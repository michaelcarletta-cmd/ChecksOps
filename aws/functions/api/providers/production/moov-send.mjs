/**
 * Production sends (moov-disburse): the tenant's money → stakeholders and partners.
 * Staging runs the same path against the Moov sandbox (handleSandboxMoovSend):
 * sandbox credentials and environment='sandbox' rows; the send switches below are
 * production-only, AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED is the staging switch.
 *
 * Owner rules (docs/MOOV_PAYMENTS_RULES.md):
 * - Any member of the tenant may send. Platform roles alone may not. No amount limit.
 * - Two-factor once per login: the same step-up that covers funding.
 * - Stakeholders (Stakeholder Settings) are paid to their linked bank by ACH credit.
 * - Partners the check is shared with are paid wallet to wallet, or to their
 *   linked bank when they have no production wallet.
 * - Top-up: when the wallet's available balance is short, each recipient gets
 *   the wallet part (wallet → recipient) and the shortfall straight from the
 *   tenant's linked bank (ach-debit-fund → recipient), in that order.
 *
 * Money safety (same as funding):
 * - One idempotency key per click; every leg is committed as `ready` before the
 *   first Moov call, then claimed ready → submitting before its POST.
 * - Moov's idempotency key is the leg's row id.
 * - A result that does not prove Moov refused the leg is `unknown` and never
 *   retried automatically.
 * - Legs go out one at a time in order; after any leg that is not accepted, the
 *   remaining legs are canceled unsent, so the user sends the rest with a new click.
 * - Nothing is recorded or sent while AWS_MOOV_SEND_POST_ENABLED (or the general
 *   AWS_MOOV_TRANSFER_POST_ENABLED) is off.
 */
import { createHash } from 'node:crypto';
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
import { fail, jsonResult, moovParityContext, moovProductionReadContext } from '../parity/caller.mjs';
import { loadMoovAccount, sanitize } from '../parity/db.mjs';
import { syncWalletReadOnly } from '../parity/moov-wallet.mjs';
import { loadSessionFundStepUp, loginSessionBinding, WALLET_FUND_TOTP_ACTION } from './moov-fund-authz.mjs';
import {
  MOOV_POST_TIMEOUT_MS,
  moovRefusedTransfer,
  parseFundAmountCents,
  preferredBank,
  resolveFacilitatorId,
  selectDebitMethod,
  transferPostEnabled,
} from './moov-wallet-fund.mjs';

const OPERATION = 'wallet.send';
export const SEND_KEY_PREFIX = 'send:';
export const SEND_LEG_ROLES = Object.freeze({ wallet: 'send_wallet', bank: 'send_bank' });
export const MAX_RECIPIENTS = 10;
/**
 * The API Lambda stops at 29s. Legs are only started while this much of the
 * request budget is left; the rest stay ready and the client continues them
 * with the same key, so a send never runs into the Lambda timeout mid-POST.
 */
export const SEND_TIME_BUDGET_MS = 24_000;
export const MIN_POST_WINDOW_MS = 8_000;
/** Ready legs older than this are canceled unsent instead of being sent late. */
export const READY_LEG_MAX_AGE_MS = 15 * 60_000;

const ACCEPTED = new Set(['submitted', 'pending', 'processing', 'completed']);
const SPEEDS = new Set(['standard', 'same_day']);
const CREDIT_RAIL = { standard: 'ach-credit-standard', same_day: 'ach-credit-same-day' };

/** Sends need their own switch on top of the general transfer switch, which still stops everything. */
export const sendPostEnabled = () => transferPostEnabled() && flagTrue('AWS_MOOV_SEND_POST_ENABLED');

const bankIdOf = (method) => String(method?.bankAccount?.bankAccountID ?? method?.bankAccount?.bankAccountId ?? '');
const methodIdOf = (method) => String(method?.paymentMethodID ?? method?.paymentMethodId ?? '');
const walletIdOf = (method) => String(method?.wallet?.walletID ?? method?.wallet?.walletId ?? '');
const accountIdOf = (account) => String(account?.accountID ?? account?.accountId ?? '');

/** A Moov account created for this tenant (moov-account-create), not a recipient account. */
export function isTenantAccountFor(account, tenantId) {
  const id = String(tenantId || '').toLowerCase();
  if (!id || !accountIdOf(account)) return false;
  const metadata = account?.metadata && typeof account.metadata === 'object' ? account.metadata : {};
  return String(account?.foreignID ?? account?.foreignId ?? '').toLowerCase() === id
    && String(metadata.checksops_tenant_id || '').toLowerCase() === id
    && !metadata.checksops_recipient_id;
}

