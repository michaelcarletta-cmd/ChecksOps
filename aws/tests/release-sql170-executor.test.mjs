/**
 * SQL 170 (aws/workflows/sql/170_device_push_tokens.sql) in the staging guarded executor, on the release engine shared
 * with SQL 90-169 (scripts/deployment-guard/lib/release-sql-state.mjs). Owner 2026-11-19: app notifications when
 * signatures are received, funds are disbursed or received, the wallet changes, or a message arrives; the app side
 * (PR 2016) sends the phone's push token to the API, and this file is where the API keeps it.
 * release-sql90-97-executor.test.mjs runs what every release key shares (SQL 170 included); this file covers what is new:
 *
 *   - the pin: pending, code-derived, selectable, packed, in step with the pending production pin; the pinned commit
 *     authored the bytes; no predecessor, supersedes nothing; nothing names it;
 *   - the file and spec: one table (device_push_tokens: RLS on, no policy, no grant; SQL 118's revoke block for it) and
 *     two SECURITY DEFINER functions (search_path public, row_security off, EXECUTE checksops and the owner); no other
 *     release migration touches them; the absent and intended states derived;
 *   - on PostgreSQL 16 with default privileges granting new tables to checksops and authenticated: the absent state
 *     read back as derived; a pending pin and drift cannot apply; one apply through the executor reaches the intended
 *     fingerprint with no grant left on the new table, then is refused as already in place; a drifted function grant
 *     or table grant is not intended; a re-run of the bytes keeps the fingerprint.
 * The behavior is aws/tests/sql170-device-push-tokens-pg.test.mjs.
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
  AUTHORIZED_SQL170_DEVICE_PUSH_TOKENS,
  AUTHORIZED_STAGING_SQL,
  RELEASE_2026_10_17_PENDING_SQL_PINS as PINS,
  authorizationFingerprint,
  resolveAuthorizedMigration,
} from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import {
  RELEASE_SQL_KEYS,
  RELEASE_SQL_SPECS,
  RELEASE_STAGING_SQL_KEYS,
  releaseFunctionDefinitions,
  releaseIntendedHash,
  releaseIntendedState,
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
const NOW = '2026-11-19T12:00:00.000Z';
const KEY = 'sql170';
const TABLE = 'public.device_push_tokens';
const ACL = ['checksops EXECUTE', 'owner EXECUTE'];
const RESULTS = Object.freeze({
  'public.aws_push_register_device(text, text)': 'uuid',
  'public.aws_push_unregister_device(text)': 'boolean',
});
const FNS = Object.keys(RESULTS);
const sha = (text) => createHash('sha256').update(text).digest('hex');
const TEXT = fs.readFileSync(path.join(ROOT, PINS[KEY].filename), 'utf8');
/** Everything SQL 170 creates absent: the pre-state both databases are expected to have. */
const ABSENT = releaseStateHash(KEY, {});
const FILES = Object.freeze(Object.fromEntries(RELEASE_SQL_KEYS.map((key) => [key, path.join(ROOT, PINS[key].filename)])));
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK|BEGIN READ ONLY)\b/i;
const productionPin = () => JSON.parse(fs.readFileSync(path.join(ROOT, RELEASE_SQL_SPECS[KEY].production_pin_rel), 'utf8'));

// Default privileges that grant new tables to checksops and authenticated (the case that rolled SQL 117 back in
// staging): the file must leave no grant on its table.
const EXTRA = ['ALTER DEFAULT PRIVILEGES FOR ROLE checksops_admin IN SCHEMA public GRANT ALL ON TABLES TO checksops, authenticated;'];

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
    expiry: '2026-11-19T13:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    ...rest,
  };
  event.preflight_live_fingerprint = authorizationFingerprint(event);
  return event;
}
const inspectEvent = () => releaseEvent({ action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL });

