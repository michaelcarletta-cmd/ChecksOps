import { isUuid } from '../../financial-ownership.mjs';
import { evaluateReadiness } from '../readiness.mjs';
import { assertMoovTenantView } from './moov-authz.mjs';
import { listOf, productionMoovFetch } from './moov-http.mjs';
import { resolveProductionMerchant } from './moov-parties.mjs';
import { getApprovedAccountSnapshot } from './moov-preflight.mjs';
import { loadProductionMoovReadSecrets } from './moov-secrets.mjs';

const fail = (error, statusCode, extra = {}) => ({
  ok: false,
  statusCode,
  error,
  provider: 'moov',
  liveProviderCalled: extra.liveProviderCalled === true,
  productionExecution: false,
  kycRequested: false,
  capabilitiesPosted: false,
  ...extra,
});

const claimedTenant = (body) => body?.tenant_id || body?.tenantId || null;

export const amountToCents = (amount) => {
  if (amount === undefined || amount === null) return 0;
  if (typeof amount === 'object') {
    if (amount.valueDecimal !== undefined && amount.valueDecimal !== null) {
      const dollars = Number(amount.valueDecimal);
      return Number.isFinite(dollars) ? Math.round(dollars * 100) : 0;
    }
    const raw = amount.value ?? amount.amount ?? 0;
    if (typeof raw === 'string' && raw.includes('.')) {
      const dollars = Number(raw);
      return Number.isFinite(dollars) ? Math.round(dollars * 100) : 0;
    }
    const n = Number(raw);
    return Number.isFinite(n) ? Math.round(n) : 0;
  }
  const n = Number(amount);
  return Number.isFinite(n) ? Math.round(n) : 0;
};

const emptyReadiness = (environment = 'production') => evaluateReadiness({
  environment,
  accountId: null,
  capabilities: [],
  banks: [],
  termsAccepted: false,
});

export const normalizeSweepConfig = (cfg = {}) => ({
  provider_sweep_config_id: cfg.sweepConfigID || cfg.sweepConfigId || cfg.id || null,
  provider_wallet_id: cfg.walletID || cfg.walletId || null,
  status: String(cfg.status || 'disabled').toLowerCase() === 'enabled' ? 'enabled' : 'disabled',
  push_payment_method_id: cfg.pushPaymentMethodID || cfg.pushPaymentMethodId || null,
  pull_payment_method_id: cfg.pullPaymentMethodID || cfg.pullPaymentMethodId || null,
  minimum_balance_cents: amountToCents(cfg.minimumBalance),
  statement_descriptor: cfg.statementDescriptor || null,
  provider_created_at: cfg.createdOn || null,
  provider_updated_at: cfg.updatedOn || null,
});

const railsFromMethods = (methods = []) => {
  const types = listOf(methods).map((row) => String(row.paymentMethodType || ''));
  const preference = ['instant-bank-credit', 'rtp-credit', 'ach-credit-same-day', 'ach-credit-standard'];
  return preference.filter((rail) => types.includes(rail));
};

const settlementFromBanks = (banks = [], methods = []) => {
  const bank = listOf(banks)[0] || null;
  if (!bank) return null;
  const credit = listOf(methods).find((row) => String(row.paymentMethodType || '').startsWith('ach-credit'));
  return {
    id: bank.bankAccountID || bank.bankAccountId || credit?.paymentMethodID || null,
    bank_name: bank.bankName || null,
    last_four: bank.lastFourAccountNumber || bank.lastFour || null,
    connection_status: bank.status || null,
  };
};

async function loadPendingLegs(client, tenantId) {
  const rows = (await client.query(
    `SELECT amount_cents, status, leg_role
     FROM public.payment_transfers
     WHERE tenant_id = $1::uuid
       AND lower(status) IN ('pending','processing','submitted','queued','created')`,
    [tenantId],
  )).rows;
  let pendingIn = 0;
  let pendingOut = 0;
  for (const row of rows) {
    const cents = Number(row.amount_cents || 0);
    if (String(row.leg_role || '') === 'funding' || String(row.leg_role || '') === 'platform_refund') {
      pendingIn += cents;
    } else {
      pendingOut += cents;
    }
  }
  return { pendingIn, pendingOut };
}

async function localWallet(client, tenantId, walletType = 'operating') {
  return (await client.query(
    `SELECT id, tenant_id, wallet_type, name, currency, available_cents, pending_cents, status,
            last_synced_at, provider_wallet_id
     FROM public.payment_wallets
     WHERE tenant_id = $1::uuid AND provider = 'moov' AND environment = 'production' AND wallet_type = $2
     LIMIT 1`,
    [tenantId, walletType],
  )).rows[0] || null;
}

