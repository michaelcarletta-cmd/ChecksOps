/**
 * Per-tenant deposits switch (owner decision 2026-10-17, option 2), API side:
 * the two server choke points refuse a deposit for a tenant whose deposits are
 * off (deposits_disabled), before any write or provider call; a failed read
 * fails closed; true or an unknown tenant behaves exactly as before; nothing
 * else in the API can create a deposit; the platform owner alone saves the
 * switch. The database side is tenant-deposits-switch-pg.test.mjs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DEPOSITS_DISABLED,
  DEPOSITS_DISABLED_MESSAGE,
  TENANT_DEPOSITS_ENABLED_SQL,
  checkTenantDepositsEnabled,
  gateProviderDeposit,
  isDepositFunction,
} from '../functions/api/tenant-deposits-gate.mjs';
import { handleFunctionInvoke } from '../functions/api/providers.mjs';
import { runProductionCheckAltHandler } from '../functions/api/providers/production/checkalt-dispatch.mjs';
import { checkaltExecutionStub } from '../functions/api/providers/checkalt.mjs';
import { WRITE_ALLOWLIST } from '../functions/api/write-allowlist.mjs';
import { executeTenantsNarrow } from '../functions/api/write-app-metadata.mjs';
import { SET_TENANT_DEPOSITS_ENABLED_SQL, saveBillingSettings } from '../functions/api/tenant-billing-engine.mjs';
import { handleTenantBillingAdmin } from '../functions/api/tenant-billing-handlers.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const TENANT = '11111111-1111-4111-8111-111111111111';
const CHECK = '55555555-5555-4555-8555-555555555555';
const DEPOSIT = '66666666-6666-4666-8666-666666666666';
const USER = 'a1000000-0000-4000-8000-000000000001';

/** Answers the gate's reads: the check's / deposit's tenant and the flag (or throws). */
const gateClient = ({ enabled = true, tenant = TENANT, fail = false, sandboxOnly = false } = {}) => {
  const queries = [];
  return {
    queries,
    query: async (sql, params = []) => {
      const text = String(sql);
      queries.push({ sql: text, params });
      if (/SAVEPOINT|RELEASE|ROLLBACK/.test(text)) return { rows: [] };
      if (fail && text === TENANT_DEPOSITS_ENABLED_SQL) throw new Error('connection reset');
      if (/FROM public\.check_intake_items/.test(text)) return { rows: tenant ? [{ tenant_id: tenant }] : [] };
      if (/FROM public\.checkalt_deposits/.test(text)) return { rows: tenant && !sandboxOnly ? [{ tenant_id: tenant }] : [] };
      if (/FROM public\.aws_provider_sandbox_operations/.test(text)) return { rows: tenant ? [{ tenant_id: tenant }] : [] };
      if (text === TENANT_DEPOSITS_ENABLED_SQL) return { rows: [{ enabled }] };
      return { rows: [] };
    },
  };
};

const SUBMIT = { name: 'checkalt-submit-deposit', body: { check_intake_item_id: CHECK } };
const APPROVE = { name: 'checkalt-approve-deposit', body: { action: 'approve', deposit_id: DEPOSIT } };
const event = (body) => ({ body: JSON.stringify(body), headers: {} });

test('only Check Alt submit and approve-to-deposit are deposit functions; reject, polls and the rest are not', () => {
  assert.equal(isDepositFunction('checkalt-submit-deposit', {}), true);
  assert.equal(isDepositFunction('checkalt-approve-deposit', { action: 'approve' }), true);
  for (const [name, body] of [
    ['checkalt-approve-deposit', { action: 'reject' }],
    ['checkalt-approve-deposit', {}],
    ['checkalt-poll-status', {}],
    ['checkalt-prepare-image', {}],
    ['checkalt-register-account', {}],
    ['moov-wallet-fund', {}],
    ['moov-disburse', {}],
  ]) assert.equal(isDepositFunction(name, body), false, `${name} ${JSON.stringify(body)}`);
});

test('the flag read: false refuses with the owner message, true / unknown tenant pass, a failed read fails closed', async () => {
  const off = await checkTenantDepositsEnabled(gateClient({ enabled: false }), TENANT);
  assert.equal(off.ok, false);
  assert.equal(off.error, DEPOSITS_DISABLED);
  assert.equal(off.message, 'Deposits are turned off for this account. Contact ChecksOps.');
  assert.equal(DEPOSITS_DISABLED_MESSAGE, off.message);
  assert.equal(off.statusCode, 403);
  assert.equal(off.liveProviderCalled, false);
  assert.equal((await checkTenantDepositsEnabled(gateClient({ enabled: true }), TENANT)).ok, true);
  assert.equal((await checkTenantDepositsEnabled(gateClient({ enabled: null }), TENANT)).ok, true);
  const broken = gateClient({ fail: true });
  const unread = await checkTenantDepositsEnabled(broken, TENANT);
  assert.equal(unread.ok, false);
  assert.equal(unread.error, 'deposits_status_unavailable');
  assert.equal(unread.statusCode, 503);
  // The read runs in a savepoint, so the caller's transaction survives a failure.
  assert.deepEqual(broken.queries.map((q) => q.sql), ['SAVEPOINT tenant_deposits_gate', TENANT_DEPOSITS_ENABLED_SQL, 'ROLLBACK TO SAVEPOINT tenant_deposits_gate']);
  assert.match(read('aws/workflows/sql/98_tenant_fee_collection.sql'), /CREATE OR REPLACE FUNCTION public\.aws_tenant_deposits_enabled\(_tenant_id uuid\)/);
});

