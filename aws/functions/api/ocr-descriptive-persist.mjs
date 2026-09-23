/**
 * Post-OCR application handoff: persist issue_date, normalized descriptive
 * text, pending check_payees, and detected_claim_number via a narrow RPC.
 *
 * Does not extract, call Azure/Textract, persist amount, or write MICR.
 * Generic /data/write stays blocked for detected_claim_number.
 * Does not invoke CheckAlt or Moov.
 * Claim numbers identify the claim: many checks may share one number
 * and link to the same existing tenant claim. Never inserts a claims row.
 */
import { cleanPayeeLine, looksLikeSecurityDisclaimer, matchKnownCarrier, sanitizeCarrierName } from './ocr-parse.mjs';
import {
  normalizeClaimNumber,
  normalizeDescriptiveText,
} from './ocr-descriptive-text.mjs';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PAYEE_NAME = 200;

const isUuid = (value) => UUID_RE.test(String(value || ''));

export const normalizePayeeKey = (name) => String(name || '')
  .trim()
  .replace(/\s+/g, ' ')
  .toLowerCase();

export const normalizePayeeName = (name) => {
  const text = normalizeDescriptiveText(name, { max: MAX_PAYEE_NAME });
  if (!text || text.length < 2) return null;
  return text;
};

export const normalizeIssueDate = (value) => {
  if (value == null || value === '') return null;
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`;
  }
  const raw = String(value).trim();
  if (!raw) return null;
  if (DATE_RE.test(raw)) return raw;
  if (/^\d{4}-\d{2}-\d{2}[T\s]/.test(raw)) {
    const day = raw.slice(0, 10);
    return DATE_RE.test(day) ? day : null;
  }
  const mdy = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (mdy) {
    let mm = Number(mdy[1]);
    let dd = Number(mdy[2]);
    let yy = Number(mdy[3]);
    if (yy < 100) yy = yy >= 70 ? 1900 + yy : 2000 + yy;
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
    return `${String(yy).padStart(4, '0')}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  }
  return null;
};

export const collectOcrPayeeCandidates = (parsed = {}) => {
  const seen = new Set();
  const out = [];
  const rows = Array.isArray(parsed.payees) ? parsed.payees : [];
  for (const row of rows) {
    const cleaned = cleanPayeeLine(row?.name);
    if (row?.name && !cleaned) continue;
    const name = normalizePayeeName(cleaned || row?.name);
    if (!name) continue;
    const key = normalizePayeeKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ name, key });
  }
  return out;
};

const persistCode = ({
  issueDatePersisted = false,
  inserted = 0,
  skipped = 0,
  multiPayeeSet = false,
  claim = 'none',
} = {}) => (
  `date_${issueDatePersisted ? 1 : 0}_ins_${inserted}_skip_${skipped}_multi_${multiPayeeSet ? 1 : 0}_claim_${claim}`
);

