import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LOOKUP_MAPPING_SQL, TENANT_MEMBERSHIP_SQL } from '../functions/api/identity.mjs';
import { handleProviderRequest } from '../functions/api/providers.mjs';
import {
  productionCheckAltExecutionAllowed,
  checkaltStatusReconcileEnabled,
} from '../functions/api/providers/production/checkalt-holds.mjs';
import {
  checkaltStatusReadAllowed,
  checkaltStatusReadOnlyMode,
  statusReadOnlyFetch,
  isCheckAltStatusReadPath,
} from '../functions/api/providers/production/checkalt-status-read.mjs';
import { persistStatusReadOutcome } from '../functions/api/providers/production/checkalt-idempotency.mjs';
import { handleCheckAltStatusReconcileJob } from '../functions/api/providers/production/checkalt-status-reconcile.mjs';
import {
  applyCheckAltSettlementInvariant,
  resolveCheckAltProviderStatus,
} from '../functions/api/providers/amounts.mjs';

const FREEDOM_APP = 'abd3c2a0-6dc0-4686-92dd-a013e1141c91';
const FREEDOM_TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const CHECK_ID = '44444444-4444-4444-8444-444444444444';
const DEPOSIT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const jwtEvent = (pathName, method, body) => ({
  rawPath: pathName,
  headers: { authorization: 'Bearer test-id-token' },
  body: body ? JSON.stringify(body) : undefined,
  requestContext: {
    stage: 'staging',
    http: { method, path: pathName },
    authorizer: {
      jwt: { claims: { sub: COGNITO_SUB, email: 'owner@freedomadj.com', token_use: 'id' } },
    },
  },
});

const mapping = {
  application_user_id: FREEDOM_APP,
  cognito_sub: COGNITO_SUB,
  email: 'owner@freedomadj.com',
  status: 'active',
};

