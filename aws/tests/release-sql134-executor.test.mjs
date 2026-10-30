/**
 * SQL 134 (aws/workflows/sql/134_loss_draft_escrow_write_grants.sql) in the staging guarded
 * executor, on the release engine shared with SQL 90-132 (scripts/deployment-guard/lib/release-sql-state.mjs).
 * release-sql90-97-executor.test.mjs runs what every release key shares (SQL 134 included); this
 * file covers what is new:
 *
 *   - the pin: staging-authorized from its read-live (wave 30), code-derived, selectable, packed, in step
 *     with the pending production pin; the pinned commit authored the bytes; no predecessor;
 *   - the spec's fourteen column_acl entries (SQL 134 creates or replaces no function), as SQL 92's
 *     and SQL 114's: the fingerprint is the column ACL (every grantee) of five loss_draft_tracking
 *     columns (UPDATE) and nine loss_draft_releases columns (INSERT); the expected pre-state (no
 *     column grant) is derived here; one or both pinned lines already held pass the pre-conditions
 *     (GRANT is a no-op), any other grant on those columns refuses, all held is already in place,
 *     and the table ACLs and the other columns are in the unrelated snapshot;
 *   - the file: the two column-scoped GRANTs to checksops and authenticated, nothing else;
 *   - on PostgreSQL 16 (the tables as the restored database and SQL 50 leave them): the read-live
 *     reads the derived pre-state; a pending pin cannot apply; drift refuses; one apply through the
 *     executor reaches the intended fingerprint and leaves the table ACLs and every other column's
 *     ACL as they were, then is refused as already in place.
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
  AUTHORIZED_SQL134_LOSS_DRAFT_ESCROW_WRITE_GRANTS,
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
import { INSERT_COLUMNS, LOSS_DRAFT_SCHEMA, RELEASES, TRACKING, UPDATE_COLUMNS } from './helpers/sql134-loss-draft-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-10-30T12:00:00.000Z';
const KEY = 'sql134';
const UPD = Object.freeze(['authenticated UPDATE', 'checksops UPDATE']);
const INS = Object.freeze(['authenticated INSERT', 'checksops INSERT']);
/** The fourteen columns in spec order: [table, column, the two pinned lines]. */
const COLUMNS = Object.freeze([
  ...UPDATE_COLUMNS.map((c) => [TRACKING, c, UPD]),
  ...INSERT_COLUMNS.map((c) => [RELEASES, c, INS]),
]);
/** The expected pre-state (no column grant on any of the fourteen), derived below and read back on PostgreSQL 16. */
const ABSENT_GRANTS = '7827f4c87e5bc9e7bd0def01d5f201a0a1fc26365480921896aa452e1403466d';
const sha = (text) => createHash('sha256').update(text).digest('hex');
const TEXT = fs.readFileSync(path.join(ROOT, PINS[KEY].filename), 'utf8');
const FILES = Object.freeze(Object.fromEntries(RELEASE_SQL_KEYS.map((key) => [key, path.join(ROOT, PINS[key].filename)])));
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK|BEGIN READ ONLY)\b/i;
const productionPin = () => JSON.parse(fs.readFileSync(path.join(ROOT, RELEASE_SQL_SPECS[KEY].production_pin_rel), 'utf8'));
const colKey = (table, column) => `${table}.${column}`;

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
    expiry: '2026-10-30T13:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    ...rest,
  };
  event.preflight_live_fingerprint = authorizationFingerprint(event);
  return event;
}
const inspectEvent = () => releaseEvent({ action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL });

function handlerFor(connect, { pins = {} } = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql134-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

test('pin: SQL 134 staging-authorized from its read-live, code-derived, selectable, packed, in step with the pending production pin; no predecessor', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL134_LOSS_DRAFT_ESCROW_WRITE_GRANTS, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/134_loss_draft_escrow_write_grants.sql');
  assert.equal(pin.migration_id, '134_loss_draft_escrow_write_grants');
  assert.equal(spec.choice, 'sql134-loss-draft-escrow-write-grants');
  assert.equal(sha(TEXT), pin.source_sha256);
  // Staging apply authorized (owner approved 2026-10-30) from staging read-live run 41130749260: none of the
  // fourteen columns granted, so SQL 134 was not yet applied there.
  assertStagingPinState(assert, KEY, pin);
  assert.equal(pin.execute, true);
  assert.equal(pin.authorization, 'Owner approved 2026-10-30: staging apply (wave 30) from staging read-live run 41130749260');
  assert.equal(pin.expected_live_definition_sha256, '7827f4c87e5bc9e7bd0def01d5f201a0a1fc26365480921896aa452e1403466d');
  assert.equal(pin.expected_live_definition_sha256, ABSENT_GRANTS);
  assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
  assert.equal(releaseIntendedHash(KEY, TEXT), pin.intended_replacement_sha256);
  assert.equal(pin.intended_replacement_sha256, 'c046d1c91cc79596c103f154b043b5421cb1dc6ceaef45d87f2f6ea1c0073c7c');
  assert.notEqual(ABSENT_GRANTS, pin.intended_replacement_sha256);
  assert.equal(pin.superseded_intended_sha256, undefined);
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql134-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], []);
  assert.deepEqual(spec.predecessors, []);
  assert.equal(spec.runs_before, undefined);
  assert.equal(spec.supersedes, undefined);
  assert.equal(spec.refuse_after, undefined);
  // Nothing in the release refuses after SQL 134, supersedes it or needs it.
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes(KEY)
    || (RELEASE_SQL_SPECS[key].refuse_after || []).some((m) => m.key === KEY)
    || (RELEASE_SQL_SPECS[key].predecessors || []).includes(KEY)), []);
  // SQL 92 and SQL 114 (the same kind of column grant) are unchanged.
  for (const key of ['sql92', 'sql114']) {
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
  assert.ok(prod.production_inspect.note.includes(ABSENT_GRANTS));
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

test('reviewed file and spec: two column-scoped GRANTs; the fingerprint is each column ACL; the derived pre-state; held lines pass; another grant on a column refuses', () => {
  assert.equal(releaseSqlExecutableText(KEY, TEXT), TEXT);
  assert.deepEqual(releaseFunctionDefinitions(TEXT), {});
  const code = TEXT.replace(/--[^\n]*/g, '');
  const statements = code.split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  assert.deepEqual(statements, [
    `GRANT UPDATE ( ${UPDATE_COLUMNS.join(', ')} ) ON TABLE ${TRACKING} TO checksops, authenticated`,
    `GRANT INSERT ( ${INSERT_COLUMNS.join(', ')} ) ON TABLE ${RELEASES} TO checksops, authenticated`,
  ]);
  for (const forbidden of [/\bREVOKE\b/i, /\bPUBLIC\b/, /\banon\b/, /ROW LEVEL SECURITY/i, /\bPOLICY\b/i, /\bCREATE\b/i, /\bDROP\b/i, /\bALTER\b/i, /\bTRUNCATE\b/i, /\bDELETE\b/, /\bSELECT\b/, /\bSEQUENCE\b/i, /\bDO\b/, /GRANT (UPDATE|INSERT) ON/i]) {
    assert.doesNotMatch(code, forbidden, String(forbidden));
  }
  assert.match(TEXT, /Not applied by this\n-- change/);
  assert.match(TEXT, /aws_write_loss_draft_releases/);
  assert.match(TEXT, /02_grant_readonly_application_role\.sql/);
  assert.match(TEXT, /50_tranche5_write_grants\.sql/);
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.functions, []);
  assert.equal(spec.table_privileges, undefined);
  assert.deepEqual(spec.column_acl.map((c) => [c.table, c.column, [...c.acl], c.revokes]), COLUMNS.map(([t, c, acl]) => [t, c, [...acl], undefined]));
  assert.deepEqual(spec.altered_relations, [TRACKING, RELEASES]);
  assert.deepEqual(spec.prerequisites, [TRACKING, RELEASES, ...COLUMNS.map(([t, c]) => `column ${colKey(t, c)}`), 'role checksops', 'role authenticated']);
  assert.equal(spec.render, undefined);
  assert.equal(spec.whole_tables, undefined);
  const intended = releaseIntendedState(KEY, TEXT);
  assert.deepEqual(intended.columns, Object.fromEntries(COLUMNS.map(([t, c, acl]) => [colKey(t, c), { exists: true, acl: [...acl] }])));
  assert.equal(releaseStateText(KEY, intended), ['release sql134 v1', ...COLUMNS.map(([t, c, acl]) => `column ${colKey(t, c)} acl: ${acl.join(';')}`)].join('\n'));
  assert.equal(releaseStateText(KEY, {}), ['release sql134 v1', ...COLUMNS.map(([t, c]) => `column ${colKey(t, c)}: absent`)].join('\n'));
  // The expected pre-state: the fourteen columns present with no column grant.
  const live = (aclOf) => ({ columns: Object.fromEntries(COLUMNS.map(([t, c, acl]) => [colKey(t, c), { exists: true, acl: aclOf(t, c, acl) }])) });
  assert.equal(releaseStateText(KEY, live(() => [])), ['release sql134 v1', ...COLUMNS.map(([t, c]) => `column ${colKey(t, c)} acl: `)].join('\n'));
  assert.equal(releaseStateHash(KEY, live(() => [])), ABSENT_GRANTS);
  // Unrelated snapshot: only the fourteen columns are skipped; the tables' own ACLs stay in it.
  const scope = releaseUnrelatedScope(KEY);
  assert.deepEqual(scope.skip_columns, COLUMNS.map(([t, c]) => colKey(t, c)));
  assert.deepEqual(scope.acl_relations, []);
  for (const field of ['skip_relations', 'skip_constraints', 'skip_policies', 'skip_functions', 'skip_triggers', 'skip_views', 'skip_indexes', 'skip_not_null_columns']) {
    assert.deepEqual(scope[field], [], field);
  }
  // Pre-conditions: any subset of the pinned lines passes; another grant on a column refuses;
  // a missing column refuses; both tables must be owned by the login.
  const cols = (aclOf) => Object.fromEntries(COLUMNS.map(([t, c, acl]) => [colKey(t, c), { exists: true, type: 'x', notnull: false, default: null, acl: aclOf(t, c, acl) }]));
  const owned = { [TRACKING]: { exists: true, owner_is_login: true }, [RELEASES]: { exists: true, owner_is_login: true } };
  const base = { prerequisites_missing: [], predecessors_applied: true, successors_applied: [], dropped_function_callers: [], altered: owned };
  const pre = (over = {}) => releaseSharedPreconditionFailures(KEY, { ...base, ...over }, TEXT);
  for (const held of [() => [], (t) => [t === TRACKING ? 'checksops UPDATE' : 'checksops INSERT'], (t, c, acl) => (c === 'draw_stage' ? [...acl] : []), (t, c, acl) => [...acl]]) {
    assert.deepEqual(pre({ columns: cols(held) }), [], String(held));
  }
  assert.deepEqual(pre({ columns: cols((t, c) => (c === 'total_escrowed' ? ['service_role UPDATE'] : [])) }), ['column_acl_replaceable']);
  // UPDATE on a releases column or INSERT on a tracking column is not a pinned line.
  assert.deepEqual(pre({ columns: cols((t, c) => (t === RELEASES && c === 'status' ? ['checksops UPDATE'] : [])) }), ['column_acl_replaceable']);
  assert.deepEqual(pre({ columns: cols((t, c) => (t === TRACKING && c === 'holdback_amount' ? ['checksops INSERT'] : [])) }), ['column_acl_replaceable']);
  assert.deepEqual(pre({ columns: cols((t, c) => (c === 'notes' ? ['checksops INSERT with grant option'] : [])) }), ['column_acl_replaceable']);
  assert.deepEqual(pre({ columns: { ...cols(() => []), [colKey(RELEASES, 'created_by')]: { exists: false } } }), ['column_acl_replaceable']);
  assert.deepEqual(pre({ columns: cols(() => []), altered: { ...owned, [RELEASES]: { exists: true, owner_is_login: false } } }), ['altered_relations_owned_by_login']);
  assert.deepEqual(pre({ columns: cols(() => []), prerequisites_missing: [`column ${colKey(TRACKING, 'draw_stage')}`] }), ['prerequisites_present']);
  // All pinned lines held: live == intended, so the tools see it as already in place.
  assert.equal(releaseStateHash(KEY, live((t, c, acl) => [...acl])), PINS[KEY].intended_replacement_sha256);
  // One line short (no authenticated INSERT on created_by) is another state.
  assert.notEqual(releaseStateHash(KEY, live((t, c, acl) => (c === 'created_by' ? ['checksops INSERT'] : [...acl]))), PINS[KEY].intended_replacement_sha256);
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
  const fx = await releaseFixture(pg, prefix, port, { extra: [LOSS_DRAFT_SCHEMA] });
  try {
    await fn(fx);
  } finally {
    await fx.close();
  }
}

test('PostgreSQL 16: SQL 134 through the executor: the derived pre-state, a pending pin cannot apply, drift refused, one apply on the intended fingerprint keeps the table ACLs, then refused as in place', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql134-exec-', 59234, async ({ admin, connectAs }) => {
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
  /** Each table's ACL (owner excluded) and every column's ACL. */
  const acls = async () => Object.fromEntries(await Promise.all([TRACKING, RELEASES].map(async (table) => [table, {
    table: (await admin.query(`SELECT pg_catalog.pg_get_userbyid(a.grantee) || ' ' || a.privilege_type AS line
      FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
      WHERE c.oid = $1::regclass AND a.grantee <> c.relowner ORDER BY 1`, [table])).rows.map((r) => r.line),
    columns: Object.fromEntries((await admin.query(`SELECT a.attname AS name,
      ARRAY(SELECT pg_catalog.pg_get_userbyid(x.grantee) || ' ' || x.privilege_type FROM pg_catalog.aclexplode(a.attacl) x ORDER BY 1)::text[] AS acl
      FROM pg_catalog.pg_attribute a WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, [table])).rows.map((r) => [r.name, r.acl])),
  }])));

  const r = await inspect();
  assert.deepEqual(r.precondition_failures, [], JSON.stringify(r.release_sql_inspect));
  assert.deepEqual(r.release_sql_inspect.predecessors, {});
  assert.equal(r.already_applied, false);
  assert.equal(r.live_definition_sha256, ABSENT_GRANTS);
  const before = await acls();
  assert.deepEqual(before[RELEASES].table, ['authenticated SELECT', 'checksops SELECT']);
  assert.ok(Object.values(before[RELEASES].columns).every((acl) => acl.length === 0));
  // SQL 50's loss_draft_tracking grants: table SELECT, INSERT, DELETE and column UPDATE on its list.
  assert.deepEqual(before[TRACKING].table, ['authenticated DELETE', 'authenticated INSERT', 'authenticated SELECT', 'checksops DELETE', 'checksops INSERT', 'checksops SELECT']);
  for (const c of ['escrow_status', 'check_received_date', 'updated_at']) assert.deepEqual(before[TRACKING].columns[c], [...UPD], c);
  for (const c of UPDATE_COLUMNS) assert.deepEqual(before[TRACKING].columns[c], [], c);
  // A pending pin cannot apply (the committed pin is staging-authorized, so pend a copy).
  const pendingCopy = pendingPin(PINS[KEY]);
  const pending = await handlerFor(connect, { pins: { [KEY]: pendingCopy } })(releaseEvent({ pin: pendingCopy, expected_live_definition_sha256: r.live_definition_sha256 }));
  assert.equal(pending.ok, false);
  // Drift between the recorded pre-state and the apply refuses.
  await admin.query(`GRANT UPDATE (draw_stage) ON TABLE ${TRACKING} TO checksops`);
  assert.equal((await apply(r.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
  await admin.query(`REVOKE UPDATE (draw_stage) ON TABLE ${TRACKING} FROM checksops`);

  const applied = await apply(r.live_definition_sha256);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.before_hash, r.live_definition_sha256);
  assert.equal(applied.details.receipt.after_hash, PINS[KEY].intended_replacement_sha256);
  const after = await inspect();
  assert.equal(after.already_applied, true);
  assert.deepEqual(after.precondition_failures, []);
  // Exactly the fourteen columns gained the two lines; the table ACLs and every other column are unchanged.
  const now = await acls();
  for (const [table, pinned, lines] of [[TRACKING, UPDATE_COLUMNS, UPD], [RELEASES, INSERT_COLUMNS, INS]]) {
    assert.deepEqual(now[table].table, before[table].table, table);
    for (const [name, acl] of Object.entries(now[table].columns)) {
      assert.deepEqual(acl, pinned.includes(name) ? [...lines] : before[table].columns[name], `${table}.${name}`);
    }
  }
  assert.equal((await apply(r.live_definition_sha256)).code, CODES.UNRELATED_MUTATION);
}));
