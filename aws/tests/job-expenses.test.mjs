/**
 * Job expenses API: the route job-expenses (aws/functions/api/job-expenses.mjs), list / add / delete of job costs paid
 * outside ChecksOps against an insurance job (claim) or a cash job (owner 2026-11-23, "Proceed with the per job build.
 * Make sure it is for insurance jobs and cash jobs"). SQL 173's functions are proven on PostgreSQL 16 in
 * sql173-job-expenses-pg.test.mjs; this file covers the routing, the sign-in the route runs as, membership, the request
 * checks before the database, the calls and their parameters, the error answers, the 503 while SQL 173 is not applied,
 * and the idempotent repeat.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CLASS_A_FUNCTIONS, handleAppServiceRequest } from '../functions/api/app-services.mjs';
import {
  JOB_EXPENSE_ADD_SQL,
  JOB_EXPENSE_COLUMNS,
  JOB_EXPENSE_DELETE_SQL,
  handleJobExpenses,
  isExpenseDate,
  mapJobExpenseSqlError,
  parseJobExpenseRequest,
} from '../functions/api/job-expenses.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const APP_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const CLAIM = 'c1730000-0000-4000-8000-000000000001';
const CASH_JOB = 'c1730000-0000-4000-8000-000000000002';
const EXPENSE = 'e1730000-0000-4000-8000-000000000003';
const KEY = 'job-exp:2026-11-23:abc123';

const event = (body, { signedIn = true } = {}) => ({
  rawPath: '/functions/v1/job-expenses',
  headers: signedIn ? { authorization: 'Bearer t' } : {},
  body: JSON.stringify(body),
  requestContext: {
    stage: 'staging',
    requestId: 'req-1',
    http: { method: 'POST', path: '/functions/v1/job-expenses' },
    ...(signedIn ? { authorizer: { jwt: { claims: { sub: SUB, email: 'tester@example.com', token_use: 'id' } } } } : {}),
  },
});

const ROW = {
  id: EXPENSE, tenant_id: TENANT, claim_id: CLAIM, cash_job_id: null, category: 'materials', amount_cents: '125050',
  expense_date: '2026-11-20', paid_to: 'ABC Supply', paid_by: 'supplier_account', notes: null, receipt_path: null,
  created_at: '2026-11-23T18:00:00.000Z',
};

/**
 * A fake connection: the identity lookup answers; tenant_users answers a membership when `member`; the SQL 173 calls
 * and the list SELECT answer `answer` (a value, a function of (sql, params), or an Error to throw).
 */
const fakeClient = ({ member = true, answer = null } = {}) => {
  const queries = [];
  return {
    queries,
    connected: false,
    async connect() { this.connected = true; },
    end: async () => {},
    query: async (sql, params) => {
      const text = String(sql);
      queries.push({ sql: text, params });
      if (params && params[0] === SUB) return { rows: [{ application_user_id: APP_ID, cognito_sub: SUB, email: 'tester@example.com', status: 'active' }] };
      if (/FROM public\.tenant_users/.test(text)) return { rows: member ? [{ role: 'member' }] : [] };
      if (text === JOB_EXPENSE_ADD_SQL || text === JOB_EXPENSE_DELETE_SQL || /FROM public\.job_expenses/.test(text)) {
        const value = typeof answer === 'function' ? answer(text, params) : answer;
        if (value instanceof Error) throw value;
        return value;
      }
      return { rows: [] };
    },
  };
};
const deps = (client) => ({
  enforceLoginMfa: async () => null,
  loadDatabaseCredentials: async () => ({ username: 'checksops', password: 'unit-test-only', host: 'db.example.internal', database: 'checksops' }),
  createClient: () => client,
});
const sqlError = (message, code) => Object.assign(new Error(message), { code });
const quiet = async (fn) => {
  const orig = console.error;
  const lines = [];
  console.error = (...a) => lines.push(a.join(' '));
  try { return { result: await fn(), lines }; } finally { console.error = orig; }
};
const addBody = (extra = {}) => ({
  action: 'add', tenant_id: TENANT, claim_id: CLAIM, category: 'materials', amount_cents: 125050,
  expense_date: '2026-11-20', paid_to: ' ABC Supply ', paid_by: 'supplier_account', idempotency_key: KEY, ...extra,
});
const ran = (client, sql) => client.queries.filter((q) => q.sql === sql);