const withEnv = async (vars, fn) => {
  const saved = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};
/** The two modes in which a Check Alt deposit handler actually runs. */
const PRODUCTION_MODE = {
  AWS_PROVIDER_EXECUTION_ENABLED: 'true', AWS_CHECKALT_ENABLED: 'true', AWS_FINANCIAL_PERMISSIONS_ACTIVATED: 'true',
  AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: undefined,
};
const SANDBOX_MODE = {
  AWS_PROVIDER_EXECUTION_ENABLED: undefined, AWS_CHECKALT_ENABLED: undefined, AWS_FINANCIAL_PERMISSIONS_ACTIVATED: undefined,
  AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'true',
};

test('providers.mjs: submit and approve are refused for a tenant whose deposits are off, before the handler and any provider call', async () => {
  for (const [mode, env] of [['production', PRODUCTION_MODE], ['sandbox', SANDBOX_MODE]]) await withEnv(env, async () => {
  for (const { name, body } of [SUBMIT, APPROVE, { ...APPROVE, body: { action: 'approve', checkalt_reference: 'REF-1' } }]) {
    for (const sandboxOnly of [false, true]) {
      let fetched = 0;
      let connected = 0;
      const client = gateClient({ enabled: false, sandboxOnly });
      const res = await handleFunctionInvoke(event(body), name, {
        depositGateClient: client,
        fetchImpl: async () => { fetched += 1; throw new Error('provider called'); },
        createClient: () => { connected += 1; throw new Error('handler connected'); },
        loadDatabaseCredentials: async () => { connected += 1; return {}; },
      });
      assert.equal(res.error, DEPOSITS_DISABLED, `${mode} ${name} ${JSON.stringify(body)}`);
      assert.equal(res.message, DEPOSITS_DISABLED_MESSAGE);
      assert.equal(res.liveProviderCalled, false);
      assert.equal(fetched, 0, 'no provider call');
      assert.equal(connected, 0, 'the production / sandbox handler never ran (no write connection)');
      // Only the gate's reads ran: no INSERT / UPDATE.
      assert.ok(client.queries.every((q) => !/INSERT|UPDATE|DELETE/.test(q.sql)), JSON.stringify(client.queries));
    }
  }
  });
  // The gate sits before both the production Check Alt dispatch and the sandbox parity dispatch.
  const src = read('aws/functions/api/providers.mjs');
  const invoke = src.slice(src.indexOf('export const handleFunctionInvoke'));
  const production = invoke.indexOf('runProductionCheckAltHandler(');
  const parity = invoke.indexOf('runParityHandler(');
  assert.ok(invoke.lastIndexOf('depositGate()', production) > 0);
  assert.ok(invoke.lastIndexOf('depositGate()', parity) > production);
});

test('providers.mjs: with the default money holds, the holds and stubs still answer first (no gate read, even when off)', async () => {
  const client = gateClient({ enabled: false });
  for (const { name, body } of [SUBMIT, APPROVE]) {
    const res = await handleFunctionInvoke(event(body), name, { depositGateClient: client });
    assert.deepEqual(res, checkaltExecutionStub(name), name);
  }
  assert.equal(client.queries.length, 0);
});

test('providers.mjs: in production and sandbox mode, deposits on or an unknown check reach the handler exactly as before', async () => {
  const { runParityHandler } = await import('../functions/api/providers/parity/dispatch.mjs');
  for (const [mode, env, direct] of [
    ['production', PRODUCTION_MODE, (name, ev, deps) => runProductionCheckAltHandler(name, ev, deps)],
    ['sandbox', SANDBOX_MODE, (name, ev, deps) => runParityHandler(name, ev, deps)],
  ]) await withEnv(env, async () => {
    for (const { name, body } of [SUBMIT, APPROVE]) {
      const before = await direct(name, event(body), {});
      for (const client of [gateClient({ enabled: true }), gateClient({ enabled: null }), gateClient({ tenant: null })]) {
        assert.deepEqual(await handleFunctionInvoke(event(body), name, { depositGateClient: client }), before, `${mode} ${name}`);
      }
    }
  });
});