function handlerFor(connect, { pins = {} } = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql170-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

test('pin: SQL 170 pending, code-derived, selectable, packed, in step with the pending production pin; no predecessor', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL170_DEVICE_PUSH_TOKENS, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/170_device_push_tokens.sql');
  assert.equal(pin.migration_id, '170_device_push_tokens');
  assert.equal(spec.choice, 'sql170-device-push-tokens');
  assert.doesNotMatch(spec.choice, /production/);
  assert.equal(sha(TEXT), pin.source_sha256);
  // Pending until a reviewed pin change records a staging read-live.
  assertStagingPinState(assert, KEY, pin);
  assert.equal(pin.execute, false);
  assert.equal(pin.authorization, 'pending');
  assert.equal(pin.expected_live_definition_sha256, null);
  assert.equal(releaseIntendedHash(KEY, TEXT), pin.intended_replacement_sha256);
  assert.notEqual(ABSENT, pin.intended_replacement_sha256);
  assert.ok(RELEASE_STAGING_SQL_KEYS.includes(KEY));
  // The runbook names the absent and intended states (derived here), the intended fingerprint and the source.
  const runbook = fs.readFileSync(path.join(ROOT, 'ops/production-sql-170-apply.md'), 'utf8');
  for (const value of [ABSENT, pin.intended_replacement_sha256, pin.source_sha256]) assert.ok(runbook.includes(value), value);
  assert.ok(runbook.includes(`\`\`\`\n${releaseStateText(KEY, releaseIntendedState(KEY, TEXT))}\n\`\`\``));
  assert.ok(runbook.includes(`\`\`\`\n${releaseStateText(KEY, {})}\n\`\`\``));
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql170-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], FNS);
  assert.deepEqual(spec.functions.map((fn) => fn.identity), FNS);
  assert.deepEqual(spec.predecessors, []);
  for (const absent of ['supersedes', 'runs_before', 'refuse_after', 'production_only']) assert.equal(spec[absent], undefined, absent);
  // Nothing supersedes, refuses after or depends on SQL 170, and no other release migration names its table or functions.
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes(KEY)
    || (RELEASE_SQL_SPECS[key].refuse_after || []).some((m) => m.key === KEY)
    || (RELEASE_SQL_SPECS[key].predecessors || []).includes(KEY)), []);
  for (const key of RELEASE_SQL_KEYS.filter((k) => k !== KEY)) {
    const other = RELEASE_SQL_SPECS[key];
    assert.ok(!(other.tables || []).some((t) => t.name === TABLE), `${key} ${TABLE}`);
    for (const fn of FNS) assert.ok(!(other.functions || []).some((f) => f.identity === fn), `${key} ${fn}`);
  }
  const prod = productionPin();
  assert.equal(prod.migration, KEY);
  assert.equal(prod.intended_replacement_sha256, pin.intended_replacement_sha256);
  assert.equal(prod.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(prod.staging_pin_commit, pin.commit);
  assert.equal(prod.source_sha256, pin.source_sha256);
  assert.deepEqual(prod.function_identities, FNS);
  assert.deepEqual(prod.predecessors, []);
  assert.equal(prod.execute, false);
  assert.equal(prod.authorization, 'pending');
  assert.equal(prod.authorization_phrase, 'REGISTER_PHONES_FOR_PUSH_NOTIFICATIONS');
  assert.equal(prod.expected_live_definition_sha256, null);
  assert.equal(prod.production_inspect.status, 'pending');
  assert.equal(prod.staging_acceptance.ok, false);
  assert.ok(prod.production_inspect.note.includes(ABSENT));
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

test('reviewed file and spec: one table with no grant (SQL 118\'s revoke block), two SECURITY DEFINER functions with their ACLs; no other object', () => {
  assert.equal(releaseSqlExecutableText(KEY, TEXT), TEXT);
  const defs = releaseFunctionDefinitions(TEXT);
  assert.deepEqual(Object.keys(defs).sort(), ['aws_push_register_device', 'aws_push_unregister_device']);
  for (const name of Object.keys(defs)) {
    assert.equal(defs[name].security_definer, true, name);
    assert.equal(defs[name].language, 'plpgsql', name);
    assert.equal(defs[name].volatility, 'v', name);
    assert.deepEqual([...defs[name].config].sort(), ['row_security=off', 'search_path=public'], name);
  }
  assert.equal(defs.aws_push_register_device.result, 'uuid');
  assert.equal(defs.aws_push_unregister_device.result, 'boolean');
  // The revoke block is SQL 118's (as SQL 158's), for this table.
  const revoke = /DO \$sql170_table_acl\$[\s\S]*?\$sql170_table_acl\$;\n/;
  assert.match(TEXT, revoke);
  const sql118 = fs.readFileSync(path.join(ROOT, 'aws/workflows/sql/118_platform_owner_tenant_lifecycle.sql'), 'utf8');
  const block118 = sql118.match(/DO \$sql118_table_acl\$[\s\S]*?\$sql118_table_acl\$;\n/)[0];
  assert.equal(TEXT.match(revoke)[0], block118.replace(/sql118/g, 'sql170').replace(/tenant_deactivations/g, 'device_push_tokens'));
  for (const code55000 of ['sql170_prerequisite_missing', 'sql170_unexpected_table']) {
    assert.match(TEXT, new RegExp(`RAISE EXCEPTION '${code55000}`), code55000);
  }
  assert.match(TEXT, /Not applied by this change: staging first, then production, through the\n-- guarded SQL path/);
  const code = TEXT.replace(/--[^\n]*/g, '').replace(/'(?:[^']|'')*'/g, "''");
  for (const forbidden of [/\bPOLICY\b/i, /\bTRIGGER\b/i, /\bFORCE\b/i, /\bDROP\b/i, /\bBEGIN\s*;/i, /\bCOMMIT\b/i, /ADD COLUMN/i, /ALTER COLUMN/i, /\bUPDATE\s+public\.(?!device_push_tokens)/i, /\bINSERT\s+INTO\s+public\.(?!device_push_tokens)/i, /\bDELETE\s+FROM\s+public\.(?!device_push_tokens)/i]) {
    assert.doesNotMatch(code, forbidden, String(forbidden));
  }
  const spec = RELEASE_SQL_SPECS[KEY];
  // Plain results (uuid, boolean): the file's RETURNS clause is the catalog's, so the spec states none.
  assert.deepEqual(spec.functions, FNS.map((identity) => ({ identity, acl: ACL })));
  assert.deepEqual(spec.prerequisites, ['auth.uid()', 'gen_random_uuid()', 'role checksops']);
  for (const name of spec.prerequisites) assert.ok(TEXT.includes(name.replace(/^role /, '')), name);
  assert.deepEqual(spec.tables.map((t) => [t.name, t.rls, t.forced, t.acl]), [[TABLE, true, false, []]]);
  const table = spec.tables[0];
  assert.deepEqual(table.columns, [
    ['id', 'uuid', true, 'gen_random_uuid()'],
    ['user_id', 'uuid', true, null],
    ['platform', 'text', true, null],
    ['token', 'text', true, null],
    ['created_at', 'timestamp with time zone', true, 'now()'],
    ['last_seen_at', 'timestamp with time zone', true, 'now()'],
  ]);
  assert.deepEqual(table.constraints.map(([name]) => name), [
    'device_push_tokens_pkey', 'device_push_tokens_platform', 'device_push_tokens_token_key', 'device_push_tokens_token_shape']);
  assert.deepEqual(table.indexes.map(([name]) => name), ['device_push_tokens_pkey', 'device_push_tokens_token_key', 'device_push_tokens_user_idx']);
  for (const kind of ['policies', 'table_privileges', 'column_acl', 'acl_functions', 'dropped_functions', 'views', 'indexes', 'added_columns', 'constraints', 'triggers', 'altered_relations', 'definer_writes', 'render']) {
    assert.equal(spec[kind], undefined, kind);
  }
  const scope = releaseUnrelatedScope(KEY);
  assert.deepEqual(scope.skip_functions, FNS);
  assert.deepEqual(scope.skip_relations, [TABLE]);
  for (const field of ['acl_relations', 'skip_columns', 'skip_constraints', 'skip_not_null_columns', 'skip_policies', 'skip_triggers', 'skip_views', 'skip_indexes']) {
    assert.deepEqual(scope[field], [], field);
  }
  const intended = releaseIntendedState(KEY, TEXT);
  for (const fn of FNS) {
    assert.equal(intended.functions[fn].result, RESULTS[fn], fn);
    assert.deepEqual(intended.functions[fn].acl, ACL, fn);
  }
  const text = releaseStateText(KEY, intended);
  assert.match(text, /^release sql170 v1\n/);
  assert.match(text, /\ntable public\.device_push_tokens: kind=r rls=true forced=false\n/);
  assert.match(text, /\ntable public\.device_push_tokens policies: \ntable public\.device_push_tokens triggers: \ntable public\.device_push_tokens acl: $/);
  assert.equal(releaseStateText(KEY, {}), ['release sql170 v1', ...FNS.map((fn) => `function ${fn}: absent`), `table ${TABLE}: absent`].join('\n'));
  // Pre-conditions: the prerequisites; a present table only as intended; present functions owned by the login with
  // no EXECUTE grant the file neither keeps nor revokes. No predecessor.
  const base = { prerequisites_missing: [], predecessors_applied: true, successors_applied: [], dropped_function_callers: [] };
  const pre = (over = {}) => releaseSharedPreconditionFailures(KEY, { ...base, ...over }, TEXT);
  assert.deepEqual(pre(), []);
  assert.deepEqual(pre({ prerequisites_missing: ['role checksops'] }), ['prerequisites_present']);
  assert.deepEqual(pre({ tables: { [TABLE]: intended.tables[TABLE] } }), []);
  assert.deepEqual(pre({ tables: { [TABLE]: { ...intended.tables[TABLE], acl: ['authenticated SELECT'] } } }), ['created_tables_absent_or_intended']);
  const fnRow = (over) => ({ functions: { [FNS[0]]: { ...intended.functions[FNS[0]], owner_is_login: true, ...over } } });
  assert.deepEqual(pre(fnRow({})), []);
  assert.deepEqual(pre(fnRow({ owner_is_login: false })), ['functions_owned_by_login']);
  assert.deepEqual(pre(fnRow({ acl: [...ACL, 'authenticated EXECUTE'] })), ['function_acl_replaceable']);
  assert.deepEqual(pre(fnRow({ acl: [...ACL, 'PUBLIC EXECUTE'] })), []);
  assert.deepEqual(pre(fnRow({ result: 'text' })), ['function_results_match']);
});

