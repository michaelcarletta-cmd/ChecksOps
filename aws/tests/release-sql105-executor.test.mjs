/**
 * SQL 105 (aws/workflows/sql/105_onboarding_payment_table_grants.sql) in the staging guarded
 * executor, on the release engine shared with SQL 90-104 (scripts/deployment-guard/lib/release-sql-state.mjs).
 * release-sql90-97-executor.test.mjs runs what every release key shares (SQL 105 included); this
 * file covers what is new:
 *
 *   - the pin: staging-authorized from its read-live (wave 8), code-derived, selectable, packed,
 *     in step with the production pin; the pinned commit authored the bytes; after SQL 91;
 *   - the spec's four table_privileges entries (SQL 105 creates or replaces no function): the
 *     fingerprint is the SELECT / INSERT / UPDATE lines of checksops and authenticated on
 *     payment_provider_accounts, payment_provider_methods and payment_method_verifications and
 *     their SELECT / INSERT lines on payment_event_log; any subset of them already held passes
 *     the pre-conditions (GRANT is a no-op), and every other grant on each table must stay as
 *     it was;
 *   - the file: one guarded DO block looping the four tables and the two grantees, nothing else;
 *   - on PostgreSQL 16 (the tables with the grants the supabase migrations left: authenticated's
 *     and service_role's, none for checksops): refused before SQL 91; one apply through the
 *     executor reaches the intended fingerprint and keeps the other grants, then is refused as
 *     already in place.
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
  AUTHORIZED_SQL105_ONBOARDING_PAYMENT_TABLE_GRANTS,
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
const NOW = '2026-10-20T12:00:00.000Z';
const KEY = 'sql105';
const ACCOUNTS = 'public.payment_provider_accounts';
const METHODS = 'public.payment_provider_methods';
const VERIFICATIONS = 'public.payment_method_verifications';
const EVENT_LOG = 'public.payment_event_log';
const TABLES = Object.freeze([ACCOUNTS, METHODS, VERIFICATIONS, EVENT_LOG]);
const ALL_SIX = Object.freeze(['authenticated INSERT', 'authenticated SELECT', 'authenticated UPDATE', 'checksops INSERT', 'checksops SELECT', 'checksops UPDATE']);
const ALL_FOUR = Object.freeze(['authenticated INSERT', 'authenticated SELECT', 'checksops INSERT', 'checksops SELECT']);
/** The pinned lines per table (spec intended). */
const PINNED = Object.freeze({ [ACCOUNTS]: ALL_SIX, [METHODS]: ALL_SIX, [VERIFICATIONS]: ALL_SIX, [EVENT_LOG]: ALL_FOUR });
const sha = (text) => createHash('sha256').update(text).digest('hex');
const TEXT = fs.readFileSync(path.join(ROOT, PINS[KEY].filename), 'utf8');
const SQL91_TEXT = fs.readFileSync(path.join(ROOT, PINS.sql91.filename), 'utf8');
const FILES = Object.freeze(Object.fromEntries(RELEASE_SQL_KEYS.map((key) => [key, path.join(ROOT, PINS[key].filename)])));
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK|BEGIN READ ONLY)\b/i;
const productionPin = () => JSON.parse(fs.readFileSync(path.join(ROOT, RELEASE_SQL_SPECS[KEY].production_pin_rel), 'utf8'));

/**
 * The four tables as the supabase migrations left them: authenticated holds its original grants
 * (SELECT, INSERT, UPDATE, DELETE on the accounts and methods tables; SELECT, INSERT, UPDATE on
 * the verifications; SELECT only on the event log), service_role holds ALL, checksops holds
 * nothing directly (run as the superuser, before ownership).
 */
const SUPABASE_ERA_GRANTS = `
DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
REVOKE ALL ON TABLE ${TABLES.join(', ')} FROM checksops, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${ACCOUNTS}, ${METHODS} TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE ${VERIFICATIONS} TO authenticated;
GRANT SELECT ON TABLE ${EVENT_LOG} TO authenticated;
GRANT ALL ON TABLE ${TABLES.join(', ')} TO service_role;`;

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
    expiry: '2026-10-20T13:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    ...rest,
  };
  event.preflight_live_fingerprint = authorizationFingerprint(event);
  return event;
}
const inspectEvent = () => releaseEvent({ action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL });

