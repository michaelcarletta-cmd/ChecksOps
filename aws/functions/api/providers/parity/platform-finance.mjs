/**
 * ChecksOps Platform Finance read model.
 *
 * Represents the facilitator / platform Moov account only. Never a tenant
 * selected through memberships[0], body.tenant_id, or a guessed tenant id.
 *
 * Read-only: status / overview / wallet / pnl. Writes fail closed.
 */
import { fail, jsonResult } from './caller.mjs';
import { moovFetch, scopes, withMoovContext } from './moov-client.mjs';

export const PLATFORM_OWNER_EMAIL = 'checksopsadmin@gmail.com';
export const PLATFORM_FINANCE_FUNCTIONS = Object.freeze(['moov-platform-bank', 'platform-treasury']);

export const PLATFORM_FINANCE_READ_ACTIONS = Object.freeze([
  'status',
  'overview',
  'wallet',
  'pnl',
  'list',
  'get',
]);

export const PLATFORM_FINANCE_WRITE_ACTIONS = Object.freeze([
  'add',
  'initiate_micro_deposit',
  'confirm_micro_deposit',
  'create',
  'transfer',
  'charge',
  'pull',
  'sweep',
  'enable',
  'disable',
]);

export const PLATFORM_FINANCE_WRITE_BLOCKED_MESSAGE =
  'Platform Finance writes are disabled. Bank attach, verification, ACH, and fee collection are not available in this phase.';

export const isPlatformFinanceFunction = (name) => PLATFORM_FINANCE_FUNCTIONS.includes(String(name || ''));

export const isPlatformOwnerEmail = (email) =>
  String(email || '').trim().toLowerCase() === PLATFORM_OWNER_EMAIL;

export const isPlatformFinanceWriteAction = (action) =>
  PLATFORM_FINANCE_WRITE_ACTIONS.includes(String(action || '').toLowerCase());

export const isPlatformFinanceReadAction = (action) => {
  const value = String(action || '').toLowerCase();
  return !value || PLATFORM_FINANCE_READ_ACTIONS.includes(value);
};

/**
 * Live production Lambda uses CHECKSOPS_ENV=production-prep.
 * That name is production, never sandbox.
 */
export const PLATFORM_FINANCE_PRODUCTION_ENVS = Object.freeze(['production', 'production-prep']);

/** Known ChecksOps sandbox facilitator. Forbidden when environment is production. */
export const SANDBOX_PLATFORM_ACCOUNT_ID = '36b79957-ce7a-4ca7-a68f-30986c9e47bb';

export function isPlatformFinanceProductionEnv(checksopsEnv) {
  const env = String(checksopsEnv || '').trim().toLowerCase();
  return PLATFORM_FINANCE_PRODUCTION_ENVS.includes(env);
}

/**
 * Server environment is authoritative. Staging always sandbox.
 * Production and production-prep select the production facilitator.
 * Client tenant_id / memberships never participate.
 */
export function resolvePlatformFinanceEnvironment({
  checksopsEnv,
  hostname,
} = {}) {
  const env = String(checksopsEnv || '').trim().toLowerCase();
  const host = String(hostname || '').trim().toLowerCase();
  if (env === 'staging' || env === 'sandbox' || env === 'uat') return 'sandbox';
  if (host.startsWith('staging.') || host === 'staging.checksops.com') return 'sandbox';
  if (isPlatformFinanceProductionEnv(env)) return 'production';
  if (host === 'checksops.com' || host === 'www.checksops.com' || host === 'checkops.com' || host === 'www.checkops.com') {
    return 'production';
  }
  return 'sandbox';
}

export function isForbiddenSandboxFacilitatorId(accountId, sandboxPlatformAccountId = null) {
  const value = String(accountId || '').trim().toLowerCase();
  if (!value) return false;
  if (value === SANDBOX_PLATFORM_ACCOUNT_ID) return true;
  const sandbox = String(sandboxPlatformAccountId || '').trim().toLowerCase();
  return Boolean(sandbox) && value === sandbox;
}

/**
 * Production facilitator only. Never the sandbox account, a tenant, or memberships[0].
 * Secret MOOV_ACCOUNT_ID / MOOV_PLATFORM_ACCOUNT_ID win; otherwise the live
 * production billing destination is the ChecksOps facilitator.
 */
export function resolveProductionPlatformAccountId({
  secrets = {},
  billingDestinationAccountId = null,
  sandboxPlatformAccountId = null,
} = {}) {
  const fromSecret = secrets?.MOOV_ACCOUNT_ID || secrets?.MOOV_PLATFORM_ACCOUNT_ID || null;
  const candidate = fromSecret || billingDestinationAccountId || null;
  if (!candidate) return null;
  if (isForbiddenSandboxFacilitatorId(candidate, sandboxPlatformAccountId || secrets?.MOOV_SANDBOX_PLATFORM_ACCOUNT_ID)) {
    return null;
  }
  return candidate;
}

/**
 * Facilitator id only. claimedTenantId is accepted so tests can prove it is ignored.
 */
