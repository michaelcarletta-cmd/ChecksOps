/**
 * Staging executor, Mortgage SQL 84-86: when COMMIT was sent and threw, the
 * result is "COMMIT outcome unknown; re-run read-live", never a claimed
 * rollback (UNRELATED_MUTATION). Same rule as the production tools' commitSent.
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import {
  AUTHORIZED_SQL84_MORTGAGE_RETURN_TO_QUEUE as PIN84,
  authorizationFingerprint,
} from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import { READ_LIVE_EXPECTED_SENTINEL } from '../../scripts/deployment-guard/lib/sql-executor-read-live.mjs';
import { importGuardedSqlExecutor } from './helpers/import-guarded-sql-executor.mjs';
import {
  STAGING_PER_CHECK_INDEX_SQL,
  cursorSql48,
  cursorSql49,
  mortgageRolesSql,
  mortgageSchemaSql,
} from './helpers/mortgage-sql-pg.mjs';
import { pgSkipReason, startPg } from './helpers/stakeholder-policies-pg.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const NOW = '2026-10-16T12:00:00.000Z';
const OWNER = 'mortgage_commit_login';
const { module: { createHandler } } = await importGuardedSqlExecutor();

function event(pin, overrides = {}) {
  const out = {
    action: 'apply',
    workstream_id: 'staging-sql84-mortgage-return-to-queue',
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
    expected_live_definition_sha256: pin.expected_live_definition_sha256 || READ_LIVE_EXPECTED_SENTINEL,
    one_use_id: `sql84-commit-${process.pid}-${Math.random().toString(16).slice(2)}`,
    expiry: '2026-10-16T13:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    ...overrides,
  };
  out.preflight_live_fingerprint = authorizationFingerprint(out);
  return out;
}

function handlerFor(connect, pin) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(
    os.tmpdir(),
    `sql84-commit-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), sqlFile84: path.join(ROOT, PIN84.filename), sql84Pin: pin });
}

test('PostgreSQL 16: a COMMIT that throws is reported as outcome unknown, with no ROLLBACK claimed or sent', { timeout: 240000 }, async (t) => {
  const reason = pgSkipReason();
  if (reason) return t.skip(reason);
  let pg;
  try {
    pg = (await import('pg')).default;
  } catch {
    return t.skip('pg module is not installed');
  }
  const server = startPg('pg-mortgage-commit-outcome-', 57800);
  const admin = new pg.Client({ host: server.host, port: server.port, user: 'ubuntu', database: 'postgres' });
  await admin.connect();
  const connectAs = async (user) => {
    const client = new pg.Client({ host: server.host, port: server.port, user, database: 'postgres' });
    await client.connect();
    return client;
  };
  try {
    await admin.query(mortgageRolesSql(OWNER));
    const owner = await connectAs(OWNER);
    try {
      await owner.query(mortgageSchemaSql());
      await owner.query(STAGING_PER_CHECK_INDEX_SQL);
      await owner.query(cursorSql48());
      await owner.query(cursorSql49());
    } finally {
      await owner.end();
    }

    const inspected = await handlerFor(() => connectAs(OWNER), PIN84)(event(PIN84, {
      action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL,
    }));
    assert.equal(inspected.ok, true, JSON.stringify(inspected));
    const recorded = { ...PIN84, expected_live_definition_sha256: inspected.details.receipt.live_definition_sha256 };

    // COMMIT is sent and lands, but the client sees an error (connection lost after COMMIT).
    const seen = [];
    const lostAfterCommit = async () => {
      const client = await connectAs(OWNER);
      const query = client.query.bind(client);
      client.query = async (sql, params) => {
        seen.push(String(sql));
        if (String(sql) === 'COMMIT') {
          await query(sql, params);
          throw new Error('Connection terminated unexpectedly');
        }
        return query(sql, params);
      };
      return client;
    };
    const handler = handlerFor(lostAfterCommit, recorded);
    const result = await handler(event(recorded));
    assert.equal(result.ok, false);
    assert.equal(result.code, CODES.SQL_COLLISION, JSON.stringify(result));
    assert.notEqual(result.code, CODES.UNRELATED_MUTATION);
    assert.match(result.message, /COMMIT outcome unknown; re-run read-live/);
    assert.doesNotMatch(result.message, /roll/i);
    assert.equal(result.details.commit_outcome, 'unknown');
    assert.equal(seen.at(-1), 'COMMIT', 'no ROLLBACK after COMMIT was sent');
    assert.ok(!seen.slice(seen.indexOf('COMMIT')).includes('ROLLBACK'));

    // Re-running read-live shows what happened: here it landed.
    const after = await handlerFor(() => connectAs(OWNER), recorded)(event(recorded, {
      action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL,
    }));
    assert.equal(after.details.receipt.already_applied, true);
    assert.equal(after.details.receipt.live_definition_sha256, PIN84.intended_replacement_sha256);
  } finally {
    await admin.end().catch(() => {});
    server.stop();
  }
});

test('PostgreSQL 16: a failure before COMMIT is still rolled back (UNRELATED_MUTATION)', { timeout: 240000 }, async (t) => {
  const reason = pgSkipReason();
  if (reason) return t.skip(reason);
  let pg;
  try {
    pg = (await import('pg')).default;
  } catch {
    return t.skip('pg module is not installed');
  }
  const server = startPg('pg-mortgage-commit-before-', 57850);
  const admin = new pg.Client({ host: server.host, port: server.port, user: 'ubuntu', database: 'postgres' });
  await admin.connect();
  const connectAs = async (user) => {
    const client = new pg.Client({ host: server.host, port: server.port, user, database: 'postgres' });
    await client.connect();
    return client;
  };
  try {
    await admin.query(mortgageRolesSql(OWNER));
    const owner = await connectAs(OWNER);
    try {
      await owner.query(mortgageSchemaSql());
      await owner.query(STAGING_PER_CHECK_INDEX_SQL);
      await owner.query(cursorSql48());
      await owner.query(cursorSql49());
    } finally {
      await owner.end();
    }
    const inspected = await handlerFor(() => connectAs(OWNER), PIN84)(event(PIN84, {
      action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL,
    }));
    const recorded = { ...PIN84, expected_live_definition_sha256: inspected.details.receipt.live_definition_sha256 };
    const seen = [];
    const failsMigration = async () => {
      const client = await connectAs(OWNER);
      const query = client.query.bind(client);
      client.query = async (sql, params) => {
        seen.push(String(sql));
        if (String(sql).includes('CREATE OR REPLACE FUNCTION public.return_mortgage_handling_request_to_queue')) {
          throw new Error('statement failed');
        }
        return query(sql, params);
      };
      return client;
    };
    const result = await handlerFor(failsMigration, recorded)(event(recorded));
    assert.equal(result.code, CODES.UNRELATED_MUTATION, JSON.stringify(result));
    assert.ok(seen.includes('ROLLBACK'));
    assert.ok(!seen.includes('COMMIT'));
  } finally {
    await admin.end().catch(() => {});
    server.stop();
  }
});
