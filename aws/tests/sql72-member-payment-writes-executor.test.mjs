/**
 * Staging VPC executor support for SQL 72 (tenant-member payment write policies).
 * A fake client covers the decision logic; the PostgreSQL 16 test runs the real
 * handler against payment tables with RLS and the live helper functions.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import {
  AUTHORIZED_SQL72_MEMBER_PAYMENT_WRITES as PIN,
  AUTHORIZED_STAGING_SQL,
  MEMBER_PAYMENT_POLICIES,
  authorizationFingerprint,
  evaluateSqlExecutorAuthorization,
  memberPaymentPolicyStateText,
  resolveAuthorizedMigration,
} from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import { importGuardedSqlExecutor } from './helpers/import-guarded-sql-executor.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PG_BIN = '/usr/lib/postgresql/16/bin';
const SQL_FILE = path.join(ROOT, PIN.filename);
const NOW = '2026-10-13T17:30:00.000Z';
const sha = (text) => createHash('sha256').update(text).digest('hex');

const { module: executorModule } = await importGuardedSqlExecutor();
const { createHandler, sql72StatementsAllowed } = executorModule;

function policyEvent(overrides = {}) {
  const oneUse = overrides.one_use_id || `sql72-test-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const event = {
    action: 'apply',
    workstream_id: 'staging-sql72-member-payment-writes',
    branch: 'main',
    commit: PIN.commit,
    operator: 'test-agent',
    target_environment: 'staging',
    target_component: 'staging-sql',
    deployment_type: 'sql-executor-invoke',
    owned_components: [PIN.filename],
    filename: PIN.filename,
    migration_id: PIN.migration_id,
    source_sha256: PIN.source_sha256,
    intended_replacement_sha256: PIN.intended_replacement_sha256,
    expected_live_definition_sha256: PIN.expected_live_definition_sha256,
    one_use_id: oneUse,
    expiry: '2026-10-13T18:30:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    ...overrides,
  };
  event.one_use_id = oneUse;
  event.preflight_live_fingerprint = authorizationFingerprint(event);
  return event;
}

function handlerFor(connect, extra = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(
    os.tmpdir(),
    `sql72-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), sqlFile72: SQL_FILE, ...extra });
}

const neverConnect = async () => {
  throw new Error('should-not-connect');
};

const MEMBER_CLAUSE = '(aws_is_authenticated() AND COALESCE(aws_financial_execution_active(), false) AND (tenant_id IN ( SELECT aws_user_tenant_ids() AS aws_user_tenant_ids)))';
const EXISTING = [
  { tablename: 'payment_transfers', policyname: 'aws_write_payment_transfers', cmd: 'ALL', roles: '{authenticated}', permissive: 'PERMISSIVE', qual: 'aws_can_write_tenant(tenant_id)', with_check: 'aws_can_write_tenant(tenant_id)' },
  { tablename: 'payment_wallets', policyname: 'aws_write_payment_wallets', cmd: 'ALL', roles: '{authenticated}', permissive: 'PERMISSIVE', qual: 'aws_can_write_tenant(tenant_id)', with_check: 'aws_can_write_tenant(tenant_id)' },
];

/** In-memory pg_policies. Running the embedded SQL adds the five member policies (or a variant). */
function fakeDb({ policies = EXISTING, functions = ['aws_financial_execution_active', 'aws_is_authenticated', 'aws_user_tenant_ids'], noExecute = [], onApply } = {}) {
  let committed = policies.map((row) => ({ ...row }));
  let working = null;
  const current = () => working || committed;
  return {
    get policies() { return committed; },
    connect: async () => ({
      end: async () => {},
      query: async (sql) => {
        const text = String(sql);
        if (text === 'BEGIN') { working = committed.map((row) => ({ ...row })); return { rows: [] }; }
        if (text === 'COMMIT') { committed = working; working = null; return { rows: [] }; }
        if (text === 'ROLLBACK') { working = null; return { rows: [] }; }
        if (text.includes('pg_advisory_xact_lock')) return { rows: [] };
        if (text.includes('FROM pg_policies')) return { rows: current() };
        if (text.includes('FROM pg_proc')) return { rows: functions.map((proname) => ({ proname, can_execute: !noExecute.includes(proname) })) };
        if (text.includes('CREATE POLICY aws_member_')) {
          const added = MEMBER_PAYMENT_POLICIES.map((row) => ({
            tablename: row.table, policyname: row.name, cmd: row.cmd, roles: '{authenticated}', permissive: 'PERMISSIVE',
            qual: row.cmd === 'UPDATE' ? MEMBER_CLAUSE : null, with_check: MEMBER_CLAUSE,
          }));
          working = onApply ? onApply([...working, ...added]) : [...working, ...added];
          return { rows: [] };
        }
        throw new Error(`unexpected SQL ${text.slice(0, 60)}`);
      },
    }),
  };
}

