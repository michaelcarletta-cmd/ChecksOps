/**
 * WalletOps GET-only wallet/activity projection.
 * Never POSTs to Moov. Never creates operations, intents, or transfers.
 * Tenant moov_environment is the only ledger selector.
 */
import { TENANT_MEMBERSHIP_SQL } from '../../identity.mjs';
import { membershipForTenant } from '../../financial-ownership.mjs';
import { withIdentity } from '../../data.mjs';
import {
  ignoreClientEnvironment,
  isKnownProductionMoovObject,
  loadTenantMoovEnvironment,
} from '../moov-environment.mjs';
import { moovSandboxFetch, moovSandboxScopes } from '../moov-sandbox.mjs';
import { loadSandboxCredentials } from '../../sandbox-credentials.mjs';
import { buildWalletActivityFeed } from './moov-wallet-activity.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';

const fail = (error, statusCode, extra = {}) => ({
  ok: false,
  statusCode,
  error,
  provider: 'moov',
  liveProviderCalled: extra.liveProviderCalled === true,
  liveProviderPosted: false,
  createdPaymentTransfer: false,
  productionExecution: false,
  ...extra,
});

const membershipsOf = async (client, userId) => {
  const rows = (await client.query(TENANT_MEMBERSHIP_SQL, [userId])).rows;
  return rows.map((row) => ({
    tenant_id: row.tenant_id,
    role: row.role,
    tenant_name: row.tenant_name,
    tenant_slug: row.tenant_slug,
  }));
};

const amountCentsOf = (amount) => {
  if (amount === undefined || amount === null) return null;
  if (typeof amount === 'object') {
    if (amount.valueDecimal != null && amount.valueDecimal !== '') {
      const n = Math.round(Number(amount.valueDecimal) * 100);
      return Number.isFinite(n) ? n : null;
    }
    const n = Number(amount.value ?? amount.amount ?? 0);
    return Number.isFinite(n) ? Math.round(n) : null;
  }
  const n = Number(amount);
  return Number.isFinite(n) ? Math.round(n) : null;
};

const loadWallet = async (client, tenantId, environment, walletType) => (await client.query(
  `SELECT *
     FROM public.payment_wallets
    WHERE tenant_id = $1::uuid
      AND provider = 'moov'
      AND environment = $2
      AND wallet_type = $3
    ORDER BY last_synced_at DESC NULLS LAST, updated_at DESC NULLS LAST
    LIMIT 1`,
  [tenantId, environment, walletType],
)).rows[0] || null;

const loadLedger = async (client, walletId, limit) => {
  if (!walletId) return [];
  return (await client.query(
    `SELECT *
       FROM public.payment_wallet_ledger
      WHERE wallet_id = $1::uuid
      ORDER BY created_at DESC NULLS LAST
      LIMIT $2`,
    [walletId, limit],
  )).rows;
};

const loadTransfers = async (client, tenantId, environment, limit) => (await client.query(
  `SELECT id, tenant_id, environment, amount_cents, status, provider_status,
          speed, selected_rail, description, created_at, completed_at, leg_role,
          is_facilitator_fee, provider_transfer_id, failure_reason
     FROM public.payment_transfers
    WHERE tenant_id = $1::uuid
      AND environment = $2
      AND provider = 'moov'
    ORDER BY created_at DESC NULLS LAST
    LIMIT $3`,
  [tenantId, environment, limit],
)).rows;

const loadProviderActivity = async (client, tenantId, environment, limit) => (await client.query(
  `SELECT id, tenant_id, environment, origin, activity_kind, provider_transfer_id,
          payment_transfer_id, status, amount_cents, source_rail, destination_rail,
          provider_created_at, provider_completed_at, observed_at
     FROM public.payment_provider_activity
    WHERE tenant_id = $1::uuid
      AND environment = $2
    ORDER BY COALESCE(provider_created_at, observed_at) DESC NULLS LAST
    LIMIT $3`,
  [tenantId, environment, limit],
)).rows;

const loadAccount = async (client, tenantId, environment) => (await client.query(
  `SELECT id, tenant_id, provider_account_id, environment, onboarding_status
     FROM public.payment_provider_accounts
    WHERE tenant_id = $1::uuid AND provider = 'moov' AND environment = $2
    ORDER BY updated_at DESC NULLS LAST
    LIMIT 1`,
  [tenantId, environment],
)).rows[0] || null;

/** A linked/active wallet with a real 0 cache is synchronized. Null is not. */
export const walletSnapshotIsSynchronized = (wallet, liveOk = false) => Boolean(
  liveOk === true
  || wallet?.synchronized === true
  || Boolean(wallet?.last_synced_at)
  || (String(wallet?.status || '') === 'active' && Boolean(wallet?.provider_wallet_id)),
);

export const projectWalletSnapshot = ({
  wallet = null,
  liveAvailableCents = null,
  livePendingCents = null,
  liveOk = false,
} = {}) => {
  const synchronized = walletSnapshotIsSynchronized(wallet, liveOk);
  if (!wallet && liveOk !== true) {
    return { wallet: null, synchronized: false };
  }
  const available = liveOk && liveAvailableCents != null
    ? liveAvailableCents
    : Number(wallet?.available_cents || 0);
  const pending = liveOk && livePendingCents != null
    ? livePendingCents
    : Number(wallet?.pending_cents || 0);
  return {
    synchronized,
    wallet: (wallet || liveOk) ? {
      ...(wallet || {}),
      available_cents: available,
      pending_cents: pending,
      synchronized,
      last_synced_at: wallet?.last_synced_at || (liveOk ? new Date().toISOString() : null),
      status: wallet?.status === 'sync_failed' && synchronized ? 'active' : (wallet?.status || (synchronized ? 'active' : null)),
    } : null,
  };
};

