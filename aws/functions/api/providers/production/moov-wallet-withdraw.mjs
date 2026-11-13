/**
 * Production WalletOps transfer to bank (moov-wallet-withdraw): tenant operating
 * wallet → the tenant's own verified settlement bank, by same-day ACH.
 *
 * Design: docs/WALLET_TO_BANK_TRANSFER_DESIGN.md and its owner decisions
 * (2026-11-13): no fee; any tenant member; no admin approval; the same wallet.fund
 * two-factor step-up as funding and sends; operating wallet only; any amount up to
 * the wallet's available balance read from Moov at submit time, and up to the
 * tenant's own limits when it has set them (SQL 164 columns).
 *
 * Money safety (the funding contract, moov-wallet-fund.mjs):
 * - Each click carries its own idempotency key; a retry with the same key never
 *   sends a second transfer.
 * - The transfer row is committed before Moov is called, then claimed
 *   ready → submitting, so two racing requests cannot both POST.
 * - Moov's own idempotency key is the transfer row id.
 * - An error that does not prove Moov refused the transfer is recorded as
 *   `unknown` and is never retried automatically.
 * - The destination is never chosen by the browser: it is the tenant's default
 *   connected bank (owner decision 2026-11-13: "transfers go to default bank"),
 *   verified at Moov, with an ach-credit-same-day payment method. Without a
 *   default bank nothing is sent. Never a recipient method.
 * - SQL 164 (the limit columns, and the webhook writer owning the
 *   wallet_withdrawal leg) is applied in staging and production (record #1875).
 *   The 503 withdrawal_not_ready guard stays as a fallback: if the columns were
 *   ever missing, nothing is recorded or sent.
 */
import { APP_USER_EMAIL_GUC, APP_USER_ID_GUC } from '../../cognito.mjs';
import { financialPermissionsActivated } from '../../financial-flags.mjs';
import { isUuid } from '../../financial-ownership.mjs';
import { setMoneyWriteFlag } from '../../money-write-flag.mjs';
import { providerSandboxExecutionEnabled } from '../../sandbox-flags.mjs';
import {
  MoovError,
  moovFetch,
  normalizeTransferStatus,
  scopes,
  withMoovContext,
} from '../parity/moov-client.mjs';
import { fail, jsonResult, moovProductionReadContext } from '../parity/caller.mjs';
import { loadMoovAccount, sanitize } from '../parity/db.mjs';
import { syncWalletReadOnly } from '../parity/moov-wallet.mjs';
import { isBankingDay, nextBankingDay } from '../../fed-holidays.mjs';
import { sameDayWindowOpen } from '../parity/rail-router.mjs';
import { loadSessionFundStepUp, loginSessionBinding, WALLET_FUND_TOTP_ACTION } from './moov-fund-authz.mjs';
import {
  MOOV_POST_TIMEOUT_MS,
  moovRefusedTransfer,
  parseFundAmountCents,
  resolveFacilitatorId,
  transferPostEnabled,
} from './moov-wallet-fund.mjs';

const ENVIRONMENT = 'production';
const OPERATION = 'wallet.withdraw';
export const WALLET_WITHDRAW_KEY_PREFIX = 'wallet-withdraw:';
export const WALLET_WITHDRAW_LEG = 'wallet_withdrawal';
export const WALLET_WITHDRAW_RAIL = 'ach-credit-same-day';
/** Wallet legs that spend the available balance while they are in flight. */
const WALLET_SPENDING_LEGS = ['send_wallet', WALLET_WITHDRAW_LEG];

const REPLAYABLE_STATUSES = new Set(['ready']);
const SETTLED_BAD = new Set(['failed', 'canceled', 'returned']);