function handlerFor(connect, { pins = {} } = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql105-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

test('pin: SQL 105 staging-authorized from its read-live, code-derived, selectable, packed, in step with the production pin; after SQL 91', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL105_ONBOARDING_PAYMENT_TABLE_GRANTS, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/105_onboarding_payment_table_grants.sql');
  assert.equal(pin.migration_id, '105_onboarding_payment_table_grants');
  assert.equal(spec.choice, 'sql105-onboarding-payment-table-grants');
  assert.equal(sha(TEXT), pin.source_sha256);
  // Staging apply authorized (owner approved 2026-10-20) from staging read-live run 39429083380:
  // checksops INSERT was missing on three of the four tables, so SQL 105 was not yet applied there.
  assertStagingPinState(assert, KEY, pin);
  assert.equal(pin.execute, true);
  assert.equal(pin.authorization, 'Owner approved 2026-10-20: staging apply (wave 8) from staging read-live run 39429083380');
  assert.equal(pin.expected_live_definition_sha256, 'fbbdae18762d3d8e2cbd43c070720cf5b04ef6344b5a956ee0fb1c3b4c1fc27a');
  assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
  assert.equal(releaseIntendedHash(KEY, TEXT), pin.intended_replacement_sha256);
  assert.equal(pin.intended_replacement_sha256, 'a67bc0a6faa4cf60500946c4a1a980180cec9ff44980a6cf9b5f05846e7e7127');
  assert.equal(pin.superseded_intended_sha256, undefined);
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql105-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], []);
  assert.deepEqual(spec.predecessors, ['sql91']);
  assert.equal(spec.runs_before, undefined);
  assert.equal(spec.supersedes, undefined);
  assert.equal(spec.refuse_after, undefined);
  // Nothing in the release refuses after SQL 105, supersedes it or needs it.
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes(KEY)
    || (RELEASE_SQL_SPECS[key].refuse_after || []).some((m) => m.key === KEY)
    || (RELEASE_SQL_SPECS[key].predecessors || []).includes(KEY)), []);
  // SQL 91 stays as applied: its file, pin and fingerprint are unchanged by SQL 105.
  assert.equal(PINS.sql91.source_sha256, '199bfa1a528d219a8683b61ae6264d84dd5b08caa74564691374c8c6c42b71e3');
  assert.equal(releaseIntendedHash('sql91', SQL91_TEXT), PINS.sql91.intended_replacement_sha256);
  assert.equal(PINS.sql91.intended_replacement_sha256, 'f8611dcca3397f684a247de454c8737074b3d2fb03c52e28fba665d0f297967d');
  // SQL 104 (the same gap on payment_idempotency_keys) is unchanged too.
  assert.equal(PINS.sql104.intended_replacement_sha256, 'e5b35104ca9c3f68fd03298354c5d6e1e48218f0871a3f216539999931a291a6');
  const prod = productionPin();
  assert.equal(prod.intended_replacement_sha256, pin.intended_replacement_sha256);
  assert.equal(prod.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(prod.staging_pin_commit, pin.commit);
  assert.equal(prod.source_sha256, pin.source_sha256);
  assert.deepEqual(prod.predecessors, ['sql91']);
  assert.equal(prod.execute, false);
  assert.equal(prod.authorization, 'pending');
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

test('reviewed file and spec: one guarded block over the four tables; the fingerprint is the pinned grant lines per table; held grants pass; other grants must not change', () => {
  assert.equal(releaseSqlExecutableText(KEY, TEXT), TEXT);
  assert.deepEqual(releaseFunctionDefinitions(TEXT), {});
  const code = TEXT.replace(/--[^\n]*/g, '');
  const statements = code.replace(/\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, '$$body$$').split(';').map((s) => s.trim()).filter(Boolean);
  assert.deepEqual(statements, ['DO $body$']);
  // The four tables and their privilege lists, in file order; one GRANT template; the two grantees.
  assert.deepEqual([...code.matchAll(/\('(public\.[a-z_]+)',\s*'([A-Z, ]+)'\)/g)].map((m) => [m[1], m[2]]), [
    [ACCOUNTS, 'SELECT, INSERT, UPDATE'],
    [METHODS, 'SELECT, INSERT, UPDATE'],
    [VERIFICATIONS, 'SELECT, INSERT, UPDATE'],
    [EVENT_LOG, 'SELECT, INSERT'],
  ]);
  assert.deepEqual([...code.matchAll(/'(GRANT[^']*)'/g)].map((m) => m[1]), ['GRANT %s ON TABLE %s TO %I']);
  assert.match(code, /ARRAY\['checksops', 'authenticated'\]/);
  for (const forbidden of [/\bREVOKE\b/i, /\bDELETE\b/i, /\bPUBLIC\b/, /\banon\b/, /ROW LEVEL SECURITY/i, /\bPOLICY\b/i, /\bCREATE\b/i, /\bDROP\b/i, /\bALTER\b/i, /\bTRUNCATE\b/i]) {
    assert.doesNotMatch(code, forbidden, String(forbidden));
  }
  assert.match(TEXT, /NOT APPLIED\. Apply only through the guarded SQL path/);
  assert.match(TEXT, /2026-10-20 12:18:20Z/);
  assert.match(TEXT, /permission denied for table\s+(-- )?payment_provider_accounts/);
  assert.match(TEXT, /SQL 104/);
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.functions, []);
  assert.deepEqual(spec.table_privileges.map((p) => p.table), [...TABLES]);
  for (const p of spec.table_privileges) {
    assert.deepEqual(p.privileges, p.table === EVENT_LOG ? ['SELECT', 'INSERT'] : ['SELECT', 'INSERT', 'UPDATE'], p.table);
    assert.deepEqual([...p.grantees].sort(), ['authenticated', 'checksops'], p.table);
    assert.deepEqual(p.intended, [...PINNED[p.table]], p.table);
    assert.deepEqual(p.intended, [...p.intended].sort(), p.table);
  }
  assert.deepEqual(spec.altered_relations, [...TABLES]);
  assert.deepEqual(spec.prerequisites, [...TABLES, 'role checksops', 'role authenticated']);
  assert.equal(spec.render, undefined);
  const intended = releaseIntendedState(KEY, TEXT);
  assert.deepEqual(intended.privileges, Object.fromEntries(TABLES.map((t) => [t, { exists: true, lines: [...PINNED[t]] }])));
  assert.equal(releaseStateText(KEY, intended), [
    'release sql105 v1',
    `privileges ${ACCOUNTS} SELECT,INSERT,UPDATE: ${ALL_SIX.join(';')}`,
    `privileges ${METHODS} SELECT,INSERT,UPDATE: ${ALL_SIX.join(';')}`,
    `privileges ${VERIFICATIONS} SELECT,INSERT,UPDATE: ${ALL_SIX.join(';')}`,
    `privileges ${EVENT_LOG} SELECT,INSERT: ${ALL_FOUR.join(';')}`,
  ].join('\n'));
  assert.equal(releaseStateText(KEY, {}), ['release sql105 v1', ...TABLES.map((t) => `privileges ${t}: absent`)].join('\n'));
  const scope = releaseUnrelatedScope(KEY);
  assert.deepEqual(scope.acl_relations, [...TABLES]);
  for (const field of ['skip_relations', 'skip_columns', 'skip_constraints', 'skip_policies', 'skip_functions', 'skip_triggers', 'skip_views', 'skip_indexes']) {
    assert.deepEqual(scope[field], [], field);
  }
  // Pre-conditions: no subset of the pinned lines refuses (GRANT of a held privilege is a
  // no-op), nor do other grants; the tables must exist, be owned by the login, and SQL 91 must
  // be in place.
  const owned = (owner_is_login) => Object.fromEntries(TABLES.map((t) => [t, { exists: true, owner_is_login }]));
  const privs = (held, other = ['authenticated DELETE', 'service_role SELECT']) => Object.fromEntries(TABLES.map((t) => [t, { exists: true, lines: held(t), other }]));
  const base = { prerequisites_missing: [], predecessors_applied: true, successors_applied: [], dropped_function_callers: [], altered: owned(true) };
  const pre = (over = {}) => releaseSharedPreconditionFailures(KEY, { ...base, ...over }, TEXT);
  for (const held of [() => [], () => ['checksops SELECT'], (t) => PINNED[t].filter((l) => l.startsWith('authenticated ')), (t) => [...PINNED[t]]]) {
    assert.deepEqual(pre({ privileges: privs(held) }), [], String(held));
  }
  assert.deepEqual(pre({ altered: { ...owned(true), [EVENT_LOG]: { exists: true, owner_is_login: false } } }), ['altered_relations_owned_by_login']);
  assert.deepEqual(pre({ predecessors_applied: false }), ['predecessors_applied']);
  assert.deepEqual(pre({ prerequisites_missing: [EVENT_LOG] }), ['prerequisites_present']);
  // All pinned lines held: live == intended, so the tools see it as already in place.
  assert.equal(releaseStateHash(KEY, { privileges: privs((t) => [...PINNED[t]]) }), PINS[KEY].intended_replacement_sha256);
  // One table short of it is another state.
  assert.notEqual(releaseStateHash(KEY, { privileges: { ...privs((t) => [...PINNED[t]]), [EVENT_LOG]: { exists: true, lines: ['authenticated SELECT', 'checksops SELECT'] } } }), PINS[KEY].intended_replacement_sha256);
  // Post-conditions: the intended fingerprint, and every other grant on each table unchanged.
  const pin = PINS[KEY];
  const st = (otherOf) => ({ live_definition_sha256: pin.intended_replacement_sha256, privileges: Object.fromEntries(TABLES.map((t) => [t, { exists: true, lines: [...PINNED[t]], other: otherOf(t) }])) });
  const before = st((t) => (t === EVENT_LOG ? ['service_role DELETE', 'service_role SELECT'] : ['authenticated DELETE', 'service_role DELETE', 'service_role SELECT']));
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, before, st((t) => [...before.privileges[t].other]), pin), []);
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, before, st((t) => (t === EVENT_LOG ? ['checksops DELETE', ...before.privileges[t].other] : before.privileges[t].other)), pin), ['other_table_privileges_unchanged']);
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, before, st((t) => (t === ACCOUNTS ? before.privileges[t].other.filter((l) => l !== 'authenticated DELETE') : before.privileges[t].other)), pin), ['other_table_privileges_unchanged']);
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, before, { ...st((t) => [...before.privileges[t].other]), live_definition_sha256: 'f'.repeat(64) }, pin), ['intended_state']);
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
  const fx = await releaseFixture(pg, prefix, port, { extra: [SUPABASE_ERA_GRANTS] });
  try {
    await fn(fx);
  } finally {
    await fx.close();
  }
}