export async function runMoovWalletProjection({
  client,
  mapping,
  body = {},
  fetchImpl = fetch,
  loadSandbox = loadSandboxCredentials,
  getWallet = null,
} = {}) {
  const memberships = await membershipsOf(client, mapping.application_user_id);
  const claimed = body.tenant_id || body.tenantId || null;
  if (claimed && !UUID_RE.test(String(claimed))) {
    return fail('invalid_uuid', 400, { field: 'tenant_id' });
  }
  const tenantId = claimed
    ? (membershipForTenant(memberships, claimed)?.tenant_id || null)
    : (memberships[0]?.tenant_id || null);
  if (!tenantId) return fail('tenant_id is required', 400);

  const tenantEnv = await loadTenantMoovEnvironment(client, tenantId);
  if (!tenantEnv?.ok) return fail(tenantEnv?.error || 'moov_environment_invalid', tenantEnv?.statusCode || 409);
  const environment = tenantEnv.environment;
  const ignoredClientEnvironment = ignoreClientEnvironment(body);
  const walletType = body.wallet_type || 'operating';
  if (!['operating', 'trust'].includes(walletType)) {
    return fail("wallet_type must be 'operating' or 'trust'", 400);
  }

  const account = await loadAccount(client, tenantId, environment);
  const local = await loadWallet(client, tenantId, environment, walletType);
  if (local?.provider_wallet_id && environment === 'sandbox' && isKnownProductionMoovObject(local.provider_wallet_id)) {
    return fail('production_object_refused', 403, { environment });
  }
  if (account?.provider_account_id && environment === 'sandbox' && isKnownProductionMoovObject(account.provider_account_id)) {
    return fail('production_object_refused', 403, { environment });
  }

  let liveAvailableCents = null;
  let livePendingCents = null;
  let liveOk = false;
  let liveProviderCalled = false;
  if (environment === 'sandbox' && local?.provider_wallet_id && account?.provider_account_id) {
    try {
      let json = null;
      if (typeof getWallet === 'function') {
        json = await getWallet({
          accountId: account.provider_account_id,
          walletId: local.provider_wallet_id,
          environment,
        });
        liveProviderCalled = true;
      } else {
        const loaded = await loadSandbox();
        const credentials = loaded?.moov ? {
          environment: 'sandbox',
          publicKey: loaded.moov.publicKey,
          secretKey: loaded.moov.secretKey,
          platformId: loaded.moov.platformAccountId,
          origin: loaded.moov.origin,
          apiVersion: loaded.moov.apiVersion,
          host: loaded.moov.host || 'https://api.moov.io',
        } : null;
        if (credentials?.publicKey && credentials?.secretKey) {
          const got = await moovSandboxFetch({
            credentials,
            path: `/accounts/${account.provider_account_id}/wallets/${local.provider_wallet_id}`,
            method: 'GET',
            scopes: moovSandboxScopes.walletsRead(account.provider_account_id),
            fetchImpl,
          });
          json = got?.data || got;
          liveProviderCalled = true;
        }
      }
      if (json) {
        const available = amountCentsOf(json.availableBalance ?? json.available);
        const pending = amountCentsOf(json.pendingBalance ?? json.pending);
        if (available != null) {
          liveAvailableCents = available;
          livePendingCents = pending ?? 0;
          liveOk = true;
        }
      }
    } catch {
      liveOk = false;
    }
  }

  const projected = projectWalletSnapshot({
    wallet: local,
    liveAvailableCents,
    livePendingCents,
    liveOk,
  });
  const ledgerLimit = Math.min(Number(body.ledger_limit) || 50, 200);
  const ledger = await loadLedger(client, projected.wallet?.id || local?.id, ledgerLimit);
  const transfers = await loadTransfers(client, tenantId, environment, ledgerLimit);
  let providerActivity = [];
  try {
    providerActivity = await loadProviderActivity(client, tenantId, environment, ledgerLimit);
  } catch {
    providerActivity = [];
  }
  const activity = buildWalletActivityFeed({
    transfers,
    providerActivity,
    ledger,
    limit: ledgerLimit,
    environment,
  });
  const subLedgers = projected.wallet?.id
    ? (await client.query(
      `SELECT * FROM public.payment_wallet_sub_ledgers
        WHERE wallet_id = $1::uuid
        ORDER BY created_at DESC NULLS LAST`,
      [projected.wallet.id],
    )).rows
    : [];

  return {
    ok: true,
    statusCode: 200,
    success: true,
    provider: 'moov',
    environment,
    tenant_id: tenantId,
    ignoredClientEnvironment,
    freedomTenant: tenantId === FREEDOM,
    wallet: projected.wallet,
    synchronized: projected.synchronized,
    ledger,
    transfers,
    provider_activity: providerActivity,
    activity,
    sub_ledgers: subLedgers,
    liveProviderCalled,
    liveProviderPosted: false,
    createdPaymentTransfer: false,
    productionExecution: false,
    productionMoneyMoved: false,
  };
}

export const handleMoovWalletProjection = (event, deps = {}) => (
  withIdentity(event, async ({ client, mapping, body }) => (
    runMoovWalletProjection({
      client,
      mapping,
      body,
      fetchImpl: deps.fetchImpl || fetch,
      loadSandbox: deps.loadSandboxCredentials || loadSandboxCredentials,
      getWallet: deps.getWallet || null,
    })
  ), deps)
);
