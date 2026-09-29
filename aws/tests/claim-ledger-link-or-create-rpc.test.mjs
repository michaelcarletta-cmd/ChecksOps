import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleWrite } from '../functions/api/write.mjs';
import {
  CLAIM_LEDGER_LINK_OR_CREATE_SQL,
  SAFE_WRITE_RPCS,
  executeSafeWriteRpc,
  handleSafeWriteRpc,
} from '../functions/api/workflow-rpc.mjs';
import { LOOKUP_MAPPING_SQL, USER_ROLES_SQL } from '../functions/api/identity.mjs';
import { INTAKE_PROHIBITED_COLUMNS, WRITE_ALLOWLIST, pickAllowlistedValues } from '../functions/api/write-allowlist.mjs';

const APP_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const CHECK_ID = '8d2b1c3e-4f5a-4678-9abc-def012345678';
const CLAIM_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const OTHER_TENANT = '99999999-9999-4999-8999-999999999999';

const jwtEvent = (path, method, body) => ({
  rawPath: path,
  headers: { authorization: 'Bearer test-id-token' },
  body: body ? JSON.stringify(body) : undefined,
  requestContext: {
    stage: 'staging',
    http: { method, path },
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

const mockClient = ({
  check = { id: CHECK_ID, tenant_id: FREEDOM, claim_id: null, deposited_at: null, check_stage: 'review' },
  member = true,
  roles = [{ role: 'staff' }],
  rpcResult = { ok: true, code: 'created', created: true, linked: true, claim_id: CLAIM_ID, check_claim_id: CLAIM_ID },
} = {}) => {
  const queries = [];
  return {
    queries,
    connect: async () => {},
    end: async () => {},
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT' || sql === 'SET TRANSACTION READ WRITE') {
        return { rows: [] };
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
      if (sql === CLAIM_LEDGER_LINK_OR_CREATE_SQL) {
        return { rows: [{ result: rpcResult }] };
      }
      if (/review_save_detected_claim_number/.test(sql)) {
        return { rows: [{ result: { ok: true, persisted: true, code: 'written', detected_claim_number: params[2] } }] };
      }
      if (/SELECT \* FROM public.check_intake_items WHERE id =/.test(sql)) {
        return { rows: [{ id: params[0], detected_claim_number: 'REVIEW-OK', claim_id: CLAIM_ID }] };
      }
      if (/SELECT id, tenant_id FROM public.check_intake_items/.test(sql)) {
        return { rows: [{ id: params[0], tenant_id: FREEDOM }] };
      }
      if (/UPDATE public.claims/.test(sql)) {
        return { rows: [{ id: params[0], claim_number: params[1] }] };
      }
      if (/FROM public.claims WHERE id =/.test(sql)) {
        return { rows: [{ id: params[0], org_id: FREEDOM, claim_number: 'OLD' }] };
      }
      return { rows: [] };
    },
  };
};

test('Claim Ledger RPC is allowlisted and generic insert/claim_id stay blocked', () => {
  assert.equal(SAFE_WRITE_RPCS.has('claim_ledger_link_or_create'), true);
  assert.equal(WRITE_ALLOWLIST.claims.ops.has('insert'), false);
  assert.equal(WRITE_ALLOWLIST.claims.ops.has('update'), true);
  assert.equal(INTAKE_PROHIBITED_COLUMNS.has('claim_id'), true);
  const genericClaimId = pickAllowlistedValues('check_intake_items', { claim_id: CLAIM_ID });
  assert.equal(genericClaimId.error, 'column_not_allowlisted');
  const genericInsert = WRITE_ALLOWLIST.claims.ops.has('insert');
  assert.equal(genericInsert, false);
});

test('already-linked inspect returns existing claim and does not create', async () => {
  const client = mockClient({
    check: { id: CHECK_ID, tenant_id: FREEDOM, claim_id: CLAIM_ID, deposited_at: null, check_stage: 'review' },
    rpcResult: {
      ok: true,
      code: 'already_linked',
      created: false,
      linked: false,
      claim_id: CLAIM_ID,
      check_claim_id: CLAIM_ID,
    },
  });
  const result = await executeSafeWriteRpc({
    client,
    mapping: { application_user_id: APP_ID },
    name: 'claim_ledger_link_or_create',
    args: { p_check_id: CHECK_ID, p_claim_number: 'CL-NEW', p_action: 'create_new' },
  });
  assert.equal(result.data.code, 'already_linked');
  assert.equal(result.data.claim_id, CLAIM_ID);
  assert.equal(result.data.created, false);
  const rpc = client.queries.find((q) => q.sql === CLAIM_LEDGER_LINK_OR_CREATE_SQL);
  assert.ok(rpc);
  assert.equal(rpc.params[1], FREEDOM);
  assert.equal(client.queries.some((q) => /INSERT INTO public\.claims/.test(String(q.sql))), false);
});

test('unlinked existing claim can link and uses check tenant not client tenant', async () => {
  const client = mockClient({
    rpcResult: {
      ok: true,
      code: 'linked',
      created: false,
      linked: true,
      claim_id: CLAIM_ID,
      check_claim_id: CLAIM_ID,
    },
  });
  const result = await executeSafeWriteRpc({
    client,
    mapping: { application_user_id: APP_ID },
    name: 'claim_ledger_link_or_create',
    args: {
      p_check_id: CHECK_ID,
      p_tenant_id: OTHER_TENANT,
      p_claim_number: 'CL-EXIST',
      p_action: 'link_existing',
    },
  });
  assert.equal(result.data.code, 'linked');
  assert.equal(result.data.check_claim_id, result.data.claim_id);
  const rpc = client.queries.find((q) => q.sql === CLAIM_LEDGER_LINK_OR_CREATE_SQL);
  assert.equal(rpc.params[0], CHECK_ID);
  assert.equal(rpc.params[1], FREEDOM);
  assert.equal(rpc.params[2], 'CL-EXIST');
  assert.equal(rpc.params[3], 'link_existing');
});

test('unlinked nonexistent claim number can explicitly create', async () => {
  const client = mockClient({
    rpcResult: {
      ok: true,
      code: 'created',
      created: true,
      linked: true,
      persisted: true,
      claim_id: CLAIM_ID,
      check_claim_id: CLAIM_ID,
    },
  });
  const result = await executeSafeWriteRpc({
    client,
    mapping: { application_user_id: APP_ID },
    name: 'claim_ledger_link_or_create',
    args: { p_check_id: CHECK_ID, p_claim_number: 'CL-NEW', p_action: 'create_new' },
  });
  assert.equal(result.data.code, 'created');
  assert.equal(result.data.created, true);
  assert.equal(result.data.linked, true);
  assert.equal(result.data.check_claim_id, result.data.claim_id);
});

test('duplicate / existing_found create is rejected', async () => {
  const client = mockClient({
    rpcResult: { ok: false, code: 'existing_found', created: false, linked: false, claim_id: CLAIM_ID },
  });
  const result = await executeSafeWriteRpc({
    client,
    mapping: { application_user_id: APP_ID },
    name: 'claim_ledger_link_or_create',
    args: { p_check_id: CHECK_ID, p_claim_number: 'CL-EXIST', p_action: 'create_new' },
  });
  assert.equal(result.error, 'existing_found');
  assert.equal(result.result.created, false);
});

test('cross-tenant existing claim cannot be linked', async () => {
  const client = mockClient({
    rpcResult: { ok: false, code: 'cross_tenant', created: false, linked: false },
  });
  const result = await executeSafeWriteRpc({
    client,
    mapping: { application_user_id: APP_ID },
    name: 'claim_ledger_link_or_create',
    args: { p_check_id: CHECK_ID, p_claim_number: 'CL-OTHER', p_action: 'link_existing' },
  });
  assert.equal(result.error, 'cross_tenant');
});

test('non-member cannot call Claim Ledger RPC', async () => {
  const client = mockClient({ member: false, roles: [] });
  const result = await executeSafeWriteRpc({
    client,
    mapping: { application_user_id: APP_ID },
    name: 'claim_ledger_link_or_create',
    args: { p_check_id: CHECK_ID, p_claim_number: 'CL-NEW', p_action: 'inspect' },
  });
  assert.equal(result.error, 'not_authorized');
  assert.equal(client.queries.some((q) => q.sql === CLAIM_LEDGER_LINK_OR_CREATE_SQL), false);
});

test('generic claims INSERT and claim_id UPDATE remain blocked', async () => {
  const client = mockClient();
  const insert = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'claims',
    op: 'insert',
    values: { claim_number: 'SHOULD-NOT-INSERT', status: 'tracking', org_id: FREEDOM },
  }), depsFor(client));
  assert.equal(insert.statusCode, 403);
  assert.equal(insert.error, 'operation_not_allowlisted');

  const claimIdWrite = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'check_intake_items',
    op: 'update',
    values: { claim_id: CLAIM_ID },
    filters: [{ column: 'id', op: 'eq', value: CHECK_ID }],
  }), depsFor(client));
  assert.equal(claimIdWrite.statusCode, 403);
  assert.equal(claimIdWrite.error, 'column_not_allowlisted');
  assert.ok(claimIdWrite.columns.includes('claim_id'));
});

