/**
 * Production WalletOps funding (moov-wallet-fund): linked bank → tenant wallet.
 *
 * Any member of the tenant may fund. There is no amount limit. The caller must
 * have entered a financial two-factor code once in the current login.
 *
 * Money safety:
 * - Each click carries its own idempotency key; a retry with the same key never
 *   sends a second transfer.
 * - The transfer row is committed before Moov is called, then claimed
 *   ready → submitting, so two racing requests cannot both POST.
 * - Moov's own idempotency key is the transfer row id.
 * - An error that does not prove Moov refused the transfer is recorded as
 *   `unknown` and is never retried automatically.
 * - Pending ACH funds are not spendable; the wallet balance comes from Moov.
 */
import { APP_USER_EMAIL_GUC, APP_USER_ID_GUC } from '../../cognito.mjs';
import { financialPermissionsActivated } from '../../financial-flags.mjs';
import { isUuid } from '../../financial-ownership.mjs';
import { flagTrue } from '../../ops-readiness.mjs';
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
import { loadSessionFundStepUp, loginSessionBinding, WALLET_FUND_TOTP_ACTION } from './moov-fund-authz.mjs';

const ENVIRONMENT = 'production';
const OPERATION = 'wallet.fund';
export const WALLET_FUND_KEY_PREFIX = 'wallet-fund:';

const REPLAYABLE_STATUSES = new Set(['ready']);

/** A hung Moov POST is abandoned (and recorded as unknown) well before the Lambda times out. */
export const MOOV_POST_TIMEOUT_MS = 20_000;
const SETTLED_BAD = new Set(['failed', 'canceled', 'returned']);

export const transferPostEnabled = () => flagTrue('AWS_MOOV_TRANSFER_POST_ENABLED');

/** Whole cents, positive, and exactly representable. No business limit. */
export function parseFundAmountCents(value) {
  const cents = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  if (typeof cents !== 'number' || !Number.isSafeInteger(cents) || cents <= 0) return null;
  return cents;
}

/** Moov said no (4xx other than timeout / rate limit): nothing was created. */
export function moovRefusedTransfer(error) {
  if (!(error instanceof MoovError)) return false;
  const status = Number(error.status);
  return status >= 400 && status < 500 && status !== 408 && status !== 409 && status !== 429;
}

