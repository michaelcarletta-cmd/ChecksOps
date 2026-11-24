/**
 * Read-only production inspect of CheckAlt deposit state
 * (scripts/deployment-guard/checkalt-deposit-state-inspect.mjs,
 * lib/checkalt-deposit-state-inspect.mjs, ops/production-checkalt-deposit-state-inspect.md):
 *
 *   - the configuration is inspect-only and bound to the same production RDS and
 *     checksops_admin secret as the Mortgage Desk access inspect; the tool is inventoried SAFE
 *     and is not a one-shot apply entry;
 *   - the CLI accepts exactly --inspect, refuses every other argument and any deployment-guard
 *     environment variable before reading a secret or connecting;
 *   - every statement is a fixed constant: BEGIN READ ONLY, a SELECT / WITH ... SELECT or
 *     ROLLBACK, and no statement returns an id, a reference, an amount or a payload value;
 *   - the stranded rule is the Lambda's own: with an HTTP attempt and no reference,
 *     shouldReconcileInsteadOfPost (checkalt-idempotency.mjs) is true exactly for the terminal
 *     statuses plus STRANDED_STATUSES, and the submit path marks the attempt before it signs in;
 *   - on PostgreSQL 16, as a non-superuser checksops_admin: stranded and normal rows are
 *     classified as expected, timestamps are minutes in UTC, nothing changes, a write inside the
 *     inspect's transaction is refused (25006), the output has no uuids, amounts, references,
 *     error text or payload values, and a missing column skips only the statements that read it.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { main } from '../../scripts/deployment-guard/checkalt-deposit-state-inspect.mjs';
import {
  INSPECT_STATEMENTS,
  INSPECT_TABLES,
  Q,
  STRANDED_STATUSES,
  TERMINAL_STATUSES,
  buildReport,
  loadInspectConfig,
  summarize,
} from '../../scripts/deployment-guard/lib/checkalt-deposit-state-inspect.mjs';
import { ONE_SHOT_TOOLS } from '../../scripts/deployment-guard/lib/production-sql-one-shot.mjs';
import { shouldReconcileInsteadOfPost } from '../functions/api/providers/production/checkalt-idempotency.mjs';
import { pgSkipReason, startPg } from './helpers/stakeholder-policies-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TOOL = 'scripts/deployment-guard/checkalt-deposit-state-inspect.mjs';
const LIB = 'scripts/deployment-guard/lib/checkalt-deposit-state-inspect.mjs';
const READ_ONLY_STATEMENT_RE = /^\s*(BEGIN READ ONLY|SELECT|WITH|ROLLBACK)\b/;
const MUTATING_RE = /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE|COPY|CALL|DO|LOCK|VACUUM|ANALYZE|REFRESH|COMMENT|SECURITY LABEL|REASSIGN|nextval|setval|pg_terminate|pg_cancel|lo_)\b/i;
/** The only column names a statement may return. */
const RETURNED = new Set(['current_user', 'session_user', 'transaction_read_only', 'server_version_num', 'table_name', 'column_name',
  'row_security_active', 'set_config', 'status', 'reference_null', 'http_attempted', 'deposits', 'created_minute', 'attempted_minute',
  'updated_minute', 'failure_class', 'phase', 'last_error_null', 'check_linked', 'check_found', 'check_deposited', 'check_status',
  'check_stage', 'check_deposit_rows', 'check_rows_with_reference', 'other_row_has_reference', 'other_row_terminal', 'created_date',
  'stranded', 'check_seq']);
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const quiet = async (fn) => {
  const out = process.stdout.write;
  const err = process.stderr.write;
  const chunks = [];
  process.stdout.write = (c) => { chunks.push(String(c)); return true; };
  process.stderr.write = (c) => { chunks.push(String(c)); return true; };
  try {
    const code = await fn();
    return { code, text: chunks.join('') };
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
};

// --- configuration, inventory, statements ------------------------------------------------

test('the configuration is inspect-only and bound to the same production RDS and admin secret as the Mortgage Desk inspect', () => {
  const config = loadInspectConfig(ROOT);
  const desk = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/mortgage-desk-access-production-inspect.json'), 'utf8'));
  assert.equal(config.id, 'checkalt-deposit-state-inspect');
  assert.equal(config.read_only, true);
  assert.equal(config.apply, false);
  assert.equal(config.target_environment, 'production');
  assert.equal(config.tool, TOOL);
  assert.equal(config.execute, undefined);
  assert.equal(config.authorization_phrase, undefined);
  assert.equal(config.production_inspect, null, 'nothing has been run');
  for (const key of ['admin_login', 'rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(config[key], desk[key], key);
  assert.ok(fs.existsSync(path.join(ROOT, config.runbook)));
});

test('the tool is inventoried as SAFE, is not a one-shot apply entry and has no write capability', () => {
  const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/bypass-inventory.json'), 'utf8'));
  const entry = inventory.scripts.find((s) => s.path === TOOL);
  assert.ok(entry, 'inventoried');
  assert.equal(entry.classification, 'SAFE');
  assert.match(entry.note, /BEGIN READ ONLY/);
  assert.ok(!JSON.stringify(ONE_SHOT_TOOLS).includes('checkalt-deposit-state-inspect'));
  const source = fs.readFileSync(path.join(ROOT, TOOL), 'utf8') + fs.readFileSync(path.join(ROOT, LIB), 'utf8');
  assert.doesNotMatch(source, /CHECKSOPS_DEPLOYMENT_GUARD_APPLY|issueReceipt|acquireLease|UpdateFunctionCode|PutObject|SendCommand/);
});

test('every statement is a fixed read-only constant and returns only the allowed columns', () => {
  assert.equal(INSPECT_STATEMENTS[0], 'BEGIN READ ONLY');
  assert.equal(INSPECT_STATEMENTS.at(-1), 'ROLLBACK');
  for (const sql of INSPECT_STATEMENTS) {
    assert.match(sql, READ_ONLY_STATEMENT_RE, sql);
    if (/^\s*(BEGIN READ ONLY|ROLLBACK)\s*$/.test(sql)) continue;
    assert.doesNotMatch(sql.replace(/'[^']*'/g, "''"), MUTATING_RE, sql);
    // The final SELECT's output columns (after the last CTE) are all aliased from the allowlist.
    const final = sql.slice(sql.lastIndexOf('\n  SELECT ') >= 0 ? sql.lastIndexOf('\n  SELECT ') : 0);
    const list = final.slice(final.indexOf('SELECT') + 6, final.search(/\n\s*FROM\b/) >= 0 ? final.search(/\n\s*FROM\b/) : final.length);
    for (const alias of [...list.matchAll(/\bAS\s+([a-z0-9_]+)/g)].map((m) => m[1])) assert.ok(RETURNED.has(alias), `${alias} in ${sql}`);
    // Payload, error, amount, key and id columns are read only inside predicates, never returned.
    assert.doesNotMatch(list.replace(/'[^']*'/g, "''"), /\b(amount|amount_cents|idempotency_key|tenant_id|submitted_by|payee_line)\b/, sql);
    assert.doesNotMatch(list, /last_status_payload(?!\s*->>\s*'phase')/, sql);
    assert.doesNotMatch(list, /\blast_error\b(?!\s+IS NULL)/, sql);
    assert.doesNotMatch(list, /\bcheckalt_reference\b(?!\s+IS (NOT )?NULL)/, sql);
  }
});

test('the stranded rule is the Lambda\'s own: with an HTTP attempt and no reference it reconciles exactly in the terminal and stranded statuses', () => {
  const statuses = [...STRANDED_STATUSES, ...TERMINAL_STATUSES, 'approved', 'unknown', ''];
  for (const status of statuses) {
    const attempted = { status, checkalt_reference: null, provider_http_attempted_at: '2026-11-24T19:58:00Z', last_status_payload: {} };
    const fresh = { status, checkalt_reference: null, provider_http_attempted_at: null, last_status_payload: {} };
    assert.equal(shouldReconcileInsteadOfPost(fresh), TERMINAL_STATUSES.includes(status), `fresh ${status}`);
    assert.equal(shouldReconcileInsteadOfPost(attempted), TERMINAL_STATUSES.includes(status) || STRANDED_STATUSES.includes(status), `attempted ${status}`);
  }
  for (const sql of [Q.stranded, Q.strandedByDate, Q.recent]) {
    assert.match(sql, /provider_http_attempted_at IS NOT NULL AND [a-z]\.checkalt_reference IS NULL AND [a-z]\.status::text IN \('queued', 'pending', 'submitting', 'error'\)/);
  }
  // Until #2068 the submit path marked the attempt (and committed it) before it signed in to
  // CheckAlt, so a sign-in failure stranded the row (2026-11-24 19:58 UTC). Since #2068 it signs
  // in first and marks the attempt only right before the deposit POST; rows stranded earlier
  // still match the rule above.
  const submit = fs.readFileSync(path.join(ROOT, 'aws/functions/api/providers/production/checkalt-submit.mjs'), 'utf8');
  assert.ok(submit.indexOf('await markHttpAttempted(client') > 0);
  assert.ok(submit.indexOf('await getCheckAltJwt(') < submit.indexOf('await markHttpAttempted(client'));
});

// --- CLI refusals ------------------------------------------------------------------------

test('the CLI accepts exactly --inspect and refuses everything else before a secret or connection', async () => {
  for (const argv of [[], ['--apply'], ['--inspect', '--apply'], ['--inspect', '--input', 'x.json'], ['--inspect', '--password', 'x'],
    ['--inspect', '--sql', 'SELECT 1'], ['--inspect', '--database-url', 'postgres://x'], ['--inspect=1'], ['inspect'],
    ['--inspect', '--check-id', '00000000-0000-4000-8000-000000000001'], ['--inspect', '--inspect']]) {
    let touched = false;
    const deps = {
      root: ROOT,
      connect: async () => { touched = true; throw new Error('must not connect'); },
      resolveUrl: async () => { touched = true; throw new Error('must not read the secret'); },
    };
    const { code, text } = await quiet(() => main(argv, {}, deps));
    assert.equal(code, 1, argv.join(' '));
    assert.equal(touched, false, argv.join(' '));
    assert.match(text, /accepts exactly one argument: --inspect/);
    assert.doesNotMatch(text, /x\.json|postgres:\/\/|SELECT 1|00000000-0000/);
  }
});

test('the CLI refuses any deployment-guard environment variable before a secret or connection', async () => {
  for (const env of [{ CHECKSOPS_SKIP_DEPLOYMENT_GUARD: '1' }, { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' }, { CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT: '/tmp/r.json' }]) {
    let touched = false;
    const deps = { root: ROOT, connect: async () => { touched = true; }, resolveUrl: async () => { touched = true; } };
    const { code, text } = await quiet(() => main(['--inspect'], env, deps));
    assert.equal(code, 1);
    assert.equal(touched, false);
    assert.match(text, /refuses to run with deployment-guard environment variables/);
  }
});

test('the CLI refuses a configuration that is not read-only production', async () => {
  const base = loadInspectConfig(ROOT);
  for (const config of [{ ...base, read_only: false }, { ...base, apply: true }, { ...base, target_environment: 'staging' }]) {
    let touched = false;
    const { code } = await quiet(() => main(['--inspect'], {}, { root: ROOT, config, connect: async () => { touched = true; throw new Error('no'); } }));
    assert.equal(code, 1);
    assert.equal(touched, false);
  }
});

test('a connection failure prints only the JSON error with its code', async () => {
  const host = 'checkalt-unreachable.invalid';
  const password = 'Hunter2-not-a-real-password';
  const failing = async () => {
    const error = new Error(`getaddrinfo ENOTFOUND ${host} (postgres://checksops_admin:${password}@${host}:5432/postgres)`);
    error.code = 'ENOTFOUND';
    throw error;
  };
  const { code, text } = await quiet(() => main(['--inspect'], {}, { root: ROOT, connect: failing }));
  assert.equal(code, 1);
  const result = JSON.parse(text);
  assert.deepEqual(Object.keys(result.details).sort(), ['error_code', 'read_only', 'stage']);
  assert.equal(result.details.stage, 'connect');
  assert.equal(result.details.error_code, 'ENOTFOUND');
  for (const leak of [host, password, 'postgres://', '    at ']) assert.ok(!text.includes(leak), `leaked ${leak}`);
});

test('a transaction that is not read-only is refused before any data statement', async () => {
  const sent = [];
  const connect = async () => ({
    query: async (sql) => {
      sent.push(sql);
      if (sql === Q.session) return { rows: [{ transaction_read_only: 'off', current_user: 'x', session_user: 'x', server_version_num: 160000 }] };
      return { rows: [] };
    },
    end: async () => {},
  });
  const { code, text } = await quiet(() => main(['--inspect'], {}, { root: ROOT, connect }));
  assert.equal(code, 1);
  assert.match(text, /not read-only/);
  assert.ok(!sent.includes(Q.summary) && !sent.includes(Q.stranded));
  assert.equal(sent.at(-1), 'ROLLBACK');
});

// --- report ------------------------------------------------------------------------------

test('the report prints labels, minutes and counts only, and marks statements that were not read', () => {
  const report = buildReport({
    session: [{ transaction_read_only: 'on', current_user: 'checksops_admin', session_user: 'checksops_admin', server_version_num: 160004 }],
    rowSecurity: [{ table_name: 'checkalt_deposits', row_security_active: false }],
    skipped: { recent: 'columns_missing:checkalt_deposits.failure_class' },
    summary: [
      { status: 'submitting', reference_null: true, http_attempted: true, deposits: 2 },
      { status: 'error', reference_null: true, http_attempted: true, deposits: 1 },
      { status: 'submitting', reference_null: true, http_attempted: false, deposits: 4 },
      { status: 'submitted', reference_null: false, http_attempted: true, deposits: 10 },
      { status: 'pending_approval', reference_null: true, http_attempted: true, deposits: 3 },
      { status: 'CA-REF 4111', reference_null: true, http_attempted: true, deposits: 1 },
    ],
    stranded: [{
      created_minute: '2026-11-24T19:58Z', attempted_minute: '2026-11-24T19:58:37Z', updated_minute: '',
      status: 'submitting', failure_class: 'Gateway Timeout 504', phase: 'submitting', last_error_null: true,
      check_linked: true, check_found: true, check_deposited: null, check_status: 'ready_for_deposit', check_stage: 'Jane Doe',
      check_deposit_rows: 1, check_rows_with_reference: 'DROP', other_row_has_reference: false, other_row_terminal: 'x',
    }],
    strandedByDate: [{ created_date: '2026-11-24', deposits: 1 }, { created_date: '2026-13-01', deposits: 2 }],
  });
  assert.deepEqual(report.recent, { read: false, reason: 'columns_missing:checkalt_deposits.failure_class' });
  assert.deepEqual(report.row_security, { checkalt_deposits: false });
  assert.deepEqual(report.summary.total, { deposits: 21, reference_null: 11, reference_set: 10, http_attempted: 17, not_attempted: 4, stranded: 3 });
  assert.deepEqual(report.summary.by_status.submitting, {
    reference_null: { attempted: 2, not_attempted: 4 }, reference_set: { attempted: 0, not_attempted: 0 }, total: 6,
  });
  assert.equal(report.summary.by_status.other.total, 1);
  assert.equal(report.summary.rows.at(-1).status, 'other');
  assert.deepEqual(report.stranded.rows[0], {
    created_minute: '2026-11-24T19:58Z', attempted_minute: 'other', updated_minute: '(none)',
    status: 'submitting', failure_class: 'other', phase: 'submitting', last_error_null: true,
    check_linked: true, check_found: true, check_deposited: null, check_status: 'ready_for_deposit', check_stage: 'other',
    check_deposit_rows: 1, check_rows_with_reference: null, other_row_has_reference: false, other_row_terminal: null,
  });
  assert.deepEqual(report.stranded_by_date.rows, [{ created_date: '2026-11-24', deposits: 1 }, { created_date: 'other', deposits: 2 }]);
  assert.equal(report.server_major_version, 16);
  assert.deepEqual(summarize([]).total, { deposits: 0, reference_null: 0, reference_set: 0, http_attempted: 0, not_attempted: 0, stranded: 0 });
});

// --- PostgreSQL 16 -----------------------------------------------------------------------

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TENANT = ID(1);
const USER = ID(2);
const C = (n) => ID(100 + n); // checks
const D = (n) => ID(200 + n); // deposits
const SECRET = 'Jane Q Homeowner';
const SETUP = `
CREATE ROLE checksops_admin LOGIN NOSUPERUSER;
CREATE TABLE public.check_intake_items (id uuid PRIMARY KEY, tenant_id uuid, deposited_at timestamptz, status text, check_stage text,
  amount numeric, payee_line text);
CREATE TABLE public.checkalt_deposits (id uuid PRIMARY KEY, check_intake_item_id uuid, tenant_id uuid, checkalt_reference text UNIQUE,
  status text NOT NULL DEFAULT 'pending', amount numeric, amount_cents bigint, idempotency_key text, provider_http_attempted_at timestamptz,
  failure_class text, last_status_payload jsonb, last_error text, submitted_at timestamptz, submitted_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO checksops_admin;
`;
const ago = (minutes) => new Date(Date.now() - minutes * 60000);
const MIN = (d) => `${d.toISOString().slice(0, 16)}Z`;
const T13 = ago(30);
const T13A = ago(29);
const T14 = ago(10);
const T15 = ago(3 * 24 * 60);
const T16 = ago(5);
const dep = (n, check, status, ref, attempted, failure, payload, lastError, created, updated = created) => `('${D(n)}', ${check ? `'${check}'` : 'NULL'},
  '${TENANT}', ${ref ? `'${ref}'` : 'NULL'}, '${status}', 1234.56, 123456, 'idem-SECRET-${n}', ${attempted ? `'${attempted}'` : 'NULL'},
  ${failure ? `'${failure}'` : 'NULL'}, ${payload ? `'${JSON.stringify(payload)}'::jsonb` : 'NULL'}, ${lastError ? `'${lastError}'` : 'NULL'},
  '${USER}', '${created}', '${updated}')`;
const ROWS = `
INSERT INTO public.check_intake_items VALUES
  ('${C(1)}', '${TENANT}', NULL, 'ready_for_deposit', 'ready_for_deposit', 1234.56, '${SECRET}'),
  ('${C(2)}', '${TENANT}', '2025-04-02T00:00:00Z', 'deposited', 'deposited', 1234.56, 'x'),
  ('${C(3)}', '${TENANT}', NULL, 'Weird Status!', 'review', 1234.56, 'x'),
  ('${C(4)}', '${TENANT}', NULL, 'ready_for_deposit', 'ready_for_deposit', 1, 'x'),
  ('${C(5)}', '${TENANT}', NULL, 'ready_for_deposit', 'ready_for_deposit', 1, 'x'),
  ('${C(6)}', '${TENANT}', NULL, 'ready_for_deposit', 'ready_for_deposit', 1, 'x'),
  ('${C(7)}', '${TENANT}', NULL, 'deposited', 'deposited', 1, 'x');
INSERT INTO public.checkalt_deposits (id, check_intake_item_id, tenant_id, checkalt_reference, status, amount, amount_cents, idempotency_key,
  provider_http_attempted_at, failure_class, last_status_payload, last_error, submitted_by, created_at, updated_at) VALUES
  ${dep(1, C(1), 'submitting', null, '2025-11-24T19:58:38Z', null, { phase: 'submitting', provider_http_attempted: true, amount_cents: 123456 }, null, '2025-11-24T19:58:37Z', '2025-11-24T19:58:38Z')},
  ${dep(3, C(2), 'error', null, '2025-03-31T23:58:31-05', 'provider_timeout', { phase: 'provider_outcome', error: 'provider_timeout' }, 'provider_egress_or_timeout', '2025-03-31T23:58:30-05', '2025-04-01T05:00:59Z')},
  ${dep(4, C(2), 'submitted', 'CA-REF-SECRET-4', '2025-04-01T06:00:00Z', null, { phase: 'provider_outcome' }, null, '2025-04-01T06:00:00Z')},
  ${dep(5, C(3), 'queued', null, '2025-08-10T10:10:10Z', 'Weird Class!', { phase: 'Weird Phase', token: 'secret-token' }, 'CheckAlt said 504 for Jane', '2025-08-10T10:10:00Z')},
  ${dep(6, C(3), 'rejected', null, null, null, null, null, '2025-08-11T10:00:00Z')},
  ${dep(7, null, 'pending', null, '2025-06-01T12:00:30Z', null, [1, 2], null, '2025-06-01T12:00:00Z')},
  ${dep(8, ID(999), 'submitting', null, '2025-09-01T12:00:30Z', null, null, null, '2025-09-01T12:00:00Z')},
  ${dep(9, C(4), 'submitting', null, null, null, { phase: 'queued_before_http' }, null, '2025-10-01T12:00:00Z')},
  ${dep(10, C(4), 'cleared', 'CA-REF-SECRET-10', '2025-10-02T12:00:00Z', null, null, null, '2025-10-02T12:00:00Z')},
  ${dep(11, C(5), 'submitting', 'CA-REF-SECRET-11', '2025-10-03T12:00:00Z', 'db_after_provider', null, null, '2025-10-03T12:00:00Z')},
  ${dep(12, C(5), 'pending_approval', null, '2025-10-04T12:00:00Z', null, null, null, '2025-10-04T12:00:00Z')},
  ${dep(13, C(6), 'submitting', null, T13A.toISOString(), null, { phase: 'submitting' }, null, T13.toISOString(), T13A.toISOString())},
  ${dep(14, C(6), 'queued', null, null, null, { phase: 'queued_before_http' }, null, T14.toISOString())},
  ${dep(15, C(4), 'cleared', 'CA-REF-SECRET-15', T15.toISOString(), null, null, null, T15.toISOString())},
  ${dep(16, C(7), 'submitted', 'CA-REF-SECRET-16', T16.toISOString(), null, null, null, T16.toISOString())};
`;
const SNAPSHOT = `SELECT
  (SELECT pg_catalog.md5(pg_catalog.string_agg(t::text, ',' ORDER BY t::text)) FROM public.check_intake_items t) AS checks,
  (SELECT pg_catalog.md5(pg_catalog.string_agg(t::text, ',' ORDER BY t::text)) FROM public.checkalt_deposits t) AS deposits,
  (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public') AS relations`;

test('PostgreSQL 16: the inspect is read-only and classifies stranded and normal CheckAlt deposits', {
  timeout: 180000, skip: pgSkipReason() || false,
}, async (t) => {
  let pg;
  try {
    pg = (await import('pg')).default;
  } catch {
    t.skip('pg module is not installed');
    return;
  }
  const server = startPg('pg-checkalt-deposit-state-', 60300);
  const open = async (user) => {
    const c = new pg.Client({ host: server.host, port: server.port, user, database: 'postgres' });
    await c.connect();
    return c;
  };
  const su = await open('ubuntu');
  try {
    await su.query(SETUP);
    await su.query(ROWS);

    const statements = [];
    const connect = async () => {
      const c = await open('checksops_admin');
      const query = c.query.bind(c);
      c.query = async (sql, params) => {
        statements.push(typeof sql === 'string' ? sql : sql.text);
        const result = await query(sql, params);
        // What the database really returns: only the allowed columns, never an id or a value.
        for (const field of result.fields || []) assert.ok(RETURNED.has(field.name), `${field.name} returned by ${sql}`);
        return result;
      };
      return c;
    };
    const run = async () => {
      statements.length = 0;
      const before = (await su.query(SNAPSHOT)).rows[0];
      const { code, text } = await quiet(() => main(['--inspect'], {}, { root: ROOT, connect }));
      assert.equal(code, 0, text);
      assert.deepEqual((await su.query(SNAPSHOT)).rows[0], before, 'nothing changed');
      for (const sql of statements) assert.ok(INSPECT_STATEMENTS.includes(sql), sql);
      assert.equal(statements[0], 'BEGIN READ ONLY');
      assert.equal(statements.at(-1), 'ROLLBACK');
      for (const leak of [SECRET, 'Jane', 'CA-REF', 'SECRET', 'idem-', '1234.56', '123456', 'secret-token', 'provider_egress_or_timeout',
        'Weird', '504']) {
        assert.ok(!text.includes(leak), `leaked ${leak}`);
      }
      assert.doesNotMatch(text, UUID_RE);
      return JSON.parse(text).details;
    };

    const report = await run();
    assert.equal(statements.length, INSPECT_STATEMENTS.length, 'every statement ran once');
    assert.equal(report.transaction_read_only, true);
    assert.equal(report.current_user, 'checksops_admin');
    assert.equal(report.server_major_version, 16);
    assert.deepEqual(report.row_security, { check_intake_items: false, checkalt_deposits: false });

    // Summary: 15 rows; stranded are 1, 3, 5, 7, 8 and 13. Not stranded: 9 (no attempt), 11 (a
    // reference), 12 (pending_approval is terminal), 4, 10, 15, 16 (references), 6 and 14 (no attempt).
    const s = report.summary;
    assert.deepEqual(s.total, { deposits: 15, reference_null: 10, reference_set: 5, http_attempted: 12, not_attempted: 3, stranded: 6 });
    assert.deepEqual(s.by_status.submitting, {
      reference_null: { attempted: 3, not_attempted: 1 }, reference_set: { attempted: 1, not_attempted: 0 }, total: 5,
    });
    assert.deepEqual(s.by_status.pending_approval.reference_null, { attempted: 1, not_attempted: 0 });

    // Stranded, ordered by created_at, minutes in UTC (3 was created 2025-03-31 23:58 at -05).
    const st = report.stranded.rows;
    assert.deepEqual(st.map((x) => [x.created_minute, x.status]), [
      ['2025-04-01T04:58Z', 'error'], ['2025-06-01T12:00Z', 'pending'], ['2025-08-10T10:10Z', 'queued'],
      ['2025-09-01T12:00Z', 'submitting'], ['2025-11-24T19:58Z', 'submitting'], [MIN(T13), 'submitting'],
    ]);
    assert.deepEqual(st[0], {
      created_minute: '2025-04-01T04:58Z', attempted_minute: '2025-04-01T04:58Z', updated_minute: '2025-04-01T05:00Z',
      status: 'error', failure_class: 'provider_timeout', phase: 'provider_outcome', last_error_null: false,
      check_linked: true, check_found: true, check_deposited: true, check_status: 'deposited', check_stage: 'deposited',
      check_deposit_rows: 2, check_rows_with_reference: 1, other_row_has_reference: true, other_row_terminal: true,
    });
    // 7 has no check, and its payload is an array: no phase.
    assert.deepEqual(st[1], {
      created_minute: '2025-06-01T12:00Z', attempted_minute: '2025-06-01T12:00Z', updated_minute: '2025-06-01T12:00Z',
      status: 'pending', failure_class: '(none)', phase: '(none)', last_error_null: true,
      check_linked: false, check_found: false, check_deposited: null, check_status: '(none)', check_stage: '(none)',
      check_deposit_rows: null, check_rows_with_reference: null, other_row_has_reference: null, other_row_terminal: null,
    });
    // 5: labels that are not code labels print as other; its check's other row is rejected (terminal, no reference).
    assert.deepEqual([st[2].failure_class, st[2].phase, st[2].check_status, st[2].last_error_null, st[2].other_row_has_reference, st[2].other_row_terminal,
      st[2].check_deposit_rows, st[2].check_rows_with_reference], ['other', 'other', 'other', false, false, true, 2, 0]);
    // 8 names a check that does not exist.
    assert.deepEqual([st[3].check_linked, st[3].check_found, st[3].check_deposited, st[3].check_deposit_rows, st[3].other_row_terminal], [true, false, null, 1, false]);
    // 1: the owner's case: attempted, no reference, phase submitting, its check still ready for deposit.
    assert.deepEqual(st[4], {
      created_minute: '2025-11-24T19:58Z', attempted_minute: '2025-11-24T19:58Z', updated_minute: '2025-11-24T19:58Z',
      status: 'submitting', failure_class: '(none)', phase: 'submitting', last_error_null: true,
      check_linked: true, check_found: true, check_deposited: false, check_status: 'ready_for_deposit', check_stage: 'ready_for_deposit',
      check_deposit_rows: 1, check_rows_with_reference: 0, other_row_has_reference: false, other_row_terminal: false,
    });
    assert.equal(st[5].attempted_minute, MIN(T13A));
    assert.equal(st[5].check_deposit_rows, 2);
    assert.equal(st[5].other_row_terminal, false);

    const today = T13.toISOString().slice(0, 10);
    const expectDates = { '2025-04-01': 1, '2025-06-01': 1, '2025-08-10': 1, '2025-09-01': 1, '2025-11-24': 1 };
    expectDates[today] = (expectDates[today] || 0) + 1;
    assert.deepEqual(Object.fromEntries(report.stranded_by_date.rows.map((x) => [x.created_date, x.deposits])), expectDates);

    // Recent (last 2 days): 13, 14 and 16, not 15 (3 days old); 13 and 14 are the same check.
    assert.deepEqual(report.recent.rows, [
      { created_minute: MIN(T13), attempted_minute: MIN(T13A), updated_minute: MIN(T13A), status: 'submitting', reference_null: true, http_attempted: true,
        failure_class: '(none)', stranded: true, check_seq: 1 },
      { created_minute: MIN(T14), attempted_minute: '(none)', updated_minute: MIN(T14), status: 'queued', reference_null: true, http_attempted: false,
        failure_class: '(none)', stranded: false, check_seq: 1 },
      { created_minute: MIN(T16), attempted_minute: MIN(T16), updated_minute: MIN(T16), status: 'submitted', reference_null: false, http_attempted: true,
        failure_class: '(none)', stranded: false, check_seq: 2 },
    ]);

    // A write inside the inspect's transaction is refused by PostgreSQL itself, although the login may write.
    const admin = await open('checksops_admin');
    try {
      await admin.query(Q.begin);
      await assert.rejects(admin.query(`UPDATE public.checkalt_deposits SET status = 'queued', provider_http_attempted_at = NULL`), (e) => e.code === '25006');
      await admin.query(Q.rollback);
      await admin.query(Q.begin);
      await assert.rejects(admin.query('CREATE TABLE public.nope (id int)'), (e) => e.code === '25006');
      await admin.query(Q.rollback);
    } finally {
      await admin.end();
    }

    // A missing column skips the statements that read it and nothing else.
    await su.query('ALTER TABLE public.checkalt_deposits DROP COLUMN failure_class; ALTER TABLE public.check_intake_items DROP COLUMN check_stage');
    const partial = await run();
    assert.equal(partial.summary.read, true);
    assert.equal(partial.stranded_by_date.read, true);
    assert.deepEqual(partial.stranded, { read: false, reason: 'columns_missing:checkalt_deposits.failure_class,check_intake_items.check_stage' });
    assert.deepEqual(partial.recent, { read: false, reason: 'columns_missing:checkalt_deposits.failure_class' });
    assert.ok(!statements.includes(Q.stranded) && !statements.includes(Q.recent));

    // Without provider_http_attempted_at nothing but the session and catalog statements runs.
    await su.query('ALTER TABLE public.checkalt_deposits DROP COLUMN provider_http_attempted_at');
    const none = await run();
    for (const key of ['summary', 'stranded', 'stranded_by_date', 'recent']) assert.equal(none[key].read, false, key);
    assert.equal(INSPECT_TABLES.length, 2);
  } finally {
    await su.end();
    server.stop();
  }
});
