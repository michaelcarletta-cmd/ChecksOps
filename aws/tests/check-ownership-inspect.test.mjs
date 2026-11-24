/**
 * Read-only production inspect of check ownership
 * (scripts/deployment-guard/check-ownership-inspect.mjs, lib/check-ownership-inspect.mjs,
 * ops/production-check-ownership-inspect.md):
 *
 *   - the configuration is inspect-only and bound to the same production RDS and
 *     checksops_admin secret as the Mortgage Desk access inspect; the tool is inventoried SAFE
 *     and is not a one-shot apply entry;
 *   - the CLI accepts exactly --inspect, refuses every other argument and any deployment-guard
 *     environment variable before reading a secret or connecting;
 *   - every statement is a fixed constant: BEGIN READ ONLY, a SELECT / WITH ... SELECT or
 *     ROLLBACK, and no statement returns an id, a name, an amount or a path;
 *   - the membership predicate is the API's TENANT_MEMBER_SQL (user_id, tenant_id);
 *   - on PostgreSQL 16, as a non-superuser checksops_admin: every ownership class, uploader
 *     tenant count, claim class and path class is counted as expected, the SQL path scope equals
 *     storage-paths.mjs normalizePath + matchCheckScopedPath, nothing changes, a write inside the
 *     inspect's transaction is refused (25006), the output has no ids, paths or row values, and
 *     a missing column skips only the statements that read it.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { main } from '../../scripts/deployment-guard/check-ownership-inspect.mjs';
import {
  CLAIM_CLASSES,
  INSPECT_STATEMENTS,
  INSPECT_TABLES,
  OWNERSHIP_CLASSES,
  PATH_CLASSES,
  Q,
  buildReport,
  loadInspectConfig,
  relPathSql,
  scopedUuidSql,
  summarize,
} from '../../scripts/deployment-guard/lib/check-ownership-inspect.mjs';
import { ONE_SHOT_TOOLS } from '../../scripts/deployment-guard/lib/production-sql-one-shot.mjs';
import { TENANT_MEMBER_SQL } from '../functions/api/workflow-transitions.mjs';
import { TENANT_MEMBER_SQL as RPC_TENANT_MEMBER_SQL } from '../functions/api/workflow-rpc.mjs';
import { matchCheckScopedPath, normalizePath } from '../functions/api/storage-paths.mjs';
import { pgSkipReason, startPg } from './helpers/stakeholder-policies-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TOOL = 'scripts/deployment-guard/check-ownership-inspect.mjs';
const LIB = 'scripts/deployment-guard/lib/check-ownership-inspect.mjs';
const READ_ONLY_STATEMENT_RE = /^\s*(BEGIN READ ONLY|SELECT|WITH|ROLLBACK)\b/;
const MUTATING_RE = /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE|COPY|CALL|DO|LOCK|VACUUM|ANALYZE|REFRESH|COMMENT|SECURITY LABEL|REASSIGN|nextval|setval|pg_terminate|pg_cancel|lo_)\b/i;
/** The only column names a statement may return. */
const RETURNED = new Set(['current_user', 'session_user', 'transaction_read_only', 'server_version_num', 'table_name', 'column_name',
  'row_security_active', 'set_config', 'ownership', 'uploader_tenants', 'deposited', 'checks', 'tenants_with_checks', 'missing_tenants',
  'tenants_with_uploader_not_member', 'tenants_affected', 'uploaders_affected', 'created_month', 'status', 'check_stage', 'claim_class',
  'uploader_member_of_claim_org', 'image_column', 'path_class']);
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
  assert.equal(config.id, 'check-ownership-inspect');
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
  assert.ok(!JSON.stringify(ONE_SHOT_TOOLS).includes('check-ownership-inspect'));
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
    assert.doesNotMatch(list.replace(/'[^']*'/g, "''"), /\b(payee_line|check_number|claim_number|amount|name|email)\b/, sql);
  }
});