export const persistOcrDescriptiveHandoff = async ({
  client,
  checkId,
  tenantId = null,
  parsed = {},
  log = null,
} = {}) => {
  const empty = {
    ok: true,
    issue_date_persisted: false,
    payees_inserted: 0,
    payees_skipped: 0,
    multi_payee_set: false,
    claim_persisted: false,
    claim_code: 'none',
    code: persistCode(),
  };
  if (!client || !isUuid(checkId)) {
    return { ...empty, ok: false, code: 'invalid_check' };
  }

  const issueDate = normalizeIssueDate(parsed.issue_date);
  const alias = matchKnownCarrier(parsed.carrier_name);
  const carrierGate = sanitizeCarrierName(parsed.carrier_name);
  const carrierName = alias || (carrierGate ? normalizeDescriptiveText(parsed.carrier_name) : null);
  const payeeLine = normalizeDescriptiveText(cleanPayeeLine(parsed.payee_line) || parsed.payee_line);
  const clearBadCarrier = !carrierName && (
    looksLikeSecurityDisclaimer(parsed.carrier_name)
    || Boolean(parsed.diagnostic?.carrier_rejected_disclaimer)
  );
  const candidates = collectOcrPayeeCandidates(parsed);
  let issueDatePersisted = false;
  let inserted = 0;
  let skipped = 0;
  let multiPayeeSet = false;
  let claimPersisted = false;
  let claimCode = 'none';

  const incomingClaim = normalizeClaimNumber(
    parsed.claim_number || parsed.detected_claim_number,
  );
  if (incomingClaim) {
    try {
      await client.query('SAVEPOINT ocr_claim_number');
      const rpc = await client.query(
        `SELECT public.ocr_persist_detected_claim_number($1::uuid, $2::uuid, $3::text) AS result`,
        [checkId, isUuid(tenantId) ? tenantId : null, incomingClaim],
      );
      const row = rpc.rows?.[0]?.result || {};
      claimPersisted = row.persisted === true;
      claimCode = String(row.code || 'written');
      await client.query('RELEASE SAVEPOINT ocr_claim_number');
    } catch {
      try { await client.query('ROLLBACK TO SAVEPOINT ocr_claim_number'); } catch { /* ignore */ }
      claimCode = 'rpc_unavailable';
    }
  }

  if (issueDate) {
    await client.query(
      `UPDATE public.check_intake_items
       SET issue_date = $2::date, updated_at = now()
       WHERE id = $1::uuid`,
      [checkId, issueDate],
    );
    issueDatePersisted = true;
  }

  if (carrierName || payeeLine || clearBadCarrier) {
    await client.query(
      `UPDATE public.check_intake_items
       SET carrier_name = CASE
             WHEN $4::boolean THEN NULL
             ELSE COALESCE($2, carrier_name)
           END,
           payee_line = COALESCE($3, payee_line),
           updated_at = now()
       WHERE id = $1::uuid`,
      [checkId, carrierName, payeeLine, clearBadCarrier],
    );
  }

  const existing = (await client.query(
    `SELECT id, payee_name
     FROM public.check_payees
     WHERE check_id = $1::uuid`,
    [checkId],
  )).rows || [];
  const existingKeys = new Set(
    existing.map((row) => normalizePayeeKey(row?.payee_name)).filter(Boolean),
  );

  for (const candidate of candidates) {
    if (existingKeys.has(candidate.key)) {
      skipped += 1;
      continue;
    }
    await client.query(
      `INSERT INTO public.check_payees (
         check_id, tenant_id, payee_name, payee_type,
         endorsement_token, endorsement_token_expires_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::text, 'unknown',
         $4::uuid, now() + interval '30 days'
       )`,
      [checkId, isUuid(tenantId) ? tenantId : null, candidate.name, crypto.randomUUID()],
    );
    existingKeys.add(candidate.key);
    inserted += 1;
  }

  if (candidates.length > 1) {
    await client.query(
      `UPDATE public.check_intake_items
       SET is_multi_payee = true, updated_at = now()
       WHERE id = $1::uuid`,
      [checkId],
    );
    multiPayeeSet = true;
  }

  const result = {
    ok: true,
    issue_date_persisted: issueDatePersisted,
    payees_inserted: inserted,
    payees_skipped: skipped,
    multi_payee_set: multiPayeeSet,
    claim_persisted: claimPersisted,
    claim_code: claimCode,
    code: persistCode({
      issueDatePersisted,
      inserted,
      skipped,
      multiPayeeSet,
      claim: claimCode,
    }),
  };
  if (typeof log === 'function') {
    log({
      event: 'ocr_descriptive_persist',
      ok: true,
      code: result.code,
    });
  }
  return result;
};

export const __test__ = {
  normalizePayeeKey,
  normalizePayeeName,
  normalizeIssueDate,
  collectOcrPayeeCandidates,
  persistCode,
};
