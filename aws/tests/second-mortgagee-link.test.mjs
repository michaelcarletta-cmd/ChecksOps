// Send to Mortgage Desk, 2nd mortgagee (owner 2026-11-10 "build the second-mortgagee fix", SQL 148).
// The screen used to UPDATE the 1st request to endorsement_order 1 / total_mortgagees 2 through
// /data/write, which is refused (no tenant UPDATE grant or policy on those columns, SQL 100; the
// API refuses them on update) and the error was ignored. It now calls the link_second_mortgagee
// RPC, which runs SQL 148's aws_link_second_mortgagee as the verified sign-in in one transaction.
// The database behaviour is proven in sql148-second-mortgagee-link-pg.test.mjs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { LOOKUP_MAPPING_SQL, USER_ROLES_SQL } from '../functions/api/identity.mjs';
import {
  LINK_SECOND_MORTGAGEE_SQL,
  SAFE_WRITE_RPC_CLASSIFICATION,
  SAFE_WRITE_RPCS,
  executeSafeWriteRpc,
  handleSafeWriteRpc,
  mapLinkSecondMortgageeError,
} from '../functions/api/workflow-rpc.mjs';

const APP_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const FIRST = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SECOND = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const CHECK_ID = '8d2b1c3e-4f5a-4678-9abc-def012345678';
const LINKED = {
  first_request_id: FIRST, second_request_id: SECOND, check_intake_item_id: CHECK_ID, first_changed: true, second_changed: false,
};

const jwtEvent = (body) => ({
  rawPath: '/data/rpc',
  headers: { authorization: 'Bearer test-id-token' },
  body: JSON.stringify(body),
  requestContext: {
    stage: 'staging',
    http: { method: 'POST', path: '/data/rpc' },
    authorizer: { jwt: { claims: { sub: COGNITO_SUB, email: 'checksops-tester@example.com', token_use: 'id' } } },
  },
});

const pgError = (message, code) => Object.assign(new Error(message), { code });

const mockClient = ({ answer = () => ({ rows: [{ result: LINKED }] }) } = {}) => {
  const queries = [];
  return {
    queries,
    connect: async () => {},
    end: async () => {},
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (['BEGIN', 'ROLLBACK', 'COMMIT', 'SET TRANSACTION READ WRITE'].includes(sql)) return { rows: [] };
      if (sql.startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
      if (sql === LOOKUP_MAPPING_SQL) {
        return { rows: [{ application_user_id: APP_ID, cognito_sub: COGNITO_SUB, email: 'checksops-tester@example.com', status: 'active' }] };
      }
      if (sql === USER_ROLES_SQL) return { rows: [] };
      if (sql === LINK_SECOND_MORTGAGEE_SQL) return answer(params);
      throw new Error(`unexpected SQL in test: ${sql}`);
    },
  };
};

const depsFor = (client) => ({
  forceEnabled: true,
  loadDatabaseCredentials: async () => ({
    username: 'checksops', password: 'unit-test-only-not-a-real-secret', host: 'db.example.internal', database: 'checksops',
  }),
  createClient: () => client,
});

const call = (client, args) => handleSafeWriteRpc(jwtEvent({ name: 'link_second_mortgagee', args }), depsFor(client));

test('link_second_mortgagee is a safe write RPC that calls only SQL 148\'s DEFINER', () => {
  assert.equal(SAFE_WRITE_RPCS.has('link_second_mortgagee'), true);
  assert.equal(SAFE_WRITE_RPC_CLASSIFICATION.link_second_mortgagee, 'safe_now');
  assert.equal(LINK_SECOND_MORTGAGEE_SQL, 'SELECT public.aws_link_second_mortgagee($1::uuid, $2::uuid) AS result');
  // The SQL file grants EXECUTE to the API login only.
  const sql = readFileSync(new URL('../workflows/sql/148_second_mortgagee_link.sql', import.meta.url), 'utf8');
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.aws_link_second_mortgagee\(uuid, uuid\) TO checksops;\s*$/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.aws_link_second_mortgagee\(uuid, uuid\) FROM PUBLIC;/);
});

test('link_second_mortgagee: one DEFINER call as the verified sign-in, committed, the function\'s answer as data', async () => {
  const client = mockClient();
  const result = await call(client, { p_first_request_id: FIRST, p_second_request_id: SECOND });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.data, LINKED);
  assert.equal(result.applicationUserId, APP_ID);
  const calls = client.queries.filter((q) => q.sql === LINK_SECOND_MORTGAGEE_SQL);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, [FIRST, SECOND]);
  // The DEFINER reads auth.uid() from request.app_user_id, set before the call.
  const guc = client.queries.findIndex((q) => q.sql.startsWith('SELECT set_config') && q.params?.[1] === APP_ID);
  assert.ok(guc >= 0 && guc < client.queries.indexOf(calls[0]));
  assert.equal(client.queries.some((q) => q.sql === 'COMMIT'), true);
  // No direct UPDATE of the request rows from the API.
  assert.equal(client.queries.some((q) => /UPDATE public\.mortgage_handling_requests/.test(q.sql)), false);
});