test('the membership predicate is the API\'s TENANT_MEMBER_SQL: a tenant_users row for (user_id, tenant_id), role ignored', () => {
  for (const sql of [TENANT_MEMBER_SQL, RPC_TENANT_MEMBER_SQL]) {
    assert.match(sql, /FROM public\.tenant_users\s+WHERE user_id = \$1::uuid AND tenant_id = \$2::uuid/);
  }
  const members = Q.ownership.match(/EXISTS \(SELECT 1 FROM public\.tenant_users tu WHERE tu\.user_id = ([a-z_.]+) AND tu\.tenant_id = ([a-z_.]+)\)/);
  assert.deepEqual(members.slice(1), ['c.uploaded_by', 'c.tenant_id']);
  assert.doesNotMatch(Q.ownership, /\brole\b/);
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
  const host = 'ownership-unreachable.invalid';
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
  assert.ok(!sent.includes(Q.ownership));
  assert.equal(sent.at(-1), 'ROLLBACK');
});

// --- report ------------------------------------------------------------------------------

test('the report prints labels and counts only, and marks statements that were not read', () => {
  const report = buildReport({
    session: [{ transaction_read_only: 'on', current_user: 'checksops_admin', session_user: 'checksops_admin', server_version_num: 160004 }],
    rowSecurity: [{ table_name: 'check_intake_items', row_security_active: false }],
    skipped: { claims: 'columns_missing:claims.org_id' },
    ownership: [
      { ownership: 'tenant_null', uploader_tenants: 'one', deposited: false, checks: 3 },
      { ownership: 'tenant_null', uploader_tenants: 'uploader_null', deposited: true, checks: 2 },
      { ownership: 'uploader_not_member', uploader_tenants: 'several', deposited: false, checks: 4 },
      { ownership: 'uploader_member', uploader_tenants: 'one', deposited: false, checks: 10 },
      { ownership: 'made up', uploader_tenants: 'Jane Doe', deposited: false, checks: 1 },
    ],
    byStage: [{ ownership: 'tenant_null', deposited: false, status: 'Jane Doe 4111', check_stage: 'review', checks: 1 }],
    byMonth: [{ ownership: 'tenant_null', deposited: false, created_month: '2025-13', checks: 1 }, { ownership: 'tenant_null', deposited: false, created_month: '', checks: 2 }],
    imagePaths: [{ image_column: 'checks/x', ownership: 'tenant_null', deposited: false, path_class: 'checks/abc', checks: 'DROP' }],
  });
  assert.deepEqual(report.claims, { read: false, reason: 'columns_missing:claims.org_id' });
  assert.deepEqual(report.affected, { read: false, reason: 'not_read' });
  assert.deepEqual(report.row_security, { check_intake_items: false });
  assert.equal(report.summary.total.checks, 20);
  assert.equal(report.summary.uploaded_by_null, 2);
  assert.deepEqual(report.summary.uploader_cannot_write, { checks: 9, deposited: 2, not_deposited: 7 });
  assert.deepEqual(report.summary.by_ownership.tenant_null.uploader_tenants, { uploader_null: 2, none: 0, one: 3, several: 0 });
  assert.deepEqual(report.ownership.rows.at(-1), { ownership: 'other', uploader_tenants: 'other', deposited: false, checks: 1 });
  assert.equal(report.by_stage.rows[0].status, 'other');
  assert.deepEqual(report.by_month.rows.map((x) => x.created_month), ['other', '(none)']);
  assert.deepEqual(report.image_paths.rows, [{ image_column: 'other', ownership: 'tenant_null', deposited: false, path_class: 'other', checks: null }]);
  assert.equal(report.server_major_version, 16);
  assert.deepEqual(summarize([]).total, { checks: 0, deposited: 0, not_deposited: 0 });
});

