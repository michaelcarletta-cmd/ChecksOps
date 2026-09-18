/**
 * Isolated live-validation wrapper.
 * Provider/normalize/merge come from packaged HEAD modules (or repo modules in local tests).
 * Direct invoke only. Redacted output only. Does not persist.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const ALLOWED_CONTENT_TYPES = new Set(['image/jpeg', 'image/png']);
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const SECRET_ID = process.env.AZURE_DI_SECRET_ID || 'checksops/isolated/azure-document-intelligence-504e';

const DESCRIPTIVE_FIELDS = [
  'carrier_name',
  'issue_date',
  'amount',
  'written_amount',
  'payee_line',
  'claim_number',
  'bank_name',
  'memo',
];

export const resolveImplModule = (name) => {
  const local = path.join(here, name);
  const repo = path.join(here, '../../../functions/api', name);
  const target = existsSync(local) ? local : repo;
  return pathToFileURL(target).href;
};

const loadAzureHelpers = async () => import(resolveImplModule('azure-check-ocr.mjs'));
const loadProvider = async () => import(resolveImplModule('check-ocr-provider.mjs'));

const present = (value) => {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.trim() !== '';
  return true;
};

const sourceFor = (key, canonical) => {
  const filled = Array.isArray(canonical?.filled_from_azure) ? canonical.filled_from_azure : [];
  if (key === 'printed_check_number') {
    if (filled.includes('check_number')) return 'azure_prebuilt_check_us';
    return present(canonical?.check_number) ? (canonical?.descriptive_engine || 'aws_textract') : 'none';
  }
  if (key === 'payees') {
    if (filled.includes('payees')) return 'azure_prebuilt_check_us';
    return present(canonical?.payees) ? (canonical?.descriptive_engine || 'aws_textract') : 'none';
  }
  if (filled.includes(key)) return 'azure_prebuilt_check_us';
  if (present(canonical?.[key])) return canonical?.descriptive_engine || 'aws_textract';
  return 'none';
};

const abaValidFromState = (state) => {
  if (state === 'VERIFIED') return true;
  if (state === 'REVIEW_REQUIRED') return false;
  return null;
};

const matchesPrinted = (canonical) => {
  const state = canonical?.micr_check_state;
  const printed = present(canonical?.check_number);
  if (state === 'MISSING') return null;
  if (!printed) return null;
  if (state === 'VERIFIED') return true;
  if (state === 'REVIEW_REQUIRED') return false;
  return null;
};

export const buildRedactedResponse = (extracted = {}) => {
  const canonical = extracted.canonical || {};
  const filled = Array.isArray(canonical.filled_from_azure) ? [...canonical.filled_from_azure] : [];
  const descriptive = {};
  for (const key of DESCRIPTIVE_FIELDS) {
    descriptive[key] = {
      present: present(canonical[key]),
      source: sourceFor(key, canonical),
      confidence: canonical.field_confidence?.[key] ?? null,
    };
  }
  descriptive.payees = {
    present: present(canonical.payees),
    count: Array.isArray(canonical.payees) ? canonical.payees.length : 0,
    source: sourceFor('payees', canonical),
  };
  descriptive.printed_check_number = {
    present: present(canonical.check_number),
    source: sourceFor('printed_check_number', canonical),
    confidence: canonical.field_confidence?.check_number ?? null,
  };

  return {
    ok: true,
    code: 'ok',
    descriptive_engine: canonical.descriptive_engine || null,
    micr_engine: canonical.micr_engine || 'none',
    needs_manual_review: Boolean(canonical.needs_manual_review),
    filled_from_azure: filled,
    azure_result_delete: extracted.azure_delete_confirmed ? 'CONFIRMED' : 'NOT_CONFIRMED',
    descriptive,
    micr: {
      provider: canonical.micr_engine || 'none',
      routing: {
        state: canonical.micr_routing_state || 'MISSING',
        aba_valid: abaValidFromState(canonical.micr_routing_state),
        confidence: canonical.field_confidence?.routing_number ?? null,
      },
      account: {
        state: canonical.micr_account_state || 'MISSING',
        confidence: canonical.field_confidence?.account_number ?? null,
      },
      micr_check: {
        state: canonical.micr_check_state || 'MISSING',
        matches_printed_check: matchesPrinted(canonical),
        printed_check_present: present(canonical.check_number),
        confidence: canonical.field_confidence?.micr_check_number ?? null,
      },
    },
  };
};

const maxInputBytes = () => {
  const raw = Number(process.env.MAX_INPUT_BYTES || DEFAULT_MAX_BYTES);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_MAX_BYTES;
  return Math.min(DEFAULT_MAX_BYTES, Math.max(1, Math.floor(raw)));
};

const isBase64ish = (value) => {
  if (typeof value !== 'string') return false;
  const s = value.trim();
  if (!s || s.length > 8 * 1024 * 1024) return false;
  return /^[A-Za-z0-9+/=\s]+$/.test(s);
};

const decodeBase64 = (value) => {
  if (!isBase64ish(value)) return null;
  try {
    const trimmed = value.replace(/\s+/g, '');
    if (!trimmed) return null;
    return Buffer.from(trimmed, 'base64');
  } catch {
    return null;
  }
};

const respond = (statusCode, body) => ({ statusCode, ...body });

const isolatedLog = async (log, entry) => {
  const { safeOcrLog } = await loadAzureHelpers();
  safeOcrLog(log, {
    event: entry?.event || 'ocr_isolated_validate',
    ok: entry?.ok ?? null,
    code: entry?.code || null,
    status: entry?.status ?? null,
    ms: entry?.ms ?? null,
    deleteConfirmed: entry?.deleteConfirmed ?? null,
    attempts: entry?.attempts ?? null,
  });
};

const readSecretPayload = (out) => {
  if (out?.SecretString) return out.SecretString;
  if (out?.SecretBinary) {
    const buf = Buffer.isBuffer(out.SecretBinary)
      ? out.SecretBinary
      : Buffer.from(out.SecretBinary);
    return buf.toString('utf8');
  }
  return null;
};

const defaultSecretLoader = async (deps = {}) => {
  // Injected clients are used as-is so tests never construct AWS commands.
  if (typeof deps.loadSecret === 'function') return deps.loadSecret();
  if (deps.secretsClient) {
    return readSecretPayload(await deps.secretsClient.send({ SecretId: SECRET_ID }));
  }
  const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const client = new SecretsManagerClient({
    region: process.env.AWS_REGION || 'us-east-1',
  });
  const out = await client.send(new GetSecretValueCommand({ SecretId: SECRET_ID }));
  // Return raw secret payload only. analyzeAzureCheck parses { api_key, endpoint }.
  // Never log this value.
  return readSecretPayload(out);
};

export const handler = async (event = {}, context = {}, deps = {}) => {
  const startedAt = Date.now();
  const log = deps.log || ((row) => console.log(JSON.stringify(row)));

  try {
    const contentType = event?.contentType;
    const imageB64 = event?.imageB64;
    const returnMode = event?.returnMode;

    if (returnMode !== 'redacted') {
      await isolatedLog(log, { event: 'ocr_isolated_validate', ok: false, code: 'bad_return_mode' });
      return respond(400, { ok: false, code: 'bad_return_mode' });
    }
    if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
      await isolatedLog(log, { event: 'ocr_isolated_validate', ok: false, code: 'unsupported_content_type' });
      return respond(415, { ok: false, code: 'unsupported_content_type' });
    }

    const bytes = decodeBase64(imageB64);
    if (!bytes) {
      await isolatedLog(log, { event: 'ocr_isolated_validate', ok: false, code: 'invalid_base64' });
      return respond(400, { ok: false, code: 'invalid_base64' });
    }
    if (bytes.length <= 0) {
      await isolatedLog(log, { event: 'ocr_isolated_validate', ok: false, code: 'empty_image' });
      return respond(400, { ok: false, code: 'empty_image' });
    }
    const max = maxInputBytes();
    if (bytes.length > max) {
      await isolatedLog(log, { event: 'ocr_isolated_validate', ok: false, code: 'payload_too_large' });
      return respond(413, { ok: false, code: 'payload_too_large', maxBytes: max });
    }

    const extractCheck = deps.extractCheck || (await loadProvider()).extractCheck;
    const secretLoader = deps.secretLoader || (async () => defaultSecretLoader(deps));

    const extracted = await extractCheck({
      imageBytes: bytes,
      secretLoader,
      fetchImpl: deps.fetchImpl
        || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined),
      textractSend: deps.textractSend,
      sleep: deps.sleep,
      now: deps.now,
      log,
    });

    const redacted = buildRedactedResponse(extracted);
    redacted.input_bytes = bytes.length;
    redacted.ms = Date.now() - startedAt;
    if (extracted.textract_error) redacted.textract_error = 'textract_failed';
    if (extracted.azure_error) redacted.azure_error = extracted.azure_error;

    await isolatedLog(log, {
      event: 'ocr_isolated_validate',
      ok: true,
      code: 'ok',
      ms: redacted.ms,
      deleteConfirmed: extracted.azure_delete_confirmed === true,
    });

    return respond(200, redacted);
  } catch {
    await isolatedLog(log, { event: 'ocr_isolated_validate', ok: false, code: 'exception' });
    return respond(500, { ok: false, code: 'exception' });
  }
};

export const __test__ = {
  buildRedactedResponse,
  maxInputBytes,
  decodeBase64,
  isolatedLog,
  resolveImplModule,
  SECRET_ID,
  DEFAULT_MAX_BYTES,
};
