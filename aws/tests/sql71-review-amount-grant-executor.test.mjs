/**
 * Staging VPC executor support for SQL 71 (GRANT UPDATE (amount) TO checksops).
 * The PostgreSQL 16 test runs the real handler against a check_intake_items
 * table whose checksops column grants mirror the Tranche 2 and SQL 52 grants.
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
  AMOUNT_GRANT_STATE_TEXT,
  AUTHORIZED_SQL71_AMOUNT_GRANT as PIN,
  AUTHORIZED_STAGING_SQL,
  authorizationFingerprint,
  evaluateSqlExecutorAuthorization,
  resolveAuthorizedMigration,
} from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import { importGuardedSqlExecutor } from './helpers/import-guarded-sql-executor.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PG_BIN = '/usr/lib/postgresql/16/bin';
const SQL_FILE = path.join(ROOT, PIN.filename);
const NOW = '2026-10-12T16:00:00.000Z';
const sha = (text) => createHash('sha256').update(text).digest('hex');

const { module: executorModule } = await importGuardedSqlExecutor();
const { createHandler } = executorModule;

function grantEvent(overrides = {}) {
  const oneUse = overrides.one_use_id || `sql71-test-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const event = {
    action: 'apply',
    workstream_id: 'staging-sql71-amount-grant',
    branch: 'claude/review-financial-edits',
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
    expiry: '2026-10-12T17:00:00.000Z',
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
    `sql71-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), sqlFile71: SQL_FILE, ...extra });
}

const neverConnect = async () => {
  throw new Error('should-not-connect');
};

test('pin matches the SQL file and the canonical privilege state hashes', () => {
  assert.equal(createHash('sha256').update(fs.readFileSync(SQL_FILE)).digest('hex'), PIN.source_sha256);
  assert.equal(sha(AMOUNT_GRANT_STATE_TEXT.absent), PIN.expected_live_definition_sha256);
  assert.equal(sha(AMOUNT_GRANT_STATE_TEXT.granted), PIN.intended_replacement_sha256);
  assert.match(fs.readFileSync(SQL_FILE, 'utf8'), /^GRANT UPDATE \(amount\) ON TABLE public\.check_intake_items TO checksops;$/m);
  assert.ok(AUTHORIZED_STAGING_SQL.includes(PIN));
  assert.equal(resolveAuthorizedMigration({ filename: PIN.filename, migration_id: PIN.migration_id }), PIN);
  assert.equal(evaluateSqlExecutorAuthorization(grantEvent(), { now: Date.parse(NOW) }).ok, true);
  const atCommit = spawnSync('git', ['show', `${PIN.commit}:${PIN.filename}`], { cwd: ROOT, maxBuffer: 1024 * 1024 });
  if (atCommit.status === 0) {
    assert.equal(createHash('sha256').update(atCommit.stdout).digest('hex'), PIN.source_sha256);
  }
});

test('apply refuses before connecting unless it is the exact pin, and a tampered file is refused', async () => {
  const other = await handlerFor(neverConnect)(grantEvent({ expected_live_definition_sha256: 'b'.repeat(64) }));
  assert.equal(other.code, CODES.SQL_COLLISION);
  const tampered = path.join(os.tmpdir(), `sql71-tampered-${process.pid}.sql`);
  fs.writeFileSync(tampered, `${fs.readFileSync(SQL_FILE, 'utf8')}GRANT UPDATE (status) ON TABLE public.check_intake_items TO checksops;\n`);
  try {
    const result = await handlerFor(neverConnect, { sqlFile71: tampered })(grantEvent());
    assert.equal(result.code, CODES.SQL_COLLISION);
  } finally {
    fs.rmSync(tampered, { force: true });
  }
});

const pgSkipReason = () => {
  if (!fs.existsSync(path.join(PG_BIN, 'initdb'))) return 'PostgreSQL 16 initdb is not installed in this environment';
  if (typeof process.getuid === 'function' && process.getuid() === 0) return 'initdb cannot run as root';
  return null;
};

test('PostgreSQL 16: inspect, apply, replay refusal and drift refusals through the real handler', {
  timeout: 180000,
}, async (t) => {
  const reason = pgSkipReason();
  if (reason) {
    t.skip(reason);
    return;
  }
  const pgData = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-sql71-'));
  const port = 59800 + (process.pid % 1000);
  const init = spawnSync(path.join(PG_BIN, 'initdb'), ['-D', pgData, '--auth=trust', '--no-sync', '--username=ubuntu', '--encoding=UTF8'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  fs.appendFileSync(path.join(pgData, 'postgresql.conf'), `\nlisten_addresses = ''\nport = ${port}\nunix_socket_directories = '${pgData}'\nlogging_collector = off\n`);
  const started = spawnSync(path.join(PG_BIN, 'pg_ctl'), ['-D', pgData, '-l', path.join(pgData, 'pg.log'), '-w', '-t', '30', 'start'], { encoding: 'utf8' });
  assert.equal(started.status, 0, started.stderr);
  const admin = new pg.Client({ host: pgData, port, user: 'ubuntu', database: 'postgres' });
  await admin.connect();
  await admin.query('CREATE ROLE checksops NOLOGIN');
  let n = 0;
  const freshDatabase = async (extra = '') => {
    n += 1;
    const database = `sql71_${n}`;
    await admin.query(`CREATE DATABASE ${database}`);
    const seed = new pg.Client({ host: pgData, port, user: 'ubuntu', database });
    await seed.connect();
    await seed.query(`
      CREATE TABLE public.check_intake_items (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), status text, amount numeric,
        routing_number text, account_number text, carrier_name text, updated_at timestamptz);
      GRANT SELECT ON public.check_intake_items TO checksops;
      GRANT UPDATE (carrier_name, updated_at) ON TABLE public.check_intake_items TO checksops;
      GRANT UPDATE (routing_number, account_number) ON TABLE public.check_intake_items TO checksops;
      ${extra}`);
    await seed.end();
    return async () => {
      const client = new pg.Client({ host: pgData, port, user: 'ubuntu', database });
      await client.connect();
      return client;
    };
  };
  const canUpdateAmount = async (connect) => {
    const client = await connect();
    try {
      return (await client.query(
        "SELECT has_column_privilege('checksops', 'public.check_intake_items', 'amount', 'UPDATE') AS ok",
      )).rows[0].ok;
    } finally {
      await client.end();
    }
  };
  try {
    const live = await freshDatabase();
    const handler = handlerFor(live);
    const inspect = await handler(grantEvent({ action: 'inspect' }));
    assert.equal(inspect.ok, true, JSON.stringify(inspect));
    assert.equal(inspect.details.receipt.amount_update_granted, false);
    assert.equal(inspect.details.receipt.apply_preconditions_met, true);
    assert.deepEqual(inspect.details.receipt.updatable_columns, ['account_number', 'carrier_name', 'routing_number', 'updated_at']);

    const event = grantEvent();
    const applied = await handler(event);
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.after_hash, PIN.intended_replacement_sha256);
    assert.deepEqual(applied.details.receipt.updatable_columns_after, ['account_number', 'amount', 'carrier_name', 'routing_number', 'updated_at']);
    assert.equal(await canUpdateAmount(live), true);

    assert.equal((await handler(event)).code, CODES.SQL_COLLISION);
    assert.equal((await handler(grantEvent())).code, CODES.UNRELATED_MUTATION);

    // drift: a table-level UPDATE grant means column grants are not as expected.
    const broad = await freshDatabase('GRANT UPDATE ON public.check_intake_items TO checksops;');
    const refused = await handlerFor(broad)(grantEvent());
    assert.equal(refused.ok, false);
    assert.equal(refused.code, CODES.UNRELATED_MUTATION);
  } finally {
    await admin.end();
    spawnSync(path.join(PG_BIN, 'pg_ctl'), ['-D', pgData, '-m', 'immediate', '-w', 'stop']);
    fs.rmSync(pgData, { recursive: true, force: true });
  }
});
