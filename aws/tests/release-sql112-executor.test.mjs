/**
 * SQL 112 (aws/workflows/sql/112_moov_invoice_table_grants.sql) in the staging guarded
 * executor, on the release engine shared with SQL 90-111 (scripts/deployment-guard/lib/release-sql-state.mjs).
 * release-sql90-97-executor.test.mjs runs what every release key shares (SQL 112 included); this
 * file covers what is new:
 *
 *   - the pin: staging-authorized from its read-live (wave 13), code-derived, selectable, packed,
 *     in step with the production pin (execute-authorized on the staging apply); the pinned
 *     commit authored the bytes; no predecessor;
 *   - the spec's two table_privileges entries (SQL 112 creates or replaces no function): the
 *     fingerprint is the SELECT / INSERT / UPDATE / DELETE lines of checksops and authenticated
 *     on moov_invoices and their SELECT / INSERT lines on moov_invoice_customers; any subset of
 *     them already held passes the pre-conditions (GRANT is a no-op), all of them held is
 *     already in place, and every other grant on each table must stay as it was;
 *   - the file: one guarded DO block looping the two tables and the two grantees, nothing else;
 *   - on PostgreSQL 16 (the tables with the grants the supabase migration left: authenticated's
 *     and service_role's, none for checksops): one apply through the executor reaches the
 *     intended fingerprint and keeps the other grants, then is refused as already in place.
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
  AUTHORIZED_SQL112_MOOV_INVOICE_TABLE_GRANTS,
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
import { MOOV_INVOICE_TABLES, SUPABASE_ERA_INVOICE_GRANTS } from './helpers/sql112-invoice-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-10-23T12:00:00.000Z';
const KEY = 'sql112';
const INVOICES = 'public.moov_invoices';
const CUSTOMERS = 'public.moov_invoice_customers';
const TABLES = Object.freeze([INVOICES, CUSTOMERS]);
const ALL_EIGHT = Object.freeze(['authenticated DELETE', 'authenticated INSERT', 'authenticated SELECT', 'authenticated UPDATE', 'checksops DELETE', 'checksops INSERT', 'checksops SELECT', 'checksops UPDATE']);
const ALL_FOUR = Object.freeze(['authenticated INSERT', 'authenticated SELECT', 'checksops INSERT', 'checksops SELECT']);
/** The pinned lines per table (spec intended). */
const PINNED = Object.freeze({ [INVOICES]: ALL_EIGHT, [CUSTOMERS]: ALL_FOUR });
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
    expiry: '2026-10-23T13:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    ...rest,
  };
  event.preflight_live_fingerprint = authorizationFingerprint(event);
  return event;
}
const inspectEvent = () => releaseEvent({ action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL });

function handlerFor(connect, { pins = {} } = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql112-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

test('pin: SQL 112 staging-authorized from its read-live, code-derived, selectable, packed, in step with the production pin; no predecessor', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL112_MOOV_INVOICE_TABLE_GRANTS, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/112_moov_invoice_table_grants.sql');
  assert.equal(pin.migration_id, '112_moov_invoice_table_grants');
  assert.equal(spec.choice, 'sql112-moov-invoice-table-grants');
  assert.equal(sha(TEXT), pin.source_sha256);
  // Staging apply authorized (owner approved 2026-10-23) from staging read-live run 39963348904:
  // checksops held SELECT only on both tables, so SQL 112 was not yet applied there.
  assertStagingPinState(assert, KEY, pin);
  assert.equal(pin.execute, true);
  assert.equal(pin.authorization, 'Owner approved 2026-10-23: staging apply (wave 13) from staging read-live run 39963348904');
  assert.equal(pin.expected_live_definition_sha256, 'c606d5eda318a2336d5885b3675339ee98aed761c3aa620a7ced759b3c5eeb89');
  assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
  assert.equal(releaseIntendedHash(KEY, TEXT), pin.intended_replacement_sha256);
  assert.equal(pin.intended_replacement_sha256, '7caba5ba4a322d54a3c55ca712966da58cf4358c0db81f95c142dabfc916f315');
  assert.equal(pin.superseded_intended_sha256, undefined);
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql112-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], []);
  assert.deepEqual(spec.predecessors, []);
  assert.equal(spec.runs_before, undefined);
  assert.equal(spec.supersedes, undefined);
  assert.equal(spec.refuse_after, undefined);
  // Nothing in the release refuses after SQL 112, supersedes it or needs it.
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes(KEY)
    || (RELEASE_SQL_SPECS[key].refuse_after || []).some((m) => m.key === KEY)
    || (RELEASE_SQL_SPECS[key].predecessors || []).includes(KEY)), []);
  // SQL 105 (the same kind of grant on the onboarding payment tables) is unchanged.
  assert.equal(PINS.sql105.intended_replacement_sha256, 'a67bc0a6faa4cf60500946c4a1a980180cec9ff44980a6cf9b5f05846e7e7127');
  const prod = productionPin();
  assert.equal(prod.intended_replacement_sha256, pin.intended_replacement_sha256);
  assert.equal(prod.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(prod.staging_pin_commit, pin.commit);
  assert.equal(prod.source_sha256, pin.source_sha256);
  assert.deepEqual(prod.predecessors, []);
  // Production pin execute-authorized (owner-approved pin change of 2026-10-23) on the staging apply;
  // production's pre-state differs from staging's (checksops already held every line there).
  assert.equal(prod.execute, true);
  assert.match(prod.authorization, /^Owner approved 2026-10-23 /);
  assert.equal(prod.expected_live_definition_sha256, 'a61983121c4739f38084c66c6aaafcb67968b008526ff0c69459713280292acd');
  assert.notEqual(prod.expected_live_definition_sha256, pin.expected_live_definition_sha256);
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

test('reviewed file and spec: one guarded block over the two tables; the fingerprint is the pinned grant lines per table; held grants pass; other grants must not change', () => {
  assert.equal(releaseSqlExecutableText(KEY, TEXT), TEXT);
  assert.deepEqual(releaseFunctionDefinitions(TEXT), {});
  const code = TEXT.replace(/--[^\n]*/g, '');
  const statements = code.replace(/\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, '$$body$$').split(';').map((s) => s.trim()).filter(Boolean);
  assert.deepEqual(statements, ['DO $body$']);
  // The two tables and their privilege lists, in file order; one GRANT template; the two grantees.
  assert.deepEqual([...code.matchAll(/\('(public\.[a-z_]+)',\s*'([A-Z, ]+)'\)/g)].map((m) => [m[1], m[2]]), [
    [INVOICES, 'SELECT, INSERT, UPDATE, DELETE'],
    [CUSTOMERS, 'SELECT, INSERT'],
  ]);
  assert.deepEqual([...code.matchAll(/'(GRANT[^']*)'/g)].map((m) => m[1]), ['GRANT %s ON TABLE %s TO %I']);
  assert.match(code, /ARRAY\['checksops', 'authenticated'\]/);
  // DELETE appears only in moov_invoices' privilege list (the handler deletes a draft).
  assert.equal((code.match(/\bDELETE\b/g) || []).length, 1);
  for (const forbidden of [/\bREVOKE\b/i, /\bPUBLIC\b/, /\banon\b/, /ROW LEVEL SECURITY/i, /\bPOLICY\b/i, /\bCREATE\b/i, /\bDROP\b/i, /\bALTER\b/i, /\bTRUNCATE\b/i]) {
    assert.doesNotMatch(code, forbidden, String(forbidden));
  }
  assert.match(TEXT, /NOT APPLIED\. Apply only through the guarded SQL path/);
  assert.match(TEXT, /20260819015105/);
  assert.match(TEXT, /SQL 105/);
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.functions, []);
  assert.deepEqual(spec.table_privileges.map((p) => p.table), [...TABLES]);
  for (const p of spec.table_privileges) {
    assert.deepEqual(p.privileges, p.table === INVOICES ? ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] : ['SELECT', 'INSERT'], p.table);
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
    'release sql112 v1',
    `privileges ${INVOICES} SELECT,INSERT,UPDATE,DELETE: ${ALL_EIGHT.join(';')}`,
    `privileges ${CUSTOMERS} SELECT,INSERT: ${ALL_FOUR.join(';')}`,
  ].join('\n'));
  assert.equal(releaseStateText(KEY, {}), ['release sql112 v1', ...TABLES.map((t) => `privileges ${t}: absent`)].join('\n'));
  const scope = releaseUnrelatedScope(KEY);
  assert.deepEqual(scope.acl_relations, [...TABLES]);
  for (const field of ['skip_relations', 'skip_columns', 'skip_constraints', 'skip_policies', 'skip_functions', 'skip_triggers', 'skip_views', 'skip_indexes']) {
    assert.deepEqual(scope[field], [], field);
  }
  // Pre-conditions: no subset of the pinned lines refuses (GRANT of a held privilege is a
  // no-op), nor do other grants; the tables must exist and be owned by the login.
  const owned = (owner_is_login) => Object.fromEntries(TABLES.map((t) => [t, { exists: true, owner_is_login }]));
  const privs = (held, other = ['authenticated UPDATE', 'service_role SELECT']) => Object.fromEntries(TABLES.map((t) => [t, { exists: true, lines: held(t), other }]));
  const base = { prerequisites_missing: [], predecessors_applied: true, successors_applied: [], dropped_function_callers: [], altered: owned(true) };
  const pre = (over = {}) => releaseSharedPreconditionFailures(KEY, { ...base, ...over }, TEXT);
  for (const held of [() => [], () => ['checksops SELECT'], (t) => PINNED[t].filter((l) => l.startsWith('authenticated ')), (t) => [...PINNED[t]]]) {
    assert.deepEqual(pre({ privileges: privs(held) }), [], String(held));
  }
  assert.deepEqual(pre({ altered: { ...owned(true), [CUSTOMERS]: { exists: true, owner_is_login: false } } }), ['altered_relations_owned_by_login']);
  assert.deepEqual(pre({ prerequisites_missing: [CUSTOMERS] }), ['prerequisites_present']);
  // All pinned lines held: live == intended, so the tools see it as already in place.
  assert.equal(releaseStateHash(KEY, { privileges: privs((t) => [...PINNED[t]]) }), PINS[KEY].intended_replacement_sha256);
  // Only what the supabase migration granted (authenticated's lines, no checksops): another state.
  assert.notEqual(releaseStateHash(KEY, { privileges: privs((t) => PINNED[t].filter((l) => l.startsWith('authenticated '))) }), PINS[KEY].intended_replacement_sha256);
  // One line short of it (no checksops DELETE on moov_invoices) is another state.
  assert.notEqual(releaseStateHash(KEY, { privileges: { ...privs((t) => [...PINNED[t]]), [INVOICES]: { exists: true, lines: ALL_EIGHT.filter((l) => l !== 'checksops DELETE') } } }), PINS[KEY].intended_replacement_sha256);
  // Post-conditions: the intended fingerprint, and every other grant on each table unchanged.
  const pin = PINS[KEY];
  const st = (otherOf) => ({ live_definition_sha256: pin.intended_replacement_sha256, privileges: Object.fromEntries(TABLES.map((t) => [t, { exists: true, lines: [...PINNED[t]], other: otherOf(t) }])) });
  const before = st((t) => (t === CUSTOMERS ? ['authenticated DELETE', 'authenticated UPDATE', 'service_role DELETE', 'service_role SELECT'] : ['service_role DELETE', 'service_role SELECT']));
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, before, st((t) => [...before.privileges[t].other]), pin), []);
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, before, st((t) => (t === CUSTOMERS ? ['checksops DELETE', ...before.privileges[t].other] : before.privileges[t].other)), pin), ['other_table_privileges_unchanged']);
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, before, st((t) => (t === CUSTOMERS ? before.privileges[t].other.filter((l) => l !== 'authenticated DELETE') : before.privileges[t].other)), pin), ['other_table_privileges_unchanged']);
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
  const fx = await releaseFixture(pg, prefix, port, { extra: [MOOV_INVOICE_TABLES, SUPABASE_ERA_INVOICE_GRANTS] });
  try {
    await fn(fx);
  } finally {
    await fx.close();
  }
}