/** Validated request, or { error }. Recipients keep the order the user gave. */
export function parseSendRequest(body = {}) {
  const clickKey = String(body.idempotency_key || '').trim().toLowerCase();
  if (!isUuid(clickKey)) return { error: 'idempotency_key is required' };
  const checkId = String(body.check_id || '').trim();
  if (!isUuid(checkId)) return { error: 'check_id is required' };
  const speed = String(body.speed || 'standard');
  if (!SPEEDS.has(speed)) return { error: "speed must be 'standard' or 'same_day'" };
  const list = Array.isArray(body.recipients) ? body.recipients : [];
  if (!list.length) return { error: 'Choose at least one recipient.' };
  if (list.length > MAX_RECIPIENTS) return { error: `At most ${MAX_RECIPIENTS} recipients per send.` };
  const seen = new Set();
  const recipients = [];
  for (const raw of list) {
    const amount = parseFundAmountCents(raw?.amount_cents);
    if (amount === null) return { error: 'Each amount must be a whole number of cents greater than zero.' };
    let recipient;
    if (raw?.kind === 'stakeholder' && isUuid(String(raw?.stakeholder_account_id || ''))) {
      recipient = { kind: 'stakeholder', id: String(raw.stakeholder_account_id).toLowerCase(), amount_cents: amount };
    } else if (raw?.kind === 'partner' && isUuid(String(raw?.partner_tenant_id || ''))) {
      recipient = { kind: 'partner', id: String(raw.partner_tenant_id).toLowerCase(), amount_cents: amount };
    } else {
      return { error: 'Each recipient must be a stakeholder or a partner.' };
    }
    const unique = `${recipient.kind}:${recipient.id}`;
    if (seen.has(unique)) return { error: 'Each recipient may appear only once per send.' };
    seen.add(unique);
    recipients.push(recipient);
  }
  return { clickKey, checkId, speed, recipients, description: String(body.description || '').slice(0, 100) };
}