// --- PostgreSQL 16 -----------------------------------------------------------------------

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TA = ID(1);
const TB = ID(2);
const TGONE = ID(9);
const U1 = ID(101); // member of A
const U2 = ID(102); // member of A and B
const U3 = ID(103); // member of none
const U4 = ID(104); // member of B
const STRAY = ID(333); // no check, no user
const SECRET = 'Jane Q Homeowner';
const SETUP = `
CREATE ROLE checksops_admin LOGIN NOSUPERUSER;
CREATE TABLE public.tenants (id uuid PRIMARY KEY, name text);
CREATE TABLE public.tenant_users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, user_id uuid NOT NULL, role text NOT NULL);
CREATE TABLE public.claims (id uuid PRIMARY KEY, org_id uuid, claim_number text);
CREATE TABLE public.check_intake_items (id uuid PRIMARY KEY, tenant_id uuid, uploaded_by uuid, deposited_at timestamptz, created_at timestamptz,
  status text, check_stage text, claim_id uuid, amount numeric, payee_line text,
  front_image_path text, back_image_path text, back_image_original_path text);
GRANT SELECT ON ALL TABLES IN SCHEMA public TO checksops_admin;
`;
const ROWS = `
INSERT INTO public.tenants VALUES ('${TA}', 'Alpha Roofing'), ('${TB}', 'Beta Adjusting');
INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES
  ('${TA}', '${U1}', 'owner'), ('${TA}', '${U2}', 'client'), ('${TB}', '${U2}', 'admin'), ('${TB}', '${U4}', 'staff');
INSERT INTO public.claims VALUES ('${ID(201)}', '${TA}', 'CLM-SECRET'), ('${ID(202)}', '${TB}', 'x'), ('${ID(203)}', NULL, 'x');
INSERT INTO public.check_intake_items (id, tenant_id, uploaded_by, deposited_at, created_at, status, check_stage, claim_id, amount, payee_line,
  front_image_path, back_image_path, back_image_original_path) VALUES
  ('${ID(11)}', '${TA}', '${U1}', NULL, '2026-10-02T12:00:00Z', 'pending', 'review', NULL, 1234.56, '${SECRET}',
    'checks/${ID(11)}/f.jpg', 'checks/${ID(11)}/b.jpg', NULL),
  ('${ID(12)}', NULL, '${U1}', NULL, '2025-03-15T12:00:00Z', 'pending', 'endorsing', '${ID(201)}', 50, 'x',
    'checks/${U1}/unclaimed/1_front_a.jpg', 'checks/${U1}/unclaimed/1_back_a.jpg', NULL),
  ('${ID(13)}', NULL, NULL, NULL, '2025-03-31T23:30:00-05', 'pending', 'endorsing', NULL, 50, 'x',
    NULL, 'https://abc.supabase.co/storage/v1/object/public/claim-files/checks/${STRAY}/c/back.jpg?token=secret', NULL),
  ('${ID(14)}', '${TGONE}', '${U2}', '2025-05-01T00:00:00Z', '2025-04-20T12:00:00Z', 'deposited', 'deposited', NULL, 50, 'x',
    'claim-files/checks/${TGONE}/f.jpg', '', NULL),
  ('${ID(15)}', '${TB}', '${U1}', NULL, '2025-06-01T12:00:00Z', 'pending', 'review', '${ID(202)}', 50, 'x',
    NULL, '/checks/${ID(12)}//./b.jpg', NULL),
  ('${ID(16)}', '${TB}', '${U3}', NULL, '2025-06-02T12:00:00Z', 'Weird Status!', 'review', NULL, 50, 'x',
    'Weird/legacy.jpg', 'https://example.com/x.jpg', NULL),
  ('${ID(17)}', '${TA}', NULL, NULL, '2026-01-01T12:00:00Z', 'pending', 'review', '${ID(203)}', 50, 'x', NULL, NULL, NULL),
  ('${ID(18)}', '${TB}', '${U2}', NULL, '2026-11-01T12:00:00Z', 'pending', 'ready_for_deposit', NULL, 50, 'x',
    'CHECKS/REUPLOAD/${ID(18).toUpperCase()}/a.jpg', 'checks/${ID(18)}/b.jpg', 'check-intake/${ID(18)}/files/o.jpg'),
  ('${ID(19)}', '${TA}', '${U4}', '2026-02-01T00:00:00Z', NULL, 'deposited', 'deposited', '${ID(299)}', 50, 'x', NULL, NULL, NULL);
`;
const SNAPSHOT = `SELECT
  (SELECT pg_catalog.md5(pg_catalog.string_agg(t::text, ',' ORDER BY t::text)) FROM public.tenants t) AS tenants,
  (SELECT pg_catalog.md5(pg_catalog.string_agg(t::text, ',' ORDER BY t::text)) FROM public.tenant_users t) AS members,
  (SELECT pg_catalog.md5(pg_catalog.string_agg(t::text, ',' ORDER BY t::text)) FROM public.claims t) AS claims,
  (SELECT pg_catalog.md5(pg_catalog.string_agg(t::text, ',' ORDER BY t::text)) FROM public.check_intake_items t) AS checks,
  (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public') AS relations`;

const count = (rows, key, filter = () => true) => rows.filter(filter).reduce((acc, x) => ({ ...acc, [x[key]]: (acc[x[key]] || 0) + x.checks }), {});