const withEnv = async (vars, fn) => {
  const previous = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const statusReadOnlyFlags = {
  AWS_CHECKALT_STATUS_RECONCILE_ENABLED: 'true',
  AWS_CHECKALT_ENABLED: 'false',
  AWS_PROVIDER_EXECUTION_ENABLED: 'false',
  AWS_FINANCIAL_PERMISSIONS_ACTIVATED: 'false',
  AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'true',
  AWS_MOOV_ENABLED: 'false',
  PROVIDER_SECRETS_ARN: 'arn:aws:secretsmanager:us-east-1:806168576068:secret:checksops/production/providers',
};

const statusReadOffFlags = {
  ...statusReadOnlyFlags,
  AWS_CHECKALT_STATUS_RECONCILE_ENABLED: undefined,
};

const createStore = () => ({
  deposits: [],
  memberships: [{ tenant_id: FREEDOM_TENANT, role: 'admin', tenant_name: 'Freedom', tenant_slug: 'freedom' }],
  check: { id: CHECK_ID, tenant_id: FREEDOM_TENANT, amount: 9984.11, status: 'approved_for_deposit' },
  processPosts: 0,
  approvePosts: 0,
  itemPosts: 0,
  historyPosts: 0,
  registerPosts: 0,
  itemPayload: { statusCode: 127, status: 127, statusDescription: 'Approved' },
  historyPayload: null,
  gucs: {},
});

const identityClient = (store) => ({
  connect: async () => {},
  end: async () => {},
  query: async (sql, params = []) => {
    const text = String(sql);
    if (text === 'BEGIN' || text === 'ROLLBACK' || text === 'COMMIT' || text === 'SET TRANSACTION READ WRITE') {
      return { rows: [] };
    }
    if (text.startsWith('SELECT set_config')) {
      store.gucs[params[0]] = params[1];
      return { rows: [{ set_config: params[1] }] };
    }
    if (text === LOOKUP_MAPPING_SQL) return { rows: params[0] === mapping.cognito_sub ? [mapping] : [] };
    if (text === TENANT_MEMBERSHIP_SQL || text.includes('FROM public.tenant_users tu')) {
      return { rows: store.memberships };
    }
    if (text.includes('FROM public.user_roles')) return { rows: [{ role: 'admin' }] };
    if (text.includes('FROM public.tenant_users WHERE user_id')) return { rows: [{ role: 'admin' }] };
    if (text.includes('FROM public.check_intake_items')) {
      return { rows: params[0] === store.check.id ? [store.check] : [] };
    }
    if (text.includes('aws_checkalt_status_read_config')) {
      return {
        rows: [{
          merchant: 'prod-merchant',
          default_enabled: true,
          base_url: 'https://api2.checkalt.com',
        }],
      };
    }
    if (text.includes('aws_checkalt_production_config') || (text.includes('FROM public.checkalt_config') && text.includes('singleton'))) {
      return {
        rows: [{
          merchant: 'prod-merchant',
          fi_key: 'ignored-db-fi',
          base_url: 'https://api2.checkalt.com',
          default_enabled: true,
          depositor_account_id: 'acct-1',
        }],
      };
    }
    if (text.includes('FROM public.checkalt_tenant_accounts')) {
      return { rows: [{ tenant_id: FREEDOM_TENANT, enabled: true, sso_user_id: 'depositor-prod', last_register_payload: { sso_key: 'sso-prod' } }] };
    }
    if (text.includes('status_refresh_tenants')) {
      return { rows: [...new Set(store.deposits.filter((row) => row.checkalt_reference).map((row) => row.tenant_id))].map((tenant_id) => ({ tenant_id })) };
    }
    if (text.includes('FROM public.checkalt_deposits') && text.includes('status = ANY(')) {
      return { rows: store.deposits.filter((row) => params[0].includes(row.tenant_id) && params[1].includes(row.status) && row.checkalt_reference) };
    }
    if (text.includes('FROM public.checkalt_deposits')) {
      const found = store.deposits.find((row) => row.id === params[0] || row.checkalt_reference === params[0]);
      return { rows: found ? [found] : [] };
    }
    if (text.includes('aws_checkalt_status_read_persist')) {
      const row = store.deposits.find((item) => item.id === params[0]);
      if (!row) return { rows: [] };
      const before = { ...row };
      const next = params[1];
      if (next) row.status = next;
      row.last_polled_at = new Date().toISOString();
      if (next === 'cleared' && params[3]) row.cleared_at = params[3];
      row._persistParams = params;
      row._before = before;
      row._persistSql = text;
      return { rows: [row] };
    }
    if (text.includes('UPDATE public.checkalt_deposits')) {
      store.genericUpdate = (store.genericUpdate || 0) + 1;
      const row = store.deposits.find((item) => item.id === params[0]);
      if (!row) return { rows: [] };
      const before = { ...row };
      if (params[1]) row.status = params[1];
      if (params[2]) row.checkalt_reference = params[2];
      row.last_polled_at = new Date().toISOString();
      if (params[1] === 'cleared' && params[4]) row.cleared_at = params[4];
      row._persistParams = params;
      row._before = before;
      return { rows: [row] };
    }
    return { rows: [] };
  },
});

const fetchImpl = (store) => async (url) => {
  const target = String(url);
  if (target.includes('/public/fincapture/authenticate')) {
    const token = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')
      + '.'
      + Buffer.from(JSON.stringify({ exp: 9999999999 })).toString('base64url')
      + '.sig';
    return { ok: true, status: 200, text: async () => token };
  }
  if (target.includes('/fincapture/deposit/process')) {
    store.processPosts += 1;
    return { ok: true, status: 200, text: async () => JSON.stringify({ referenceNumber: 9001 }) };
  }
  if (target.includes('/fincapture/deposit/approve')) {
    store.approvePosts += 1;
    return { ok: true, status: 200, text: async () => JSON.stringify({ success: true }) };
  }
  if (target.includes('/fincapture/useraccount/register')) {
    store.registerPosts += 1;
    return { ok: true, status: 200, text: async () => JSON.stringify({ success: true }) };
  }
  if (target.includes('/fincapture/deposit/item')) {
    store.itemPosts += 1;
    if (store.itemPayload === null) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ unknown: true }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(store.itemPayload) };
  }
  if (target.includes('/fincapture/deposit/history')) {
    store.historyPosts += 1;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(store.historyPayload || {
        depositHistoryList: [{ referenceNumber: 9001, status: 127, statusDescription: 'Approved' }],
      }),
    };
  }
  return { ok: false, status: 404, text: async () => 'not found' };
};

const deps = (store) => ({
  createClient: () => identityClient(store),
  loadDatabaseCredentials: async () => ({ host: 'localhost', username: 'checksops', password: 'x', database: 'checksops' }),
  fetchImpl: fetchImpl(store),
  loadProductionSecrets: async () => ({
    ok: true,
    credentials: {
      environment: 'production',
      username: 'prod-user',
      password: 'prod-pass',
      fiKey: 'prod-fi-key',
      baseUrl: 'https://api2.checkalt.com',
    },
  }),
});

const seedPending = (store, extra = {}) => {
  store.deposits.push({
    id: DEPOSIT_ID,
    tenant_id: FREEDOM_TENANT,
    check_intake_item_id: CHECK_ID,
    checkalt_reference: '9001',
    status: 'pending_approval',
    amount: 9984.11,
    amount_cents: 998411,
    cleared_at: null,
    last_polled_at: null,
    ...extra,
  });
};

