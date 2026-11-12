/**
 * Read-only production inspect of the checks a partner shared with Condition One and released
 * (scripts/deployment-guard/partner-released-shares-inspect.mjs,
 * lib/partner-released-shares-inspect.mjs, ops/production-partner-released-shares-inspect.md):
 *
 *   - the configuration is inspect-only and bound to the same production RDS and
 *     checksops_admin secret as the Mortgage Desk access inspect; the tool is inventoried SAFE
 *     and is not a one-shot apply entry;
 *   - the CLI accepts exactly --inspect, refuses every other argument and any deployment-guard
 *     environment variable before reading a secret or connecting;
 *   - every statement is a fixed constant: BEGIN READ ONLY, a SELECT / WITH ... SELECT or
 *     ROLLBACK, and no statement returns an id, a name or a free-text column;
 *   - the inlined name normalization equals public.normalize_org_name;
 *   - on PostgreSQL 16, as a non-superuser checksops_admin: every recipient class and check
 *     class is counted as expected, nothing changes, a write inside the inspect's transaction
 *     is refused (25006), the output has no ids, names or row values, and with zero or two
 *     matching tenants the inspect reads nothing but the tenant count.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { main } from '../../scripts/deployment-guard/partner-released-shares-inspect.mjs';
import {
  CHECK_CLASSES,
  INSPECT_STATEMENTS,
  INSPECT_TABLES,
  Q,
  RECIPIENT_CLASSES,
  buildReport,
  loadInspectConfig,
} from '../../scripts/deployment-guard/lib/partner-released-shares-inspect.mjs';
import { ONE_SHOT_TOOLS } from '../../scripts/deployment-guard/lib/production-sql-one-shot.mjs';
import { pgSkipReason, startPg } from './helpers/stakeholder-policies-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TOOL = 'scripts/deployment-guard/partner-released-shares-inspect.mjs';
const LIB = 'scripts/deployment-guard/lib/partner-released-shares-inspect.mjs';
const READ_ONLY_STATEMENT_RE = /^\s*(BEGIN READ ONLY|SELECT|WITH|ROLLBACK)\b/;
const MUTATING_RE = /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE|COPY|CALL|DO|LOCK|VACUUM|ANALYZE|REFRESH|COMMENT|SECURITY LABEL|REASSIGN|nextval|setval|pg_terminate|pg_cancel|lo_)\b/i;
/** The only column names a statement may return. */
const RETURNED = new Set(['current_user', 'session_user', 'transaction_read_only', 'server_version_num', 'table_name', 'column_name',
  'name', 'identity_arguments', 'security_definer', 'prosrc_sha256', 'uses_normalize_org_name', 'uses_recipient_tenant_id',
  'uses_stakeholder_accounts', 'target_matches', 'source_matches', 'check_stage', 'checks', 'check_amount', 'status', 'method',
  'recipient_class', 'payouts', 'amount', 'check_class', 'settled_amount', 'listed_amount', 'near_miss_amount', 'leg_role',
  'to_target', 'legs', 'set_config']);
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
  assert.equal(config.read_only, true);
  assert.equal(config.apply, false);
  assert.equal(config.target_environment, 'production');
  assert.equal(config.tool, TOOL);
  assert.equal(config.execute, undefined);
  assert.equal(config.authorization_phrase, undefined);
  assert.equal(config.production_inspect, null);
  for (const key of ['admin_login', 'rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(config[key], desk[key], key);
  assert.ok(fs.existsSync(path.join(ROOT, config.runbook)));
});

test('the tool is inventoried as SAFE, is not a one-shot apply entry and has no write capability', () => {
  const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/bypass-inventory.json'), 'utf8'));
  const entry = inventory.scripts.find((s) => s.path === TOOL);
  assert.ok(entry, 'inventoried');
  assert.equal(entry.classification, 'SAFE');
  assert.match(entry.note, /BEGIN READ ONLY/);
  assert.ok(!JSON.stringify(ONE_SHOT_TOOLS).includes('partner-released-shares-inspect'));
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
    assert.doesNotMatch(list.replace(/'[^']*'/g, "''"), /\b(recipient_name|nickname|custname|external_notes|external_check_number|check_number|payee_line|property_address)\b/, sql);
  }
});