test('providers.mjs: deposits on, an unknown check, or reject behave exactly as without the gate', async () => {
  const deps = () => ({
    fetchImpl: async () => { throw new Error('no network in tests'); },
  });
  // What the route answered before the gate existed, in this (non-production, no provider flags)
  // runtime: no production handler applies, so the Check Alt execution stub.
  assert.equal(await runProductionCheckAltHandler(SUBMIT.name, event(SUBMIT.body), deps()), null);
  for (const name of [SUBMIT.name, APPROVE.name]) {
    const before = checkaltExecutionStub(name);
    const body = name === SUBMIT.name ? SUBMIT.body : APPROVE.body;
    for (const client of [gateClient({ enabled: true }), gateClient({ enabled: null }), gateClient({ tenant: null })]) {
      const res = await handleFunctionInvoke(event(body), name, { ...deps(), depositGateClient: client });
      assert.deepEqual(res, before, `${name}`);
    }
  }
  // Reject never consults the switch, even when deposits are off.
  const rejectClient = gateClient({ enabled: false });
  const rejected = await handleFunctionInvoke(event({ ...APPROVE.body, action: 'reject' }), APPROVE.name, { ...deps(), depositGateClient: rejectClient });
  assert.deepEqual(rejected, checkaltExecutionStub(APPROVE.name));
  assert.equal(rejectClient.queries.length, 0);
  // A non-deposit function never opens the gate's connection.
  let opened = 0;
  await gateProviderDeposit('checkalt-poll-status', {}, async () => { opened += 1; return { ok: true }; });
  assert.equal(opened, 0);
});

test('providers.mjs: a gate read that fails refuses (fail closed); an unauthenticated caller gets the handler answer', async () => {
  const failed = await gateProviderDeposit(SUBMIT.name, SUBMIT.body, (fn) => fn({ client: gateClient({ fail: true }) }));
  assert.equal(failed.error, 'deposits_status_unavailable');
  assert.equal(failed.liveProviderCalled, false);
  const dbDown = await gateProviderDeposit(SUBMIT.name, SUBMIT.body, async () => ({ ok: false, statusCode: 503, error: 'data_query_failed' }));
  assert.equal(dbDown.error, 'deposits_status_unavailable');
  const thrown = await gateProviderDeposit(SUBMIT.name, SUBMIT.body, async () => { throw new Error('pool exhausted'); });
  assert.equal(thrown.error, 'deposits_status_unavailable');
  assert.equal(await gateProviderDeposit(SUBMIT.name, SUBMIT.body, async () => ({ ok: false, statusCode: 401, error: 'missing_token' })), null);
});

test('workflow-rpc.mjs deposit_action: all three actions check the switch for the item\'s own tenant before writing', () => {
  const src = read('aws/functions/api/workflow-rpc.mjs');
  const fn = src.slice(src.indexOf('const executeDepositAction'), src.indexOf('export const DEPOSIT_BATCH_LOCK_SQL'));
  const prepare = fn.slice(fn.indexOf("if (action === 'prepare_deposit')"), fn.indexOf("if (action === 'mark_manual_deposit')"));
  const manual = fn.slice(fn.indexOf("if (action === 'mark_manual_deposit')"), fn.indexOf("const depositItemId = arg(args, 'p_deposit_item_id', 'deposit_item_id');\n  const provider"));
  const assign = fn.slice(fn.indexOf("const depositItemId = arg(args, 'p_deposit_item_id', 'deposit_item_id');\n  const provider"));
  for (const [label, body, tenantExpr] of [
    ['prepare_deposit', prepare, 'check.tenant_id'],
    ['mark_manual_deposit', manual, 'item.tenant_id'],
    ['assign_provider', assign, 'item.tenant_id'],
  ]) {
    const gateAt = body.indexOf(`checkTenantDepositsEnabled(client, ${tenantExpr})`);
    assert.ok(gateAt > 0, label);
    const firstWrite = body.search(/INSERT INTO|UPDATE public\.|CREATE_DEPOSIT_BATCH_FOR_ITEM_SQL,/);
    assert.ok(firstWrite > gateAt, `${label}: gate before the first write`);
  }
});