async function bindRequestGucs(client, mapping, claims) {
  await client.query('SELECT set_config($1, $2, true)', [APP_USER_ID_GUC, mapping.application_user_id]);
  await client.query('SELECT set_config($1, $2, true)', [APP_USER_EMAIL_GUC, mapping.email || claims?.email || '']);
  await client.query("SELECT set_config('request.financial_execution', '1', true)");
  await client.query('SELECT set_config($1, $2, true)', [
    'request.aws_financial_permissions_activated',
    financialPermissionsActivated() ? '1' : '0',
  ]);
  // Every money-table write below runs in a transaction that carries the flag (SQL 136).
  await setMoneyWriteFlag(client);
}

/** Make everything so far durable, then continue in a new transaction. */
async function commitAndContinue(client, mapping, claims) {
  const committed = await client.query('COMMIT');
  if (String(committed?.command || 'COMMIT').toUpperCase() === 'ROLLBACK') {
    const error = new Error('transaction_not_committed');
    error.code = 'TRANSACTION_NOT_COMMITTED';
    throw error;
  }
  await client.query('BEGIN');
  await client.query('SET TRANSACTION READ WRITE');
  await bindRequestGucs(client, mapping, claims);
}

/** The event log is informational; a failed insert must not abort the transaction. */
async function logEvent(client, row) {
  await client.query('SAVEPOINT wallet_withdraw_event');
  try {
    await client.query(
      `INSERT INTO public.payment_event_log
        (provider, environment, tenant_id, event_type, new_status, previous_status,
         transfer_id, provider_transfer_id, provider_metadata)
       VALUES ('moov', $1, $2::uuid, $3, $4, $5, $6::uuid, $7, $8::jsonb)`,
      [
        ENVIRONMENT, row.tenantId, row.eventType, row.newStatus || null, row.previousStatus || null,
        row.transferId, row.providerTransferId || null, JSON.stringify(sanitize(row.metadata || {})),
      ],
    );
    await client.query('RELEASE SAVEPOINT wallet_withdraw_event');
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT wallet_withdraw_event');
    console.warn(JSON.stringify({
      service: 'checksops-api',
      event: 'wallet_withdraw_event_log_failed',
      eventType: row.eventType,
      transferId: row.transferId,
      sqlstate: error?.code || null,
    }));
  }
}

const transferByKey = async (client, tenantId, key) => (await client.query(
  `SELECT * FROM public.payment_transfers
   WHERE tenant_id = $1::uuid AND idempotency_key = $2 LIMIT 1`,
  [tenantId, key],
)).rows[0] || null;

/** The tenant's own connected banks (never a recipient's), default first. */
const connectedBanks = async (client, tenantId, providerAccountId) => (await client.query(
  `SELECT id, provider_bank_account_id, is_default
   FROM public.payment_provider_methods
   WHERE tenant_id = $1::uuid AND provider = 'moov' AND environment = $2
     AND provider_account_id = $3 AND connection_status = 'connected'
     AND external_recipient_id IS NULL
   ORDER BY is_default DESC NULLS LAST, created_at DESC NULLS LAST`,
  [tenantId, ENVIRONMENT, providerAccountId],
)).rows;

/**
 * The tenant's own transfer-to-bank limits (SQL 164). null means no limit.
 * `{ ready: false }` only if SQL 164's columns are missing (it is applied in both
 * environments; a fallback): then nothing may be sent.
 */
export async function loadWithdrawLimits(client, tenantId) {
  await client.query('SAVEPOINT wallet_withdraw_limits');
  try {
    const row = (await client.query(
      `SELECT wallet_withdraw_max_per_transfer_cents, wallet_withdraw_max_per_day_cents
       FROM public.tenant_wallet_funding_settings
       WHERE tenant_id = $1::uuid LIMIT 1`,
      [tenantId],
    )).rows[0];
    await client.query('RELEASE SAVEPOINT wallet_withdraw_limits');
    const cents = (value) => (value === null || value === undefined ? null : Number(value));
    return {
      ready: true,
      perTransfer: cents(row?.wallet_withdraw_max_per_transfer_cents),
      perDay: cents(row?.wallet_withdraw_max_per_day_cents),
    };
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT wallet_withdraw_limits');
    if (error?.code === '42703' || error?.code === '42P01') return { ready: false };
    throw error;
  }
}

