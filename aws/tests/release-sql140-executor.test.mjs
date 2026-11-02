/**
 * SQL 140 (aws/workflows/sql/140_wallet_funding_settings_write_grants.sql) in the staging guarded
 * executor, on the release engine shared with SQL 90-139 (scripts/deployment-guard/lib/release-sql-state.mjs).
 * release-sql90-97-executor.test.mjs runs what every release key shares (SQL 140 included); this file
 * covers what is new:
 *
 *   - the pin: staging-authorized (wave 36) from staging read-live run 41452217978 (the derived pre-state: no
 *     column grant), code-derived, selectable, packed, in step with the production pin (execute true on
 *     production's own pre-state, the same one staging had); the pinned commit authored the bytes; no predecessor;
 *   - the spec's thirteen column_acl entries (SQL 140 creates or replaces no function), as SQL 92's,
 *     SQL 114's, SQL 134's and SQL 135's, nothing revoked: the fingerprint is the column ACL (every
 *     grantee) of the tenant_wallet_funding_settings columns the automatic funding save writes;
 *     checksops INSERT on the twelve it inserts, checksops UPDATE on the twelve it updates; the expected
 *     pre-state (no column grant, the restore's state) is derived here; held lines pass the
 *     pre-conditions, any other grant on those columns refuses, all held is already in place, and the
 *     table ACL and the other columns are in the unrelated snapshot;
 *   - the file: the fail-closed precondition block, one column-scoped INSERT grant and one column-scoped
 *     UPDATE grant to checksops, nothing else;
 *   - on PostgreSQL 16 (the table as the restore leaves it, helpers/sql140-wallet-funding-schema.mjs):
 *     the read-live reads the derived pre-state; a pending pin cannot apply; drift refuses; one apply
 *     through the executor reaches the intended fingerprint and leaves the table ACL and every other
 *     column's ACL as they were, then is refused as already in place.
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
  AUTHORIZED_SQL140_WALLET_FUNDING_SETTINGS_WRITE_GRANTS,
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
import { COLUMNS, INSERT_COLUMNS, TABLE, UPDATE_COLUMNS, pinned, walletFundingSchema } from './helpers/sql140-wallet-funding-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-11-02T13:00:00.000Z';
const KEY = 'sql140';
/** The thirteen columns in spec order: [column, the pinned lines]. */
const PINNED = Object.freeze(COLUMNS.map((c) => [c, pinned(c)]));
/** Expected pre-state (no column grant), derived below and read back on PostgreSQL 16. */
const PRE_NONE = 'fa08a3db73806391d757885c9165d0f1bf56a4571a22b1a32e2e63c73578952d';
const sha = (text) => createHash('sha256').update(text).digest('hex');
const TEXT = fs.readFileSync(path.join(ROOT, PINS[KEY].filename), 'utf8');
const FILES = Object.freeze(Object.fromEntries(RELEASE_SQL_KEYS.map((key) => [key, path.join(ROOT, PINS[key].filename)])));
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK|BEGIN READ ONLY)\b/i;
const productionPin = () => JSON.parse(fs.readFileSync(path.join(ROOT, RELEASE_SQL_SPECS[KEY].production_pin_rel), 'utf8'));
const colKey = (column) => `${TABLE}.${column}`;

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
    expiry: '2026-11-02T14:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    ...rest,
  };
  event.preflight_live_fingerprint = authorizationFingerprint(event);
  return event;
}
const inspectEvent = () => releaseEvent({ action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL });

function handlerFor(connect, { pins = {} } = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql140-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

test('pin: SQL 140 staging-authorized from its read-live, code-derived, selectable, packed, in step with the production pin; no predecessor', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL140_WALLET_FUNDING_SETTINGS_WRITE_GRANTS, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/140_wallet_funding_settings_write_grants.sql');
  assert.equal(pin.migration_id, '140_wallet_funding_settings_write_grants');
  assert.equal(spec.choice, 'sql140-wallet-funding-settings-write-grants');
  assert.doesNotMatch(spec.choice, /production/);
  assert.equal(sha(TEXT), pin.source_sha256);
  // Staging apply authorized (owner approved 2026-11-02, "record the SQL 140 staging pin") from staging read-live
  // run 41452217978: already_applied false, precondition_failures [], all thirteen columns acl [], the pre-state
  // derived here.
  assertStagingPinState(assert, KEY, pin);
  assert.equal(pin.execute, true);
  assert.equal(pin.authorization, 'Owner approved 2026-11-02: staging apply (wave 36) from staging read-live run 41452217978');
  assert.equal(pin.expected_live_definition_sha256, PRE_NONE);
  assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
  assert.equal(releaseIntendedHash(KEY, TEXT), pin.intended_replacement_sha256);
  assert.equal(pin.intended_replacement_sha256, '6157ad0d9a04d119c2f4c6b289470c302f16626de6b5d3e32ff25a93f161ea5b');
  assert.notEqual(PRE_NONE, pin.intended_replacement_sha256);
  assert.equal(pin.superseded_intended_sha256, undefined);
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql140-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], []);
  assert.deepEqual(spec.predecessors, []);
  assert.equal(spec.runs_before, undefined);
  assert.equal(spec.supersedes, undefined);
  assert.equal(spec.refuse_after, undefined);
  // Nothing in the release refuses after SQL 140, supersedes it or needs it.
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes(KEY)
    || (RELEASE_SQL_SPECS[key].refuse_after || []).some((m) => m.key === KEY)
    || (RELEASE_SQL_SPECS[key].predecessors || []).includes(KEY)), []);
  // SQL 92, SQL 114, SQL 134 and SQL 135 (the same kind of column grant) are unchanged.
  for (const key of ['sql92', 'sql114', 'sql134', 'sql135']) {
    assert.equal(PINS[key].intended_replacement_sha256, releaseIntendedHash(key, fs.readFileSync(path.join(ROOT, PINS[key].filename), 'utf8')), key);
  }
  const prod = productionPin();
  assert.equal(prod.intended_replacement_sha256, pin.intended_replacement_sha256);
  assert.equal(prod.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(prod.staging_pin_commit, pin.commit);
  assert.equal(prod.source_sha256, pin.source_sha256);
  assert.deepEqual(prod.predecessors, []);
  // Production pin execute-authorized (owner-approved pin change of 2026-11-02) on the staging apply. Its pre-state is
  // production's own (read-only inspect SSM e89960f1), the same pre-state staging recorded (read-live run 41452217978)
  // and the one derived from the file.
  assert.equal(prod.execute, true);
  assert.match(prod.authorization, /^Owner approved 2026-11-02 /);
  assert.equal(prod.expected_live_definition_sha256, prod.production_inspect.live_definition_sha256);
  assert.equal(prod.expected_live_definition_sha256, pin.expected_live_definition_sha256);
  assert.equal(prod.expected_live_definition_sha256, PRE_NONE);
  assert.notEqual(prod.expected_live_definition_sha256, prod.intended_replacement_sha256);
  assert.equal(prod.production_inspect.status, 'recorded');
  assert.ok(prod.production_inspect.note.includes(PRE_NONE));
  assert.match(prod.production_inspect.note, / Earlier: Pending: no read-only production inspect has been run for SQL 140 yet\./);
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

test('reviewed file and spec: preconditions, one INSERT grant and one UPDATE grant to checksops; the fingerprint is each column ACL; the derived pre-state; held lines pass; another grant on a column refuses', () => {
  assert.equal(releaseSqlExecutableText(KEY, TEXT), TEXT);
  assert.deepEqual(releaseFunctionDefinitions(TEXT), {});
  const code = TEXT.replace(/--[^\n]*/g, '');
  // The precondition block, then exactly the two column-scoped statements.
  const blockEnd = code.indexOf('$sql140_preconditions$;') + '$sql140_preconditions$;'.length;
  assert.ok(code.trimStart().startsWith('DO $sql140_preconditions$'));
  const block = code.slice(0, blockEnd);
  for (const raise of ['sql140_table_missing', 'sql140_column_missing', 'sql140_role_missing']) assert.match(block, new RegExp(`RAISE EXCEPTION '${raise}:`), raise);
  assert.doesNotMatch(block, /\b(GRANT|REVOKE|ALTER|CREATE|DROP|INSERT INTO|UPDATE public|DELETE FROM|EXECUTE)\b/);
  assert.deepEqual([...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).filter((w) => COLUMNS.includes(w)), [...COLUMNS]);
  const statements = code.slice(blockEnd).split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  assert.deepEqual(statements, [
    `GRANT INSERT ( ${INSERT_COLUMNS.join(', ')} ) ON TABLE ${TABLE} TO checksops`,
    `GRANT UPDATE ( ${UPDATE_COLUMNS.join(', ')} ) ON TABLE ${TABLE} TO checksops`,
  ]);
  const rest = code.slice(blockEnd);
  for (const forbidden of [/\bPUBLIC\b/, /\banon\b/, /\bauthenticated\b/, /\bservice_role\b/, /ROW LEVEL SECURITY/i, /\bPOLICY\b/i, /\bCREATE\b/i, /\bDROP\b/i, /\bALTER\b/i, /\bTRUNCATE\b/i, /\bDELETE\b/, /\bSELECT\b/, /\bREVOKE\b/, /\bSEQUENCE\b/i, /\bDO\b/, /(GRANT|REVOKE) (INSERT|UPDATE) ON/i]) {
    assert.doesNotMatch(rest, forbidden, String(forbidden));
  }
  assert.match(TEXT, /Not applied by this change/);
  assert.match(TEXT, /permission denied for table tenant_wallet_funding_settings/);
  assert.match(TEXT, /2026-11-02 12:31:40Z/);
  assert.match(TEXT, /aws_write_tenant_wallet_funding_settings/);
  assert.match(TEXT, /02_grant_readonly_application_role\.sql/);
  assert.match(TEXT, /A new migration, not an edit to any earlier file/);
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.functions, []);
  assert.equal(spec.table_privileges, undefined);
  assert.deepEqual(UPDATE_COLUMNS, [...INSERT_COLUMNS.slice(1), 'updated_at']);
  assert.deepEqual(spec.column_acl.map((c) => [c.table, c.column, [...c.acl], c.revokes]), PINNED.map(([c, acl]) => [TABLE, c, [...acl], undefined]));
  assert.deepEqual(spec.altered_relations, [TABLE]);
  assert.deepEqual(spec.prerequisites, [TABLE, ...PINNED.map(([c]) => `column ${colKey(c)}`), 'role checksops']);
  assert.equal(spec.render, undefined);
  assert.equal(spec.whole_tables, undefined);
  const intended = releaseIntendedState(KEY, TEXT);
  assert.deepEqual(intended.columns, Object.fromEntries(PINNED.map(([c, acl]) => [colKey(c), { exists: true, acl: [...acl] }])));
  assert.equal(releaseStateText(KEY, intended), ['release sql140 v1', ...PINNED.map(([c, acl]) => `column ${colKey(c)} acl: ${acl.join(';')}`)].join('\n'));
  assert.equal(releaseStateText(KEY, {}), ['release sql140 v1', ...PINNED.map(([c]) => `column ${colKey(c)}: absent`)].join('\n'));
  // The expected pre-state: no column grant (the restore gave checksops table SELECT only).
  const live = (aclOf) => ({ columns: Object.fromEntries(PINNED.map(([c, acl]) => [colKey(c), { exists: true, acl: aclOf(c, acl) }])) });
  assert.equal(releaseStateHash(KEY, live(() => [])), PRE_NONE);
  // Unrelated snapshot: only the thirteen columns are skipped; the table's own ACL stays in it.
  const scope = releaseUnrelatedScope(KEY);
  assert.deepEqual(scope.skip_columns, PINNED.map(([c]) => colKey(c)));
  assert.deepEqual(scope.acl_relations, []);
  for (const field of ['skip_relations', 'skip_constraints', 'skip_policies', 'skip_functions', 'skip_triggers', 'skip_views', 'skip_indexes', 'skip_not_null_columns']) {
    assert.deepEqual(scope[field], [], field);
  }
  // Pre-conditions: any subset of the pinned lines passes; another grant on a column refuses; a missing
  // column refuses; the table must be owned by the login.
  const cols = (aclOf) => Object.fromEntries(PINNED.map(([c, acl]) => [colKey(c), { exists: true, type: 'x', notnull: false, default: null, acl: aclOf(c, acl) }]));
  const owned = { [TABLE]: { exists: true, owner_is_login: true } };
  const base = { prerequisites_missing: [], predecessors_applied: true, successors_applied: [], dropped_function_callers: [], altered: owned };
  const pre = (over = {}) => releaseSharedPreconditionFailures(KEY, { ...base, ...over }, TEXT);
  for (const held of [() => [], (c, acl) => acl.slice(0, 1), (c, acl) => [...acl]]) {
    assert.deepEqual(pre({ columns: cols(held) }), [], String(held));
  }
  assert.deepEqual(pre({ columns: cols((c) => (c === 'tenant_id' ? ['authenticated INSERT'] : [])) }), ['column_acl_replaceable']);
  assert.deepEqual(pre({ columns: cols((c) => (c === 'funding_strategy' ? ['service_role UPDATE'] : [])) }), ['column_acl_replaceable']);
  // UPDATE on tenant_id, or INSERT on updated_at, is not a pinned line.
  assert.deepEqual(pre({ columns: cols((c) => (c === 'tenant_id' ? ['checksops UPDATE'] : [])) }), ['column_acl_replaceable']);
  assert.deepEqual(pre({ columns: cols((c) => (c === 'updated_at' ? ['checksops INSERT'] : [])) }), ['column_acl_replaceable']);
  assert.deepEqual(pre({ columns: cols((c) => (c === 'target_wallet_balance_cents' ? ['checksops INSERT with grant option'] : [])) }), ['column_acl_replaceable']);
  assert.deepEqual(pre({ columns: { ...cols(() => []), [colKey('authorization_version')]: { exists: false } } }), ['column_acl_replaceable']);
  assert.deepEqual(pre({ columns: cols(() => []), altered: { [TABLE]: { exists: true, owner_is_login: false } } }), ['altered_relations_owned_by_login']);
  assert.deepEqual(pre({ columns: cols(() => []), prerequisites_missing: [`column ${colKey('updated_at')}`] }), ['prerequisites_present']);
  // All pinned lines held: live == intended, already in place.
  assert.equal(releaseStateHash(KEY, live((c, acl) => [...acl])), PINS[KEY].intended_replacement_sha256);
  // One line missing is another state.
  assert.notEqual(releaseStateHash(KEY, live((c, acl) => (c === 'updated_at' ? [] : [...acl]))), PINS[KEY].intended_replacement_sha256);
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
  const fx = await releaseFixture(pg, prefix, port, { extra: [walletFundingSchema('none')] });
  try {
    await fn(fx);
  } finally {
    await fx.close();
  }
}

test('PostgreSQL 16: SQL 140 through the executor: the derived pre-state, a pending pin cannot apply, drift refused, one apply on the intended fingerprint keeps the table ACL, then refused as in place', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql140-exec-', 59240, async ({ admin, connectAs }) => {
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
  assert.equal(r.live_definition_sha256, PRE_NONE);
  const before = await acls();
  assert.deepEqual(before.table, ['authenticated SELECT', 'checksops SELECT']);
  for (const [c] of PINNED) assert.deepEqual(before.columns[c], [], c);
  // A pending pin cannot apply (the committed pin is staging-authorized, so pend a copy).
  const pendingCopy = pendingPin(PINS[KEY]);
  const pending = await handlerFor(connect, { pins: { [KEY]: pendingCopy } })(releaseEvent({ pin: pendingCopy, expected_live_definition_sha256: r.live_definition_sha256 }));
  assert.equal(pending.ok, false);
  // Drift between the recorded pre-state and the apply refuses.
  await admin.query(`GRANT UPDATE (updated_at) ON TABLE ${TABLE} TO checksops`);
  assert.equal((await apply(r.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
  await admin.query(`REVOKE UPDATE (updated_at) ON TABLE ${TABLE} FROM checksops`);

  const applied = await apply(r.live_definition_sha256);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.before_hash, r.live_definition_sha256);
  assert.equal(applied.details.receipt.after_hash, PINS[KEY].intended_replacement_sha256);
  const after = await inspect();
  assert.equal(after.already_applied, true);
  assert.deepEqual(after.precondition_failures, []);
  // Exactly the thirteen columns changed; the table ACL and every other column are unchanged.
  const now = await acls();
  assert.deepEqual(now.table, before.table);
  const lines = Object.fromEntries(PINNED);
  for (const [name, acl] of Object.entries(now.columns)) {
    assert.deepEqual(acl, Object.hasOwn(lines, name) ? [...lines[name]] : before.columns[name], name);
  }
  assert.equal((await apply(r.live_definition_sha256)).code, CODES.UNRELATED_MUTATION);
}));