/** Fingerprint of what this click asked for; a reused key must ask for the same thing. */
export function requestHash(request) {
  const canonical = JSON.stringify({
    check: request.checkId,
    speed: request.speed,
    recipients: request.recipients.map((r) => [r.kind, r.id, r.amount_cents]),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Split each recipient's amount into the wallet part and the bank shortfall.
 * The available balance is used up in recipient order.
 */
export function planSendLegs(recipients, availableCents) {
  let left = Math.max(0, Number.isSafeInteger(availableCents) ? availableCents : 0);
  return recipients.map((r) => {
    const walletCents = Math.min(left, r.amount_cents);
    left -= walletCents;
    return { ...r, wallet_cents: walletCents, bank_cents: r.amount_cents - walletCents };
  });
}

/** The recipient's credit method for a bank, at the requested speed. */
export function selectCreditMethod(methods, speed, bankAccountId = null) {
  const rail = CREDIT_RAIL[speed];
  const credits = (Array.isArray(methods) ? methods : [])
    .filter((m) => String(m?.paymentMethodType) === rail && methodIdOf(m));
  if (bankAccountId) {
    const match = credits.find((m) => bankIdOf(m) === String(bankAccountId));
    return match ? { method: match } : { error: 'recipient_bank_not_ready' };
  }
  const banks = new Set(credits.map(bankIdOf));
  if (credits.length && banks.size === 1) return { method: credits[0] };
  return { error: credits.length ? 'recipient_bank_choice_required' : 'recipient_bank_not_ready' };
}

/** A partner's single production wallet, if it has one. */
export function selectWalletMethod(methods) {
  const wallets = (Array.isArray(methods) ? methods : [])
    .filter((m) => String(m?.paymentMethodType) === 'moov-wallet' && methodIdOf(m));
  const distinct = new Set(wallets.map((m) => walletIdOf(m) || methodIdOf(m)));
  if (wallets.length && distinct.size === 1) return { method: wallets[0] };
  // With an operating and a trust wallet, pay the account's default (operating) wallet.
  const defaults = wallets.filter((m) => String(m?.wallet?.walletType ?? '') === 'default');
  if (defaults.length === 1) return { method: defaults[0] };
  return { error: wallets.length ? 'partner_wallet_choice_required' : 'partner_wallet_missing' };
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

async function logEvent(client, row) {
  await client.query('SAVEPOINT wallet_send_event');
  try {
    await client.query(
      `INSERT INTO public.payment_event_log
        (provider, environment, tenant_id, event_type, new_status, previous_status,
         transfer_id, provider_transfer_id, provider_metadata)
       VALUES ('moov', $1, $2::uuid, $3, $4, $5, $6::uuid, $7, $8::jsonb)`,
      [
        row.environment, row.tenantId, row.eventType, row.newStatus || null, row.previousStatus || null,
        row.transferId, row.providerTransferId || null, JSON.stringify(sanitize(row.metadata || {})),
      ],
    );
    await client.query('RELEASE SAVEPOINT wallet_send_event');
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT wallet_send_event');
    console.warn(JSON.stringify({
      service: 'checksops-api',
      event: 'wallet_send_event_log_failed',
      eventType: row.eventType,
      transferId: row.transferId,
      sqlstate: error?.code || null,
    }));
  }
}

const legsByPrefix = async (client, tenantId, prefix) => (await client.query(
  `SELECT * FROM public.payment_transfers
   WHERE tenant_id = $1::uuid AND left(idempotency_key, $3) = $2
   ORDER BY (provider_metadata->>'leg_index')::int`,
  [tenantId, prefix, prefix.length],
)).rows;

const connectedBanks = async (client, tenantId, providerAccountId, environment) => (await client.query(
  `SELECT id, provider_bank_account_id, is_default
   FROM public.payment_provider_methods
   WHERE tenant_id = $1::uuid AND provider = 'moov' AND environment = $2
     AND provider_account_id = $3 AND connection_status = 'connected'
     AND external_recipient_id IS NULL
   ORDER BY created_at DESC NULLS LAST`,
  [tenantId, environment, providerAccountId],
)).rows;

async function settingsFundingBankId(client, tenantId) {
  await client.query('SAVEPOINT wallet_send_settings');
  try {
    const row = (await client.query(
      `SELECT funding_bank_account_id FROM public.tenant_wallet_funding_settings
       WHERE tenant_id = $1::uuid LIMIT 1`,
      [tenantId],
    )).rows[0];
    await client.query('RELEASE SAVEPOINT wallet_send_settings');
    return row?.funding_bank_account_id || null;
  } catch {
    await client.query('ROLLBACK TO SAVEPOINT wallet_send_settings');
    return null;
  }
}

const publicLeg = (row) => ({
  id: row.id,
  role: row.leg_role,
  status: row.status,
  amount_cents: Number(row.amount_cents),
  provider_transfer_id: row.provider_transfer_id,
});

/** Per-recipient view of the legs: what went out, what did not, what is unclear. */
export function summarizeSend(legs) {
  const byIndex = new Map();
  for (const leg of legs) {
    const meta = leg.provider_metadata || {};
    const index = Number(meta.recipient_index);
    if (!byIndex.has(index)) {
      byIndex.set(index, {
        index,
        kind: meta.recipient_kind,
        id: meta.recipient_id,
        name: meta.recipient_name || null,
        destination: meta.destination_kind || null,
        amount_cents: 0,
        sent_cents: 0,
        unknown_cents: 0,
        unsent_cents: 0,
        legs: [],
      });
    }
    const entry = byIndex.get(index);
    const cents = Number(leg.amount_cents);
    entry.amount_cents += cents;
    if (ACCEPTED.has(String(leg.status))) entry.sent_cents += cents;
    else if (['unknown', 'submitting'].includes(String(leg.status))) entry.unknown_cents += cents;
    else entry.unsent_cents += cents;
    entry.legs.push(publicLeg(leg));
  }
  const recipients = [...byIndex.values()].sort((a, b) => a.index - b.index);
  const total = (key) => recipients.reduce((sum, r) => sum + r[key], 0);
  return {
    recipients,
    sent_cents: total('sent_cents'),
    unknown_cents: total('unknown_cents'),
    unsent_cents: total('unsent_cents'),
    amount_cents: total('amount_cents'),
  };
}

function sendResult(legs, { duplicate, incomplete = false }) {
  const summary = summarizeSend(legs);
  const extra = { duplicate, send: summary, liveProviderCalled: !duplicate };
  if (incomplete) {
    return fail('send_incomplete', 409, {
      ...extra,
      message: 'Part of this payment is still being sent. Continue with the same payment to finish it; nothing is paid twice.',
    });
  }
  if (summary.unknown_cents > 0) {
    return fail('provider_outcome_unknown', 409, {
      ...extra,
      message: 'We could not confirm whether part of this send went through. It will not be retried automatically; check the payment history before sending again.',
    });
  }
  if (summary.sent_cents === 0) {
    return fail('send_failed', 409, { ...extra, message: 'This send did not go through. Nothing was sent.' });
  }
  if (summary.unsent_cents > 0) {
    return fail('send_partial', 409, {
      ...extra,
      message: `Partially sent. $${(summary.unsent_cents / 100).toFixed(2)} was not sent; send the rest with a new payment.`,
    });
  }
  return jsonResult({ success: true, ...extra, message: 'Payment sent. Bank transfers usually arrive in 1–3 business days.' });
}

/** Resolve where each recipient is paid. Reads only; nothing is created. */
async function resolveDestinations({ client, tenantId, request, environment, fetchImpl }) {
  const resolved = [];
  for (const r of request.recipients) {
    if (r.kind === 'stakeholder') {
      const row = (await client.query(
        // Homeowner and partner-payout rows are not paid here (homeowner sends are not built).
        `SELECT id, nickname, provider, provider_account_id, provider_bank_account_id,
                verification_status, is_active, origin, is_partner_payout, provider_environment
         FROM public.stakeholder_accounts
         WHERE id = $1::uuid AND tenant_id = $2::uuid`,
        [r.id, tenantId],
      )).rows[0];
      if (!row || row.is_active === false) return { error: 'recipient_not_found', recipient: r };
      if ((row.origin && row.origin !== 'tenant_owned') || row.is_partner_payout === true) {
        return { error: 'recipient_not_supported', recipient: r, name: row.nickname };
      }
      if (row.provider_environment && row.provider_environment !== environment) {
        return { error: 'recipient_setup_required', recipient: r, name: row.nickname };
      }
      if (!['verified', 'admin_override'].includes(String(row.verification_status || ''))) {
        return { error: 'recipient_not_verified', recipient: r, name: row.nickname };
      }
      if (row.provider !== 'moov' || !row.provider_account_id || !row.provider_bank_account_id) {
        return { error: 'recipient_setup_required', recipient: r, name: row.nickname };
      }
      let methods;
      try {
        methods = await moovFetch(`/accounts/${row.provider_account_id}/payment-methods`, {
          scopes: scopes.paymentMethodsRead(row.provider_account_id), fetchImpl,
        });
      } catch {
        return { error: 'recipient_setup_required', recipient: r, name: row.nickname };
      }
      const credit = selectCreditMethod(methods, request.speed, row.provider_bank_account_id);
      if (credit.error) return { error: credit.error, recipient: r, name: row.nickname };
      resolved.push({ ...r, name: row.nickname || 'Stakeholder', destinationKind: 'bank', destinationMethodId: methodIdOf(credit.method) });
      continue;
    }

    if (r.id === String(tenantId).toLowerCase()) return { error: 'recipient_is_sender', recipient: r };
    // A partner can be paid on this organization's check when the check is shared with
    // them, or the partnership is active (both sides agreed: SQL 76 lets only the
    // invitee or Partner Code redemption activate it). Choosing a partner in the
    // payment picker needs no share. Since the pair last became live (the earliest
    // acceptance among its active rows, never later than now), this check must not
    // have been un-shared with them and no row for the pair (one per direction is
    // possible) may have been ended. Ending a partnership revokes its shares, so
    // those older revocations do not block a reconnected pair.
    const share = (await client.query(
      `SELECT 1 AS ok
       WHERE EXISTS (
           SELECT 1 FROM public.shared_checks
           WHERE check_id = $1::uuid AND revoked_at IS NULL
             AND source_tenant_id = $2::uuid AND target_tenant_id = $3::uuid)
         OR EXISTS (
           SELECT 1
           FROM (
             SELECT min(LEAST(COALESCE(p.accepted_at, p.created_at, '-infinity'::timestamptz), now())) AS since
             FROM public.tenant_partnerships p
             WHERE p.status = 'active' AND p.revoked_at IS NULL
               AND ((p.inviter_tenant_id = $2::uuid AND p.invitee_tenant_id = $3::uuid)
                 OR (p.inviter_tenant_id = $3::uuid AND p.invitee_tenant_id = $2::uuid))
           ) live
           WHERE live.since IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM public.tenant_partnerships q
               WHERE q.revoked_at IS NOT NULL AND q.revoked_at >= live.since
                 AND ((q.inviter_tenant_id = $2::uuid AND q.invitee_tenant_id = $3::uuid)
                   OR (q.inviter_tenant_id = $3::uuid AND q.invitee_tenant_id = $2::uuid)))
             AND NOT EXISTS (
               SELECT 1 FROM public.shared_checks s
               WHERE s.check_id = $1::uuid AND s.revoked_at IS NOT NULL AND s.revoked_at >= live.since
                 AND s.source_tenant_id = $2::uuid AND s.target_tenant_id = $3::uuid))`,
      [request.checkId, tenantId, r.id],
    )).rows[0];
    if (!share) return { error: 'partner_not_shared', recipient: r };
    // Tenant accounts are created with foreignID = tenant id.
    let accounts;
    try {
      accounts = await moovFetch(`/accounts?foreignID=${encodeURIComponent(r.id)}`, { scopes: scopes.accountsRead(), fetchImpl });
    } catch {
      return { error: 'partner_setup_required', recipient: r };
    }
    // Only the partner's own tenant account: recipient accounts also carry a
    // foreignID but are tagged with checksops_recipient_id and their creator's tenant.
    const matches = (Array.isArray(accounts) ? accounts : []).filter((a) => isTenantAccountFor(a, r.id));
    if (matches.length !== 1) return { error: matches.length ? 'partner_account_ambiguous' : 'partner_setup_required', recipient: r };
    const partnerAccountId = accountIdOf(matches[0]);
    const partnerName = matches[0]?.displayName ?? matches[0]?.profile?.business?.legalBusinessName ?? 'Partner';
    let methods;
    try {
      methods = await moovFetch(`/accounts/${partnerAccountId}/payment-methods`, {
        scopes: scopes.paymentMethodsRead(partnerAccountId), fetchImpl,
      });
    } catch {
      return { error: 'partner_setup_required', recipient: r, name: partnerName };
    }
    const wallet = selectWalletMethod(methods);
    if (wallet.method) {
      resolved.push({ ...r, name: partnerName, destinationKind: 'wallet', destinationMethodId: methodIdOf(wallet.method), partnerAccountId });
      continue;
    }
    if (wallet.error === 'partner_wallet_choice_required') return { error: wallet.error, recipient: r, name: partnerName };
    // No production wallet: pay the partner's linked bank (owner rule).
    const credit = selectCreditMethod(methods, request.speed);
    if (credit.error) return { error: credit.error === 'recipient_bank_choice_required' ? 'partner_bank_choice_required' : 'partner_setup_required', recipient: r, name: partnerName };
    resolved.push({ ...r, name: partnerName, destinationKind: 'bank', destinationMethodId: methodIdOf(credit.method), partnerAccountId });
  }
  return { resolved };
}

const DESTINATION_MESSAGES = {
  recipient_not_found: 'A recipient was not found for this organization.',
  recipient_not_supported: 'Homeowner and partner payout accounts cannot be paid here yet.',
  recipient_not_verified: 'A recipient has not been verified yet.',
  recipient_setup_required: 'A recipient has not finished linking a bank for payments.',
  recipient_bank_not_ready: "A recipient's bank is not ready for this delivery speed.",
  recipient_bank_choice_required: "A recipient's bank could not be determined.",
  recipient_is_sender: 'You cannot send to your own organization.',
  partner_not_shared: 'You are not partners with that organization, or this check was un-shared with them.',
  partner_setup_required: "This partner hasn't finished payment setup.",
  partner_account_ambiguous: "This partner's payment account could not be determined.",
  partner_wallet_choice_required: "This partner's balance account could not be determined.",
  partner_bank_choice_required: "This partner's bank could not be determined.",
};

async function postLeg({ client, mapping, claims, tenantId, environment, leg, facilitatorId, fetchImpl, timeoutMs }) {
  const claimed = (await client.query(
    `UPDATE public.payment_transfers
     SET status = 'submitting', submitted_at = now()
     WHERE id = $1::uuid AND status = 'ready' AND provider_transfer_id IS NULL
     RETURNING *`,
    [leg.id],
  )).rows[0];
  if (!claimed) return null;
  await commitAndContinue(client, mapping, claims);

  const meta = leg.provider_metadata || {};
  let created;
  try {
    created = await moovFetch(`/accounts/${facilitatorId}/transfers`, {
      method: 'POST',
      scopes: scopes.transfersWrite(facilitatorId),
      idempotencyKey: leg.id,
      fetchImpl: (url, init = {}) => fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) }),
      body: {
        source: { paymentMethodID: meta.source_moov_payment_method_id },
        destination: { paymentMethodID: meta.destination_moov_payment_method_id },
        amount: { currency: 'USD', value: Number(leg.amount_cents) },
        description: String(leg.description || 'ChecksOps payment').slice(0, 128),
        metadata: { checksops_transfer_id: leg.id, checksops_tenant_id: tenantId, checksops_leg: leg.leg_role },
      },
    });
  } catch (error) {
    const refused = moovRefusedTransfer(error);
    const status = refused ? 'failed' : 'unknown';
    const saved = (await client.query(
      `UPDATE public.payment_transfers
       SET status = $2, failure_reason = $3,
           provider_metadata = provider_metadata || $4::jsonb
       WHERE id = $1::uuid AND status = 'submitting'
       RETURNING *`,
      [leg.id, status, String(error?.message || 'Moov request failed').slice(0, 500),
        JSON.stringify({ post_error_status: error?.status ?? null })],
    )).rows[0];
    await logEvent(client, {
      environment, tenantId, transferId: leg.id, eventType: refused ? 'wallet.send.failed' : 'wallet.send.unknown',
      previousStatus: 'submitting', newStatus: status, metadata: { http_status: error?.status ?? null, leg: leg.leg_role },
    });
    await commitAndContinue(client, mapping, claims);
    return saved || { ...claimed, status };
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
    [leg.id, providerTransferId, providerStatus, status, JSON.stringify({ moov: { transferID: providerTransferId, status: providerStatus } })],
  )).rows[0];
  await logEvent(client, {
    environment, tenantId, transferId: leg.id, providerTransferId, eventType: 'wallet.send.submitted',
    previousStatus: 'submitting', newStatus: status, metadata: { provider_status: providerStatus, leg: leg.leg_role },
  });
  await commitAndContinue(client, mapping, claims);
  return saved;
}

