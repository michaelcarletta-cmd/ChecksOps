/**
 * SQL 116 (aws/workflows/sql/116_moov_onboarding_profile_industry.sql) in the staging guarded
 * executor, on the release engine shared with SQL 90-115 (scripts/deployment-guard/lib/release-sql-state.mjs).
 * release-sql90-97-executor.test.mjs runs what every release key shares (SQL 116 included); this
 * file covers what is new:
 *
 *   - the pin: staging-authorized from its read-live (wave 17), code-derived, selectable, packed, in step with the
 *     production pin; the pinned commit authored the bytes; after SQL 91, which it supersedes;
 *   - the spec's one added column (SQL 116 creates or replaces no function):
 *     moov_onboarding_profiles.industry, text, nullable, no default, no column grant; a column of
 *     another shape or a table not owned by the login refuses; the table's other columns are in
 *     the unrelated snapshot;
 *   - the file: the prerequisite block and one ADD COLUMN IF NOT EXISTS, nothing else;
 *   - on PostgreSQL 16 (SQL 91's real file): refused before SQL 91; one apply through the
 *     executor reaches the intended fingerprint, then is refused as already in place; SQL 91
 *     still counts as applied (by SQL 116's fingerprint) for SQL 116 and for SQL 105.
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
  AUTHORIZED_SQL116_MOOV_ONBOARDING_PROFILE_INDUSTRY,
  AUTHORIZED_STAGING_SQL,
  RELEASE_2026_10_17_PENDING_SQL_PINS as PINS,
  authorizationFingerprint,
  resolveAuthorizedMigration,
} from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import {
  RELEASE_SQL_KEYS,
  RELEASE_SQL_SPECS,
  readReleaseSqlState,
  releaseFunctionDefinitions,
  releaseIntendedHash,
  releaseIntendedState,
  releaseSharedPostconditionFailures,
  releaseSharedPreconditionFailures,
  releaseSqlExecutableText,
  releaseStateHash,
  releaseStateText,
  releaseUnrelatedScope,
} from '../../scripts/deployment-guard/lib/release-sql-state.mjs';
import { EXECUTOR_PACK_MEMBERS } from '../../scripts/deployment-guard/sql-executor-ensure.mjs';
import { MIGRATIONS } from '../../scripts/deployment-guard/github-staging-sql-executor.mjs';
import { READ_LIVE_EXPECTED_SENTINEL } from '../../scripts/deployment-guard/lib/sql-executor-read-live.mjs';
import { importGuardedSqlExecutor } from './helpers/import-guarded-sql-executor.mjs';
import { assertStagingPinState, pendingPin } from './helpers/staging-sql-wave1.mjs';
import { pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-10-26T12:00:00.000Z';
const KEY = 'sql116';
const TABLE = 'public.moov_onboarding_profiles';
const COLUMN = `${TABLE}.industry`;
const sha = (text) => createHash('sha256').update(text).digest('hex');
const TEXT = fs.readFileSync(path.join(ROOT, PINS[KEY].filename), 'utf8');
const SQL91_TEXT = fs.readFileSync(path.join(ROOT, PINS.sql91.filename), 'utf8');
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
    expiry: '2026-10-26T13:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    ...rest,
  };
  event.preflight_live_fingerprint = authorizationFingerprint(event);
  return event;
}
const inspectEvent = () => releaseEvent({ action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL });

function handlerFor(connect, { pins = {} } = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql116-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

test('pin: SQL 116 staging-authorized from its read-live, code-derived, selectable, packed, in step with the production pin; after SQL 91, which it supersedes', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL116_MOOV_ONBOARDING_PROFILE_INDUSTRY, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/116_moov_onboarding_profile_industry.sql');
  assert.equal(pin.migration_id, '116_moov_onboarding_profile_industry');
  assert.equal(spec.choice, 'sql116-moov-onboarding-profile-industry');
  assert.equal(sha(TEXT), pin.source_sha256);
  // Staging apply authorized (owner approved 2026-10-26) from staging read-live run 40336144625:
  // no industry column yet, so SQL 116 was not yet applied there.
  assertStagingPinState(assert, KEY, pin);
  assert.equal(pin.execute, true);
  assert.equal(pin.authorization, 'Owner approved 2026-10-26: staging apply (wave 17) from staging read-live run 40336144625');
  assert.equal(pin.expected_live_definition_sha256, 'd145c18e29fb0e309222d250e270f5750be7f23a8cbe336190d5c9d7bfd7d9dd');
  assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
  assert.equal(releaseIntendedHash(KEY, TEXT), pin.intended_replacement_sha256);
  assert.equal(pin.intended_replacement_sha256, 'c99fc953f7ab14c2c68647ed3bcfa3e0b50a5aa4888bdc9f9c71163392314ee1');
  // SQL 116 replaces no SQL 91 function; SQL 91 counts as applied by SQL 116's own fingerprint.
  assert.equal(pin.superseded_intended_sha256, undefined);
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql116-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], []);
  assert.deepEqual(spec.predecessors, ['sql91']);
  assert.deepEqual(spec.supersedes, ['sql91']);
  assert.equal(spec.runs_before, undefined);
  assert.equal(spec.refuse_after, undefined);
  // Only SQL 116 supersedes SQL 91; SQL 104, 105 and 109 keep SQL 91 as their predecessor.
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes('sql91')), [KEY]);
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].predecessors || []).includes('sql91')), ['sql104', 'sql105', 'sql109', KEY]);
  // Nothing in the release refuses after SQL 116, supersedes it or needs it.
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes(KEY)
    || (RELEASE_SQL_SPECS[key].refuse_after || []).some((m) => m.key === KEY)
    || (RELEASE_SQL_SPECS[key].predecessors || []).includes(KEY)), []);
  // No other release migration adds this column; SQL 91 creates the table without it.
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => key !== KEY && (RELEASE_SQL_SPECS[key].added_columns || [])
    .some((c) => `${c.table}.${c.column}` === COLUMN)), []);
  const sql91Table = RELEASE_SQL_SPECS.sql91.tables.find((t) => t.name === TABLE);
  assert.ok(sql91Table);
  assert.equal(sql91Table.columns.some(([name]) => name === 'industry'), false);
  // SQL 91 stays as applied: its file, pin and fingerprint are unchanged by SQL 116.
  assert.equal(PINS.sql91.source_sha256, '199bfa1a528d219a8683b61ae6264d84dd5b08caa74564691374c8c6c42b71e3');
  assert.equal(releaseIntendedHash('sql91', SQL91_TEXT), PINS.sql91.intended_replacement_sha256);
  assert.equal(PINS.sql91.intended_replacement_sha256, 'f8611dcca3397f684a247de454c8737074b3d2fb03c52e28fba665d0f297967d');
  const prod = productionPin();
  assert.equal(prod.intended_replacement_sha256, pin.intended_replacement_sha256);
  assert.equal(prod.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(prod.staging_pin_commit, pin.commit);
  assert.equal(prod.source_sha256, pin.source_sha256);
  assert.deepEqual(prod.predecessors, ['sql91']);
  // Production pin applied 2026-10-26 and retired (owner approved #1266, on the staging apply);
  // production's pre-state is staging's (d145c18e...: read-only production inspect SSM 5120ddac).
  assert.equal(prod.execute, false);
  assert.match(prod.authorization, /^Applied to production on 2026-10-26; execute is false again/);
  assert.equal(prod.applied.receipt.before_hash, prod.expected_live_definition_sha256);
  assert.equal(prod.applied.receipt.after_hash, pin.intended_replacement_sha256);
  assert.equal(prod.expected_live_definition_sha256, 'd145c18e29fb0e309222d250e270f5750be7f23a8cbe336190d5c9d7bfd7d9dd');
  assert.equal(prod.expected_live_definition_sha256, pin.expected_live_definition_sha256);
  assert.notEqual(prod.expected_live_definition_sha256, prod.intended_replacement_sha256);
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

test('reviewed file and spec: the prerequisite block and one nullable text column; another shape, another owner or no SQL 91 refuses', () => {
  assert.equal(releaseSqlExecutableText(KEY, TEXT), TEXT);
  assert.deepEqual(releaseFunctionDefinitions(TEXT), {});
  const code = TEXT.replace(/--[^\n]*/g, '');
  const statements = code.replace(/\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, '$$body$$').split(';').map((s) => s.trim()).filter(Boolean);
  assert.deepEqual(statements.map((s) => s.replace(/\s+/g, ' ')), [
    'DO $body$',
    'ALTER TABLE public.moov_onboarding_profiles ADD COLUMN IF NOT EXISTS industry text',
  ]);
  assert.match(code, /RAISE EXCEPTION 'sql116_prerequisite_missing: /);
  assert.match(code, /ERRCODE = '55000'/);
  for (const forbidden of [/\bGRANT\b/i, /\bREVOKE\b/i, /ROW LEVEL SECURITY/i, /\bPOLICY\b/i, /\bDROP\b/i, /\bTRUNCATE\b/i, /\bDELETE\b/, /\bUPDATE\b/, /\bINSERT\b/, /\bTRIGGER\b/, /\bCONSTRAINT\b/i, /\bDEFAULT\b/i, /\bNOT NULL\b/i, /\bFUNCTION\b/i]) {
    assert.doesNotMatch(code, forbidden, String(forbidden));
  }
  assert.match(TEXT, /Not applied by this change\./);
  assert.match(TEXT, /2026-10-26/);
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.functions, []);
  assert.deepEqual(spec.added_columns, [{ table: TABLE, column: 'industry', type: 'text', notnull: false, default: null, acl: [] }]);
  assert.deepEqual(spec.altered_relations, [TABLE]);
  assert.deepEqual(spec.prerequisites, [TABLE]);
  assert.equal(spec.column_acl, undefined);
  assert.equal(spec.render, undefined);
  const intended = releaseIntendedState(KEY, TEXT);
  assert.deepEqual(intended.columns, { [COLUMN]: { exists: true, type: 'text', notnull: false, default: null, acl: [] } });
  assert.equal(releaseStateText(KEY, intended), `release sql116 v1\ncolumn ${COLUMN}: text notnull=false default=- acl=`);
  assert.equal(releaseStateText(KEY, {}), `release sql116 v1\ncolumn ${COLUMN}: absent`);
  // Unrelated snapshot: only the new column is skipped; every other column of the table stays in it.
  const scope = releaseUnrelatedScope(KEY);
  assert.deepEqual(scope.skip_columns, [COLUMN]);
  assert.deepEqual(scope.skip_not_null_columns, [COLUMN]);
  for (const field of ['skip_relations', 'skip_constraints', 'skip_policies', 'skip_functions', 'skip_triggers', 'skip_views', 'skip_indexes', 'acl_relations']) {
    assert.deepEqual(scope[field], [], field);
  }
  // Pre-conditions: an absent column or the intended one passes; another shape refuses; the table
  // must be owned by the login and SQL 91 must be in place.
  const column = (over = {}) => ({ exists: true, type: 'text', notnull: false, default: null, acl: [], ...over });
  const base = { prerequisites_missing: [], predecessors_applied: true, successors_applied: [], dropped_function_callers: [], altered: { [TABLE]: { exists: true, owner_is_login: true } } };
  const pre = (over = {}) => releaseSharedPreconditionFailures(KEY, { ...base, ...over }, TEXT);
  assert.deepEqual(pre({ columns: { [COLUMN]: { exists: false } } }), []);
  assert.deepEqual(pre({ columns: { [COLUMN]: column() } }), []);
  for (const other of [{ type: 'character varying(64)' }, { notnull: true }, { default: "'none'::text" }, { acl: ['checksops SELECT'] }]) {
    assert.deepEqual(pre({ columns: { [COLUMN]: column(other) } }), ['added_columns_absent_or_intended'], JSON.stringify(other));
  }
  assert.deepEqual(pre({ columns: { [COLUMN]: { exists: false } }, altered: { [TABLE]: { exists: true, owner_is_login: false } } }), ['altered_relations_owned_by_login']);
  assert.deepEqual(pre({ columns: { [COLUMN]: { exists: false } }, predecessors_applied: false }), ['predecessors_applied']);
  assert.ok(pre({ columns: { [COLUMN]: { exists: false } }, prerequisites_missing: [TABLE], altered: { [TABLE]: { exists: false } } }).includes('prerequisites_present'));
  // The intended column is the intended state; an absent one is another state.
  assert.equal(releaseStateHash(KEY, { columns: { [COLUMN]: column() } }), PINS[KEY].intended_replacement_sha256);
  assert.notEqual(releaseStateHash(KEY, { columns: { [COLUMN]: { exists: false } } }), PINS[KEY].intended_replacement_sha256);
  // Post-conditions: the intended fingerprint (the rest is the unrelated snapshot's), the table still the login's.
  const pin = PINS[KEY];
  const owned = { altered: { [TABLE]: { exists: true, owner_is_login: true } }, columns: { [COLUMN]: column() } };
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, owned, { ...owned, live_definition_sha256: pin.intended_replacement_sha256 }, pin), []);
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, owned, { ...owned, live_definition_sha256: 'f'.repeat(64) }, pin), ['intended_state']);
});