test('PostgreSQL 16: the inspect is read-only and counts every ownership, claim and path class', {
  timeout: 180000, skip: pgSkipReason() || false,
}, async (t) => {
  let pg;
  try {
    pg = (await import('pg')).default;
  } catch {
    t.skip('pg module is not installed');
    return;
  }
  const server = startPg('pg-check-ownership-', 62950);
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
        // What the database really returns: only the allowed columns, never an id or a path.
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
      for (const leak of [SECRET, 'Jane', 'CLM-SECRET', 'Alpha', 'Beta', '1234.56', 'token=secret', 'legacy.jpg', 'Weird', 'unclaimed', 'supabase.co']) {
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
    assert.deepEqual(report.row_security, { check_intake_items: false, claims: false, tenant_users: false, tenants: false });

    // Ownership: 12 and 13 have no tenant, 14 a tenant that does not exist, 15, 16 and 19 an
    // uploader outside the check's tenant, 17 no uploader, 11 and 18 a member uploader.
    const s = report.summary;
    assert.deepEqual(s.total, { checks: 9, deposited: 2, not_deposited: 7 });
    assert.equal(s.uploaded_by_null, 2);
    assert.deepEqual(s.uploader_cannot_write, { checks: 6, deposited: 2, not_deposited: 4 });
    assert.deepEqual(Object.fromEntries(Object.entries(s.by_ownership).map(([k, v]) => [k, [v.checks, v.uploader_tenants]])), {
      tenant_null: [2, { uploader_null: 1, none: 0, one: 1, several: 0 }],
      tenant_missing: [1, { uploader_null: 0, none: 0, one: 0, several: 1 }],
      uploader_null: [1, { uploader_null: 1, none: 0, one: 0, several: 0 }],
      uploader_not_member: [3, { uploader_null: 0, none: 1, one: 2, several: 0 }],
      uploader_member: [2, { uploader_null: 0, none: 0, one: 1, several: 1 }],
    });
    for (const row of report.ownership.rows) assert.ok(Object.hasOwn(OWNERSHIP_CLASSES, row.ownership));
    assert.deepEqual(report.affected, {
      read: true, tenants_with_checks: 3, missing_tenants: 1, tenants_with_uploader_not_member: 2, tenants_affected: 3, uploaders_affected: 4,
    });

    // Months in UTC (13 is 2025-03-31 23:30 at -05, so 2025-04 UTC); 19 has no created_at.
    assert.deepEqual(count(report.by_month.rows, 'created_month', (x) => x.ownership === 'tenant_null'), { '2025-03': 1, '2025-04': 1 });
    assert.deepEqual(count(report.by_month.rows, 'created_month', (x) => x.ownership === 'uploader_not_member'), { '(none)': 1, '2025-06': 2 });
    assert.deepEqual(report.by_stage.rows.filter((x) => x.ownership === 'uploader_not_member').map((x) => [x.status, x.check_stage, x.deposited, x.checks])
      .sort((a, b) => a[0].localeCompare(b[0])), [['deposited', 'deposited', true, 1], ['other', 'review', false, 1], ['pending', 'review', false, 1]]);

    // Claims: 12's claim belongs to tenant A (the check has none; its uploader is a member of A),
    // 15's to the check's tenant, 17's has no org, 19's claim does not exist.
    assert.deepEqual(count(report.claims.rows, 'claim_class'), { no_claim: 5, claim_org_differs: 1, claim_org_equal: 1, claim_org_null: 1, claim_missing: 1 });
    assert.deepEqual(report.claims.rows.find((x) => x.claim_class === 'claim_org_differs'),
      { ownership: 'tenant_null', deposited: false, claim_class: 'claim_org_differs', uploader_member_of_claim_org: true, checks: 1 });
    assert.equal(report.claims.rows.find((x) => x.claim_class === 'claim_org_equal').uploader_member_of_claim_org, false);
    for (const row of report.claims.rows) assert.ok(CLAIM_CLASSES.includes(row.claim_class));

    // Paths: the Endorsement Adjuster's source (back_image_original_path, else back_image_path).
    assert.deepEqual(count(report.image_paths.rows, 'path_class', (x) => x.image_column === 'adjuster_source'), {
      check_scoped_self: 2, check_scoped_uploader: 1, check_scoped_other_uuid: 1, empty: 3, check_scoped_other_check: 1, url_not_parsed: 1,
    });
    assert.deepEqual(count(report.image_paths.rows, 'path_class', (x) => x.image_column === 'front_image_path'), {
      check_scoped_self: 2, check_scoped_uploader: 1, check_scoped_tenant: 1, not_check_scoped: 1, empty: 4,
    });
    assert.deepEqual(report.image_paths.rows.filter((x) => x.path_class === 'check_scoped_uploader').map((x) => [x.image_column, x.ownership]),
      [['adjuster_source', 'tenant_null'], ['back_image_path', 'tenant_null'], ['front_image_path', 'tenant_null']]);
    for (const row of report.image_paths.rows) assert.ok(Object.hasOwn(PATH_CLASSES, row.path_class));

    // The SQL path scope is storage-paths.mjs normalizePath(.., 'claim-files') + matchCheckScopedPath.
    const samples = [
      `checks/${ID(11)}/f.jpg`, `CHECKS/${ID(11).toUpperCase()}/f.jpg`, `/claim-files/checks/${ID(11)}/f.jpg`, `claim-files/checks/${ID(11)}/f.jpg`,
      `//checks//${ID(11)}/./f.jpg`, `./checks/${ID(11)}/f.jpg`, `checks/reupload/${ID(12)}/a.jpg`, `check-intake/${ID(13)}/files/a.jpg`,
      `check-intake/${ID(13)}/a.jpg`, `checks/${ID(11)}`, `checks/00000000-0000-0000-0000-000000000000/a.jpg`, 'checks/not-a-uuid/a.jpg',
      `https://x.supabase.co/storage/v1/object/sign/claim-files/checks/${ID(14)}/b.jpg?token=t`,
      `https://x.supabase.co/storage/v1/object/public/claim-files/checks/${ID(14)}/b.jpg`,
      `https://x.supabase.co/storage/v1/object/claim-files/checks/${ID(14)}/b.jpg`,
      `https://x.supabase.co/storage/v1/object/public/other-bucket/checks/${ID(14)}/b.jpg`, 'https://example.com/x.jpg',
      `  checks/${ID(15)}/a.jpg  `, `${U1}/unclaimed/a.jpg`, 'Weird/legacy.jpg', '', '   ', `checks/${ID(15)}/../a.jpg`,
    ];
    const sql = await su.query(`SELECT v, ${scopedUuidSql(relPathSql('v'))} AS scope FROM unnest($1::text[]) WITH ORDINALITY AS u(v, n) ORDER BY n`, [samples]);
    for (const row of sql.rows) {
      const rel = normalizePath(row.v, 'claim-files');
      // '..' paths are refused by normalizePath (no write at all); the inspect only reports their scope.
      if (row.v.includes('/../')) continue;
      assert.equal(row.scope, rel ? matchCheckScopedPath(rel) : null, row.v);
    }

    // A write inside the inspect's transaction is refused by PostgreSQL itself.
    const admin = await open('checksops_admin');
    try {
      await admin.query(Q.begin);
      await assert.rejects(admin.query('CREATE TABLE public.nope (id int)'), (e) => e.code === '25006');
      await admin.query(Q.rollback);
    } finally {
      await admin.end();
    }

    // A missing column skips the statements that read it and nothing else.
    await su.query('ALTER TABLE public.claims DROP COLUMN org_id; ALTER TABLE public.check_intake_items DROP COLUMN back_image_original_path');
    const partial = await run();
    assert.equal(partial.summary.read, true);
    assert.equal(partial.by_month.read, true);
    assert.deepEqual(partial.claims, { read: false, reason: 'columns_missing:claims.org_id' });
    assert.deepEqual(partial.image_paths, { read: false, reason: 'columns_missing:check_intake_items.back_image_original_path' });
    assert.ok(!statements.includes(Q.claims) && !statements.includes(Q.imagePaths));

    // Without uploaded_by nothing but the session and catalog statements runs.
    await su.query('ALTER TABLE public.check_intake_items DROP COLUMN uploaded_by');
    const none = await run();
    for (const key of ['summary', 'ownership', 'affected', 'by_month', 'by_stage']) assert.equal(none[key].read, false, key);
    assert.equal(INSPECT_TABLES.length, 4);
  } finally {
    await su.end();
    server.stop();
  }
});