async function cancelLeg({ client, mapping, claims, tenantId, environment }, leg, reason) {
  const canceled = (await client.query(
    `UPDATE public.payment_transfers
     SET status = 'canceled', failure_reason = $2
     WHERE id = $1::uuid AND status = 'ready' AND provider_transfer_id IS NULL
     RETURNING id`,
    [leg.id, reason],
  )).rows[0];
  if (!canceled) return;
  await logEvent(client, { environment, tenantId, transferId: leg.id, eventType: 'wallet.send.canceled', previousStatus: 'ready', newStatus: 'canceled', metadata: { leg: leg.leg_role, reason } });
  await commitAndContinue(client, mapping, claims);
}

/**
 * Send the ready legs in order. After one is not accepted, the rest are canceled
 * unsent. A leg is only started while the request budget allows a full POST;
 * otherwise the send stops `incomplete` and the client continues it.
 */
async function runLegs({ client, mapping, claims, tenantId, environment, prefix, facilitatorId, fetchImpl, clock }) {
  const scope = { client, mapping, claims, tenantId, environment };
  let stopped = false;
  let incomplete = false;
  for (const leg of await legsByPrefix(client, tenantId, prefix)) {
    if (String(leg.status) !== 'ready') {
      if (!ACCEPTED.has(String(leg.status))) stopped = true;
      continue;
    }
    if (stopped) {
      await cancelLeg(scope, leg, 'not_sent_after_earlier_leg');
      continue;
    }
    const createdAt = Date.parse(leg.created_at);
    if (Number.isFinite(createdAt) && clock.wall() - createdAt > READY_LEG_MAX_AGE_MS) {
      await cancelLeg(scope, leg, 'expired_unsent');
      stopped = true;
      continue;
    }
    const remaining = clock.remaining();
    if (remaining < MIN_POST_WINDOW_MS) {
      incomplete = true;
      break;
    }
    const timeoutMs = Math.min(MOOV_POST_TIMEOUT_MS, remaining - 2_000);
    const result = await postLeg({ ...scope, leg, facilitatorId, fetchImpl, timeoutMs });
    if (!result || !ACCEPTED.has(String(result.status))) stopped = true;
  }
  return { legs: await legsByPrefix(client, tenantId, prefix), incomplete };
}