async function localLedger(client, walletId, limit = 50) {
  if (!walletId) return [];
  return (await client.query(
    `SELECT id, wallet_id, sub_ledger_id, direction, entry_type, amount_cents, balance_after_cents,
            claim_id, check_id, memo, created_at
     FROM public.payment_wallet_ledger
     WHERE wallet_id = $1::uuid
     ORDER BY created_at DESC NULLS LAST
     LIMIT $2`,
    [walletId, limit],
  )).rows;
}

export async function buildLiveSnapshot({ client, mapping, body, spoof, fetchImpl, deps = {} }) {
  const tenantId = claimedTenant(body);
  if (!tenantId || !isUuid(tenantId)) {
    return fail('invalid_uuid', 400, { field: 'tenant_id', spoofFieldsIgnored: spoof });
  }
  const access = await assertMoovTenantView(client, mapping, tenantId);
  if (!access.ok) return { ...access, spoofFieldsIgnored: spoof };

  const walletType = body?.wallet_type || 'operating';
  const merchant = await resolveProductionMerchant(client, tenantId);
  if (!merchant.ok) {
    const readiness = emptyReadiness('production');
    readiness.source = 'no_production_account';
    readiness.liveProviderCalled = false;
    return {
      ok: true,
      statusCode: 200,
      success: true,
      provider: 'moov',
      liveProviderCalled: false,
      productionExecution: false,
      kycRequested: false,
      capabilitiesPosted: false,
      setup_required: true,
      wallet: null,
      ledger: [],
      sub_ledgers: [],
      pending_in_cents: 0,
      pending_out_cents: 0,
      sweeps: [],
      sweep_config: null,
      settlement_method: null,
      available_push_rails: [],
      pull_available: false,
      verification: {
        account_verified: false,
        identity: null,
        tos_accepted: false,
        capabilities: [],
        banks: [],
        what_is_verified: [],
      },
      readiness,
      spoofFieldsIgnored: spoof,
    };
  }

  const loaded = await (deps.loadProductionSecrets || loadProductionMoovReadSecrets)(deps.getSecrets);
  if (!loaded.ok) return { ...loaded, spoofFieldsIgnored: spoof, kycRequested: false, capabilitiesPosted: false };

  let snapshot;
  let sweepConfigs = [];
  let sweepHistory = [];
  let walletRow = null;
  try {
    snapshot = await getApprovedAccountSnapshot({
      credentials: loaded.credentials,
      known: merchant,
      fetchImpl,
      includeSweeps: true,
      requiredCapabilities: [],
    });
    sweepConfigs = listOf(snapshot.sweepConfigs);
    const walletId = merchant.walletId || snapshot.resolvedWalletId;
    if (walletId) {
      walletRow = await productionMoovFetch({
        credentials: loaded.credentials,
        path: `/accounts/${merchant.moovAccountId}/wallets/${walletId}`,
        fetchImpl,
      }).catch(() => null);
      sweepHistory = listOf(await productionMoovFetch({
        credentials: loaded.credentials,
        path: `/accounts/${merchant.moovAccountId}/wallets/${walletId}/sweeps`,
        fetchImpl,
      }).catch(() => []));
    }
  } catch (error) {
    return fail('moov_preflight_failed', error.status || 502, {
      liveProviderCalled: true,
      message: error.message,
    });
  }

  const methods = await productionMoovFetch({
    credentials: loaded.credentials,
    path: `/accounts/${merchant.moovAccountId}/payment-methods`,
    fetchImpl,
  }).catch(() => []);

  const pending = await loadPendingLegs(client, tenantId);
  const local = await localWallet(client, tenantId, walletType);
  const availableCents = amountToCents(walletRow?.availableBalance);
  const moovPendingCents = amountToCents(walletRow?.pendingBalance);
  const matchedSweep = sweepConfigs.find((row) => (
    !merchant.walletId || String(row.walletID || row.walletId || '') === merchant.walletId
  )) || sweepConfigs[0] || null;

  const banks = snapshot.banks || [];
  const capList = (snapshot.capabilities || []).map((row) => ({
    capability: row.capability,
    status: row.status,
  }));
  const readiness = evaluateReadiness({
    environment: 'production',
    accountId: merchant.moovAccountId,
    capabilities: capList,
    banks: banks.map((bank) => ({ status: bank.status })),
    verificationStatus: snapshot.verification,
    disabled: snapshot.disabled,
    termsAccepted: snapshot.tosAccepted === true,
    feePlanCode: null,
    feePlanUnavailable: true,
  });
  readiness.source = 'live_provider';
  readiness.liveProviderCalled = true;
  readiness.isSandbox = false;

  const verifiedBanks = banks.filter((bank) => String(bank.status || '').toLowerCase() === 'verified');
  const wallet = {
    id: local?.id || merchant.walletId || snapshot.resolvedWalletId,
    tenant_id: tenantId,
    wallet_type: walletType,
    name: local?.name || 'Operating wallet',
    currency: 'USD',
    available_cents: availableCents,
    pending_cents: moovPendingCents,
    status: walletRow?.status || local?.status || (snapshot.verified ? 'active' : 'pending'),
    last_synced_at: new Date().toISOString(),
    provider_wallet_id: merchant.walletId || snapshot.resolvedWalletId,
  };

  return {
    ok: true,
    statusCode: 200,
    success: true,
    provider: 'moov',
    liveProviderCalled: true,
    productionExecution: false,
    kycRequested: false,
    capabilitiesPosted: false,
    setup_required: false,
    wallet,
    ledger: await localLedger(client, local?.id, Number(body?.ledger_limit) || 50),
    sub_ledgers: [],
    pending_in_cents: pending.pendingIn,
    pending_out_cents: pending.pendingOut,
    moov_pending_cents: moovPendingCents,
    sweeps: sweepHistory,
    sweep_config: matchedSweep ? {
      ...normalizeSweepConfig(matchedSweep),
      tenant_id: tenantId,
      push_rail: listOf(methods).find((row) => (
        (row.paymentMethodID || row.paymentMethodId)
        === (matchedSweep.pushPaymentMethodID || matchedSweep.pushPaymentMethodId)
      ))?.paymentMethodType || null,
    } : null,
    settlement_method: settlementFromBanks(banks, methods),
    available_push_rails: railsFromMethods(methods),
    pull_available: listOf(methods).some((row) => String(row.paymentMethodType) === 'ach-debit-fund'),
    verification: {
      account_verified: snapshot.verified === true,
      identity: snapshot.verification,
      tos_accepted: snapshot.tosAccepted === true,
      disabled: snapshot.disabled === true,
      capabilities: capList,
      banks,
      payment_methods: listOf(methods).map((row) => ({
        payment_method_id: row.paymentMethodID || row.paymentMethodId || null,
        type: row.paymentMethodType || null,
        bank_account_id: row.bankAccountID || row.bankAccount?.bankAccountID || null,
        wallet_id: row.walletID || row.wallet?.walletID || null,
      })),
      what_is_verified: [
        snapshot.verified ? 'Moov identity / business' : null,
        snapshot.tosAccepted ? 'Moov terms of service' : null,
        verifiedBanks.length
          ? verifiedBanks.map((bank) => `${bank.bankName || 'Bank'} ••••${bank.lastFour || '----'}`).join(', ')
          : null,
      ].filter(Boolean),
    },
    readiness,
    spoofFieldsIgnored: spoof,
  };
}

