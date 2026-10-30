/**
 * Read-only production inspect of the financial TOTP database surface
 * (scripts/deployment-guard/financial-totp-live-inspect.mjs,
 * lib/financial-totp-live-inspect.mjs, ops/security/FINANCIAL_TOTP_LIVE_INSPECT.md):
 *
 *   - the configuration is inspect-only and bound to the same production RDS and
 *     checksops_admin secret as the Mortgage Desk access inspect; the tool is inventoried SAFE
 *     and is not a one-shot apply entry;
 *   - the CLI accepts exactly --inspect, refuses every other argument and any deployment-guard
 *     environment variable before reading a secret or connecting;
 *   - every statement is a fixed constant: BEGIN READ ONLY, a SELECT or ROLLBACK, and none
 *     selects a user id, tenant id, secret, ciphertext, nonce, key id or metadata column;
 *   - the action allow-list parser reads IN (...) and = ANY (ARRAY[...]) checks and ignores
 *     comments;
 *   - on PostgreSQL 16, as a non-superuser checksops_admin that owns the tables, with the
 *     proposed SQL loaded: the tool reports accepts_code_check false and the allow-list
 *     enroll_start / enroll_confirm / step_up; after the function is replaced with one that
 *     also allows code_check it reports true; nothing changes; a write inside the inspect's
 *     transaction is refused (25006); and the output has no ids, secrets or row values.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { main } from '../../scripts/deployment-guard/financial-totp-live-inspect.mjs';
import {
  ACTIVITY_SINCE,
  CODE_CHECK_ACTION,
  INSPECT_STATEMENTS,
  NEVER_SELECTED_COLUMNS,
  PROPOSED_REL,
  Q,
  acceptsAction,
  buildFinancialTotpReport,
  inspectFinancialTotp,
  loadInspectConfig,
  parseActionAllowList,
} from '../../scripts/deployment-guard/lib/financial-totp-live-inspect.mjs';
import { ONE_SHOT_TOOLS } from '../../scripts/deployment-guard/lib/production-sql-one-shot.mjs';
import { pgSkipReason, startPg } from './helpers/stakeholder-policies-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TOOL = 'scripts/deployment-guard/financial-totp-live-inspect.mjs';
const LIB = 'scripts/deployment-guard/lib/financial-totp-live-inspect.mjs';
const READ_ONLY_STATEMENT_RE = /^\s*(BEGIN READ ONLY|SELECT|ROLLBACK)\b/;
const MUTATING_RE = /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE|COPY|CALL|DO|LOCK|VACUUM|ANALYZE|REFRESH|COMMENT|SECURITY LABEL|REASSIGN|nextval|setval|pg_terminate|pg_cancel|lo_)\b/i;
const EMPTY_INDEX = { functions: new Map(), policies: new Map() };
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
  for (const key of ['admin_login', 'rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(config[key], desk[key], key);
  assert.ok(fs.existsSync(path.join(ROOT, config.runbook)));
});

test('the tool is inventoried as SAFE, is not a one-shot apply entry and has no write capability', () => {
  const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/bypass-inventory.json'), 'utf8'));
  const entry = inventory.scripts.find((s) => s.path === TOOL);
  assert.ok(entry, 'inventoried');
  assert.equal(entry.classification, 'SAFE');
  assert.match(entry.note, /BEGIN READ ONLY/);
  // SQL 129's one-shot (sql129-financial-totp-rate-limit-code-check-production-apply) is; this inspect is not.
  assert.ok(!JSON.stringify(ONE_SHOT_TOOLS).includes('financial-totp-live-inspect'));
  const source = fs.readFileSync(path.join(ROOT, TOOL), 'utf8') + fs.readFileSync(path.join(ROOT, LIB), 'utf8');
  assert.doesNotMatch(source, /CHECKSOPS_DEPLOYMENT_GUARD_APPLY|issueReceipt|acquireLease|UpdateFunctionCode|PutObject|SendCommand/);
});

test('every statement is a fixed read-only constant and none selects secret or identifying columns', () => {
  assert.equal(INSPECT_STATEMENTS[0], 'BEGIN READ ONLY');
  assert.equal(INSPECT_STATEMENTS.at(-1), 'ROLLBACK');
  for (const sql of INSPECT_STATEMENTS) {
    assert.match(sql, READ_ONLY_STATEMENT_RE, sql);
    if (!/^\s*(BEGIN READ ONLY|ROLLBACK)\s*$/.test(sql)) assert.doesNotMatch(sql.replace(/'[^']*'/g, "''"), MUTATING_RE, sql);
    for (const col of NEVER_SELECTED_COLUMNS) assert.doesNotMatch(sql, new RegExp(`\\b${col}\\b`), `${col} in ${sql}`);
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
  const host = 'totp-unreachable.invalid';
  const password = 'Hunter2-not-a-real-password';
  const failing = async () => {
    const error = new Error(`getaddrinfo ENOTFOUND ${host} (postgres://checksops_admin:${password}@${host}:5432/postgres)`);
    error.code = 'ENOTFOUND';
    throw error;
  };
  const { code, text } = await quiet(() => main(['--inspect'], {}, { root: ROOT, connect: failing, index: EMPTY_INDEX, proposed: new Map() }));
  assert.equal(code, 1);
  const result = JSON.parse(text);
  assert.deepEqual(Object.keys(result.details).sort(), ['error_code', 'read_only', 'stage']);
  assert.equal(result.details.stage, 'connect');
  assert.equal(result.details.error_code, 'ENOTFOUND');
  for (const leak of [host, password, 'postgres://', '    at ']) assert.ok(!text.includes(leak), `leaked ${leak}`);
});

// --- parsing -----------------------------------------------------------------------------

test('the allow-list parser reads IN (...) and = ANY (ARRAY[...]) checks and ignores comments', () => {
  assert.deepEqual(parseActionAllowList("IF p_action IS NULL OR p_action NOT IN ('enroll_start', 'enroll_confirm', 'step_up') THEN"),
    { recognized: true, actions: ['enroll_confirm', 'enroll_start', 'step_up'], form: 'in' });
  assert.deepEqual(parseActionAllowList("IF NOT (p_action = ANY (ARRAY['enroll_start'::text, 'code_check'::text])) THEN"),
    { recognized: true, actions: ['code_check', 'enroll_start'], form: 'any_array' });
  assert.deepEqual(parseActionAllowList("-- p_action NOT IN ('code_check')\nRETURN QUERY SELECT true;"), { recognized: false, actions: null, form: null });
  assert.deepEqual(acceptsAction(parseActionAllowList("p_action NOT IN ('step_up')"), CODE_CHECK_ACTION), { accepts: false, reason: null });
  assert.deepEqual(acceptsAction({ recognized: false }, CODE_CHECK_ACTION), { accepts: null, reason: 'no_recognized_action_allow_list' });
});

test('a definition is printed with SQLSTATE codes, and withheld when it has an id-, email- or long-number-shaped literal', () => {
  const report = (def) => buildFinancialTotpReport({
    session: [{ transaction_read_only: 'on' }], functionAcl: [], tables: [], columns: [], skipped: {},
    functions: [{ schema: 'public', name: 'financial_totp_status', identity_arguments: 'p_user_id uuid', prosrc: def, functiondef: def }],
  }, EMPTY_INDEX, new Map()).functions[0];
  const ok = report("BEGIN RAISE EXCEPTION 'x' USING ERRCODE = '22023'; END");
  assert.match(ok.definition, /ERRCODE = '22023'/);
  assert.equal(report(`BEGIN PERFORM 1 WHERE id = '${'0b8f6f1e-2f0c-4c7e-9a51-6a3f1d2e4b5c'}'; END`).definition_withheld, 'uuid_shaped_literal');
  assert.equal(report("BEGIN PERFORM 'ops@example.com'; END").definition_withheld, 'email_shaped_literal');
  assert.equal(report('BEGIN PERFORM 123456789; END').definition_withheld, 'long_number');
});

test('a missing rate-limit function is reported as such, with no verdict', () => {
  const report = buildFinancialTotpReport({ session: [{ transaction_read_only: 'on' }], functions: [], functionAcl: [], tables: [], columns: [], skipped: {} }, EMPTY_INDEX, new Map());
  assert.equal(report.accepts_code_check, null);
  assert.deepEqual(report.rate_limit, { present: false, overloads: 0, accepts_code_check: null, reason: 'function_missing' });
  assert.equal(report.tables.financial_totp_rate_limits.exists, false);
  assert.equal(report.activity.rate_limit.read, false);
});

// --- PostgreSQL 16 ---------------------------------------------------------------------------

const USER_A = '0b8f6f1e-2f0c-4c7e-9a51-6a3f1d2e4b5c';
const USER_B = '1c9a7a2f-3a1d-4d8f-8b62-7b4a2e3f5c6d';
const TENANT = '2d0b8b3a-4b2e-4e9a-9c73-8c5b3f4a6d7e';
const SECRET_MARKER = 'SECRETMARKER0123456789';
const KEY_ID = 'arn:aws:kms:us-east-1:000000000000:key/totp-test-key';

const SETUP = `
CREATE ROLE checksops_admin LOGIN NOSUPERUSER NOBYPASSRLS INHERIT;
CREATE ROLE checksops LOGIN NOSUPERUSER NOBYPASSRLS INHERIT;
CREATE ROLE authenticated NOLOGIN;
GRANT USAGE, CREATE ON SCHEMA public TO checksops_admin;
CREATE TABLE public.financial_stepup_log (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY, user_id uuid NOT NULL, tenant_id uuid,
  action_key text NOT NULL, factor_type text NOT NULL DEFAULT 'totp', succeeded boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.financial_stepup_log OWNER TO checksops_admin;
`;
const ROWS = `
INSERT INTO public.financial_totp_enrollments (application_user_id, ciphertext, nonce, key_id, verified_at, failed_attempts, last_used_timestep)
VALUES ('${USER_A}', convert_to('${SECRET_MARKER}', 'UTF8'), convert_to('nonce-${SECRET_MARKER}', 'UTF8'), '${KEY_ID}', now(), 2, 59000000),
       ('${USER_B}', convert_to('${SECRET_MARKER}-b', 'UTF8'), convert_to('nonce-b', 'UTF8'), '${KEY_ID}', NULL, 0, NULL);
INSERT INTO public.financial_totp_rate_limits (user_id, action, window_started_at, request_count)
VALUES ('${USER_A}', 'step_up', '2026-10-29T15:52:00Z', 1), ('${USER_B}', 'enroll_confirm', '2026-10-30T10:00:00Z', 3),
       ('${USER_A}', 'Weird Action ${USER_B}', '2026-10-30T11:00:00Z', 1), ('${USER_B}', 'step_up', '2026-10-01T00:00:00Z', 4);
INSERT INTO public.financial_stepup_log (user_id, tenant_id, action_key, succeeded, metadata, created_at)
VALUES ('${USER_A}', '${TENANT}', 'wallet_fund', true, '{"note":"${SECRET_MARKER}"}', '2026-10-29T15:52:07Z'),
       ('${USER_B}', '${TENANT}', 'wallet_fund', false, '{}', '2026-10-30T09:00:00Z');
`;
const WITH_CODE_CHECK = (proposed) => {
  const start = proposed.indexOf('CREATE OR REPLACE FUNCTION public.consume_financial_totp_rate_limit(');
  const end = proposed.indexOf('COMMENT ON FUNCTION public.consume_financial_totp_rate_limit');
  return proposed.slice(start, end).replace("NOT IN ('enroll_start', 'enroll_confirm', 'step_up')", "NOT IN ('enroll_start', 'enroll_confirm', 'step_up', 'code_check')");
};
const SNAPSHOT = `SELECT
  (SELECT pg_catalog.string_agg(p.proname || ':' || pg_catalog.md5(p.prosrc), ',' ORDER BY p.proname) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public') AS functions,
  (SELECT pg_catalog.md5(pg_catalog.string_agg(t::text, ',' ORDER BY t::text)) FROM public.financial_totp_rate_limits t) AS rate_limits,
  (SELECT pg_catalog.md5(pg_catalog.string_agg(t::text, ',' ORDER BY t::text)) FROM public.financial_totp_enrollments t) AS enrollments,
  (SELECT pg_catalog.md5(pg_catalog.string_agg(t::text, ',' ORDER BY t::text)) FROM public.financial_stepup_log t) AS stepups`;

test('PostgreSQL 16: the inspect is read-only and tells whether the live rate-limit function accepts code_check', {
  timeout: 180000, skip: pgSkipReason() || false,
}, async (t) => {
  let pg;
  try {
    pg = (await import('pg')).default;
  } catch {
    t.skip('pg module is not installed');
    return;
  }
  const server = startPg('pg-financial-totp-inspect-', 61700);
  const open = async (user) => {
    const c = new pg.Client({ host: server.host, port: server.port, user, database: 'postgres' });
    await c.connect();
    return c;
  };
  const su = await open('ubuntu');
  const proposed = fs.readFileSync(path.join(ROOT, PROPOSED_REL), 'utf8');
  try {
    await su.query(SETUP);
    await su.query(proposed);
    await su.query(ROWS);

    const statements = [];
    const connect = async () => {
      const c = await open('checksops_admin');
      const query = c.query.bind(c);
      c.query = (sql, params) => { statements.push(typeof sql === 'string' ? sql : sql.text); return query(sql, params); };
      return c;
    };
    const run = async () => {
      statements.length = 0;
      const before = (await su.query(SNAPSHOT)).rows[0];
      const { code, text } = await quiet(() => main(['--inspect'], {}, { root: ROOT, connect }));
      assert.equal(code, 0, text);
      assert.deepEqual((await su.query(SNAPSHOT)).rows[0], before, 'nothing changed');
      assert.ok(statements.length > 5);
      for (const sql of statements) assert.ok(INSPECT_STATEMENTS.includes(sql), sql);
      assert.equal(statements[0], 'BEGIN READ ONLY');
      assert.equal(statements.at(-1), 'ROLLBACK');
      for (const leak of [USER_A, USER_B, TENANT, SECRET_MARKER, KEY_ID, 'Weird Action', '59000000']) assert.ok(!text.includes(leak), `leaked ${leak}`);
      return JSON.parse(text).details;
    };

    // 1. The proposed (NOT_APPLIED) definition: code_check is refused.
    const report = await run();
    assert.equal(report.transaction_read_only, true);
    assert.equal(report.current_user, 'checksops_admin');
    assert.equal(report.server_major_version, 16);
    assert.equal(report.accepts_code_check, false);
    assert.equal(report.rate_limit.present, true);
    assert.deepEqual(report.rate_limit.detail[0].action_allow_list, ['enroll_confirm', 'enroll_start', 'step_up']);
    assert.equal(report.rate_limit.detail[0].raises_invalid_rate_limit_action, true);
    assert.deepEqual(report.rate_limit.detail[0].accepts_api_actions, { enroll_start: true, code_check: false });
    const fns = Object.fromEntries(report.functions.map((f) => [f.name, f]));
    assert.deepEqual(Object.keys(fns).sort(), [
      'public.consume_financial_totp_rate_limit', 'public.financial_totp_get_enrollment', 'public.financial_totp_mark_verified',
      'public.financial_totp_status', 'public.financial_totp_upsert_enrollment']);
    const rl = fns['public.consume_financial_totp_rate_limit'];
    assert.equal(rl.security_definer, true);
    assert.equal(rl.owner, 'checksops_admin');
    assert.equal(rl.matches_proposed_file, 'exact');
    assert.match(rl.definition, /invalid_rate_limit_action/);
    assert.match(rl.functiondef_sha256, /^[0-9a-f]{64}$/);
    assert.equal(rl.public_execute, false);
    assert.ok(rl.execute_acl.some((e) => e.grantee === 'checksops' && e.privilege === 'EXECUTE'));
    assert.deepEqual(report.tables.financial_totp_enrollments.columns.map((c) => c.name).slice(0, 2), ['application_user_id', 'ciphertext']);
    assert.equal(report.tables.financial_totp_rate_limits.rls_enabled, true);
    // Aggregate activity only; the odd action label is counted as 'other'; rows before the cut-off are excluded.
    assert.equal(report.activity.since, ACTIVITY_SINCE);
    assert.deepEqual(report.activity.rate_limit.rows, [
      { action: 'enroll_confirm', day: '2026-10-30', rows: 1, requests: 3 },
      { action: 'other', day: '2026-10-30', rows: 1, requests: 1 },
      { action: 'step_up', day: '2026-10-29', rows: 1, requests: 1 },
    ]);
    assert.equal(report.activity.code_check_rows, 0);
    assert.deepEqual(report.activity.step_up.rows, [
      { action: 'wallet_fund', succeeded: false, day: '2026-10-30', rows: 1 },
      { action: 'wallet_fund', succeeded: true, day: '2026-10-29', rows: 1 },
    ]);
    assert.deepEqual(report.activity.enrollments, { read: true, enrolled: 2, verified: 1, with_failed_attempts: 1, locked_until_set: 0, last_used_timestep_set: 1 });

    // 2. A live function that also allows code_check.
    await su.query(WITH_CODE_CHECK(proposed));
    const fixed = await run();
    assert.equal(fixed.accepts_code_check, true);
    assert.deepEqual(fixed.rate_limit.detail[0].action_allow_list, ['code_check', 'enroll_confirm', 'enroll_start', 'step_up']);
    const fixedRl = fixed.functions.find((f) => f.name === 'public.consume_financial_totp_rate_limit');
    assert.equal(fixedRl.matches_proposed_file, 'differs');
    // The definition with code_check is SQL 129's (aws/workflows/sql/129_financial_totp_rate_limit_code_check.sql).
    assert.equal(fixedRl.repo_match, 'exact');

    // 3. The inspect's transaction is read-only: a write inside it is refused.
    const c = await open('checksops_admin');
    try {
      await c.query(Q.begin);
      await assert.rejects(
        c.query("INSERT INTO public.financial_totp_rate_limits (user_id, action) VALUES (gen_random_uuid(), 'code_check')"),
        (error) => error.code === '25006',
      );
      await c.query(Q.rollback);
    } finally {
      await c.end();
    }
  } finally {
    await su.end();
    server.stop();
  }
});