export function resolvePlatformFacilitatorId({
  environment,
  sandboxPlatformAccountId = null,
  productionPlatformAccountId = null,
  claimedTenantId = null,
  membershipTenantId = null,
} = {}) {
  void claimedTenantId;
  void membershipTenantId;
  const env = String(environment || '').toLowerCase();
  if (env === 'production') {
    if (isForbiddenSandboxFacilitatorId(productionPlatformAccountId, sandboxPlatformAccountId)) {
      return null;
    }
    return productionPlatformAccountId || null;
  }
  return sandboxPlatformAccountId || null;
}

export function centsFromBalance(balance) {
  if (!balance) return 0;
  if (balance.valueDecimal != null) return Math.round(Number(balance.valueDecimal) * 100);
  return Number(balance.value ?? 0);
}

function walletIdOf(wallet) {
  return wallet?.walletID ?? wallet?.walletId ?? wallet?.id ?? null;
}

function walletTypeOf(wallet) {
  return String(wallet?.walletType ?? wallet?.wallet_type ?? wallet?.name ?? '').toLowerCase();
}

function isOperatingWallet(wallet) {
  const type = walletTypeOf(wallet);
  return type === 'operating' || type === 'default' || type.includes('operating') || type === 'moov-wallet';
}

/**
 * Deterministic platform/operating wallet selection.
 * Never returns wallets[0] when more than one candidate remains.
 */
export function selectPlatformWallet(wallets, {
  environment,
  platformAccountId,
} = {}) {
  const env = String(environment || '').toLowerCase();
  if (env !== 'sandbox' && env !== 'production') {
    return { wallet: null, reason: 'environment_required', warning: 'Payment wallet environment is required.' };
  }
  const rows = Array.isArray(wallets) ? wallets.filter(Boolean) : [];
  const accountFiltered = rows.filter((wallet) => {
    const accountId = wallet?.accountID ?? wallet?.accountId ?? wallet?.provider_account_id ?? null;
    if (!platformAccountId || !accountId) return true;
    return String(accountId) === String(platformAccountId);
  });
  const operating = accountFiltered.filter(isOperatingWallet);
  const pool = operating.length > 0 ? operating : accountFiltered;
  if (pool.length === 0) return { wallet: null, reason: 'not_found', warning: null };
  if (pool.length > 1) {
    return {
      wallet: null,
      reason: 'ambiguous_wallet',
      warning: `Multiple ${env} platform wallets for the ChecksOps facilitator.`,
    };
  }
  return { wallet: pool[0], reason: 'selected', warning: null };
}

export function composePlatformBankDisplay({
  providerBanks = [],
  localMethods = [],
} = {}) {
  const byId = new Map();
  for (const bank of providerBanks || []) {
    const bankAccountId = bank.bank_account_id || bank.bankAccountID || bank.bankAccountId || null;
    if (!bankAccountId) continue;
    byId.set(String(bankAccountId), {
      id: bank.id || bankAccountId,
      bank_account_id: bankAccountId,
      bank_name: bank.bank_name ?? bank.bankName ?? null,
      last_four: bank.last_four ?? bank.lastFourAccountNumber ?? null,
      account_type: bank.account_type ?? bank.bank_account_type ?? bank.bankAccountType ?? null,
      holder_name: bank.holder_name ?? bank.holderName ?? null,
      verification_status: String(bank.verification_status ?? bank.status ?? 'unknown').toLowerCase(),
      connection_status: String(bank.connection_status ?? (String(bank.status || '').toLowerCase() === 'verified' ? 'connected' : 'pending')),
      is_default: Boolean(bank.is_default),
      connected_at: bank.connected_at ?? null,
      micro_deposit: bank.micro_deposit ?? null,
      source: 'moov',
    });
  }
  for (const method of localMethods || []) {
    const bankAccountId = method.bank_account_id || method.provider_bank_account_id || method.id;
    if (!bankAccountId) continue;
    const key = String(bankAccountId);
    const existing = byId.get(key);
    byId.set(key, {
      id: method.id || existing?.id || bankAccountId,
      bank_account_id: key,
      bank_name: existing?.bank_name || method.bank_name || null,
      last_four: existing?.last_four || method.last_four || null,
      account_type: existing?.account_type || method.account_type || null,
      holder_name: existing?.holder_name || method.holder_name || null,
      verification_status: String(existing?.verification_status || method.verification_status || 'unknown').toLowerCase(),
      connection_status: existing?.connection_status || method.connection_status || 'pending',
      is_default: Boolean(method.is_default || existing?.is_default),
      connected_at: method.connected_at || existing?.connected_at || null,
      micro_deposit: method.micro_deposit || existing?.micro_deposit || null,
      source: existing ? 'moov+local' : 'local',
    });
  }
  return [...byId.values()];
}

export function platformFinanceWriteBlocked(action) {
  return fail(PLATFORM_FINANCE_WRITE_BLOCKED_MESSAGE, 403, {
    write_blocked: true,
    action: String(action || ''),
    liveProviderCalled: false,
    ach_initiated: false,
    fee_pull: false,
    bankAccountAddInvoked: false,
  });
}

async function requirePlatformOwner({ client, mapping, claims }) {
  const email = mapping?.email || claims?.email || '';
  if (isPlatformOwnerEmail(email)) return { ok: true, email };
  try {
    const row = (await client.query('SELECT public.is_platform_owner() AS is_owner')).rows[0];
    if (row?.is_owner === true) return { ok: true, email, sqlOwner: true };
  } catch {
    /* SQL unavailable — email is the remaining gate */
  }
  return fail('Platform owner access required', 403, {
    liveProviderCalled: false,
    tenant_context_used: false,
  });
}

