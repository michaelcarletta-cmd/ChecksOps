/**
 * SQL 106 (aws/workflows/sql/106_financial_stepup_log_append_only.sql) in the staging guarded
 * executor, on the release engine shared with SQL 90-105 (scripts/deployment-guard/lib/release-sql-state.mjs).
 * release-sql90-97-executor.test.mjs runs what every release key shares (SQL 106 included); this
 * file covers what is new:
 *
 *   - the pin: pending, code-derived, selectable, packed, in step with the production pin (which is
 *     execute-authorized on owner-accepted substitute staging evidence); the
 *     pinned commit authored the bytes; no predecessor, runs before SQL 97 (whose file, pins and
 *     fingerprints are unchanged);
 *   - the spec's one table_privileges entry (SQL 106 creates or replaces no function): the
 *     fingerprint is the UPDATE / DELETE / TRUNCATE lines of PUBLIC, anon, authenticated and
 *     checksops on financial_stepup_log, which must be none; any held subset passes the
 *     pre-conditions (REVOKE of a privilege not held is a no-op), and every other grant on the
 *     table must stay as it was;
 *   - the file: one guarded DO block revoking those three privileges from PUBLIC and the three
 *     roles, nothing else;
 *   - on PostgreSQL 16, staging order (SQL 97 already applied, then write grants on the table for
 *     checksops, authenticated, anon and PUBLIC, and service_role ALL): one apply through the
 *     executor reaches the intended fingerprint, removes exactly those lines and keeps every
 *     other grant; SQL 97 stays at its own intended fingerprint; a re-apply is refused.
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
  AUTHORIZED_SQL106_FINANCIAL_STEPUP_LOG_APPEND_ONLY,
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

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-10-21T12:00:00.000Z';
const KEY = 'sql106';
const TABLE = 'public.financial_stepup_log';
const GRANTEES = Object.freeze(['PUBLIC', 'anon', 'authenticated', 'checksops']);
const WRITES = Object.freeze(['UPDATE', 'DELETE', 'TRUNCATE']);
const sha = (text) => createHash('sha256').update(text).digest('hex');
const TEXT = fs.readFileSync(path.join(ROOT, PINS[KEY].filename), 'utf8');
const SQL97_TEXT = fs.readFileSync(path.join(ROOT, PINS.sql97.filename), 'utf8');
const FILES = Object.freeze(Object.fromEntries(RELEASE_SQL_KEYS.map((key) => [key, path.join(ROOT, PINS[key].filename)])));
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK|BEGIN READ ONLY)\b/i;
const productionPin = (key = KEY) => JSON.parse(fs.readFileSync(path.join(ROOT, RELEASE_SQL_SPECS[key].production_pin_rel), 'utf8'));
/** Whether an ACL line ("grantee PRIVILEGE[ with grant option]") is one SQL 106 revokes. */
const revoked = (line) => GRANTEES.includes(line.split(' ')[0]) && WRITES.includes(line.split(' ')[1]);

/**
 * Write grants on the step-up log beyond production's (production held checksops UPDATE and
 * DELETE, SQL 97's inspect of 2026-10-21): every role SQL 106 names holds some, checksops with
 * grant option on UPDATE, and service_role ALL (which SQL 106 must leave). Run as the superuser,
 * before ownership.
 */
const WRITE_GRANTS = `
DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT INSERT, DELETE ON TABLE ${TABLE} TO checksops;
GRANT UPDATE ON TABLE ${TABLE} TO checksops WITH GRANT OPTION;
GRANT UPDATE, DELETE, TRUNCATE ON TABLE ${TABLE} TO authenticated;
GRANT SELECT, UPDATE ON TABLE ${TABLE} TO anon;
GRANT DELETE ON TABLE ${TABLE} TO PUBLIC;
GRANT ALL ON TABLE ${TABLE} TO service_role;`;

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
    expiry: '2026-10-21T13:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    ...rest,
  };
  event.preflight_live_fingerprint = authorizationFingerprint(event);
  return event;
}
const inspectEvent = () => releaseEvent({ action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL });

function handlerFor(connect, { pins = {} } = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql106-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

test('pin: SQL 106 pending in staging (the production pin applied and retired), code-derived, selectable, packed, in step with the production pin; no predecessor, before SQL 97', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL106_FINANCIAL_STEPUP_LOG_APPEND_ONLY, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/106_financial_stepup_log_append_only.sql');
  assert.equal(pin.migration_id, '106_financial_stepup_log_append_only');
  assert.equal(spec.choice, 'sql106-financial-stepup-log-append-only');
  assert.equal(sha(TEXT), pin.source_sha256);
  // Pending: no staging read-live recorded yet (and no apply authorized).
  assertStagingPinState(assert, KEY, pin);
  assert.equal(pin.execute, false);
  assert.equal(pin.authorization, 'pending');
  assert.equal(pin.expected_live_definition_sha256, null);
  assert.equal(releaseIntendedHash(KEY, TEXT), pin.intended_replacement_sha256);
  assert.equal(pin.intended_replacement_sha256, '0a159961b80a1887b551d7bc9f187811f62614ef352c00b12bbfe621f109088f');
  assert.equal(pin.superseded_intended_sha256, undefined);
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql106-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], []);
  assert.deepEqual(spec.predecessors, []);
  assert.deepEqual(spec.runs_before, ['sql97']);
  assert.equal(spec.supersedes, undefined);
  assert.equal(spec.refuse_after, undefined);
  // Nothing in the release refuses after SQL 106, supersedes it or lists it as a predecessor.
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes(KEY)
    || (RELEASE_SQL_SPECS[key].refuse_after || []).some((m) => m.key === KEY)
    || (RELEASE_SQL_SPECS[key].predecessors || []).includes(KEY)), []);
  // SQL 97 is unchanged by SQL 106: its file, pins and fingerprint, and its spec (no predecessor;
  // its table_privileges entry covers INSERT only, so the two fingerprints never overlap).
  assert.equal(PINS.sql97.source_sha256, 'e3c8fd413f1d60030dd65192bb8696387229a4fd33fc2ae234cd61e52fbb79db');
  assert.equal(sha(SQL97_TEXT), PINS.sql97.source_sha256);
  assert.equal(releaseIntendedHash('sql97', SQL97_TEXT), PINS.sql97.intended_replacement_sha256);
  assert.equal(PINS.sql97.intended_replacement_sha256, '5d9b50f5c71da4ca06810c229a67ff1dfd3839ecba83ba4e1829da15eb28edef');
  assert.deepEqual(RELEASE_SQL_SPECS.sql97.predecessors, []);
  assert.deepEqual(RELEASE_SQL_SPECS.sql97.table_privileges.map((p) => [p.table, p.privileges]), [[TABLE, ['INSERT']]]);
  const prod97 = productionPin('sql97');
  assert.equal(prod97.expected_live_definition_sha256, '56b1f63192df1147fbbdd0206226129aeea35467d13c8bf0c8bc399316d06079');
  assert.equal(prod97.intended_replacement_sha256, PINS.sql97.intended_replacement_sha256);
  assert.deepEqual(prod97.predecessors, []);
  const prod = productionPin();
  assert.equal(prod.intended_replacement_sha256, pin.intended_replacement_sha256);
  assert.equal(prod.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(prod.staging_pin_commit, pin.commit);
  assert.equal(prod.source_sha256, pin.source_sha256);
  assert.deepEqual(prod.predecessors, []);
  // Production pin applied 2026-10-21 and retired (owner approved #1120, substitute staging
  // evidence: SQL 106 was already in effect in staging); production's pre-state (checksops DELETE and
  // UPDATE) differs from staging's.
  assert.equal(prod.execute, false);
  assert.match(prod.authorization, /^Applied to production on 2026-10-21; execute is false again/);
  assert.equal(prod.applied.receipt.after_hash, pin.intended_replacement_sha256);
  assert.equal(prod.expected_live_definition_sha256, '56b5e4bb1a2db3133c32c9cc3cca02c1e7fb876839544dbdfd0717aad8f25880');
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

test('reviewed file and spec: one guarded block revoking UPDATE / DELETE / TRUNCATE; the fingerprint is those lines (none); held lines pass; other grants must not change', () => {
  assert.equal(releaseSqlExecutableText(KEY, TEXT), TEXT);
  assert.deepEqual(releaseFunctionDefinitions(TEXT), {});
  const code = TEXT.replace(/--[^\n]*/g, '');
  const statements = code.replace(/\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, '$$body$$').split(';').map((s) => s.trim()).filter(Boolean);
  assert.deepEqual(statements, ['DO $body$']);
  // Exactly two REVOKE templates (PUBLIC, then each named role), the same three privileges, one table.
  assert.deepEqual([...code.matchAll(/'(REVOKE[^']*)'/g)].map((m) => m[1]), [
    'REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.financial_stepup_log FROM PUBLIC',
    'REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.financial_stepup_log FROM %I',
  ]);
  assert.match(code, /ARRAY\['checksops', 'authenticated', 'anon'\]/);
  for (const forbidden of [/\bGRANT\b/i, /\bSELECT\b(?! 1 FROM pg_roles)/, /\bINSERT\b/i, /service_role/, /ROW LEVEL SECURITY/i, /\bPOLICY\b/i, /\bCREATE\b/i, /\bDROP\b/i, /\bALTER\b/i, /\bTRIGGER\b/i, /\bCASCADE\b/i, /\bBEGIN\s*;/i, /\bCOMMIT\b/i]) {
    assert.doesNotMatch(code, forbidden, String(forbidden));
  }
  assert.match(TEXT, /NOT APPLIED\. Apply only through the guarded SQL path/);
  assert.match(TEXT, /16bcba87-7ad4-48b1-a63b-a2de20d25eee/);
  assert.match(TEXT, /SQL 97/);
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.functions, []);
  assert.deepEqual(spec.table_privileges, [{ table: TABLE, grantees: [...GRANTEES], privileges: [...WRITES], intended: [] }]);
  assert.deepEqual(spec.altered_relations, [TABLE]);
  assert.deepEqual(spec.prerequisites, [TABLE, 'role checksops', 'role authenticated']);
  assert.equal(spec.render, undefined);
  const intended = releaseIntendedState(KEY, TEXT);
  assert.deepEqual(intended.privileges, { [TABLE]: { exists: true, lines: [] } });
  assert.equal(releaseStateText(KEY, intended), ['release sql106 v1', `privileges ${TABLE} UPDATE,DELETE,TRUNCATE: `].join('\n'));
  assert.equal(releaseStateText(KEY, {}), ['release sql106 v1', `privileges ${TABLE}: absent`].join('\n'));
  const scope = releaseUnrelatedScope(KEY);
  assert.deepEqual(scope.acl_relations, [TABLE]);
  for (const field of ['skip_relations', 'skip_columns', 'skip_constraints', 'skip_policies', 'skip_functions', 'skip_triggers', 'skip_views', 'skip_indexes']) {
    assert.deepEqual(scope[field], [], field);
  }
  // Pre-conditions: any held subset of the revoked lines passes, as do other grants; the table
  // must exist and be owned by the login. No predecessor.
  const owned = (owner_is_login) => ({ [TABLE]: { exists: true, owner_is_login } });
  const privs = (lines, other = ['authenticated INSERT', 'authenticated SELECT', 'checksops INSERT', 'checksops SELECT', 'service_role UPDATE']) => ({ [TABLE]: { exists: true, lines, other } });
  const base = { prerequisites_missing: [], predecessors_applied: true, successors_applied: [], dropped_function_callers: [], altered: owned(true) };
  const pre = (over = {}) => releaseSharedPreconditionFailures(KEY, { ...base, ...over }, TEXT);
  for (const lines of [[], ['checksops DELETE', 'checksops UPDATE'], ['PUBLIC DELETE', 'anon UPDATE', 'authenticated TRUNCATE', 'checksops UPDATE with grant option']]) {
    assert.deepEqual(pre({ privileges: privs(lines) }), [], String(lines));
  }
  assert.deepEqual(pre({ altered: owned(false) }), ['altered_relations_owned_by_login']);
  assert.deepEqual(pre({ prerequisites_missing: [TABLE] }), ['prerequisites_present']);
  // None held: live == intended, so the tools see it as already in place.
  assert.equal(releaseStateHash(KEY, { privileges: privs([]) }), PINS[KEY].intended_replacement_sha256);
  // Production's pre-state (SQL 97's inspect of 2026-10-21: checksops DELETE and UPDATE) is another state.
  assert.notEqual(releaseStateHash(KEY, { privileges: privs(['checksops DELETE', 'checksops UPDATE']) }), PINS[KEY].intended_replacement_sha256);
  // The spec reads exactly the lines the file revokes; SELECT, INSERT and service_role's are "other".
  assert.equal(revoked('checksops UPDATE'), true);
  assert.equal(revoked('checksops UPDATE with grant option'), true);
  assert.equal(revoked('checksops INSERT'), false);
  assert.equal(revoked('service_role UPDATE'), false);
  // Post-conditions: the intended fingerprint, and every other grant on the table unchanged.
  const pin = PINS[KEY];
  const st = (other) => ({ live_definition_sha256: pin.intended_replacement_sha256, privileges: { [TABLE]: { exists: true, lines: [], other } } });
  const before = st(['authenticated INSERT', 'authenticated SELECT', 'checksops INSERT', 'checksops SELECT', 'service_role DELETE', 'service_role UPDATE']);
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, before, st([...before.privileges[TABLE].other]), pin), []);
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, before, st(before.privileges[TABLE].other.filter((l) => l !== 'checksops INSERT')), pin), ['other_table_privileges_unchanged']);
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, before, st(before.privileges[TABLE].other.filter((l) => l !== 'service_role UPDATE')), pin), ['other_table_privileges_unchanged']);
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, before, { ...st([...before.privileges[TABLE].other]), live_definition_sha256: 'f'.repeat(64) }, pin), ['intended_state']);
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
  const fx = await releaseFixture(pg, prefix, port, { extra: [WRITE_GRANTS] });
  try {
    await fn(fx);
  } finally {
    await fx.close();
  }
}

