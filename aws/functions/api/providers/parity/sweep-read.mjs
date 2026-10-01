/**
 * Read-only WalletOps sweep snapshot.
 *
 * Normalizes the live Moov sweep-config payload (nested payment-method objects)
 * into the existing frontend contract:
 *   { settlement_method, sweep_config, available_push_rails, pull_available, wallet }
 *
 * GET only. Never creates, updates, disables, or deletes a sweep.
 * Never posts a wallet or transfer.
 */

import { MoovError, moovFetch, scopes } from './moov-client.mjs';
import { loadMoovAccount } from './db.mjs';
import { readWallet } from './moov-wallet.mjs';
import { failClosedMissingAccount, requireMoovProviderEnvironment } from './moov-provider-env.mjs';

export const SWEEP_PUSH_RAIL_PREFERENCE = [
  'instant-bank-credit',
  'rtp-credit',
  'ach-credit-same-day',
  'ach-credit-standard',
];

export const SWEEP_PULL_RAIL = 'ach-debit-fund';

export function paymentMethodIdOf(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  return value.paymentMethodID ?? value.paymentMethodId ?? value.id ?? null;
}

export function paymentMethodTypeOf(value) {
  if (!value || typeof value !== 'object') return null;
  return value.paymentMethodType ?? value.paymentMethod_type ?? value.type ?? null;
}

export function unwrapSweepConfigs(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.sweepConfigs)) return data.sweepConfigs;
  if (Array.isArray(data?.configs)) return data.configs;
  if (data?.sweepConfigID || data?.sweepConfigId) return [data];
  return [];
}