test('pin matches the SQL file, the main commit and the canonical state hashes', () => {
  assert.equal(sha(fs.readFileSync(SQL_FILE)), PIN.source_sha256);
  assert.equal(sha(memberPaymentPolicyStateText('absent')), PIN.expected_live_definition_sha256);
  assert.equal(sha(memberPaymentPolicyStateText('present')), PIN.intended_replacement_sha256);
  assert.ok(AUTHORIZED_STAGING_SQL.includes(PIN));
  assert.equal(resolveAuthorizedMigration({ filename: PIN.filename, migration_id: PIN.migration_id }), PIN);
  assert.equal(evaluateSqlExecutorAuthorization(policyEvent(), { now: Date.parse(NOW) }).ok, true);
  assert.equal(sql72StatementsAllowed(fs.readFileSync(SQL_FILE, 'utf8')), true);
  const atCommit = spawnSync('git', ['show', `${PIN.commit}:${PIN.filename}`], { cwd: ROOT, maxBuffer: 1024 * 1024 });
  if (atCommit.status === 0) assert.equal(sha(atCommit.stdout), PIN.source_sha256);
});

test('statement allowlist refuses anything beyond the five pinned policies', () => {
  const sql = fs.readFileSync(SQL_FILE, 'utf8');
  for (const extra of [
    'GRANT ALL ON public.payment_transfers TO authenticated;',
    'DROP POLICY IF EXISTS aws_write_payment_transfers ON public.payment_transfers;',
    'CREATE POLICY aws_member_select_payment_transfers ON public.payment_transfers FOR SELECT TO authenticated USING (true);',
    'ALTER TABLE public.payment_transfers DISABLE ROW LEVEL SECURITY;',
  ]) {
    assert.equal(sql72StatementsAllowed(`${sql}\n${extra}\n`), false, extra);
  }
  assert.equal(sql72StatementsAllowed(sql.replace('FOR UPDATE TO authenticated', 'FOR INSERT TO authenticated')), false);
  assert.equal(sql72StatementsAllowed(sql.replace('TO authenticated', 'TO PUBLIC')), false);
  assert.equal(sql72StatementsAllowed(sql.replace('TO authenticated', 'TO authenticated, anon')), false);
  assert.equal(sql72StatementsAllowed(sql.replace('WITH CHECK (\n    public.aws_is_authenticated()', 'WITH CHECK (\n    true OR public.aws_is_authenticated()')), false);
  // Order matters: a CREATE moved ahead of its DROP is refused.
  const [first, second] = sql.split(';');
  assert.equal(sql72StatementsAllowed(sql.replace(`${first};${second};`, `${second};${first};`)), false);
});

test('apply refuses before connecting unless it is the exact pin, and a tampered file is refused', async () => {
  const other = await handlerFor(neverConnect)(policyEvent({ expected_live_definition_sha256: 'b'.repeat(64) }));
  assert.equal(other.code, CODES.SQL_COLLISION);
  const tampered = path.join(os.tmpdir(), `sql72-tampered-${process.pid}.sql`);
  fs.writeFileSync(tampered, `${fs.readFileSync(SQL_FILE, 'utf8')}GRANT ALL ON public.payment_transfers TO authenticated;\n`);
  try {
    const result = await handlerFor(neverConnect, { sqlFile72: tampered })(policyEvent());
    assert.equal(result.code, CODES.SQL_COLLISION);
  } finally {
    fs.rmSync(tampered, { force: true });
  }
});