test('#455 Review Save still routes to review RPC and #532 linked update stays update-only', async () => {
  const reviewClient = mockClient();
  const review = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'check_intake_items',
    op: 'update',
    values: { detected_claim_number: 'REVIEW-OK' },
    filters: [{ column: 'id', op: 'eq', value: CHECK_ID }],
  }), depsFor(reviewClient));
  assert.equal(review.ok, true);
  assert.ok(reviewClient.queries.some((q) => String(q.sql).includes('review_save_detected_claim_number')));
  assert.equal(reviewClient.queries.some((q) => String(q.sql).includes('claim_ledger_link_or_create')), false);

  const updateClient = mockClient();
  const updated = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'claims',
    op: 'update',
    values: { claim_number: 'CL-RENAME' },
    filters: [{ column: 'id', op: 'eq', value: CLAIM_ID }],
  }), depsFor(updateClient));
  assert.equal(updated.ok, true);
  assert.equal(updateClient.queries.some((q) => /INSERT INTO public\.claims/.test(String(q.sql))), false);
});

test('HTTP /data/rpc inspect succeeds and unknown RPC stays disabled', async () => {
  const client = mockClient({
    rpcResult: { ok: true, code: 'no_match', can_create: true, created: false, linked: false },
  });
  const inspect = await handleSafeWriteRpc(jwtEvent('/data/rpc', 'POST', {
    name: 'claim_ledger_link_or_create',
    args: { p_check_id: CHECK_ID, p_claim_number: 'CL-NEW', p_action: 'inspect' },
  }), depsFor(client));
  assert.equal(inspect.ok, true);
  assert.equal(inspect.data.code, 'no_match');

  const disabled = await handleSafeWriteRpc(jwtEvent('/data/rpc', 'POST', {
    name: 'create_claim_for_staff',
    args: { p_claim_number: 'NOPE' },
  }), depsFor(mockClient()));
  assert.equal(disabled.statusCode, 403);
  assert.equal(disabled.error, 'rpc_disabled');
});