test('routing: job-expenses is a Class A name dispatched to its handler; the module reads only through withIdentity', async () => {
  assert.ok(CLASS_A_FUNCTIONS.has('job-expenses'));
  const appServices = read('aws/functions/api/app-services.mjs');
  assert.match(appServices, /^import \{ handleJobExpenses \} from '\.\/job-expenses\.mjs';$/m);
  assert.match(appServices, /^ {2}'job-expenses',$/m);
  assert.match(appServices, /case 'job-expenses':\n\s+return handleJobExpenses\(event\);/);
  const answer = await handleAppServiceRequest(event({ action: 'list', tenant_id: TENANT }, { signedIn: false }), '/functions/v1/job-expenses', 'POST');
  assert.equal(answer.statusCode, 401, JSON.stringify(answer));
  const src = read('aws/functions/api/job-expenses.mjs');
  assert.deepEqual([...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]), ['./data.mjs', './tenant-email-domain.mjs']);
  const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  // Writes only through SQL 173's functions: no INSERT / UPDATE / DELETE, no provider, no fetch.
  assert.doesNotMatch(code, /\b(INSERT\s+INTO|UPDATE\s+public|DELETE\s+FROM)\b|fetch\(|moov/i);
  for (const rel of ['aws/functions/api/data.mjs', 'aws/functions/api/workflow-rpc.mjs', 'aws/functions/api/write-allowlist.mjs']) {
    assert.doesNotMatch(read(rel), /aws_job_expense_(add|delete)|job_expenses/, rel);
  }
});

test('a sign-in is required: no token answers 401 and no database connection is made', async () => {
  const client = fakeClient();
  const result = await handleJobExpenses(event(addBody(), { signedIn: false }), deps(client));
  assert.equal(result.statusCode, 401);
  assert.equal(client.connected, false);
  assert.equal(client.queries.length, 0);
});

test('validation before the database: action, tenant, one job, category, paid_by, cents, date, lengths, key, receipt', async () => {
  const bad = [
    [{ action: 'pay', tenant_id: TENANT }, 'invalid_action'],
    [{ action: 'list' }, 'missing_tenant'],
    [{ action: 'list', tenant_id: TENANT, claim_id: CLAIM, cash_job_id: CASH_JOB }, 'invalid_job_expense'],
    [addBody({ claim_id: undefined }), 'invalid_job_expense'],
    [addBody({ cash_job_id: CASH_JOB }), 'invalid_job_expense'],
    [addBody({ claim_id: 'not-a-uuid' }), 'invalid_job_expense'],
    [addBody({ category: 'fuel' }), 'invalid_job_expense'],
    [addBody({ paid_by: 'venmo' }), 'invalid_job_expense'],
    [addBody({ amount_cents: 0 }), 'invalid_job_expense'],
    [addBody({ amount_cents: 12.5 }), 'invalid_job_expense'],
    [addBody({ amount_cents: '1250' }), 'invalid_job_expense'],
    [addBody({ amount_cents: 100000000001 }), 'invalid_job_expense'],
    [addBody({ expense_date: '11/20/2026' }), 'invalid_job_expense'],
    [addBody({ expense_date: '2026-02-30' }), 'invalid_job_expense'],
    [addBody({ paid_to: 'x'.repeat(201) }), 'invalid_job_expense'],
    [addBody({ notes: 'x'.repeat(2001) }), 'invalid_job_expense'],
    [addBody({ idempotency_key: undefined }), 'invalid_job_expense'],
    [addBody({ idempotency_key: 'short' }), 'invalid_job_expense'],
    [addBody({ idempotency_key: 'has space here' }), 'invalid_job_expense'],
    [addBody({ idempotency_key: 'k'.repeat(101) }), 'invalid_job_expense'],
    [addBody({ receipt_path: 'claim-files/x/receipt.pdf' }), 'receipt_not_supported'],
    [{ action: 'delete', tenant_id: TENANT }, 'invalid_job_expense'],
  ];
  for (const [body, error] of bad) {
    const client = fakeClient();
    const result = await handleJobExpenses(event(body), deps(client));
    assert.equal(result.statusCode, 400, JSON.stringify(body));
    assert.equal(result.error, error, JSON.stringify(body));
    assert.equal(client.connected, false, JSON.stringify(body));
  }
  // Accepted edges: the largest amount, a trimmed lower-cased category and paid_by, blank optional text and receipt.
  const ok = parseJobExpenseRequest(addBody({ amount_cents: 100000000000, category: ' Labor ', paid_by: 'ACH', notes: '  ', receipt_path: '' }));
  assert.equal(ok.error, undefined);
  assert.equal(ok.category, 'labor');
  assert.equal(ok.paidBy, 'ach');
  assert.equal(ok.notes, null);
  assert.equal(ok.paidTo, 'ABC Supply');
  assert.equal(parseJobExpenseRequest(addBody({ claim_id: undefined, cash_job_id: CASH_JOB })).cashJobId, CASH_JOB);
  assert.equal(isExpenseDate('2028-02-29'), true);
  assert.equal(isExpenseDate('2027-02-29'), false);
});

