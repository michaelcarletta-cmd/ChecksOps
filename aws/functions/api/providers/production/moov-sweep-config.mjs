import { isUuid } from '../../financial-ownership.mjs';
import { FINANCIAL_ROLES, roleAllowsFinancial } from '../../financial-authz.mjs';
import { assertMoovTenantAccess, loadTenantRole } from './moov-authz.mjs';
import { productionMoovExecutionAllowed } from './moov-holds.mjs';
import { listOf, productionMoovFetch } from './moov-http.mjs';
import { buildLiveSnapshot } from './moov-live-read.mjs';
import { loadProductionMoovReadSecrets } from './moov-secrets.mjs';
import { resolveProductionMerchant } from './moov-parties.mjs';

const READ_ACTIONS = new Set(['get', 'list', 'sweeps']);

const fail = (error, statusCode, extra = {}) => ({
  ok: false,
  statusCode,
  error,
  provider: 'moov',
  operation: 'sweep.config',
  liveProviderCalled: extra.liveProviderCalled === true,
  productionExecution: extra.productionExecution === true,
  kycRequested: false,
  capabilitiesPosted: false,
  ...extra,
});

const claimedTenant = (body) => body?.tenant_id || body?.tenantId || null;
const methodId = (row) => row?.paymentMethodID || row?.paymentMethodId || null;

const pickPushMethod = (methods, preferredRail) => {
  const list = listOf(methods);
  if (preferredRail) {
    const match = list.find((row) => String(row.paymentMethodType) === String(preferredRail));
    if (match) return match;
  }
  return list.find((row) => String(row.paymentMethodType) === 'ach-credit-standard')
    || list.find((row) => String(row.paymentMethodType || '').startsWith('ach-credit'))
    || list.find((row) => String(row.paymentMethodType) === 'rtp-credit')
    || list.find((row) => String(row.paymentMethodType) === 'instant-bank-credit')
    || null;
};

const snapshotResponse = (snapshot, extra = {}) => ({
  ok: true,
  statusCode: 200,
  success: true,
  provider: 'moov',
  operation: 'sweep.config',
  liveProviderCalled: snapshot.liveProviderCalled === true,
  productionExecution: extra.productionExecution === true,
  kycRequested: false,
  capabilitiesPosted: false,
  wallet: snapshot.wallet,
  settlement_method: snapshot.settlement_method,
  available_push_rails: snapshot.available_push_rails,
  pull_available: snapshot.pull_available,
  sweep_config: snapshot.sweep_config,
  sweeps: snapshot.sweeps,
  stale: extra.stale === true,
  spoofFieldsIgnored: snapshot.spoofFieldsIgnored,
});