/** Provider reads before any POST get their own timeout, so planning cannot hang. */
export const MOOV_READ_TIMEOUT_MS = 8_000;
const withReadTimeout = (fetchImpl) => (url, init = {}) => fetchImpl(url, { ...init, signal: init.signal || AbortSignal.timeout(MOOV_READ_TIMEOUT_MS) });

async function runSend({ client, mapping, claims, ctx, body, fetchImpl: postFetch, clock }) {
  const fetchImpl = withReadTimeout(postFetch);
  const tenantId = ctx.tenantId;
  const environment = ctx.environment;
  const postsEnabled = () => environment !== 'production' || sendPostEnabled();
  const request = parseSendRequest(body);
  if (request.error) return fail('invalid_send_request', 400, { message: request.error });
  const prefix = `${SEND_KEY_PREFIX}${request.clickKey}:`;
  const hash = requestHash(request);

  const loginSession = loginSessionBinding(claims);
  const stepUp = await loadSessionFundStepUp(client, { userId: mapping.application_user_id, tenantId, loginSession });
  if (!stepUp) {
    return fail('totp_required', 401, { actionKey: WALLET_FUND_TOTP_ACTION, message: 'Enter your two-factor code to send this payment.' });
  }

  await bindRequestGucs(client, mapping, claims);

  const check = (await client.query(
    'SELECT id, tenant_id FROM public.check_intake_items WHERE id = $1::uuid',
    [request.checkId],
  )).rows[0];
  if (!check || String(check.tenant_id) !== String(tenantId)) return fail('check_not_found', 404, { message: 'Check not found for this organization.' });

  const existing = await legsByPrefix(client, tenantId, prefix);
  if (existing.length && existing.some((leg) => leg.provider_metadata?.request_hash !== hash)) {
    return fail('idempotency_key_reused', 409, { message: 'That request was already used for a different payment.' });
  }
  if (!existing.length && !postsEnabled()) {
    return fail('send_post_held', 403, { message: 'Sending payments is switched off. Nothing was recorded or sent.' });
  }
  if (existing.length && !existing.some((leg) => String(leg.status) === 'ready')) {
    return sendResult(existing, { duplicate: true });
  }

  // Plan under a per-organization lock (held until the plan commits), and count the
  // wallet parts of other sends that have not gone out yet, so two clicks cannot
  // plan against the same balance.
  // A lock held by a stuck connection fails this request instead of hanging it.
  await client.query("SET LOCAL lock_timeout = '10s'");
  await client.query("SET idle_in_transaction_session_timeout = '30s'");
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`moov-send:${tenantId}`]);
  // A parallel request with the same key may have planned while this one waited.
  const planned = await legsByPrefix(client, tenantId, prefix);
  if (planned.some((leg) => leg.provider_metadata?.request_hash !== hash)) {
    return fail('idempotency_key_reused', 409, { message: 'That request was already used for a different payment.' });
  }
  const account = await loadMoovAccount(client, tenantId, environment);
  if (!account?.provider_account_id) return fail('Set up your payment account first.', 409);
  if (account.onboarding_status !== 'active') {
    return fail(`Your payment account is not active yet (${account.onboarding_status}).`, 409);
  }
  const payerMethods = await moovFetch(`/accounts/${account.provider_account_id}/payment-methods`, {
    scopes: scopes.paymentMethodsRead(account.provider_account_id), fetchImpl,
  });
  const wallet = await syncWalletReadOnly(client, {
    tenantId, accountId: account.provider_account_id, environment, walletType: 'operating', fetchImpl,
  });
  if (!wallet || wallet.error || !wallet.provider_payment_method_id) {
    return fail('wallet_not_ready', 409, { message: 'Your balance account is not ready yet.' });
  }
  const platformAccountId = environment === 'production'
    ? ctx.moovContext.productionPlatformAccountId
    : ctx.moovContext.sandboxPlatformAccountId;
  const facilitatorId = resolveFacilitatorId(platformAccountId, payerMethods, wallet.provider_payment_method_id);
  if (!facilitatorId) return fail('facilitator_unavailable', 503, { message: 'Payments are not configured correctly. Nothing was sent.' });

  let legs = planned;
  if (legs.some((leg) => (leg.provider_metadata?.facilitator_account_id || facilitatorId) !== facilitatorId)) {
    return fail('facilitator_changed', 409, { message: 'Payment settings changed since this payment was started. Nothing more was sent.' });
  }
  if (!legs.length) {
    const destinations = await resolveDestinations({ client, tenantId, request, environment, fetchImpl });
    if (destinations.error) {
      return fail(destinations.error, 409, {
        recipient: destinations.recipient,
        recipient_name: destinations.name || null,
        message: DESTINATION_MESSAGES[destinations.error] || 'A recipient is not ready to be paid.',
      });
    }
    const reserved = Number((await client.query(
      `SELECT COALESCE(sum(amount_cents), 0)::bigint AS cents FROM public.payment_transfers
       WHERE tenant_id = $1::uuid AND environment = $2 AND leg_role = $3
         AND (status IN ('ready', 'submitting')
           OR (status IN ('submitted', 'pending', 'processing') AND submitted_at > now() - interval '2 minutes'))
         AND created_at > now() - interval '15 minutes'`,
      [tenantId, environment, SEND_LEG_ROLES.wallet],
    )).rows[0]?.cents ?? 0);
    const plan = planSendLegs(destinations.resolved, Math.max(0, Number(wallet.available_cents ?? 0) - reserved));
    let bank = null;
    if (plan.some((p) => p.bank_cents > 0)) {
      const banks = await connectedBanks(client, tenantId, account.provider_account_id, environment);
      const local = preferredBank(banks, await settingsFundingBankId(client, tenantId));
      const picked = selectDebitMethod(payerMethods, local?.provider_bank_account_id);
      if (picked.error) {
        return fail(picked.error, 409, {
          message: picked.error === 'bank_choice_required'
            ? 'Your balance is short and more than one bank is linked. Mark one as the default funding bank first.'
            : 'Your balance is short and your linked bank is not verified for payments yet.',
        });
      }
      bank = {
        methodId: methodIdOf(picked.method),
        localId: banks.find((b) => String(b.provider_bank_account_id) === bankIdOf(picked.method))?.id ?? null,
      };
    }

    let legIndex = 0;
    for (const [recipientIndex, p] of plan.entries()) {
      const parts = [['wallet', p.wallet_cents], ['bank', p.bank_cents]].filter(([, cents]) => cents > 0);
      for (const [source, cents] of parts) {
        const role = SEND_LEG_ROLES[source];
        await client.query(
          `INSERT INTO public.payment_transfers
            (tenant_id, provider, environment, status, idempotency_key, amount_cents,
             platform_fee_cents, net_amount_cents, speed, description,
             source_tenant_account_id, source_payment_method_id, destination_tenant_id,
             wallet_id, leg_role, check_id, claim_id, provider_metadata, created_by)
           VALUES ($1::uuid, 'moov', $2, 'ready', $3, $4, 0, $4, $5, $6,
                   $7, $8::uuid, $9::uuid, $10::uuid, $11, $12::uuid, $13::uuid, $14::jsonb, $15::uuid)`,
          [
            tenantId, environment, `${prefix}${legIndex}:${source}`, cents, request.speed,
            String(request.description || `ChecksOps payment to ${p.name}`).slice(0, 128),
            account.provider_account_id, source === 'bank' ? bank.localId : null,
            p.kind === 'partner' ? p.id : null,
            source === 'wallet' ? wallet.id : null, role, request.checkId, null,
            JSON.stringify({
              checksops_kind: 'send',
              request_hash: hash,
              leg_index: legIndex,
              recipient_index: recipientIndex,
              recipient_kind: p.kind,
              recipient_id: p.id,
              recipient_name: p.name,
              destination_kind: p.destinationKind,
              partner_account_id: p.partnerAccountId || null,
              source_moov_payment_method_id: source === 'wallet' ? wallet.provider_payment_method_id : bank.methodId,
              destination_moov_payment_method_id: p.destinationMethodId,
              stepup_id: stepUp.id,
              facilitator_account_id: facilitatorId,
            }),
            mapping.application_user_id,
          ],
        );
        legIndex += 1;
      }
    }
    legs = await legsByPrefix(client, tenantId, prefix);
    for (const leg of legs) {
      await logEvent(client, { environment, tenantId, transferId: leg.id, eventType: 'wallet.send.created', newStatus: 'ready', metadata: { leg: leg.leg_role, amount_cents: Number(leg.amount_cents) } });
    }
    await commitAndContinue(client, mapping, claims);
  }

  if (!postsEnabled()) {
    return fail('send_post_held', 403, { send: summarizeSend(legs), message: 'Sending payments is switched off. Nothing was sent.' });
  }
  // Only one request runs a given send's legs at a time (the lock ends with the connection).
  const lockKey = `moov-send-run:${prefix}`;
  const runLocked = (await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [lockKey])).rows[0]?.ok;
  if (!runLocked) {
    return fail('send_in_progress', 409, { message: 'This payment is still being sent. Check the payment history in a moment.' });
  }
  try {
    const run = await runLegs({ client, mapping, claims, tenantId, environment, prefix, facilitatorId, fetchImpl: postFetch, clock });
    return sendResult(run.legs, { duplicate: false, incomplete: run.incomplete });
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]).catch(() => {});
  }
}

