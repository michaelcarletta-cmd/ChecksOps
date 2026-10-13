/**
 * Production apply path for SQL 72 (tenant-member payment write policies).
 * The PostgreSQL 16 test builds the three payment tables with RLS and the live
 * helper functions, then runs the real production inspect and apply.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import { AUTHORIZED_SQL72_MEMBER_PAYMENT_WRITES as STAGING_PIN } from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import {
  evaluateSql72ProductionApply,
  executeSql72ProductionApply,
  inspectSql72Production,
  loadSql72ProductionPin,
  readPinnedSql72,
  readSql72State,
  sql72StatementsAllowed,
} from '../../scripts/deployment-guard/lib/sql72-production-apply.mjs';
import { main as sql72Main } from '../../scripts/deployment-guard/sql72-production-apply.mjs';
import { importGuardedSqlExecutor } from './helpers/import-guarded-sql-executor.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const COMMITTED_PIN = loadSql72ProductionPin(ROOT);
// The committed pin was flipped to execute:false after the 2026-10-13 apply; the apply tests exercise an execute-authorized copy.
const PIN = { ...COMMITTED_PIN, execute: true };
const PG_BIN = '/usr/lib/postgresql/16/bin';
const SQL_TEXT = fs.readFileSync(path.join(ROOT, PIN.filename), 'utf8');

const fingerprint = { sql: PIN.expected_live_definition_sha256 };
function manifest(overrides = {}) {
  return {
    workstream_id: 'prod-sql72-member-payment-writes-test',
    branch: 'main',
    commit: 'a'.repeat(40),
    operator: 'owner',
    target_environment: 'production',
    target_component: 'production-sql',
    deployment_type: 'sql-apply',
    owned_components: [PIN.filename],
    filename: PIN.filename,
    migration_id: PIN.migration_id,
    source_sha256: PIN.source_sha256,
    expected_live_definition_sha256: PIN.expected_live_definition_sha256,
    live_definition_sha256: PIN.expected_live_definition_sha256,
    preflight_live_fingerprint: fingerprint,
    production_fingerprint: fingerprint,
    immediately_before_fingerprint: fingerprint,
    staging_acceptance: PIN.staging_acceptance,
    approval: { approved: true, workstream_id: 'prod-sql72-member-payment-writes-test' },
    authorization_phrase: PIN.authorization_phrase,
    one_use_id: `sql72-prod-${process.pid}-${Math.random().toString(16).slice(2)}`,
    build_timestamp: '2026-10-13T19:00:00.000Z',
    ...overrides,
  };
}
const consumedPath = () => path.join(os.tmpdir(), `sql72-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
const neverConnect = async () => { throw new Error('should-not-connect'); };

test('production pin is the staging-applied SQL 72 with the exact before/after state hashes', () => {
  for (const key of ['filename', 'migration_id', 'source_sha256', 'expected_live_definition_sha256', 'intended_replacement_sha256']) {
    assert.equal(PIN[key], STAGING_PIN[key], key);
  }
  assert.equal(PIN.target_environment, 'production');
  assert.equal(PIN.deployment_type, 'sql-apply');
  assert.equal(createHash('sha256').update(SQL_TEXT).digest('hex'), PIN.source_sha256);
  assert.equal(readPinnedSql72(ROOT, PIN).ok, true);
  assert.equal(PIN.staging_acceptance.reference, 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/38438034883');
});

test('the statement check matches the staging executor exactly and refuses variants', async () => {
  const { module: executor } = await importGuardedSqlExecutor();
  assert.deepEqual((await import('../../scripts/deployment-guard/lib/sql72-production-apply.mjs')).sql72ExpectedStatements(), executor.sql72ExpectedStatements());
  assert.equal(sql72StatementsAllowed(SQL_TEXT), true);
  for (const variant of [
    `${SQL_TEXT}\nGRANT ALL ON public.payment_transfers TO authenticated;`,
    SQL_TEXT.replace('TO authenticated', 'TO authenticated, anon'),
    SQL_TEXT.replace('WITH CHECK (\n    public.aws_is_authenticated()', 'WITH CHECK (\n    true OR public.aws_is_authenticated()'),
  ]) {
    assert.equal(sql72StatementsAllowed(variant), false);
    assert.equal(executor.sql72StatementsAllowed(variant), false);
  }
});

test('evaluation is bound to the exact pin and the production gate', () => {
  assert.equal(evaluateSql72ProductionApply(manifest(), { root: ROOT, pin: PIN }).ok, true);
  const wrongHash = evaluateSql72ProductionApply(manifest({ expected_live_definition_sha256: 'b'.repeat(64) }), { root: ROOT, pin: PIN });
  assert.equal(wrongHash.code, CODES.SQL_COLLISION);
  assert.deepEqual(wrongHash.details.mismatched, ['expected_live_definition_sha256']);
  assert.equal(evaluateSql72ProductionApply(manifest({ target_environment: 'staging' }), { root: ROOT, pin: PIN }).code, CODES.SQL_COLLISION);
  assert.equal(evaluateSql72ProductionApply(manifest({ approval: { approved: true, workstream_id: 'someone-else' } }), { root: ROOT, pin: PIN }).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal(evaluateSql72ProductionApply(manifest({ staging_acceptance: { ok: false } }), { root: ROOT, pin: PIN }).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const otherRun = { ok: true, reference: 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/1' };
  assert.equal(evaluateSql72ProductionApply(manifest({ staging_acceptance: otherRun }), { root: ROOT, pin: PIN }).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal(evaluateSql72ProductionApply(manifest({ immediately_before_fingerprint: { sql: 'c'.repeat(64) } }), { root: ROOT, pin: PIN }).code, CODES.DEPLOYMENT_COLLISION);
});

test('a missing or wrong live hash from the inspect is refused before anything is spent', () => {
  for (const live of [undefined, 'c'.repeat(64)]) {
    const result = evaluateSql72ProductionApply(manifest({ live_definition_sha256: live }), { root: ROOT, pin: PIN });
    assert.equal(result.code, CODES.SQL_COLLISION);
    assert.deepEqual(result.details.mismatched, ['live_definition_sha256']);
  }
});

test('CLI does not spend the receipt on a wrong phrase, a reused id or a receipt for another file', async () => {
  const run = async (overrides, receipt, consumed, connect = neverConnect) => {
    const input = path.join(os.tmpdir(), `sql72-prod-input-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
    fs.writeFileSync(input, JSON.stringify(manifest(overrides)));
    const writes = [];
    let spent = 0;
    const orig = { out: process.stdout.write, err: process.stderr.write };
    process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };
    process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
    try {
      await sql72Main(['--apply', '--input', input], { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' }, {
        root: ROOT,
        pin: PIN,
        enforceScriptGuard: () => ({ ok: true, details: { receipt } }),
        consumeReceiptOnce: () => { spent += 1; return { ok: true }; },
        connect,
        consumedPath: consumed,
      });
    } finally {
      process.stdout.write = orig.out;
      process.stderr.write = orig.err;
      fs.rmSync(input, { force: true });
    }
    return { out: writes.join(''), spent };
  };
  const owned = { owned_components: [PIN.filename] };
  const phrase = await run({ authorization_phrase: 'yes' }, owned, consumedPath());
  assert.equal(phrase.spent, 0);
  assert.match(phrase.out, /PRODUCTION_APPROVAL_REQUIRED/);
  const other = await run({}, { owned_components: ['aws/workflows/sql/71_review_amount_column_grant.sql'] }, consumedPath());
  assert.equal(other.spent, 0);
  assert.match(other.out, /RECEIPT_MISMATCH/);
  const file = consumedPath();
  fs.writeFileSync(file, JSON.stringify({ consumed: ['sql72-prod-reused-id'] }));
  const reused = await run({ one_use_id: 'sql72-prod-reused-id' }, owned, file);
  assert.equal(reused.spent, 0);
  assert.match(reused.out, /RECEIPT_REUSED/);
  const wrongLive = await run({ live_definition_sha256: 'c'.repeat(64) }, owned, consumedPath());
  assert.equal(wrongLive.spent, 0);
  assert.match(wrongLive.out, /SQL_COLLISION/);
  // A valid run spends the receipt exactly once, then rolls back at a database that refuses every query.
  const refusingDb = async () => ({ query: async () => { throw new Error('db-unavailable'); }, end: async () => {} });
  const valid = await run({}, owned, consumedPath(), refusingDb);
  assert.equal(valid.spent, 1);
  assert.match(valid.out, /rolled back/);
  for (const r of [phrase, other, reused, wrongLive]) assert.doesNotMatch(r.out, /should-not-connect/);
});

test('apply refuses before connecting without the phrase, a single-use id or execute', async () => {
  const noPhrase = await executeSql72ProductionApply(manifest({ authorization_phrase: 'yes' }), { root: ROOT, pin: PIN, connect: neverConnect, consumedPath: consumedPath() });
  assert.equal(noPhrase.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const noId = await executeSql72ProductionApply(manifest({ one_use_id: 'x' }), { root: ROOT, pin: PIN, connect: neverConnect, consumedPath: consumedPath() });
  assert.equal(noId.code, CODES.INVALID_MANIFEST);
  const notExecutable = await executeSql72ProductionApply(manifest(), { root: ROOT, pin: { ...PIN, execute: false }, connect: neverConnect, consumedPath: consumedPath() });
  assert.equal(notExecutable.code, CODES.GUARD_APPLY_FORBIDDEN);
});

test('the committed pin no longer authorizes an apply', async () => {
  assert.equal(COMMITTED_PIN.execute, false);
  const refused = await executeSql72ProductionApply(manifest(), { root: ROOT, pin: COMMITTED_PIN, connect: neverConnect, consumedPath: consumedPath() });
  assert.equal(refused.code, CODES.GUARD_APPLY_FORBIDDEN);

  const input = path.join(os.tmpdir(), `sql72-prod-committed-${process.pid}.json`);
  fs.writeFileSync(input, JSON.stringify(manifest()));
  const writes = [];
  let spent = 0;
  const orig = { out: process.stdout.write, err: process.stderr.write };
  process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
  try {
    await sql72Main(['--apply', '--input', input], { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' }, {
      root: ROOT,
      pin: COMMITTED_PIN,
      enforceScriptGuard: () => ({ ok: true, details: { receipt: { owned_components: [COMMITTED_PIN.filename] } } }),
      consumeReceiptOnce: () => { spent += 1; return { ok: true }; },
      connect: neverConnect,
      consumedPath: consumedPath(),
    });
  } finally {
    process.stdout.write = orig.out;
    process.stderr.write = orig.err;
    fs.rmSync(input, { force: true });
  }
  assert.equal(spent, 0);
  assert.match(writes.join(''), /GUARD_APPLY_FORBIDDEN/);
});

test('the CLI refuses arbitrary SQL and an apply without the guard flag', async () => {
  const writes = [];
  const orig = { out: process.stdout.write, err: process.stderr.write };
  process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
  const input = path.join(os.tmpdir(), `sql72-prod-cli-${process.pid}.json`);
  try {
    fs.writeFileSync(input, JSON.stringify({ ...manifest(), sql_text: 'DROP TABLE public.payment_transfers' }));
    await sql72Main(['--apply', '--input', input], {}, { connect: neverConnect, enforceScriptGuard: () => ({ ok: true }) });
    fs.writeFileSync(input, JSON.stringify(manifest()));
    await sql72Main(['--apply', '--input', input], {}, { connect: neverConnect, enforceScriptGuard: () => ({ ok: true }) });
  } finally {
    process.stdout.write = orig.out;
    process.stderr.write = orig.err;
    fs.rmSync(input, { force: true });
  }
  const out = writes.join('');
  assert.match(out, /arbitrary SQL text is forbidden/);
  assert.match(out, /blocked unless CHECKSOPS_DEPLOYMENT_GUARD_APPLY=1/);
});

const pgSkipReason = () => {
  if (!fs.existsSync(path.join(PG_BIN, 'initdb'))) return 'PostgreSQL 16 initdb is not installed in this environment';
  if (typeof process.getuid === 'function' && process.getuid() === 0) return 'initdb cannot run as root';
  return null;
};

test('PostgreSQL 16: production inspect and apply create exactly the five member policies', { timeout: 180000 }, async (t) => {
  const reason = pgSkipReason();
  if (reason) {
    t.skip(reason);
    return;
  }
  let pg;
  try {
    pg = (await import('pg')).default;
  } catch {
    t.skip('pg module is not installed');
    return;
  }
  const pgData = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-sql72-prod-'));
  const port = 59600 + (process.pid % 1000);
  const init = spawnSync(path.join(PG_BIN, 'initdb'), ['-D', pgData, '--auth=trust', '--no-sync', '--username=ubuntu', '--encoding=UTF8'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  fs.appendFileSync(path.join(pgData, 'postgresql.conf'), `\nlisten_addresses = ''\nport = ${port}\nunix_socket_directories = '${pgData}'\nlogging_collector = off\n`);
  const started = spawnSync(path.join(PG_BIN, 'pg_ctl'), ['-D', pgData, '-l', path.join(pgData, 'pg.log'), '-w', '-t', '30', 'start'], { encoding: 'utf8' });
  assert.equal(started.status, 0, started.stderr);
  const admin = new pg.Client({ host: pgData, port, user: 'ubuntu', database: 'postgres' });
  await admin.connect();
  await admin.query('CREATE ROLE authenticated NOLOGIN');
  await admin.query('CREATE DATABASE sql72prod');
  const connect = async () => {
    const client = new pg.Client({ host: pgData, port, user: 'ubuntu', database: 'sql72prod' });
    await client.connect();
    return client;
  };
  try {
    const seed = await connect();
    await seed.query(`
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.app_user_id', true), '')::uuid $$;
      CREATE TABLE public.tenant_users (user_id uuid, tenant_id uuid);
      CREATE FUNCTION public.aws_user_tenant_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$ SELECT tenant_id FROM public.tenant_users WHERE user_id = auth.uid() $$;
      CREATE FUNCTION public.aws_is_authenticated() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT auth.uid() IS NOT NULL $$;
      CREATE FUNCTION public.aws_financial_execution_active() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT current_setting('request.financial_execution', true) = '1' $$;
      CREATE FUNCTION public.aws_can_write_tenant(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
      CREATE TABLE public.payment_transfers (id serial PRIMARY KEY, tenant_id uuid);
      CREATE TABLE public.payment_wallets (id serial PRIMARY KEY, tenant_id uuid);
      CREATE TABLE public.payment_event_log (id serial PRIMARY KEY, tenant_id uuid);
      ALTER TABLE public.payment_transfers ENABLE ROW LEVEL SECURITY;
      CREATE POLICY aws_write_payment_transfers ON public.payment_transfers FOR ALL TO authenticated USING (public.aws_can_write_tenant(tenant_id)) WITH CHECK (public.aws_can_write_tenant(tenant_id));`);
    await seed.end();

    // Drift refusals: a revoked helper EXECUTE, then a malformed member policy; each rolls back.
    const tweak = async (sql) => { const c = await connect(); try { await c.query(sql); } finally { await c.end(); } };
    await tweak('REVOKE EXECUTE ON FUNCTION public.aws_financial_execution_active() FROM PUBLIC');
    const revoked = await executeSql72ProductionApply(manifest(), { root: ROOT, pin: PIN, connect, consumedPath: consumedPath() });
    assert.equal(revoked.code, CODES.DEPLOYMENT_COLLISION, JSON.stringify(revoked));
    await tweak('GRANT EXECUTE ON FUNCTION public.aws_financial_execution_active() TO PUBLIC');
    await tweak('CREATE POLICY aws_member_insert_payment_wallets ON public.payment_wallets FOR INSERT TO authenticated WITH CHECK (true)');
    const malformed = await executeSql72ProductionApply(manifest(), { root: ROOT, pin: PIN, connect, consumedPath: consumedPath() });
    assert.equal(malformed.code, CODES.DEPLOYMENT_COLLISION, JSON.stringify(malformed));
    await tweak('DROP POLICY aws_member_insert_payment_wallets ON public.payment_wallets');
    const probe = await connect();
    try {
      assert.equal((await probe.query("SELECT count(*)::int AS n FROM pg_policies WHERE policyname LIKE 'aws_member_%'")).rows[0].n, 0);
    } finally {
      await probe.end();
    }

    const inspect = await inspectSql72Production({ connect, pin: PIN });
    assert.equal(inspect.ok, true, JSON.stringify(inspect));
    assert.equal(inspect.details.apply_preconditions_met, true);
    assert.equal(inspect.details.already_applied, false);
    assert.equal(inspect.details.other_policy_count, 1);

    const applied = await executeSql72ProductionApply(manifest(), { root: ROOT, pin: PIN, connect, consumedPath: consumedPath() });
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.after_hash, PIN.intended_replacement_sha256);
    assert.equal(applied.details.receipt.other_policy_count, 1);

    const after = await inspectSql72Production({ connect, pin: PIN });
    assert.equal(after.details.already_applied, true);
    const again = await executeSql72ProductionApply(manifest(), { root: ROOT, pin: PIN, connect, consumedPath: consumedPath() });
    assert.equal(again.code, CODES.UNRELATED_MUTATION);

    const client = await connect();
    try {
      const state = await readSql72State(client);
      assert.deepEqual(Object.values(state.details.member_policy_states), ['present', 'present', 'present', 'present', 'present']);
    } finally {
      await client.end();
    }
  } finally {
    await admin.end();
    spawnSync(path.join(PG_BIN, 'pg_ctl'), ['-D', pgData, '-m', 'immediate', '-w', 'stop']);
    fs.rmSync(pgData, { recursive: true, force: true });
  }
});
