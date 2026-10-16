/**
 * Staging VPC executor support for SQL 89 (checksops: column-level UPDATE on
 * check_intake_items instead of table-level UPDATE).
 *
 * The committed pin carries the staging pre-state from read-live run 82; a pin
 * without one refuses apply before connecting. The PostgreSQL 16
 * test runs the real handler: the read-only inspect reports the updatable columns and
 * the plan through read-live, and an apply with a recorded pre-state converges
 * staging-like column grants on exactly the 43 columns, refuses replay and re-apply,
 * and rolls back drift.
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
import {
  AUTHORIZED_SQL89_CHECK_INTAKE_COLUMN_UPDATE as PIN,
  AUTHORIZED_STAGING_SQL,
  SQL89_CANONICAL_STATEMENTS,
  SQL89_COLUMNS,
  authorizationFingerprint,
  columnUpdateStateText,
  evaluateSqlExecutorAuthorization,
  resolveAuthorizedMigration,
  sql89StatementText,
} from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import { READ_LIVE_EXPECTED_SENTINEL, readLiveSummary } from '../../scripts/deployment-guard/lib/sql-executor-read-live.mjs';
import { MIGRATIONS } from '../../scripts/deployment-guard/github-staging-sql-executor.mjs';
import { EXECUTOR_PACK_MEMBERS } from '../../scripts/deployment-guard/sql-executor-ensure.mjs';
import { importGuardedSqlExecutor } from './helpers/import-guarded-sql-executor.mjs';
import { pgSkipReason, startPg } from './helpers/stakeholder-policies-pg.mjs';
import { checkIntakeTableSql, NOT_GRANTED_COLUMNS } from './helpers/check-intake-column-update.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SQL_FILE = path.join(ROOT, PIN.filename);
const NOW = '2026-10-16T16:00:00.000Z';
const sha = (text) => createHash('sha256').update(text).digest('hex');
const stateHash = (tableLevel, columns) => sha(columnUpdateStateText({ table_level_update: tableLevel, updatable_columns: columns }));

const { module: executorModule } = await importGuardedSqlExecutor();
const { createHandler } = executorModule;

function grantEvent(overrides = {}, pin = PIN) {
  const oneUse = overrides.one_use_id || `sql89-test-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const event = {
    action: 'apply',
    workstream_id: 'staging-sql89-check-intake-column-update',
    branch: 'main',
    commit: pin.commit,
    operator: 'test-agent',
    target_environment: 'staging',
    target_component: 'staging-sql',
    deployment_type: 'sql-executor-invoke',
    owned_components: [pin.filename],
    filename: pin.filename,
    migration_id: pin.migration_id,
    source_sha256: pin.source_sha256,
    intended_replacement_sha256: pin.intended_replacement_sha256,
    expected_live_definition_sha256: pin.expected_live_definition_sha256 ?? READ_LIVE_EXPECTED_SENTINEL,
    one_use_id: oneUse,
    expiry: '2026-10-16T17:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    ...overrides,
  };
  event.one_use_id = oneUse;
  event.preflight_live_fingerprint = authorizationFingerprint(event);
  return event;
}

function handlerFor(connect, extra = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql89-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), sqlFile89: SQL_FILE, ...extra });
}
const neverConnect = async () => { throw new Error('should-not-connect'); };

test('pin: the file, its authoring commit, the intended hash, the recorded staging pre-state; selectable and packed', () => {
  assert.equal(sha(fs.readFileSync(SQL_FILE)), PIN.source_sha256);
  assert.equal(sql89StatementText(fs.readFileSync(SQL_FILE, 'utf8')), SQL89_CANONICAL_STATEMENTS);
  assert.equal(PIN.intended_replacement_sha256, stateHash(false, SQL89_COLUMNS));
  assert.equal(PIN.expected_live_definition_sha256, '6810985b26778774a633ad17f02b634ec7c19b956d0f5302251fd1d2d05b0c7f', 'read-live run 82');
  assert.notEqual(PIN.expected_live_definition_sha256, PIN.intended_replacement_sha256);
  assert.deepEqual(PIN.columns, SQL89_COLUMNS);
  assert.ok(AUTHORIZED_STAGING_SQL.includes(PIN));
  assert.equal(resolveAuthorizedMigration({ filename: PIN.filename, migration_id: PIN.migration_id }), PIN);
  assert.equal(MIGRATIONS['sql89-check-intake-column-update'], PIN);
  assert.ok(EXECUTOR_PACK_MEMBERS.some(([from, to]) => from === PIN.filename && to === 'sql/89_check_intake_items_column_update.sql'));
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.match(workflow, /- sql89-check-intake-column-update\n/);
  assert.match(workflow, /node --test aws\/tests\/sql89-check-intake-column-update-executor\.test\.mjs/);
  assert.equal(evaluateSqlExecutorAuthorization(grantEvent({ action: 'inspect' }), { now: Date.parse(NOW) }).ok, true);
  const atCommit = spawnSync('git', ['show', `${PIN.commit}:${PIN.filename}`], { cwd: ROOT, maxBuffer: 1024 * 1024 });
  if (atCommit.status === 0) assert.equal(sha(atCommit.stdout), PIN.source_sha256);
});

test('apply refuses before connecting: no reviewed pre-state, a read-live sentinel, another pin, a tampered file', async () => {
  const unrecordedPin = { ...PIN, expected_live_definition_sha256: null };
  const unrecorded = await handlerFor(neverConnect, { sql89Pin: unrecordedPin })(grantEvent({ expected_live_definition_sha256: 'b'.repeat(64) }, unrecordedPin));
  assert.equal(unrecorded.code, CODES.SQL_COLLISION);
  assert.match(unrecorded.message, /no reviewed pre-apply live definition hash/);
  const recorded = { ...PIN, expected_live_definition_sha256: 'c'.repeat(64) };
  const sentinel = await handlerFor(neverConnect, { sql89Pin: recorded })(grantEvent({ expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL }));
  assert.equal(sentinel.code, CODES.SQL_COLLISION);
  assert.match(sentinel.message, /apply is bound to the exact allowlisted pin/);
  const tampered = path.join(os.tmpdir(), `sql89-tampered-${process.pid}.sql`);
  fs.writeFileSync(tampered, fs.readFileSync(SQL_FILE, 'utf8').replace('  updated_at\n', '  updated_at,\n  tenant_id\n'));
  try {
    assert.equal((await handlerFor(neverConnect, { sqlFile89: tampered })(grantEvent({ action: 'inspect' }))).code, CODES.SQL_COLLISION);
    // With a matching hash in the pin, the exact-statements rule still refuses.
    const pin = { ...PIN, source_sha256: sha(fs.readFileSync(tampered)) };
    assert.equal((await handlerFor(neverConnect, { sqlFile89: tampered, sql89Pin: pin })(grantEvent({ action: 'inspect' }))).code, CODES.UNRELATED_MUTATION);
  } finally {
    fs.rmSync(tampered, { force: true });
  }
});

const STAGING_COLUMNS = Object.freeze(['account_number', 'amount', 'carrier_name', 'check_stage', 'routing_number', 'status', 'updated_at']);

test('PostgreSQL 16: inspect and read-live report the plan; apply converges once; replay, re-apply and drift refused', { timeout: 240000 }, async (t) => {
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
  const server = startPg('pg-sql89-exec-', 58900);
  const admin = new pg.Client({ host: server.host, port: server.port, user: 'ubuntu', database: 'postgres' });
  await admin.connect();
  try {
    await admin.query('CREATE ROLE checksops NOLOGIN; CREATE ROLE authenticated NOLOGIN');
    await admin.query(checkIntakeTableSql(SQL89_COLUMNS));
    await admin.query(`
      CREATE FUNCTION public.aws_ingest_shared_check(p_payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
      BEGIN UPDATE public.check_intake_items SET detected_claim_number = p_payload->>'n' WHERE false; RETURN '{}'::jsonb; END $$;
      GRANT SELECT, INSERT, DELETE ON public.check_intake_items TO checksops;
      GRANT UPDATE (${STAGING_COLUMNS.join(', ')}, detected_claim_number) ON public.check_intake_items TO checksops;
      GRANT SELECT ON public.check_intake_items TO authenticated;
      GRANT UPDATE (status) ON public.check_intake_items TO authenticated;`);
    const connect = async () => {
      const client = new pg.Client({ host: server.host, port: server.port, user: 'ubuntu', database: 'postgres' });
      await client.connect();
      return client;
    };
    const updatable = async () => (await admin.query(`SELECT ARRAY(SELECT attname::text FROM pg_attribute
      WHERE attrelid = 'public.check_intake_items'::regclass AND attnum > 0 AND NOT attisdropped
        AND has_column_privilege('checksops', attrelid, attnum, 'UPDATE') ORDER BY attname::text COLLATE "C") AS cols,
      has_table_privilege('checksops', 'public.check_intake_items', 'INSERT') AS ins,
      has_column_privilege('authenticated', 'public.check_intake_items', 'status', 'UPDATE') AS auth_status`)).rows[0];
    const preColumns = [...STAGING_COLUMNS, 'detected_claim_number'].sort();
    const live = stateHash(false, preColumns);

    const inspect = await handlerFor(connect)(grantEvent({ action: 'inspect' }));
    assert.equal(inspect.ok, true, JSON.stringify(inspect));
    const receipt = inspect.details.receipt;
    assert.equal(receipt.live_definition_sha256, live);
    assert.equal(receipt.pin_executable, true);
    // The fixture's grants are not staging's recorded pre-state.
    assert.notEqual(receipt.live_definition_sha256, PIN.expected_live_definition_sha256);
    assert.equal(receipt.apply_preconditions_met, false, 'live state differs from the recorded pre-state');
    assert.deepEqual(receipt.precondition_failures, []);
    assert.deepEqual(receipt.column_grant_inspect.updatable_columns, preColumns);
    assert.deepEqual(receipt.column_grant_inspect.columns_losing_update, ['detected_claim_number']);
    assert.deepEqual(receipt.column_grant_inspect.columns_to_grant, SQL89_COLUMNS.filter((c) => !STAGING_COLUMNS.includes(c)));
    assert.equal(receipt.column_grant_inspect.table_privileges.insert, true);
    assert.equal(receipt.column_grant_inspect.table_privileges.update, false);
    // Read-live passes the plan through and keeps owner and grantor names out.
    const summary = readLiveSummary({ ok: true, details: { ok: true, details: inspect.details } }, { migration: 'sql89-check-intake-column-update', pin: PIN });
    assert.equal(summary.ok, true, JSON.stringify(summary));
    assert.equal(summary.details.live_definition_sha256, live);
    assert.equal(summary.details.table_level_update, false);
    assert.deepEqual(summary.details.column_grant_inspect.updatable_columns, preColumns);
    assert.deepEqual(summary.details.column_grant_inspect.columns_losing_update, ['detected_claim_number']);
    assert.doesNotMatch(JSON.stringify(summary.details), /ubuntu|granted by/);

    const recorded = { ...PIN, expected_live_definition_sha256: live };
    const handler = handlerFor(connect, { sql89Pin: recorded });
    // A table-level UPDATE added after the read-live is drift: refused, nothing changes.
    await admin.query('GRANT UPDATE ON public.check_intake_items TO checksops');
    const drift = await handler(grantEvent({}, recorded));
    assert.equal(drift.code, CODES.DEPLOYMENT_COLLISION);
    await admin.query(`REVOKE UPDATE ON public.check_intake_items FROM checksops; GRANT UPDATE (${preColumns.join(', ')}) ON public.check_intake_items TO checksops`);
    assert.deepEqual((await updatable()).cols, preColumns);

    const event = grantEvent({}, recorded);
    const applied = await handler(event);
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.before_hash, live);
    assert.equal(applied.details.receipt.after_hash, PIN.intended_replacement_sha256);
    assert.deepEqual(applied.details.receipt.updatable_columns_after, [...SQL89_COLUMNS]);
    assert.deepEqual(applied.details.receipt.columns_lost_update, ['detected_claim_number']);
    assert.deepEqual(await updatable(), { cols: [...SQL89_COLUMNS], ins: true, auth_status: true });

    assert.equal((await handler(event)).code, CODES.SQL_COLLISION, 'replay');
    const again = await handler(grantEvent({}, recorded));
    assert.equal(again.code, CODES.UNRELATED_MUTATION);
    assert.match(again.message, /already/);
    const after = await handlerFor(connect)(grantEvent({ action: 'inspect' }));
    assert.equal(after.details.receipt.live_definition_sha256, PIN.intended_replacement_sha256);
    assert.equal(after.details.receipt.column_grant_inspect.already_applied, true);

    // A column SQL 89 does not grant is refused for checksops.
    for (const column of Object.keys(NOT_GRANTED_COLUMNS).filter((c) => c !== 'id')) {
      await admin.query('BEGIN');
      try {
        await admin.query('SET LOCAL ROLE checksops');
        await assert.rejects(admin.query(`UPDATE public.check_intake_items SET ${column} = NULL`), (error) => error.code === '42501', column);
      } finally {
        await admin.query('ROLLBACK');
      }
    }
  } finally {
    await admin.end();
    server.stop();
  }
});