// --- CLI refusals ------------------------------------------------------------------------

test('the CLI accepts exactly --inspect and refuses everything else before a secret or connection', async () => {
  for (const argv of [[], ['--apply'], ['--inspect', '--apply'], ['--inspect', '--input', 'x.json'], ['--inspect', '--password', 'x'],
    ['--inspect', '--sql', 'SELECT 1'], ['--inspect', '--database-url', 'postgres://x'], ['--inspect=1'], ['inspect']]) {
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
    assert.doesNotMatch(text, /x\.json|postgres:\/\/|SELECT 1/);
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
    const { code } = await quiet(() => main(['--inspect'], {}, { root: ROOT, config, connect: async () => { throw new Error('no'); } }));
    assert.equal(code, 1);
  }
});

test('a connection failure prints only the JSON error with its code', async () => {
  const host = 'shares-unreachable.invalid';
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

// --- report ------------------------------------------------------------------------------

test('the report prints labels, counts and amounts only, and marks statements that were not read', () => {
  const report = buildReport({
    session: [{ transaction_read_only: 'on', current_user: 'checksops_admin', session_user: 'checksops_admin', server_version_num: 160004 }],
    tenants: [{ target_matches: 2, source_matches: 1 }],
    functions: [],
    skipped: { shares: 'target_not_resolved' },
    releasedSplits: [{ source_matches: true, status: 'settled', method: 'Jane Doe 4111111111111111', recipient_class: 'made up', payouts: 1, checks: 1, amount: 'DROP' }],
  });
  assert.equal(report.tenants.target_resolved, false);
  assert.deepEqual(report.shares, { read: false, reason: 'target_not_resolved' });
  assert.deepEqual(report.released_checks, { read: false, reason: 'not_read' });
  assert.deepEqual(report.released_splits.rows, [{ source_matches_prefix: true, status: 'settled', method: 'other',
    recipient_class: 'other', funds_received: 'other', payouts: 1, checks: 1, amount: null }]);
  assert.deepEqual(report.functions, { get_tenant_funds_received: { present: false }, normalize_org_name: { present: false } });
  assert.equal(report.server_major_version, 16);
});

// --- PostgreSQL 16 -----------------------------------------------------------------------

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const FREEDOM = ID(1);
const C1 = ID(2);
const OTHER = ID(3);
const NORMALIZE = fs.readFileSync(path.join(ROOT, 'supabase/migrations/20260820194902_3c6b1fee-a086-4fc6-8960-fd4d32e94fdd.sql'), 'utf8')
  .match(/CREATE OR REPLACE FUNCTION public\.normalize_org_name[\s\S]*?\$\$;/)[0];
const SETUP = `
CREATE ROLE checksops_admin LOGIN NOSUPERUSER;
CREATE TABLE public.tenants (id uuid PRIMARY KEY, name text);
CREATE TABLE public.shared_checks (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), check_id uuid, source_tenant_id uuid, target_tenant_id uuid, revoked_at timestamptz);
CREATE TABLE public.check_intake_items (id uuid PRIMARY KEY, tenant_id uuid, check_stage text, amount numeric, check_number text, payee_line text);
CREATE TABLE public.disbursement_batches (id uuid PRIMARY KEY, check_intake_item_id uuid);
CREATE TABLE public.stakeholder_accounts (id uuid PRIMARY KEY, tenant_id uuid, nickname text, custname text);
CREATE TABLE public.disbursement_splits (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), batch_id uuid, tenant_id uuid, amount numeric, status text, method text,
  recipient_name text, recipient_tenant_id uuid, stakeholder_account_id uuid, external_check_number text, external_notes text);
CREATE TABLE public.payment_transfers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, check_id uuid, leg_role text, status text, amount_cents bigint, destination_tenant_id uuid);
${NORMALIZE}
CREATE FUNCTION public.get_tenant_funds_received(_tenant_id uuid) RETURNS int LANGUAGE sql SECURITY DEFINER AS $f$
  SELECT count(*)::int FROM public.disbursement_splits ds LEFT JOIN public.stakeholder_accounts sa ON sa.id = ds.stakeholder_account_id
  WHERE ds.recipient_tenant_id = _tenant_id OR public.normalize_org_name(ds.recipient_name) = 'x' $f$;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO checksops_admin;
`;
const SECRET_NAME = 'Jane Q Homeowner';
// Checks 11-18 are shared by Freedom with Condition One; 19 by another organization; 20 is revoked.
const ROWS = `
INSERT INTO public.tenants VALUES ('${FREEDOM}', 'Freedom Adjustment, LLC'), ('${C1}', 'Condition One Commercial LLC'), ('${OTHER}', 'Other Roofing Inc');
INSERT INTO public.check_intake_items (id, tenant_id, check_stage, amount, check_number, payee_line) VALUES
  ('${ID(11)}', '${FREEDOM}', 'disbursed_externally', 1000, 'CK-SECRET-11', '${SECRET_NAME}'),
  ('${ID(12)}', '${FREEDOM}', 'disbursed_externally', 2000, 'CK-12', 'x'),
  ('${ID(13)}', '${FREEDOM}', 'funds_released', 3000, 'CK-13', 'x'),
  ('${ID(14)}', '${FREEDOM}', 'disbursed_externally', 4000, 'CK-14', 'x'),
  ('${ID(15)}', '${FREEDOM}', 'funds_released', 5000, 'CK-15', 'x'),
  ('${ID(16)}', '${FREEDOM}', 'deposited', 6000, 'CK-16', 'x'),
  ('${ID(17)}', '${FREEDOM}', 'Weird Stage!', 7000, 'CK-17', 'x'),
  ('${ID(18)}', '${FREEDOM}', 'disbursed_externally', 8000, 'CK-18', 'x'),
  ('${ID(19)}', '${OTHER}', 'funds_released', 900, 'CK-19', 'x'),
  ('${ID(20)}', '${FREEDOM}', 'funds_released', 111, 'CK-20', 'x');
INSERT INTO public.shared_checks (check_id, source_tenant_id, target_tenant_id, revoked_at)
  SELECT ('00000000-0000-4000-8000-0000000000' || n)::uuid, '${FREEDOM}', '${C1}', NULL FROM generate_series(11, 18) n;
INSERT INTO public.shared_checks (check_id, source_tenant_id, target_tenant_id, revoked_at) VALUES
  ('${ID(19)}', '${OTHER}', '${C1}', NULL), ('${ID(20)}', '${FREEDOM}', '${C1}', now()),
  ('${ID(13)}', '${FREEDOM}', '${OTHER}', NULL);
INSERT INTO public.disbursement_batches (id, check_intake_item_id)
  SELECT ('00000000-0000-4000-8000-0000000001' || n)::uuid, ('00000000-0000-4000-8000-0000000000' || n)::uuid FROM generate_series(11, 20) n;
INSERT INTO public.stakeholder_accounts VALUES
  ('${ID(201)}', '${C1}', 'own', 'own'), ('${ID(202)}', '${FREEDOM}', 'Condition One - ops', NULL), ('${ID(203)}', '${FREEDOM}', 'Roofer', 'Roofer');
INSERT INTO public.disbursement_splits (batch_id, tenant_id, amount, status, method, recipient_name, recipient_tenant_id, stakeholder_account_id, external_notes) VALUES
  -- 11: listed by name (equal after normalization), plus a homeowner payout
  ('${ID(111)}', '${FREEDOM}', 600, 'settled', 'external_check', 'CONDITION ONE COMMERCIAL, L.L.C.', NULL, NULL, 'memo-secret'),
  ('${ID(111)}', '${FREEDOM}', 400, 'settled', 'external_check', '${SECRET_NAME}', NULL, NULL, NULL),
  -- 12: listed by recipient_tenant_id; 13: listed by the payee account's tenant
  ('${ID(112)}', '${FREEDOM}', 2000, 'settled', 'ach', 'whoever', '${C1}', NULL, NULL),
  ('${ID(113)}', '${FREEDOM}', 3000, 'settled', 'external_check', NULL, NULL, '${ID(201)}', NULL),
  -- 14: near misses only (name contains; account name contains; abbreviation)
  ('${ID(114)}', '${FREEDOM}', 1000, 'settled', 'external_check', 'Condition One', NULL, NULL, NULL),
  ('${ID(114)}', '${FREEDOM}', 1500, 'settled', 'external_check', NULL, NULL, '${ID(202)}', NULL),
  ('${ID(114)}', '${FREEDOM}', 500, 'settled', 'external_check', 'C1 - draw 2', NULL, NULL, NULL),
  -- 15: others only (account; nobody)
  ('${ID(115)}', '${FREEDOM}', 4000, 'settled', 'external_check', NULL, NULL, '${ID(203)}', NULL),
  ('${ID(115)}', '${FREEDOM}', 1000, 'settled', 'Odd Method 9', NULL, NULL, NULL, NULL),
  -- 18: a payout that is not settled does not count for the check
  ('${ID(118)}', '${FREEDOM}', 8000, 'pending', 'ach', 'Condition One Commercial', NULL, NULL, NULL),
  -- not counted: deposited check, another target, revoked share, another tenant's split on a shared check
  ('${ID(116)}', '${FREEDOM}', 6000, 'settled', 'ach', 'Condition One Commercial', NULL, NULL, NULL),
  ('${ID(120)}', '${FREEDOM}', 111, 'settled', 'ach', 'Condition One Commercial', NULL, NULL, NULL),
  ('${ID(111)}', '${OTHER}', 77, 'settled', 'ach', 'Condition One Commercial', NULL, NULL, NULL),
  -- 19: shared by another organization
  ('${ID(119)}', '${OTHER}', 900, 'settled', 'external_check', 'Condition One Commercial', NULL, NULL, NULL);
INSERT INTO public.payment_transfers (tenant_id, check_id, leg_role, status, amount_cents, destination_tenant_id) VALUES
  ('${FREEDOM}', '${ID(12)}', 'send_wallet', 'completed', 12345, '${C1}'),
  ('${FREEDOM}', '${ID(12)}', 'send_bank', 'completed', 500, NULL),
  ('${FREEDOM}', '${ID(12)}', 'funding', 'completed', 999999, NULL),
  ('${FREEDOM}', '${ID(16)}', 'send_wallet', 'completed', 700, '${C1}');
`;
const SNAPSHOT = `SELECT
  (SELECT pg_catalog.md5(pg_catalog.string_agg(t::text, ',' ORDER BY t::text)) FROM public.tenants t) AS tenants,
  (SELECT pg_catalog.md5(pg_catalog.string_agg(t::text, ',' ORDER BY t::text)) FROM public.shared_checks t) AS shares,
  (SELECT pg_catalog.md5(pg_catalog.string_agg(t::text, ',' ORDER BY t::text)) FROM public.check_intake_items t) AS checks,
  (SELECT pg_catalog.md5(pg_catalog.string_agg(t::text, ',' ORDER BY t::text)) FROM public.disbursement_splits t) AS splits,
  (SELECT pg_catalog.md5(pg_catalog.string_agg(t::text, ',' ORDER BY t::text)) FROM public.payment_transfers t) AS transfers,
  (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public') AS relations`;

test('PostgreSQL 16: the inspect is read-only and counts every recipient and check class', {
  timeout: 180000, skip: pgSkipReason() || false,
}, async (t) => {
  let pg;
  try {
    pg = (await import('pg')).default;
  } catch {
    t.skip('pg module is not installed');
    return;
  }
  const server = startPg('pg-partner-released-shares-', 61900);
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
        // What the database really returns: only the allowed columns, never an id or a name.
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
      for (const leak of [FREEDOM, C1, OTHER, ID(11), SECRET_NAME, 'Jane', 'CK-SECRET-11', 'memo-secret', 'Roofer', 'Freedom Adjustment',
        'Condition One Commercial', 'Weird Stage', 'Odd Method', 'draw 2']) assert.ok(!text.includes(leak), `leaked ${leak}`);
      assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
      return JSON.parse(text).details;
    };

    const report = await run();
    assert.equal(statements.length, INSPECT_STATEMENTS.length, 'every statement ran once');
    assert.equal(report.transaction_read_only, true);
    assert.equal(report.current_user, 'checksops_admin');
    assert.equal(report.server_major_version, 16);
    assert.deepEqual({ ...report.tenants, target_name_prefix: undefined, source_name_prefix: undefined },
      { target_matches: 1, source_matches: 1, target_resolved: true, target_name_prefix: undefined, source_name_prefix: undefined });
    assert.equal(report.functions.normalize_org_name.present, true);
    assert.deepEqual(report.functions.get_tenant_funds_received.detail.map(({ prosrc_sha256, ...rest }) => rest), [{
      security_definer: true, matches_by_recipient_name: true, matches_by_recipient_tenant_id: true, matches_by_payee_account_tenant: true }]);
    assert.match(report.functions.get_tenant_funds_received.detail[0].prosrc_sha256, /^[0-9a-f]{64}$/);

    // Shares: Freedom's eight active ones by stage (the odd stage label is 'other'), the other organization's one.
    assert.deepEqual(report.shares.rows, [
      { source_matches_prefix: false, check_stage: 'funds_released', checks: 1, check_amount: '900.00' },
      { source_matches_prefix: true, check_stage: 'other', checks: 1, check_amount: '7000.00' },
      { source_matches_prefix: true, check_stage: 'deposited', checks: 1, check_amount: '6000.00' },
      { source_matches_prefix: true, check_stage: 'disbursed_externally', checks: 4, check_amount: '15000.00' },
      { source_matches_prefix: true, check_stage: 'funds_released', checks: 2, check_amount: '8000.00' },
    ]);

    const splits = Object.fromEntries(report.released_splits.rows.filter((x) => x.source_matches_prefix)
      .map((x) => [`${x.status}/${x.method}/${x.recipient_class}`, [x.funds_received, x.payouts, x.checks, x.amount]]));
    assert.deepEqual(splits, {
      'pending/ach/recipient_name_equal': ['listed', 1, 1, '8000.00'],
      'settled/ach/recipient_tenant_id': ['listed', 1, 1, '2000.00'],
      'settled/external_check/other_payee_account': ['other', 1, 1, '4000.00'],
      'settled/external_check/other_recipient_name': ['other', 1, 1, '400.00'],
      'settled/external_check/payee_account_name_contains': ['near_miss', 1, 1, '1500.00'],
      'settled/external_check/payee_account_of_target': ['listed', 1, 1, '3000.00'],
      'settled/external_check/recipient_name_abbreviation': ['near_miss', 1, 1, '500.00'],
      'settled/external_check/recipient_name_contains': ['near_miss', 1, 1, '1000.00'],
      'settled/external_check/recipient_name_equal': ['listed', 1, 1, '600.00'],
      'settled/other/no_recipient': ['other', 1, 1, '1000.00'],
    });
    assert.deepEqual(report.released_splits.rows.filter((x) => !x.source_matches_prefix), [{ source_matches_prefix: false, status: 'settled',
      method: 'external_check', recipient_class: 'recipient_name_equal', funds_received: 'listed', payouts: 1, checks: 1, amount: '900.00' }]);
    for (const row of report.released_splits.rows) assert.ok(Object.hasOwn(RECIPIENT_CLASSES, row.recipient_class));

    assert.deepEqual(report.released_checks.rows.filter((x) => x.source_matches_prefix), [
      { source_matches_prefix: true, check_class: 'no_settled_payout', checks: 1, check_amount: '8000.00', settled_amount: '0.00', listed_amount: '0.00', near_miss_amount: '0.00' },
      { source_matches_prefix: true, check_class: 'paid_to_others_only', checks: 1, check_amount: '5000.00', settled_amount: '5000.00', listed_amount: '0.00', near_miss_amount: '0.00' },
      { source_matches_prefix: true, check_class: 'paid_to_target_listed', checks: 3, check_amount: '6000.00', settled_amount: '6000.00', listed_amount: '5600.00', near_miss_amount: '0.00' },
      { source_matches_prefix: true, check_class: 'paid_to_target_near_miss_only', checks: 1, check_amount: '4000.00', settled_amount: '3000.00', listed_amount: '0.00', near_miss_amount: '3000.00' },
    ]);
    for (const row of report.released_checks.rows) assert.ok(CHECK_CLASSES.includes(row.check_class));

    assert.deepEqual(report.send_legs.rows, [
      { source_matches_prefix: true, leg_role: 'send_bank', status: 'completed', to_target: false, legs: 1, checks: 1, amount: '5.00' },
      { source_matches_prefix: true, leg_role: 'send_wallet', status: 'completed', to_target: true, legs: 1, checks: 1, amount: '123.45' },
    ]);
    assert.deepEqual(report.target_own, { payouts: { read: true, rows: [] }, send_legs: { read: true, rows: [] } });

    // A write inside the inspect's transaction is refused by PostgreSQL itself.
    const admin = await open('checksops_admin');
    try {
      await admin.query(Q.begin);
      await assert.rejects(admin.query("CREATE TABLE public.nope (id int)"), (e) => e.code === '25006');
      await admin.query(Q.rollback);
    } finally {
      await admin.end();
    }

    // The inlined normalization equals public.normalize_org_name.
    const inlined = Q.tenants.match(/FILTER \(WHERE (NULLIF\([\s\S]*?\)) LIKE \$1\)/)[1].replaceAll('t.name', 'v');
    const same = await su.query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE ${inlined} IS NOT DISTINCT FROM public.normalize_org_name(v))::int AS equal
      FROM unnest(ARRAY['Condition One Commercial, L.L.C.', 'FREEDOM  Adjustment Co', ' a&b Holdings ', '', NULL, 'Inc', 'x  y Corp.', 'Co Co']) AS v`);
    assert.deepEqual(same.rows[0], { n: 8, equal: 8 });

    // Two tenants match the receiving prefix: only the tenant count is read.
    await su.query(`INSERT INTO public.tenants VALUES ('${ID(4)}', 'Condition One Residential')`);
    const two = await run();
    assert.deepEqual([two.tenants.target_matches, two.tenants.target_resolved], [2, false]);
    for (const part of [two.shares, two.released_splits, two.released_checks, two.send_legs, two.target_own.payouts, two.target_own.send_legs]) {
      assert.deepEqual(part, { read: false, reason: 'target_not_resolved' });
    }
    assert.ok(!statements.some((sql) => /shared_checks|disbursement_splits|payment_transfers/.test(sql)));

    // A missing column skips the statements that read it and nothing else.
    await su.query(`DELETE FROM public.tenants WHERE id = '${ID(4)}'; ALTER TABLE public.disbursement_splits DROP COLUMN recipient_tenant_id`);
    const partial = await run();
    assert.equal(partial.shares.read, true);
    assert.equal(partial.send_legs.read, true);
    assert.deepEqual(partial.released_splits, { read: false, reason: 'columns_missing:disbursement_splits.recipient_tenant_id' });
    assert.equal(partial.target_own.payouts.read, false);
    assert.deepEqual(INSPECT_TABLES.length, 7);
  } finally {
    await su.end();
    server.stop();
  }
});