const invoke = (name, body, store, flags = statusReadOnlyFlags) => withEnv(flags, () => handleProviderRequest(
  jwtEvent(`/functions/v1/${name}`, 'POST', body),
  `/functions/v1/${name}`,
  'POST',
  deps(store),
));

test('status-read flag is independent of financial execution holds', () => {
  assert.equal(checkaltStatusReconcileEnabled(), false);
  assert.equal(checkaltStatusReadAllowed(), false);
  assert.equal(productionCheckAltExecutionAllowed(), false);
  assert.equal(checkaltStatusReadOnlyMode(), false);
});

test('1. status-reconcile flag OFF blocks real CheckAlt status HTTP', async () => {
  const store = createStore();
  seedPending(store);
  const result = await invoke('checkalt-poll-status', { deposit_id: DEPOSIT_ID }, store, statusReadOffFlags);
  assert.equal(result.statusCode, 403);
  assert.equal(result.error, 'checkalt_status_reconcile_disabled');
  assert.equal(result.liveProviderCalled, false);
  assert.equal(store.itemPosts, 0);
  assert.equal(store.historyPosts, 0);
  assert.equal(store.processPosts, 0);
  assert.equal(store.deposits[0].status, 'pending_approval');
});

test('2. flag ON + financial flags OFF allows /deposit/item status lookup', async () => {
  const store = createStore();
  seedPending(store);
  const result = await invoke('checkalt-poll-status', { deposit_id: DEPOSIT_ID }, store);
  assert.equal(productionCheckAltExecutionAllowed(), false);
  assert.equal(result.statusCode, 200);
  assert.equal(result.reconciled, true);
  assert.equal(store.itemPosts, 1);
  assert.equal(store.processPosts, 0);
  assert.equal(store.approvePosts, 0);
  assert.equal(store.deposits[0].status, 'submitted');
  assert.equal(store.gucs['request.financial_execution'], '0');
  assert.equal(store.gucs['request.checkalt_status_read'], '1');
  assert.equal(store.genericUpdate || 0, 0);
  assert.match(store.deposits[0]._persistSql, /aws_checkalt_status_read_persist/);
});

test('3. same configuration allows history status fallback', async () => {
  const store = createStore();
  store.itemPayload = null;
  seedPending(store);
  const result = await invoke('checkalt-poll-status', { deposit_id: DEPOSIT_ID }, store);
  assert.equal(result.statusCode, 200);
  assert.equal(store.itemPosts, 1);
  assert.equal(store.historyPosts, 1);
  assert.equal(store.processPosts, 0);
  assert.equal(store.deposits[0].status, 'submitted');
});

test('4-9. same configuration blocks process, approve, submit, reject, and registration', async () => {
  const store = createStore();
  seedPending(store);
  const guarded = statusReadOnlyFetch(fetchImpl(store));
  await assert.rejects(() => guarded('https://api2.checkalt.com/fincapture/deposit/process', { method: 'POST' }), /status_reconcile_refused_money_path/);
  await assert.rejects(() => guarded('https://api2.checkalt.com/fincapture/deposit/approve', { method: 'POST' }), /status_reconcile_refused_money_path/);
  await assert.rejects(() => guarded('https://api2.checkalt.com/fincapture/useraccount/register', { method: 'POST' }), /status_reconcile_refused_money_path/);
  assert.equal(isCheckAltStatusReadPath('https://api2.checkalt.com/fincapture/deposit/item'), true);
  assert.equal(store.processPosts, 0);
  assert.equal(store.approvePosts, 0);
  assert.equal(store.registerPosts, 0);

  for (const [name, body] of [
    ['checkalt-submit-deposit', { check_intake_item_id: CHECK_ID }],
    ['checkalt-approve-deposit', { deposit_id: DEPOSIT_ID, action: 'approve' }],
    ['checkalt-approve-deposit', { deposit_id: DEPOSIT_ID, action: 'reject' }],
    ['checkalt-register-account', { tenant_id: FREEDOM_TENANT }],
    ['checkalt-deposit-history', { tenant_id: FREEDOM_TENANT }],
  ]) {
    const result = await invoke(name, body, store);
    assert.equal(result.statusCode, 403, name);
    assert.ok(['checkalt_mutation_blocked', 'production_execution_blocked', 'provider_disabled'].includes(result.error), `${name} ${result.error}`);
    assert.equal(result.liveProviderCalled, false, name);
    assert.equal(result.submitPosted || false, false, name);
    assert.equal(result.approvePosted || false, false, name);
    assert.equal(result.moneyMoved || false, false, name);
  }
  assert.equal(store.processPosts, 0);
  assert.equal(store.approvePosts, 0);
  assert.equal(store.registerPosts, 0);
  assert.equal(store.genericUpdate || 0, 0);
  assert.equal(store.deposits[0].status, 'pending_approval');
});

