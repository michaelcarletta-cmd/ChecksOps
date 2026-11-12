/**
 * SQL 158 (aws/workflows/sql/158_homeowner_intro_requests_select_grant.sql) in the staging guarded executor, on the
 * release engine shared with SQL 90-156 (scripts/deployment-guard/lib/release-sql-state.mjs). Owner 2026-11-12, option
 * (a), "A now": checksops table SELECT on homeowner_intro_requests, so a contractor's Leads list loads (production
 * 2026-11-10: "permission denied for table homeowner_intro_requests").
 * release-sql90-97-executor.test.mjs runs what every release key shares (SQL 158 included); this file covers what is new:
 *
 *   - the pin: pending, code-derived, selectable, packed, in step with the pending production pin; the pinned commit
 *     authored the bytes; no predecessor, supersedes nothing;
 *   - the file and spec: one table grant (checksops SELECT), nothing else; no other release migration pins grants on
 *     the table; the absent and intended states derived;
 *   - on PostgreSQL 16 (the release fixture plus the table, its real SELECT policy and production's grants): the
 *     absent state read back as derived; a pending pin and drift cannot apply; one apply through the executor reaches
 *     the intended fingerprint, service_role's grant unchanged, then is refused as already in place; a re-run of the
 *     bytes keeps the fingerprint; a table that already holds the grant (staging) reads as already applied.
 * The behavior is aws/tests/sql158-homeowner-intro-requests-select-grant-pg.test.mjs.
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
  AUTHORIZED_SQL158_HOMEOWNER_INTRO_REQUESTS_SELECT_GRANT,
  AUTHORIZED_STAGING_SQL,
  RELEASE_2026_10_17_PENDING_SQL_PINS as PINS,
  authorizationFingerprint,
  resolveAuthorizedMigration,
} from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import {
  RELEASE_SQL_KEYS,
  RELEASE_SQL_SPECS,
  RELEASE_STAGING_SQL_KEYS,
  releaseIntendedHash,
  releaseIntendedState,
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
import { TABLE, homeownerIntroSchema } from './helpers/sql158-homeowner-intro-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-11-12T12:00:00.000Z';
const KEY = 'sql158';
const sha = (text) => createHash('sha256').update(text).digest('hex');
const TEXT = fs.readFileSync(path.join(ROOT, PINS[KEY].filename), 'utf8');
/** The table missing (the file refuses it: sql158_table_missing). */
const ABSENT = releaseStateHash(KEY, {});
/** The table present, checksops without SELECT on it: production's pre-state. */
const NO_GRANT = releaseStateHash(KEY, { privileges: { [TABLE]: { exists: true, lines: [] } } });
const FILES = Object.freeze(Object.fromEntries(RELEASE_SQL_KEYS.map((key) => [key, path.join(ROOT, PINS[key].filename)])));
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK|BEGIN READ ONLY)\b/i;
const productionPin = () => JSON.parse(fs.readFileSync(path.join(ROOT, RELEASE_SQL_SPECS[KEY].production_pin_rel), 'utf8'));

const { module: executorModule } = await importGuardedSqlExecutor();
const { createHandler } = executorModule;

function releaseEvent(overrides = {}) {
  const key = overrides.key || KEY;
  const pin = overrides.pin || PINS[key];
  const rest = { ...overrides };
  delete rest.pin;
  delete rest.key;
  const event = {
    action: 'apply',
    workstream_id: `staging-${RELEASE_SQL_SPECS[key].choice}`,
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
    one_use_id: `${key}-test-${process.pid}-${Math.random().toString(16).slice(2)}`,
    expiry: '2026-11-12T13:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    ...rest,
  };
  event.preflight_live_fingerprint = authorizationFingerprint(event);
  return event;
}
const inspectEvent = (key = KEY) => releaseEvent({ key, action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL });

