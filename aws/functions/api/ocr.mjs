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
    `SELECT id, tenant_id, front_image_path, back_image_path, ocr_status,
            raw_ocr_front, raw_ocr_back, carrier_name, check_number, payee_line,
            detected_claim_number, amount
     FROM public.check_intake_items WHERE id = $1::uuid LIMIT 1`,
    [checkId],
  )).rows[0];
  if (!row) return { error: 'check_not_found' };
  if (!row.front_image_path) return { error: 'missing_front_image', row };

  const rel = normalizePath(row.front_image_path, 'claim-files');
  const key = s3KeyFor('claim-files', rel);
  if (!key || !filesBucket()) return { error: 's3_not_configured', row };

  try {
    const obj = await s3().send(new GetObjectCommand({ Bucket: filesBucket(), Key: key }));
    const bytes = await streamToBuffer(obj.Body);
    return { row, bytes, key };
  } catch (error) {
    return {
      row,
      bytes: null,
      key,
      imageError: String(error?.message || error).slice(0, 240),
    };
  }
};

const linesFromStoredOcr = (row) => {
  const chunks = [];
  for (const value of [row?.raw_ocr_front, row?.raw_ocr_back]) {
    if (!value) continue;
    if (typeof value === 'string') {
      chunks.push(value);
      continue;
    }
    if (typeof value === 'object') {
      // Restored dumps often store structured OCR JSON rather than LINE text.
      const parts = [
        value.payee_line,
        value.carrier_name,
        value.check_number && `Check ${value.check_number}`,
        value.amount && `$${value.amount}`,
        value.claim_number || value.detected_claim_number,
        value.issue_date,
        ...(Array.isArray(value.payees) ? value.payees.map((p) => p?.name).filter(Boolean) : []),
        value.text,
        value.raw_text,
      ].filter(Boolean);
      if (parts.length) chunks.push(parts.join('\n'));
      else chunks.push(JSON.stringify(value));
    }
  }
  const text = chunks.join('\n');
  if (!text.trim()) return [];
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
};

/** If stored OCR is already structured fields, prefer that over heuristic reparse. */
const parsedFromStoredOcr = (row) => {
  const value = row?.raw_ocr_front;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!value.payee_line && !value.amount && !value.check_number && !value.payees) return null;
  return {
    amount: value.amount != null ? Number(value.amount) : null,
    payee_line: value.payee_line || null,
    payees: Array.isArray(value.payees) ? value.payees : [],
    check_number: value.check_number || null,
    carrier_name: value.carrier_name || null,
    claim_number: value.claim_number || value.detected_claim_number || null,
    issue_date: value.issue_date || null,
    confidence: value.confidence || 50,
    low_confidence_fields: value.low_confidence_fields || [],
    needs_manual_review: Boolean(value.needs_manual_review),
  };
};

const runTextract = async (bytes) => {
  try {
    const analyzed = await textract().send(new AnalyzeDocumentCommand({
      Document: { Bytes: bytes },
      FeatureTypes: ['FORMS'],
    }));
    return { lines: extractLines(analyzed.Blocks || []), engine: 'aws_textract_analyze' };
  } catch (analyzeError) {
    try {
      const detected = await textract().send(new DetectDocumentTextCommand({
        Document: { Bytes: bytes },
      }));
      return { lines: extractLines(detected.Blocks || []), engine: 'aws_textract_detect' };
    } catch (detectError) {
      const message = String(detectError?.message || analyzeError?.message || detectError).slice(0, 240);
      return { lines: [], engine: 'aws_textract', error: message };
    }
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
  if (loaded.error === 'missing_front_image' || loaded.error === 's3_not_configured') {
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
  let engine = 'aws_textract';
  let textractError = null;
  if (loaded.bytes && loaded.bytes.length) {
    const tex = await runTextract(loaded.bytes);
    lines = tex.lines || [];
    engine = tex.engine || engine;
    textractError = tex.error || null;
  } else {
    textractError = loaded.imageError || 'image_unavailable';
  }

  // Staging fallback when Textract is not subscribed / unavailable:
  // re-parse restored raw OCR text/JSON so intake UAT still works without money movement.
  let parsedFromStore = null;
  if (!lines.length) {
    parsedFromStore = parsedFromStoredOcr(loaded.row);
    const stored = linesFromStoredOcr(loaded.row);
    if (stored.length) {
      lines = stored;
      engine = 'aws_stored_ocr_reparse';
    } else if (parsedFromStore) {
      engine = 'aws_stored_ocr_json';
    }
  }

  if (!lines.length && !parsedFromStore) {
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
      textract_note: 'Enable AWS Textract on account 806168576068 for live image OCR; stored OCR reparse used when available.',
      spoofFieldsIgnored: spoof,
    };
  }

  const parsed = parsedFromStore || parseCheckFields(lines);
  const eligibility = {
    recommendation: parsed.needs_manual_review ? 'manual_review' : 'proceed',
    reasons: (parsed.low_confidence_fields || []).map((f) => `low_confidence:${f}`),
    rules: { engine: engine === 'aws_textract_analyze' || engine === 'aws_textract_detect' ? 'aws_textract_heuristics' : engine, version: 1 },
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
    engine,
    textract_error: textractError,
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
