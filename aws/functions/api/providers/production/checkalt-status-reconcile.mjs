import pg from 'pg';
import { parseBody, ignoredSpoof } from '../../data.mjs';
import { loadDatabaseCredentials } from '../../secrets.mjs';
import { buildWriteClientConfig, sanitizePublicError } from '../../db-health.mjs';
import { loadProductionCheckAltConfig, loadProductionTenantAccount } from './checkalt-config.mjs';
import { loadProductionCheckAltSecrets } from './checkalt-secrets.mjs';
import { checkaltStatusReconcileEnabled } from './checkalt-holds.mjs';
import { statusReadOnlyFetch } from './checkalt-status-read.mjs';
import {
  CHECKALT_STATUS_REFRESH_STATUSES,
  batchDepositSummary,
  bindStatusRefreshGucs,
  loadDepositsForStatusRefresh,
  refreshDepositRow,
} from './checkalt-poll.mjs';

const { Client } = pg;

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The scheduled job has no Cognito caller, and every checkalt_deposits read
 * and write is under row security (SET ROLE checksops; aws_can_access_tenant
 * needs request.app_user_id). It therefore runs as one reviewed actor: the
 * platform-owner application user id written into the schedule definition
 * (aws/production/checkalt-status-reconcile-schedule.yaml). The job refuses
 * to call Check Alt unless public.is_platform_owner() is true for that id.
 */
export const scheduledActorOf = (event = {}, body = {}) => {
  const raw = event?.actor_application_user_id ?? body?.actor_application_user_id ?? null;
  return typeof raw === 'string' && UUID_RE.test(raw) ? raw : null;
};

export async function bindScheduledActor(client, actorId) {
  if (!actorId) return { ok: false, error: 'scheduled_actor_required' };
  const mode = await bindStatusRefreshGucs(client, { application_user_id: actorId, email: '' }, {});
  const owner = (await client.query('SELECT public.is_platform_owner() AS ok')).rows[0]?.ok === true;
  if (!owner) return { ok: false, error: 'scheduled_actor_not_platform_owner' };
  return { ok: true, mode };
}

export async function runCheckAltStatusReconcile({
  client,
  fetchImpl = fetch,
  deps = {},
  limit = 50,
  tenantIds = null,
  actorId = null,
} = {}) {
  const actor = await bindScheduledActor(client, actorId);
  if (!actor.ok) {
    return {
      ok: false,
      statusCode: 403,
      error: actor.error,
      message: 'The scheduled Check Alt status job runs only as the reviewed platform-owner actor named in its schedule. Nothing was read from Check Alt.',
      polled: 0,
      updated: 0,
      errors: 0,
      liveProviderCalled: false,
      submitPosted: false,
      approvePosted: false,
      moneyMoved: false,
    };
  }
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

  const safeFetch = statusReadOnlyFetch(fetchImpl);
  let polled = 0;
  let updated = 0;
  let errors = 0;
  const deposits = [];
  const acctCache = new Map();
  for (const row of rows) {
    let acct = acctCache.get(row.tenant_id);
    if (!acct) {
      acct = await loadProductionTenantAccount(client, row.tenant_id);
      acctCache.set(row.tenant_id, acct);
    }
    const previousStatus = row.status;
    try {
      // Own savepoint per row: one failure cannot abort the other rows.
      const result = await refreshDepositRow({
        client,
        mapping: { application_user_id: actorId },
        row,
        cfg: loadedCfg.cfg,
        credentials: loadedCfg.credentials,
        acct,
        fetchImpl: safeFetch,
      });
      polled += 1;
      if (result.reconciled) updated += 1;
      else errors += 1;
      deposits.push(batchDepositSummary(row, result, previousStatus));
    } catch {
      errors += 1;
      deposits.push({ deposit_id: row.id, status: previousStatus, previous_status: previousStatus, reconciled: false });
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
    deposits,
    database_session: actor.mode,
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
      actorId: scheduledActorOf(event, body),
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