/** Production: production credentials and rows, behind the financial and send switches. */
export const handleProductionMoovSend = (event, deps = {}) => handleMoovSend(event, deps, 'production');

/** Staging: the same send against the Moov sandbox, only while sandbox execution is on. */
export const handleSandboxMoovSend = (event, deps = {}) => handleMoovSend(event, deps, 'sandbox');

async function handleMoovSend(event, deps, environment) {
  // The budget counts from the start of the request (database connect and secrets included).
  const wall = deps.now || Date.now;
  const startedAt = wall();
  const { withIdentityWrite } = await import('../../data.mjs');
  return withIdentityWrite(event, async ({ client, mapping, claims, body, spoof }) => {
    const ctx = environment === 'production'
      ? await moovProductionReadContext({
        client, mapping, body, requireAdmin: false, loadProviderSecrets: deps.loadProviderSecrets,
      })
      : await moovParityContext({ client, mapping, body, requireAdmin: false, loadSandbox: deps.loadSandboxCredentials });
    const meta = { spoofFieldsIgnored: spoof, applicationUserId: mapping.application_user_id, environment, operation: OPERATION };
    if (ctx.error) return { ...ctx, ...meta };
    const enabled = environment === 'production'
      ? financialPermissionsActivated() && !providerSandboxExecutionEnabled()
      : providerSandboxExecutionEnabled() && ctx.environment === 'sandbox';
    if (!enabled) {
      return { ...fail(`${environment}_send_disabled`, 403, { message: 'Sending payments is not enabled.' }), ...meta };
    }
    // Platform roles never move a tenant's money; only that tenant's members can.
    if (!ctx.memberships.some((m) => m.tenant_id === ctx.tenantId)) {
      return { ...fail('Forbidden', 403, { error: 'cross_tenant_denied' }), ...meta };
    }
    const fetchImpl = deps.fetchImpl || fetch;
    const clock = { wall, remaining: () => SEND_TIME_BUDGET_MS - (wall() - startedAt) };
    try {
      const result = await withMoovContext({ ...ctx.moovContext, fetchImpl }, () => runSend({
        client, mapping, claims, ctx, body, fetchImpl, clock,
      }));
      return { ...result, ...meta };
    } catch (error) {
      const { isProviderNetworkError, providerEgressFailure } = await import('../../sandbox-credentials.mjs');
      if (isProviderNetworkError(error)) return { ...providerEgressFailure('moov'), ...meta };
      const status = error instanceof MoovError ? 502 : 500;
      return { ...fail('wallet_send_failed', status, { message: 'Something went wrong while sending. Part of the payment may have gone out; check the payment history before trying again.' }), ...meta };
    }
  }, deps);
}
