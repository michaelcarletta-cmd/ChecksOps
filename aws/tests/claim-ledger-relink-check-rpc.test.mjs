/**
 * claim_ledger_relink_check through POST /data/rpc (SQL 167; owner 2026-11-14 "Need to be able to
 * change/correct claim number once edited for ledger to link to existing claim"). Mirrors
 * claim-ledger-link-or-create-rpc.test.mjs: the same tenant gate, the check's own tenant and the
 * verified caller as actor (never the body's), inspect|relink only, refusals as clear 4xx answers.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CLAIM_LEDGER_LINK_OR_CREATE_SQL,
  CLAIM_LEDGER_RELINK_ACTIONS,
  CLAIM_LEDGER_RELINK_CHECK_SQL,
  CLAIM_LEDGER_RELINK_REFUSALS,
  SAFE_WRITE_RPCS,
  SAFE_WRITE_RPC_CLASSIFICATION,
  executeSafeWriteRpc,
  handleSafeWriteRpc,
} from '../functions/api/workflow-rpc.mjs';
import { LOOKUP_MAPPING_SQL, USER_ROLES_SQL } from '../functions/api/identity.mjs';
import { INTAKE_PROHIBITED_COLUMNS, WRITE_ALLOWLIST, pickAllowlistedValues } from '../functions/api/write-allowlist.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const APP_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const CHECK_ID = '8d2b1c3e-4f5a-4678-9abc-def012345678';
const OLD_CLAIM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NEW_CLAIM = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const OTHER_TENANT = '99999999-9999-4999-8999-999999999999';
const OTHER_ACTOR = '77777777-7777-4777-8777-777777777777';

const jwtEvent = (pathname, method, body) => ({
  rawPath: pathname,
  headers: { authorization: 'Bearer test-id-token' },
  body: body ? JSON.stringify(body) : undefined,
  requestContext: {
    stage: 'staging',
    http: { method, path: pathname },
    authorizer: { jwt: { claims: { sub: COGNITO_SUB, email: 'checksops-tester@freedomadj.com', token_use: 'id' } } },
  },
});

const depsFor = (client) => ({
  forceEnabled: true,
  forceWorkflow: true,
  loadDatabaseCredentials: async () => ({
    username: 'checksops',
    password: 'unit-test-only-not-a-real-secret',
    host: 'db.example.internal',
    database: 'checksops',
  }),
  createClient: () => client,
});

const INSPECT_FOUND = {
  ok: true,
  persisted: false,
  code: 'relink_available',
  can_relink: true,
  claim_id: NEW_CLAIM,
  claim_number: '695064-GQ',
  policyholder_name: 'Jane Homeowner',
  check_claim_id: OLD_CLAIM,
  old_claim_id: OLD_CLAIM,
  old_claim_number: '695064-QG',
  old_claim_other_check_count: 1,
  old_claim_has_settlements: false,
  loss_draft_rows_to_move: 1,
  signature_request_rows_to_move: 2,
};

const RELINKED = {
  ok: true,
  persisted: true,
  code: 'relinked',
  claim_id: NEW_CLAIM,
  claim_number: '695064-GQ',
  policyholder_name: 'Jane Homeowner',
  check_claim_id: NEW_CLAIM,
  old_claim_id: OLD_CLAIM,
  old_claim_number: '695064-QG',
  old_claim_remaining_check_count: 1,
  old_claim_has_settlements: false,
  loss_draft_rows_moved: 1,
  signature_request_rows_moved: 2,
};

const mockClient = ({
  check = { id: CHECK_ID, tenant_id: FREEDOM, claim_id: OLD_CLAIM, deposited_at: null, check_stage: 'review' },
  member = true,
  roles = [{ role: 'staff' }],
  rpcResult = INSPECT_FOUND,
  rpcError = null,
} = {}) => {
  const queries = [];
  return {
    queries,
    connect: async () => {},
    end: async () => {},
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT' || sql === 'SET TRANSACTION READ WRITE') {
        return { rows: [], command: sql };
      }
      if (sql.startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
      if (sql === LOOKUP_MAPPING_SQL) {
        return {
          rows: [{
            application_user_id: APP_ID,
            cognito_sub: COGNITO_SUB,
            email: 'checksops-tester@freedomadj.com',
            status: 'active',
          }],
        };
      }
      if (sql === USER_ROLES_SQL) return { rows: roles };
      if (/FROM public.check_intake_items/.test(sql) && /FOR UPDATE/.test(sql)) {
        return { rows: check ? [check] : [] };
      }
      if (/FROM public.tenant_users/.test(sql)) {
        return { rows: member ? [{ '?column?': 1 }] : [] };
      }
      if (sql === CLAIM_LEDGER_RELINK_CHECK_SQL) {
        if (rpcError) throw rpcError;
        return { rows: [{ result: rpcResult }] };
      }
      return { rows: [] };
    },
  };
};

const call = (client, args) => executeSafeWriteRpc({
  client,
  mapping: { application_user_id: APP_ID },
  name: 'claim_ledger_relink_check',
  args,
});

const rpcCall = (client) => client.queries.find((q) => q.sql === CLAIM_LEDGER_RELINK_CHECK_SQL);

test('claim_ledger_relink_check is a classified safe write RPC; generic claim_id UPDATE and claims INSERT stay blocked', () => {
  assert.equal(SAFE_WRITE_RPCS.has('claim_ledger_relink_check'), true);
  assert.equal(SAFE_WRITE_RPC_CLASSIFICATION.claim_ledger_relink_check, 'safe_now');
  assert.deepEqual([...CLAIM_LEDGER_RELINK_ACTIONS], ['inspect', 'relink']);
  assert.equal(
    CLAIM_LEDGER_RELINK_CHECK_SQL,
    'SELECT public.claim_ledger_relink_check($1::uuid, $2::uuid, $3::text, $4::text, $5::uuid) AS result',
  );
  assert.equal(WRITE_ALLOWLIST.claims.ops.has('insert'), false);
  assert.equal(INTAKE_PROHIBITED_COLUMNS.has('claim_id'), true);
  assert.equal(pickAllowlistedValues('check_intake_items', { claim_id: NEW_CLAIM }).error, 'column_not_allowlisted');
});

test('the SQL matches SQL 167\'s signature and grant (the API login is checksops)', () => {
  const sql = fs.readFileSync(path.join(ROOT, 'aws/workflows/sql/167_claim_ledger_relink_check.sql'), 'utf8');
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.claim_ledger_relink_check\(\s*p_check_id uuid,\s*p_tenant_id uuid,\s*p_claim_number text,\s*p_action text,\s*p_actor_id uuid\s*\)/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.claim_ledger_relink_check\(uuid, uuid, text, text, uuid\) TO checksops;/);
  for (const code of Object.keys(CLAIM_LEDGER_RELINK_REFUSALS)) {
    assert.match(sql, new RegExp(`'code', '${code}'`), code);
  }
});

test('inspect: the check\'s tenant and the verified caller go to the function; body tenant and actor are ignored', async () => {
  const client = mockClient();
  const result = await call(client, {
    p_check_id: CHECK_ID,
    p_tenant_id: OTHER_TENANT,
    p_actor_id: OTHER_ACTOR,
    p_claim_number: '  695064-GQ  ',
    p_action: 'inspect',
  });
  assert.deepEqual(result.data, INSPECT_FOUND);
  const rpc = rpcCall(client);
  assert.deepEqual(rpc.params, [CHECK_ID, FREEDOM, '695064-GQ', 'inspect', APP_ID]);
  assert.equal(client.queries.some((q) => q.sql === CLAIM_LEDGER_LINK_OR_CREATE_SQL), false);
  assert.equal(client.queries.some((q) => /UPDATE public\.(check_intake_items|claims|loss_draft_tracking|signature_requests)/.test(String(q.sql))), false);
});

test('relink returns the function\'s result, including old_claim_remaining_check_count; the API itself writes nothing else', async () => {
  const client = mockClient({ rpcResult: RELINKED });
  const result = await call(client, { p_check_id: CHECK_ID, p_claim_number: '695064-GQ', p_action: 'RELINK' });
  assert.equal(result.data.code, 'relinked');
  assert.equal(result.data.old_claim_remaining_check_count, 1);
  assert.equal(result.data.loss_draft_rows_moved, 1);
  assert.equal(result.data.signature_request_rows_moved, 2);
  assert.deepEqual(rpcCall(client).params, [CHECK_ID, FREEDOM, '695064-GQ', 'relink', APP_ID]);
  assert.equal(client.queries.filter((q) => /^\s*(UPDATE|INSERT|DELETE)/i.test(String(q.sql))).length, 0);
});

test('inspect no_match and unchanged are answers, not refusals', async () => {
  const noMatch = { ok: true, persisted: false, code: 'no_match', claim_id: null, claim_number: 'CL-NEW', check_claim_id: OLD_CLAIM };
  const a = await call(mockClient({ rpcResult: noMatch }), { p_check_id: CHECK_ID, p_claim_number: 'CL-NEW', p_action: 'inspect' });
  assert.deepEqual(a.data, noMatch);
  const unchanged = { ok: true, persisted: false, code: 'unchanged', claim_id: OLD_CLAIM, claim_number: 'CL-OLD', check_claim_id: OLD_CLAIM };
  const b = await call(mockClient({ rpcResult: unchanged }), { p_check_id: CHECK_ID, p_claim_number: 'cl old', p_action: 'relink' });
  assert.deepEqual(b.data, unchanged);
});

test('only inspect and relink are accepted; check id and claim number are required', async () => {
  for (const action of ['link_existing', 'create_new', 'rename', '', undefined]) {
    const client = mockClient();
    const result = await call(client, { p_check_id: CHECK_ID, p_claim_number: 'CL', p_action: action });
    assert.equal(result.error, 'invalid_field', String(action));
    assert.equal(result.field, 'p_action');
    assert.equal(client.queries.length, 0, 'nothing read for a bad action');
  }
  assert.equal((await call(mockClient(), { p_check_id: 'nope', p_claim_number: 'CL', p_action: 'inspect' })).error, 'invalid_uuid');
  for (const claim of [undefined, '', '   ', 42]) {
    const result = await call(mockClient(), { p_check_id: CHECK_ID, p_claim_number: claim, p_action: 'inspect' });
    assert.equal(result.error, 'missing_required_field', String(claim));
    assert.equal(result.field, 'p_claim_number');
  }
});

test('non-member, tenantless or unreadable check never reaches the function', async () => {
  const nonMember = mockClient({ member: false, roles: [] });
  assert.equal((await call(nonMember, { p_check_id: CHECK_ID, p_claim_number: 'CL', p_action: 'relink' })).error, 'not_authorized');
  assert.equal(rpcCall(nonMember), undefined);
  const tenantless = mockClient({ check: { id: CHECK_ID, tenant_id: null, claim_id: OLD_CLAIM } });
  assert.equal((await call(tenantless, { p_check_id: CHECK_ID, p_claim_number: 'CL', p_action: 'inspect' })).error, 'not_authorized');
  assert.equal(rpcCall(tenantless), undefined);
  const missing = mockClient({ check: null });
  assert.equal((await call(missing, { p_check_id: CHECK_ID, p_claim_number: 'CL', p_action: 'inspect' })).error, 'rls_denied');
  assert.equal(rpcCall(missing), undefined);
});

test('each SQL 167 refusal maps to its own 4xx status and message', async () => {
  const expected = {
    invalid_args: 400,
    invalid_action: 400,
    actor_required: 403,
    check_not_found: 404,
    tenant_mismatch: 403,
    locked: 409,
    not_linked: 409,
    ambiguous: 409,
    cross_tenant: 409,
    no_match: 409,
  };
  assert.deepEqual(Object.keys(CLAIM_LEDGER_RELINK_REFUSALS).sort(), Object.keys(expected).sort());
  for (const [code, statusCode] of Object.entries(expected)) {
    const refusal = { ok: false, persisted: false, code };
    const result = await call(mockClient({ rpcResult: refusal }), { p_check_id: CHECK_ID, p_claim_number: 'CL', p_action: 'relink' });
    assert.equal(result.error, code);
    assert.equal(result.statusCode, statusCode, code);
    assert.equal(result.message, CLAIM_LEDGER_RELINK_REFUSALS[code].message);
    assert.deepEqual(result.result, refusal);
  }
  assert.match(CLAIM_LEDGER_RELINK_REFUSALS.locked.message, /deposited/);
  const unknown = await call(mockClient({ rpcResult: { ok: false, code: 'something_new' } }), { p_check_id: CHECK_ID, p_claim_number: 'CL', p_action: 'inspect' });
  assert.equal(unknown.error, 'something_new');
  assert.equal(unknown.statusCode, 409);
});

test('function missing (SQL 167 not applied) is 503; a lost race is 409; anything else is rethrown', async () => {
  const missing = Object.assign(new Error('function public.claim_ledger_relink_check does not exist'), { code: '42883' });
  const a = await call(mockClient({ rpcError: missing }), { p_check_id: CHECK_ID, p_claim_number: 'CL', p_action: 'inspect' });
  assert.deepEqual([a.error, a.statusCode], ['claim_ledger_relink_unavailable', 503]);
  const race = Object.assign(new Error('claim_ledger_relink_failed'), { code: 'P0001' });
  const b = await call(mockClient({ rpcError: race }), { p_check_id: CHECK_ID, p_claim_number: 'CL', p_action: 'relink' });
  assert.deepEqual([b.error, b.statusCode], ['claim_ledger_relink_failed', 409]);
  const other = Object.assign(new Error('boom'), { code: '57014' });
  await assert.rejects(call(mockClient({ rpcError: other }), { p_check_id: CHECK_ID, p_claim_number: 'CL', p_action: 'relink' }), /boom/);
});

test('HTTP /data/rpc: inspect 200, relink commits, locked is a 409 that rolls back, unknown RPC stays disabled', async () => {
  const inspectClient = mockClient();
  const inspect = await handleSafeWriteRpc(jwtEvent('/data/rpc', 'POST', {
    name: 'claim_ledger_relink_check',
    args: { p_check_id: CHECK_ID, p_claim_number: '695064-GQ', p_action: 'inspect' },
  }), depsFor(inspectClient));
  assert.equal(inspect.ok, true);
  assert.equal(inspect.data.code, 'relink_available');

  const relinkClient = mockClient({ rpcResult: RELINKED });
  const relink = await handleSafeWriteRpc(jwtEvent('/data/rpc', 'POST', {
    name: 'public.claim_ledger_relink_check',
    args: { p_check_id: CHECK_ID, p_claim_number: '695064-GQ', p_action: 'relink', p_tenant_id: OTHER_TENANT },
  }), depsFor(relinkClient));
  assert.equal(relink.ok, true);
  assert.equal(relink.data.old_claim_remaining_check_count, 1);
  assert.deepEqual(rpcCall(relinkClient).params.slice(1, 2), [FREEDOM]);
  assert.ok(relinkClient.queries.some((q) => q.sql === 'COMMIT'));

  const lockedClient = mockClient({ rpcResult: { ok: false, persisted: false, code: 'locked' } });
  const locked = await handleSafeWriteRpc(jwtEvent('/data/rpc', 'POST', {
    name: 'claim_ledger_relink_check',
    args: { p_check_id: CHECK_ID, p_claim_number: '695064-GQ', p_action: 'relink' },
  }), depsFor(lockedClient));
  assert.equal(locked.ok, false);
  assert.equal(locked.statusCode, 409);
  assert.equal(locked.error, 'locked');
  assert.match(locked.message, /deposited/);
  assert.equal(lockedClient.queries.some((q) => q.sql === 'COMMIT'), false);
  assert.ok(lockedClient.queries.some((q) => q.sql === 'ROLLBACK'));

  const badAction = await handleSafeWriteRpc(jwtEvent('/data/rpc', 'POST', {
    name: 'claim_ledger_relink_check',
    args: { p_check_id: CHECK_ID, p_claim_number: '695064-GQ', p_action: 'create_new' },
  }), depsFor(mockClient()));
  assert.equal(badAction.statusCode, 400);

  const disabled = await handleSafeWriteRpc(jwtEvent('/data/rpc', 'POST', {
    name: 'claim_ledger_relink_any',
    args: {},
  }), depsFor(mockClient()));
  assert.equal(disabled.statusCode, 403);
  assert.equal(disabled.error, 'rpc_disabled');
});