async function withPg(t, prefix, port, fn) {
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
  const fx = await releaseFixture(pg, prefix, port);
  try {
    await fn(fx);
  } finally {
    await fx.close();
  }
}

test('PostgreSQL 16: SQL 116 through the executor: refused before SQL 91, drift refused, one apply on the intended fingerprint, then refused as in place; SQL 91 stays applied', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql116-exec-', 59216, async ({ admin, connectAs }) => {
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
  const columns = async () => (await admin.query(`SELECT a.attname AS name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull, a.atthasdef AS hasdef
    FROM pg_catalog.pg_attribute a WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, [TABLE])).rows;
  /** SQL 91 as the release engine reads it (its own fingerprint, and whether it counts as applied for SQL 105). */
  const sql91 = async () => {
    const client = await connectAs('checksops_admin');
    try {
      await client.query('BEGIN READ ONLY');
      const own = (await readReleaseSqlState(client, 'sql91', { counts: false })).details;
      const sql105 = (await readReleaseSqlState(client, 'sql105', { counts: false })).details;
      await client.query('ROLLBACK');
      return { own: own.live_definition_sha256, for105: sql105.predecessors };
    } finally {
      await client.end();
    }
  };

  // Before SQL 91: the table and the predecessor are missing, so SQL 116 refuses.
  const early = await inspect();
  assert.deepEqual(early.release_sql_inspect.predecessors, { sql91: false });
  assert.ok(early.precondition_failures.includes('predecessors_applied'));
  assert.ok(early.precondition_failures.includes('prerequisites_present'));
  assert.equal((await apply(early.live_definition_sha256)).ok, false);
  const owner = await connectAs('checksops_admin');
  try {
    await owner.query(SQL91_TEXT);
  } finally {
    await owner.end();
  }
  assert.equal((await sql91()).own, PINS.sql91.intended_replacement_sha256);

  const r = await inspect();
  assert.deepEqual(r.precondition_failures, [], JSON.stringify(r.release_sql_inspect));
  assert.deepEqual(r.release_sql_inspect.predecessors, { sql91: true });
  assert.equal(r.already_applied, false);
  const before = await columns();
  assert.equal(before.some((c) => c.name === 'industry'), false);
  // A pending pin cannot apply (the committed pin is staging-authorized, so pend a copy).
  const pendingCopy = pendingPin(PINS[KEY]);
  const pending = await handlerFor(connect, { pins: { [KEY]: pendingCopy } })(releaseEvent({ pin: pendingCopy, expected_live_definition_sha256: r.live_definition_sha256 }));
  assert.equal(pending.ok, false);
  // Drift between the recorded pre-state and the apply refuses.
  await admin.query(`ALTER TABLE ${TABLE} ADD COLUMN industry character varying(64)`);
  assert.equal((await apply(r.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
  await admin.query(`ALTER TABLE ${TABLE} DROP COLUMN industry`);

  const applied = await apply(r.live_definition_sha256);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.before_hash, r.live_definition_sha256);
  assert.equal(applied.details.receipt.after_hash, PINS[KEY].intended_replacement_sha256);
  const after = await inspect();
  assert.equal(after.already_applied, true);
  assert.deepEqual(after.precondition_failures, []);
  // Exactly one nullable text column without a default was added; every other column is unchanged.
  const now = await columns();
  assert.deepEqual(now.filter((c) => c.name !== 'industry'), before);
  assert.deepEqual(now.filter((c) => c.name === 'industry'), [{ name: 'industry', type: 'text', notnull: false, hasdef: false }]);
  assert.equal((await apply(r.live_definition_sha256)).code, CODES.UNRELATED_MUTATION);
  // SQL 91's own fingerprint moved with its table's columns, but it still counts as applied, by
  // SQL 116's fingerprint: for SQL 116 itself and for SQL 105 (and SQL 104 and 109 alike).
  assert.deepEqual(after.release_sql_inspect.predecessors, { sql91: true });
  const state91 = await sql91();
  assert.notEqual(state91.own, PINS.sql91.intended_replacement_sha256);
  assert.deepEqual(state91.for105, { sql91: true });
}));