function handlerFor(connect, { pins = {} } = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql158-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

test('pin: SQL 158 pending, code-derived, selectable, packed, in step with the pending production pin; no predecessor', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL158_HOMEOWNER_INTRO_REQUESTS_SELECT_GRANT, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/158_homeowner_intro_requests_select_grant.sql');
  assert.equal(pin.migration_id, '158_homeowner_intro_requests_select_grant');
  assert.equal(spec.choice, 'sql158-homeowner-intro-requests-select-grant');
  assert.doesNotMatch(spec.choice, /production/);
  assert.equal(sha(TEXT), pin.source_sha256);
  // Pending until a reviewed pin change records a staging read-live.
  assertStagingPinState(assert, KEY, pin);
  assert.equal(pin.execute, false);
  assert.equal(pin.authorization, 'pending');
  assert.equal(pin.expected_live_definition_sha256, null);
  assert.equal(releaseIntendedHash(KEY, TEXT), pin.intended_replacement_sha256);
  assert.notEqual(ABSENT, pin.intended_replacement_sha256);
  assert.notEqual(NO_GRANT, pin.intended_replacement_sha256);
  assert.ok(RELEASE_STAGING_SQL_KEYS.includes(KEY));
  // The runbook names the absent and intended states (derived here), the intended fingerprint and the source.
  const runbook = fs.readFileSync(path.join(ROOT, 'ops/production-sql-158-apply.md'), 'utf8');
  for (const value of [NO_GRANT, ABSENT, pin.intended_replacement_sha256, pin.source_sha256]) assert.ok(runbook.includes(value), value);
  assert.ok(runbook.includes(`\`\`\`\n${releaseStateText(KEY, { privileges: { [TABLE]: { exists: true, lines: [] } } })}\n\`\`\``));
  assert.ok(runbook.includes(`\`\`\`\n${releaseStateText(KEY, releaseIntendedState(KEY, TEXT))}\n\`\`\``));
  assert.ok(runbook.includes(`\`\`\`\n${releaseStateText(KEY, {})}\n\`\`\``));
  assert.match(runbook, /\*\*Status:\*\* tooling built; staging and production pins pending \(`execute: false`\)\. Nothing applied or read\./);
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql158-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], []);
  assert.deepEqual(spec.functions, []);
  assert.deepEqual(spec.predecessors, []);
  for (const absent of ['supersedes', 'runs_before', 'refuse_after', 'production_only', 'production_noop']) assert.equal(spec[absent], undefined, absent);
  // Nothing supersedes, refuses after or depends on SQL 158, and no other release migration pins grants on the table.
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes(KEY)
    || (RELEASE_SQL_SPECS[key].refuse_after || []).some((m) => m.key === KEY)
    || (RELEASE_SQL_SPECS[key].predecessors || []).includes(KEY)), []);
  for (const key of RELEASE_SQL_KEYS.filter((k) => k !== KEY)) {
    const other = RELEASE_SQL_SPECS[key];
    assert.ok(!(other.table_privileges || []).some((p) => p.table === TABLE), key);
    assert.ok(!(other.altered_relations || []).includes(TABLE), key);
  }
  const prod = productionPin();
  assert.equal(prod.migration, KEY);
  assert.equal(prod.intended_replacement_sha256, pin.intended_replacement_sha256);
  assert.equal(prod.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(prod.staging_pin_commit, pin.commit);
  assert.equal(prod.source_sha256, pin.source_sha256);
  assert.deepEqual(prod.function_identities, []);
  assert.deepEqual(prod.predecessors, []);
  assert.equal(prod.execute, false);
  assert.equal(prod.authorization, 'pending');
  assert.equal(prod.authorization_phrase, 'GRANT_HOMEOWNER_INTRO_REQUESTS_SELECT');
  assert.equal(prod.expected_live_definition_sha256, null);
  assert.equal(prod.production_inspect.status, 'pending');
  assert.equal(prod.staging_acceptance.ok, false);
  assert.ok(prod.production_inspect.note.includes(NO_GRANT));
  assert.ok(prod.order_note.includes(NO_GRANT));
  assert.ok(prod.order_note.includes(ABSENT));
  assert.ok(prod.intended_post_state.note.includes(pin.intended_replacement_sha256));
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

test('reviewed file and spec: one table grant, checksops SELECT on homeowner_intro_requests; no other object', () => {
  assert.equal(releaseSqlExecutableText(KEY, TEXT), TEXT);
  // The statements: the fail-closed precondition block and one GRANT; no write grant, revoke, policy or RLS change.
  assert.match(TEXT, /\nGRANT SELECT ON TABLE public\.homeowner_intro_requests TO checksops;\n$/);
  assert.equal((TEXT.match(/^GRANT /gm) || []).length, 1);
  for (const forbidden of [/^REVOKE /m, /^ALTER /m, /^CREATE /m, /^DROP /m, /GRANT\s+(INSERT|UPDATE|DELETE|TRUNCATE|ALL)/i, /\bPOLICY\b/, /ROW LEVEL SECURITY/i]) {
    assert.doesNotMatch(TEXT, forbidden, String(forbidden));
  }
  assert.match(TEXT, /sql158_table_missing/);
  assert.match(TEXT, /sql158_role_missing/);
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.prerequisites, [TABLE, 'role checksops']);
  assert.deepEqual(spec.table_privileges, [{ table: TABLE, grantees: ['checksops'], privileges: ['SELECT'], intended: ['checksops SELECT'] }]);
  assert.deepEqual(spec.altered_relations, [TABLE]);
  for (const kind of ['tables', 'policies', 'column_acl', 'acl_functions', 'dropped_functions', 'views', 'indexes', 'added_columns', 'constraints', 'triggers', 'definer_writes']) {
    assert.equal(spec[kind], undefined, kind);
  }
  assert.deepEqual(releaseUnrelatedScope(KEY).acl_relations, [TABLE]);
  assert.equal(releaseStateText(KEY, releaseIntendedState(KEY, TEXT)), ['release sql158 v1', `privileges ${TABLE} SELECT: checksops SELECT`].join('\n'));
  assert.equal(releaseStateText(KEY, {}), ['release sql158 v1', `privileges ${TABLE}: absent`].join('\n'));
  assert.equal(releaseStateText(KEY, { privileges: { [TABLE]: { exists: true, lines: [] } } }), ['release sql158 v1', `privileges ${TABLE} SELECT: `].join('\n'));
});

