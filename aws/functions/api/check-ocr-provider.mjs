/**
 * Dual-provider check OCR: Textract (descriptive fallback + printed/claim)
 * + Azure (structured MICR and Azure-native descriptive fields).
 */
import { digitsOnly, parseCheckFields } from './ocr-parse.mjs';
import { runTextract } from './textract-check-ocr.mjs';
import { analyzeAzureCheck, redactOcrLog } from './azure-check-ocr.mjs';
import { emptyAzureMicr, normalizeAzureMicr } from './ocr-normalize-azure.mjs';

/** Azure wins these when present. Printed check + claim stay Textract-only. */
const AZURE_PREFERRED_DESCRIPTIVE = [
  'carrier_name',
  'issue_date',
  'amount',
  'payee_line',
  'bank_name',
  'memo',
];

const present = (value) => {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.trim() !== '';
  return true;
};

const textractSourceLabel = (engine) => {
  if (engine === 'aws_textract_detect') return 'aws_textract_detect';
  if (engine === 'aws_textract_analyze') return 'aws_textract_analyze';
  return 'aws_textract_analyze';
};

const parseMoney = (value) => {
  if (!present(value)) return null;
  const n = Number(String(value).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};

const amountsDiffer = (left, right) => {
  const a = parseMoney(left);
  const b = parseMoney(right);
  if (a == null || b == null) return false;
  return Math.abs(a - b) >= 0.01;
};

const normalizeDateKey = (value) => {
  if (!present(value)) return '';
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const mdy = s.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/);
  if (mdy) {
    let [, mm, dd, yy] = mdy.map((part, i) => (i === 0 ? part : Number(part)));
    if (yy < 100) yy = yy >= 70 ? 1900 + yy : 2000 + yy;
    return `${String(yy).padStart(4, '0')}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  }
  const parsed = Date.parse(s);
  if (Number.isFinite(parsed)) {
    const d = new Date(parsed);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }
  return s.toLowerCase().replace(/[^0-9]/g, '');
};

const datesDiffer = (left, right) => {
  const a = normalizeDateKey(left);
  const b = normalizeDateKey(right);
  return Boolean(a && b && a !== b);
};

const normalizeName = (value) => {
  if (!present(value)) return '';
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
};

const namesDiffer = (left, right) => {
  const a = normalizeName(left);
  const b = normalizeName(right);
  return Boolean(a && b && a !== b);
};

const snapshotTextract = (textractParsed = {}) => ({
  carrier_name: textractParsed.carrier_name ?? null,
  issue_date: textractParsed.issue_date ?? null,
  amount: textractParsed.amount ?? null,
  written_amount: textractParsed.written_amount ?? null,
  payee_line: textractParsed.payee_line ?? null,
  payees: Array.isArray(textractParsed.payees) ? textractParsed.payees : [],
  bank_name: textractParsed.bank_name ?? null,
  memo: textractParsed.memo ?? null,
  check_number: textractParsed.check_number ?? null,
  claim_number: textractParsed.claim_number ?? null,
  detected_claim_number: textractParsed.detected_claim_number ?? textractParsed.claim_number ?? null,
});

export const mergeCheckExtraction = ({
  textractParsed = {},
  azureMicr = emptyAzureMicr(),
  descriptiveEngine = 'aws_textract',
  azureRan = false,
  azureOk = false,
} = {}) => {
  const textractSnap = snapshotTextract(textractParsed);
  const supp = azureMicr.supplemental || {};
  const texLabel = textractSourceLabel(descriptiveEngine);
  const descriptive_sources = {};

  const canonical = {
    carrier_name: textractSnap.carrier_name,
    check_number: textractSnap.check_number,
    amount: textractSnap.amount,
    written_amount: textractSnap.written_amount,
    issue_date: textractSnap.issue_date,
    claim_number: textractSnap.claim_number,
    detected_claim_number: textractSnap.detected_claim_number,
    payee_line: textractSnap.payee_line,
    payees: textractSnap.payees,
    bank_name: textractSnap.bank_name,
    memo: textractSnap.memo,
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
      textract_descriptive: textractSnap,
      descriptive_comparison: {},
      printed_vs_micr_check: { both_present: false, differs: false },
    },
    masked: textractParsed.masked || {},
    descriptive_engine: descriptiveEngine,
    micr_engine: azureOk ? 'azure_prebuilt_check_us' : 'none',
    micr_routing_state: azureMicr.micr_routing_state,
    micr_account_state: azureMicr.micr_account_state,
    micr_check_state: azureMicr.micr_check_state,
    azure_descriptive: supp,
    textract_descriptive: textractSnap,
    filled_from_azure: [],
    descriptive_sources,
  };

  for (const key of AZURE_PREFERRED_DESCRIPTIVE) {
    if (present(supp[key])) {
      canonical[key] = supp[key];
      canonical.filled_from_azure.push(key);
      descriptive_sources[key] = 'azure_prebuilt_check_us';
      if (azureMicr.field_confidence && azureMicr.field_confidence[key] != null) {
        canonical.field_confidence[key] = azureMicr.field_confidence[key];
      }
    } else {
      descriptive_sources[key] = present(canonical[key]) ? texLabel : 'none';
    }
  }

  if (present(supp.payees)) {
    canonical.payees = supp.payees;
    if (!canonical.filled_from_azure.includes('payees')) canonical.filled_from_azure.push('payees');
    descriptive_sources.payees = 'azure_prebuilt_check_us';
  } else {
    descriptive_sources.payees = present(canonical.payees) ? texLabel : 'none';
  }

  if (!present(canonical.written_amount) && present(supp.written_amount)) {
    canonical.written_amount = supp.written_amount;
    canonical.filled_from_azure.push('written_amount');
    descriptive_sources.written_amount = 'azure_prebuilt_check_us';
  } else {
    descriptive_sources.written_amount = present(canonical.written_amount) ? texLabel : 'none';
  }

  // Printed check + claim identifiers stay Textract/deterministic-only.
  descriptive_sources.check_number = present(canonical.check_number) ? texLabel : 'none';
  descriptive_sources.claim_number = present(canonical.claim_number) ? texLabel : 'none';
  descriptive_sources.detected_claim_number = present(canonical.detected_claim_number)
    ? texLabel
    : 'none';

  if (!present(canonical.detected_claim_number) && present(canonical.claim_number)) {
    canonical.detected_claim_number = canonical.claim_number;
    descriptive_sources.detected_claim_number = descriptive_sources.claim_number;
  }

  const comparison = {
    amount: {
      both_present: present(textractSnap.amount) && present(supp.amount),
      differs: amountsDiffer(textractSnap.amount, supp.amount),
    },
    issue_date: {
      both_present: present(textractSnap.issue_date) && present(supp.issue_date),
      differs: datesDiffer(textractSnap.issue_date, supp.issue_date),
    },
    payee_line: {
      both_present: present(textractSnap.payee_line) && present(supp.payee_line),
      differs: namesDiffer(textractSnap.payee_line, supp.payee_line),
    },
    carrier_name: {
      both_present: present(textractSnap.carrier_name) && present(supp.carrier_name),
      differs: namesDiffer(textractSnap.carrier_name, supp.carrier_name),
    },
    bank_name: {
      both_present: present(textractSnap.bank_name) && present(supp.bank_name),
      differs: namesDiffer(textractSnap.bank_name, supp.bank_name),
    },
  };
  if (azureOk) {
    canonical.routing_number = azureMicr.routing_number;
    canonical.account_number = azureMicr.account_number;
    canonical.micr_check_number = azureMicr.micr_check_number;
    canonical.field_confidence.routing_number = azureMicr.field_confidence?.routing_number ?? null;
    canonical.field_confidence.account_number = azureMicr.field_confidence?.account_number ?? null;
    canonical.field_confidence.micr_check_number = azureMicr.field_confidence?.micr_check_number ?? null;
  }

  const printedDigits = present(canonical.check_number) ? digitsOnly(canonical.check_number) : '';
  const micrCheckDigits = present(canonical.micr_check_number) ? digitsOnly(canonical.micr_check_number) : '';
  const printedVsMicr = {
    both_present: Boolean(printedDigits && micrCheckDigits),
    differs: Boolean(printedDigits && micrCheckDigits && printedDigits !== micrCheckDigits),
  };
  comparison.printed_check_vs_micr_check = printedVsMicr;
  canonical.diagnostic.descriptive_comparison = comparison;
  canonical.diagnostic.printed_vs_micr_check = printedVsMicr;

  const micrReview = ['micr_routing_state', 'micr_account_state', 'micr_check_state']
    .some((k) => canonical[k] === 'REVIEW_REQUIRED');
  const micrMissingCritical = azureRan && (
    canonical.micr_routing_state === 'MISSING' || canonical.micr_account_state === 'MISSING'
  );
  const descriptiveReview = Boolean(
    (comparison.amount.both_present && comparison.amount.differs)
    || (comparison.issue_date.both_present && comparison.issue_date.differs)
    || (comparison.payee_line.both_present && comparison.payee_line.differs),
  );
  canonical.needs_manual_review = Boolean(
    textractParsed.needs_manual_review || micrReview || micrMissingCritical || descriptiveReview,
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
  const transport = typeof fetchImpl === 'function'
    ? fetchImpl
    : (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
  if (typeof secretLoader === 'function' && typeof transport === 'function') {
    azure = await analyzeAzureCheck({
      imageBytes,
      secretLoader,
      fetchImpl: transport,
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