test('link_second_mortgagee: malformed or identical ids are refused before any SQL', async () => {
  for (const [args, field] of [
    [{ p_first_request_id: 'nope', p_second_request_id: SECOND }, 'p_first_request_id'],
    [{ p_first_request_id: FIRST }, 'p_second_request_id'],
    [{ p_first_request_id: FIRST, p_second_request_id: FIRST }, 'p_second_request_id'],
  ]) {
    const client = mockClient();
    const result = await call(client, args);
    assert.equal(result.ok, false, JSON.stringify(args));
    assert.equal(result.statusCode, 400);
    assert.equal(result.field, field);
    assert.equal(client.queries.some((q) => q.sql === LINK_SECOND_MORTGAGEE_SQL), false);
    assert.equal(client.queries.some((q) => q.sql === 'COMMIT'), false);
  }
});

test('link_second_mortgagee: SQL 148\'s refusals become API answers and nothing is committed', async () => {
  for (const [error, expect] of [
    [pgError('mortgagee_link_forbidden', '42501'), { statusCode: 403, error: 'mortgagee_link_forbidden' }],
    [pgError('mortgagee_link_request_not_found', 'P0002'), { statusCode: 403, error: 'rls_denied' }],
    [pgError('mortgagee_link_invalid: different check', '22023'), { statusCode: 400, error: 'invalid_field', message: 'Cannot link these requests: different check' }],
    [pgError('mortgagee_link_conflict', '23505'), { statusCode: 409, error: 'mortgagee_link_conflict' }],
    [pgError('function public.aws_link_second_mortgagee(uuid, uuid) does not exist', '42883'), { statusCode: 503, error: 'mortgagee_link_unavailable' }],
  ]) {
    const client = mockClient({ answer: () => { throw error; } });
    const result = await call(client, { p_first_request_id: FIRST, p_second_request_id: SECOND });
    assert.equal(result.ok, false, error.message);
    for (const [key, value] of Object.entries(expect)) assert.equal(result[key], value, `${error.message}: ${key}`);
    assert.equal(client.queries.some((q) => q.sql === 'COMMIT'), false, error.message);
  }
  // Anything else is not swallowed.
  assert.throws(() => mapLinkSecondMortgageeError(pgError('deadlock detected', '40P01')), /deadlock detected/);
  const direct = await executeSafeWriteRpc({
    client: mockClient({ answer: () => ({ rows: [{ result: null }] }) }),
    mapping: { application_user_id: APP_ID },
    name: 'link_second_mortgagee',
    args: { p_first_request_id: FIRST, p_second_request_id: SECOND },
  });
  assert.deepEqual(direct, { error: 'mortgagee_link_failed' });
});

test('SendToMortgageDeskButton: links the 2nd mortgagee through the RPC instead of the refused direct update, and reports a failure', () => {
  const source = readFileSync(new URL('../../src/components/loss-draft/SendToMortgageDeskButton.tsx', import.meta.url), 'utf8');
  // The refused direct backfill is gone.
  assert.doesNotMatch(source, /\.update\(\{\s*endorsement_order:\s*1,\s*total_mortgagees:\s*2/);
  assert.doesNotMatch(source, /\.update\(/);
  // The insert returns the new request's id, and the RPC links it to the 1st.
  assert.match(source, /\.from\("mortgage_handling_requests"\)\.insert\(\{[\s\S]*?\} as any\)\.select\("id"\)\.maybeSingle\(\);/);
  assert.match(source, /\(supabase\.rpc as unknown as RpcCall\)\.call\(supabase, "link_second_mortgagee", \{\s*p_first_request_id: firstRequestId,\s*p_second_request_id: secondRequestId,\s*\}\)/);
  assert.match(source, /await linkSecondMortgagee\(firstRequest\.id, createdId\)/, 'link_second_mortgagee called with the 1st and the new request');
  // Only for a 2nd mortgagee, after the insert succeeded.
  const linkAt = source.indexOf('await linkSecondMortgagee(');
  assert.ok(source.lastIndexOf('if (isSecond && firstRequest?.id) {', linkAt) > source.indexOf('if (error) {'));
  // Its error is shown, not ignored.
  assert.match(source, /if \(linkErr\) linkError = /);
  assert.match(source, /if \(linkError\) \{\s*toast\(\{\s*title: "2nd mortgagee sent, but not linked to the 1st"/);
  assert.match(source, /variant: "destructive"/);
});