export async function loadPlatformFinanceCredentials({
  environment,
  loadSandbox,
  loadProviderSecrets,
} = {}) {
  if (environment === 'production') {
    const loader = typeof loadProviderSecrets === 'function'
      ? loadProviderSecrets
      : (await import('../../provider-secrets.mjs')).loadProviderSecrets;
    const secrets = await loader();
    return {
      environment: 'production',
      publicKey: secrets?.MOOV_PUBLIC_KEY || null,
      secretKey: secrets?.MOOV_SECRET_KEY || null,
      platformAccountId: resolveProductionPlatformAccountId({
        secrets,
        billingDestinationAccountId: process.env.AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID || null,
        sandboxPlatformAccountId: secrets?.MOOV_SANDBOX_PLATFORM_ACCOUNT_ID || null,
      }),
      apiVersion: 'v2024.01.00',
    };
  }
  const loader = typeof loadSandbox === 'function'
    ? loadSandbox
    : (await import('../../sandbox-credentials.mjs')).loadSandboxCredentials;
  const loaded = await loader();
  return {
    environment: 'sandbox',
    publicKey: loaded?.moov?.publicKey || null,
    secretKey: loaded?.moov?.secretKey || null,
    platformAccountId: loaded?.moov?.platformAccountId || null,
    apiVersion: loaded?.moov?.apiVersion || 'v2024.01.00',
  };
}

function publicProfile(profile) {
  return {
    displayName: profile?.profile?.business?.name ?? profile?.displayName ?? null,
    accountType: profile?.accountType ?? null,
    verificationStatus: profile?.verificationStatus ?? profile?.verification?.status ?? null,
  };
}

function publicCapabilities(capabilities) {
  return (capabilities ?? []).map((item) => ({
    capability: item.capability,
    status: item.status,
  }));
}

function publicProviderBanks(banks) {
  return (banks ?? []).map((bank) => ({
    bank_account_id: bank.bankAccountID ?? bank.bankAccountId ?? null,
    bank_name: bank.bankName ?? null,
    last_four: bank.lastFourAccountNumber ?? null,
    bank_account_type: bank.bankAccountType ?? null,
    holder_name: bank.holderName ?? null,
    status: bank.status ?? null,
  }));
}

async function loadLocalPlatformMethods(client, environment, accountId) {
  if (!client?.query || !accountId) return [];
  try {
    const { rows } = await client.query(
      `SELECT id, provider_bank_account_id, bank_name, last_four, account_type, holder_name,
              verification_status, connection_status, is_default, connected_at, provider_metadata
         FROM public.payment_provider_methods
        WHERE provider = 'moov'
          AND environment = $1
          AND provider_account_id = $2
          AND is_platform = true
          AND tenant_id IS NULL
          AND external_recipient_id IS NULL
        ORDER BY created_at DESC NULLS LAST`,
      [environment, accountId],
    );
    return (rows || []).map((row) => ({
      id: row.id,
      bank_account_id: row.provider_bank_account_id,
      bank_name: row.bank_name,
      last_four: row.last_four,
      account_type: row.account_type,
      holder_name: row.holder_name,
      verification_status: row.verification_status,
      connection_status: row.connection_status,
      is_default: row.is_default,
      connected_at: row.connected_at,
      micro_deposit: row.provider_metadata?.micro_deposit ?? null,
    }));
  } catch {
    return [];
  }
}

async function walletPayload({ accountId, environment, fetchImpl }) {
  const warnings = [];
  if (!accountId) {
    return {
      wallet_id: null,
      available_cents: 0,
      pending_cents: 0,
      transactions: [],
      setup_required: true,
      warnings: ['Platform payment account is not configured yet.'],
    };
  }
  let wallets = [];
  try {
    wallets = await moovFetch(`/accounts/${accountId}/wallets`, {
      scopes: scopes.accountRead(accountId),
      fetchImpl,
    });
  } catch (error) {
    warnings.push(`wallets: ${error.message}`);
  }
  const selected = selectPlatformWallet(wallets, { environment, platformAccountId: accountId });
  if (selected.warning) warnings.push(selected.warning);
  const wallet = selected.wallet;
  const walletId = walletIdOf(wallet);
  let transactions = [];
  if (walletId) {
    try {
      transactions = await moovFetch(
        `/accounts/${accountId}/wallets/${walletId}/transactions?count=25`,
        { scopes: scopes.accountRead(accountId), fetchImpl },
      );
    } catch (error) {
      warnings.push(`transactions: ${error.message}`);
    }
  }
  return {
    wallet_id: walletId,
    available_cents: centsFromBalance(wallet?.availableBalance),
    pending_cents: centsFromBalance(wallet?.pendingBalance),
    currency: wallet?.availableBalance?.currency ?? 'USD',
    setup_required: !walletId,
    selection_reason: selected.reason,
    transactions: (transactions ?? []).map((item) => ({
      id: item.walletTransactionID ?? item.transactionID ?? null,
      type: item.transactionType ?? null,
      status: item.status ?? null,
      amount_cents: Number(item.grossAmount ?? item.netAmount ?? 0),
      available_balance_cents: Number(item.availableBalance ?? 0),
      created_at: item.createdOn ?? item.completedOn ?? null,
      memo: item.memo ?? item.sourceType ?? null,
    })),
    warnings,
  };
}