test('PostgreSQL 16: SQL 106 through the executor after SQL 97 (staging order): drift refused, one apply revokes exactly the write lines, keeps every other grant and SQL 97', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql106-exec-', 60220, async ({ admin, connectAs }) => {
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
  /** The table's ACL lines (grantee privilege[ with grant option]), the owner excluded. */
  const acl = async () => (await admin.query(`SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END
      || ' ' || a.privilege_type || CASE WHEN a.is_grantable THEN ' with grant option' ELSE '' END AS line
    FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
    WHERE c.oid = $1::regclass AND a.grantee <> c.relowner ORDER BY 1`, [TABLE])).rows.map((r) => r.line);
  const sql97Hash = async () => {
    const result = await handlerFor(connect)(releaseEvent({ pin: PINS.sql97, action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL, workstream_id: 'staging-sql97-financial-stepup-log-server-writer' }));
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.details.receipt;
  };

  // Staging order: SQL 97 is already applied (wave 4) before SQL 106.
  const owner = await connectAs('checksops_admin');
  try {
    await owner.query(SQL97_TEXT);
  } finally {
    await owner.end();
  }
  const s97 = await sql97Hash();
  assert.equal(s97.live_definition_sha256, PINS.sql97.intended_replacement_sha256);
  assert.ok(s97.release_sql_inspect.table_privileges[0].other_write_grants.length > 0);

  const r = await inspect();
  assert.deepEqual(r.precondition_failures, [], JSON.stringify(r.release_sql_inspect));
  assert.deepEqual(r.release_sql_inspect.predecessors, {});
  assert.equal(r.already_applied, false);
  assert.deepEqual(r.release_sql_inspect.table_privileges[0].lines, ['PUBLIC DELETE', 'anon UPDATE', 'authenticated DELETE', 'authenticated TRUNCATE', 'authenticated UPDATE', 'checksops DELETE', 'checksops UPDATE with grant option']);
  const before = await acl();
  assert.ok(before.includes('service_role UPDATE'));
  // A pending pin cannot apply.
  const pending = await handlerFor(connect)(releaseEvent({ expected_live_definition_sha256: r.live_definition_sha256 }));
  assert.equal(pending.ok, false);
  // Drift between the recorded pre-state and the apply refuses.
  await admin.query(`GRANT TRUNCATE ON TABLE ${TABLE} TO checksops`);
  assert.equal((await apply(r.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
  await admin.query(`REVOKE TRUNCATE ON TABLE ${TABLE} FROM checksops`);

  const applied = await apply(r.live_definition_sha256);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.before_hash, r.live_definition_sha256);
  assert.equal(applied.details.receipt.after_hash, PINS[KEY].intended_replacement_sha256);
  const after = await inspect();
  assert.equal(after.already_applied, true);
  assert.deepEqual(after.precondition_failures, []);
  assert.deepEqual(after.release_sql_inspect.table_privileges[0].lines, []);
  // Exactly the revoked lines went; nothing else on the table changed (service_role's ALL stays).
  const now = await acl();
  assert.deepEqual(now, before.filter((line) => !revoked(line)));
  assert.ok(now.includes('service_role UPDATE') && now.includes('service_role TRUNCATE'));
  assert.ok(now.includes('checksops INSERT') && now.includes('checksops SELECT') && now.includes('anon SELECT'));
  assert.equal((await apply(r.live_definition_sha256)).code, CODES.UNRELATED_MUTATION);
  // SQL 97 is still at its own intended fingerprint; its inspect now lists only service_role's writes.
  const s97After = await sql97Hash();
  assert.equal(s97After.live_definition_sha256, PINS.sql97.intended_replacement_sha256);
  assert.deepEqual(s97After.release_sql_inspect.table_privileges[0].other_write_grants, ['service_role DELETE', 'service_role TRUNCATE', 'service_role UPDATE']);
}));