test('10. status-read persist uses isolated SQL helper, not raw UPDATE', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'functions/api/providers/production/checkalt-idempotency.mjs'), 'utf8');
  const persistStart = src.indexOf('export async function persistStatusReadOutcome');
  const persistEnd = src.indexOf('export async function persistPollOutcome');
  const persist = src.slice(persistStart, persistEnd);
  assert.match(persist, /aws_checkalt_status_read_persist/);
  assert.equal(persist.includes('UPDATE public.checkalt_deposits'), false);
  const approvePersist = src.slice(src.indexOf('export async function persistPollOutcome'));
  assert.match(approvePersist, /UPDATE public.checkalt_deposits/);

  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [{ id: params[0], status: params[1], cleared_at: params[1] === 'cleared' ? params[3] : null }] };
    },
  };
  await persistStatusReadOutcome(client, {
    rowId: DEPOSIT_ID,
    status: 'submitted',
    providerPayload: { statusCode: 127, status: 'Approved' },
  });
  assert.match(calls[0].sql, /aws_checkalt_status_read_persist/);
  assert.equal(calls[0].params[1], 'submitted');
  assert.equal(calls[0].params[3], null);
});

test('11-13. settlement mapping: 127 never clears; 200 needs depositDate', () => {
  assert.equal(resolveCheckAltProviderStatus({ statusCode: 127 }), 'submitted');
  assert.equal(resolveCheckAltProviderStatus({ status: 'Approved' }), 'submitted');
  assert.notEqual(resolveCheckAltProviderStatus({ status: 'Approved', depositDate: '2026-09-16' }), 'cleared');
  assert.equal(resolveCheckAltProviderStatus({ statusCode: 200 }), 'submitted');
  assert.equal(resolveCheckAltProviderStatus({ statusCode: 200, depositDate: '2026-09-16' }), 'cleared');
  assert.equal(applyCheckAltSettlementInvariant('cleared', { statusCode: 200 }), 'submitted');
});

test('11-13 via status-read poll persist', async () => {
  const approved = createStore();
  seedPending(approved);
  const approvedResult = await invoke('checkalt-poll-status', { deposit_id: DEPOSIT_ID }, approved);
  assert.equal(approvedResult.status, 'submitted');
  assert.equal(approved.deposits[0].status, 'submitted');
  assert.ok(!approved.deposits[0].cleared_at);

  const noDate = createStore();
  noDate.itemPayload = { statusCode: 200 };
  seedPending(noDate);
  const noDateResult = await invoke('checkalt-poll-status', { deposit_id: DEPOSIT_ID }, noDate);
  assert.equal(noDateResult.status, 'submitted');
  assert.equal(noDate.deposits[0].status, 'submitted');
  assert.ok(!noDate.deposits[0].cleared_at);

  const withDate = createStore();
  withDate.itemPayload = { statusCode: 200, depositDate: '2026-09-16' };
  seedPending(withDate);
  const withDateResult = await invoke('checkalt-poll-status', { deposit_id: DEPOSIT_ID }, withDate);
  assert.equal(withDateResult.status, 'cleared');
  assert.equal(withDate.deposits[0].status, 'cleared');
  assert.equal(withDate.deposits[0].cleared_at, '2026-09-16T12:00:00.000Z');
  assert.equal(approved.genericUpdate || 0, 0);
  assert.equal(noDate.genericUpdate || 0, 0);
  assert.equal(withDate.genericUpdate || 0, 0);
});

test('scheduled job uses the same status-read permission and stays off by default', async () => {
  const store = createStore();
  seedPending(store);
  store.itemPayload = { statusCode: 127, statusDescription: 'Approved' };
  await withEnv(statusReadOffFlags, async () => {
    const disabled = await handleCheckAltStatusReconcileJob({
      headers: { 'x-scheduled-job-secret': 'cron' },
      body: JSON.stringify({ job: 'checkalt-poll-deposits' }),
    }, { ...deps(store), createClient: () => identityClient(store) });
    assert.equal(disabled.error, 'checkalt_status_reconcile_disabled');
    assert.equal(disabled.liveProviderCalled, false);
  });
  await withEnv(statusReadOnlyFlags, async () => {
    assert.equal(productionCheckAltExecutionAllowed(), false);
    const allowed = await handleCheckAltStatusReconcileJob({
      headers: {},
      body: JSON.stringify({ job: 'checkalt-poll-deposits' }),
    }, { ...deps(store), createClient: () => identityClient(store) });
    assert.equal(allowed.ok, true);
    assert.equal(store.processPosts, 0);
    assert.equal(store.approvePosts, 0);
    assert.equal(store.deposits[0].status, 'submitted');
  });
});