async function bindRequestGucs(client, mapping, claims) {
  await client.query('SELECT set_config($1, $2, true)', [APP_USER_ID_GUC, mapping.application_user_id]);
  await client.query('SELECT set_config($1, $2, true)', [APP_USER_EMAIL_GUC, mapping.email || claims?.email || '']);
  await client.query("SELECT set_config('request.financial_execution', '1', true)");
  await client.query('SELECT set_config($1, $2, true)', [
    'request.aws_financial_permissions_activated',
    financialPermissionsActivated() ? '1' : '0',
  ]);
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
  await client.query('SAVEPOINT wallet_fund_event');
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
    await client.query('RELEASE SAVEPOINT wallet_fund_event');
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT wallet_fund_event');
    // The transfer row is the record of truth; surface the missing audit event in logs.
    console.warn(JSON.stringify({
      service: 'checksops-api',
      event: 'wallet_fund_event_log_failed',
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

const connectedBanks = async (client, tenantId, providerAccountId) => (await client.query(
  `SELECT id, provider_bank_account_id, is_default
   FROM public.payment_provider_methods
   WHERE tenant_id = $1::uuid AND provider = 'moov' AND environment = $2
     AND provider_account_id = $3 AND connection_status = 'connected'
     AND external_recipient_id IS NULL
   ORDER BY created_at DESC NULLS LAST`,
  [tenantId, ENVIRONMENT, providerAccountId],
)).rows;

/** The bank chosen in Automatic Funding settings, if that table and row exist. */
async function settingsFundingBankId(client, tenantId) {
  await client.query('SAVEPOINT wallet_fund_settings');
  try {
    const row = (await client.query(
      `SELECT funding_bank_account_id FROM public.tenant_wallet_funding_settings
       WHERE tenant_id = $1::uuid LIMIT 1`,
      [tenantId],
    )).rows[0];
    await client.query('RELEASE SAVEPOINT wallet_fund_settings');
    return row?.funding_bank_account_id || null;
  } catch {
    await client.query('ROLLBACK TO SAVEPOINT wallet_fund_settings');
    return null;
  }
}

/** Preferred bank: the Automatic Funding choice, else the one marked default. */
export function preferredBank(banks, settingsBankId) {
  return (settingsBankId && banks.find((b) => String(b.id) === String(settingsBankId)))
    || banks.find((b) => b.is_default === true)
    || null;
}

const bankIdOf = (method) => String(method?.bankAccount?.bankAccountID ?? method?.bankAccount?.bankAccountId ?? '');
const methodIdOf = (method) => String(method?.paymentMethodID ?? method?.paymentMethodId ?? '');

/**
 * The bank to pull from: Moov's ach-debit-fund methods for this account (only
 * verified banks have one). The tenant's default linked bank wins; otherwise
 * there must be exactly one.
 */
export function selectDebitMethod(methods, preferredBankId) {
  const debits = (Array.isArray(methods) ? methods : [])
    .filter((m) => String(m?.paymentMethodType) === 'ach-debit-fund' && methodIdOf(m));
  if (preferredBankId) {
    const preferred = debits.find((m) => bankIdOf(m) === String(preferredBankId));
    if (preferred) return { method: preferred };
  }
  const banks = new Set(debits.map(bankIdOf));
  if (debits.length && banks.size === 1) return { method: debits[0] };
  return { error: debits.length ? 'bank_choice_required' : 'bank_not_ready' };
}

/**
 * The account that facilitates the transfer: the platform account from the
 * production secrets, else the partner on this tenant's own wallet method.
 * Never a cached or tenant-derived guess.
 */
export function resolveFacilitatorId(platformAccountId, methods, walletMethodId) {
  if (platformAccountId) return String(platformAccountId);
  const walletMethod = (Array.isArray(methods) ? methods : [])
    .find((m) => String(m?.paymentMethodType) === 'moov-wallet' && methodIdOf(m) === String(walletMethodId));
  const partner = walletMethod?.wallet?.partnerAccountID ?? walletMethod?.wallet?.partnerAccountId ?? null;
  return partner ? String(partner) : null;
}

const publicWallet = (row) => ({
  wallet_type: row.wallet_type,
  available_cents: Number(row.available_cents ?? 0),
  pending_cents: Number(row.pending_cents ?? 0),
  status: row.status,
  last_synced_at: row.last_synced_at ?? null,
});

/** A repeat of an earlier click reports that click's real outcome. */
function duplicateResult(row) {
  const status = String(row?.status || '');
  if (SETTLED_BAD.has(status)) {
    return fail('funding_failed', 409, { duplicate: true, transfer: publicTransfer(row), message: 'This funding did not go through. Nothing was sent.' });
  }
  if (status === 'unknown' || status === 'submitting') {
    return fail('provider_outcome_unknown', 409, {
      duplicate: true,
      transfer: publicTransfer(row),
      message: 'We could not confirm whether this funding went through. Check WalletOps before trying again.',
    });
  }
  return jsonResult({ success: true, duplicate: true, transfer: publicTransfer(row), liveProviderCalled: false });
}

const publicTransfer = (row) => (row ? {
  id: row.id,
  status: row.status,
  provider_status: row.provider_status,
  amount_cents: Number(row.amount_cents),
  provider_transfer_id: row.provider_transfer_id,
  created_at: row.created_at,
  submitted_at: row.submitted_at,
} : null);

async function fundProductionWallet({ client, mapping, claims, ctx, body, fetchImpl }) {
  const tenantId = ctx.tenantId;
  const walletType = body.wallet_type || 'operating';
  if (!['operating', 'trust'].includes(walletType)) return fail("wallet_type must be 'operating' or 'trust'", 400);
  const amount = parseFundAmountCents(body.amount_cents);
  if (amount === null) return fail('Amount must be a whole number of cents greater than zero.', 400);
  const clickKey = String(body.idempotency_key || '').trim();
  if (!isUuid(clickKey)) return fail('idempotency_key is required', 400);
  const key = `${WALLET_FUND_KEY_PREFIX}${clickKey.toLowerCase()}`;

  // Two-factor once per login.
  const loginSession = loginSessionBinding(claims);
  const stepUp = await loadSessionFundStepUp(client, {
    userId: mapping.application_user_id, tenantId, loginSession,
  });
  if (!stepUp) {
    return fail('totp_required', 401, {
      actionKey: WALLET_FUND_TOTP_ACTION,
      message: 'Enter your two-factor code to fund your balance.',
    });
  }

  await bindRequestGucs(client, mapping, claims);

  let draft = await transferByKey(client, tenantId, key);
  if (!draft && !transferPostEnabled()) {
    return fail('transfer_post_held', 403, { message: 'Sending to Moov is switched off. Nothing was recorded or sent.' });
  }
  if (draft) {
    if (Number(draft.amount_cents) !== amount || draft.leg_role !== 'wallet_funding') {
      return fail('idempotency_key_reused', 409, { message: 'That request was already used for a different payment.' });
    }
    if (!REPLAYABLE_STATUSES.has(String(draft.status))) return duplicateResult(draft);
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
    return fail('wallet_not_ready', 409, { message: 'Your balance account is not ready to receive funds yet.' });
  }

  const banks = await connectedBanks(client, tenantId, account.provider_account_id);
  const local = preferredBank(banks, await settingsFundingBankId(client, tenantId));
  const methods = await moovFetch(`/accounts/${account.provider_account_id}/payment-methods`, {
    scopes: scopes.paymentMethodsRead(account.provider_account_id),
    fetchImpl,
  });
  const picked = selectDebitMethod(methods, local?.provider_bank_account_id);
  if (picked.error) {
    return fail(picked.error, 409, {
      message: picked.error === 'bank_choice_required'
        ? 'More than one bank is linked. Mark one as the default funding bank first.'
        : 'Your linked bank is not verified for funding yet.',
    });
  }
  const sourceMethodId = methodIdOf(picked.method);
  const bankId = bankIdOf(picked.method);
  const sourceLocal = banks.find((b) => String(b.provider_bank_account_id) === bankId)?.id ?? null;
  const facilitatorId = resolveFacilitatorId(ctx.moovContext.productionPlatformAccountId, methods, wallet.provider_payment_method_id);
  if (!facilitatorId) {
    return fail('facilitator_unavailable', 503, { message: 'Payments are not configured correctly. Nothing was sent.' });
  }
  // A resumed request must still describe the same bank and wallet.
  if (draft && (
    String(draft.wallet_id) !== String(wallet.id)
    || String(draft.provider_metadata?.source_moov_payment_method_id || '') !== sourceMethodId
    || String(draft.provider_metadata?.destination_moov_payment_method_id || '') !== String(wallet.provider_payment_method_id)
  )) {
    return fail('idempotency_key_reused', 409, { message: 'That request was already used for a different payment.' });
  }

  if (!draft) {
    try {
      draft = (await client.query(
        `INSERT INTO public.payment_transfers
          (tenant_id, provider, environment, status, idempotency_key, amount_cents,
           platform_fee_cents, net_amount_cents, speed, description,
           source_tenant_account_id, source_payment_method_id, destination_tenant_id,
           wallet_id, leg_role, provider_metadata, created_by)
         VALUES ($1::uuid, 'moov', $2, 'ready', $3, $4, 0, $4, 'standard', $5,
                 $6, $7, $1::uuid, $8::uuid, 'wallet_funding', $9::jsonb, $10::uuid)
         RETURNING *`,
        [
          tenantId, ENVIRONMENT, key, amount,
          String(body.description || 'Balance funding').slice(0, 128),
          account.provider_account_id, sourceLocal, wallet.id,
          JSON.stringify({
            checksops_kind: 'wallet_funding',
            source_moov_payment_method_id: sourceMethodId,
            destination_moov_payment_method_id: wallet.provider_payment_method_id,
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
      tenantId, transferId: draft.id, eventType: 'wallet.funding.created', newStatus: 'ready',
      metadata: { amount_cents: amount },
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
        source: { paymentMethodID: sourceMethodId },
        destination: { paymentMethodID: wallet.provider_payment_method_id },
        amount: { currency: 'USD', value: amount },
        description: 'ChecksOps balance funding',
        metadata: { checksops_transfer_id: draft.id, checksops_tenant_id: tenantId, checksops_leg: 'wallet_funding' },
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
      tenantId, transferId: draft.id, eventType: refused ? 'wallet.funding.failed' : 'wallet.funding.unknown',
      previousStatus: 'submitting', newStatus: status, metadata: { http_status: error?.status ?? null },
    });
    await commitAndContinue(client, mapping, claims);
    if (refused) {
      return fail('provider_transfer_refused', 502, {
        transfer_id: draft.id,
        liveProviderCalled: true,
        message: 'Moov declined this funding. Nothing was sent.',
      });
    }
    return fail('provider_outcome_unknown', 502, {
      transfer_id: draft.id,
      liveProviderCalled: true,
      message: 'We could not confirm whether the funding went through. It will not be retried automatically; check WalletOps before trying again.',
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
    tenantId, transferId: draft.id, providerTransferId, eventType: 'wallet.funding.submitted',
    previousStatus: 'submitting', newStatus: status, metadata: { provider_status: providerStatus },
  });
  await commitAndContinue(client, mapping, claims);

  if (SETTLED_BAD.has(status)) {
    return fail('funding_failed', 502, { transfer: publicTransfer(saved), liveProviderCalled: true, message: 'Moov did not accept this funding. Nothing was sent.' });
  }
  return jsonResult({
    success: true,
    duplicate: false,
    transfer: publicTransfer(saved),
    wallet: publicWallet(wallet),
    liveProviderCalled: true,
    message: 'Funding started. Bank transfers usually take 1–3 business days before the money can be spent.',
  });
}

export async function handleProductionMoovWalletFund(event, deps = {}) {
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
    // Same production gate as CheckAlt: financial permissions on, sandbox execution off.
    if (!financialPermissionsActivated() || providerSandboxExecutionEnabled()) {
      return { ...fail('production_funding_disabled', 403, { message: 'Funding is not enabled.' }), ...meta };
    }
    // Platform roles never move a tenant's money; only that tenant's members can.
    if (!ctx.memberships.some((m) => m.tenant_id === ctx.tenantId)) {
      return { ...fail('Forbidden', 403, { error: 'cross_tenant_denied' }), ...meta };
    }
    const fetchImpl = deps.fetchImpl || fetch;
    try {
      const result = await withMoovContext({ ...ctx.moovContext, fetchImpl }, () => fundProductionWallet({
        client, mapping, claims, ctx, body, fetchImpl,
      }));
      return { ...result, ...meta };
    } catch (error) {
      const { isProviderNetworkError, providerEgressFailure } = await import('../../sandbox-credentials.mjs');
      if (isProviderNetworkError(error)) return { ...providerEgressFailure('moov'), ...meta };
      const status = error instanceof MoovError ? 502 : 500;
      return { ...fail('wallet_fund_failed', status, { message: 'Funding could not be started. Nothing was sent.' }), ...meta };
    }
  }, deps);
}