/** Which limit, if any, this amount breaks. Pure. */
export function tenantLimitBreach({ amount, perTransfer, perDay, todayCents }) {
  if (perTransfer !== null && perTransfer !== undefined && amount > perTransfer) {
    return { limit: 'per_transfer', limit_cents: perTransfer };
  }
  if (perDay !== null && perDay !== undefined && Number(todayCents || 0) + amount > perDay) {
    return { limit: 'per_day', limit_cents: perDay, used_today_cents: Number(todayCents || 0) };
  }
  return null;
}

const bankIdOf = (method) => String(method?.bankAccount?.bankAccountID ?? method?.bankAccount?.bankAccountId ?? '');
const methodIdOf = (method) => String(method?.paymentMethodID ?? method?.paymentMethodId ?? '');
const bankVerified = (method) => String(method?.bankAccount?.status ?? '').toLowerCase() === 'verified';

/**
 * The bank to credit: the tenant's default bank only. Moov must list an
 * ach-credit-same-day method for that bank, on a bank Moov reports verified.
 * With no default bank, `default_bank_required`; never another bank.
 */
export function selectSameDayCreditMethod(methods, defaultBankId) {
  if (!defaultBankId) return { error: 'default_bank_required' };
  const credits = (Array.isArray(methods) ? methods : [])
    .filter((m) => String(m?.paymentMethodType) === WALLET_WITHDRAW_RAIL && methodIdOf(m) && bankVerified(m));
  const preferred = credits.find((m) => bankIdOf(m) === String(defaultBankId));
  return preferred ? { method: preferred } : { error: 'same_day_unavailable' };
}

const easternDate = (now) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(now);

/**
 * When the credit is expected, decided by the server clock: today when today
 * (New York) is a banking day and it is before the same-day cutoff, otherwise
 * the next banking day. Banking days skip weekends and the observed Federal
 * Reserve holidays (fed-holidays.mjs).
 */
export function expectedArrival(now = new Date()) {
  const today = easternDate(now);
  if (isBankingDay(today) && sameDayWindowOpen(now)) return { arrives: 'today', date: today };
  return { arrives: 'next_banking_day', date: nextBankingDay(today) };
}

const arrivalMessage = (arrival) => (arrival.arrives === 'today'
  ? 'Arrives today'
  : "Arrives next banking day (sent after today's same-day cutoff)");

const publicWallet = (row) => ({
  wallet_type: row.wallet_type,
  available_cents: Number(row.available_cents ?? 0),
  pending_cents: Number(row.pending_cents ?? 0),
  status: row.status,
  last_synced_at: row.last_synced_at ?? null,
});

const publicTransfer = (row) => (row ? {
  id: row.id,
  status: row.status,
  provider_status: row.provider_status,
  amount_cents: Number(row.amount_cents),
  provider_transfer_id: row.provider_transfer_id,
  created_at: row.created_at,
  submitted_at: row.submitted_at,
} : null);

/** A repeat of an earlier click reports that click's real outcome. */
function duplicateResult(row) {
  const status = String(row?.status || '');
  if (SETTLED_BAD.has(status)) {
    return fail('withdrawal_failed', 409, { duplicate: true, transfer: publicTransfer(row), message: 'This transfer to your bank did not go through. Nothing was sent.' });
  }
  if (status === 'unknown' || status === 'submitting') {
    return fail('provider_outcome_unknown', 409, {
      duplicate: true,
      transfer: publicTransfer(row),
      message: 'We could not confirm whether this transfer to your bank went through. Check WalletOps before trying again.',
    });
  }
  return jsonResult({ success: true, duplicate: true, transfer: publicTransfer(row), liveProviderCalled: false });
}