test('PostgreSQL 16: SQL 105 through the executor: refused before SQL 91, drift refused, one apply on the intended fingerprint keeps the other grants', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql105-exec-', 59210, async ({ admin, connectAs }) => {
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
  /** Every table's ACL lines (grantee privilege), the owner excluded. */
  const acls = async () => Object.fromEntries(await Promise.all(TABLES.map(async (table) => [table, (await admin.query(`SELECT pg_catalog.pg_get_userbyid(a.grantee) || ' ' || a.privilege_type AS line
    FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
    WHERE c.oid = $1::regclass AND a.grantee <> c.relowner ORDER BY 1`, [table])).rows.map((r) => r.line)])));

  // Before SQL 91: the predecessor is missing, so SQL 105 refuses.
  const early = await inspect();
  assert.deepEqual(early.release_sql_inspect.predecessors, { sql91: false });
  assert.ok(early.precondition_failures.includes('predecessors_applied'));
  assert.equal((await apply(early.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
  const owner = await connectAs('checksops_admin');
  try {
    await owner.query(SQL91_TEXT);
  } finally {
    await owner.end();
  }

  const r = await inspect();
  assert.deepEqual(r.precondition_failures, [], JSON.stringify(r.release_sql_inspect));
  assert.deepEqual(r.release_sql_inspect.predecessors, { sql91: true });
  assert.equal(r.already_applied, false);
  const before = await acls();
  for (const table of TABLES) {
    assert.ok(before[table].includes('service_role SELECT'), table);
    assert.deepEqual(before[table].filter((line) => line.startsWith('checksops ')), [], table);
  }
  assert.ok(before[ACCOUNTS].includes('authenticated DELETE'));
  assert.deepEqual(before[EVENT_LOG].filter((line) => line.startsWith('authenticated ')), ['authenticated SELECT']);
  // A pending pin cannot apply.
  const pending = await handlerFor(connect)(releaseEvent({ expected_live_definition_sha256: r.live_definition_sha256 }));
  assert.equal(pending.ok, false);
  // Drift between the recorded pre-state and the apply refuses.
  await admin.query(`GRANT SELECT ON TABLE ${ACCOUNTS} TO checksops`);
  assert.equal((await apply(r.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
  await admin.query(`REVOKE SELECT ON TABLE ${ACCOUNTS} FROM checksops`);

  const applied = await apply(r.live_definition_sha256);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.before_hash, r.live_definition_sha256);
  assert.equal(applied.details.receipt.after_hash, PINS[KEY].intended_replacement_sha256);
  const after = await inspect();
  assert.equal(after.already_applied, true);
  assert.deepEqual(after.precondition_failures, []);
  // Exactly the pinned lines were added; nothing else on any table changed.
  const now = await acls();
  for (const table of TABLES) assert.deepEqual(now[table], [...new Set([...before[table], ...PINNED[table]])].sort(), table);
  assert.equal((await apply(r.live_definition_sha256)).code, CODES.UNRELATED_MUTATION);
  // SQL 91 is still in place (at its own intended fingerprint), unchanged by SQL 105.
  assert.deepEqual(after.release_sql_inspect.predecessors, { sql91: true });
}));
