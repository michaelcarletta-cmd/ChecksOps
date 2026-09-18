/**
 * Dual-provider check OCR: Textract (descriptive) + Azure (structured MICR).
 */
import { parseCheckFields } from './ocr-parse.mjs';
import { runTextract } from './textract-check-ocr.mjs';
import { analyzeAzureCheck, redactOcrLog } from './azure-check-ocr.mjs';
import { emptyAzureMicr, normalizeAzureMicr } from './ocr-normalize-azure.mjs';

/** Azure may fill these only when Textract left them empty. Never overwrite. */
const AZURE_FILL_IF_MISSING = [
  'carrier_name',
  'issue_date',
  'amount',
  'written_amount',
  'payee_line',
  'bank_name',
  'memo',
  'check_number',
];

/** Azure must not invent or fill claim identifiers (claim_number, detected_claim_number). */

const present = (value) => {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.trim() !== '';
  return true;
};

const fillIfMissing = (canonical, key, fallback) => {
  if (present(canonical[key])) return { filled: false };
  if (!present(fallback)) return { filled: false };
  canonical[key] = fallback;
  return { filled: true, source: 'azure_prebuilt_check_us' };
};

export const mergeCheckExtraction = ({
  textractParsed = {},
  azureMicr = emptyAzureMicr(),
  descriptiveEngine = 'aws_textract',
  azureRan = false,
  azureOk = false,
} = {}) => {
  const canonical = {
    carrier_name: textractParsed.carrier_name ?? null,
    check_number: textractParsed.check_number ?? null,
    amount: textractParsed.amount ?? null,
    written_amount: textractParsed.written_amount ?? null,
    issue_date: textractParsed.issue_date ?? null,
    claim_number: textractParsed.claim_number ?? null,
    detected_claim_number: textractParsed.detected_claim_number ?? textractParsed.claim_number ?? null,
    payee_line: textractParsed.payee_line ?? null,
    payees: Array.isArray(textractParsed.payees) ? textractParsed.payees : [],
    bank_name: textractParsed.bank_name ?? null,
    memo: textractParsed.memo ?? null,
    routing_number: null,
    account_number: null,
    micr_check_number: null,
    confidence: textractParsed.confidence ?? null,
    field_confidence: { ...(textractParsed.field_confidence || {}) },
    low_confidence_fields: Array.isArray(textractParsed.low_confidence_fields)
      ? [...textractParsed.low_confidence_fields]
      : [],
    needs_manual_review: Boolean(textractParsed.needs_manual_review),
    diagnostic: {
      ...(textractParsed.diagnostic || {}),
      textract_micr_heuristic: {
        routing_present: Boolean(textractParsed.routing_number),
        account_present: Boolean(textractParsed.account_number),
        micr_check_present: Boolean(textractParsed.micr_check_number),
        routing_number: textractParsed.routing_number || null,
        account_number: textractParsed.account_number || null,
        micr_check_number: textractParsed.micr_check_number || null,
      },
    },
    masked: textractParsed.masked || {},
    descriptive_engine: descriptiveEngine,
    micr_engine: azureOk ? 'azure_prebuilt_check_us' : 'none',
    micr_routing_state: azureMicr.micr_routing_state,
    micr_account_state: azureMicr.micr_account_state,
    micr_check_state: azureMicr.micr_check_state,
    azure_descriptive: azureMicr.supplemental,
    filled_from_azure: [],
  };

  const supp = azureMicr.supplemental || {};
  // claim_number / detected_claim_number: never fill from Azure (no invented claim).
  for (const key of AZURE_FILL_IF_MISSING) {
    const fallback = key === 'check_number' ? supp.check_number : supp[key];
    const result = fillIfMissing(canonical, key, fallback);
    if (result.filled) canonical.filled_from_azure.push(key);
  }
  if (!present(canonical.payees) && present(supp.payees)) {
    canonical.payees = supp.payees;
    if (!present(canonical.payee_line) && present(supp.payee_line)) {
      canonical.payee_line = supp.payee_line;
      if (!canonical.filled_from_azure.includes('payee_line')) canonical.filled_from_azure.push('payee_line');
    }
    canonical.filled_from_azure.push('payees');
  }
  if (!present(canonical.detected_claim_number) && present(canonical.claim_number)) {
    canonical.detected_claim_number = canonical.claim_number;
  }

  if (azureOk) {
    canonical.routing_number = azureMicr.routing_number;
    canonical.account_number = azureMicr.account_number;
    canonical.micr_check_number = azureMicr.micr_check_number;
    canonical.field_confidence.routing_number = azureMicr.field_confidence?.routing_number ?? null;
    canonical.field_confidence.account_number = azureMicr.field_confidence?.account_number ?? null;
    canonical.field_confidence.micr_check_number = azureMicr.field_confidence?.micr_check_number ?? null;
  }

  const micrReview = ['micr_routing_state', 'micr_account_state', 'micr_check_state']
    .some((k) => canonical[k] === 'REVIEW_REQUIRED');
  const micrMissingCritical = azureRan && (
    canonical.micr_routing_state === 'MISSING' || canonical.micr_account_state === 'MISSING'
  );
  canonical.needs_manual_review = Boolean(
    textractParsed.needs_manual_review || micrReview || micrMissingCritical,
  );

  return canonical;
};

export const extractCheck = async ({
  imageBytes,
  contentType: _contentType,
  secretLoader = async () => null,
  textractSend,
  fetchImpl,
  sleep,
  now,
  log,
} = {}) => {
  const tex = imageBytes && imageBytes.length
    ? await runTextract(imageBytes, { textractSend })
    : { blocks: [], lines: [], engine: 'aws_textract', error: 'empty_image' };

  const textractParsed = (tex.blocks && tex.blocks.length)
    ? parseCheckFields(tex.blocks)
    : (tex.lines && tex.lines.length ? parseCheckFields(tex.lines) : {});

  let azure = { ok: false, code: 'azure_not_configured', deleteConfirmed: false };
  if (typeof secretLoader === 'function' && typeof fetchImpl === 'function') {
    azure = await analyzeAzureCheck({
      imageBytes,
      secretLoader,
      fetchImpl,
      sleep,
      now,
      log,
    });
  }

  const azureMicr = azure.ok
    ? normalizeAzureMicr(azure.document, { printedCheckNumber: textractParsed.check_number })
    : emptyAzureMicr();

  const canonical = mergeCheckExtraction({
    textractParsed,
    azureMicr,
    descriptiveEngine: tex.engine,
    azureRan: azure.code !== 'azure_not_configured',
    azureOk: azure.ok,
  });

  return {
    canonical,
    textract_error: tex.error || null,
    azure_error: azure.ok ? null : (azure.code || null),
    azure_delete_confirmed: Boolean(azure.deleteConfirmed),
    logs: redactOcrLog({
      descriptive_engine: canonical.descriptive_engine,
      micr_engine: canonical.micr_engine,
      micr_routing_state: canonical.micr_routing_state,
      micr_account_state: canonical.micr_account_state,
      micr_check_state: canonical.micr_check_state,
      azure_code: azure.code || null,
    }),
  };
};

export const ocrInProgress = (row, now = Date.now(), windowMs = 60_000) => {
  if (!row || row.ocr_status !== 'processing') return false;
  const t = new Date(row.updated_at).getTime();
  if (!Number.isFinite(t)) return false;
  return (now - t) < windowMs;
};
