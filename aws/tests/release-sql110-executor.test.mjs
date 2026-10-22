/**
 * SQL 110 (aws/workflows/sql/110_homeowner_preclaim_links.sql) in the staging guarded executor,
 * on the release engine shared with SQL 90-109 (scripts/deployment-guard/lib/release-sql-state.mjs).
 * release-sql90-97-executor.test.mjs runs what every release key shares (SQL 110 included); this
 * file covers what is new:
 *
 *   - the pin: pending (no read-live yet), code-derived, selectable, packed, in step with the
 *     production pin; the pinned commit authored the bytes; no predecessor;
 *   - the file and spec: one guarded prerequisite block, GRANT DELETE on homeowner_ledger_tokens
 *     to checksops only, and one SECURITY DEFINER function, EXECUTE checksops only, writing the
 *     homeowner ledger tables (definer_writes); no table, policy or other grant DDL; the
 *     definer-write pre-condition refuses a login that cannot write them;
 *   - on PostgreSQL 16: a pending pin cannot apply; one apply through the executor reaches the
 *     intended fingerprint, then is refused as already in place.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import {
  AUTHORIZED_SQL110_HOMEOWNER_PRECLAIM_LINKS,
  AUTHORIZED_STAGING_SQL,
  RELEASE_2026_10_17_PENDING_SQL_PINS as PINS,
  authorizationFingerprint,
  resolveAuthorizedMigration,
} from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import {
  RELEASE_SQL_KEYS,
  RELEASE_SQL_SPECS,
  releaseFunctionDefinitions,
  releaseIntendedHash,
  releaseIntendedState,
  releaseSharedPreconditionFailures,
  releaseSqlExecutableText,
  releaseStateText,
} from '../../scripts/deployment-guard/lib/release-sql-state.mjs';
import { EXECUTOR_PACK_MEMBERS } from '../../scripts/deployment-guard/sql-executor-ensure.mjs';
import { MIGRATIONS } from '../../scripts/deployment-guard/github-staging-sql-executor.mjs';
import { READ_LIVE_EXPECTED_SENTINEL } from '../../scripts/deployment-guard/lib/sql-executor-read-live.mjs';
import { importGuardedSqlExecutor } from './helpers/import-guarded-sql-executor.mjs';
import { assertStagingPinState, pendingPin } from './helpers/staging-sql-wave1.mjs';
import { pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';
import { HOMEOWNER_SCHEMA } from './helpers/sql110-homeowner-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-10-22T12:00:00.000Z';
const KEY = 'sql110';
const WRITER = 'public.aws_public_homeowner_ledger_upload(text, text, text, text, numeric, text)';
const sha = (text) => createHash('sha256').update(text).digest('hex');
const TEXT = fs.readFileSync(path.join(ROOT, PINS[KEY].filename), 'utf8');
const FILES = Object.freeze(Object.fromEntries(RELEASE_SQL_KEYS.map((key) => [key, path.join(ROOT, PINS[key].filename)])));
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK|BEGIN READ ONLY)\b/i;
const productionPin = () => JSON.parse(fs.readFileSync(path.join(ROOT, RELEASE_SQL_SPECS[KEY].production_pin_rel), 'utf8'));

const { module: executorModule } = await importGuardedSqlExecutor();
const { createHandler } = executorModule;

function releaseEvent(overrides = {}) {
  const pin = overrides.pin || PINS[KEY];
  const rest = { ...overrides };
  delete rest.pin;
  const event = {
    action: 'apply',
    workstream_id: `staging-${RELEASE_SQL_SPECS[KEY].choice}`,
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
    one_use_id: `${KEY}-test-${process.pid}-${Math.random().toString(16).slice(2)}`,
    expiry: '2026-10-22T13:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    ...rest,
  };
  event.preflight_live_fingerprint = authorizationFingerprint(event);
  return event;
}
const inspectEvent = () => releaseEvent({ action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL });

function handlerFor(connect, { pins = {} } = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql110-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

test('pin: SQL 110 staging-authorized from its read-live, code-derived, selectable, packed, in step with the production pin; no predecessor', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL110_HOMEOWNER_PRECLAIM_LINKS, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/110_homeowner_preclaim_links.sql');
  assert.equal(pin.migration_id, '110_homeowner_preclaim_links');
  assert.equal(spec.choice, 'sql110-homeowner-preclaim-links');
  assert.equal(sha(TEXT), pin.source_sha256);
  assertStagingPinState(assert, KEY, pin);
  // Staging apply authorized (owner approved 2026-10-22) from staging read-live run 39836749684:
  // the writer was absent, so SQL 110 was not yet applied.
  assert.equal(pin.execute, true);
  assert.equal(pin.authorization, 'Owner approved 2026-10-22: staging apply (wave 11) from staging read-live run 39836749684');
  assert.equal(pin.expected_live_definition_sha256, '3fdbb3d323c1c0edab0c2ee7e4a6c1b08aa30c1a021c7d81899e95a616f186fd');
  assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
  assert.equal(releaseIntendedHash(KEY, TEXT), pin.intended_replacement_sha256);
  assert.equal(pin.superseded_intended_sha256, undefined);
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql110-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], [WRITER]);
  assert.deepEqual(spec.predecessors, []);
  assert.equal(spec.runs_before, undefined);
  assert.equal(spec.supersedes, undefined);
  assert.equal(spec.refuse_after, undefined);
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes(KEY)
    || (RELEASE_SQL_SPECS[key].refuse_after || []).some((m) => m.key === KEY)
    || (RELEASE_SQL_SPECS[key].predecessors || []).includes(KEY)), []);
  const prod = productionPin();
  assert.equal(prod.intended_replacement_sha256, pin.intended_replacement_sha256);
  assert.equal(prod.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(prod.staging_pin_commit, pin.commit);
  assert.equal(prod.source_sha256, pin.source_sha256);
  assert.deepEqual(prod.predecessors, []);
  assert.equal(prod.execute, false);
  let bytes = null;
  if (/^[0-9a-f]{40}$/.test(pin.commit)) {
    try {
      bytes = execFileSync('git', ['-C', ROOT, 'show', `${pin.commit}:${pin.filename}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      bytes = null;
    }
  }
  if (bytes !== null) assert.equal(sha(bytes), pin.source_sha256, 'the pinned commit carries the pinned bytes');
});

test('reviewed file and spec: one guarded block, DELETE for checksops only, one SECURITY DEFINER writer, EXECUTE checksops only; no table, policy or other grant DDL', () => {
  assert.equal(releaseSqlExecutableText(KEY, TEXT), TEXT);
  const defs = releaseFunctionDefinitions(TEXT);
  assert.deepEqual(Object.keys(defs), ['aws_public_homeowner_ledger_upload']);
  const fn = defs.aws_public_homeowner_ledger_upload;
  assert.equal(fn.security_definer, true);
  assert.equal(fn.language, 'plpgsql');
  assert.equal(fn.volatility, 'v');
  assert.equal(fn.result, 'jsonb');
  assert.deepEqual(fn.config, ['search_path=public']);
  // Only the two ledger tables are written; the token row is locked, read by the exact token.
  assert.deepEqual([...fn.prosrc.matchAll(/\b(UPDATE|INSERT INTO|DELETE FROM)\s+(public\.[a-z_]+)/g)].map((m) => `${m[1]} ${m[2]}`), [
    'INSERT INTO public.homeowner_ledger_check_uploads',
    'INSERT INTO public.homeowner_ledger_events',
  ]);
  assert.match(fn.prosrc, /WHERE token = v_token\s+LIMIT 1\s+FOR UPDATE;/);
  assert.match(fn.prosrc, /'pending_review'/);
  assert.match(fn.prosrc, /v_recent >= 25/);
  const code = TEXT.replace(/--[^\n]*/g, '');
  const outside = code.replace(/\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, '$$body$$').replace(/'(?:[^']|'')*'/g, "''");
  const statements = outside.split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  assert.equal(statements.length, 6);
  assert.equal(statements[0], 'DO $body$');
  assert.equal(statements[1], 'GRANT DELETE ON TABLE public.homeowner_ledger_tokens TO checksops');
  assert.match(statements[2], /^CREATE OR REPLACE FUNCTION public\.aws_public_homeowner_ledger_upload\(/);
  assert.match(statements[3], /^REVOKE ALL ON FUNCTION public\.aws_public_homeowner_ledger_upload\(.*\) FROM PUBLIC$/);
  assert.match(statements[4], /^GRANT EXECUTE ON FUNCTION public\.aws_public_homeowner_ledger_upload\(.*\) TO checksops$/);
  assert.match(statements[5], /^COMMENT ON FUNCTION public\.aws_public_homeowner_ledger_upload\(/);
  for (const forbidden of [/\bCREATE\s+(TABLE|POLICY|TRIGGER|INDEX|VIEW)\b/i, /\bDROP\b/i, /\bALTER\b/i, /\bTRUNCATE\b/i, /ROW LEVEL SECURITY/i, /\bTO\s+authenticated\b/i, /\banon\b/, /\bTO\s+PUBLIC\b/i]) {
    assert.doesNotMatch(outside, forbidden, String(forbidden));
  }
  assert.match(TEXT, /NOT APPLIED\./);
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.functions, [{ identity: WRITER, acl: ['checksops EXECUTE', 'owner EXECUTE'] }]);
  assert.deepEqual(spec.table_privileges, [{ table: 'public.homeowner_ledger_tokens', grantees: ['checksops'], privileges: ['DELETE'], intended: ['checksops DELETE'] }]);
  assert.deepEqual(spec.altered_relations, ['public.homeowner_ledger_tokens']);
  assert.deepEqual(spec.definer_writes, ['public.homeowner_ledger_tokens', 'public.homeowner_ledger_check_uploads', 'public.homeowner_ledger_events']);
  assert.equal(spec.policies, undefined);
  assert.equal(spec.tables, undefined);
  const intended = releaseIntendedState(KEY, TEXT);
  assert.match(releaseStateText(KEY, intended), /^release sql110 v1\nfunction public\.aws_public_homeowner_ledger_upload\(text, text, text, text, numeric, text\): lang=plpgsql vol=v parallel=u secdef=true result=jsonb config=search_path=public prosrc=[0-9a-f]{64} acl=checksops EXECUTE;owner EXECUTE\nprivileges public\.homeowner_ledger_tokens DELETE: checksops DELETE$/);
  // The definer-write pre-condition: a login that cannot write a table refuses.
  const base = {
    prerequisites_missing: [], predecessors_applied: true, successors_applied: [], dropped_function_callers: [],
    definer: Object.fromEntries(spec.definer_writes.map((table) => [table, true])),
  };
  const pre = (over = {}) => releaseSharedPreconditionFailures(KEY, { ...base, ...over }, TEXT);
  assert.ok(!pre().includes('definer_can_write_relations'));
  assert.ok(pre({ definer: { ...base.definer, 'public.homeowner_ledger_events': false } }).includes('definer_can_write_relations'));
});