export async function handleProductionMoovSweepConfig({
  client,
  mapping,
  body,
  spoof,
  fetchImpl,
  deps = {},
}) {
  const tenantId = claimedTenant(body);
  if (!tenantId || !isUuid(tenantId)) {
    return fail('invalid_uuid', 400, { field: 'tenant_id', spoofFieldsIgnored: spoof });
  }
  const action = String(body?.action || 'get').toLowerCase();
  if (!['get', 'list', 'sweeps', 'create', 'update', 'disable'].includes(action)) {
    return fail('unknown_sweep_action', 400, { message: 'Unknown sweep action.' });
  }

  if (READ_ACTIONS.has(action)) {
    const snapshot = await buildLiveSnapshot({ client, mapping, body, spoof, fetchImpl, deps });
    if (snapshot.ok === false) return snapshot;
    if (action === 'sweeps') {
      return {
        ok: true,
        statusCode: 200,
        success: true,
        provider: 'moov',
        operation: 'sweep.config',
        liveProviderCalled: snapshot.liveProviderCalled === true,
        productionExecution: false,
        kycRequested: false,
        capabilitiesPosted: false,
        sweeps: snapshot.sweeps,
        spoofFieldsIgnored: snapshot.spoofFieldsIgnored,
      };
    }
    return snapshotResponse(snapshot);
  }

  if (!productionMoovExecutionAllowed()) {
    return fail('production_execution_blocked', 403, {
      message: 'Sweep create/update stays dark until money flags are lifted. GET is available with live reads.',
    });
  }

  const access = await assertMoovTenantAccess(client, mapping, tenantId);
  if (!access.ok) return { ...access, spoofFieldsIgnored: spoof, operation: 'sweep.config' };
  const roles = await loadTenantRole(client, mapping.application_user_id, tenantId);
  if (!roleAllowsFinancial(roles) && !roles.some((role) => FINANCIAL_ROLES.has(role))) {
    return fail('financial_role_required', 403, {
      message: 'Only a tenant owner, admin, or manager can change sweeps.',
    });
  }

  const minimumCents = Number(body?.minimum_balance_cents);
  const enabling = action !== 'disable' && String(body?.status || 'enabled') !== 'disabled';
  if (enabling && (!Number.isInteger(minimumCents) || minimumCents < 0)) {
    return fail('invalid_sweep_minimum', 400, {
      message: 'minimum_balance_cents must be a non-negative integer. $0.00 keeps nothing in the wallet and auto-pushes the full available balance to the settlement bank.',
    });
  }

  const merchant = await resolveProductionMerchant(client, tenantId);
  if (!merchant.ok) return { ...merchant, spoofFieldsIgnored: spoof, operation: 'sweep.config' };

  const loaded = await (deps.loadProductionSecrets || loadProductionMoovReadSecrets)(deps.getSecrets);
  if (!loaded.ok) return { ...loaded, spoofFieldsIgnored: spoof, kycRequested: false, capabilitiesPosted: false };

  const methods = await productionMoovFetch({
    credentials: loaded.credentials,
    path: `/accounts/${merchant.moovAccountId}/payment-methods`,
    fetchImpl,
  }).catch(() => []);
  const configs = listOf(await productionMoovFetch({
    credentials: loaded.credentials,
    path: `/accounts/${merchant.moovAccountId}/sweep-configs`,
    fetchImpl,
  }).catch(() => []));
  const existing = configs.find((row) => (
    !merchant.walletId || String(row.walletID || row.walletId || '') === merchant.walletId
  )) || configs[0] || null;

  if (action === 'disable') {
    const id = body?.sweep_config_id || existing?.sweepConfigID || existing?.sweepConfigId;
    if (!id) return fail('sweep_not_configured', 404, { message: 'There is no sweep to turn off.' });
    await productionMoovFetch({
      credentials: loaded.credentials,
      path: `/accounts/${merchant.moovAccountId}/sweep-configs/${id}`,
      method: 'PATCH',
      allowSweepWrite: true,
      fetchImpl,
      body: { status: 'disabled' },
    });
    const snapshot = await buildLiveSnapshot({ client, mapping, body, spoof, fetchImpl, deps });
    if (snapshot.ok === false) return snapshot;
    return snapshotResponse(snapshot, { productionExecution: true });
  }

  const push = pickPushMethod(methods, body?.push_rail);
  if (!push) {
    return fail('sweep_push_method_missing', 409, {
      liveProviderCalled: true,
      message: 'Connect and verify a settlement bank before turning on sweeps.',
    });
  }
  const pull = body?.enable_pull === false
    ? null
    : listOf(methods).find((row) => String(row.paymentMethodType) === 'ach-debit-fund');
  const walletId = merchant.walletId;
  if (!walletId) {
    return fail('wallet_missing', 409, { message: 'No Moov wallet is linked. Do not POST /wallets.' });
  }

  const payload = {
    walletID: walletId,
    status: enabling ? 'enabled' : 'disabled',
    pushPaymentMethodID: methodId(push),
    pullPaymentMethodID: pull ? methodId(pull) : null,
    minimumBalance: { currency: 'USD', value: Number((minimumCents / 100).toFixed(2)) },
    statementDescriptor: body?.statement_descriptor || 'CHECKOPS',
  };

  if (action === 'create' && !existing) {
    await productionMoovFetch({
      credentials: loaded.credentials,
      path: `/accounts/${merchant.moovAccountId}/sweep-configs`,
      method: 'POST',
      allowSweepWrite: true,
      fetchImpl,
      body: payload,
    });
  } else {
    const id = body?.sweep_config_id || existing?.sweepConfigID || existing?.sweepConfigId;
    if (!id) return fail('sweep_not_configured', 404, { message: 'No sweep is configured yet.' });
    await productionMoovFetch({
      credentials: loaded.credentials,
      path: `/accounts/${merchant.moovAccountId}/sweep-configs/${id}`,
      method: 'PATCH',
      allowSweepWrite: true,
      fetchImpl,
      body: payload,
    });
  }

  const snapshot = await buildLiveSnapshot({ client, mapping, body, spoof, fetchImpl, deps });
  if (snapshot.ok === false) return snapshot;
  return snapshotResponse(snapshot, { productionExecution: true });
}
