/**
 * AWS Textract-backed check OCR (Class A).
 * Preserves check-ocr-intake / detect-endorsement-zone response shapes.
 * Does not execute payments. Commits intake metadata via ocr_commit_results when available,
 * otherwise updates descriptive columns directly under RLS.
 */
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  TextractClient,
  DetectDocumentTextCommand,
  AnalyzeDocumentCommand,
} from '@aws-sdk/client-textract';
import { withIdentity } from './data.mjs';
import { normalizePath, s3KeyFor } from './storage-paths.mjs';
import { parseCheckFields } from './ocr-parse.mjs';

const s3 = () => new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
const textract = () => new TextractClient({ region: process.env.AWS_REGION || 'us-east-1' });
const filesBucket = () => process.env.FILES_BUCKET || '';

const streamToBuffer = async (body) => {
  if (!body) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  const chunks = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks);
};

const extractLines = (blocks = []) => (blocks || [])
  .filter((b) => b.BlockType === 'LINE' && b.Text)
  .map((b) => b.Text);

const loadCheckImageBytes = async (client, checkId) => {
  const row = (await client.query(
    `SELECT id, tenant_id, front_image_path, back_image_path, ocr_status
     FROM public.check_intake_items WHERE id = $1::uuid LIMIT 1`,
    [checkId],
  )).rows[0];
  if (!row) return { error: 'check_not_found' };
  if (!row.front_image_path) return { error: 'missing_front_image', row };

  const rel = normalizePath(row.front_image_path, 'claim-files');
  const key = s3KeyFor('claim-files', rel);
  if (!key || !filesBucket()) return { error: 's3_not_configured', row };

  const obj = await s3().send(new GetObjectCommand({ Bucket: filesBucket(), Key: key }));
  const bytes = await streamToBuffer(obj.Body);
  return { row, bytes, key };
};

const runTextract = async (bytes) => {
  try {
    const analyzed = await textract().send(new AnalyzeDocumentCommand({
      Document: { Bytes: bytes },
      FeatureTypes: ['FORMS'],
    }));
    return extractLines(analyzed.Blocks || []);
  } catch {
    const detected = await textract().send(new DetectDocumentTextCommand({
      Document: { Bytes: bytes },
    }));
    return extractLines(detected.Blocks || []);
  }
};

