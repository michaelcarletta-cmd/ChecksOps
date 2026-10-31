/**
 * SQL 135 (aws/workflows/sql/135_check_create_insert_grant.sql) in the staging guarded executor, on
 * the release engine shared with SQL 90-134 (scripts/deployment-guard/lib/release-sql-state.mjs).
 * release-sql90-97-executor.test.mjs runs what every release key shares (SQL 135 included); this file
 * covers what is new:
 *
 *   - the pin: pending (no read-live yet), code-derived, selectable, packed, in step with the pending
 *     production pin; the pinned commit authored the bytes; no predecessor;
 *   - the spec's twenty-four column_acl entries (SQL 135 creates or replaces no function), as SQL 92's,
 *     SQL 114's and SQL 134's, with authenticated INSERT as the revoked line (as SQL 100): the
 *     fingerprint is the column ACL (every grantee) of the check_intake_items columns handleCreateCheck
 *     names; checksops INSERT on all, SQL 89's checksops UPDATE kept on seventeen; the expected
 *     pre-states (production's, staging's with SQL 50's lines) are derived here; held lines and
 *     authenticated INSERT pass the pre-conditions, any other grant on those columns refuses, all held
 *     is already in place, and the table ACL and the other columns are in the unrelated snapshot;
 *   - the file: the fail-closed precondition block, one column-scoped GRANT to checksops and one REVOKE
 *     of the same columns from authenticated, nothing else;
 *   - on PostgreSQL 16 (the table as SQL 50 and SQL 89 leave staging): the read-live reads the derived
 *     pre-state; a pending pin cannot apply; drift refuses; one apply through the executor reaches the
 *     intended fingerprint and leaves the table ACL and every other column's ACL as they were, then is
 *     refused as already in place.
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
  AUTHORIZED_SQL135_CHECK_CREATE_INSERT_GRANT,
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
import { INSERT_COLUMNS, TABLE, checkIntakeSchema, sql89Columns } from './helpers/sql135-check-intake-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-10-31T12:00:00.000Z';
const KEY = 'sql135';
const SQL89 = new Set(sql89Columns());
/** SQL 50's twenty INSERT columns (all but claim_id and the cash-job columns). */
const SQL50 = Object.freeze(INSERT_COLUMNS.slice(0, 20));
/** The twenty-four columns in spec order: [column, the pinned lines]. */
const COLUMNS = Object.freeze(INSERT_COLUMNS.map((c) => [c, SQL89.has(c) ? ['checksops INSERT', 'checksops UPDATE'] : ['checksops INSERT']]));
const UPDATE_HELD = Object.freeze(['status', 'check_stage', 'ocr_status', 'front_image_path', 'back_image_path', 'ocr_needs_verification', 'carrier_name', 'check_number', 'payee_line', 'property_address', 'funds_type', 'review_notes', 'payee_address', 'expiration_days', 'is_multi_payee', 'issue_date', 'amount']);
/** Expected pre-states, derived below and read back on PostgreSQL 16. */
const PRE_PRODUCTION = '5e147e3929d9f3ae9a8edbf9e3a1b1b896993a9b9ff88cb7d093b2e7273305e4';
const PRE_STAGING_SQL50 = '4dac49398757060deee5d636f193059e30cbe1ffdb33890122f79f026d144f33';
const sha = (text) => createHash('sha256').update(text).digest('hex');
const TEXT = fs.readFileSync(path.join(ROOT, PINS[KEY].filename), 'utf8');
const FILES = Object.freeze(Object.fromEntries(RELEASE_SQL_KEYS.map((key) => [key, path.join(ROOT, PINS[key].filename)])));
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK|BEGIN READ ONLY)\b/i;
const productionPin = () => JSON.parse(fs.readFileSync(path.join(ROOT, RELEASE_SQL_SPECS[KEY].production_pin_rel), 'utf8'));
const colKey = (column) => `${TABLE}.${column}`;
/** SQL 89's UPDATE line alone (production's column ACL; staging's after SQL 51). */
const sql89Only = (c) => (SQL89.has(c) ? ['checksops UPDATE'] : []);
/** SQL 89's line plus SQL 50's two INSERT lines (staging where SQL 51 was never run). */
const sql50And89 = (c) => [...sql89Only(c), ...(SQL50.includes(c) ? ['authenticated INSERT', 'checksops INSERT'] : [])].sort();

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
    expiry: '2026-10-31T13:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    ...rest,
  };
  event.preflight_live_fingerprint = authorizationFingerprint(event);
  return event;
}
const inspectEvent = () => releaseEvent({ action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL });

function handlerFor(connect, { pins = {} } = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql135-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

test('pin: SQL 135 pending, code-derived, selectable, packed, in step with the pending production pin; no predecessor', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL135_CHECK_CREATE_INSERT_GRANT, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/135_check_create_insert_grant.sql');
  assert.equal(pin.migration_id, '135_check_create_insert_grant');
  assert.equal(spec.choice, 'sql135-check-create-insert-grant');
  assert.equal(sha(TEXT), pin.source_sha256);
  // Pending: no staging read-live recorded yet.
  assertStagingPinState(assert, KEY, pin);
  assert.equal(pin.execute, false);
  assert.equal(pin.authorization, 'pending');
  assert.equal(pin.expected_live_definition_sha256, null);
  assert.equal(releaseIntendedHash(KEY, TEXT), pin.intended_replacement_sha256);
  assert.equal(pin.intended_replacement_sha256, '946e84beb5a459f55bdc1fb90d839dcfeb292901573e3e5fb6ceb24a65213a6d');
  for (const pre of [PRE_PRODUCTION, PRE_STAGING_SQL50]) assert.notEqual(pre, pin.intended_replacement_sha256);
  assert.equal(pin.superseded_intended_sha256, undefined);
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql135-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], []);
  assert.deepEqual(spec.predecessors, []);
  assert.equal(spec.runs_before, undefined);
  assert.equal(spec.supersedes, undefined);
  assert.equal(spec.refuse_after, undefined);
  // Nothing in the release refuses after SQL 135, supersedes it or needs it.
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes(KEY)
    || (RELEASE_SQL_SPECS[key].refuse_after || []).some((m) => m.key === KEY)
    || (RELEASE_SQL_SPECS[key].predecessors || []).includes(KEY)), []);
  // SQL 92, SQL 114 and SQL 134 (the same kind of column grant) are unchanged.
  for (const key of ['sql92', 'sql114', 'sql134']) {
    assert.equal(PINS[key].intended_replacement_sha256, releaseIntendedHash(key, fs.readFileSync(path.join(ROOT, PINS[key].filename), 'utf8')), key);
  }
  const prod = productionPin();
  assert.equal(prod.intended_replacement_sha256, pin.intended_replacement_sha256);
  assert.equal(prod.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(prod.staging_pin_commit, pin.commit);
  assert.equal(prod.source_sha256, pin.source_sha256);
  assert.deepEqual(prod.predecessors, []);
  assert.equal(prod.execute, false);
  assert.equal(prod.authorization, 'pending');
  assert.equal(prod.expected_live_definition_sha256, null);
  assert.equal(prod.production_inspect.status, 'pending');
  assert.ok(prod.production_inspect.note.includes(PRE_PRODUCTION));
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

test('reviewed file and spec: preconditions, one GRANT to checksops, one REVOKE from authenticated; the fingerprint is each column ACL; the derived pre-states; held lines pass; another grant on a column refuses', () => {
  assert.equal(releaseSqlExecutableText(KEY, TEXT), TEXT);
  assert.deepEqual(releaseFunctionDefinitions(TEXT), {});
  const code = TEXT.replace(/--[^\n]*/g, '');
  // The precondition block, then exactly the two column-scoped statements.
  const blockEnd = code.indexOf('$sql135_preconditions$;') + '$sql135_preconditions$;'.length;
  assert.ok(code.trimStart().startsWith('DO $sql135_preconditions$'));
  const block = code.slice(0, blockEnd);
  for (const raise of ['sql135_table_missing', 'sql135_column_missing', 'sql135_role_missing']) assert.match(block, new RegExp(`RAISE EXCEPTION '${raise}:`), raise);
  assert.doesNotMatch(block, /\b(GRANT|REVOKE|ALTER|CREATE|DROP|INSERT INTO|UPDATE public|DELETE FROM|EXECUTE)\b/);
  assert.deepEqual([...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).filter((w) => INSERT_COLUMNS.includes(w)), [...INSERT_COLUMNS]);
  const statements = code.slice(blockEnd).split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  assert.deepEqual(statements, [
    `GRANT INSERT ( ${INSERT_COLUMNS.join(', ')} ) ON TABLE ${TABLE} TO checksops`,
    `REVOKE INSERT ( ${INSERT_COLUMNS.join(', ')} ) ON TABLE ${TABLE} FROM authenticated`,
  ]);
  const rest = code.slice(blockEnd);
  for (const forbidden of [/\bPUBLIC\b/, /\banon\b/, /ROW LEVEL SECURITY/i, /\bPOLICY\b/i, /\bCREATE\b/i, /\bDROP\b/i, /\bALTER\b/i, /\bTRUNCATE\b/i, /\bDELETE\b/, /\bSELECT\b/, /\bUPDATE\b/, /\bSEQUENCE\b/i, /\bDO\b/, /(GRANT|REVOKE) INSERT ON/i, /\bservice_role\b/]) {
    assert.doesNotMatch(rest, forbidden, String(forbidden));
  }
  assert.match(TEXT, /Not applied\n-- by this change/);
  assert.match(TEXT, /permission denied for table check_intake_items/);
  assert.match(TEXT, /13:06:40Z and 13:15:40Z/);
  assert.match(TEXT, /aws_write_check_intake_items/);
  assert.match(TEXT, /50_tranche5_write_grants\.sql/);
  assert.match(TEXT, /51_tranche5_revoke_write_grants\.sql/);
  assert.match(TEXT, /A new migration, not an edit to SQL 50 or SQL 51/);
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.functions, []);
  assert.equal(spec.table_privileges, undefined);
  assert.deepEqual(INSERT_COLUMNS.filter((c) => SQL89.has(c)), [...UPDATE_HELD]);
  assert.deepEqual(spec.column_acl.map((c) => [c.table, c.column, [...c.acl], [...c.revokes]]), COLUMNS.map(([c, acl]) => [TABLE, c, [...acl], ['authenticated INSERT']]));
  assert.deepEqual(spec.altered_relations, [TABLE]);
  assert.deepEqual(spec.prerequisites, [TABLE, ...COLUMNS.map(([c]) => `column ${colKey(c)}`), 'role checksops', 'role authenticated']);
  assert.equal(spec.render, undefined);
  assert.equal(spec.whole_tables, undefined);
  const intended = releaseIntendedState(KEY, TEXT);
  assert.deepEqual(intended.columns, Object.fromEntries(COLUMNS.map(([c, acl]) => [colKey(c), { exists: true, acl: [...acl] }])));
  assert.equal(releaseStateText(KEY, intended), ['release sql135 v1', ...COLUMNS.map(([c, acl]) => `column ${colKey(c)} acl: ${acl.join(';')}`)].join('\n'));
  assert.equal(releaseStateText(KEY, {}), ['release sql135 v1', ...COLUMNS.map(([c]) => `column ${colKey(c)}: absent`)].join('\n'));
  // The expected pre-states.
  const live = (aclOf) => ({ columns: Object.fromEntries(COLUMNS.map(([c, acl]) => [colKey(c), { exists: true, acl: aclOf(c, acl) }])) });
  assert.equal(releaseStateHash(KEY, live(sql89Only)), PRE_PRODUCTION);
  assert.equal(releaseStateHash(KEY, live(sql50And89)), PRE_STAGING_SQL50);
  // Unrelated snapshot: only the twenty-four columns are skipped; the table's own ACL stays in it.
  const scope = releaseUnrelatedScope(KEY);
  assert.deepEqual(scope.skip_columns, COLUMNS.map(([c]) => colKey(c)));
  assert.deepEqual(scope.acl_relations, []);
  for (const field of ['skip_relations', 'skip_constraints', 'skip_policies', 'skip_functions', 'skip_triggers', 'skip_views', 'skip_indexes', 'skip_not_null_columns']) {
    assert.deepEqual(scope[field], [], field);
  }
  // Pre-conditions: any subset of the pinned lines, with or without authenticated INSERT, passes;
  // another grant on a column refuses; a missing column refuses; the table must be owned by the login.
  const cols = (aclOf) => Object.fromEntries(COLUMNS.map(([c, acl]) => [colKey(c), { exists: true, type: 'x', notnull: false, default: null, acl: aclOf(c, acl) }]));
  const owned = { [TABLE]: { exists: true, owner_is_login: true } };
  const base = { prerequisites_missing: [], predecessors_applied: true, successors_applied: [], dropped_function_callers: [], altered: owned };
  const pre = (over = {}) => releaseSharedPreconditionFailures(KEY, { ...base, ...over }, TEXT);
  for (const held of [() => [], sql89Only, sql50And89, (c, acl) => [...acl], (c, acl) => [...acl, 'authenticated INSERT'].sort()]) {
    assert.deepEqual(pre({ columns: cols(held) }), [], String(held));
  }
  assert.deepEqual(pre({ columns: cols((c) => (c === 'claim_id' ? ['service_role INSERT'] : [])) }), ['column_acl_replaceable']);
  // authenticated UPDATE (SQL 89 revoked it) or UPDATE on a column SQL 89 does not grant is not a pinned line.
  assert.deepEqual(pre({ columns: cols((c) => (c === 'status' ? ['authenticated UPDATE', 'checksops UPDATE'] : [])) }), ['column_acl_replaceable']);
  assert.deepEqual(pre({ columns: cols((c) => (c === 'tenant_id' ? ['checksops UPDATE'] : [])) }), ['column_acl_replaceable']);
  assert.deepEqual(pre({ columns: cols((c) => (c === 'amount' ? ['checksops INSERT with grant option'] : [])) }), ['column_acl_replaceable']);
  assert.deepEqual(pre({ columns: { ...cols(() => []), [colKey('cash_job_payment_class')]: { exists: false } } }), ['column_acl_replaceable']);
  assert.deepEqual(pre({ columns: cols(() => []), altered: { [TABLE]: { exists: true, owner_is_login: false } } }), ['altered_relations_owned_by_login']);
  assert.deepEqual(pre({ columns: cols(() => []), prerequisites_missing: [`column ${colKey('claim_id')}`] }), ['prerequisites_present']);
  // All pinned lines held and no authenticated INSERT: live == intended, already in place.
  assert.equal(releaseStateHash(KEY, live((c, acl) => [...acl])), PINS[KEY].intended_replacement_sha256);
  // authenticated INSERT left on one column, or SQL 89's UPDATE missing on one, is another state.
  assert.notEqual(releaseStateHash(KEY, live((c, acl) => (c === 'id' ? [...acl, 'authenticated INSERT'].sort() : [...acl]))), PINS[KEY].intended_replacement_sha256);
  assert.notEqual(releaseStateHash(KEY, live((c, acl) => (c === 'amount' ? ['checksops INSERT'] : [...acl]))), PINS[KEY].intended_replacement_sha256);
  // Post-conditions: the intended fingerprint (the rest is the unrelated snapshot's).
  const pin = PINS[KEY];
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, {}, { live_definition_sha256: pin.intended_replacement_sha256 }, pin), []);
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, {}, { live_definition_sha256: 'f'.repeat(64) }, pin), ['intended_state']);
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
  const fx = await releaseFixture(pg, prefix, port, { extra: [checkIntakeSchema('staging')] });
  try {
    await fn(fx);
  } finally {
    await fx.close();
  }
}

