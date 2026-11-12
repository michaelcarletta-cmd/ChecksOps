/**
 * Tenant Management desk view through the API (SQL 158; owner 2026-11-12: "Tenant Management desk view plus 'Message
 * agent'", "If no agent then tenant management can assign", "Tenant management and the agent assigned can see the
 * notes", "Note is only visible to agent"):
 *
 *   - desk_overview / desk_agents / agent_notes: one SQL 158 read each, as the signed-in user, nothing committed; the
 *     input is checked before the database (tenant uuid, status, limit 1..500, offset >= 0); total_count becomes total;
 *   - assign_agent: SQL 158 c commits, then one notice email to the returned agent address (best effort: a failed or
 *     missing address never undoes the assignment); bad uuids never reach the database;
 *   - message_agent: SQL 158 d commits the note, the email carries the note to the agent, SQL 158 e records sent,
 *     failed or skipped once; a record failure is a 502 that says not to resend; refusals (no_assigned_agent,
 *     rate_limited, not_authorized) map to 409, 429, 403 and send nothing;
 *   - no email address or note text is ever echoed in the response.
 * SQL 158's own rules are proven on PostgreSQL 16 by aws/tests/sql158-mortgage-desk-oversight-pg.test.mjs.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DESK_ADD_AGENT_NOTE_SQL,
  DESK_AGENT_NOTES_SQL,
  DESK_ASSIGNABLE_AGENTS_SQL,
  DESK_ASSIGN_AGENT_SQL,
  DESK_OVERVIEW_SQL,
  DESK_RECORD_AGENT_NOTE_EMAIL_SQL,
  MORTGAGE_DESK_ESIGN_ACTIONS,
  deskAgentNoteEmail,
  deskAssignmentEmail,
  handleMortgageDeskEsign,
  validateDeskOverviewInput,
} from '../functions/api/mortgage-desk-esign.mjs';
import { LOOKUP_MAPPING_SQL, USER_ROLES_SQL } from '../functions/api/identity.mjs';

const OWNER = 'a1580000-0000-4000-8000-000000000001';
const COGNITO_SUB = 'c1580000-0000-4000-8000-000000000001';
const REQUEST_ID = 'd1580000-0000-4000-8000-000000000001';
const AGENT_ID = 'e1580000-0000-4000-8000-000000000001';
const TENANT_ID = 'f1580000-0000-4000-8000-000000000001';
const NOTE_ID = 'b1580000-0000-4000-8000-000000000001';
const AGENT_EMAIL = 'agent158@checksops.test';

const OVERVIEW_ROWS = [
  { request_id: REQUEST_ID, tenant_id: TENANT_ID, tenant_name: 'Owner Co', status: 'requested', seconds_in_status: 3600, total_count: '2' },
  { request_id: NOTE_ID, tenant_id: TENANT_ID, tenant_name: 'Owner Co', status: 'in_progress', seconds_in_status: 60, total_count: '2' },
];
const ASSIGNED = { request_id: REQUEST_ID, agent_id: AGENT_ID, agent_name: 'Avery Agent', agent_email: AGENT_EMAIL,
  accepted_at: '2026-11-12T15:00:00Z', tenant_name: 'Owner Co', mortgage_company: 'Big Bank', loan_number: '12345' };
const NOTE = { note_id: NOTE_ID, request_id: REQUEST_ID, agent_id: AGENT_ID, agent_name: 'Avery Agent', agent_email: AGENT_EMAIL,
  created_at: '2026-11-12T15:01:00Z', tenant_name: 'Owner Co', mortgage_company: 'Big Bank', loan_number: '12345' };

const sqlError = (message, code) => Object.assign(new Error(message), { code });

const fakeClient = ({ raise = {}, rows = {} } = {}) => {
  const queries = [];
  return {
    queries,
    connect: async () => {},
    end: async () => {},
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (['BEGIN', 'ROLLBACK', 'COMMIT', 'SET TRANSACTION READ WRITE'].includes(sql)) return { rows: [], command: sql };
      if (/^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)/.test(sql)) return { rows: [] };
      if (sql.startsWith('SELECT set_config')) return { rows: [] };
      if (sql === LOOKUP_MAPPING_SQL) {
        return { rows: [{ application_user_id: OWNER, cognito_sub: COGNITO_SUB, email: 'owner@checksops.test', status: 'active' }] };
      }
      if (sql === USER_ROLES_SQL) return { rows: [{ role: 'platform_owner' }] };
      if (raise[sql]) throw raise[sql];
      if (rows[sql]) return { rows: rows[sql] };
      if (sql === DESK_OVERVIEW_SQL) return { rows: OVERVIEW_ROWS };
      if (sql === DESK_ASSIGNABLE_AGENTS_SQL) return { rows: [{ agent_id: AGENT_ID, agent_name: 'Avery Agent', in_progress_count: 2 }] };
      if (sql === DESK_ASSIGN_AGENT_SQL) return { rows: [ASSIGNED] };
      if (sql === DESK_ADD_AGENT_NOTE_SQL) return { rows: [NOTE] };
      if (sql === DESK_RECORD_AGENT_NOTE_EMAIL_SQL) return { rows: [{ recorded: true }] };
      if (sql === DESK_AGENT_NOTES_SQL) return { rows: [{ note_id: NOTE_ID, body: 'Call the bank', email_status: 'sent' }] };
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
    authorizer: { jwt: { claims: { sub: COGNITO_SUB, email: 'owner@checksops.test', token_use: 'id' } } },
  },
});

const depsFor = (opts = {}, sendImpl = null) => {
  const clients = [];
  const sent = [];
  return {
    clients,
    sent,
    deps: {
      loadDatabaseCredentials: async () => ({ host: 'x', username: 'checksops', password: 'x', database: 'checksops' }),
      createClient: () => {
        const client = fakeClient(opts);
        clients.push(client);
        return client;
      },
      sendViaSesOrSink: async (message) => {
        sent.push(message);
        if (sendImpl) return sendImpl(message);
        return { results: [{ status: 'sent', messageId: 'm-1' }] };
      },
    },
  };
};

const bodyOf = (out) => (typeof out.body === 'string' ? JSON.parse(out.body) : out);
const allQueries = (clients) => clients.flatMap((c) => c.queries);
const callsOf = (clients, sql) => allQueries(clients).filter((q) => q.sql === sql);

test('the five SQL 158 actions are registered and call exactly the SQL 158 functions', () => {
  for (const action of ['desk_overview', 'desk_agents', 'assign_agent', 'message_agent', 'agent_notes']) {
    assert.ok(MORTGAGE_DESK_ESIGN_ACTIONS.includes(action), action);
  }
  assert.equal(DESK_OVERVIEW_SQL, 'SELECT * FROM public.aws_mortgage_desk_overview($1::uuid, $2::text, $3::integer, $4::integer)');
  assert.equal(DESK_ASSIGNABLE_AGENTS_SQL, 'SELECT * FROM public.aws_mortgage_desk_assignable_agents()');
  assert.equal(DESK_ASSIGN_AGENT_SQL, 'SELECT * FROM public.aws_mortgage_desk_assign_agent($1::uuid, $2::uuid)');
  assert.equal(DESK_ADD_AGENT_NOTE_SQL, 'SELECT * FROM public.aws_mortgage_desk_add_agent_note($1::uuid, $2::text)');
  assert.equal(DESK_RECORD_AGENT_NOTE_EMAIL_SQL, 'SELECT public.aws_mortgage_desk_record_agent_note_email($1::uuid, $2::text) AS recorded');
  assert.equal(DESK_AGENT_NOTES_SQL, 'SELECT * FROM public.aws_mortgage_desk_agent_notes($1::uuid)');
});

test('desk_overview: one read as the signed-in user with the checked filters; total from total_count; nothing committed', async () => {
  const { deps, clients } = depsFor();
  const out = bodyOf(await handleMortgageDeskEsign(event({ action: 'desk_overview', tenant_id: TENANT_ID, status: 'requested', limit: 50, offset: 100 }), deps));
  assert.equal(out.statusCode, 200, JSON.stringify(out));
  assert.equal(out.total, 2);
  assert.equal(out.data.length, 2);
  assert.ok(out.data.every((row) => !('total_count' in row)));
  assert.deepEqual(callsOf(clients, DESK_OVERVIEW_SQL).map((q) => q.params), [[TENANT_ID, 'requested', 50, 100]]);
  assert.ok(!allQueries(clients).some((q) => q.sql === 'COMMIT'));
  assert.ok(allQueries(clients).some((q) => q.sql.startsWith('SELECT set_config')), 'runs as the signed-in user');
  // Defaults: every tenant, every status, 200 rows from 0.
  const all = depsFor();
  assert.equal(bodyOf(await handleMortgageDeskEsign(event({ action: 'desk_overview' }), all.deps)).statusCode, 200);
  assert.deepEqual(callsOf(all.clients, DESK_OVERVIEW_SQL).map((q) => q.params), [[null, null, 200, 0]]);
  // An empty page has total 0.
  const empty = depsFor({ rows: { [DESK_OVERVIEW_SQL]: [] } });
  assert.equal(bodyOf(await handleMortgageDeskEsign(event({ action: 'desk_overview' }), empty.deps)).total, 0);
});

test('desk_overview: bad filters never reach the database; SQL 158 not_authorized is a 403', async () => {
  for (const bad of [{ tenant_id: 'nope' }, { status: 'cancelled' }, { limit: 0 }, { limit: 501 }, { limit: 2.5 }, { offset: -1 }, { offset: 'x' }]) {
    assert.equal(validateDeskOverviewInput(bad).ok, false, JSON.stringify(bad));
    const { deps, clients } = depsFor();
    const out = bodyOf(await handleMortgageDeskEsign(event({ action: 'desk_overview', ...bad }), deps));
    assert.equal(out.statusCode, 400, JSON.stringify(bad));
    assert.equal(callsOf(clients, DESK_OVERVIEW_SQL).length, 0);
  }
  const refused = depsFor({ raise: { [DESK_OVERVIEW_SQL]: sqlError('not_authorized', '42501') } });
  const out = bodyOf(await handleMortgageDeskEsign(event({ action: 'desk_overview' }), refused.deps));
  assert.equal(out.statusCode, 403);
  assert.equal(out.error, 'not_authorized');
});

test('desk_agents and agent_notes: one read each; agent_notes takes only the request id', async () => {
  const agents = depsFor();
  const a = bodyOf(await handleMortgageDeskEsign(event({ action: 'desk_agents', tenant_id: 'spoof' }), agents.deps));
  assert.equal(a.statusCode, 200);
  assert.equal(a.data[0].agent_id, AGENT_ID);
  assert.deepEqual(callsOf(agents.clients, DESK_ASSIGNABLE_AGENTS_SQL).map((q) => q.params), [[]]);
  const notes = depsFor();
  const n = bodyOf(await handleMortgageDeskEsign(event({ action: 'agent_notes', request_id: REQUEST_ID, agent_id: 'spoof' }), notes.deps));
  assert.equal(n.statusCode, 200);
  assert.deepEqual(callsOf(notes.clients, DESK_AGENT_NOTES_SQL).map((q) => q.params), [[REQUEST_ID]]);
  assert.ok(!allQueries(notes.clients).some((q) => q.sql === 'COMMIT'));
  const bad = depsFor();
  assert.equal(bodyOf(await handleMortgageDeskEsign(event({ action: 'agent_notes', request_id: 'nope' }), bad.deps)).statusCode, 403);
  assert.equal(callsOf(bad.clients, DESK_AGENT_NOTES_SQL).length, 0);
  const refused = depsFor({ raise: { [DESK_AGENT_NOTES_SQL]: sqlError('not_authorized', '42501') } });
  assert.equal(bodyOf(await handleMortgageDeskEsign(event({ action: 'agent_notes', request_id: REQUEST_ID }), refused.deps)).statusCode, 403);
});

test('assign_agent: SQL 158 c commits, then one notice email to the agent; the response names no address', async () => {
  const { deps, clients, sent } = depsFor();
  const out = bodyOf(await handleMortgageDeskEsign(event({ action: 'assign_agent', request_id: REQUEST_ID, agent_id: AGENT_ID }), deps));
  assert.equal(out.statusCode, 200, JSON.stringify(out));
  assert.equal(out.status, 'in_progress');
  assert.equal(out.agentId, AGENT_ID);
  assert.deepEqual(out.notice, { status: 'sent', error: null });
  assert.deepEqual(callsOf(clients, DESK_ASSIGN_AGENT_SQL).map((q) => q.params), [[REQUEST_ID, AGENT_ID]]);
  assert.ok(allQueries(clients).some((q) => q.sql === 'COMMIT'));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, AGENT_EMAIL);
  assert.equal(sent[0].messageCategory, 'mortgage-desk-assignment');
  assert.match(sent[0].subject, /assigned to you/);
  assert.doesNotMatch(JSON.stringify(out), new RegExp(AGENT_EMAIL));
});

test('assign_agent: a failed or missing email never undoes the assignment; refusals send nothing; bad uuids never reach the database', async () => {
  const failing = depsFor({}, () => ({ results: [{ status: 'failed', error: 'ses down' }] }));
  const f = bodyOf(await handleMortgageDeskEsign(event({ action: 'assign_agent', request_id: REQUEST_ID, agent_id: AGENT_ID }), failing.deps));
  assert.equal(f.statusCode, 200);
  assert.deepEqual(f.notice, { status: 'failed', error: 'ses down' });
  const noEmail = depsFor({ rows: { [DESK_ASSIGN_AGENT_SQL]: [{ ...ASSIGNED, agent_email: null }] } });
  const n = bodyOf(await handleMortgageDeskEsign(event({ action: 'assign_agent', request_id: REQUEST_ID, agent_id: AGENT_ID }), noEmail.deps));
  assert.equal(n.statusCode, 200);
  assert.equal(n.notice.status, 'skipped');
  assert.equal(noEmail.sent.length, 0);
  for (const [code, status] of [['already_taken', 409], ['agent_not_assignable', 400], ['not_found', 404], ['not_authorized', 403]]) {
    const refused = depsFor({ raise: { [DESK_ASSIGN_AGENT_SQL]: sqlError(code, 'P0001') } });
    const r = bodyOf(await handleMortgageDeskEsign(event({ action: 'assign_agent', request_id: REQUEST_ID, agent_id: AGENT_ID }), refused.deps));
    assert.equal(r.statusCode, status, code);
    assert.equal(r.error, code);
    assert.equal(refused.sent.length, 0, code);
  }
  for (const bad of [{ request_id: 'nope', agent_id: AGENT_ID }, { request_id: REQUEST_ID, agent_id: 'nope' }, { request_id: REQUEST_ID }]) {
    const b = depsFor();
    assert.equal(bodyOf(await handleMortgageDeskEsign(event({ action: 'assign_agent', ...bad }), b.deps)).statusCode, 400);
    assert.equal(callsOf(b.clients, DESK_ASSIGN_AGENT_SQL).length, 0);
    assert.equal(b.sent.length, 0);
  }
});

test('message_agent: the note commits, the email carries it to the agent, SQL 158 e records sent once', async () => {
  const { deps, clients, sent } = depsFor();
  const out = bodyOf(await handleMortgageDeskEsign(event({ action: 'message_agent', request_id: REQUEST_ID, body: '  Please call Big Bank today.  ' }), deps));
  assert.equal(out.statusCode, 200, JSON.stringify(out));
  assert.equal(out.noteId, NOTE_ID);
  assert.deepEqual(out.email, { status: 'sent', error: null });
  assert.equal(out.emailRecorded, true);
  assert.deepEqual(callsOf(clients, DESK_ADD_AGENT_NOTE_SQL).map((q) => q.params), [[REQUEST_ID, 'Please call Big Bank today.']]);
  assert.deepEqual(callsOf(clients, DESK_RECORD_AGENT_NOTE_EMAIL_SQL).map((q) => q.params), [[NOTE_ID, 'sent']]);
  // The note commits in its own transaction before the email; the record in a second one.
  assert.equal(allQueries(clients).filter((q) => q.sql === 'COMMIT').length, 2);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, AGENT_EMAIL);
  assert.equal(sent[0].messageCategory, 'mortgage-desk-agent-note');
  assert.ok(sent[0].text.includes('Please call Big Bank today.'));
  assert.doesNotMatch(JSON.stringify(out), new RegExp(`${AGENT_EMAIL}|Please call`));
});

test('message_agent: failed and skipped emails are recorded as such; a record failure is a 502 that says not to resend', async () => {
  const failing = depsFor({}, () => { throw new Error('boom'); });
  const f = bodyOf(await handleMortgageDeskEsign(event({ action: 'message_agent', request_id: REQUEST_ID, body: 'Hi' }), failing.deps));
  assert.equal(f.statusCode, 200);
  assert.equal(f.email.status, 'failed');
  assert.deepEqual(callsOf(failing.clients, DESK_RECORD_AGENT_NOTE_EMAIL_SQL).map((q) => q.params), [[NOTE_ID, 'failed']]);
  const noEmail = depsFor({ rows: { [DESK_ADD_AGENT_NOTE_SQL]: [{ ...NOTE, agent_email: '' }] } });
  const s = bodyOf(await handleMortgageDeskEsign(event({ action: 'message_agent', request_id: REQUEST_ID, body: 'Hi' }), noEmail.deps));
  assert.equal(s.email.status, 'skipped');
  assert.equal(noEmail.sent.length, 0);
  assert.deepEqual(callsOf(noEmail.clients, DESK_RECORD_AGENT_NOTE_EMAIL_SQL).map((q) => q.params), [[NOTE_ID, 'skipped']]);
  const unrecorded = depsFor({ raise: { [DESK_RECORD_AGENT_NOTE_EMAIL_SQL]: new Error('connection lost') } });
  const u = bodyOf(await handleMortgageDeskEsign(event({ action: 'message_agent', request_id: REQUEST_ID, body: 'Hi' }), unrecorded.deps));
  assert.equal(u.statusCode, 502, JSON.stringify(u));
  assert.equal(u.error, 'email_status_not_recorded');
  assert.match(u.message, /Do not resend/);
  assert.equal(u.noteId, NOTE_ID);
  assert.deepEqual(u.email, { status: 'sent', error: null });
  assert.equal(unrecorded.sent.length, 1, 'the email went out once and is not retried');
});

test('message_agent: refusals map and send nothing; empty or too-long text and bad ids never reach the database', async () => {
  for (const [code, status] of [['no_assigned_agent', 409], ['rate_limited', 429], ['not_authorized', 403], ['not_found', 404], ['invalid_body', 400]]) {
    const refused = depsFor({ raise: { [DESK_ADD_AGENT_NOTE_SQL]: sqlError(code, 'P0001') } });
    const r = bodyOf(await handleMortgageDeskEsign(event({ action: 'message_agent', request_id: REQUEST_ID, body: 'Hi' }), refused.deps));
    assert.equal(r.statusCode, status, code);
    assert.equal(refused.sent.length, 0, code);
    assert.equal(callsOf(refused.clients, DESK_RECORD_AGENT_NOTE_EMAIL_SQL).length, 0, code);
  }
  for (const bad of [{ request_id: REQUEST_ID, body: '   ' }, { request_id: REQUEST_ID, body: 'x'.repeat(2001) }, { request_id: 'nope', body: 'Hi' }]) {
    const b = depsFor();
    const out = bodyOf(await handleMortgageDeskEsign(event({ action: 'message_agent', ...bad }), b.deps));
    assert.ok([400, 403].includes(out.statusCode), JSON.stringify(out));
    assert.equal(callsOf(b.clients, DESK_ADD_AGENT_NOTE_SQL).length, 0);
    assert.equal(b.sent.length, 0);
  }
});

test('emails: the note text and request label are HTML-escaped; the assignment notice carries no note or homeowner data', () => {
  const note = deskAgentNoteEmail({ ...NOTE, tenant_name: '<b>Owner</b>' }, '<script>x</script>', 'https://staging.checksops.com/mortgage-ops/queue');
  assert.doesNotMatch(note.html, /<script>x<\/script>|<b>Owner<\/b>/);
  assert.match(note.html, /&lt;script&gt;/);
  assert.match(note.text, /<script>x<\/script>/);
  assert.match(note.html, /mortgage-ops\/queue/);
  const notice = deskAssignmentEmail({ ...ASSIGNED, homeowner_name: 'Hidden Homeowner' });
  assert.doesNotMatch(notice.html + notice.text, /Hidden Homeowner/);
  assert.match(notice.text, /Owner Co \/ Big Bank \/ loan 12345/);
});
