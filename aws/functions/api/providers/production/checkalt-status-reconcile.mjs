import pg from 'pg';
import { parseBody, ignoredSpoof } from '../../data.mjs';
import { loadDatabaseCredentials } from '../../secrets.mjs';
import { buildWriteClientConfig, sanitizePublicError } from '../../db-health.mjs';
import { loadProductionCheckAltConfig, loadProductionTenantAccount } from './checkalt-config.mjs';
import { loadProductionCheckAltSecrets } from './checkalt-secrets.mjs';
import {
  checkaltStatusReconcileEnabled,
  productionCheckAltExecutionAllowed,
} from './checkalt-holds.mjs';
import {
  CHECKALT_STATUS_REFRESH_STATUSES,
  loadDepositsForStatusRefresh,
  reconcileProductionCheckAltDeposit,
} from './checkalt-poll.mjs';

const { Client } = pg;

const PROCESS_PATH = '/fincapture/deposit/process';
const APPROVE_PATH = '/fincapture/deposit/approve';

export const checkAltStatusReconcileJobName = 'checkalt-poll-deposits';

export const statusReconcileDisabled = (spoof, extra = {}) => ({
  ok: false,
  statusCode: 403,
  error: 'checkalt_status_reconcile_disabled',
  message: 'CheckAlt status reconciliation stays disabled until separately authorized. It does not enable other financial jobs.',
  liveProviderCalled: false,
  createdDeposit: false,
  approvePosted: false,
  submitPosted: false,
  moneyMoved: false,
  spoofFieldsIgnored: spoof,
  ...extra,
});

const guardedFetch = (fetchImpl) => async (url, options = {}) => {
  const target = String(url || '');
  if (target.includes(PROCESS_PATH) || target.includes(APPROVE_PATH)) {
    throw new Error('status_reconcile_refused_money_path');
  }
  return fetchImpl(url, options);
};

export async function runCheckAltStatusReconcile({
  client,
  fetchImpl = fetch,
  deps = {},
  limit = 50,
  tenantIds = null,
} = {}) {
  const ids = tenantIds && tenantIds.length
    ? tenantIds
    : (await client.query(
      `SELECT DISTINCT tenant_id /* status_refresh_tenants */
       FROM public.checkalt_deposits
       WHERE status = ANY($1::text[])
         AND checkalt_reference IS NOT NULL`,
      [CHECKALT_STATUS_REFRESH_STATUSES],
    )).rows.map((row) => row.tenant_id);
  const rows = await loadDepositsForStatusRefresh(client, { tenantIds: ids, limit });
  const secrets = await (deps.loadProductionSecrets || loadProductionCheckAltSecrets)(deps.getSecrets);
  if (!secrets.ok) {
    return {
      ok: false,
      statusCode: secrets.statusCode || 503,
      error: secrets.error || 'production_secret_missing',
      polled: 0,
      updated: 0,
      errors: 0,
      liveProviderCalled: false,
      submitPosted: false,
      approvePosted: false,
      moneyMoved: false,
    };
  }
  const loadedCfg = await loadProductionCheckAltConfig(client, { credentials: secrets.credentials });
  if (!loadedCfg.ok) {
    return {
      ...loadedCfg,
      polled: 0,
      updated: 0,
      errors: 0,
      submitPosted: false,
      approvePosted: false,
      moneyMoved: false,
    };
  }

  const safeFetch = guardedFetch(fetchImpl);
  let polled = 0;
  let updated = 0;
  let errors = 0;
  const acctCache = new Map();
  for (const row of rows) {
    let acct = acctCache.get(row.tenant_id);
    if (!acct) {
      acct = await loadProductionTenantAccount(client, row.tenant_id);
      acctCache.set(row.tenant_id, acct);
    }
    try {
      const result = await reconcileProductionCheckAltDeposit({
        client,
        mapping: { application_user_id: null },
        row,
        cfg: loadedCfg.cfg,
        credentials: loadedCfg.credentials,
        acct,
        fetchImpl: safeFetch,
      });
      polled += 1;
      if (result.reconciled) updated += 1;
      else errors += 1;
    } catch {
      errors += 1;
    }
  }
  return {
    ok: true,
    statusCode: 200,
    success: true,
    job: checkAltStatusReconcileJobName,
    polled,
    updated,
    errors,
    liveProviderCalled: polled > 0,
    createdDeposit: false,
    submitPosted: false,
    approvePosted: false,
    moneyMoved: false,
    productionExecution: true,
    productionRecordsMutated: updated > 0,
  };
}

export async function handleCheckAltStatusReconcileJob(event, deps = {}) {
  const spoof = ignoredSpoof(event, parseBody(event));
  if (!checkaltStatusReconcileEnabled()) return statusReconcileDisabled(spoof);
  if (!productionCheckAltExecutionAllowed()) {
    return {
      ok: false,
      statusCode: 403,
      error: 'production_execution_blocked',
      message: 'CheckAlt status reconciliation requires production CheckAlt holds to be lifted. Status-only; no submit/approve.',
      liveProviderCalled: false,
      submitPosted: false,
      approvePosted: false,
      moneyMoved: false,
      spoofFieldsIgnored: spoof,
    };
  }

  const body = parseBody(event);
  const createClient = deps.createClient || ((config) => new Client(config));
  const loadCredentials = deps.loadDatabaseCredentials || loadDatabaseCredentials;
  let client;
  try {
    client = deps.createClient
      ? createClient({})
      : createClient(buildWriteClientConfig(await loadCredentials(), { queryTimeoutMillis: 20000 }));
    if (client.connect) await client.connect();
    if (typeof client.query === 'function') {
      try {
        await client.query('BEGIN');
        await client.query('SET TRANSACTION READ WRITE');
      } catch { /* mock clients may ignore */ }
    }
    const result = await runCheckAltStatusReconcile({
      client,
      fetchImpl: deps.fetchImpl || fetch,
      deps,
      limit: body.limit,
    });
    try { await client.query('COMMIT'); } catch { /* mock */ }
    return { ...result, spoofFieldsIgnored: spoof };
  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    }
    return {
      ok: false,
      statusCode: 503,
      error: 'status_reconcile_failed',
      message: sanitizePublicError(error),
      liveProviderCalled: false,
      submitPosted: false,
      approvePosted: false,
      moneyMoved: false,
      spoofFieldsIgnored: spoof,
    };
  } finally {
    if (client?.end) {
      try { await client.end(); } catch { /* ignore */ }
    }
  }
}