/**
 * Transfer statuses that are not money moved: never sent to the provider (ready),
 * stopped (failed, canceled) or sent back (returned, reversed).
 */
export const PNL_EXCLUDED_TRANSFER_STATUSES = Object.freeze(['ready', 'failed', 'cancelled', 'canceled', 'returned', 'reversed']);

/**
 * What the providers charge ChecksOps. Owner, 2026-11-25/26: "Check alt charges $0.68 per
 * check." "Moov charges $500 minimum. They charge $0.25 for next day disbursement and $0.40
 * for same day". Confirmed with the owner: the $500 minimum is per calendar month; the
 * $0.25 / $0.40 apply to payouts to recipients only (not fee collection pulls, not wallet
 * funding); the top-up to the minimum is not split by tenant and is its own line on the
 * month and on the total. No overheads (AWS and the like) are counted.
 *
 * Dated rows, oldest first: a rate change is a new row with its effective_from (UTC day),
 * never an edit of an old one. An item is priced by the row in force on its own date.
 */
export const PROVIDER_COST_RATES = Object.freeze([
  Object.freeze({
    effective_from: '2026-01-01',
    checkalt_per_check_cents: 68,
    moov_next_day_cents: 25,
    moov_same_day_cents: 40,
    moov_monthly_minimum_cents: 50000,
  }),
]);

/** The rate row in force on a date; a date before the first row takes the first row. */
export function providerCostRatesAt(value) {
  const at = value instanceof Date ? value : new Date(value);
  const day = Number.isNaN(at.getTime()) ? '' : at.toISOString().slice(0, 10);
  let picked = PROVIDER_COST_RATES[0];
  for (const row of PROVIDER_COST_RATES) {
    if (row.effective_from <= day) picked = row;
  }
  return picked;
}

/** Calendar month (UTC) as YYYY-MM; pg hands timestamptz back as a Date, not ISO text. */
export function pnlMonthOf(value) {
  if (!value) return 'unknown';
  const at = value instanceof Date ? value : new Date(value);
  return Number.isNaN(at.getTime()) ? 'unknown' : at.toISOString().slice(0, 7);
}

/**
 * The P&L window: from the first day (UTC) of the month 11 months before the current UTC
 * month, through now. Date.UTC normalises the month, so the 29th-31st cannot overflow into
 * the following month the way setMonth on the current day did.
 */
export function pnlWindow(now = new Date()) {
  const at = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  return {
    since: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() - 11, 1)),
    until: at,
  };
}

/** The P&L sources, as they are named in sources_unavailable. */
export const PNL_SOURCES = Object.freeze(['tenants', 'collected_revenue', 'payouts', 'check_deposits']);

/** A payout to a recipient is one or two of these legs (providers/production/moov-send.mjs SEND_LEG_ROLES). */
export const PNL_SEND_LEG_ROLES = Object.freeze(['send_wallet', 'send_bank']);
// BILLABLE_TRANSFER_STATUSES and the not-yet statuses of transferIsQualifying (tenant-billing-engine.mjs).
const PNL_COMPLETED_TRANSFER_STATUSES = Object.freeze(['completed', 'settled', 'succeeded']);
const PNL_NOT_YET_TRANSFER_STATUSES = Object.freeze(['pending', 'created']);
/**
 * Deposits the check provider received: approved or accepted ('submitted', 'cleared'; SQL 120,
 * aws_record_checkalt_billing_event) and 'returned' (a returned check was submitted and charged).
 */
export const PNL_SUBMITTED_DEPOSIT_STATUSES = Object.freeze(['submitted', 'cleared', 'returned']);
const PNL_VERIFICATION_OCCURRENCE = 'billing_verification'; // OCCURRENCE_KIND_VERIFICATION, tenant-billing-engine.mjs

/**
 * A completed send leg: transferIsQualifying (tenant-billing-engine.mjs: completed_at set, or
 * a completed status, and not failed / canceled / ready / pending / created), and not sent
 * back afterwards (returned, reversed). Replicated here: the engine is not imported by a
 * read model.
 */
export function pnlTransferIsCompleted(transfer) {
  if (!transfer) return false;
  const status = String(transfer.status || '').toLowerCase();
  if (PNL_EXCLUDED_TRANSFER_STATUSES.includes(status) || PNL_NOT_YET_TRANSFER_STATUSES.includes(status)) return false;
  if (transfer.completed_at) return true;
  return PNL_COMPLETED_TRANSFER_STATUSES.includes(status);
}

