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
 * Server environment is authoritative. Staging always sandbox.
 * Production CHECKSOPS_ENV selects the production facilitator.
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
  if (env === 'production') return 'production';
  if (host === 'checksops.com' || host === 'www.checksops.com' || host === 'checkops.com' || host === 'www.checkops.com') {
    return 'production';
  }
  return 'sandbox';
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
  if (env === 'production') return productionPlatformAccountId || null;
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
      platformAccountId: secrets?.MOOV_ACCOUNT_ID || secrets?.MOOV_PLATFORM_ACCOUNT_ID || null,
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

async function pnlPayload(client) {
  const empty = () => ({
    fees_cents: 0,
    transfer_fees_cents: 0,
    provider_cost_cents: 0,
    volume_cents: 0,
    transfer_count: 0,
  });
  if (!client?.query) {
    const totals = { ...empty(), revenue_cents: 0, profit_cents: 0 };
    return { totals, months: [], tenants: [] };
  }
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
      `SELECT tenant_id, amount_cents, occurred_at, fee_code, status
         FROM public.platform_fee_line_items
        WHERE occurred_at >= $1`,
      [sinceIso],
    )).rows;
  } catch { /* optional */ }
  try {
    transfers = (await client.query(
      `SELECT tenant_id, amount_cents, provider_fee_cents, platform_fee_cents, status, created_at
         FROM public.payment_transfers
        WHERE created_at >= $1`,
      [sinceIso],
    )).rows;
  } catch { /* optional */ }

  const nameById = new Map((tenants || []).map((row) => [row.id, row.name]));
  const monthOf = (iso) => (iso ? String(iso).slice(0, 7) : 'unknown');
  const byMonth = new Map();
  const byTenant = new Map();
  const bump = (map, key) => {
    if (!map.has(key)) map.set(key, empty());
    return map.get(key);
  };
  for (const fee of fees || []) {
    if (String(fee.status || '').toLowerCase() === 'void') continue;
    const amount = Number(fee.amount_cents || 0);
    bump(byMonth, monthOf(fee.occurred_at)).fees_cents += amount;
    bump(byTenant, fee.tenant_id || 'unassigned').fees_cents += amount;
  }
  for (const transfer of transfers || []) {
    const status = String(transfer.status || '').toLowerCase();
    if (['failed', 'cancelled', 'canceled'].includes(status)) continue;
    for (const bucket of [bump(byMonth, monthOf(transfer.created_at)), bump(byTenant, transfer.tenant_id || 'unassigned')]) {
      bucket.transfer_fees_cents += Number(transfer.platform_fee_cents || 0);
      bucket.provider_cost_cents += Number(transfer.provider_fee_cents || 0);
      bucket.volume_cents += Number(transfer.amount_cents || 0);
      bucket.transfer_count += 1;
    }
  }
  const shape = (bucket) => {
    const revenue = bucket.fees_cents + bucket.transfer_fees_cents;
    return { ...bucket, revenue_cents: revenue, profit_cents: revenue - bucket.provider_cost_cents };
  };
  const months = [...byMonth.entries()]
    .filter(([key]) => key !== 'unknown')
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([month, bucket]) => ({ month, ...shape(bucket) }));
  const tenantRows = [...byTenant.entries()]
    .map(([id, bucket]) => ({ tenant_id: id, tenant_name: nameById.get(id) ?? 'Unassigned', ...shape(bucket) }))
    .sort((left, right) => right.revenue_cents - left.revenue_cents);
  const totals = shape([...byTenant.values()].reduce((acc, bucket) => {
    acc.fees_cents += bucket.fees_cents;
    acc.transfer_fees_cents += bucket.transfer_fees_cents;
    acc.provider_cost_cents += bucket.provider_cost_cents;
    acc.volume_cents += bucket.volume_cents;
    acc.transfer_count += bucket.transfer_count;
    return acc;
  }, empty()));
  return { since: sinceIso, totals, months, tenants: tenantRows };
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
      pnl: await pnlPayload(client),
      liveProviderCalled: false,
      ach_initiated: false,
      fee_pull: false,
    });
  }
  const [wallet, pnl] = await Promise.all([
    walletPayload({ accountId, environment, fetchImpl }),
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
