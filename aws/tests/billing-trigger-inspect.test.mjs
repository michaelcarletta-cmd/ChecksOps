/**
 * Read-only production inspect of the billing and agent-compensation triggers
 * (scripts/deployment-guard/billing-trigger-inspect.mjs, lib/billing-trigger-inspect.mjs,
 * ops/production-billing-trigger-inspect.md). Owner 2026-11-12: no $5 for an additional check, no agent pay for
 * it, no $4 for a check deposited outside ChecksOps; the live-only tg_accrue_mortgage_ops_billing must be read
 * before a migration replaces it.
 *
 *   - the configuration is inspect-only and bound to the same production RDS and checksops_admin secret as the
 *     Mortgage Desk access inspect; the tool is inventoried SAFE and is not a one-shot apply entry;
 *   - the CLI accepts exactly --inspect, refuses every other argument and any deployment-guard environment
 *     variable before reading a secret or connecting; a connection failure prints only the JSON error code;
 *   - every statement is a fixed catalog constant (BEGIN READ ONLY, SELECT, ROLLBACK) that reads no public table;
 *   - a definition is printed, and withheld when it has an id-, email- or long-number-shaped literal;
 *   - on PostgreSQL 16, as a non-superuser checksops_admin: SQL 98's record_check_billing_event (repo exact), a
 *     live-only trigger function (no repository definition) with its trigger, the missing named functions and
 *     the column names are reported; nothing changes; a write inside the transaction is refused (25006); no row
 *     value appears in the output.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { main } from '../../scripts/deployment-guard/billing-trigger-inspect.mjs';
import {
  COLUMN_TABLES,
  INSPECT_STATEMENTS,
  NAMED_FUNCTIONS,
  Q,
  WATCHED_TABLES,
  buildBillingTriggerReport,
  loadInspectConfig,
} from '../../scripts/deployment-guard/lib/billing-trigger-inspect.mjs';
import { ONE_SHOT_TOOLS } from '../../scripts/deployment-guard/lib/production-sql-one-shot.mjs';
import { pgSkipReason, startPg } from './helpers/stakeholder-policies-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TOOL = 'scripts/deployment-guard/billing-trigger-inspect.mjs';
const LIB = 'scripts/deployment-guard/lib/billing-trigger-inspect.mjs';
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

test('the configuration is inspect-only and bound to the same production RDS and admin secret as the Mortgage Desk inspect', () => {
  const config = loadInspectConfig(ROOT);
  const desk = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/mortgage-desk-access-production-inspect.json'), 'utf8'));
  assert.equal(config.read_only, true);
  assert.equal(config.apply, false);
  assert.equal(config.target_environment, 'production');
  assert.equal(config.tool, TOOL);
  assert.equal(config.execute, undefined);
  assert.equal(config.authorization_phrase, undefined);
  // 2026-11-12: a partial run is recorded (four read-only SSM commands, one output hash); accrue_mortgage_ops_billing was added after it.
  assert.equal(config.production_inspect.status, 'partial');
  assert.equal(config.production_inspect.owner_approval, 'run the billing trigger inspect in production');
  assert.equal(config.production_inspect.ssm_command_ids.length, 4);
  assert.match(config.production_inspect.output_sha256, /^[0-9a-f]{64}$/);
  assert.match(config.production_inspect.note, /accrue_mortgage_ops_billing/);
  for (const key of ['admin_login', 'rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(config[key], desk[key], key);
  assert.ok(fs.existsSync(path.join(ROOT, config.runbook)));
});

test('the tool is inventoried as SAFE, is not a one-shot apply entry and has no write capability', () => {
  const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/bypass-inventory.json'), 'utf8'));
  const entry = inventory.scripts.find((s) => s.path === TOOL);
  assert.ok(entry, 'inventoried');
  assert.equal(entry.classification, 'SAFE');
  assert.deepEqual(entry.capabilities, ['billing-trigger-inspect']);
  assert.match(entry.note, /BEGIN READ ONLY/);
  assert.match(entry.note, /Reads no table row/);
  assert.ok(!JSON.stringify(ONE_SHOT_TOOLS).includes('billing-trigger-inspect'));
  const source = fs.readFileSync(path.join(ROOT, TOOL), 'utf8') + fs.readFileSync(path.join(ROOT, LIB), 'utf8');
  assert.doesNotMatch(source, /CHECKSOPS_DEPLOYMENT_GUARD_APPLY|issueReceipt|acquireLease|UpdateFunctionCode|PutObject|SendCommand/);
});

test('every statement is a fixed read-only catalog constant and reads no public table', () => {
  assert.equal(INSPECT_STATEMENTS[0], 'BEGIN READ ONLY');
  assert.equal(INSPECT_STATEMENTS.at(-1), 'ROLLBACK');
  for (const sql of INSPECT_STATEMENTS) {
    assert.match(sql, READ_ONLY_STATEMENT_RE, sql);
    if (!/^\s*(BEGIN READ ONLY|ROLLBACK)\s*$/.test(sql)) assert.doesNotMatch(sql.replace(/'[^']*'/g, "''"), MUTATING_RE, sql);
    // Catalog only: every relation is pg_catalog.*, never a public table.
    assert.doesNotMatch(sql, /\b(FROM|JOIN)\s+(public\.)?(?!pg_catalog\.|LATERAL\b)[a-z_]+\s/i, sql);
  }
  assert.ok(NAMED_FUNCTIONS.includes('tg_accrue_mortgage_ops_billing'));
  // What the live trigger function calls (production inspect 2026-11-12): read by name, no trigger runs it.
  assert.ok(NAMED_FUNCTIONS.includes('accrue_mortgage_ops_billing'));
  assert.ok(NAMED_FUNCTIONS.includes('record_check_billing_event'));
  assert.ok(NAMED_FUNCTIONS.includes('earn_mortgage_agent_compensation'));
  assert.ok(WATCHED_TABLES.includes('mortgage_handling_requests') && WATCHED_TABLES.includes('check_intake_items'));
  assert.ok(COLUMN_TABLES.includes('deposit_items'));
});

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

test('the CLI refuses any deployment-guard environment variable and a configuration that is not read-only production', async () => {
  for (const env of [{ CHECKSOPS_SKIP_DEPLOYMENT_GUARD: '1' }, { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' }, { CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT: '/tmp/r.json' }]) {
    let touched = false;
    const deps = { root: ROOT, connect: async () => { touched = true; }, resolveUrl: async () => { touched = true; } };
    const { code, text } = await quiet(() => main(['--inspect'], env, deps));
    assert.equal(code, 1);
    assert.equal(touched, false);
    assert.match(text, /refuses to run with deployment-guard environment variables/);
  }
  const base = loadInspectConfig(ROOT);
  for (const config of [{ ...base, read_only: false }, { ...base, apply: true }, { ...base, target_environment: 'staging' }]) {
    const { code } = await quiet(() => main(['--inspect'], {}, { root: ROOT, config, connect: async () => { throw new Error('no'); } }));
    assert.equal(code, 1);
  }
});

test('a connection failure prints only the JSON error with its code', async () => {
  const host = 'billing-unreachable.invalid';
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

test('a definition is printed with SQLSTATE codes, and withheld when it has an id-, email- or long-number-shaped literal', () => {
  const report = (def) => buildBillingTriggerReport({
    session: [{ transaction_read_only: 'on' }], functionAcl: [], triggers: [], columns: [],
    functions: [{ schema: 'public', name: 'tg_accrue_mortgage_ops_billing', identity_arguments: '', prosrc: def, functiondef: def }],
  }, EMPTY_INDEX).functions[0];
  const ok = report("BEGIN RAISE EXCEPTION 'x' USING ERRCODE = '22023'; INSERT INTO x VALUES (500); END");
  assert.match(ok.definition, /ERRCODE = '22023'/);
  assert.equal(ok.repo_definitions, 0);
  assert.equal(report("BEGIN PERFORM 1 WHERE id = '0b8f6f1e-2f0c-4c7e-9a51-6a3f1d2e4b5c'; END").definition_withheld, 'uuid_shaped_literal');
  assert.equal(report("BEGIN PERFORM 'ops@example.com'; END").definition_withheld, 'email_shaped_literal');
  assert.equal(report('BEGIN PERFORM 123456789; END').definition_withheld, 'long_number');
  // Named functions not found are listed.
  const empty = buildBillingTriggerReport({ session: [{ transaction_read_only: 'on' }], functions: [], functionAcl: [], triggers: [], columns: [] }, EMPTY_INDEX);
  assert.deepEqual(empty.missing, [...NAMED_FUNCTIONS]);
  assert.deepEqual(empty.tables_missing, [...COLUMN_TABLES]);
});

// --- PostgreSQL 16 ---------------------------------------------------------------------------

const TENANT = '2d0b8b3a-4b2e-4e9a-9c73-8c5b3f4a6d7e';
const CHECK = '3e1c9c4b-5c3f-4fab-8d84-9d6c4a5b7e8f';
const ROW_MARKER = 'ROWMARKER-Wigodner-0001';
const SQL98 = fs.readFileSync(path.join(ROOT, 'aws/workflows/sql/98_tenant_fee_collection.sql'), 'utf8');
const RECORD_FN = SQL98.slice(SQL98.indexOf('CREATE OR REPLACE FUNCTION public.record_check_billing_event()'), SQL98.indexOf('$$;', SQL98.indexOf('CREATE OR REPLACE FUNCTION public.record_check_billing_event()')) + 3);
const SETUP = `
CREATE ROLE checksops_admin LOGIN NOSUPERUSER NOBYPASSRLS INHERIT;
CREATE ROLE checksops LOGIN NOSUPERUSER NOBYPASSRLS INHERIT;
GRANT USAGE, CREATE ON SCHEMA public TO checksops_admin;
SET ROLE checksops_admin;
CREATE TABLE public.check_intake_items (id uuid PRIMARY KEY, tenant_id uuid, status text, payee_name text);
CREATE TABLE public.mortgage_handling_requests (id uuid PRIMARY KEY, tenant_id uuid, status text, check_intake_item_id uuid);
CREATE TABLE public.deposit_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), check_intake_item_id uuid, provider text, status text);
CREATE TABLE public.check_billing_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, check_intake_item_id uuid, event_type text, unit_price_cents integer, status text);
${RECORD_FN}
CREATE TRIGGER trg_record_check_billing_event AFTER UPDATE OF status ON public.check_intake_items
  FOR EACH ROW EXECUTE FUNCTION public.record_check_billing_event();
CREATE FUNCTION public.accrue_mortgage_ops_billing(p_request_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  INSERT INTO public.check_billing_events (tenant_id, check_intake_item_id, event_type, unit_price_cents, status)
  SELECT r.tenant_id, r.check_intake_item_id, 'mortgage_ops_additional_check', 500, 'recorded'
    FROM public.mortgage_handling_requests r WHERE r.id = p_request_id;
END $fn$;
CREATE FUNCTION public.tg_accrue_mortgage_ops_billing() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  IF NEW.status = 'in_progress' THEN
    PERFORM public.accrue_mortgage_ops_billing(NEW.id);
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER tr_accrue_mortgage_ops_billing AFTER UPDATE OF status ON public.mortgage_handling_requests
  FOR EACH ROW EXECUTE FUNCTION public.tg_accrue_mortgage_ops_billing();
RESET ROLE;
INSERT INTO public.check_intake_items VALUES ('${CHECK}', '${TENANT}', 'received', '${ROW_MARKER}');
INSERT INTO public.deposit_items (check_intake_item_id, provider, status) VALUES ('${CHECK}', 'manual_branch', 'succeeded');
INSERT INTO public.check_billing_events (tenant_id, check_intake_item_id, event_type, unit_price_cents, status)
VALUES ('${TENANT}', '${CHECK}', 'check_processing', 400, 'recorded');
`;
const SNAPSHOT = `SELECT
  (SELECT pg_catalog.string_agg(p.proname || ':' || pg_catalog.md5(p.prosrc), ',' ORDER BY p.proname) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public') AS functions,
  (SELECT pg_catalog.md5(pg_catalog.string_agg(t::text, ',' ORDER BY t::text)) FROM public.check_billing_events t) AS events,
  (SELECT pg_catalog.md5(pg_catalog.string_agg(t::text, ',' ORDER BY t::text)) FROM public.check_intake_items t) AS checks`;

test('PostgreSQL 16: the inspect is read-only and reports the triggers, the live-only body, the repo match and the columns', {
  timeout: 180000, skip: pgSkipReason() || false,
}, async (t) => {
  let pg;
  try {
    pg = (await import('pg')).default;
  } catch {
    t.skip('pg module is not installed');
    return;
  }
  const server = startPg('pg-billing-trigger-inspect-', 61800);
  const open = async (user) => {
    const c = new pg.Client({ host: server.host, port: server.port, user, database: 'postgres' });
    await c.connect();
    return c;
  };
  const su = await open('ubuntu');
  try {
    await su.query(SETUP);
    const statements = [];
    const connect = async () => {
      const c = await open('checksops_admin');
      const query = c.query.bind(c);
      c.query = (sql, params) => { statements.push(typeof sql === 'string' ? sql : sql.text); return query(sql, params); };
      return c;
    };
    const before = (await su.query(SNAPSHOT)).rows[0];
    const { code, text } = await quiet(() => main(['--inspect'], {}, { root: ROOT, connect }));
    assert.equal(code, 0, text);
    assert.deepEqual((await su.query(SNAPSHOT)).rows[0], before, 'nothing changed');
    for (const sql of statements) assert.ok(INSPECT_STATEMENTS.includes(sql), sql);
    assert.equal(statements[0], 'BEGIN READ ONLY');
    assert.equal(statements.at(-1), 'ROLLBACK');
    for (const leak of [TENANT, CHECK, ROW_MARKER]) assert.ok(!text.includes(leak), `leaked ${leak}`);
    const report = JSON.parse(text).details;
    assert.equal(report.transaction_read_only, true);
    assert.equal(report.current_user, 'checksops_admin');

    assert.deepEqual(report.triggers.map((x) => [x.table, x.name, x.function, x.enabled]), [
      ['check_intake_items', 'trg_record_check_billing_event', 'public.record_check_billing_event', 'origin'],
      ['mortgage_handling_requests', 'tr_accrue_mortgage_ops_billing', 'public.tg_accrue_mortgage_ops_billing', 'origin'],
    ]);
    assert.match(report.triggers[1].triggerdef, /AFTER UPDATE OF status ON public\.mortgage_handling_requests/);
    const fns = Object.fromEntries(report.functions.map((f) => [f.name, f]));
    // SQL 98's body is live: exact repository match.
    assert.equal(fns['public.record_check_billing_event'].repo_match, 'exact');
    assert.ok(fns['public.record_check_billing_event'].matched_sources.includes('aws/workflows/sql/98_tenant_fee_collection.sql'));
    assert.deepEqual(fns['public.record_check_billing_event'].run_by_triggers, ['check_intake_items.trg_record_check_billing_event']);
    // The live-only trigger function: no repository definition; its body is printed.
    const accrue = fns['public.tg_accrue_mortgage_ops_billing'];
    assert.equal(accrue.repo_definitions, 0);
    assert.equal(accrue.repo_match, 'differs_from_repo');
    assert.equal(accrue.security_definer, true);
    assert.equal(accrue.owner, 'checksops_admin');
    assert.match(accrue.definition, /PERFORM public\.accrue_mortgage_ops_billing\(NEW\.id\)/);
    // What it calls is read by name although no trigger runs it: live-only, printed.
    const callee = fns['public.accrue_mortgage_ops_billing'];
    assert.equal(callee.signature, 'public.accrue_mortgage_ops_billing(p_request_id uuid)');
    assert.equal(callee.repo_definitions, 0);
    assert.deepEqual(callee.run_by_triggers, []);
    assert.match(callee.definition, /mortgage_ops_additional_check/);
    assert.match(accrue.functiondef_sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(report.missing.sort(), ['aws_check_billing_charges_when_per_check_off', 'aws_check_processing_price_cents',
      'earn_mortgage_agent_compensation', 'tg_earn_mortgage_agent_compensation']);
    assert.deepEqual(report.columns.deposit_items.map((c) => c.name), ['id', 'check_intake_item_id', 'provider', 'status']);
    assert.deepEqual(report.tables_missing.sort(), ['mortgage_agent_compensation_entries', 'mortgage_agent_compensation_rates']);

    // The inspect's transaction is read-only: a write inside it is refused.
    const c = await open('checksops_admin');
    try {
      await c.query(Q.begin);
      await assert.rejects(c.query("UPDATE public.check_intake_items SET status = 'deposited'"), (error) => error.code === '25006');
      await c.query(Q.rollback);
    } finally {
      await c.end();
    }
  } finally {
    await su.end();
    server.stop();
  }
});