test('PostgreSQL 16: SQL 135 through the executor: the derived staging pre-state, a pending pin cannot apply, drift refused, one apply on the intended fingerprint keeps the table ACL, then refused as in place', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql135-exec-', 59235, async ({ admin, connectAs }) => {
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
  /** The table's ACL (owner excluded) and every column's ACL. */
  const acls = async () => ({
    table: (await admin.query(`SELECT pg_catalog.pg_get_userbyid(a.grantee) || ' ' || a.privilege_type AS line
      FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
      WHERE c.oid = $1::regclass AND a.grantee <> c.relowner ORDER BY 1`, [TABLE])).rows.map((r) => r.line),
    columns: Object.fromEntries((await admin.query(`SELECT a.attname AS name,
      ARRAY(SELECT pg_catalog.pg_get_userbyid(x.grantee) || ' ' || x.privilege_type FROM pg_catalog.aclexplode(a.attacl) x ORDER BY 1)::text[] AS acl
      FROM pg_catalog.pg_attribute a WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, [TABLE])).rows.map((r) => [r.name, r.acl])),
  });

  const r = await inspect();
  assert.deepEqual(r.precondition_failures, [], JSON.stringify(r.release_sql_inspect));
  assert.deepEqual(r.release_sql_inspect.predecessors, {});
  assert.equal(r.already_applied, false);
  assert.equal(r.live_definition_sha256, PRE_STAGING_SQL50);
  const before = await acls();
  assert.deepEqual(before.table, ['authenticated SELECT', 'checksops SELECT']);
  for (const [c] of COLUMNS) assert.deepEqual(before.columns[c], sql50And89(c), c);
  // A pending pin cannot apply (the committed pin is pending; pend a copy anyway).
  const pendingCopy = pendingPin(PINS[KEY]);
  const pending = await handlerFor(connect, { pins: { [KEY]: pendingCopy } })(releaseEvent({ pin: pendingCopy, expected_live_definition_sha256: r.live_definition_sha256 }));
  assert.equal(pending.ok, false);
  // Drift between the recorded pre-state and the apply refuses.
  await admin.query(`GRANT INSERT (claim_id) ON TABLE ${TABLE} TO checksops`);
  assert.equal((await apply(r.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
  await admin.query(`REVOKE INSERT (claim_id) ON TABLE ${TABLE} FROM checksops`);

  const applied = await apply(r.live_definition_sha256);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.before_hash, r.live_definition_sha256);
  assert.equal(applied.details.receipt.after_hash, PINS[KEY].intended_replacement_sha256);
  const after = await inspect();
  assert.equal(after.already_applied, true);
  assert.deepEqual(after.precondition_failures, []);
  // Exactly the twenty-four columns changed; the table ACL and every other column are unchanged.
  const now = await acls();
  assert.deepEqual(now.table, before.table);
  const pinned = Object.fromEntries(COLUMNS);
  for (const [name, acl] of Object.entries(now.columns)) {
    assert.deepEqual(acl, Object.hasOwn(pinned, name) ? [...pinned[name]] : before.columns[name], name);
  }
  assert.equal((await apply(r.live_definition_sha256)).code, CODES.UNRELATED_MUTATION);
}));