test('inspect, apply, replay and re-apply refusal', async () => {
  const db = fakeDb();
  const handler = handlerFor(db.connect);
  const inspect = await handler(policyEvent({ action: 'inspect' }));
  assert.equal(inspect.ok, true, JSON.stringify(inspect));
  assert.equal(inspect.details.receipt.apply_preconditions_met, true);
  assert.equal(inspect.details.receipt.other_policy_count, 2);

  const event = policyEvent();
  const applied = await handler(event);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.after_hash, PIN.intended_replacement_sha256);
  assert.equal(db.policies.length, 7);

  assert.equal((await handler(event)).code, CODES.SQL_COLLISION);
  assert.equal((await handler(policyEvent())).code, CODES.UNRELATED_MUTATION);
});

test('drift, missing helpers and collateral changes are refused and rolled back', async () => {
  const partial = fakeDb({ policies: [...EXISTING, { tablename: 'payment_wallets', policyname: 'aws_member_insert_payment_wallets', cmd: 'INSERT', roles: '{authenticated}', permissive: 'PERMISSIVE', qual: null, with_check: 'true' }] });
  assert.equal((await handlerFor(partial.connect)(policyEvent())).code, CODES.DEPLOYMENT_COLLISION);

  const noExecute = fakeDb({ noExecute: ['aws_financial_execution_active'] });
  assert.equal((await handlerFor(noExecute.connect)(policyEvent())).code, CODES.DEPLOYMENT_COLLISION);
  assert.equal(noExecute.policies.length, 2);

  const noHelpers = fakeDb({ functions: ['aws_is_authenticated'] });
  const missing = await handlerFor(noHelpers.connect)(policyEvent());
  assert.equal(missing.code, CODES.DEPLOYMENT_COLLISION);
  assert.equal(noHelpers.policies.length, 2);

  const collateral = fakeDb({ onApply: (rows) => rows.filter((row) => row.policyname !== 'aws_write_payment_wallets') });
  const refused = await handlerFor(collateral.connect)(policyEvent());
  assert.equal(refused.code, CODES.UNRELATED_MUTATION);
  assert.equal(collateral.policies.length, 2);

  const loose = fakeDb({ onApply: (rows) => rows.map((row) => (row.policyname === 'aws_member_insert_payment_transfers'
    ? { ...row, with_check: `(${row.with_check} OR aws_is_cross_tenant_reader())` } : row)) });
  assert.equal((await handlerFor(loose.connect)(policyEvent())).code, CODES.UNRELATED_MUTATION);
  assert.equal(loose.policies.length, 2);

  const orTrue = fakeDb({ onApply: (rows) => rows.map((row) => (row.policyname === 'aws_member_update_payment_wallets'
    ? { ...row, qual: `(true OR ${row.qual})` } : row)) });
  assert.equal((await handlerFor(orTrue.connect)(policyEvent())).code, CODES.UNRELATED_MUTATION);
  assert.equal(orTrue.policies.length, 2);
});

const pgSkipReason = () => {
  if (!fs.existsSync(path.join(PG_BIN, 'initdb'))) return 'PostgreSQL 16 initdb is not installed in this environment';
  if (typeof process.getuid === 'function' && process.getuid() === 0) return 'initdb cannot run as root';
  return null;
};