test('membership: a non-member is refused 403 for every action and SQL 173 is never called', async () => {
  for (const body of [{ action: 'list', tenant_id: TENANT }, addBody(), { action: 'delete', tenant_id: TENANT, expense_id: EXPENSE }]) {
    const client = fakeClient({ member: false, answer: { rows: [] } });
    const result = await handleJobExpenses(event(body), deps(client));
    assert.equal(result.statusCode, 403, body.action);
    assert.equal(result.error, 'cross_tenant_denied');
    assert.equal(client.queries.some((q) => /job_expense/.test(q.sql)), false, body.action);
    assert.ok(client.queries.some((q) => q.sql === 'ROLLBACK'));
    assert.equal(client.queries.some((q) => q.sql === 'COMMIT'), false);
  }
});

test('list: a job\'s live expenses (claim or cash job) or all of the tenant\'s, read-only, never committed', async () => {
  for (const [extra, jobColumn, jobId] of [[{ claim_id: CLAIM }, 'claim_id', CLAIM], [{ cash_job_id: CASH_JOB }, 'cash_job_id', CASH_JOB], [{}, null, null]]) {
    const client = fakeClient({ answer: { rows: [ROW] } });
    const result = await handleJobExpenses(event({ action: 'list', tenant_id: TENANT, ...extra }), deps(client));
    assert.equal(result.statusCode, 200, JSON.stringify(result));
    assert.equal(result.truncated, false);
    assert.deepEqual(Object.keys(result.expenses[0]), [...JOB_EXPENSE_COLUMNS]);
    assert.equal(result.expenses[0].amount_cents, 125050);
    assert.equal(result.expenses[0].tenant_id, undefined);
    const select = client.queries.find((q) => /FROM public\.job_expenses/.test(q.sql));
    assert.match(select.sql, /e\.tenant_id = \$1::uuid AND e\.deleted_at IS NULL/);
    assert.deepEqual(select.params, jobId ? [TENANT, jobId] : [TENANT]);
    if (jobColumn) assert.match(select.sql, new RegExp(`AND e\\.${jobColumn} = \\$2::uuid`));
    else assert.doesNotMatch(select.sql, /\$2/);
    assert.equal(client.queries.some((q) => q.sql === 'SET TRANSACTION READ WRITE'), false);
    assert.equal(client.queries.some((q) => q.sql === 'COMMIT'), false);
    assert.ok(client.queries.some((q) => q.sql === 'ROLLBACK'));
    // The identity the read runs as is the verified sign-in.
    assert.ok(client.queries.some((q) => /set_config/.test(q.sql) && q.params?.[1] === APP_ID));
  }
});

test('add: one SQL 173 call as the verified sign-in (p_user_id = the mapping), committed; no receipt passed', async () => {
  const client = fakeClient({ answer: { rows: [{ result: { expense: { ...ROW, amount_cents: 125050, idempotency_key: KEY }, duplicate: false } }] } });
  const result = await handleJobExpenses(event({ ...addBody(), user_id: '00000000-0000-0000-0000-000000000099' }), deps(client));
  assert.equal(result.statusCode, 200, JSON.stringify(result));
  assert.equal(result.duplicate, false);
  assert.equal(result.moneyMoved, false);
  assert.deepEqual(Object.keys(result.expense), [...JOB_EXPENSE_COLUMNS]);
  const calls = ran(client, JOB_EXPENSE_ADD_SQL);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, [TENANT, CLAIM, null, 'materials', 125050, '2026-11-20', 'ABC Supply', 'supplier_account', null, null, KEY, APP_ID]);
  assert.ok(client.queries.some((q) => q.sql === 'SET TRANSACTION READ WRITE'));
  assert.ok(client.queries.some((q) => q.sql === 'COMMIT'));
});