export async function handleProductionMoovWalletStatus(ctx) {
  const snapshot = await buildLiveSnapshot(ctx);
  if (snapshot.ok === false) return snapshot;
  return { ...snapshot, operation: 'wallet.status' };
}

export async function handleProductionMoovReadiness(ctx) {
  const snapshot = await buildLiveSnapshot(ctx);
  if (snapshot.ok === false) return snapshot;
  return {
    ok: true,
    statusCode: 200,
    success: true,
    provider: 'moov',
    operation: 'moov-readiness',
    liveProviderCalled: snapshot.liveProviderCalled === true,
    productionExecution: false,
    kycRequested: false,
    capabilitiesPosted: false,
    readiness: snapshot.readiness,
    verification: snapshot.verification,
    settlement_method: snapshot.settlement_method,
    spoofFieldsIgnored: snapshot.spoofFieldsIgnored,
  };
}

export async function handleProductionMoovWalletSync(ctx) {
  const snapshot = await buildLiveSnapshot(ctx);
  if (snapshot.ok === false) return snapshot;
  return {
    ok: true,
    statusCode: 200,
    success: true,
    provider: 'moov',
    operation: 'wallet.sync',
    liveProviderCalled: snapshot.liveProviderCalled === true,
    productionExecution: false,
    kycRequested: false,
    capabilitiesPosted: false,
    wallet: snapshot.wallet,
    ledger: snapshot.ledger,
    sub_ledgers: snapshot.sub_ledgers,
    setup_required: snapshot.setup_required === true,
    spoofFieldsIgnored: snapshot.spoofFieldsIgnored,
  };
}