test('nothing else in the API creates a deposit', () => {
  const api = path.join(ROOT, 'aws/functions/api');
  const files = fs.readdirSync(api, { recursive: true }).map(String).filter((f) => f.endsWith('.mjs') && !f.includes('node_modules'));
  const writers = new Set();
  for (const file of files) {
    const text = fs.readFileSync(path.join(api, file), 'utf8');
    if (/INSERT INTO public\.(deposit_items|deposit_batches|checkalt_deposits)\b/.test(text)) writers.add(file);
    if (/SET status = 'deposited'/.test(text)) writers.add(file);
  }
  // deposit_action (gated) and the Check Alt production writer, whose only caller is the production submit
  // handler, reached only through the gated providers.mjs route.
  assert.deepEqual([...writers].sort(), ['providers/production/checkalt-idempotency.mjs', 'workflow-rpc.mjs']);
  const callers = files.filter((file) => /insertQueuedDeposit\(/.test(fs.readFileSync(path.join(api, file), 'utf8'))
    && !/export async function insertQueuedDeposit/.test(fs.readFileSync(path.join(api, file), 'utf8')));
  assert.deepEqual(callers, ['providers/production/checkalt-submit.mjs']);
  assert.match(read('aws/functions/api/providers/production/checkalt-dispatch.mjs'), /'checkalt-submit-deposit': wrap\(handleProductionCheckAltSubmit\)/);
  // The generic write path cannot set a check deposited or touch the deposit tables.
  const allow = read('aws/functions/api/write-allowlist.mjs');
  assert.match(allow, /INTAKE_PROHIBITED_COLUMNS = new Set\(\[[\s\S]*'status',[\s\S]*'deposited_at',/);
  for (const table of ['checkalt_deposits', 'deposit_batches', 'deposit_items']) {
    assert.match(allow.slice(allow.indexOf('FINANCIAL_OR_PROVIDER_TABLES')), new RegExp(`'${table}'`), table);
  }
  // Admin override to deposited stays disabled, and the deposit cron stays off.
  assert.match(read('aws/functions/api/admin-override-check-status.mjs'), /admin_override_check_status to 'deposited' remains disabled/);
  assert.match(read('aws/functions/api/scheduled.mjs'), /deposit automation[^\n]*stay disabled/);
});

test('members never write the switch: not in the generic tenants allowlist or the narrow tenants writer', async () => {
  assert.equal(WRITE_ALLOWLIST.tenants.columns.has('deposits_enabled'), false);
  const queries = [];
  const client = {
    query: async (sql, params) => {
      queries.push(String(sql));
      if (/tenant_users/.test(sql)) return { rows: [{ ok: 1 }] };
      return { rows: [] };
    },
  };
  const res = await executeTenantsNarrow({ client, mapping: { application_user_id: USER }, op: 'update', values: { deposits_enabled: false }, filters: [{ column: 'id', op: 'eq', value: TENANT }] });
  assert.equal(res.error, 'missing_required_field');
  assert.equal(queries.some((q) => /UPDATE public\.tenants/.test(q)), false);
  const guard = read('aws/workflows/sql/98_tenant_fee_collection.sql');
  const body = guard.slice(guard.lastIndexOf('CREATE OR REPLACE FUNCTION public.aws_tenants_member_column_guard()'));
  const memberCols = body.slice(body.indexOf('v_member_columns'), body.indexOf('];'));
  assert.equal(memberCols.includes('deposits_enabled'), false, 'members may not change it');
  assert.match(body, /IF COALESCE\(public\.is_platform_owner\(\), false\) THEN\s+v_allowed := v_allowed \|\| public\.aws_tenant_pricing_columns\(\) \|\| ARRAY\['deposits_enabled'\];/);
});

test('the platform owner saves the switch through the SQL 98 setter; anyone else is refused first', async () => {
  const queries = [];
  const client = { query: async (sql, params) => { queries.push({ sql: String(sql), params }); return { rows: [] }; } };
  await saveBillingSettings(client, { tenantId: TENANT, userId: USER, depositsEnabled: false });
  const setter = queries.find((q) => q.sql === SET_TENANT_DEPOSITS_ENABLED_SQL);
  assert.deepEqual(setter.params, [TENANT, false]);
  assert.match(SET_TENANT_DEPOSITS_ENABLED_SQL, /aws_platform_owner_set_tenant_deposits_enabled\(\$1::uuid, \$2::boolean\)/);
  assert.equal((await saveBillingSettings(client, { tenantId: TENANT, userId: USER, depositsEnabled: 'no' })).error, 'invalid_deposits_enabled');
  // Not passing the field never touches it.
  queries.length = 0;
  await saveBillingSettings(client, { tenantId: TENANT, userId: USER, billingEnabled: true });
  assert.equal(queries.some((q) => q.sql === SET_TENANT_DEPOSITS_ENABLED_SQL), false);
  // A member or partner never reaches the setter.
  const member = { queries: [], query: async (sql) => { member.queries.push(String(sql)); return { rows: [{ ok: false }] }; } };
  const refused = await handleTenantBillingAdmin({ body: JSON.stringify({ action: 'update', tenant_id: TENANT, deposits_enabled: false }) }, { client: member, mapping: { application_user_id: USER } });
  assert.equal(refused.error, 'platform_owner_required');
  assert.equal(member.queries.some((q) => q === SET_TENANT_DEPOSITS_ENABLED_SQL), false);
});