test('add: an idempotent repeat passes duplicate true through with the recorded expense', async () => {
  const client = fakeClient({ answer: { rows: [{ result: { expense: { ...ROW, amount_cents: 125050 }, duplicate: true } }] } });
  const result = await handleJobExpenses(event(addBody()), deps(client));
  assert.equal(result.statusCode, 200);
  assert.equal(result.duplicate, true);
  assert.equal(result.expense.id, EXPENSE);
});

test('add on a cash job passes the cash job id and a null claim', async () => {
  const client = fakeClient({ answer: { rows: [{ result: { expense: { ...ROW, claim_id: null, cash_job_id: CASH_JOB }, duplicate: false } }] } });
  const result = await handleJobExpenses(event(addBody({ claim_id: undefined, cash_job_id: CASH_JOB })), deps(client));
  assert.equal(result.statusCode, 200);
  assert.deepEqual(ran(client, JOB_EXPENSE_ADD_SQL)[0].params.slice(1, 3), [null, CASH_JOB]);
});

test('delete: one SQL 173 call as the verified sign-in; true is 200, false is 404', async () => {
  const yes = fakeClient({ answer: { rows: [{ removed: true }] } });
  const ok = await handleJobExpenses(event({ action: 'delete', tenant_id: TENANT, expense_id: EXPENSE }), deps(yes));
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.removed, true);
  assert.deepEqual(ran(yes, JOB_EXPENSE_DELETE_SQL)[0].params, [TENANT, EXPENSE, APP_ID]);
  assert.ok(yes.queries.some((q) => q.sql === 'COMMIT'));
  const no = fakeClient({ answer: { rows: [{ removed: false }] } });
  const missing = await handleJobExpenses(event({ action: 'delete', tenant_id: TENANT, expense_id: EXPENSE }), deps(no));
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.error, 'expense_not_found');
  assert.equal(no.queries.some((q) => q.sql === 'COMMIT'), false);
});

test('SQL 173 errors map to plain answers; nothing commits', async () => {
  const cases = [
    [sqlError('job_expense_forbidden', '42501'), 403, 'not_authorized'],
    [sqlError('job_expense_invalid: amount_cents', '22023'), 400, 'invalid_job_expense'],
    [sqlError('job_expense_job_not_found', 'P0002'), 404, 'job_not_found'],
    [sqlError('job_expense_key_reused', '23505'), 409, 'idempotency_key_reused'],
    [sqlError('connection reset by peer at 10.0.0.1', '08006'), 500, 'job_expense_failed'],
  ];
  for (const [error, status, code] of cases) {
    const client = fakeClient({ answer: error });
    const { result } = await quiet(() => handleJobExpenses(event(addBody()), deps(client)));
    assert.equal(result.statusCode, status, error.message);
    assert.equal(result.error, code, error.message);
    assert.doesNotMatch(result.message, /10\.0\.0\.1|job_expense_/);
    assert.equal(client.queries.some((q) => q.sql === 'COMMIT'), false, error.message);
  }
  assert.equal(mapJobExpenseSqlError(sqlError('job_expense_invalid: paid_by', '22023'), []).message, 'Invalid expense: paid_by');
});

test('SQL 173 not applied: a missing function or table answers 503 job_expenses_not_ready and nothing is written', async () => {
  const add = fakeClient({ answer: sqlError('function public.aws_job_expense_add(uuid, ...) does not exist', '42883') });
  const a = (await quiet(() => handleJobExpenses(event(addBody()), deps(add)))).result;
  assert.equal(a.statusCode, 503);
  assert.equal(a.error, 'job_expenses_not_ready');
  assert.equal(add.queries.some((q) => q.sql === 'COMMIT'), false);
  const del = fakeClient({ answer: sqlError('function public.aws_job_expense_delete(uuid, uuid, uuid) does not exist', '42883') });
  assert.equal((await quiet(() => handleJobExpenses(event({ action: 'delete', tenant_id: TENANT, expense_id: EXPENSE }), deps(del)))).result.statusCode, 503);
  const list = fakeClient({ answer: sqlError('relation "public.job_expenses" does not exist', '42P01') });
  const l = (await quiet(() => handleJobExpenses(event({ action: 'list', tenant_id: TENANT }), deps(list)))).result;
  assert.equal(l.statusCode, 503);
  assert.equal(l.error, 'job_expenses_not_ready');
});