test('PostgreSQL 16: the real handler applies SQL 72 and members can write only with the server marker', {
  timeout: 180000,
}, async (t) => {
  const reason = pgSkipReason();
  if (reason) {
    t.skip(reason);
    return;
  }
  const pgData = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-sql72-'));
  const port = 59700 + (process.pid % 1000);
  const init = spawnSync(path.join(PG_BIN, 'initdb'), ['-D', pgData, '--auth=trust', '--no-sync', '--username=ubuntu', '--encoding=UTF8'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  fs.appendFileSync(path.join(pgData, 'postgresql.conf'), `\nlisten_addresses = ''\nport = ${port}\nunix_socket_directories = '${pgData}'\nlogging_collector = off\n`);
  const started = spawnSync(path.join(PG_BIN, 'pg_ctl'), ['-D', pgData, '-l', path.join(pgData, 'pg.log'), '-w', '-t', '30', 'start'], { encoding: 'utf8' });
  assert.equal(started.status, 0, started.stderr);
  const admin = new pg.Client({ host: pgData, port, user: 'ubuntu', database: 'postgres' });
  await admin.connect();
  await admin.query('CREATE ROLE authenticated NOLOGIN');
  await admin.query('CREATE ROLE checksops LOGIN IN ROLE authenticated');
  await admin.query('CREATE DATABASE sql72');
  const connect = async (user = 'ubuntu') => {
    const client = new pg.Client({ host: pgData, port, user, database: 'sql72' });
    await client.connect();
    return client;
  };
  const MEMBER = '11111111-1111-4111-8111-111111111111';
  const TENANT = '22222222-2222-4222-8222-222222222222';
  const OTHER = '33333333-3333-4333-8333-333333333333';
  try {
    const seed = await connect();
    await seed.query(`
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.app_user_id', true), '')::uuid $$;
      CREATE TABLE public.tenant_users (user_id uuid, tenant_id uuid);
      INSERT INTO public.tenant_users VALUES ('${MEMBER}', '${TENANT}');
      CREATE FUNCTION public.aws_user_tenant_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public SET row_security = off AS $$ SELECT tenant_id FROM public.tenant_users WHERE user_id = auth.uid() $$;
      CREATE FUNCTION public.aws_is_authenticated() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT auth.uid() IS NOT NULL $$;
      CREATE FUNCTION public.aws_financial_execution_active() RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT COALESCE(current_setting('request.financial_execution', true) = '1'
          AND current_setting('request.aws_financial_permissions_activated', true) = '1', false) $$;
      CREATE TABLE public.payment_transfers (id serial PRIMARY KEY, tenant_id uuid, status text);
      CREATE TABLE public.payment_wallets (id serial PRIMARY KEY, tenant_id uuid, available_cents bigint);
      CREATE TABLE public.payment_event_log (id serial PRIMARY KEY, tenant_id uuid, event_type text);
      ALTER TABLE public.payment_transfers ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.payment_wallets ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.payment_event_log ENABLE ROW LEVEL SECURITY;
      CREATE POLICY aws_select_payment_transfers ON public.payment_transfers FOR SELECT TO authenticated USING (tenant_id IN (SELECT public.aws_user_tenant_ids()));
      CREATE POLICY aws_select_payment_wallets ON public.payment_wallets FOR SELECT TO authenticated USING (tenant_id IN (SELECT public.aws_user_tenant_ids()));
      GRANT USAGE ON SCHEMA auth TO authenticated;
      GRANT SELECT, INSERT, UPDATE ON public.payment_transfers, public.payment_wallets, public.payment_event_log TO checksops;
      GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO checksops;`);
    await seed.end();

    const handler = handlerFor(() => connect());
    const inspect = await handler(policyEvent({ action: 'inspect' }));
    assert.equal(inspect.ok, true, JSON.stringify(inspect));
    assert.equal(inspect.details.receipt.apply_preconditions_met, true);
    const applied = await handler(policyEvent());
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.after_hash, PIN.intended_replacement_sha256);

    const app = await connect('checksops');
    const asMember = async (marker, tenant) => {
      await app.query('BEGIN');
      try {
        await app.query(`SELECT set_config('request.app_user_id', '${MEMBER}', true)`);
        if (marker) {
          await app.query("SELECT set_config('request.financial_execution', '1', true)");
          await app.query("SELECT set_config('request.aws_financial_permissions_activated', '1', true)");
        }
        await app.query('INSERT INTO public.payment_transfers (tenant_id, status) VALUES ($1, $2)', [tenant, 'ready']);
        await app.query('ROLLBACK');
        return 'allowed';
      } catch (error) {
        await app.query('ROLLBACK');
        return error.code;
      }
    };
    assert.equal(await asMember(true, TENANT), 'allowed');
    assert.equal(await asMember(false, TENANT), '42501');
    assert.equal(await asMember(true, OTHER), '42501');
    await app.end();
  } finally {
    await admin.end();
    spawnSync(path.join(PG_BIN, 'pg_ctl'), ['-D', pgData, '-m', 'immediate', '-w', 'stop']);
    fs.rmSync(pgData, { recursive: true, force: true });
  }
});