/** Sum of the tenant's in-flight wallet spending (sends and withdrawals), not this row. */
const reservedWalletCents = async (client, tenantId, excludeId) => Number((await client.query(
  `SELECT COALESCE(sum(amount_cents), 0)::bigint AS cents FROM public.payment_transfers
   WHERE tenant_id = $1::uuid AND environment = $2 AND leg_role = ANY($3::text[])
     AND ($4::uuid IS NULL OR id <> $4::uuid)
     AND (status IN ('ready', 'submitting')
       OR (status IN ('submitted', 'pending', 'processing') AND submitted_at > now() - interval '2 minutes'))
     AND created_at > now() - interval '15 minutes'`,
  [tenantId, ENVIRONMENT, WALLET_SPENDING_LEGS, excludeId || null],
)).rows[0]?.cents ?? 0);

/** The tenant's non-failed transfers to bank this banking day (America/New_York), not this row. */
const withdrawnTodayCents = async (client, tenantId, excludeId) => Number((await client.query(
  `SELECT COALESCE(sum(amount_cents), 0)::bigint AS cents FROM public.payment_transfers
   WHERE tenant_id = $1::uuid AND environment = $2 AND leg_role = $3
     AND ($4::uuid IS NULL OR id <> $4::uuid)
     AND status NOT IN ('failed', 'canceled', 'returned')
     AND created_at >= ((now() AT TIME ZONE 'America/New_York')::date::timestamp AT TIME ZONE 'America/New_York')`,
  [tenantId, ENVIRONMENT, WALLET_WITHDRAW_LEG, excludeId || null],
)).rows[0]?.cents ?? 0);

