/**
 * Mortgage Desk sets a loss draft Monitored / Not Monitored (SQL 166, owner 2026-11-14: "Mortgage agent needs to be
 * able to change the claim from monitor to not monitored, so the tenants see that type of update").
 *
 * mortgage_desk_set_monitoring (POST /data/rpc, routed by workflow-rpc.mjs) is registered like the SQL 122 Desk
 * actions: in MORTGAGE_DESK_RPCS, safe_now in SAFE_WRITE_RPC_CLASSIFICATION, dispatched to executeMortgageDeskRpc,
 * gated by loadMortgageDeskWorkingRequest (assigned mortgage agent or platform owner, request in progress, a check),
 * then aws_mortgage_desk_set_monitoring(request id, type) under the caller's identity (withIdentityWrite sets the
 * GUCs auth.uid() reads, as for every sibling). SQL 166's refusals become clear 4xx results. Fake clients only; the
 * function itself is covered on PostgreSQL 16 by sql166-mortgage-desk-set-monitoring-pg.test.mjs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  MORTGAGE_DESK_MONITORING_TYPES,
  MORTGAGE_DESK_REQUEST_SQL,
  MORTGAGE_DESK_RPCS,
  MORTGAGE_DESK_SET_MONITORING,
  PLATFORM_OWNER_SQL,
  SET_MONITORING_REFUSALS,
  SET_MONITORING_SQL,
  executeMortgageDeskRpc,
} from '../functions/api/mortgage-desk-return.mjs';
import {
  SAFE_WRITE_RPCS,
  SAFE_WRITE_RPC_CLASSIFICATION,
  executeSafeWriteRpc,
  handleSafeWriteRpc,
} from '../functions/api/workflow-rpc.mjs';
import { LOOKUP_MAPPING_SQL, USER_ROLES_SQL } from '../functions/api/identity.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const AGENT = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const OTHER_AGENT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TENANT_MEMBER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const CHECK_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_CHECK = '44444444-4444-4444-8444-444444444444';
const LOSS_DRAFT_ID = '66666666-6666-4666-8666-666666666666';
const TENANT_A = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';

const pgError = (message, code) => Object.assign(new Error(message), { code });

/**
 * Fake pg client. `definer` answers the SQL 166 call: a function (params) => result, or an Error to throw.
 */
const fakeClient = ({
  roles = [{ role: 'mortgage_agent' }],
  platformOwner = false,
  visibleRequest = {
    id: REQUEST_ID, tenant_id: TENANT_A, check_intake_item_id: CHECK_ID, status: 'in_progress', assigned_employee_id: AGENT,
  },
  definer = ([, type]) => ({
    ok: true, changed: true, monitoring_type: type, previous_monitoring_type: type === 'monitored' ? 'not_monitored' : 'monitored',
    request_id: REQUEST_ID, loss_draft_id: LOSS_DRAFT_ID, message_id: 'm1', escrow_or_draws_recorded: false,
  }),
} = {}) => {
  const queries = [];
  return {
    queries,
    connect: async () => {},
    end: async () => {},
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (['BEGIN', 'ROLLBACK', 'COMMIT', 'SET TRANSACTION READ WRITE'].includes(sql)) return { rows: [] };
      if (sql.startsWith('SELECT set_config')) return { rows: [] };
      if (sql === LOOKUP_MAPPING_SQL) {
        return { rows: [{ application_user_id: AGENT, cognito_sub: COGNITO_SUB, email: 'agent@checksops.test', status: 'active' }] };
      }
      if (sql === USER_ROLES_SQL) return { rows: roles };
      if (sql === PLATFORM_OWNER_SQL) return { rows: [{ is_owner: platformOwner }] };
      if (sql === MORTGAGE_DESK_REQUEST_SQL) return { rows: visibleRequest ? [visibleRequest] : [] };
      if (sql === SET_MONITORING_SQL) {
        if (definer instanceof Error) throw definer;
        return { rows: [{ result: definer(params) }] };
      }
      return { rows: [] };
    },
  };
};