test('PostgreSQL 16: SQL 110 through the executor: a pending pin cannot apply, one apply on the intended fingerprint, then already in place', { timeout: 600000 }, async (t) => {
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
  const fx = await releaseFixture(pg, 'pg-sql110-exec-', 61130, { extra: [HOMEOWNER_SCHEMA] });
  const { connectAs } = fx;
  try {
    const seen = [];
    const connect = async () => {
      const client = await connectAs('checksops_admin');
      const query = client.query.bind(client);
      client.query = (sql, params) => { seen.push(String(sql)); return query(sql, params); };
      return client;
    };
    const inspect = async () => {
      seen.length = 0;
      const result = await handlerFor(connect)(inspectEvent());
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(seen[0], 'BEGIN READ ONLY');
      assert.ok(seen.every((text) => READ_ONLY_STATEMENT_RE.test(text)), JSON.stringify(seen.filter((text) => !READ_ONLY_STATEMENT_RE.test(text))));
      return result.details.receipt;
    };
    const apply = async (live) => {
      const pin = Object.freeze({ ...PINS[KEY], expected_live_definition_sha256: live, execute: true, authorization: 'Owner approved test fixture' });
      return handlerFor(connect, { pins: { [KEY]: pin } })(releaseEvent({ pin }));
    };

    const r = await inspect();
    assert.deepEqual(r.precondition_failures, [], JSON.stringify(r.release_sql_inspect));
    assert.equal(r.already_applied, false);
    // A pending pin cannot apply (the committed pin is staging-authorized, so pend a copy).
    const pendingCopy = pendingPin(PINS[KEY]);
    const pending = await handlerFor(connect, { pins: { [KEY]: pendingCopy } })(releaseEvent({ pin: pendingCopy, expected_live_definition_sha256: r.live_definition_sha256 }));
    assert.equal(pending.ok, false);

    const applied = await apply(r.live_definition_sha256);
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.before_hash, r.live_definition_sha256);
    assert.equal(applied.details.receipt.after_hash, PINS[KEY].intended_replacement_sha256);
    const after = await inspect();
    assert.equal(after.already_applied, true);
    assert.deepEqual(after.precondition_failures, []);
    assert.equal((await apply(r.live_definition_sha256)).code, CODES.UNRELATED_MUTATION);
  } finally {
    await fx.close();
  }
});