async function withdrawProductionWallet({ client, mapping, claims, ctx, body, fetchImpl, now }) {
  const tenantId = ctx.tenantId;
  const walletType = body.wallet_type ?? 'operating';
  if (walletType !== 'operating') return fail("wallet_type must be 'operating'", 400);
  const amount = parseFundAmountCents(body.amount_cents);
  if (amount === null) return fail('Amount must be a whole number of cents greater than zero.', 400);
  const clickKey = String(body.idempotency_key || '').trim();
  if (!isUuid(clickKey)) return fail('idempotency_key is required', 400);
  const key = `${WALLET_WITHDRAW_KEY_PREFIX}${clickKey.toLowerCase()}`;

  // The same two-factor step-up as funding and sends (owner decision 7).
  const loginSession = loginSessionBinding(claims);
  const stepUp = await loadSessionFundStepUp(client, {
    userId: mapping.application_user_id, tenantId, loginSession,
  });
  if (!stepUp) {
    return fail('totp_required', 401, {
      actionKey: WALLET_FUND_TOTP_ACTION,
      message: 'Enter your two-factor code to transfer to your bank.',
    });
  }

  await bindRequestGucs(client, mapping, claims);

  let draft = await transferByKey(client, tenantId, key);
  if (!draft && !transferPostEnabled()) {
    return fail('transfer_post_held', 403, { message: 'Sending to Moov is switched off. Nothing was recorded or sent.' });
  }
  if (draft) {
    if (Number(draft.amount_cents) !== amount || draft.leg_role !== WALLET_WITHDRAW_LEG) {
      return fail('idempotency_key_reused', 409, { message: 'That request was already used for a different payment.' });
    }
    if (!REPLAYABLE_STATUSES.has(String(draft.status))) return duplicateResult(draft);
  }

  const limits = await loadWithdrawLimits(client, tenantId);
  if (!limits.ready) {
    return fail('withdrawal_not_ready', 503, { message: 'Transfers to your bank are not switched on yet. Nothing was sent.' });
  }

  const account = await loadMoovAccount(client, tenantId, ENVIRONMENT);
  if (!account?.provider_account_id) return fail('Set up your payment account first.', 409);
  if (account.onboarding_status !== 'active') {
    return fail(`Your payment account is not active yet (${account.onboarding_status}).`, 409);
  }

  const wallet = await syncWalletReadOnly(client, {
    tenantId, accountId: account.provider_account_id, environment: ENVIRONMENT, walletType, fetchImpl,
  });
  if (wallet?.error === 'wallet_mismatch') {
    return fail('wallet_mismatch', 409, { message: 'The recorded Moov wallet was not returned by Moov. Nothing was sent.' });
  }
  if (!wallet || wallet.error || !wallet.provider_payment_method_id) {
    return fail('wallet_not_ready', 409, { message: 'Your balance account is not ready yet. Nothing was sent.' });
  }

  const banks = await connectedBanks(client, tenantId, account.provider_account_id);
  const settlement = banks.find((b) => b.is_default === true) || null;
  if (!settlement) {
    return fail('default_bank_required', 409, {
      message: 'Choose a default settlement bank before transferring. Nothing was sent.',
    });
  }
  const methods = await moovFetch(`/accounts/${account.provider_account_id}/payment-methods`, {
    scopes: scopes.paymentMethodsRead(account.provider_account_id),
    fetchImpl,
  });
  const picked = selectSameDayCreditMethod(methods, settlement?.provider_bank_account_id);
  if (picked.error) {
    return fail(picked.error, 409, {
      message: picked.error === 'default_bank_required'
        ? 'Choose a default settlement bank before transferring. Nothing was sent.'
        : 'Your default settlement bank is not verified for same-day transfers yet. Nothing was sent.',
    });
  }
  const destinationMethodId = methodIdOf(picked.method);
  const bankId = bankIdOf(picked.method);
  const destinationLocal = String(settlement.provider_bank_account_id) === bankId ? settlement : null;
  if (!destinationLocal) {
    return fail('same_day_unavailable', 409, { message: 'Your default settlement bank is not connected in ChecksOps. Nothing was sent.' });
  }
  const facilitatorId = resolveFacilitatorId(ctx.moovContext.productionPlatformAccountId, methods, wallet.provider_payment_method_id);
  if (!facilitatorId) {
    return fail('facilitator_unavailable', 503, { message: 'Payments are not configured correctly. Nothing was sent.' });
  }
  // A resumed request must still describe the same wallet and bank.
  if (draft && (
    String(draft.wallet_id) !== String(wallet.id)
    || String(draft.provider_metadata?.source_moov_payment_method_id || '') !== String(wallet.provider_payment_method_id)
    || String(draft.provider_metadata?.destination_moov_payment_method_id || '') !== destinationMethodId
  )) {
    return fail('idempotency_key_reused', 409, { message: 'That request was already used for a different payment.' });
  }

  // One tenant's transfers to bank are decided one at a time, until this transaction commits.
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${WALLET_WITHDRAW_KEY_PREFIX}${tenantId}`]);

  const spendable = Math.max(0, Number(wallet.available_cents ?? 0) - await reservedWalletCents(client, tenantId, draft?.id));
  if (amount > spendable) {
    return fail('insufficient_available_balance', 409, {
      available_cents: spendable,
      message: 'That is more than your available balance. Pending funds cannot be transferred. Nothing was sent.',
    });
  }
  const breach = tenantLimitBreach({
    amount,
    perTransfer: limits.perTransfer,
    perDay: limits.perDay,
    todayCents: limits.perDay === null ? 0 : await withdrawnTodayCents(client, tenantId, draft?.id),
  });
  if (breach) {
    return fail('tenant_limit_exceeded', 409, {
      ...breach,
      message: breach.limit === 'per_transfer'
        ? 'That is more than your per-transfer limit. Nothing was sent.'
        : 'That is more than your daily transfer-to-bank limit. Nothing was sent.',
    });
  }

  const arrival = expectedArrival(now);
  if (!draft) {
    try {
      draft = (await client.query(
        `INSERT INTO public.payment_transfers
          (tenant_id, provider, environment, status, idempotency_key, amount_cents,
           platform_fee_cents, net_amount_cents, speed, description,
           source_tenant_account_id, destination_tenant_id, destination_payment_method_id,
           wallet_id, leg_role, provider_metadata, created_by)
         VALUES ($1::uuid, 'moov', $2, 'ready', $3, $4, 0, $4, 'same_day', $5,
                 $6, $1::uuid, $7::uuid, $8::uuid, $9, $10::jsonb, $11::uuid)
         RETURNING *`,
        [
          tenantId, ENVIRONMENT, key, amount,
          String(body.description || 'Transfer to bank').slice(0, 128),
          account.provider_account_id, destinationLocal.id, wallet.id, WALLET_WITHDRAW_LEG,
          JSON.stringify({
            checksops_kind: WALLET_WITHDRAW_LEG,
            checksops_leg: WALLET_WITHDRAW_LEG,
            rail: WALLET_WITHDRAW_RAIL,
            source_moov_payment_method_id: wallet.provider_payment_method_id,
            destination_moov_payment_method_id: destinationMethodId,
            expected_arrival: arrival,
            stepup_id: stepUp.id,
          }),
          mapping.application_user_id,
        ],
      )).rows[0];
    } catch (error) {
      if (error?.code === '23505') {
        return fail('A matching payment was already submitted.', 409);
      }
      throw error;
    }
    await logEvent(client, {
      tenantId, transferId: draft.id, eventType: 'wallet.withdrawal.created', newStatus: 'ready',
      metadata: { amount_cents: amount, rail: WALLET_WITHDRAW_RAIL },
    });
  }
  await commitAndContinue(client, mapping, claims);

  if (!transferPostEnabled()) {
    return fail('transfer_post_held', 403, {
      transfer: publicTransfer(draft),
      message: 'Sending to Moov is switched off. Nothing was sent.',
    });
  }

  const claimed = (await client.query(
    `UPDATE public.payment_transfers
     SET status = 'submitting', submitted_at = now()
     WHERE id = $1::uuid AND status = 'ready' AND provider_transfer_id IS NULL
     RETURNING id`,
    [draft.id],
  )).rows[0];
  if (!claimed) return duplicateResult(await transferByKey(client, tenantId, key));
  await commitAndContinue(client, mapping, claims);

  let created;
  try {
    created = await moovFetch(`/accounts/${facilitatorId}/transfers`, {
      method: 'POST',
      scopes: scopes.transfersWrite(facilitatorId),
      idempotencyKey: draft.id,
      fetchImpl: (url, init = {}) => fetchImpl(url, { ...init, signal: AbortSignal.timeout(MOOV_POST_TIMEOUT_MS) }),
      body: {
        source: { paymentMethodID: wallet.provider_payment_method_id },
        destination: { paymentMethodID: destinationMethodId },
        amount: { currency: 'USD', value: amount },
        description: 'ChecksOps transfer to bank',
        metadata: { checksops_transfer_id: draft.id, checksops_tenant_id: tenantId, checksops_leg: WALLET_WITHDRAW_LEG },
      },
    });
  } catch (error) {
    const refused = moovRefusedTransfer(error);
    const status = refused ? 'failed' : 'unknown';
    await client.query(
      `UPDATE public.payment_transfers
       SET status = $2, failure_reason = $3,
           provider_metadata = provider_metadata || $4::jsonb
       WHERE id = $1::uuid AND status = 'submitting'`,
      [
        draft.id, status, String(error?.message || 'Moov request failed').slice(0, 500),
        JSON.stringify({ post_error_status: error?.status ?? null }),
      ],
    );
    await logEvent(client, {
      tenantId, transferId: draft.id, eventType: refused ? 'wallet.withdrawal.failed' : 'wallet.withdrawal.unknown',
      previousStatus: 'submitting', newStatus: status, metadata: { http_status: error?.status ?? null },
    });
    await commitAndContinue(client, mapping, claims);
    if (refused) {
      return fail('provider_transfer_refused', 502, {
        transfer_id: draft.id,
        liveProviderCalled: true,
        message: 'Moov declined this transfer to your bank. Nothing was sent.',
      });
    }
    return fail('provider_outcome_unknown', 502, {
      transfer_id: draft.id,
      liveProviderCalled: true,
      message: 'We could not confirm whether the transfer to your bank went through. It will not be retried automatically; check WalletOps before trying again.',
    });
  }

  const providerTransferId = created?.transferID ?? created?.transferId ?? null;
  const providerStatus = created?.status ?? null;
  const status = providerTransferId ? normalizeTransferStatus(providerStatus || 'created') : 'unknown';
  const saved = (await client.query(
    `UPDATE public.payment_transfers
     SET provider_transfer_id = $2, provider_status = $3, status = $4,
         completed_at = CASE WHEN $4 = 'completed' THEN now() ELSE completed_at END,
         provider_metadata = provider_metadata || $5::jsonb
     WHERE id = $1::uuid
     RETURNING *`,
    [draft.id, providerTransferId, providerStatus, status, JSON.stringify(sanitize({ moov: created ?? {} }))],
  )).rows[0];
  await logEvent(client, {
    tenantId, transferId: draft.id, providerTransferId, eventType: 'wallet.withdrawal.submitted',
    previousStatus: 'submitting', newStatus: status, metadata: { provider_status: providerStatus },
  });
  await commitAndContinue(client, mapping, claims);

  if (SETTLED_BAD.has(status)) {
    return fail('withdrawal_failed', 502, { transfer: publicTransfer(saved), liveProviderCalled: true, message: 'Moov did not accept this transfer to your bank. Nothing was sent.' });
  }
  return jsonResult({
    success: true,
    duplicate: false,
    transfer: publicTransfer(saved),
    wallet: publicWallet(wallet),
    expected_arrival: arrival,
    fee_cents: 0,
    liveProviderCalled: true,
    message: `Transfer to bank started. ${arrivalMessage(arrival)}.`,
  });
}

export async function handleProductionMoovWalletWithdraw(event, deps = {}) {
  const { withIdentityWrite } = await import('../../data.mjs');
  return withIdentityWrite(event, async ({ client, mapping, claims, body, spoof }) => {
    const ctx = await moovProductionReadContext({
      client,
      mapping,
      body,
      requireAdmin: false,
      loadProviderSecrets: deps.loadProviderSecrets,
    });
    const meta = { spoofFieldsIgnored: spoof, applicationUserId: mapping.application_user_id, environment: ENVIRONMENT, operation: OPERATION };
    if (ctx.error) return { ...ctx, ...meta };
    // Same production gate as funding: financial permissions on, sandbox execution off.
    if (!financialPermissionsActivated() || providerSandboxExecutionEnabled()) {
      return { ...fail('production_withdrawal_disabled', 403, { message: 'Transfers to your bank are not enabled.' }), ...meta };
    }
    // Platform roles never move a tenant's money; only that tenant's members can.
    if (!ctx.memberships.some((m) => m.tenant_id === ctx.tenantId)) {
      return { ...fail('Forbidden', 403, { error: 'cross_tenant_denied' }), ...meta };
    }
    const fetchImpl = deps.fetchImpl || fetch;
    const now = typeof deps.now === 'function' ? deps.now() : new Date();
    try {
      const result = await withMoovContext({ ...ctx.moovContext, fetchImpl }, () => withdrawProductionWallet({
        client, mapping, claims, ctx, body, fetchImpl, now,
      }));
      return { ...result, ...meta };
    } catch (error) {
      const { isProviderNetworkError, providerEgressFailure } = await import('../../sandbox-credentials.mjs');
      if (isProviderNetworkError(error)) return { ...providerEgressFailure('moov'), ...meta };
      const status = error instanceof MoovError ? 502 : 500;
      return { ...fail('wallet_withdraw_failed', status, { message: 'The transfer to your bank could not be started. Nothing was sent.' }), ...meta };
    }
  }, deps);
}