const definerCalls = (client) => client.queries.filter((q) => q.sql === SET_MONITORING_SQL);
const agentMapping = { application_user_id: AGENT };
const run = (client, args, mapping = agentMapping) => executeMortgageDeskRpc({
  client, mapping, name: MORTGAGE_DESK_SET_MONITORING, args,
});

test('mortgage_desk_set_monitoring is registered like the SQL 122 Desk actions', () => {
  assert.equal(MORTGAGE_DESK_SET_MONITORING, 'mortgage_desk_set_monitoring');
  assert.ok(MORTGAGE_DESK_RPCS.has('mortgage_desk_set_monitoring'));
  assert.ok(SAFE_WRITE_RPCS.has('mortgage_desk_set_monitoring'));
  assert.equal(SAFE_WRITE_RPC_CLASSIFICATION.mortgage_desk_set_monitoring, 'safe_now');
  for (const name of ['mortgage_desk_post_message', 'mortgage_desk_attach_file', 'mortgage_desk_update_shipping']) {
    assert.ok(MORTGAGE_DESK_RPCS.has(name), name);
  }
  assert.deepEqual([...MORTGAGE_DESK_MONITORING_TYPES], ['monitored', 'not_monitored']);
  // The dispatcher sends it to the Desk module with its siblings.
  const rpc = read('aws/functions/api/workflow-rpc.mjs');
  assert.match(rpc, /case 'mortgage_desk_update_shipping':\n\s*case 'mortgage_desk_set_monitoring':\n\s*return executeMortgageDeskRpc\(\{ client, mapping, name, args \}\);/);
  // The SQL 166 function, with the request id and the type as its only inputs.
  assert.equal(SET_MONITORING_SQL, 'SELECT public.aws_mortgage_desk_set_monitoring($1::uuid, $2::text) AS result');
  assert.match(read('aws/workflows/sql/166_mortgage_desk_set_monitoring.sql'),
    /CREATE OR REPLACE FUNCTION public\.aws_mortgage_desk_set_monitoring\(_request_id uuid, _monitoring_type text\)\nRETURNS jsonb/);
});

test('the assigned agent switches the loss draft; the request id comes from the gate, the type is normalized', async () => {
  const client = fakeClient();
  const result = await run(client, {
    _request_id: REQUEST_ID, _monitoring_type: '  Not_Monitored ', check_id: OTHER_CHECK, loss_draft_id: 'x', tenant_id: TENANT_A,
  });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.data, {
    ok: true, changed: true, monitoring_type: 'not_monitored', previous_monitoring_type: 'monitored',
    request_id: REQUEST_ID, loss_draft_id: LOSS_DRAFT_ID, message_id: 'm1', escrow_or_draws_recorded: false,
  });
  const calls = definerCalls(client);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, [REQUEST_ID, 'not_monitored']);
  assert.ok(!JSON.stringify(calls[0].params).includes(OTHER_CHECK));
  // The gate ran first: the request read, the owner check and the caller's roles.
  const order = client.queries.map((q) => q.sql);
  assert.ok(order.indexOf(MORTGAGE_DESK_REQUEST_SQL) < order.indexOf(SET_MONITORING_SQL));
  assert.ok(order.indexOf(USER_ROLES_SQL) < order.indexOf(SET_MONITORING_SQL));
});

test('escrow_or_draws_recorded and changed false come back from the server as they are', async () => {
  const recorded = await run(fakeClient({
    definer: ([, type]) => ({
      ok: true, changed: true, monitoring_type: type, previous_monitoring_type: 'monitored', request_id: REQUEST_ID,
      loss_draft_id: LOSS_DRAFT_ID, message_id: 'm2', escrow_or_draws_recorded: true,
    }),
  }), { request_id: REQUEST_ID, monitoring_type: 'not_monitored' });
  assert.equal(recorded.data.escrow_or_draws_recorded, true);
  const same = await run(fakeClient({
    definer: ([, type]) => ({
      ok: true, changed: false, monitoring_type: type, request_id: REQUEST_ID, loss_draft_id: LOSS_DRAFT_ID, escrow_or_draws_recorded: false,
    }),
  }), { _request_id: REQUEST_ID, _monitoring_type: 'monitored' });
  assert.equal(same.data.changed, false);
  assert.equal(same.data.message_id, undefined);
});

