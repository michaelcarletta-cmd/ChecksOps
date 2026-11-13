/**
 * Mortgage Desk API for SQL 163 (aws/functions/api/mortgage-desk-esign.mjs). Owner 2026-11-12: "the check did not show
 * for mortgage agent and it says check not linked from checksops. The check should be linked", "notes should show on
 * the mortgage agents side as well", "When sending homeowner link from mortgage desk, error missing_cognito_token. Fix
 * it."; 2026-11-13 "Start the desk fixes".
 *
 *   - workspace carries the request's check (with short-lived image URLs) and the homeowner timeline; check and
 *     homeowner_timeline are also single reads;
 *   - before SQL 163 is applied (42883) the workspace still answers: check null, timeline empty, sql163_unavailable,
 *     under a savepoint so the other reads are not aborted;
 *   - send_tracking_link: the gate first, a fresh 48-hex token, SQL 163 picks the homeowner on file (a client address
 *     is ignored), the invite email goes to that address from ChecksOps, the link is the app origin's /h/ledger/<token>;
 *     SQL 163's refusals map to 4xx; absent function -> 503 desk_link_unavailable;
 *   - the router: the actions are listed, send_tracking_link runs in a write transaction.
 * The SQL itself is aws/tests/sql163-mortgage-desk-check-timeline-homeowner-link-pg.test.mjs.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DESK_CHECK_FILES_SQL,
  DESK_HOMEOWNER_LINK_SQL,
  DESK_HOMEOWNER_TIMELINE_SQL,
  DESK_MESSAGES_SQL,
  DESK_REQUEST_CHECK_SQL,
  DESK_SIGNATURE_REQUESTS_SQL,
  MORTGAGE_DESK_ESIGN_ACTIONS,
  MORTGAGE_DESK_READ_ACTIONS,
  handleMortgageDeskEsign,
} from '../functions/api/mortgage-desk-esign.mjs';
import { MORTGAGE_DESK_REQUEST_SQL, PLATFORM_OWNER_SQL } from '../functions/api/mortgage-desk-return.mjs';
import { LOOKUP_MAPPING_SQL, USER_ROLES_SQL } from '../functions/api/identity.mjs';
import { s3KeyFor } from '../functions/api/storage-paths.mjs';

const AGENT = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const OTHER_AGENT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const CHECK_ID = '33333333-3333-4333-8333-333333333333';
const CLAIM_ID = '44444444-4444-4444-8444-444444444444';
const TENANT_A = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const TOKEN = 'ab'.repeat(24);

const sqlError = (message, code) => Object.assign(new Error(message), { code });
const CHECK_ROW = {
  check_id: CHECK_ID, claim_id: CLAIM_ID, amount: '1234.56', check_number: '4182', carrier_name: 'CARRIER', payee_line: 'PAYEE',
  payee_address: null, property_address: '1 Main St', issue_date: '2026-11-01', detected_claim_number: 'CL-1',
  front_image_path: `checks/${CHECK_ID}/front.jpg`, back_image_path: null, status: 'received', check_stage: 'review', funds_type: null,
};
const TIMELINE = [
  { event_id: 'e2', event_type: 'mortgage_followup', occurred_at: '2026-11-02T10:00:00Z', actor_label: 'Called Bank', note: 'spoke with Sarah', amount: null, from_desk: true },
  { event_id: 'e1', event_type: 'check_received', occurred_at: '2026-11-01T10:00:00Z', actor_label: 'Tenant', note: null, amount: '1234.56', from_desk: false },
];

const fakeClient = ({
  visibleRequest = { id: REQUEST_ID, tenant_id: TENANT_A, check_intake_item_id: CHECK_ID, status: 'in_progress', assigned_employee_id: AGENT },
  raise = {},
  link = { token: TOKEN, homeowner_email: 'owner@example.invalid', homeowner_name: 'Home Owner', tenant_id: TENANT_A, reused: false },
} = {}) => {
  const queries = [];
  const savepoints = [];
  return {
    queries,
    savepoints,
    connect: async () => {},
    end: async () => {},
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (['BEGIN', 'ROLLBACK', 'COMMIT', 'SET TRANSACTION READ WRITE'].includes(sql)) return { rows: [], command: sql };
      if (/^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)/.test(sql)) { savepoints.push(sql); return { rows: [] }; }
      if (sql.startsWith('SELECT set_config')) return { rows: [] };
      if (sql === LOOKUP_MAPPING_SQL) return { rows: [{ application_user_id: AGENT, cognito_sub: COGNITO_SUB, email: 'agent@checksops.test', status: 'active' }] };
      if (sql === USER_ROLES_SQL) return { rows: [{ role: 'mortgage_agent' }] };
      if (sql === PLATFORM_OWNER_SQL) return { rows: [{ is_owner: false }] };
      if (sql === MORTGAGE_DESK_REQUEST_SQL) return { rows: visibleRequest ? [visibleRequest] : [] };
      if (raise[sql]) throw raise[sql];
      if (sql === DESK_MESSAGES_SQL) return { rows: [{ id: 'm1', sender_id: AGENT, body: 'hello', created_at: '2026-10-28T10:00:00Z', from_desk: true }] };
      if (sql === DESK_CHECK_FILES_SQL) return { rows: [] };
      if (sql === DESK_SIGNATURE_REQUESTS_SQL) return { rows: [{ requests: [] }] };
      if (sql === DESK_REQUEST_CHECK_SQL) return { rows: [CHECK_ROW] };
      if (sql === DESK_HOMEOWNER_TIMELINE_SQL) return { rows: TIMELINE };
      if (sql === DESK_HOMEOWNER_LINK_SQL) return { rows: [link] };
      return { rows: [] };
    },
  };
};

const event = (body) => ({
  rawPath: '/functions/v1/mortgage-desk-esign',
  headers: { authorization: 'Bearer test-id-token' },
  body: JSON.stringify(body),
  requestContext: {
    stage: 'staging',
    http: { method: 'POST', path: '/functions/v1/mortgage-desk-esign' },
    authorizer: { jwt: { claims: { sub: COGNITO_SUB, email: 'agent@checksops.test', token_use: 'id' } } },
  },
});

const depsFor = (makeClient, extra = {}) => {
  const clients = [];
  return {
    clients,
    deps: {
      loadDatabaseCredentials: async () => ({ host: 'x', username: 'checksops', password: 'x', database: 'checksops' }),
      createClient: () => {
        const client = typeof makeClient === 'function' ? makeClient(clients.length) : makeClient;
        clients.push(client);
        return client;
      },
      filesBucket: 'files-bucket',
      s3: {},
      getSignedUrl: async (_s3, command) => `https://signed.example/${command.input.Key}`,
      ...extra,
    },
  };
};

test('the actions are listed: check and homeowner_timeline are reads, send_tracking_link is a write', () => {
  for (const action of ['check', 'homeowner_timeline']) assert.ok(MORTGAGE_DESK_READ_ACTIONS.includes(action), action);
  assert.ok(MORTGAGE_DESK_ESIGN_ACTIONS.includes('send_tracking_link'));
  assert.ok(!MORTGAGE_DESK_READ_ACTIONS.includes('send_tracking_link'));
});

test('workspace carries the check (with read URLs for its images) and the homeowner timeline', async () => {
  const { deps, clients } = depsFor(() => fakeClient());
  const res = await handleMortgageDeskEsign(event({ action: 'workspace', request_id: REQUEST_ID }), deps);
  assert.equal(res.statusCode, 200, JSON.stringify(res));
  assert.equal(res.data.check.check_id, CHECK_ID);
  // The same key mapping as get-check-image-urls (storage-paths.mjs s3KeyFor, claim-files).
  assert.equal(res.data.check.front_url, `https://signed.example/${s3KeyFor('claim-files', CHECK_ROW.front_image_path)}`);
  assert.equal(res.data.check.back_url, null);
  assert.deepEqual(res.data.homeowner_timeline, TIMELINE);
  assert.equal(res.data.messages.length, 1);
  assert.equal(res.sql163_unavailable, undefined);
  // The request id passed to SQL 163 is the gated request's, never a client value.
  const calls = clients[0].queries.filter((q) => [DESK_REQUEST_CHECK_SQL, DESK_HOMEOWNER_TIMELINE_SQL].includes(q.sql));
  assert.deepEqual(calls.map((q) => q.params), [[REQUEST_ID], [REQUEST_ID]]);
  const single = await handleMortgageDeskEsign(event({ action: 'check', request_id: REQUEST_ID }), depsFor(() => fakeClient()).deps);
  assert.equal(single.data.check_id, CHECK_ID);
  const tl = await handleMortgageDeskEsign(event({ action: 'homeowner_timeline', request_id: REQUEST_ID }), depsFor(() => fakeClient()).deps);
  assert.deepEqual(tl.data, TIMELINE);
});

test('before SQL 163 is applied the workspace still answers (check null, timeline empty), the failed call rolled back to its savepoint', async () => {
  const absent = sqlError('function public.aws_mortgage_desk_request_check(uuid) does not exist', '42883');
  const absentTl = sqlError('function public.aws_mortgage_desk_homeowner_timeline(uuid) does not exist', '42883');
  const { deps, clients } = depsFor(() => fakeClient({ raise: { [DESK_REQUEST_CHECK_SQL]: absent, [DESK_HOMEOWNER_TIMELINE_SQL]: absentTl } }));
  const res = await handleMortgageDeskEsign(event({ action: 'workspace', request_id: REQUEST_ID }), deps);
  assert.equal(res.statusCode, 200, JSON.stringify(res));
  assert.equal(res.data.check, null);
  assert.deepEqual(res.data.homeowner_timeline, []);
  assert.equal(res.sql163_unavailable, true);
  assert.equal(res.data.messages.length, 1);
  assert.deepEqual(clients[0].savepoints, ['SAVEPOINT desk_sql163', 'ROLLBACK TO SAVEPOINT desk_sql163', 'SAVEPOINT desk_sql163', 'ROLLBACK TO SAVEPOINT desk_sql163']);
  // Any other database error is not swallowed.
  const broken = depsFor(() => fakeClient({ raise: { [DESK_REQUEST_CHECK_SQL]: sqlError('connection reset', '08006') } }));
  const failed = await handleMortgageDeskEsign(event({ action: 'workspace', request_id: REQUEST_ID }), broken.deps);
  assert.notEqual(failed.statusCode, 200);
  // SQL 124's refusal from inside SQL 163 is a 4xx.
  const refused = depsFor(() => fakeClient({ raise: { [DESK_REQUEST_CHECK_SQL]: sqlError('not_assigned_to_you', '42501') } }));
  const no = await handleMortgageDeskEsign(event({ action: 'check', request_id: REQUEST_ID }), refused.deps);
  assert.equal(no.statusCode, 403);
  assert.equal(no.error, 'not_assigned_to_you');
});

test('send_tracking_link: the homeowner on file, a fresh token, the invite from ChecksOps; a client address is ignored', async () => {
  const sent = [];
  const { deps, clients } = depsFor(() => fakeClient(), {
    randomBytes: (n) => Buffer.alloc(n, 0xab),
    resolveEmailBranding: async (_client, opts) => ({ from: 'ChecksOps <no-reply@checksops.test>', replyTo: null, senderOverride: opts.senderOverride }),
    sendViaSesOrSink: async (msg) => { sent.push(msg); return { ok: true }; },
  });
  const res = await handleMortgageDeskEsign(event({
    action: 'send_tracking_link', request_id: REQUEST_ID, homeowner_email: 'attacker@example.invalid', origin: 'https://evil.example',
  }), deps);
  assert.equal(res.statusCode, 200, JSON.stringify(res));
  assert.equal(res.sentTo, 'owner@example.invalid');
  assert.equal(res.reused, false);
  assert.match(res.url, new RegExp(`/h/ledger/${TOKEN}$`));
  assert.doesNotMatch(res.url, /evil\.example/, 'only an allow-listed origin');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'owner@example.invalid');
  assert.match(sent[0].html, new RegExp(TOKEN));
  const call = clients[0].queries.find((q) => q.sql === DESK_HOMEOWNER_LINK_SQL);
  assert.deepEqual(call.params, [REQUEST_ID, TOKEN]);
  assert.ok(clients[0].queries.some((q) => q.sql === 'COMMIT'), 'the token commits');
});

test('send_tracking_link refusals: SQL 163 codes as 4xx, the gate before any token, absent function 503; no email', async () => {
  const sent = [];
  const extra = { sendViaSesOrSink: async (msg) => { sent.push(msg); }, resolveEmailBranding: async () => ({ from: 'x', replyTo: null }) };
  for (const [message, code, status] of [['no_homeowner_email', '22023', 409], ['request_has_no_claim', '22023', 409], ['claim_not_in_tenant', '42501', 403]]) {
    const { deps } = depsFor(() => fakeClient({ raise: { [DESK_HOMEOWNER_LINK_SQL]: sqlError(message, code) } }), extra);
    const res = await handleMortgageDeskEsign(event({ action: 'send_tracking_link', request_id: REQUEST_ID }), deps);
    assert.equal(res.statusCode, status, message);
    assert.equal(res.error, message);
  }
  const absent = depsFor(() => fakeClient({ raise: { [DESK_HOMEOWNER_LINK_SQL]: sqlError('function does not exist', '42883') } }), extra);
  const unavailable = await handleMortgageDeskEsign(event({ action: 'send_tracking_link', request_id: REQUEST_ID }), absent.deps);
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.error, 'desk_link_unavailable');
  // Another agent's request: the API gate refuses before SQL 163 is called.
  const other = depsFor(() => fakeClient({ visibleRequest: { id: REQUEST_ID, tenant_id: TENANT_A, check_intake_item_id: CHECK_ID, status: 'in_progress', assigned_employee_id: OTHER_AGENT } }), extra);
  const res = await handleMortgageDeskEsign(event({ action: 'send_tracking_link', request_id: REQUEST_ID }), other.deps);
  assert.equal(res.statusCode, 403);
  assert.ok(!other.clients[0].queries.some((q) => q.sql === DESK_HOMEOWNER_LINK_SQL));
  assert.equal(sent.length, 0);
});
