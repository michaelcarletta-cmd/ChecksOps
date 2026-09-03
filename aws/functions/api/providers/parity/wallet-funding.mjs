/**
 * Faithful port of supabase/functions/_shared/walletFunding.ts money maths.
 */
export function toCents(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Math.round(value * 100);
  const raw = String(value).trim();
  if (!raw) return 0;
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(raw);
  if (!m) return Math.round(Number(raw) * 100);
  const sign = m[1] === '-' ? -1 : 1;
  const whole = m[2] || '0';
  const frac = (m[3] || '').padEnd(2, '0').slice(0, 2);
  return sign * (Number(whole) * 100 + Number(frac));
}

export const ACTIVE_FUNDING_STATUSES = ['draft', 'authorization_required', 'ready', 'initiating', 'pending'];
const TERMINAL_FUNDING_STATUSES = ['completed', 'failed', 'returned', 'canceled'];

export function isTerminalFundingStatus(status) {
  return TERMINAL_FUNDING_STATUSES.includes(String(status ?? ''));
}

export async function loadPaymentContext(client, paymentId) {
  const batch = (await client.query(
    `SELECT * FROM public.disbursement_batches WHERE id = $1::uuid`,
    [paymentId],
  )).rows[0];
  if (!batch) return null;
  const splits = (await client.query(
    `SELECT id, amount, status, moov_transfer_id FROM public.disbursement_splits WHERE batch_id = $1::uuid`,
    [paymentId],
  )).rows;
  const payable = (splits ?? []).filter(
    (s) => !s.moov_transfer_id && !['failed', 'cancelled', 'canceled', 'returned', 'settled'].includes(String(s.status)),
  );
  return {
    batch,
    paymentCents: payable.reduce((sum, s) => sum + toCents(s.amount), 0),
    payableSplitCount: payable.length,
  };
}

export async function loadFundingSettings(client, tenantId) {
  const row = (await client.query(
    `SELECT * FROM public.wallet_funding_settings WHERE tenant_id = $1::uuid LIMIT 1`,
    [tenantId],
  )).rows[0];
  return row || { auto_fund_enabled: true, retain_cents: 0 };
}

export async function pulledTodayCents(client, tenantId) {
  const row = (await client.query(
    `SELECT coalesce(sum(amount_cents), 0)::bigint AS cents
     FROM public.wallet_funding_requests
     WHERE tenant_id = $1::uuid
       AND status = ANY($2::text[])
       AND created_at >= date_trunc('day', now())`,
    [tenantId, ACTIVE_FUNDING_STATUSES],
  )).rows[0];
  return Number(row?.cents || 0);
}

export function calculateFunding({ paymentCents, availableCents, retainCents = 0 }) {
  const available = Math.max(0, Number(availableCents) || 0);
  const retain = Math.max(0, Number(retainCents) || 0);
  const payment = Math.max(0, Number(paymentCents) || 0);
  const usable = Math.max(0, available - retain);
  const covered = Math.min(usable, payment);
  const shortage = Math.max(0, payment - covered);
  return {
    payment_cents: payment,
    available_cents: available,
    retain_cents: retain,
    usable_cents: usable,
    covered_cents: covered,
    shortage_cents: shortage,
    fully_funded: shortage === 0,
  };
}