test('an invalid type is refused with 400 before any database read', async () => {
  for (const type of [undefined, null, '', 'paused', 'MONITORED_X', 7]) {
    const client = fakeClient();
    const result = await run(client, { _request_id: REQUEST_ID, _monitoring_type: type });
    assert.equal(result.error, 'invalid_field', String(type));
    assert.equal(result.field, '_monitoring_type');
    assert.equal(result.statusCode, 400);
    assert.equal(client.queries.length, 0, String(type));
  }
});

test('the gate refuses a caller who may not work the request; nothing reaches SQL 166', async () => {
  const cases = [
    ['an agent not assigned', fakeClient({
      visibleRequest: { id: REQUEST_ID, tenant_id: TENANT_A, check_intake_item_id: CHECK_ID, status: 'in_progress', assigned_employee_id: OTHER_AGENT },
    }), agentMapping, 'not_assigned_to_you'],
    ['a tenant member', fakeClient({ roles: [] }), { application_user_id: TENANT_MEMBER }, 'not_authorized'],
    ['a request RLS hides', fakeClient({ roles: [], visibleRequest: null }), { application_user_id: TENANT_MEMBER }, 'not_authorized'],
    ['a requested request', fakeClient({
      visibleRequest: { id: REQUEST_ID, tenant_id: TENANT_A, check_intake_item_id: CHECK_ID, status: 'requested', assigned_employee_id: AGENT },
    }), agentMapping, 'request_not_in_progress'],
    ['a completed request', fakeClient({
      visibleRequest: { id: REQUEST_ID, tenant_id: TENANT_A, check_intake_item_id: CHECK_ID, status: 'completed', assigned_employee_id: AGENT },
    }), agentMapping, 'request_not_in_progress'],
    ['a request with no check', fakeClient({
      visibleRequest: { id: REQUEST_ID, tenant_id: TENANT_A, check_intake_item_id: null, status: 'in_progress', assigned_employee_id: AGENT },
    }), agentMapping, 'request_has_no_check'],
  ];
  for (const [label, client, mapping, error] of cases) {
    const result = await run(client, { _request_id: REQUEST_ID, _monitoring_type: 'not_monitored' }, mapping);
    assert.equal(result.error, error, label);
    assert.equal(definerCalls(client).length, 0, label);
  }
  const badId = await run(fakeClient(), { _request_id: 'nope', _monitoring_type: 'monitored' });
  assert.equal(badId.error, 'invalid_uuid');
});

test('the platform owner may switch a request assigned to another agent', async () => {
  const client = fakeClient({
    roles: [],
    platformOwner: true,
    visibleRequest: { id: REQUEST_ID, tenant_id: TENANT_A, check_intake_item_id: CHECK_ID, status: 'in_progress', assigned_employee_id: OTHER_AGENT },
  });
  const result = await run(client, { _request_id: REQUEST_ID, _monitoring_type: 'monitored' });
  assert.equal(result.error, undefined);
  assert.equal(definerCalls(client).length, 1);
});

