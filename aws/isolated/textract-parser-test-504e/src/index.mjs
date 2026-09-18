import crypto from 'node:crypto';
import {
  TextractClient,
  AnalyzeDocumentCommand,
  DetectDocumentTextCommand,
} from '@aws-sdk/client-textract';
import { parseCheckFields } from './ocr-parse.mjs';

const ALLOWED_CONTENT_TYPES = new Set(['image/jpeg', 'image/png']);

const maxInputBytes = () => {
  const raw = Number(process.env.MAX_INPUT_BYTES || 0);
  if (!Number.isFinite(raw) || raw <= 0) return 4 * 1024 * 1024;
  return Math.min(Math.max(256 * 1024, Math.floor(raw)), 5 * 1024 * 1024);
};

const stableNormalize = (value) => {
  if (value == null) return null;
  const s = String(value).trim().replace(/\s+/g, ' ');
  return s ? s : null;
};

const fingerprintSha256 = (value) => {
  const s = stableNormalize(value);
  if (!s) return null;
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
};

const digitsOnly = (v) => String(v || '').replace(/[^0-9]/g, '');

const maskedLast4 = (v) => {
  const d = digitsOnly(v);
  if (!d) return null;
  if (d.length <= 4) return `***${d}`;
  return `***${d.slice(-4)}`;
};

const isBase64ish = (value) => {
  if (typeof value !== 'string') return false;
  const s = value.trim();
  if (!s) return false;
  if (s.length > 8 * 1024 * 1024) return false; // reject obviously huge before decode
  // Basic allowed alphabet check (ignore whitespace).
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

const textractClient = () => new TextractClient({ region: process.env.AWS_REGION || 'us-east-1' });

const buildRedactedField = (key, parsed) => {
  const value = parsed?.[key] ?? null;
  const present = value != null && String(value).trim() !== '';
  const confidence = parsed?.field_confidence?.[key] ?? null;
  return {
    present,
    confidence,
    fingerprint_sha256: present ? fingerprintSha256(value) : null,
  };
};

const buildRedactedPayees = (parsed) => {
  const list = Array.isArray(parsed?.payees) ? parsed.payees : [];
  const names = list
    .map((p) => stableNormalize(p?.name))
    .filter(Boolean);
  const fingerprints = names.map((n) => fingerprintSha256(n)).filter(Boolean);
  return {
    present: fingerprints.length > 0,
    count: fingerprints.length,
    fingerprints_sha256: fingerprints,
  };
};

const buildRedactedMicr = (parsed) => {
  const routing = parsed?.routing_number ?? null;
  const account = parsed?.account_number ?? null;
  const micrCheck = parsed?.micr_check_number ?? null;
  return {
    routing_number: {
      present: Boolean(stableNormalize(routing)),
      confidence: parsed?.field_confidence?.routing_number ?? null,
      masked_last4: maskedLast4(routing),
      fingerprint_sha256: fingerprintSha256(routing),
    },
    account_number: {
      present: Boolean(stableNormalize(account)),
      confidence: parsed?.field_confidence?.account_number ?? null,
      masked_last4: maskedLast4(account),
      fingerprint_sha256: fingerprintSha256(account),
    },
    micr_check_number: {
      present: Boolean(stableNormalize(micrCheck)),
      confidence: parsed?.field_confidence?.micr_check_number ?? null,
      masked_last4: maskedLast4(micrCheck),
      fingerprint_sha256: fingerprintSha256(micrCheck),
    },
  };
};

const buildRedactedResponse = (parsed) => ({
  confidence: parsed?.confidence ?? null,
  needs_manual_review: Boolean(parsed?.needs_manual_review),
  low_confidence_fields: Array.isArray(parsed?.low_confidence_fields) ? parsed.low_confidence_fields : [],
  field_confidence: parsed?.field_confidence ?? {},
  fields: {
    carrier_name: buildRedactedField('carrier_name', parsed),
    check_number: buildRedactedField('check_number', parsed),
    issue_date: buildRedactedField('issue_date', parsed),
    amount: buildRedactedField('amount', parsed),
    written_amount: buildRedactedField('written_amount', parsed),
    payee_line: buildRedactedField('payee_line', parsed),
    claim_number: buildRedactedField('claim_number', parsed),
    bank_name: buildRedactedField('bank_name', parsed),
    memo: buildRedactedField('memo', parsed),
    payees: buildRedactedPayees(parsed),
    micr: buildRedactedMicr(parsed),
  },
  diagnostic: parsed?.diagnostic && typeof parsed.diagnostic === 'object' ? parsed.diagnostic : null,
});

const respond = (statusCode, body) => ({
  statusCode,
  ...body,
});

export const handler = async (event = {}, context = {}) => {
  const startedAt = Date.now();
  const requestId = context?.awsRequestId || null;

  const log = (entry) => {
    // Never log request/response bodies; only structured non-sensitive metadata.
    console.log(JSON.stringify({
      requestId,
      ms: Date.now() - startedAt,
      ...entry,
    }));
  };

  try {
    const contentType = event?.contentType;
    const imageB64 = event?.imageB64;
    const returnMode = event?.returnMode;

    if (returnMode !== 'redacted') {
      log({ ok: false, code: 'bad_return_mode' });
      return respond(400, { ok: false, code: 'bad_return_mode' });
    }
    if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
      log({ ok: false, code: 'unsupported_content_type' });
      return respond(415, { ok: false, code: 'unsupported_content_type' });
    }

    const bytes = decodeBase64(imageB64);
    if (!bytes) {
      log({ ok: false, code: 'invalid_base64' });
      return respond(400, { ok: false, code: 'invalid_base64' });
    }
    if (bytes.length <= 0) {
      log({ ok: false, code: 'empty_image' });
      return respond(400, { ok: false, code: 'empty_image' });
    }

    const max = maxInputBytes();
    if (bytes.length > max) {
      log({ ok: false, code: 'payload_too_large', inputBytes: bytes.length });
      return respond(413, { ok: false, code: 'payload_too_large', inputBytes: bytes.length, maxBytes: max });
    }

    let engine = 'aws_textract';
    let blocks = [];
    try {
      const analyzed = await textractClient().send(new AnalyzeDocumentCommand({
        Document: { Bytes: bytes },
        FeatureTypes: ['FORMS'],
      }));
      blocks = analyzed?.Blocks || [];
      engine = 'aws_textract_analyze';
    } catch {
      try {
        const detected = await textractClient().send(new DetectDocumentTextCommand({
          Document: { Bytes: bytes },
        }));
        blocks = detected?.Blocks || [];
        engine = 'aws_textract_detect';
      } catch {
        log({ ok: false, code: 'textract_failed', engine });
        return respond(502, { ok: false, code: 'textract_failed', engine });
      }
    }

    const parsed = parseCheckFields(blocks);
    const redacted = buildRedactedResponse(parsed);

    log({
      ok: true,
      code: 'ok',
      engine,
      inputBytes: bytes.length,
      manualReview: redacted.needs_manual_review,
    });

    return respond(200, {
      ok: true,
      code: 'ok',
      engine,
      inputBytes: bytes.length,
      ...redacted,
    });
  } catch {
    log({ ok: false, code: 'exception' });
    return respond(500, { ok: false, code: 'exception' });
  }
};

