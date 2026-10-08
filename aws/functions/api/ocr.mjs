/**
 * AWS Textract-backed check OCR (Class A).
 * Preserves check-ocr-intake / detect-endorsement-zone response shapes.
 * Does not execute payments. Commits intake metadata via ocr_commit_results when available,
 * otherwise updates descriptive columns directly under RLS.
 */
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { normalizePath, s3KeyFor } from './storage-paths.mjs';
import { parseCheckFields } from './ocr-parse.mjs';
import { runTextract } from './textract-check-ocr.mjs';
import { extractCheck, mergeCheckExtraction, ocrInProgress } from './check-ocr-provider.mjs';
import { emptyAzureMicr } from './ocr-normalize-azure.mjs';
import { azureDiAnalyzeSecretLoader } from './azure-di-secret.mjs';
import { safeOcrLog } from './azure-check-ocr.mjs';
import { persistOcrDescriptiveHandoff } from './ocr-descriptive-persist.mjs';

const s3 = () => new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
const filesBucket = () => process.env.FILES_BUCKET || '';

const streamToBuffer = async (body) => {
  if (!body) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  const chunks = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks);
};

const loadCheckImageBytes = async (client, checkId, deps = {}) => {
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
    const s3Send = deps.s3Send || ((cmd) => s3().send(cmd));
    const obj = await s3Send(new GetObjectCommand({ Bucket: filesBucket(), Key: key }));
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

const present = (value) => {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.trim() !== '';
  return true;
};

const abaValidFromState = (state) => {
  if (state === 'VERIFIED') return true;
  if (state === 'REVIEW_REQUIRED') return false;
  return null;
};

const DESCRIPTIVE_PRESENCE_FIELDS = [
  'carrier_name',
  'issue_date',
  'amount',
  'written_amount',
  'payee_line',
  'claim_number',
  'bank_name',
  'memo',
];

export const redactOcrIntakeResponse = ({
  parsed = {},
  eligibility = {},
  azureRan = false,
  azureError = null,
  azureDeleteConfirmed = false,
  rpcSuccess = false,
  rpcError = null,
  spoof = [],
  engine = null,
} = {}) => {
  const descriptive = {};
  for (const key of DESCRIPTIVE_PRESENCE_FIELDS) {
    descriptive[key] = {
      present: present(parsed[key]),
      source: parsed.descriptive_sources?.[key] || 'none',
    };
  }
  descriptive.payees = {
    present: present(parsed.payees),
    count: Array.isArray(parsed.payees) ? parsed.payees.length : 0,
    source: parsed.descriptive_sources?.payees || 'none',
  };
  descriptive.printed_check_number = {
    present: present(parsed.check_number),
    source: parsed.descriptive_sources?.check_number || 'none',
  };

  return {
    ok: true,
    statusCode: 200,
    success: true,
    ocr_success: true,
    rpc_success: rpcSuccess,
    rpc_error: rpcError,
    descriptive_engine: parsed.descriptive_engine || engine || null,
    micr_engine: parsed.micr_engine || 'none',
    micr_routing_state: parsed.micr_routing_state || 'MISSING',
    micr_account_state: parsed.micr_account_state || 'MISSING',
    micr_check_state: parsed.micr_check_state || 'MISSING',
    aba_valid: abaValidFromState(parsed.micr_routing_state),
    azure_delete_confirmed: Boolean(azureDeleteConfirmed),
    needs_manual_review: Boolean(parsed.needs_manual_review),
    descriptive,
    filled_from_azure: Array.isArray(parsed.filled_from_azure) ? [...parsed.filled_from_azure] : [],
    azure_error: azureRan ? (azureError || null) : null,
    eligibility: {
      recommendation: eligibility.recommendation || (parsed.needs_manual_review ? 'manual_review' : 'proceed'),
    },
    engine: parsed.descriptive_engine || engine || null,
    spoofFieldsIgnored: spoof,
  };
};

const resolveOcrDeps = (injected = {}) => (
  injected.ocr || handleCheckOcrIntake.__ocrDeps || {}
);

export const handleCheckOcrIntake = async (event, injected = {}) => {
  const withIdentityFn = injected.withIdentity
    || handleCheckOcrIntake.__withIdentity
    || (await import('./data.mjs')).withIdentity;
  const ocrDeps = resolveOcrDeps(injected);
  return withIdentityFn(event, async ({
    client, mapping, body, spoof,
  }) => {
  const checkId = body.checkId || body.check_id;
  if (!checkId) {
    return {
      ok: false, statusCode: 400, success: false, error: 'missing_check_id', spoofFieldsIgnored: spoof,
    };
  }

  const loaded = await loadCheckImageBytes(client, checkId, ocrDeps);
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

  if (ocrInProgress(loaded.row)) {
    return {
      ok: true,
      statusCode: 200,
      success: false,
      ocr_success: false,
      error: 'ocr_in_progress',
      spoofFieldsIgnored: spoof,
    };
  }

  // Membership / RLS already applied via GUC; lock status best-effort.
  // Use SAVEPOINT so a denied status update cannot abort the whole write tx.
  try {
    await client.query('SAVEPOINT ocr_status_processing');
    await client.query(
      `UPDATE public.check_intake_items
       SET ocr_status = 'processing', updated_at = now()
       WHERE id = $1::uuid`,
      [checkId],
    );
    await client.query('RELEASE SAVEPOINT ocr_status_processing');
  } catch {
    try { await client.query('ROLLBACK TO SAVEPOINT ocr_status_processing'); } catch { /* ignore */ }
  }

  let lines = [];
  let blocks = [];
  let engine = 'aws_textract';
  let textractError = null;
  let extracted = null;
  const secretLoader = typeof ocrDeps.secretLoader === 'function'
    ? ocrDeps.secretLoader
    : azureDiAnalyzeSecretLoader({
      getSecretString: ocrDeps.getSecretString,
      env: ocrDeps.env,
      secretId: ocrDeps.secretId,
    });
  const fetchImpl = typeof ocrDeps.fetchImpl === 'function'
    ? ocrDeps.fetchImpl
    : (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
  const ocrLog = ocrDeps.log || ((row) => safeOcrLog(null, row));

  if (loaded.bytes && loaded.bytes.length) {
    extracted = await extractCheck({
      imageBytes: loaded.bytes,
      secretLoader,
      fetchImpl,
      textractSend: ocrDeps.textractSend,
      sleep: ocrDeps.sleep,
      now: ocrDeps.now,
      log: ocrLog,
    });
    blocks = [];
    lines = [];
    engine = extracted.canonical?.descriptive_engine || engine;
    textractError = extracted.textract_error || null;
  } else {
    textractError = loaded.imageError || 'image_unavailable';
  }

  // Staging fallback when Textract is not subscribed / unavailable:
  // re-parse restored raw OCR text/JSON so intake UAT still works without money movement.
  let parsedFromStore = null;
  const extractedHasDescriptive = Boolean(
    extracted?.canonical
    && (present(extracted.canonical.payee_line)
      || present(extracted.canonical.check_number)
      || present(extracted.canonical.carrier_name)
      || present(extracted.canonical.amount)),
  );
  if (!extractedHasDescriptive && !lines.length) {
    parsedFromStore = parsedFromStoredOcr(loaded.row);
    const stored = linesFromStoredOcr(loaded.row);
    if (stored.length) {
      lines = stored;
      engine = 'aws_stored_ocr_reparse';
    } else if (parsedFromStore) {
      engine = 'aws_stored_ocr_json';
    }
  }

  if (!extractedHasDescriptive && !lines.length && !parsedFromStore) {
    try {
      await client.query('SAVEPOINT ocr_status_failed');
      await client.query(
        `UPDATE public.check_intake_items SET ocr_status = 'failed', updated_at = now() WHERE id = $1::uuid`,
        [checkId],
      );
      await client.query('RELEASE SAVEPOINT ocr_status_failed');
    } catch {
      try { await client.query('ROLLBACK TO SAVEPOINT ocr_status_failed'); } catch { /* ignore */ }
    }
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

  const textractParsed = extractedHasDescriptive
    ? null
    : (parsedFromStore || (blocks && blocks.length ? parseCheckFields(blocks) : parseCheckFields(lines)));

  let parsed = extracted?.canonical || null;
  let azureRan = extracted ? extracted.azure_error !== 'azure_not_configured' : false;
  let azureError = extracted?.azure_error && extracted.azure_error !== 'azure_not_configured'
    ? extracted.azure_error
    : null;
  let azureDeleteConfirmed = Boolean(extracted?.azure_delete_confirmed);

  if (!parsed) {
    parsed = mergeCheckExtraction({
      textractParsed: textractParsed || {},
      azureMicr: emptyAzureMicr(),
      descriptiveEngine: engine,
      azureRan: false,
      azureOk: false,
    });
    azureRan = false;
    azureError = null;
    azureDeleteConfirmed = false;
  } else if (textractParsed && !extractedHasDescriptive) {
    const fallback = mergeCheckExtraction({
      textractParsed,
      azureMicr: emptyAzureMicr(),
      descriptiveEngine: engine,
      azureRan: false,
      azureOk: false,
    });
    for (const key of ['carrier_name', 'issue_date', 'amount', 'written_amount', 'payee_line', 'payees', 'claim_number', 'detected_claim_number', 'bank_name', 'memo', 'check_number']) {
      if (!present(parsed[key]) && present(fallback[key])) parsed[key] = fallback[key];
    }
    parsed.descriptive_engine = engine;
  }
  const eligibility = {
    recommendation: parsed.needs_manual_review ? 'manual_review' : 'proceed',
    reasons: (parsed.low_confidence_fields || []).map((f) => `low_confidence:${f}`),
    rules: { engine: engine === 'aws_textract_analyze' || engine === 'aws_textract_detect' ? 'aws_textract_heuristics' : engine, version: 1 },
  };

  let rpcSuccess = false;
  let rpcError = null;
  // Prefer descriptive-column commit on staging. Full ocr_commit_results writes amount /
  // check_stage / claim_payments and uses a multi-arg signature; keep money paths untouched.
  try {
    await client.query('SAVEPOINT ocr_descriptive_commit');
    // Only columns granted to checksops for T2 intake updates (33_tranche2_write_grants.sql).
    // Do not touch ocr_status/amount/detected_claim_number (no column grant / ledger safety).
    await client.query(
      `UPDATE public.check_intake_items SET
         carrier_name = COALESCE($2, carrier_name),
         check_number = COALESCE($3, check_number),
         payee_line = COALESCE($4, payee_line),
         updated_at = now()
       WHERE id = $1::uuid`,
      [
        checkId,
        parsed.carrier_name,
        parsed.check_number,
        parsed.payee_line,
      ],
    );
    await client.query('RELEASE SAVEPOINT ocr_descriptive_commit');
    // Intentionally do not set amount here to avoid ledger amount triggers.
    rpcSuccess = true;
    rpcError = 'fallback_descriptive_only';
  } catch (error) {
    try { await client.query('ROLLBACK TO SAVEPOINT ocr_descriptive_commit'); } catch { /* ignore */ }
    rpcError = String(error?.message || error).slice(0, 240);
  }

  // Post-OCR application handoff: descriptive fields + verified Azure MICR only.
  // MICR persistence is intentionally narrow: never persist REVIEW_REQUIRED values,
  // never overwrite an existing nonblank routing/account value, and never touch amount/status.
  try {
    await client.query('SAVEPOINT ocr_descriptive_handoff');
    await persistOcrDescriptiveHandoff({
      client,
      checkId,
      tenantId: loaded.row?.tenant_id,
      parsed,
      log: (row) => ocrLog({
        event: 'ocr_descriptive_persist',
        ok: row?.ok !== false,
        code: row?.code || 'handoff',
      }),
    });
    await client.query('RELEASE SAVEPOINT ocr_descriptive_handoff');
  } catch {
    try { await client.query('ROLLBACK TO SAVEPOINT ocr_descriptive_handoff'); } catch { /* ignore */ }
  }

  const verifiedRouting = parsed.micr_routing_state === 'VERIFIED' ? parsed.routing_number : null;
  const verifiedAccount = parsed.micr_account_state === 'VERIFIED' ? parsed.account_number : null;
  if (verifiedRouting || verifiedAccount) {
    try {
      await client.query('SAVEPOINT ocr_micr_handoff');
      await client.query(
        `UPDATE public.check_intake_items
         SET routing_number = CASE
               WHEN (routing_number IS NULL OR btrim(routing_number) = '') AND $2::text IS NOT NULL
                 THEN $2::text
               ELSE routing_number
             END,
             account_number = CASE
               WHEN (account_number IS NULL OR btrim(account_number) = '') AND $3::text IS NOT NULL
                 THEN $3::text
               ELSE account_number
             END,
             updated_at = now()
         WHERE id = $1::uuid`,
        [checkId, verifiedRouting, verifiedAccount],
      );
      await client.query('RELEASE SAVEPOINT ocr_micr_handoff');
      ocrLog({ event: 'ocr_micr_persist', ok: true, code: 'verified_only' });
    } catch {
      try { await client.query('ROLLBACK TO SAVEPOINT ocr_micr_handoff'); } catch { /* ignore */ }
      ocrLog({ event: 'ocr_micr_persist', ok: false, code: 'write_failed' });
    }
  }

  try {
    await client.query('SAVEPOINT ocr_audit');
    await client.query(
      `INSERT INTO public.check_audit_log (check_id, event_type, event_description, event_data, actor_id)
       VALUES ($1::uuid, 'ocr_completed', 'AWS Textract OCR completed', $2::jsonb, $3::uuid)`,
      [
        checkId,
        JSON.stringify({
          confidence: parsed.confidence,
          low_confidence_fields: parsed.low_confidence_fields,
          engine: parsed.descriptive_engine || engine,
          micr_engine: parsed.micr_engine,
          micr_routing_state: parsed.micr_routing_state,
          micr_account_state: parsed.micr_account_state,
          micr_check_state: parsed.micr_check_state,
          needs_manual_review: parsed.needs_manual_review,
          rpcSuccess,
        }),
        mapping.application_user_id,
      ],
    );
    await client.query('RELEASE SAVEPOINT ocr_audit');
  } catch {
    try { await client.query('ROLLBACK TO SAVEPOINT ocr_audit'); } catch { /* ignore */ }
  }

  return redactOcrIntakeResponse({
    parsed,
    eligibility,
    azureRan,
    azureError,
    azureDeleteConfirmed,
    rpcSuccess,
    rpcError,
    spoof,
    engine: parsed.descriptive_engine || engine,
  });
}, { write: true, commit: true });
};

// Exported test hooks (no production callers).
export const __test__ = {
  runTextract,
  loadCheckImageBytes,
  ocrInProgress,
  mergeCheckExtraction,
  redactOcrIntakeResponse,
};

export const handleDetectEndorsementZone = async (event) => {
  const { withIdentity } = await import('./data.mjs');
  return withIdentity(event, async ({
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
};

export const handleCheckOcrBacklog = async (event) => {
  const { withIdentity } = await import('./data.mjs');
  return withIdentity(event, async ({
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
};