test('SQL 166 refusals become clear 4xx results; other errors are not swallowed', async () => {
  const cases = [
    ['request_has_no_loss_draft', '22023', { error: 'request_has_no_loss_draft', statusCode: 409 }],
    ['loss_draft_closed', '42501', { error: 'loss_draft_closed', statusCode: 409 }],
    ['invalid_monitoring_type', '22023', { error: 'invalid_field', field: '_monitoring_type', statusCode: 400 }],
    ['not_assigned_to_you', '42501', { error: 'not_assigned_to_you' }],
    ['request_not_in_status', '42501', { error: 'request_not_in_progress' }],
    ['request_has_no_check', '22023', { error: 'request_has_no_check' }],
    ['not_authorized', '42501', { error: 'not_authorized' }],
  ];
  for (const [token, code, expected] of cases) {
    const result = await run(fakeClient({ definer: pgError(token, code) }), { _request_id: REQUEST_ID, _monitoring_type: 'not_monitored' });
    for (const [key, value] of Object.entries(expected)) assert.equal(result[key], value, `${token} ${key}`);
    assert.equal(result.statusCode ?? 403, expected.statusCode ?? 403, token);
    assert.ok(typeof result.message === 'string' && result.message.length > 0, token);
    assert.equal(result.data, undefined, token);
  }
  assert.match(SET_MONITORING_REFUSALS.request_has_no_loss_draft.message, /no loss draft/);
  assert.match(SET_MONITORING_REFUSALS.loss_draft_closed.message, /closed/);
  // Not a refusal (SQL 166 missing, a connection error): rethrown, so the write wrapper reports it and rolls back.
  await assert.rejects(
    run(fakeClient({ definer: pgError('function public.aws_mortgage_desk_set_monitoring(uuid, text) does not exist', '42883') }),
      { _request_id: REQUEST_ID, _monitoring_type: 'monitored' }),
    /does not exist/,
  );
});

test('through executeSafeWriteRpc and POST /data/rpc: 200 commits, a refusal is a 4xx and rolls back', async () => {
  const direct = await executeSafeWriteRpc({
    client: fakeClient(), mapping: agentMapping, name: 'mortgage_desk_set_monitoring',
    args: { _request_id: REQUEST_ID, _monitoring_type: 'not_monitored' },
  });
  assert.equal(direct.data.monitoring_type, 'not_monitored');

  const event = (args) => ({
    rawPath: '/data/rpc',
    headers: { authorization: 'Bearer test-id-token' },
    body: JSON.stringify({ name: 'mortgage_desk_set_monitoring', args }),
    requestContext: {
      stage: 'staging',
      http: { method: 'POST', path: '/data/rpc' },
      authorizer: { jwt: { claims: { sub: COGNITO_SUB, email: 'agent@checksops.test', token_use: 'id' } } },
    },
  });
  const deps = (client) => ({
    loadDatabaseCredentials: async () => ({ host: 'x', username: 'checksops', password: 'x', database: 'checksops' }),
    createClient: () => client,
    forceEnabled: true,
  });

  const okClient = fakeClient();
  const ok = await handleSafeWriteRpc(event({ _request_id: REQUEST_ID, _monitoring_type: 'not_monitored' }), deps(okClient));
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.data.changed, true);
  assert.ok(okClient.queries.some((q) => q.sql === 'COMMIT' || /^COMMIT/.test(q.sql)), 'committed');
  // The caller's identity GUCs are set before the definer runs (auth.uid() inside SQL 166 reads them).
  const sqls = okClient.queries.map((q) => q.sql);
  assert.ok(sqls.findIndex((s) => s.startsWith('SELECT set_config')) < sqls.indexOf(SET_MONITORING_SQL));

  const closedClient = fakeClient({ definer: pgError('loss_draft_closed', '42501') });
  const closed = await handleSafeWriteRpc(event({ _request_id: REQUEST_ID, _monitoring_type: 'not_monitored' }), deps(closedClient));
  assert.equal(closed.ok, false);
  assert.equal(closed.statusCode, 409);
  assert.equal(closed.error, 'loss_draft_closed');
  assert.equal(closed.name, 'mortgage_desk_set_monitoring');
  assert.ok(closedClient.queries.some((q) => q.sql === 'ROLLBACK'), 'rolled back');
  assert.ok(!closedClient.queries.some((q) => q.sql === 'COMMIT'), 'not committed');

  const noDraft = await handleSafeWriteRpc(event({ _request_id: REQUEST_ID, _monitoring_type: 'monitored' }),
    deps(fakeClient({ definer: pgError('request_has_no_loss_draft', '22023') })));
  assert.equal(noDraft.statusCode, 409);
  assert.equal(noDraft.error, 'request_has_no_loss_draft');

  const badType = await handleSafeWriteRpc(event({ _request_id: REQUEST_ID, _monitoring_type: 'paused' }), deps(fakeClient()));
  assert.equal(badType.statusCode, 400);
  assert.equal(badType.field, '_monitoring_type');
});