test('PostgreSQL 16: SQL 112 through the executor: drift refused, one apply on the intended fingerprint keeps the other grants, then refused as in place', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql112-exec-', 59212, async ({ admin, connectAs }) => {
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

  const r = await inspect();
  assert.deepEqual(r.precondition_failures, [], JSON.stringify(r.release_sql_inspect));
  assert.deepEqual(r.release_sql_inspect.predecessors, {});
  assert.equal(r.already_applied, false);
  const before = await acls();
  for (const table of TABLES) {
    assert.ok(before[table].includes('service_role SELECT'), table);
    assert.deepEqual(before[table].filter((line) => line.startsWith('checksops ')), [], table);
    assert.deepEqual(before[table].filter((line) => line.startsWith('authenticated ')), ['authenticated DELETE', 'authenticated INSERT', 'authenticated SELECT', 'authenticated UPDATE'], table);
  }
  // A pending pin cannot apply (the committed pin is staging-authorized, so pend a copy).
  const pendingCopy = pendingPin(PINS[KEY]);
  const pending = await handlerFor(connect, { pins: { [KEY]: pendingCopy } })(releaseEvent({ pin: pendingCopy, expected_live_definition_sha256: r.live_definition_sha256 }));
  assert.equal(pending.ok, false);
  // Drift between the recorded pre-state and the apply refuses.
  await admin.query(`GRANT SELECT ON TABLE ${INVOICES} TO checksops`);
  assert.equal((await apply(r.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
  await admin.query(`REVOKE SELECT ON TABLE ${INVOICES} FROM checksops`);

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
  assert.ok(now[CUSTOMERS].includes('authenticated DELETE') && !now[CUSTOMERS].includes('checksops DELETE'));
  assert.equal((await apply(r.live_definition_sha256)).code, CODES.UNRELATED_MUTATION);
}));
