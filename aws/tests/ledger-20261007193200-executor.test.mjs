/**
 * Staging VPC executor support for 20261007193200 (sync_homeowner_ledger_from_check).
 *
 * The PostgreSQL 16 tests run the real executor handler against a database
 * rebuilt from the exact live definitions (sync 9f6ec2dc…, hle bdd9ec4b…,
 * aws_can_write_claim 0a7e62b2…) and the three ledger triggers.
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
  AUTHORIZED_LEDGER_20261007193200 as PIN,
  AUTHORIZED_SQL44,
  AUTHORIZED_SQL53,
  AUTHORIZED_STAGING_SQL,
  authorizationFingerprint,
  evaluateSqlExecutorAuthorization,
  resolveAuthorizedMigration,
} from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import { importGuardedSqlExecutor } from './helpers/import-guarded-sql-executor.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PG_BIN = '/usr/lib/postgresql/16/bin';
const RECORD = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'ops/deployment-guard/ledger-20261007193200-staging-authorization.json'),
  'utf8',
));
const LEDGER_FILE = path.join(ROOT, PIN.filename);
const NOW = '2026-10-12T15:00:00.000Z';
const HLE = 'public.hle_on_check_intake_insert()';
const CLAIM = 'public.aws_can_write_claim(uuid)';

const { module: executorModule } = await importGuardedSqlExecutor();
const { createHandler } = executorModule;

const fileSha = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function ledgerEvent(overrides = {}) {
  const oneUse = overrides.one_use_id || `ledger-test-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const base = {
    action: 'apply',
    workstream_id: 'staging-ledger-20261007193200',
    branch: 'claude/staging-sql-ledger-20261007193200',
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
    expiry: '2026-10-12T16:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
  };
  const event = { ...base, ...overrides, one_use_id: oneUse };
  event.preflight_live_fingerprint = authorizationFingerprint(event);
  return event;
}

function handlerFor(connect, extra = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(
    os.tmpdir(),
    `ledger-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({
    connect,
    now: () => Date.parse(NOW),
    sqlFileLedger: LEDGER_FILE,
    ...extra,
  });
}

const neverConnect = async () => {
  throw new Error('should-not-connect');
};

test('pin matches the migration bytes and the staging authorization record', () => {
  assert.equal(fileSha(LEDGER_FILE), PIN.source_sha256);
  assert.equal(PIN.source_sha256, RECORD.source_sha256);
  assert.equal(PIN.filename, RECORD.filename);
  assert.equal(PIN.migration_id, RECORD.migration_id);
  assert.equal(PIN.function_identity, RECORD.function_identity);
  assert.equal(PIN.expected_live_definition_sha256, RECORD.expected_live_definition_sha256);
  assert.equal(PIN.intended_replacement_sha256, RECORD.intended_definition_sha256);
  assert.deepEqual(
    { ...PIN.preserved_function_definition_sha256 },
    RECORD.preconditions.preserved_function_definition_sha256,
  );
  assert.deepEqual(Object.keys(PIN.required_ledger_triggers), RECORD.preconditions.required_ledger_triggers);
  assert.equal(RECORD.apply_authorized, false);
  assert.equal(RECORD.execute, false);
  const log = spawnSync('git', ['log', '-1', '--format=%H', '--', PIN.filename], { cwd: ROOT, encoding: 'utf8' });
  if (log.status === 0 && log.stdout.trim()) assert.equal(log.stdout.trim(), PIN.commit);
});

test('allowlist resolves the ledger pin exactly and never falls through to SQL 44 or 53', () => {
  assert.ok(AUTHORIZED_STAGING_SQL.includes(PIN));
  assert.equal(resolveAuthorizedMigration({ filename: PIN.filename, migration_id: PIN.migration_id }), PIN);
  assert.equal(resolveAuthorizedMigration({ filename: PIN.filename, migration_id: AUTHORIZED_SQL44.migration_id }), null);
  assert.equal(resolveAuthorizedMigration({ filename: AUTHORIZED_SQL53.filename, migration_id: PIN.migration_id }), null);
  assert.equal(evaluateSqlExecutorAuthorization(ledgerEvent(), { now: Date.parse(NOW) }).ok, true);
  const prod = evaluateSqlExecutorAuthorization(ledgerEvent({ target_environment: 'production' }), { now: Date.parse(NOW) });
  assert.equal(prod.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const wrongCommit = evaluateSqlExecutorAuthorization(ledgerEvent({ commit: AUTHORIZED_SQL53.commit }), { now: Date.parse(NOW) });
  assert.equal(wrongCommit.ok, false);
});

test('apply refuses before connecting when the event is not the exact pin', async () => {
  const handler = handlerFor(neverConnect);
  const otherLive = await handler(ledgerEvent({
    expected_live_definition_sha256: 'a'.repeat(64),
  }));
  assert.equal(otherLive.code, CODES.SQL_COLLISION);
  assert.match(otherLive.message, /exact allowlisted pin/);
  const arbitrary = await handler(ledgerEvent({ sql_text: 'SELECT 1' }));
  assert.equal(arbitrary.code, CODES.UNRELATED_MUTATION);
  const restore = await handler(ledgerEvent({ action: 'restore' }));
  assert.equal(restore.code, CODES.UNRELATED_MUTATION);
});

test('a tampered embedded file is refused before connecting', async () => {
  const tampered = path.join(os.tmpdir(), `ledger-tampered-${process.pid}.sql`);
  fs.writeFileSync(tampered, `${fs.readFileSync(LEDGER_FILE, 'utf8')}\nDROP TRIGGER trg_hle_check_intake_insert ON public.check_intake_items;\n`);
  try {
    const result = await handlerFor(neverConnect, { sqlFileLedger: tampered })(ledgerEvent());
    assert.equal(result.code, CODES.SQL_COLLISION);
    assert.match(result.message, /SHA256/);
  } finally {
    fs.rmSync(tampered, { force: true });
  }
});

// ---------------------------------------------------------------------------
// Real PostgreSQL 16

const pgSkipReason = () => {
  if (!fs.existsSync(path.join(PG_BIN, 'initdb'))) return 'PostgreSQL 16 initdb is not installed in this environment';
  if (typeof process.getuid === 'function' && process.getuid() === 0) return 'initdb cannot run as root';
  return null;
};

const functionBlock = (rel, pattern) => {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const match = src.match(pattern);
  assert.ok(match, `${rel} defines ${pattern}`);
  return match[0];
};

const SCHEMA_SQL = () => `
SET check_function_bodies = off;
CREATE TABLE public.check_intake_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, claim_id uuid,
  check_source text NOT NULL DEFAULT 'insurance', status text, amount numeric,
  created_at timestamptz DEFAULT now(), issue_date date, carrier_name text,
  check_number text, payee_line text);
CREATE TABLE public.homeowner_ledger_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, claim_id uuid, check_id uuid,
  event_type text, occurred_at timestamptz, amount numeric, actor_label text, payload_json jsonb);
${functionBlock(RECORD.preconditions.preserved_function_definition_source[HLE], /CREATE OR REPLACE FUNCTION public\.hle_on_check_intake_insert\(\)[\s\S]*?\$\$;/)}
${functionBlock(RECORD.expected_live_definition_source, /CREATE OR REPLACE FUNCTION public\.sync_homeowner_ledger_from_check\(\)[\s\S]*?\$\$;/)}
${functionBlock('aws/rls/sql/20_write_helpers.sql', /CREATE OR REPLACE FUNCTION public\.aws_can_write_claim\(_claim_id uuid\)[\s\S]*?\$\$;/)}
CREATE TRIGGER trg_hle_check_intake_insert AFTER INSERT ON public.check_intake_items
  FOR EACH ROW EXECUTE FUNCTION public.hle_on_check_intake_insert();
CREATE TRIGGER trg_sync_homeowner_ledger_ins AFTER INSERT ON public.check_intake_items
  FOR EACH ROW EXECUTE FUNCTION public.sync_homeowner_ledger_from_check();
CREATE TRIGGER trg_sync_homeowner_ledger_upd AFTER UPDATE OF status ON public.check_intake_items
  FOR EACH ROW EXECUTE FUNCTION public.sync_homeowner_ledger_from_check();
`;

async function withCluster(t, fn) {
  const reason = pgSkipReason();
  if (reason) {
    t.skip(reason);
    return;
  }
  const pgData = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-ledger-exec-'));
  const port = 58800 + (process.pid % 1000);
  const logPath = path.join(pgData, 'pg.log');
  const init = spawnSync(path.join(PG_BIN, 'initdb'), [
    '-D', pgData, '--auth=trust', '--no-sync', '--username=ubuntu', '--encoding=UTF8',
  ], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  fs.appendFileSync(path.join(pgData, 'postgresql.conf'), `
listen_addresses = ''
port = ${port}
unix_socket_directories = '${pgData}'
logging_collector = off
shared_buffers = 32MB
max_connections = 20
`);
  const started = spawnSync(path.join(PG_BIN, 'pg_ctl'), ['-D', pgData, '-l', logPath, '-w', '-t', '30', 'start'], { encoding: 'utf8' });
  assert.equal(started.status, 0, started.stderr);
  let dbIndex = 0;
  const admin = new pg.Client({ host: pgData, port, user: 'ubuntu', database: 'postgres' });
  await admin.connect();
  // Each call returns a fresh database seeded with the live July state, plus a connect().
  const freshDatabase = async (mutate = '') => {
    dbIndex += 1;
    const database = `ledger_${dbIndex}`;
    await admin.query(`CREATE DATABASE ${database}`);
    const seed = new pg.Client({ host: pgData, port, user: 'ubuntu', database });
    await seed.connect();
    await seed.query(SCHEMA_SQL());
    if (mutate) await seed.query(mutate);
    await seed.end();
    const connect = async () => {
      const client = new pg.Client({ host: pgData, port, user: 'ubuntu', database });
      await client.connect();
      return client;
    };
    return { connect, database };
  };
  try {
    await fn(freshDatabase);
  } finally {
    await admin.end();
    spawnSync(path.join(PG_BIN, 'pg_ctl'), ['-D', pgData, '-m', 'immediate', '-w', 'stop']);
    fs.rmSync(pgData, { recursive: true, force: true });
  }
}

async function liveSyncSha(connect) {
  const client = await connect();
  try {
    const row = (await client.query(
      "SELECT encode(sha256(convert_to(pg_get_functiondef('public.sync_homeowner_ledger_from_check()'::regprocedure), 'UTF8')), 'hex') AS h",
    )).rows[0];
    return row.h;
  } finally {
    await client.end();
  }
}

test('PostgreSQL 16: inspect, apply, replay refusal and drift refusals through the real handler', {
  timeout: 180000,
}, async (t) => {
  await withCluster(t, async (freshDatabase) => {
    // inspect on the live July state reports every precondition met and changes nothing.
    const live = await freshDatabase();
    const handler = handlerFor(live.connect);
    const inspect = await handler(ledgerEvent({ action: 'inspect' }));
    assert.equal(inspect.ok, true, JSON.stringify(inspect));
    assert.equal(inspect.details.receipt.live_definition_sha256, PIN.expected_live_definition_sha256);
    assert.equal(inspect.details.receipt.apply_preconditions_met, true);
    for (const row of inspect.details.receipt.preserved_functions) {
      assert.equal(row.definitionSha256, row.expectedSha256, row.identity);
    }
    assert.equal(await liveSyncSha(live.connect), PIN.expected_live_definition_sha256);

    // apply replaces only the sync function and keeps triggers, preserved functions and rows.
    const seedClient = await live.connect();
    await seedClient.query(`INSERT INTO public.check_intake_items (tenant_id, claim_id, status, amount)
      VALUES (gen_random_uuid(), gen_random_uuid(), 'needs_review', 50)`);
    await seedClient.end();
    const event = ledgerEvent();
    const applied = await handler(event);
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.before_hash, PIN.expected_live_definition_sha256);
    assert.equal(applied.details.receipt.after_hash, PIN.intended_replacement_sha256);
    assert.equal(applied.details.receipt.ledger_event_count, '2');
    assert.deepEqual(
      applied.details.receipt.triggers.map((row) => `${row.name}:${row.function_name}`),
      [
        'trg_hle_check_intake_insert:hle_on_check_intake_insert',
        'trg_sync_homeowner_ledger_ins:sync_homeowner_ledger_from_check',
        'trg_sync_homeowner_ledger_upd:sync_homeowner_ledger_from_check',
      ],
    );
    assert.equal(await liveSyncSha(live.connect), PIN.intended_replacement_sha256);

    // replay of the same one_use_id and a fresh apply on the already-intended state both refuse.
    const replay = await handler(event);
    assert.equal(replay.code, CODES.SQL_COLLISION);
    const again = await handler(ledgerEvent());
    assert.equal(again.ok, false);
    assert.equal(await liveSyncSha(live.connect), PIN.intended_replacement_sha256);

    // drift: a missing ledger trigger stops apply and leaves the function untouched.
    const noTrigger = await freshDatabase('DROP TRIGGER trg_sync_homeowner_ledger_upd ON public.check_intake_items;');
    const missing = await handlerFor(noTrigger.connect)(ledgerEvent());
    assert.equal(missing.code, CODES.DEPLOYMENT_COLLISION);
    assert.deepEqual(missing.details.missing_ledger_triggers, ['trg_sync_homeowner_ledger_upd']);
    assert.equal(await liveSyncSha(noTrigger.connect), PIN.expected_live_definition_sha256);

    // drift: a changed preserved function stops apply.
    const hleDrift = await freshDatabase(`CREATE OR REPLACE FUNCTION public.hle_on_check_intake_insert()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$;`);
    const drift = await handlerFor(hleDrift.connect)(ledgerEvent());
    assert.equal(drift.code, CODES.DEPLOYMENT_COLLISION);
    assert.deepEqual(drift.details.drifted_preserved_functions, [HLE]);
    assert.equal(await liveSyncSha(hleDrift.connect), PIN.expected_live_definition_sha256);

    // drift: an unexpected live sync definition stops apply.
    const syncDrift = await freshDatabase(`CREATE OR REPLACE FUNCTION public.sync_homeowner_ledger_from_check()
      RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$ BEGIN RETURN NEW; END; $$;`);
    const changed = await handlerFor(syncDrift.connect)(ledgerEvent());
    assert.equal(changed.code, CODES.DEPLOYMENT_COLLISION);
    assert.notEqual(await liveSyncSha(syncDrift.connect), PIN.intended_replacement_sha256);

    // the preserved aws_can_write_claim hash is reproduced from source, so the check is real.
    const claimRow = inspect.details.receipt.preserved_functions.find((row) => row.identity === CLAIM);
    assert.equal(claimRow.definitionSha256, PIN.preserved_function_definition_sha256[CLAIM]);
  });
});
