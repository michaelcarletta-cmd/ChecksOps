/**
 * Record a payment made outside ChecksOps against a check (route record-external-disbursement).
 *
 * Owner report 2026-11-09: "Disburse outside of Checksops should allow them to input the check #,
 * amount, recipient, memo and the funds will move as if they were sent via moov for tracking".
 * The Funds tab and the Disbursement Console used to insert disbursement_batches /
 * disbursement_splits from the browser; the generic /data/write route refuses both tables
 * (write-allowlist.mjs FINANCIAL_OR_PROVIDER_TABLES), so nothing was recorded.
 *
 * This route runs as the verified sign-in (withIdentity: request.app_user_id from the Cognito token,
 * never from the body) and makes one call, SQL 147's
 * public.aws_record_external_disbursement(tenant, check, payments, key), which in one transaction
 * checks membership and the check's owner, locks the check, enforces the amount available on it,
 * is idempotent on the key, and writes one completed batch and one settled external_check split per
 * payee. It never calls Moov and writes no payment_transfers or wallet row: no money moves.
 */
import { withIdentity } from './data.mjs';

export const RECORD_EXTERNAL_DISBURSEMENT_SQL =
  'SELECT public.aws_record_external_disbursement($1::uuid, $2::uuid, $3::jsonb, $4::text) AS result';

export const MAX_EXTERNAL_PAYMENTS = 10;
export const EXTERNAL_RECIPIENT_TYPES = Object.freeze([
  'subcontractor', 'contractor', 'sales_rep', 'appraisal', 'supplier', 'adjuster', 'vendor', 'insured', 'other',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_RE = /^[A-Za-z0-9_:-]{8,100}$/;
const text = (value) => (typeof value === 'string' ? value.trim() : '');

const refuse = (statusCode, error, message, spoof, extra = {}) => ({
  ok: false, statusCode, error, message, spoofFieldsIgnored: spoof, ...extra,
});

/** Validates the request shape; the database function validates again under the check's lock. */
export function parseExternalDisbursementRequest(body = {}) {
  const tenantId = body.tenant_id || body.tenantId;
  const checkId = body.check_intake_item_id || body.check_id;
  const key = body.idempotency_key;
  if (!UUID_RE.test(String(tenantId || ''))) return { error: 'tenant_id is required' };
  if (!UUID_RE.test(String(checkId || ''))) return { error: 'check_intake_item_id is required' };
  if (!KEY_RE.test(String(key || ''))) return { error: 'idempotency_key is required' };
  const list = body.payments;
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_EXTERNAL_PAYMENTS) {
    return { error: `payments must list 1 to ${MAX_EXTERNAL_PAYMENTS} payments` };
  }
  const payments = [];
  for (const p of list) {
    const cents = p?.amount_cents;
    if (!Number.isSafeInteger(cents) || cents <= 0) return { error: 'amount_cents must be a whole number of cents above 0' };
    const account = p.stakeholder_account_id ? String(p.stakeholder_account_id) : null;
    if (account && !UUID_RE.test(account)) return { error: 'stakeholder_account_id is invalid' };
    const name = text(p.recipient_name);
    if (!name && !account) return { error: 'Enter who was paid' };
    const type = text(p.recipient_type) || null;
    if (type && !EXTERNAL_RECIPIENT_TYPES.includes(type)) return { error: 'recipient_type is invalid' };
    const number = text(p.external_check_number) || null;
    const memo = text(p.memo) || null;
    if (name.length > 200 || (number && number.length > 40) || (memo && memo.length > 500)) {
      return { error: 'A field is too long' };
    }
    payments.push({
      amount_cents: cents,
      recipient_name: name || null,
      recipient_type: type,
      external_check_number: number,
      memo,
      stakeholder_account_id: account,
    });
  }
  return { tenantId: String(tenantId), checkId: String(checkId), key: String(key), payments };
}

const dollars = (cents) => (Number(cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Maps SQL 147's exceptions to API answers; anything else is rethrown (withIdentity answers it). */
export function mapExternalDisbursementError(error, spoof) {
  const message = String(error?.message || '');
  if (/^external_disbursement_forbidden/.test(message)) {
    return refuse(403, 'cross_tenant_denied', 'Only a member of this organization can record a payment on its check.', spoof);
  }
  if (/^external_disbursement_check_not_found/.test(message)) {
    return refuse(404, 'check_not_found', 'Check not found for this organization.', spoof);
  }
  const over = message.match(/^external_disbursement_exceeds_available: available_cents=(\d+)/);
  if (over) {
    const available = Number(over[1]);
    return refuse(409, 'amount_exceeds_available', `Amount exceeds what is left on this check ($${dollars(available)} available).`, spoof, { available_cents: available });
  }
  if (/^external_disbursement_key_reused/.test(message)) {
    return refuse(409, 'idempotency_key_reused', 'That request was already used for a different payment.', spoof);
  }
  const invalid = message.match(/^external_disbursement_invalid: (.*)$/);
  if (invalid) return refuse(400, 'invalid_external_disbursement', `Invalid payment: ${invalid[1]}`, spoof);
  if (error?.code === '42883') {
    // SQL 147 is not applied in this environment yet.
    return refuse(503, 'external_disbursement_unavailable', 'Recording outside payments is not available yet. Nothing was recorded.', spoof);
  }
  throw error;
}

export async function runRecordExternalDisbursement({ client, body, spoof }) {
  const request = parseExternalDisbursementRequest(body);
  if (request.error) return refuse(400, 'invalid_external_disbursement', request.error, spoof);
  let result;
  try {
    await client.query("SET LOCAL lock_timeout = '10s'");
    result = (await client.query(RECORD_EXTERNAL_DISBURSEMENT_SQL, [
      request.tenantId, request.checkId, JSON.stringify(request.payments), request.key,
    ])).rows[0]?.result;
  } catch (error) {
    return mapExternalDisbursementError(error, spoof);
  }
  if (!result?.batch_id) {
    return refuse(500, 'external_disbursement_not_recorded', 'The payment could not be recorded.', spoof);
  }
  return {
    ok: true,
    statusCode: 200,
    batch_id: result.batch_id,
    split_ids: result.split_ids || [],
    duplicate: result.duplicate === true,
    total_cents: Number(result.total_cents),
    remaining_cents: Number(result.remaining_cents),
    fully_disbursed: result.fully_disbursed === true,
    moneyMoved: false,
    spoofFieldsIgnored: spoof,
  };
}

export const handleRecordExternalDisbursement = (event, deps = {}) => withIdentity(event, runRecordExternalDisbursement, {
  write: true,
  commit: true,
  ...deps,
});