test('PostgreSQL 16, default privileges on: SQL 170 through the executor: the absent state as derived, a pending pin and drift cannot apply, one apply on the intended fingerprint (no grant on the new table), then already in place; drifted grants are not intended', { timeout: 600000 }, async (t) => {
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
  const fx = await releaseFixture(pg, 'pg-sql170-exec-', 60270, { extra: EXTRA });
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
    const tableGrantees = async () => (await admin.query(`SELECT DISTINCT a.grantee::regrole::text AS g FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
      WHERE c.oid = '${TABLE}'::regclass AND a.grantee <> c.relowner ORDER BY 1`)).rows.map((row) => row.g);

    // The table and both functions absent: the derived state.
    const r = await inspect();
    assert.deepEqual(r.precondition_failures, [], JSON.stringify(r.release_sql_inspect));
    assert.deepEqual(r.release_sql_inspect.prerequisites_missing, []);
    assert.equal(r.already_applied, false);
    assert.equal(r.live_definition_sha256, ABSENT);
    // A pending pin cannot apply (the committed pin is pending).
    assert.equal(r.pin_executable, false);
    const pendingCopy = Object.freeze({ ...pendingPin(PINS[KEY]), expected_live_definition_sha256: ABSENT });
    assert.equal((await handlerFor(connect, { pins: { [KEY]: pendingCopy } })(releaseEvent({ pin: pendingCopy }))).ok, false);
    assert.equal((await admin.query(`SELECT to_regclass('${TABLE}') AS t`)).rows[0].t, null);
    // Drift between the recorded pre-state and the apply refuses.
    assert.equal((await apply('f'.repeat(64))).code, CODES.DEPLOYMENT_COLLISION);

    const applied = await apply(ABSENT);
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.before_hash, ABSENT);
    assert.equal(applied.details.receipt.after_hash, PINS[KEY].intended_replacement_sha256);
    // The default-privilege grants on the new table are gone.
    assert.deepEqual(await tableGrantees(), []);
    const after = await inspect();
    assert.equal(after.already_applied, true);
    assert.deepEqual(after.precondition_failures, []);
    assert.equal(after.live_definition_sha256, PINS[KEY].intended_replacement_sha256);
    assert.deepEqual(after.release_sql_inspect.functions.map((row) => row.state), FNS.map(() => 'intended'));
    assert.deepEqual(after.release_sql_inspect.function_acl.map((row) => row.acl), FNS.map(() => ACL));
    for (const fn of FNS) {
      assert.equal((await admin.query('SELECT pg_get_function_result($1::regprocedure) AS r', [fn])).rows[0].r, RESULTS[fn], fn);
      assert.equal((await admin.query(`SELECT has_function_privilege('authenticated', $1, 'EXECUTE') AS a`, [fn])).rows[0].a, false, fn);
    }
    // No policy or trigger came with it.
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM pg_policy WHERE polrelid = '${TABLE}'::regclass`)).rows[0].n, 0);
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = '${TABLE}'::regclass AND NOT tgisinternal`)).rows[0].n, 0);
    // A second apply: refused, the database already past the pinned pre-state.
    assert.notEqual((await apply(ABSENT)).ok, true);
    // A drifted function grant is not intended, nor a table grant.
    await admin.query(`GRANT EXECUTE ON FUNCTION ${FNS[0]} TO authenticated`);
    try {
      assert.equal((await inspect()).already_applied, false);
    } finally {
      await admin.query(`REVOKE EXECUTE ON FUNCTION ${FNS[0]} FROM authenticated`);
    }
    await admin.query(`GRANT SELECT ON ${TABLE} TO authenticated`);
    try {
      assert.equal((await inspect()).already_applied, false);
    } finally {
      await admin.query(`REVOKE SELECT ON ${TABLE} FROM authenticated`);
    }
    // Re-running the reviewed bytes is a no-op on the fingerprint (idempotent).
    await asOwner(TEXT);
    assert.equal((await inspect()).live_definition_sha256, PINS[KEY].intended_replacement_sha256);
  } finally {
    await fx.close();
  }
});