test('PostgreSQL 16: SQL 158 through the executor: the absent state as derived, a pending pin and drift cannot apply, one apply on the intended fingerprint with the other grant unchanged, then already in place', { timeout: 600000 }, async (t) => {
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
  const fx = await releaseFixture(pg, 'pg-sql158-exec-', 59158, { extra: [homeownerIntroSchema()] });
  const { admin, connectAs } = fx;
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
    const asOwner = async (text) => {
      const owner = await connectAs('checksops_admin');
      try { await owner.query(text); } finally { await owner.end(); }
    };
    const tableAcl = async () => (await admin.query(`SELECT pg_catalog.pg_get_userbyid(a.grantee) || ' ' || a.privilege_type AS line
      FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
      WHERE c.oid = $1::regclass AND a.grantee <> c.relowner ORDER BY 1`, [TABLE])).rows.map((r) => r.line);

    // checksops without SELECT: the derived state.
    assert.deepEqual(await tableAcl(), ['service_role SELECT']);
    const r = await inspect();
    assert.deepEqual(r.precondition_failures, [], JSON.stringify(r.release_sql_inspect));
    assert.deepEqual(r.release_sql_inspect.prerequisites_missing, []);
    assert.equal(r.already_applied, false);
    assert.equal(r.live_definition_sha256, NO_GRANT);
    // A pending pin cannot apply.
    const pendingCopy = Object.freeze({ ...pendingPin(PINS[KEY]), expected_live_definition_sha256: NO_GRANT });
    assert.equal((await handlerFor(connect, { pins: { [KEY]: pendingCopy } })(releaseEvent({ pin: pendingCopy }))).ok, false);
    // Drift between the recorded pre-state and the apply refuses.
    assert.equal((await apply('f'.repeat(64))).code, CODES.DEPLOYMENT_COLLISION);

    const applied = await apply(NO_GRANT);
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.before_hash, NO_GRANT);
    assert.equal(applied.details.receipt.after_hash, PINS[KEY].intended_replacement_sha256);
    const after = await inspect();
    assert.equal(after.already_applied, true);
    assert.deepEqual(after.precondition_failures, []);
    assert.equal(after.live_definition_sha256, PINS[KEY].intended_replacement_sha256);
    // Exactly checksops SELECT added; service_role's grant as it was.
    assert.deepEqual(await tableAcl(), ['checksops SELECT', 'service_role SELECT']);
    // A second apply: refused, the database already past the pinned pre-state.
    assert.notEqual((await apply(NO_GRANT)).ok, true);
    // Re-running the reviewed bytes is a no-op on the fingerprint (idempotent).
    await asOwner(TEXT);
    assert.equal((await inspect()).live_definition_sha256, PINS[KEY].intended_replacement_sha256);
    assert.deepEqual(await tableAcl(), ['checksops SELECT', 'service_role SELECT']);
  } finally {
    await fx.close();
  }
});
