/**
 * SQL 114 (aws/workflows/sql/114_stakeholder_accounts_settings_update_grant.sql) in the staging
 * guarded executor, on the release engine shared with SQL 90-113 (scripts/deployment-guard/lib/release-sql-state.mjs).
 * release-sql90-97-executor.test.mjs runs what every release key shares (SQL 114 included); this
 * file covers what is new:
 *
 *   - the pin: pending (no read-live yet), code-derived, selectable, packed, in step with the
 *     production pin; the pinned commit authored the bytes; no predecessor;
 *   - the spec's six column_acl entries (SQL 114 creates or replaces no function), as SQL 92's:
 *     the fingerprint is the column ACL (every grantee) of is_active, is_primary, account_type,
 *     homeowner_name, homeowner_email and updated_at; one or both pinned lines already held pass
 *     the pre-conditions (GRANT is a no-op), any other grant on those columns refuses, all held
 *     is already in place, and the table ACL and the other columns are in the unrelated snapshot;
 *   - the file: one guarded DO block over the six columns and the two grantees, nothing else;
 *   - on PostgreSQL 16 (the table as the restored database left it: table-level SELECT only):
 *     one apply through the executor reaches the intended fingerprint and leaves the table ACL
 *     and every other column's ACL as they were, then is refused as already in place.
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
  AUTHORIZED_SQL114_STAKEHOLDER_SETTINGS_UPDATE_GRANT,
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
import { assertStagingPinState } from './helpers/staging-sql-wave1.mjs';
import { pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';
import { SETTINGS_COLUMNS, STAKEHOLDERS, STAKEHOLDER_SETTINGS_SCHEMA } from './helpers/sql114-stakeholder-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-10-25T12:00:00.000Z';
const KEY = 'sql114';
const BOTH = Object.freeze(['authenticated UPDATE', 'checksops UPDATE']);
const sha = (text) => createHash('sha256').update(text).digest('hex');
const TEXT = fs.readFileSync(path.join(ROOT, PINS[KEY].filename), 'utf8');
const FILES = Object.freeze(Object.fromEntries(RELEASE_SQL_KEYS.map((key) => [key, path.join(ROOT, PINS[key].filename)])));
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK|BEGIN READ ONLY)\b/i;
const productionPin = () => JSON.parse(fs.readFileSync(path.join(ROOT, RELEASE_SQL_SPECS[KEY].production_pin_rel), 'utf8'));
const colKey = (column) => `${STAKEHOLDERS}.${column}`;

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
    expiry: '2026-10-25T13:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    ...rest,
  };
  event.preflight_live_fingerprint = authorizationFingerprint(event);
  return event;
}
const inspectEvent = () => releaseEvent({ action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL });

function handlerFor(connect, { pins = {} } = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql114-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

test('pin: SQL 114 pending, code-derived, selectable, packed, in step with the production pin; no predecessor', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL114_STAKEHOLDER_SETTINGS_UPDATE_GRANT, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/114_stakeholder_accounts_settings_update_grant.sql');
  assert.equal(pin.migration_id, '114_stakeholder_accounts_settings_update_grant');
  assert.equal(spec.choice, 'sql114-stakeholder-settings-update-grant');
  assert.equal(sha(TEXT), pin.source_sha256);
  // Pending: no staging read-live yet, so no pre-state, no approval, execute false.
  assertStagingPinState(assert, KEY, pin);
  assert.equal(pin.execute, false);
  assert.equal(pin.authorization, 'pending');
  assert.equal(pin.expected_live_definition_sha256, null);
  assert.equal(releaseIntendedHash(KEY, TEXT), pin.intended_replacement_sha256);
  assert.equal(pin.intended_replacement_sha256, '809eba9b7f5d40b984f4f37562dfe5419ec2de50de103fc2699048eea5bf6c46');
  assert.equal(pin.superseded_intended_sha256, undefined);
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql114-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], []);
  assert.deepEqual(spec.predecessors, []);
  assert.equal(spec.runs_before, undefined);
  assert.equal(spec.supersedes, undefined);
  assert.equal(spec.refuse_after, undefined);
  // Nothing in the release refuses after SQL 114, supersedes it or needs it.
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes(KEY)
    || (RELEASE_SQL_SPECS[key].refuse_after || []).some((m) => m.key === KEY)
    || (RELEASE_SQL_SPECS[key].predecessors || []).includes(KEY)), []);
  // SQL 92 (the same kind of column grant on check_files) is unchanged.
  assert.equal(PINS.sql92.intended_replacement_sha256, releaseIntendedHash('sql92', fs.readFileSync(path.join(ROOT, PINS.sql92.filename), 'utf8')));
  const prod = productionPin();
  assert.equal(prod.intended_replacement_sha256, pin.intended_replacement_sha256);
  assert.equal(prod.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(prod.staging_pin_commit, pin.commit);
  assert.equal(prod.source_sha256, pin.source_sha256);
  assert.deepEqual(prod.predecessors, []);
  assert.equal(prod.execute, false);
  assert.equal(prod.expected_live_definition_sha256, null);
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

test('reviewed file and spec: one guarded block over six columns; the fingerprint is each column ACL; held lines pass; another grant on a column refuses', () => {
  assert.equal(releaseSqlExecutableText(KEY, TEXT), TEXT);
  assert.deepEqual(releaseFunctionDefinitions(TEXT), {});
  const code = TEXT.replace(/--[^\n]*/g, '');
  const statements = code.replace(/\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, '$$body$$').split(';').map((s) => s.trim()).filter(Boolean);
  assert.deepEqual(statements, ['DO $body$']);
  // The six columns, checked then granted in one column-scoped GRANT template; the two grantees.
  const list = SETTINGS_COLUMNS.join(', ');
  assert.match(code, new RegExp(`ARRAY\\[${SETTINGS_COLUMNS.map((c) => `'${c}'`).join(', ')}\\]`));
  assert.deepEqual([...code.matchAll(/'(GRANT[^']*)'/g)].map((m) => m[1]), [`GRANT UPDATE (${list}) ON TABLE public.stakeholder_accounts TO %I`]);
  assert.match(code, /ARRAY\['checksops', 'authenticated'\]/);
  for (const forbidden of [/\bREVOKE\b/i, /\bPUBLIC\b/, /\banon\b/, /ROW LEVEL SECURITY/i, /\bPOLICY\b/i, /\bCREATE\b/i, /\bDROP\b/i, /\bALTER\b/i, /\bTRUNCATE\b/i, /\bINSERT\b/, /\bDELETE\b/, /GRANT UPDATE ON/i]) {
    assert.doesNotMatch(code, forbidden, String(forbidden));
  }
  assert.match(TEXT, /NOT APPLIED\. Apply only through the guarded SQL path/);
  assert.match(TEXT, /aws_write_stakeholder_accounts/);
  assert.match(TEXT, /02_grant_readonly_application_role\.sql/);
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.functions, []);
  assert.equal(spec.table_privileges, undefined);
  assert.deepEqual(spec.column_acl.map((c) => [c.table, c.column, [...c.acl], c.revokes]), SETTINGS_COLUMNS.map((c) => [STAKEHOLDERS, c, [...BOTH], undefined]));
  assert.deepEqual(spec.altered_relations, [STAKEHOLDERS]);
  assert.deepEqual(spec.prerequisites, [STAKEHOLDERS, ...SETTINGS_COLUMNS.map((c) => `column ${colKey(c)}`), 'role checksops', 'role authenticated']);
  assert.equal(spec.render, undefined);
  assert.equal(spec.whole_tables, undefined);
  const intended = releaseIntendedState(KEY, TEXT);
  assert.deepEqual(intended.columns, Object.fromEntries(SETTINGS_COLUMNS.map((c) => [colKey(c), { exists: true, acl: [...BOTH] }])));
  assert.equal(releaseStateText(KEY, intended), ['release sql114 v1', ...SETTINGS_COLUMNS.map((c) => `column ${colKey(c)} acl: ${BOTH.join(';')}`)].join('\n'));
  assert.equal(releaseStateText(KEY, {}), ['release sql114 v1', ...SETTINGS_COLUMNS.map((c) => `column ${colKey(c)}: absent`)].join('\n'));
  // Unrelated snapshot: only the six columns are skipped; the table's own ACL stays in it.
  const scope = releaseUnrelatedScope(KEY);
  assert.deepEqual(scope.skip_columns, SETTINGS_COLUMNS.map(colKey));
  assert.deepEqual(scope.acl_relations, []);
  for (const field of ['skip_relations', 'skip_constraints', 'skip_policies', 'skip_functions', 'skip_triggers', 'skip_views', 'skip_indexes', 'skip_not_null_columns']) {
    assert.deepEqual(scope[field], [], field);
  }
  // Pre-conditions: any subset of the pinned lines passes; another grant on a column refuses;
  // a missing column refuses; the table must be owned by the login.
  const cols = (aclOf) => Object.fromEntries(SETTINGS_COLUMNS.map((c) => [colKey(c), { exists: true, type: 'x', notnull: false, default: null, acl: aclOf(c) }]));
  const base = { prerequisites_missing: [], predecessors_applied: true, successors_applied: [], dropped_function_callers: [], altered: { [STAKEHOLDERS]: { exists: true, owner_is_login: true } } };
  const pre = (over = {}) => releaseSharedPreconditionFailures(KEY, { ...base, ...over }, TEXT);
  for (const held of [() => [], () => ['checksops UPDATE'], (c) => (c === 'is_active' ? [...BOTH] : []), () => [...BOTH]]) {
    assert.deepEqual(pre({ columns: cols(held) }), [], String(held));
  }
  assert.deepEqual(pre({ columns: cols((c) => (c === 'account_type' ? ['service_role UPDATE'] : [])) }), ['column_acl_replaceable']);
  assert.deepEqual(pre({ columns: cols((c) => (c === 'updated_at' ? ['checksops UPDATE with grant option'] : [])) }), ['column_acl_replaceable']);
  assert.deepEqual(pre({ columns: { ...cols(() => []), [colKey('homeowner_email')]: { exists: false } } }), ['column_acl_replaceable']);
  assert.deepEqual(pre({ columns: cols(() => []), altered: { [STAKEHOLDERS]: { exists: true, owner_is_login: false } } }), ['altered_relations_owned_by_login']);
  assert.deepEqual(pre({ columns: cols(() => []), prerequisites_missing: [`column ${colKey('homeowner_name')}`] }), ['prerequisites_present']);
  // All pinned lines held: live == intended, so the tools see it as already in place.
  const live = (aclOf) => ({ columns: Object.fromEntries(SETTINGS_COLUMNS.map((c) => [colKey(c), { exists: true, acl: aclOf(c) }])) });
  assert.equal(releaseStateHash(KEY, live(() => [...BOTH])), PINS[KEY].intended_replacement_sha256);
  assert.notEqual(releaseStateHash(KEY, live(() => [])), PINS[KEY].intended_replacement_sha256);
  // One line short (no authenticated UPDATE on homeowner_email) is another state.
  assert.notEqual(releaseStateHash(KEY, live((c) => (c === 'homeowner_email' ? ['checksops UPDATE'] : [...BOTH]))), PINS[KEY].intended_replacement_sha256);
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
  const fx = await releaseFixture(pg, prefix, port, { extra: [STAKEHOLDER_SETTINGS_SCHEMA] });
  try {
    await fn(fx);
  } finally {
    await fx.close();
  }
}

