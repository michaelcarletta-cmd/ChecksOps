/**
 * Transfer-to-bank limits (save-tenant-wallet-withdraw-limits): the tenant's own per-transfer and
 * daily caps on moov-wallet-withdraw, the two SQL 164 columns of tenant_wallet_funding_settings.
 *
 * - Membership: the same check as the automatic funding settings (save-tenant-wallet-funding-settings,
 *   tenant-settings-handlers.mjs): resolveTenantAccess, any member of the tenant (canConfigure);
 *   partners, other tenants and platform roles do not act.
 * - Two-factor: saving needs the same wallet.fund step-up as funding, sends and withdrawals (owner
 *   decision 2026-11-13: "Yes, require two-factor"), verified within 15 minutes in this login, so a
 *   hijacked session cannot raise a limit and withdraw without a code. Reading needs no step-up.
 * - Writes: only wallet_withdraw_max_per_transfer_cents and wallet_withdraw_max_per_day_cents
 *   (tenant_id is the key of a new row), with the money-write flag set (SQL 136). null means no limit;
 *   a limit is a whole number of cents above zero (SQL 164's CHECKs).
 * - SQL 164 is applied in staging and production (record #1875). If the columns were ever missing, the
 *   route answers 503 limits_not_ready and writes nothing (a harmless fallback).
 */
import { withIdentity } from './data.mjs';
import { setMoneyWriteFlag } from './money-write-flag.mjs';
import { loadSessionFundStepUp, loginSessionBinding, WALLET_FUND_TOTP_ACTION } from './providers/production/moov-fund-authz.mjs';
import { resolveTenantAccess } from './tenant-email-domain.mjs';

export const WALLET_WITHDRAW_LIMIT_COLUMNS = Object.freeze([
  'wallet_withdraw_max_per_transfer_cents',
  'wallet_withdraw_max_per_day_cents',
]);
/** One billion dollars, in cents: above it the value is a typo, not a limit. */
export const WALLET_WITHDRAW_LIMIT_MAX_CENTS = 100_000_000_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isUuid = (value) => UUID_RE.test(String(value || ''));

const refuse = (spoof, statusCode, error, extra = {}) => ({
  ok: false, statusCode, error, spoofFieldsIgnored: spoof, ...extra,
});

const centsOrNull = (value) => (value === null || value === undefined ? null : Number(value));

const publicLimits = (row) => ({
  wallet_withdraw_max_per_transfer_cents: centsOrNull(row?.wallet_withdraw_max_per_transfer_cents),
  wallet_withdraw_max_per_day_cents: centsOrNull(row?.wallet_withdraw_max_per_day_cents),
});

/** The limits the request sets: null (no limit) or whole cents from 1 to the maximum. */
export function parseWithdrawLimitsPatch(body = {}) {
  const patch = {};
  for (const column of WALLET_WITHDRAW_LIMIT_COLUMNS) {
    if (!(column in body)) continue;
    const value = body[column];
    if (value === null || value === '') { patch[column] = null; continue; }
    const cents = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
    if (typeof cents !== 'number' || !Number.isSafeInteger(cents) || cents <= 0 || cents > WALLET_WITHDRAW_LIMIT_MAX_CENTS) {
      return {
        ok: false, statusCode: 400, error: 'invalid_field', field: column,
        message: `${column} must be empty (no limit) or a whole number of cents from 1 to ${WALLET_WITHDRAW_LIMIT_MAX_CENTS}`,
      };
    }
    patch[column] = cents;
  }
  if (Object.keys(patch).length === 0) return { ok: false, statusCode: 400, error: 'empty_patch' };
  return { ok: true, patch };
}

/** Runs fn inside a savepoint; a missing SQL 164 column (42703) answers { notReady: true }. */
async function sql164Guarded(client, name, fn) {
  await client.query(`SAVEPOINT ${name}`);
  try {
    const result = await fn();
    await client.query(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    if (error?.code === '42703') return { notReady: true };
    throw error;
  }
}

const NOT_READY_MESSAGE = 'Transfer-to-bank limits are not switched on yet. Nothing was saved.';

export const runSaveTenantWalletWithdrawLimits = async ({ client, mapping, claims, body, spoof }) => {
  const tenantId = body.tenantId || body.tenant_id;
  if (!isUuid(tenantId)) return refuse(spoof, 400, 'missing_tenant');
  const access = await resolveTenantAccess(client, mapping, tenantId);
  if (!access?.canView) return refuse(spoof, 403, 'cross_tenant_denied', { message: 'Not authorized' });
  if (!access?.canConfigure) {
    return refuse(spoof, 403, 'not_authorized', { message: 'Only a member of this organization can change transfer-to-bank limits.' });
  }

  const action = String(body.action || 'save').toLowerCase();
  if (action === 'get') {
    const read = await sql164Guarded(client, 'wallet_withdraw_limits_read', async () => ({
      row: (await client.query(
        `SELECT wallet_withdraw_max_per_transfer_cents, wallet_withdraw_max_per_day_cents
         FROM public.tenant_wallet_funding_settings WHERE tenant_id = $1::uuid LIMIT 1`,
        [tenantId],
      )).rows[0] || null,
    }));
    if (read.notReady) return refuse(spoof, 503, 'limits_not_ready', { message: NOT_READY_MESSAGE });
    return { ok: true, statusCode: 200, limits: publicLimits(read.row), spoofFieldsIgnored: spoof };
  }
  if (action !== 'save') return refuse(spoof, 400, 'invalid_action', { message: 'action must be get or save' });

  const parsed = parseWithdrawLimitsPatch(body);
  if (!parsed.ok) return { ...parsed, spoofFieldsIgnored: spoof };

  const stepUp = await loadSessionFundStepUp(client, {
    userId: mapping.application_user_id, tenantId, loginSession: loginSessionBinding(claims),
  });
  if (!stepUp) {
    return refuse(spoof, 401, 'totp_required', {
      actionKey: WALLET_FUND_TOTP_ACTION,
      message: 'Enter your two-factor code to change transfer-to-bank limits.',
    });
  }

  const columns = Object.keys(parsed.patch);
  const params = [tenantId, ...columns.map((column) => parsed.patch[column])];
  const saved = await sql164Guarded(client, 'wallet_withdraw_limits_save', async () => {
    await setMoneyWriteFlag(client);
    return {
      row: (await client.query(
        `INSERT INTO public.tenant_wallet_funding_settings (tenant_id, ${columns.join(', ')})
         VALUES ($1::uuid, ${columns.map((_, i) => `$${i + 2}::bigint`).join(', ')})
         ON CONFLICT (tenant_id) DO UPDATE SET ${columns.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}
         RETURNING wallet_withdraw_max_per_transfer_cents, wallet_withdraw_max_per_day_cents`,
        params,
      )).rows[0] || null,
    };
  });
  if (saved.notReady) return refuse(spoof, 503, 'limits_not_ready', { message: NOT_READY_MESSAGE });
  const written = saved.row ? publicLimits(saved.row) : null;
  if (!written || columns.some((column) => written[column] !== parsed.patch[column])) {
    return refuse(spoof, 409, 'withdraw_limits_update_not_applied');
  }
  return { ok: true, statusCode: 200, limits: written, stepup_id: stepUp.id, spoofFieldsIgnored: spoof };
};

export const handleSaveTenantWalletWithdrawLimits = (event, deps = {}) => withIdentity(
  event, runSaveTenantWalletWithdrawLimits, { write: true, commit: true, ...deps },
);