export const handleCheckOcrIntake = async (event) => withIdentity(event, async ({
  client, mapping, body, spoof,
}) => {
  const checkId = body.checkId || body.check_id;
  if (!checkId) {
    return {
      ok: false, statusCode: 400, success: false, error: 'missing_check_id', spoofFieldsIgnored: spoof,
    };
  }

  const loaded = await loadCheckImageBytes(client, checkId);
  if (loaded.error === 'check_not_found') {
    return {
      ok: false, statusCode: 404, success: false, error: 'check_not_found', spoofFieldsIgnored: spoof,
    };
  }
  if (loaded.error) {
    return {
      ok: true,
      statusCode: 200,
      success: false,
      ocr_success: false,
      error: loaded.error,
      spoofFieldsIgnored: spoof,
    };
  }

  // Membership / RLS already applied via GUC; lock status best-effort
  await client.query(
    `UPDATE public.check_intake_items
     SET ocr_status = 'processing', updated_at = now()
     WHERE id = $1::uuid`,
    [checkId],
  ).catch(() => {});

  let lines = [];
  let textractError = null;
  try {
    lines = await runTextract(loaded.bytes);
  } catch (error) {
    textractError = String(error?.message || error).slice(0, 240);
  }

  if (!lines.length) {
    await client.query(
      `UPDATE public.check_intake_items SET ocr_status = 'failed', updated_at = now() WHERE id = $1::uuid`,
      [checkId],
    ).catch(() => {});
    return {
      ok: true,
      statusCode: 200,
      success: false,
      ocr_success: false,
      error: textractError || 'textract_empty',
      stage: 'textract',
      spoofFieldsIgnored: spoof,
    };
  }

  const parsed = parseCheckFields(lines);
  const eligibility = {
    recommendation: parsed.needs_manual_review ? 'manual_review' : 'proceed',
    reasons: parsed.low_confidence_fields.map((f) => `low_confidence:${f}`),
    rules: { engine: 'aws_textract_heuristics', version: 1 },
  };

  let rpcSuccess = false;
  let rpcError = null;
  try {
    await client.query(
      `SELECT public.ocr_commit_results(
         $1::uuid, $2::jsonb, $3::jsonb, $4::jsonb, $5::uuid
       )`,
      [
        checkId,
        JSON.stringify(parsed),
        JSON.stringify(parsed.payees || []),
        JSON.stringify(eligibility),
        mapping.application_user_id,
      ],
    );
    rpcSuccess = true;
  } catch (error) {
    rpcError = String(error?.message || error).slice(0, 240);
    // Fallback: descriptive columns only (still no provider money movement)
    try {
      await client.query(
        `UPDATE public.check_intake_items SET
           carrier_name = COALESCE($2, carrier_name),
           check_number = COALESCE($3, check_number),
           payee_line = COALESCE($4, payee_line),
           detected_claim_number = COALESCE($5, detected_claim_number),
           ocr_status = 'completed',
           updated_at = now()
         WHERE id = $1::uuid`,
        [
          checkId,
          parsed.carrier_name,
          parsed.check_number,
          parsed.payee_line,
          parsed.claim_number,
        ],
      );
      // Intentionally do not set amount in fallback to avoid ledger amount triggers
      // when ocr_commit_results is unavailable.
      rpcSuccess = true;
      rpcError = `fallback_descriptive_only:${rpcError}`;
    } catch (error2) {
      rpcError = String(error2?.message || error2).slice(0, 240);
    }
  }

  await client.query(
    `INSERT INTO public.check_audit_log (check_id, event_type, event_description, event_data, actor_id)
     VALUES ($1::uuid, 'ocr_completed', 'AWS Textract OCR completed', $2::jsonb, $3::uuid)`,
    [
      checkId,
      JSON.stringify({
        confidence: parsed.confidence,
        low_confidence_fields: parsed.low_confidence_fields,
        engine: 'textract',
        rpcSuccess,
      }),
      mapping.application_user_id,
    ],
  ).catch(() => {});

  return {
    ok: true,
    statusCode: 200,
    success: true,
    ocr_success: true,
    rpc_success: rpcSuccess,
    rpc_error: rpcError,
    parsed,
    payees: parsed.payees,
    eligibility,
    payees_preserved: false,
    transaction: {},
    engine: 'aws_textract',
    spoofFieldsIgnored: spoof,
  };
}, { write: true, commit: true });

export const handleDetectEndorsementZone = async (event) => withIdentity(event, async ({
  client, body, spoof,
}) => {
  const checkId = body.checkId || body.check_id;
  // Default endorsement band on check rear (heuristic; Textract geometry optional later)
  const zone = { top: 0.72, bottom: 0.95, left: 0.05, right: 0.95 };
  const suggested = { xPct: 8, yPct: 78, scale: 1 };
  if (checkId) {
    const row = (await client.query(
      `SELECT id FROM public.check_intake_items WHERE id = $1::uuid LIMIT 1`,
      [checkId],
    )).rows[0];
    if (!row) {
      return { ok: false, statusCode: 404, detected: false, error: 'check_not_found', spoofFieldsIgnored: spoof };
    }
  }
  return {
    ok: true,
    statusCode: 200,
    detected: true,
    zone,
    suggested,
    engine: 'aws_default_band',
    spoofFieldsIgnored: spoof,
  };
});

export const handleCheckOcrBacklog = async (event) => withIdentity(event, async ({
  client, spoof,
}) => {
  // Service-style scan for stale OCR; does not auto-loop Textract for cost control in staging.
  const rows = (await client.query(
    `SELECT id, ocr_status, updated_at
     FROM public.check_intake_items
     WHERE ocr_status IN ('pending', 'processing', 'failed')
     ORDER BY updated_at ASC NULLS FIRST
     LIMIT 25`,
  )).rows;
  return {
    ok: true,
    statusCode: 200,
    scanned: rows.length,
    retried: 0,
    succeeded: 0,
    failed: 0,
    pendingIds: rows.map((r) => r.id),
    message: 'Staging backlog lists stale rows; invoke check-ocr-intake per id to process',
    spoofFieldsIgnored: spoof,
  };
});