test('PostgreSQL 16: SQL 114 through the executor: drift refused, one apply on the intended fingerprint keeps the table ACL, then refused as in place', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql114-exec-', 59214, async ({ admin, connectAs }) => {
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
  /** The table ACL (owner excluded) and every column's ACL. */
  const acls = async () => ({
    table: (await admin.query(`SELECT pg_catalog.pg_get_userbyid(a.grantee) || ' ' || a.privilege_type AS line
      FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
      WHERE c.oid = $1::regclass AND a.grantee <> c.relowner ORDER BY 1`, [STAKEHOLDERS])).rows.map((r) => r.line),
    columns: Object.fromEntries((await admin.query(`SELECT a.attname AS name,
      ARRAY(SELECT pg_catalog.pg_get_userbyid(x.grantee) || ' ' || x.privilege_type FROM pg_catalog.aclexplode(a.attacl) x ORDER BY 1)::text[] AS acl
      FROM pg_catalog.pg_attribute a WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, [STAKEHOLDERS])).rows.map((r) => [r.name, r.acl])),
  });

  const r = await inspect();
  assert.deepEqual(r.precondition_failures, [], JSON.stringify(r.release_sql_inspect));
  assert.deepEqual(r.release_sql_inspect.predecessors, {});
  assert.equal(r.already_applied, false);
  const before = await acls();
  assert.deepEqual(before.table, ['authenticated SELECT', 'checksops SELECT']);
  assert.ok(Object.values(before.columns).every((acl) => acl.length === 0));
  // A pending pin cannot apply.
  const pending = await handlerFor(connect)(releaseEvent({ expected_live_definition_sha256: r.live_definition_sha256 }));
  assert.equal(pending.ok, false);
  // Drift between the recorded pre-state and the apply refuses.
  await admin.query(`GRANT UPDATE (is_active) ON TABLE ${STAKEHOLDERS} TO checksops`);
  assert.equal((await apply(r.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
  await admin.query(`REVOKE UPDATE (is_active) ON TABLE ${STAKEHOLDERS} FROM checksops`);

  const applied = await apply(r.live_definition_sha256);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.before_hash, r.live_definition_sha256);
  assert.equal(applied.details.receipt.after_hash, PINS[KEY].intended_replacement_sha256);
  const after = await inspect();
  assert.equal(after.already_applied, true);
  assert.deepEqual(after.precondition_failures, []);
  // Exactly the six columns gained the two lines; the table ACL and every other column are unchanged.
  const now = await acls();
  assert.deepEqual(now.table, before.table);
  for (const [name, acl] of Object.entries(now.columns)) {
    assert.deepEqual(acl, SETTINGS_COLUMNS.includes(name) ? [...BOTH] : before.columns[name], name);
  }
  assert.equal((await apply(r.live_definition_sha256)).code, CODES.UNRELATED_MUTATION);
}));