function pnlMetadataOf(transfer) {
  const meta = transfer?.provider_metadata;
  if (meta && typeof meta === 'object') return meta;
  if (typeof meta === 'string') {
    try {
      const parsed = JSON.parse(meta);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * One recipient of one send is one payout: its wallet leg and its bank top-up leg share
 * provider_metadata request_hash and recipient_index. Same key as sendRecipientKey
 * (tenant-billing-engine.mjs, SQL 120), within the tenant.
 */
export function pnlPayoutKey(transfer) {
  const meta = pnlMetadataOf(transfer);
  const hash = meta.request_hash == null ? '' : String(meta.request_hash);
  const tenant = transfer?.tenant_id || 'unassigned';
  if (!hash) return `${tenant}|leg:${transfer?.id}`;
  const recipient = meta.recipient_index == null ? '' : String(meta.recipient_index);
  return `${tenant}|send:${hash}:${recipient}`;
}

/**
 * The delivery speed of a send leg that is an ACH credit to a bank: 'same_day', 'next_day',
 * or null when the leg has no such fee. Speed names as feeTypeForTransfer
 * (tenant-billing-engine.mjs): standard is next day; instant or an unknown speed has no rate
 * here. A leg to the recipient's wallet (destination_kind 'wallet') uses no ACH rail.
 */
export function pnlAchCreditSpeed(transfer) {
  if (String(pnlMetadataOf(transfer).destination_kind || '').toLowerCase() === 'wallet') return null;
  const speed = String(transfer?.requested_speed || transfer?.speed || 'standard').toLowerCase().replace(/-/g, '_');
  if (speed === 'same_day' || speed === 'moov_same_day') return 'same_day';
  if (['standard', 'next_day', 'moov_next_day', 'ach'].includes(speed)) return 'next_day';
  return null;
}

const pnlTimeOf = (value) => {
  if (!value) return NaN;
  return (value instanceof Date ? value : new Date(value)).getTime();
};

const pnlNextMonth = (month) => {
  const [year, index] = month.split('-').map(Number);
  return new Date(Date.UTC(year, index, 1)).toISOString().slice(0, 7);
};

const pnlBucket = () => ({
  revenue_cents: 0,
  checkalt_cost_cents: 0,
  moov_cost_cents: 0,
  volume_cents: 0,
  payout_count: 0,
  check_count: 0,
  next_day_count: 0,
  same_day_count: 0,
});

/**
 * The row the panel reads. The keys it already had keep their place with the new meaning:
 * fees_cents is the collected revenue, transfer_fees_cents is 0 (no per-transfer fee is
 * collected apart from the settled obligations) and transfer_count is the payout count.
 * topupCents is null on tenant rows: the monthly minimum is not attributed to a tenant.
 */
function pnlShape(bucket, topupCents = null) {
  const moov = bucket.moov_cost_cents + (topupCents || 0);
  const providerCost = bucket.checkalt_cost_cents + moov;
  return {
    fees_cents: bucket.revenue_cents,
    transfer_fees_cents: 0,
    provider_cost_cents: providerCost,
    volume_cents: bucket.volume_cents,
    transfer_count: bucket.payout_count,
    revenue_cents: bucket.revenue_cents,
    profit_cents: bucket.revenue_cents - providerCost,
    checkalt_cost_cents: bucket.checkalt_cost_cents,
    moov_cost_cents: moov,
    check_count: bucket.check_count,
    payout_count: bucket.payout_count,
    next_day_count: bucket.next_day_count,
    same_day_count: bucket.same_day_count,
    ...(topupCents === null ? {} : { moov_minimum_topup_cents: topupCents }),
  };
}

function pnlCostBasis() {
  return {
    estimated: true,
    rates: PROVIDER_COST_RATES.map((row) => ({ ...row })),
    notes: [
      'Provider cost is an estimate from the rates above, not the provider invoices.',
      'Revenue is money collected: settled tenant billing obligations by settlement date; the $1.00 bank verification debits are not revenue.',
      'Volume and payout count are completed payouts to recipients, each counted once; the legs of one payout add up to its amount.',
      'Payout fee: one per completed send leg that is an ACH credit to a bank, by delivery speed; a leg to a wallet has none.',
      'Check fee: one per check submitted for deposit, counted once at its first submission.',
      'The monthly minimum applies from the first month with a completed payout in the window through the current month; its top-up is not attributed to any organization.',
      'No overheads are counted.',
    ],
  };
}

/**
 * One P&L read. A failed read (missing table, missing permission) is named in `unavailable`
 * and logged, so a zero is never presented as a fact; the savepoint keeps the request's
 * transaction usable for the remaining reads. Returns null when the read failed.
 */
async function pnlRead(client, source, unavailable, sql, params = []) {
  const savepoint = `pnl_${source}`;
  let held = false;
  try {
    await client.query(`SAVEPOINT ${savepoint}`);
    held = true;
  } catch { /* not inside a transaction: the read stands on its own */ }
  try {
    const { rows } = await client.query(sql, params);
    if (held) {
      try { await client.query(`RELEASE SAVEPOINT ${savepoint}`); } catch { /* nothing to release */ }
    }
    return rows || [];
  } catch (error) {
    if (held) {
      try { await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`); } catch { /* transaction already over */ }
    }
    if (!unavailable.includes(source)) unavailable.push(source);
    console.warn('platform_finance_pnl_source_unavailable', JSON.stringify({ source, code: error?.code ?? null }));
    return null;
  }
}

export async function pnlPayload(client, { environment = null, now = new Date() } = {}) {
  const window = pnlWindow(now);
  const sinceIso = window.since.toISOString();
  const untilIso = window.until.toISOString();
  const sinceMs = window.since.getTime();
  const untilMs = window.until.getTime();
  const inWindow = (value) => {
    const at = pnlTimeOf(value);
    return !Number.isNaN(at) && at >= sinceMs && at <= untilMs;
  };
  if (!client?.query) {
    return {
      since: sinceIso,
      until: untilIso,
      totals: pnlShape(pnlBucket(), 0),
      months: [],
      tenants: [],
      cost_basis: pnlCostBasis(),
      sources_unavailable: [...PNL_SOURCES],
    };
  }
  const unavailable = [];

  let tenants = await pnlRead(client, 'tenants', [], 'SELECT id, name, is_test_account FROM public.tenants');
  if (tenants === null) {
    // Without the flag, demo (test account) organizations cannot be told apart: named below.
    tenants = await pnlRead(client, 'tenants', unavailable, 'SELECT id, name FROM public.tenants');
    if (tenants !== null && environment === 'production') unavailable.push('test_account_flag');
  }

  // Revenue is what was collected: settled billing obligations, on the day they settled.
  // The collection legs of an obligation (payment_transfers, tenant-collection-v2) are parts
  // of the same money and are not read here.
  const payments = await pnlRead(
    client,
    'collected_revenue',
    unavailable,
    `SELECT tenant_id, amount_cents, status, settled_at, occurrence_kind, provider_environment
       FROM public.tenant_maintenance_payments
      WHERE status = 'settled'
        AND settled_at >= $1 AND settled_at <= $2
        AND occurrence_kind IS DISTINCT FROM '${PNL_VERIFICATION_OCCURRENCE}'${environment ? `
        AND provider_environment = $3` : ''}`,
    environment ? [sinceIso, untilIso, environment] : [sinceIso, untilIso],
  );

  // Only this environment's money: production P&L never counts sandbox (test account) transfers.
  const legs = await pnlRead(
    client,
    'payouts',
    unavailable,
    `SELECT id, tenant_id, environment, amount_cents, status, speed, leg_role, completed_at, created_at, provider_metadata
       FROM public.payment_transfers
      WHERE leg_role IN (${PNL_SEND_LEG_ROLES.map((role) => `'${role}'`).join(', ')})
        AND (completed_at IS NOT NULL OR lower(status) IN (${PNL_COMPLETED_TRANSFER_STATUSES.map((status) => `'${status}'`).join(', ')}))
        AND COALESCE(completed_at, created_at) >= $1 AND COALESCE(completed_at, created_at) <= $2${environment ? `
        AND environment = $3` : ''}`,
    environment ? [sinceIso, untilIso, environment] : [sinceIso, untilIso],
  );

  // No lower bound: a check is counted once, at its first submission, which may precede a
  // later deposit row of the same check. This table has no environment column.
  const deposits = await pnlRead(
    client,
    'check_deposits',
    unavailable,
    `SELECT id, tenant_id, check_intake_item_id, checkalt_reference, status, submitted_at
       FROM public.checkalt_deposits
      WHERE checkalt_reference IS NOT NULL
        AND submitted_at IS NOT NULL AND submitted_at <= $1
        AND status IN (${PNL_SUBMITTED_DEPOSIT_STATUSES.map((status) => `'${status}'`).join(', ')})`,
    [untilIso],
  );

  const nameById = new Map((tenants || []).map((row) => [row.id, row.name]));
  // Production P&L leaves out demo (test account) organizations: they run on the sandbox ledger.
  const excludedTenants = new Set(environment === 'production'
    ? (tenants || []).filter((row) => row.is_test_account === true).map((row) => row.id)
    : []);
  const byMonth = new Map();
  const byTenant = new Map();
  const bump = (map, key) => {
    if (!map.has(key)) map.set(key, pnlBucket());
    return map.get(key);
  };
  const bucketsOf = (tenantId, at) => [bump(byMonth, pnlMonthOf(at)), bump(byTenant, tenantId || 'unassigned')];

  for (const payment of payments || []) {
    if (String(payment.status || '').toLowerCase() !== 'settled') continue;
    if (payment.occurrence_kind === PNL_VERIFICATION_OCCURRENCE) continue;
    if (environment && payment.provider_environment !== environment) continue;
    if (!inWindow(payment.settled_at)) continue;
    if (excludedTenants.has(payment.tenant_id)) continue;
    for (const bucket of bucketsOf(payment.tenant_id, payment.settled_at)) {
      bucket.revenue_cents += Number(payment.amount_cents || 0);
    }
  }

  const payoutFirstLeg = new Map();
  let firstPayoutMonth = null;
  for (const leg of legs || []) {
    if (!PNL_SEND_LEG_ROLES.includes(leg.leg_role)) continue;
    if (!pnlTransferIsCompleted(leg)) continue;
    if (environment && leg.environment !== undefined && leg.environment !== environment) continue;
    const at = leg.completed_at || leg.created_at;
    if (!inWindow(at)) continue;
    if (excludedTenants.has(leg.tenant_id)) continue;
    const speed = pnlAchCreditSpeed(leg);
    const rates = providerCostRatesAt(at);
    const fee = speed === 'same_day' ? rates.moov_same_day_cents : speed === 'next_day' ? rates.moov_next_day_cents : 0;
    for (const bucket of bucketsOf(leg.tenant_id, at)) {
      bucket.volume_cents += Number(leg.amount_cents || 0);
      bucket.moov_cost_cents += fee;
      if (speed === 'same_day') bucket.same_day_count += 1;
      if (speed === 'next_day') bucket.next_day_count += 1;
    }
    const month = pnlMonthOf(at);
    if (firstPayoutMonth === null || month < firstPayoutMonth) firstPayoutMonth = month;
    const key = pnlPayoutKey(leg);
    const first = payoutFirstLeg.get(key);
    if (!first || pnlTimeOf(at) < pnlTimeOf(first.at)) payoutFirstLeg.set(key, { at, tenantId: leg.tenant_id });
  }
  // A payout whose legs completed in different months is counted in the month of its first leg.
  for (const { at, tenantId } of payoutFirstLeg.values()) {
    for (const bucket of bucketsOf(tenantId, at)) bucket.payout_count += 1;
  }

  const firstSubmission = new Map();
  for (const deposit of deposits || []) {
    if (!deposit.checkalt_reference || !deposit.submitted_at) continue;
    if (!PNL_SUBMITTED_DEPOSIT_STATUSES.includes(String(deposit.status || '').toLowerCase())) continue;
    const at = pnlTimeOf(deposit.submitted_at);
    if (Number.isNaN(at) || at > untilMs) continue;
    const key = deposit.check_intake_item_id ? `check:${deposit.check_intake_item_id}` : `reference:${deposit.checkalt_reference}`;
    const first = firstSubmission.get(key);
    if (!first || at < pnlTimeOf(first.submitted_at)) firstSubmission.set(key, deposit);
  }
  for (const deposit of firstSubmission.values()) {
    if (!inWindow(deposit.submitted_at)) continue;
    if (excludedTenants.has(deposit.tenant_id)) continue;
    const rates = providerCostRatesAt(deposit.submitted_at);
    for (const bucket of bucketsOf(deposit.tenant_id, deposit.submitted_at)) {
      bucket.check_count += 1;
      bucket.checkalt_cost_cents += rates.checkalt_per_check_cents;
    }
  }

  // The monthly minimum: from the first month with a completed payout through the current
  // month, never for a month before the payout provider was in use.
  const topupByMonth = new Map();
  if (firstPayoutMonth) {
    const currentMonth = pnlMonthOf(window.until);
    for (let month = firstPayoutMonth; month <= currentMonth; month = pnlNextMonth(month)) {
      const minimum = providerCostRatesAt(`${month}-01T00:00:00Z`).moov_monthly_minimum_cents;
      topupByMonth.set(month, Math.max(0, minimum - bump(byMonth, month).moov_cost_cents));
    }
  }

  const months = [...byMonth.entries()]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([month, bucket]) => ({ month, ...pnlShape(bucket, topupByMonth.get(month) ?? 0) }));
  const tenantRows = [...byTenant.entries()]
    .map(([id, bucket]) => ({ tenant_id: id, tenant_name: nameById.get(id) ?? 'Unassigned', ...pnlShape(bucket) }))
    .sort((left, right) => right.revenue_cents - left.revenue_cents);
  const sum = pnlBucket();
  for (const bucket of byMonth.values()) {
    for (const key of Object.keys(sum)) sum[key] += bucket[key];
  }
  const totals = pnlShape(sum, [...topupByMonth.values()].reduce((acc, cents) => acc + cents, 0));
  return {
    since: sinceIso,
    until: untilIso,
    totals,
    months,
    tenants: tenantRows,
    cost_basis: pnlCostBasis(),
    sources_unavailable: unavailable,
  };
}

async function statusPayload({ client, accountId, environment, fetchImpl }) {
  const warnings = [];
  let profile = null;
  let capabilities = [];
  let providerBanks = [];
  if (accountId) {
    try {
      profile = await moovFetch(`/accounts/${accountId}`, {
        scopes: scopes.accountRead(accountId),
        fetchImpl,
      });
    } catch (error) {
      warnings.push(`profile: ${error.message}`);
    }
    try {
      capabilities = await moovFetch(`/accounts/${accountId}/capabilities`, {
        scopes: scopes.capabilitiesRead(accountId),
        fetchImpl,
      });
    } catch (error) {
      warnings.push(`capabilities: ${error.message}`);
    }
    try {
      providerBanks = await moovFetch(`/accounts/${accountId}/bank-accounts`, {
        scopes: scopes.bankAccountsRead(accountId),
        fetchImpl,
      });
    } catch (error) {
      warnings.push(`bank-accounts: ${error.message}`);
    }
  } else {
    warnings.push('Platform payment account is not configured yet.');
  }
  const localMethods = await loadLocalPlatformMethods(client, environment, accountId);
  const provider_bank_accounts = publicProviderBanks(providerBanks);
  const methods = composePlatformBankDisplay({
    providerBanks: provider_bank_accounts,
    localMethods,
  });
  return {
    success: true,
    environment,
    platform_account_id: accountId,
    identity: 'checksops_facilitator',
    tenant_context_used: false,
    profile: publicProfile(profile),
    capabilities: publicCapabilities(capabilities),
    provider_bank_accounts,
    methods,
    warnings,
    liveProviderCalled: Boolean(accountId),
    ach_initiated: false,
    fee_pull: false,
    bankAccountAddInvoked: false,
  };
}

async function runPlatformFinance({ client, body, ctx, fetchImpl }) {
  const action = String(body?.action ?? (ctx.name === 'platform-treasury' ? 'overview' : 'status')).toLowerCase();
  if (isPlatformFinanceWriteAction(action)) return platformFinanceWriteBlocked(action);
  if (!isPlatformFinanceReadAction(action)) return platformFinanceWriteBlocked(action);

  const environment = ctx.environment;
  const accountId = ctx.platformAccountId;
  if (action === 'status' || action === 'list' || action === 'get') {
    return jsonResult(await statusPayload({ client, accountId, environment, fetchImpl }));
  }
  if (action === 'wallet') {
    return jsonResult({
      success: true,
      environment,
      platform_account_id: accountId,
      identity: 'checksops_facilitator',
      tenant_context_used: false,
      wallet: await walletPayload({ accountId, environment, fetchImpl }),
      liveProviderCalled: Boolean(accountId),
      ach_initiated: false,
      fee_pull: false,
    });
  }
  if (action === 'pnl') {
    return jsonResult({
      success: true,
      environment,
      identity: 'checksops_facilitator',
      tenant_context_used: false,
      pnl: await pnlPayload(client, { environment }),
      liveProviderCalled: false,
      ach_initiated: false,
      fee_pull: false,
    });
  }
  const [wallet, pnl] = await Promise.all([
    walletPayload({ accountId, environment, fetchImpl }),
    pnlPayload(client, { environment }),
  ]);
  return jsonResult({
    success: true,
    environment,
    platform_account_id: accountId,
    identity: 'checksops_facilitator',
    tenant_context_used: false,
    wallet,
    pnl,
    liveProviderCalled: Boolean(accountId),
    ach_initiated: false,
    fee_pull: false,
    bankAccountAddInvoked: false,
  });
}

export const platformFinanceBank = {
  requirePlatformOwner: true,
  run: runPlatformFinance,
};

export const platformFinanceTreasury = {
  requirePlatformOwner: true,
  run: runPlatformFinance,
};

export const wrapPlatformFinance = (handler, name) => async (event, deps = {}) => {
  const { parseBody, withIdentity } = await import('../../data.mjs');
  const identity = typeof deps.withIdentity === 'function' ? deps.withIdentity : withIdentity;
  return identity(event, async ({ client, mapping, claims, body, spoof }) => {
    const owner = await requirePlatformOwner({ client, mapping, claims });
    if (owner.error) {
      return { ...owner, spoofFieldsIgnored: spoof, applicationUserId: mapping.application_user_id };
    }
    const environment = resolvePlatformFinanceEnvironment({
      checksopsEnv: process.env.CHECKSOPS_ENV,
    });
    const credentials = await loadPlatformFinanceCredentials({
      environment,
      loadSandbox: deps.loadSandboxCredentials,
      loadProviderSecrets: deps.loadProviderSecrets,
    });
    if (!credentials.publicKey || !credentials.secretKey) {
      return fail(
        environment === 'production'
          ? 'Production payment credentials are not configured.'
          : 'Sandbox payment credentials are not configured for this test organization.',
        503,
        { liveProviderCalled: false, tenant_context_used: false },
      );
    }
    const platformAccountId = resolvePlatformFacilitatorId({
      environment,
      sandboxPlatformAccountId: environment === 'sandbox' ? credentials.platformAccountId : null,
      productionPlatformAccountId: environment === 'production' ? credentials.platformAccountId : null,
      claimedTenantId: body?.tenant_id || body?.tenantId || null,
      membershipTenantId: null,
    });
    if (environment === 'production' && !platformAccountId) {
      return fail('Production platform facilitator account is not configured.', 503, {
        liveProviderCalled: false,
        tenant_context_used: false,
        sandbox_selected: false,
      });
    }
    const moovContext = environment === 'production'
      ? {
        environment: 'production',
        sandboxPublicKey: null,
        sandboxSecretKey: null,
        sandboxPlatformAccountId: null,
        productionPublicKey: credentials.publicKey,
        productionSecretKey: credentials.secretKey,
        productionPlatformAccountId: platformAccountId,
        apiVersion: credentials.apiVersion,
      }
      : {
        environment: 'sandbox',
        sandboxPublicKey: credentials.publicKey,
        sandboxSecretKey: credentials.secretKey,
        sandboxPlatformAccountId: platformAccountId,
        productionPublicKey: null,
        productionSecretKey: null,
        productionPlatformAccountId: null,
        apiVersion: credentials.apiVersion,
      };
    const ctx = {
      name,
      environment,
      platformAccountId,
      userId: mapping.application_user_id,
      tenantId: null,
      tenant_context_used: false,
      claimedTenantIdIgnored: body?.tenant_id || body?.tenantId || null,
      moovContext,
    };
    try {
      const fetchImpl = deps.fetchImpl || fetch;
      const result = await withMoovContext({ ...moovContext, fetchImpl }, () => handler.run({
        client, mapping, claims, body: body || parseBody(event), spoof, ctx, fetchImpl, event,
      }));
      return {
        ...result,
        spoofFieldsIgnored: spoof,
        applicationUserId: mapping.application_user_id,
        authUid: mapping.application_user_id,
        cognitoSub: claims.sub,
        productionExecution: false,
        environment,
        tenant_context_used: false,
        apiVersion: moovContext.apiVersion,
      };
    } catch (error) {
      return fail(error.message, error.status || 500, {
        spoofFieldsIgnored: spoof,
        applicationUserId: mapping.application_user_id,
        liveProviderCalled: true,
        tenant_context_used: false,
        ach_initiated: false,
        fee_pull: false,
      });
    }
  }, deps);
};
