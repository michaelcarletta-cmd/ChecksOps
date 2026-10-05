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

/** Verified ChecksOps production facilitator. Wallet reads pin this account's known wallet. */
export const PRODUCTION_PLATFORM_ACCOUNT_ID = '41cb5d67-4911-4bef-aad5-d8ee9c582208';

/** Known production operating wallet. Read only. Never created by this module. */
export const PRODUCTION_PLATFORM_WALLET_ID = '72630a70-4954-4761-b652-e8beff1ad02c';

export const walletReadScopes = (accountId) => [`/accounts/${accountId}/wallets.read`];

export function knownProductionWalletId(accountId, environment) {
  if (String(environment || '').toLowerCase() !== 'production') return null;
  if (String(accountId || '') !== PRODUCTION_PLATFORM_ACCOUNT_ID) return null;
  return PRODUCTION_PLATFORM_WALLET_ID;
}

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

export function toIsoTimestamp(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  return null;
}

/**
 * Year-month key from a node-pg Date, ISO string, or other parseable value.
 * Does not mutate the source timestamp.
 */
export function monthOf(value) {
  if (value == null || value === '') return 'unknown';
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  const raw = String(value).trim();
  const isoPrefix = raw.match(/^(\d{4}-\d{2})/);
  if (isoPrefix) return isoPrefix[1];
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    return `${parsed.getUTCFullYear()}-${String(parsed.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  return 'unknown';
}

export function classifyFeeCollection(fee = {}) {
  const status = String(fee.status || '').toLowerCase();
  if (status === 'void') return 'void';
  const occurrenceStatus = String(fee.occurrence_status || '').toLowerCase();
  const providerTransferId = String(fee.provider_transfer_id || '').trim();
  if (status === 'billed' && occurrenceStatus === 'completed' && providerTransferId) {
    return 'collected';
  }
  if (status === 'billed') return 'billed_processing';
  return 'outstanding';
}

export function isCompletedProductionTransfer(transfer = {}) {
  const environment = String(transfer.environment || '').toLowerCase();
  const status = String(transfer.status || '').toLowerCase();
  const providerTransferId = String(transfer.provider_transfer_id || '').trim();
  if (environment !== 'production') return false;
  if (status !== 'completed') return false;
  if (!providerTransferId) return false;
  return Boolean(toIsoTimestamp(transfer.completed_at));
}

export function hasRecordedProviderCost(transfer = {}) {
  if (transfer.provider_fee_cents == null || transfer.provider_fee_cents === '') return false;
  return Number.isFinite(Number(transfer.provider_fee_cents));
}

function emptyLedgerBucket() {
  return {
    charged_cents: 0,
    outstanding_cents: 0,
    billed_processing_cents: 0,
    collected_fee_cents: 0,
    collected_transfer_fee_cents: 0,
    provider_cost_cents: 0,
    provider_cost_rows: 0,
    provider_cost_missing_rows: 0,
    volume_cents: 0,
    transfer_count: 0,
  };
}

export function shapePlatformLedger(bucket = emptyLedgerBucket()) {
  const collected = Number(bucket.collected_fee_cents || 0) + Number(bucket.collected_transfer_fee_cents || 0);
  const hasVolume = Number(bucket.transfer_count || 0) > 0;
  const costComplete = Number(bucket.provider_cost_missing_rows || 0) === 0;
  const providerCostMissing = Number(bucket.provider_cost_missing_rows || 0) > 0
    || (collected > 0 && !hasVolume);
  const providerCostAvailable = hasVolume && costComplete;
  let profitCents = null;
  let profitAvailable = false;
  if (collected === 0) {
    profitCents = 0;
    profitAvailable = true;
  } else if (hasVolume && costComplete) {
    profitCents = collected - Number(bucket.provider_cost_cents || 0);
    profitAvailable = true;
  }
  return {
    charged_cents: Number(bucket.charged_cents || 0),
    outstanding_cents: Number(bucket.outstanding_cents || 0),
    billed_processing_cents: Number(bucket.billed_processing_cents || 0),
    collected_cents: collected,
    collected_fee_cents: Number(bucket.collected_fee_cents || 0),
    collected_transfer_fee_cents: Number(bucket.collected_transfer_fee_cents || 0),
    revenue_cents: collected,
    provider_cost_cents: Number(bucket.provider_cost_cents || 0),
    provider_cost_available: providerCostAvailable,
    provider_cost_missing: providerCostMissing,
    profit_cents: profitCents,
    profit_available: profitAvailable,
    volume_cents: Number(bucket.volume_cents || 0),
    transfer_count: Number(bucket.transfer_count || 0),
  };
}

export function feeActivityDate(fee = {}) {
  if (classifyFeeCollection(fee) === 'collected') {
    return fee.occurrence_updated_at || fee.occurred_at || null;
  }
  return fee.occurred_at || null;
}

export function buildPlatformPnl({
  tenants = [],
  fees = [],
  transfers = [],
  since = null,
} = {}) {
  const nameById = new Map((tenants || []).map((row) => [row.id, row.name]));
  const byMonth = new Map();
  const byTenant = new Map();
  const seenFees = new Set();
  const seenTransfers = new Set();
  const bump = (map, key) => {
    if (!map.has(key)) map.set(key, emptyLedgerBucket());
    return map.get(key);
  };
  const activity = [];

  for (const fee of fees || []) {
    const collection = classifyFeeCollection(fee);
    if (collection === 'void') continue;
    const id = fee.id || `${fee.tenant_id || 'unassigned'}:${fee.source_reference || ''}:${fee.occurred_at || ''}:${fee.amount_cents || 0}`;
    if (seenFees.has(id)) continue;
    seenFees.add(id);
    const amount = Number(fee.amount_cents || 0);
    const monthKey = monthOf(feeActivityDate(fee));
    const tenantKey = fee.tenant_id || 'unassigned';
    for (const bucket of [bump(byMonth, monthKey), bump(byTenant, tenantKey)]) {
      bucket.charged_cents += amount;
      if (collection === 'outstanding') bucket.outstanding_cents += amount;
      if (collection === 'billed_processing') bucket.billed_processing_cents += amount;
      if (collection === 'collected') bucket.collected_fee_cents += amount;
    }
    activity.push({
      kind: 'fee',
      id: fee.id || null,
      tenant_id: fee.tenant_id || null,
      tenant_name: nameById.get(fee.tenant_id) ?? (fee.tenant_id ? 'Unassigned' : 'Unassigned'),
      fee_code: fee.fee_code || null,
      description: fee.description || null,
      amount_cents: amount,
      collection_status: collection,
      occurred_at: toIsoTimestamp(fee.occurred_at),
      source_reference: fee.source_reference || null,
      check_id: fee.check_id || null,
      claim_id: fee.claim_id || null,
      occurrence_id: fee.occurrence_id || null,
      provider_transfer_id: fee.provider_transfer_id || null,
    });
  }

  for (const transfer of transfers || []) {
    if (!isCompletedProductionTransfer(transfer)) continue;
    const id = transfer.id || `${transfer.tenant_id || 'unassigned'}:${transfer.provider_transfer_id}`;
    if (seenTransfers.has(id)) continue;
    seenTransfers.add(id);
    const monthKey = monthOf(transfer.completed_at);
    const tenantKey = transfer.tenant_id || 'unassigned';
    const amount = Number(transfer.amount_cents || 0);
    const transferFee = Number(transfer.platform_fee_cents || 0);
    const recordedCost = hasRecordedProviderCost(transfer);
    for (const bucket of [bump(byMonth, monthKey), bump(byTenant, tenantKey)]) {
      bucket.volume_cents += amount;
      bucket.transfer_count += 1;
      bucket.collected_transfer_fee_cents += transferFee;
      if (recordedCost) {
        bucket.provider_cost_cents += Number(transfer.provider_fee_cents);
        bucket.provider_cost_rows += 1;
      } else {
        bucket.provider_cost_missing_rows += 1;
      }
    }
    activity.push({
      kind: 'transfer',
      id: transfer.id || null,
      tenant_id: transfer.tenant_id || null,
      tenant_name: nameById.get(transfer.tenant_id) ?? 'Unassigned',
      amount_cents: amount,
      platform_fee_cents: transferFee,
      provider_fee_cents: recordedCost ? Number(transfer.provider_fee_cents) : null,
      provider_fee_recorded: recordedCost,
      collection_status: 'completed_production',
      completed_at: toIsoTimestamp(transfer.completed_at),
      provider_transfer_id: transfer.provider_transfer_id || null,
      check_id: transfer.check_id || null,
      claim_id: transfer.claim_id || null,
    });
  }

  const months = [...byMonth.entries()]
    .filter(([key]) => key !== 'unknown')
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([month, bucket]) => ({ month, ...shapePlatformLedger(bucket) }));
  const tenantRows = [...byTenant.entries()]
    .map(([id, bucket]) => ({
      tenant_id: id,
      tenant_name: nameById.get(id) ?? 'Unassigned',
      ...shapePlatformLedger(bucket),
      items: activity.filter((item) => (item.tenant_id || 'unassigned') === id),
    }))
    .sort((left, right) => right.charged_cents - left.charged_cents);
  const totals = shapePlatformLedger([...byTenant.values()].reduce((acc, bucket) => {
    acc.charged_cents += bucket.charged_cents;
    acc.outstanding_cents += bucket.outstanding_cents;
    acc.billed_processing_cents += bucket.billed_processing_cents;
    acc.collected_fee_cents += bucket.collected_fee_cents;
    acc.collected_transfer_fee_cents += bucket.collected_transfer_fee_cents;
    acc.provider_cost_cents += bucket.provider_cost_cents;
    acc.provider_cost_rows += bucket.provider_cost_rows;
    acc.provider_cost_missing_rows += bucket.provider_cost_missing_rows;
    acc.volume_cents += bucket.volume_cents;
    acc.transfer_count += bucket.transfer_count;
    return acc;
  }, emptyLedgerBucket()));
  return {
    since,
    totals,
    months,
    tenants: tenantRows,
    activity,
    definitions: {
      charged: 'Non-void platform_fee_line_items amounts (accrued charges).',
      outstanding: "Line items with status unbilled. Not collected.",
      billed_processing: 'Line items with status billed that lack a completed occurrence plus provider_transfer_id.',
      collected: 'Billed line items whose occurrence is completed and has provider_transfer_id, plus platform_fee_cents on completed production transfers.',
      provider_cost: 'Recorded provider_fee_cents on completed production transfers only. Missing values are not treated as $0.',
      profit: 'Collected revenue minus recorded provider cost only when cost is complete. Unbilled fees are never profit.',
      volume: 'Completed production payment_transfers with provider_transfer_id and completed_at.',
    },
  };
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
  knownWalletId = null,
} = {}) {
  const env = String(environment || '').toLowerCase();
  if (env !== 'sandbox' && env !== 'production') {
    return { wallet: null, reason: 'environment_required', warning: 'Payment wallet environment is required.' };
  }
  const rows = Array.isArray(wallets) ? wallets.filter(Boolean) : [];
  if (knownWalletId) {
    const pinned = rows.find((wallet) => String(walletIdOf(wallet) || '') === String(knownWalletId));
    if (pinned) return { wallet: pinned, reason: 'known_wallet', warning: null };
    return {
      wallet: null,
      reason: 'known_wallet_missing',
      warning: 'Known platform wallet was not returned by the provider.',
    };
  }
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

function walletReadFailure({
  walletId = null,
  reason = 'read_failed',
  warnings = [],
  setupRequired = false,
} = {}) {
  return {
    wallet_id: walletId,
    available_cents: null,
    pending_cents: null,
    currency: 'USD',
    transactions: [],
    setup_required: setupRequired,
    read_error: true,
    selection_reason: reason,
    warnings,
  };
}

async function walletPayload({ accountId, environment, fetchImpl, knownWalletId = null }) {
  if (!accountId) {
    return walletReadFailure({
      reason: 'account_missing',
      setupRequired: true,
      warnings: ['Platform payment account is not configured yet.'],
    });
  }
  const scopesForRead = walletReadScopes(accountId);
  let wallet = null;
  let selectionReason = 'selected';
  const warnings = [];
  try {
    if (knownWalletId) {
      wallet = await moovFetch(`/accounts/${accountId}/wallets/${knownWalletId}`, {
        scopes: scopesForRead,
        fetchImpl,
      });
      selectionReason = 'known_wallet';
    } else {
      const wallets = await moovFetch(`/accounts/${accountId}/wallets`, {
        scopes: scopesForRead,
        fetchImpl,
      });
      const selected = selectPlatformWallet(wallets, {
        environment,
        platformAccountId: accountId,
      });
      if (selected.warning) warnings.push(selected.warning);
      wallet = selected.wallet;
      selectionReason = selected.reason;
    }
  } catch (error) {
    return walletReadFailure({
      walletId: knownWalletId,
      reason: 'provider_forbidden_or_failed',
      warnings: [`wallets: ${error.message}`],
    });
  }
  const walletId = walletIdOf(wallet);
  if (!walletId) {
    return walletReadFailure({
      walletId: knownWalletId,
      reason: selectionReason || 'not_found',
      warnings: warnings.length ? warnings : ['Platform wallet could not be read.'],
    });
  }
  let transactions = [];
  try {
    transactions = await moovFetch(
      `/accounts/${accountId}/wallets/${walletId}/transactions?count=25`,
      { scopes: scopesForRead, fetchImpl },
    );
  } catch (error) {
    warnings.push(`transactions: ${error.message}`);
  }
  return {
    wallet_id: walletId,
    available_cents: centsFromBalance(wallet?.availableBalance),
    pending_cents: centsFromBalance(wallet?.pendingBalance),
    currency: wallet?.availableBalance?.currency ?? 'USD',
    setup_required: false,
    read_error: false,
    selection_reason: selectionReason,
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

async function pnlPayload(client) {
  const empty = buildPlatformPnl({ tenants: [], fees: [], transfers: [] });
  if (!client?.query) return empty;
  const since = new Date();
  since.setMonth(since.getMonth() - 11);
  since.setDate(1);
  const sinceIso = new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), 1)).toISOString();
  let tenants = [];
  let fees = [];
  let transfers = [];
  try {
    tenants = (await client.query('SELECT id, name FROM public.tenants')).rows;
  } catch { /* optional */ }
  try {
    fees = (await client.query(
      `SELECT f.id, f.tenant_id, f.amount_cents, f.occurred_at, f.fee_code, f.status,
              f.check_id, f.claim_id, f.source_reference, f.occurrence_id, f.description,
              o.status AS occurrence_status, o.provider_transfer_id,
              o.updated_at AS occurrence_updated_at
         FROM public.platform_fee_line_items f
         LEFT JOIN public.platform_fee_occurrences o ON o.id = f.occurrence_id
        WHERE f.occurred_at >= $1`,
      [sinceIso],
    )).rows;
  } catch {
    try {
      fees = (await client.query(
        `SELECT id, tenant_id, amount_cents, occurred_at, fee_code, status,
                check_id, claim_id, source_reference, occurrence_id, description
           FROM public.platform_fee_line_items
          WHERE occurred_at >= $1`,
        [sinceIso],
      )).rows;
    } catch { /* optional */ }
  }
  try {
    transfers = (await client.query(
      `SELECT id, tenant_id, amount_cents, provider_fee_cents, platform_fee_cents, status,
              created_at, completed_at, environment, provider_transfer_id, check_id, claim_id
         FROM public.payment_transfers
        WHERE COALESCE(completed_at, created_at) >= $1`,
      [sinceIso],
    )).rows;
  } catch {
    try {
      transfers = (await client.query(
        `SELECT tenant_id, amount_cents, provider_fee_cents, platform_fee_cents, status, created_at
           FROM public.payment_transfers
          WHERE created_at >= $1`,
        [sinceIso],
      )).rows;
    } catch { /* optional */ }
  }
  return buildPlatformPnl({ tenants, fees, transfers, since: sinceIso });
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
  const knownWalletId = knownProductionWalletId(accountId, environment);
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
      wallet: await walletPayload({ accountId, environment, fetchImpl, knownWalletId }),
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
      pnl: await pnlPayload(client),
      liveProviderCalled: false,
      ach_initiated: false,
      fee_pull: false,
    });
  }
  const [wallet, pnl] = await Promise.all([
    walletPayload({ accountId, environment, fetchImpl, knownWalletId }),
    pnlPayload(client),
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