export function minimumBalanceToCents(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'object') {
    if (value.valueDecimal !== undefined) return Math.round(Number(value.valueDecimal) * 100) || 0;
    if (value.value !== undefined) return Math.round(Number(value.value)) || 0;
    return 0;
  }
  const n = Number(String(value).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

export function availablePushRails(src) {
  const map = src?.railPaymentMethodIds && typeof src.railPaymentMethodIds === 'object'
    ? src.railPaymentMethodIds
    : {};
  return SWEEP_PUSH_RAIL_PREFERENCE.filter((rail) => !!map[rail]);
}

export function pickSettlementMethod(methods) {
  const list = methods ?? [];
  if (!list.length) return null;
  const connected = (m) => {
    const connection = String(m.connection_status ?? '').toLowerCase();
    const verification = String(m.verification_status ?? '').toLowerCase();
    return connection === 'connected' || ['verified', 'successful'].includes(verification);
  };
  const rank = (m) => (connected(m) ? 2 : 0) + (m.is_default ? 1 : 0);
  return [...list].sort((a, b) => rank(b) - rank(a))[0] ?? null;
}

export function railTypeFor(railMap, paymentMethodId, hintedType = null) {
  if (hintedType && SWEEP_PUSH_RAIL_PREFERENCE.includes(hintedType)) return hintedType;
  if (!paymentMethodId) return hintedType && hintedType !== SWEEP_PULL_RAIL ? hintedType : null;
  for (const [rail, id] of Object.entries(railMap || {})) {
    if (id === paymentMethodId) return rail;
  }
  return hintedType && hintedType !== SWEEP_PULL_RAIL ? hintedType : null;
}

export function bankFromPaymentMethod(method) {
  const bank = method?.bankAccount ?? method?.bank_account ?? null;
  if (!bank && !method) return null;
  const bankName = bank?.bankName ?? bank?.bank_name ?? method?.bank_name ?? null;
  const lastFour = bank?.lastFourAccountNumber
    ?? bank?.lastFour
    ?? bank?.last_four
    ?? method?.last_four
    ?? null;
  if (!bankName && !lastFour) return null;
  return { bank_name: bankName ?? null, last_four: lastFour ?? null };
}

export function railsFromPaymentMethods(methods, bankAccountId = null) {
  const out = {};
  for (const method of methods ?? []) {
    const type = paymentMethodTypeOf(method);
    const id = paymentMethodIdOf(method);
    if (!type || !id) continue;
    const owner = method?.bankAccount?.bankAccountID
      ?? method?.bankAccount?.bankAccountId
      ?? method?.provider_bank_account_id
      ?? null;
    if (bankAccountId && owner && owner !== bankAccountId) continue;
    out[type] = id;
  }
  return out;
}

export function matchSweepForWallet(configs, walletId) {
  if (!Array.isArray(configs) || !configs.length) return null;
  if (!walletId) return configs[0] ?? null;
  return configs.find((cfg) => (
    (cfg.walletID ?? cfg.walletId ?? cfg.provider_wallet_id) === walletId
  )) ?? configs[0] ?? null;
}

export function normalizeSweepConfig(cfg, { tenantId, railMap = {}, walletId = null } = {}) {
  if (!cfg) return null;
  const id = cfg.sweepConfigID ?? cfg.sweepConfigId ?? cfg.provider_sweep_config_id ?? cfg.id ?? null;
  const push = cfg.pushPaymentMethod ?? cfg.push_payment_method ?? null;
  const pull = cfg.pullPaymentMethod ?? cfg.pull_payment_method ?? null;
  const pushId = paymentMethodIdOf(cfg.pushPaymentMethodID ?? cfg.pushPaymentMethodId ?? push);
  const pullId = paymentMethodIdOf(cfg.pullPaymentMethodID ?? cfg.pullPaymentMethodId ?? pull);
  const pushRail = railTypeFor(railMap, pushId, paymentMethodTypeOf(push));
  return {
    id,
    tenant_id: tenantId ?? null,
    status: String(cfg.status ?? 'disabled').toLowerCase() === 'enabled' ? 'enabled' : 'disabled',
    provider_sweep_config_id: id,
    provider_wallet_id: cfg.walletID ?? cfg.walletId ?? walletId ?? null,
    push_payment_method_id: pushId,
    push_rail: pushRail,
    pull_payment_method_id: pullId,
    pull_rail: pullId ? SWEEP_PULL_RAIL : null,
    minimum_balance_cents: minimumBalanceToCents(cfg.minimumBalance ?? cfg.minimum_balance),
    statement_descriptor: cfg.statementDescriptor ?? cfg.statement_descriptor ?? null,
    last_synced_at: new Date().toISOString(),
    provider_created_at: cfg.createdOn ?? cfg.created_on ?? null,
    provider_updated_at: cfg.updatedOn ?? cfg.updated_on ?? null,
  };
}

export function settlementFromSources({ localMethod, sweepCfg, paymentMethods }) {
  if (localMethod) {
    return {
      id: localMethod.id,
      bank_name: localMethod.bank_name ?? null,
      last_four: localMethod.last_four ?? null,
      connection_status: localMethod.connection_status ?? 'connected',
    };
  }
  const fromSweep = bankFromPaymentMethod(sweepCfg?.pushPaymentMethod ?? sweepCfg?.push_payment_method);
  if (fromSweep) {
    return {
      id: paymentMethodIdOf(sweepCfg.pushPaymentMethod ?? sweepCfg.push_payment_method),
      bank_name: fromSweep.bank_name,
      last_four: fromSweep.last_four,
      connection_status: 'connected',
    };
  }
  const pushId = paymentMethodIdOf(
    sweepCfg?.pushPaymentMethodID ?? sweepCfg?.pushPaymentMethod ?? sweepCfg?.push_payment_method,
  );
  const match = (paymentMethods ?? []).find((m) => paymentMethodIdOf(m) === pushId);
  const fromList = bankFromPaymentMethod(match);
  if (fromList) {
    return {
      id: paymentMethodIdOf(match),
      bank_name: fromList.bank_name,
      last_four: fromList.last_four,
      connection_status: 'connected',
    };
  }
  return null;
}

export function buildSweepSnapshot({
  tenantId,
  walletType = 'operating',
  wallet = null,
  sweepCfg = null,
  localMethods = [],
  paymentMethods = [],
}) {
  const localMethod = pickSettlementMethod(localMethods);
  const bankAccountId = localMethod?.provider_bank_account_id
    ?? sweepCfg?.pushPaymentMethod?.bankAccount?.bankAccountID
    ?? sweepCfg?.pushPaymentMethod?.bankAccount?.bankAccountId
    ?? null;
  const railMap = {
    ...(typeof localMethod?.rail_payment_method_ids === 'object' ? localMethod.rail_payment_method_ids : {}),
    ...railsFromPaymentMethods(paymentMethods, bankAccountId),
  };
  const config = normalizeSweepConfig(sweepCfg, {
    tenantId,
    railMap,
    walletId: wallet?.provider_wallet_id ?? null,
  });
  if (config?.push_payment_method_id && !railMap[config.push_rail]) {
    railMap[config.push_rail || 'ach-credit-standard'] = config.push_payment_method_id;
  }
  if (config?.pull_payment_method_id) {
    railMap[SWEEP_PULL_RAIL] = config.pull_payment_method_id;
  }
  const pushRails = availablePushRails({ railPaymentMethodIds: railMap });
  return {
    wallet: wallet
      ? {
        id: wallet.id ?? wallet.provider_wallet_id ?? null,
        available_cents: Number(wallet.available_cents ?? 0),
        pending_cents: Number(wallet.pending_cents ?? 0),
        status: wallet.status ?? 'active',
        wallet_type: walletType,
      }
      : null,
    settlement_method: settlementFromSources({ localMethod, sweepCfg, paymentMethods }),
    available_push_rails: pushRails,
    pull_available: Boolean(config?.pull_payment_method_id || railMap[SWEEP_PULL_RAIL]),
    sweep_config: config,
    stale: false,
  };
}

async function loadLocalMethods(client, tenantId, environment) {
  return (await client.query(
    `SELECT id, provider_payment_method_id, provider_bank_account_id, bank_name, last_four,
            is_default, connection_status, verification_status, supported_rails,
            rail_payment_method_ids, rails_synced_at
     FROM public.payment_provider_methods
     WHERE tenant_id = $1::uuid AND provider = 'moov' AND environment = $2
       AND external_recipient_id IS NULL
     ORDER BY is_default DESC NULLS LAST, created_at DESC NULLS LAST`,
    [tenantId, environment],
  )).rows;
}

async function readOnlyMoovGet(path, scopesForPath, fetchImpl) {
  try {
    return await moovFetch(path, { scopes: scopesForPath, fetchImpl });
  } catch (error) {
    if (error instanceof MoovError && (error.status === 403 || error.status === 404)) return null;
    throw error;
  }
}

export async function readSweepSnapshot({
  client,
  tenantId,
  accountId,
  environment,
  walletType = 'operating',
  fetchImpl,
}) {
  const wallet = await readWallet(client, tenantId, environment, walletType);
  const localMethods = await loadLocalMethods(client, tenantId, environment);
  const configs = unwrapSweepConfigs(
    await readOnlyMoovGet(
      `/accounts/${accountId}/sweep-configs`,
      [`/accounts/${accountId}/wallets.read`],
      fetchImpl,
    ),
  );
  const paymentMethods = await readOnlyMoovGet(
    `/accounts/${accountId}/payment-methods`,
    scopes.paymentMethodsRead(accountId),
    fetchImpl,
  );
  const sweepCfg = matchSweepForWallet(configs, wallet?.provider_wallet_id);
  return buildSweepSnapshot({
    tenantId,
    walletType,
    wallet,
    sweepCfg,
    localMethods,
    paymentMethods: Array.isArray(paymentMethods) ? paymentMethods : [],
  });
}

export function normalizeSweepHistoryRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    ...row,
    sweepID: row.sweepID ?? row.sweepId ?? null,
    transferID: row.transferID ?? row.transferId ?? null,
    transferAmount: row.transferAmount ?? row.transfer_amount ?? row.accruedAmount ?? null,
    createdOn: row.createdOn ?? row.accrualStartedOn ?? null,
    completedOn: row.completedOn ?? row.accrualEndedOn ?? null,
  }));
}

export async function readSweepHistory({ accountId, walletId, fetchImpl }) {
  if (!walletId) return { sweeps: [], historyUnavailable: true };
  try {
    const data = await moovFetch(
      `/accounts/${accountId}/wallets/${encodeURIComponent(walletId)}/sweeps?count=50`,
      { scopes: [`/accounts/${accountId}/wallets.read`], fetchImpl },
    );
    const sweeps = normalizeSweepHistoryRows(
      Array.isArray(data) ? data : (Array.isArray(data?.sweeps) ? data.sweeps : []),
    );
    return { sweeps, historyUnavailable: false };
  } catch (error) {
    if (error instanceof MoovError && error.status === 403) {
      return { sweeps: [], historyUnavailable: true };
    }
    return { sweeps: [], historyUnavailable: true };
  }
}

export async function resolveSweepAccount({ client, ctx }) {
  const envRes = requireMoovProviderEnvironment(ctx);
  if (!envRes.ok) return envRes;
  const account = await loadMoovAccount(client, ctx.tenantId, envRes.environment);
  const missing = failClosedMissingAccount(account, envRes.environment);
  if (missing) return { ok: false, ...missing };
  return { ok: true, environment: envRes.environment, account };
}
