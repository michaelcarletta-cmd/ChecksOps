/**
 * SQL 156 (aws/workflows/sql/156_mortgage_desk_shared_check_library_documents.sql) in the staging guarded executor, on
 * the release engine shared with SQL 90-155 (scripts/deployment-guard/lib/release-sql-state.mjs). Owner 2026-11-11: the
 * Mortgage Desk sees the auto-shared library documents of every tenant on a request's check ("It should be everybody
 * shared on that check").
 * release-sql90-97-executor.test.mjs runs what every release key shares (SQL 156 included); this file covers what is new:
 *
 *   - the pin: staging-authorized (wave 48) from staging read-live run 43107339208, code-derived, selectable, packed, in step with the pending production pin; the pinned commit
 *     authored the bytes; no predecessor, supersedes nothing;
 *   - the file and spec: two new SECURITY DEFINER read functions (EXECUTE checksops and the owner), the list's TABLE
 *     result, nothing else; no other release migration touches them; the absent and intended states derived;
 *   - on PostgreSQL 16 (the release fixture plus is_platform_owner() and aws_is_mortgage_ops_agent()): the absent
 *     state read back as derived; a pending pin and drift cannot apply; one apply through the executor reaches the
 *     intended fingerprint (the live TABLE result equal to the spec's), then is refused as already in place; a
 *     drifted grant is not intended; a re-run of the bytes keeps the fingerprint.
 * The behavior is aws/tests/sql156-mortgage-desk-shared-check-library-pg.test.mjs.
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
  AUTHORIZED_SQL156_MORTGAGE_DESK_SHARED_CHECK_LIBRARY,
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
import { sliceFrom } from './helpers/sql145-collection-leg-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-11-11T12:00:00.000Z';
const KEY = 'sql156';
const LIST_FN = 'public.aws_mortgage_desk_shared_library_documents(uuid)';
const PATH_FN = 'public.aws_mortgage_agent_can_read_shared_library_path(text[], text, uuid)';
const ACL = ['checksops EXECUTE', 'owner EXECUTE'];
const FNS = [LIST_FN, PATH_FN];
const LIST_RESULT = 'TABLE(tenant_id uuid, tenant_name text, requesting_tenant boolean, tenant_document_id uuid, doc_type text, file_name text, file_path text, mime_type text, file_size bigint, created_at timestamp with time zone)';
const sha = (text) => createHash('sha256').update(text).digest('hex');
const TEXT = fs.readFileSync(path.join(ROOT, PINS[KEY].filename), 'utf8');
/** Everything SQL 156 creates absent. */
const ABSENT = releaseStateHash(KEY, {});
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
    expiry: '2026-11-11T13:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    ...rest,
  };
  event.preflight_live_fingerprint = authorizationFingerprint(event);
  return event;
}
const inspectEvent = (key = KEY) => releaseEvent({ key, action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL });

function handlerFor(connect, { pins = {} } = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql156-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

// What the release fixture lacks: the platform owner and Desk agent helpers SQL 156 calls (main's text).
const HELPERS = [
  sliceFrom('aws/rls/sql/20_write_helpers.sql', 'CREATE OR REPLACE FUNCTION public.aws_is_authenticated()', '$$;'),
  sliceFrom('aws/rls/sql/10_owner_helpers_from_identity.sql', 'CREATE OR REPLACE FUNCTION public.is_platform_owner()', '$$;'),
  sliceFrom('aws/workflows/sql/100_mortgage_desk_live_access.sql', 'CREATE OR REPLACE FUNCTION public.aws_is_mortgage_ops_agent()', '$$;'),
].join('\n');

test('pin: SQL 156 staging-authorized from its read-live, code-derived, selectable, packed, in step with the pending production pin; no predecessor', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL156_MORTGAGE_DESK_SHARED_CHECK_LIBRARY, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/156_mortgage_desk_shared_check_library_documents.sql');
  assert.equal(pin.migration_id, '156_mortgage_desk_shared_check_library_documents');
  assert.equal(spec.choice, 'sql156-mortgage-desk-shared-check-library');
  assert.doesNotMatch(spec.choice, /production/);
  assert.equal(sha(TEXT), pin.source_sha256);
  // Pending until a reviewed pin change records a staging read-live.
  // Staging apply authorized (owner approved 2026-11-11, "Record the SQL 156 staging pin and merge it when green, then apply
  // SQL 156 in staging") from staging read-live run 43107339208: already_applied false, precondition_failures []. It read the
  // derived state (both functions absent).
  assertStagingPinState(assert, KEY, pin);
  assert.equal(pin.execute, true);
  assert.equal(pin.authorization, 'Owner approved 2026-11-11: staging apply (wave 48) from staging read-live run 43107339208');
  assert.equal(pin.expected_live_definition_sha256, ABSENT);
  assert.equal(releaseIntendedHash(KEY, TEXT), pin.intended_replacement_sha256);
  assert.notEqual(ABSENT, pin.intended_replacement_sha256);
  assert.ok(RELEASE_STAGING_SQL_KEYS.includes(KEY));
  // The runbook names the absent and intended states (derived here), the intended fingerprint and the source.
  const runbook = fs.readFileSync(path.join(ROOT, 'ops/production-sql-156-apply.md'), 'utf8');
  for (const value of [ABSENT, pin.intended_replacement_sha256, pin.source_sha256]) assert.ok(runbook.includes(value), value);
  assert.match(runbook, /\*\*Status:\*\* staging pin execute-authorized \(wave 48\); not applied anywhere\. The production pin is pending\./);
  assert.match(runbook, /read-live \(2026-11-11\)\.\*\* Run 43107339208/);
  assert.ok(runbook.includes(`\`\`\`\n${releaseStateText(KEY, releaseIntendedState(KEY, TEXT))}\n\`\`\``));
  assert.ok(runbook.includes(`\`\`\`\n${releaseStateText(KEY, {})}\n\`\`\``));
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql156-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], FNS);
  assert.deepEqual([...pin.function_identities], spec.functions.map((fn) => fn.identity));
  assert.deepEqual(spec.predecessors, []);
  for (const absent of ['supersedes', 'runs_before', 'refuse_after', 'production_only']) assert.equal(spec[absent], undefined, absent);
  // Nothing supersedes, refuses after or depends on SQL 156, and no other release migration touches its objects.
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes(KEY)
    || (RELEASE_SQL_SPECS[key].refuse_after || []).some((m) => m.key === KEY)
    || (RELEASE_SQL_SPECS[key].predecessors || []).includes(KEY)), []);
  for (const key of RELEASE_SQL_KEYS.filter((k) => k !== KEY)) {
    const other = RELEASE_SQL_SPECS[key];
    const touched = [...(other.functions || []).map((fn) => fn.identity), ...(other.dropped_functions || []), ...(other.acl_functions || []).map((fn) => fn.identity)];
    for (const fn of FNS) assert.ok(!touched.includes(fn), `${key} ${fn}`);
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
  assert.equal(prod.authorization_phrase, 'SHARE_CHECK_LIBRARY_WITH_MORTGAGE_DESK');
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

test('reviewed file and spec: two new SECURITY DEFINER read functions with their ACLs and the list\'s TABLE result; no other object', () => {
  assert.equal(releaseSqlExecutableText(KEY, TEXT), TEXT);
  const defs = releaseFunctionDefinitions(TEXT);
  assert.deepEqual(Object.keys(defs).sort(), ['aws_mortgage_agent_can_read_shared_library_path', 'aws_mortgage_desk_shared_library_documents']);
  for (const name of Object.keys(defs)) {
    assert.equal(defs[name].security_definer, true, name);
    assert.deepEqual([...defs[name].config].sort(), ['row_security=off', 'search_path=public'], name);
  }
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.functions.map((fn) => [fn.identity, fn.acl]), FNS.map((fn) => [fn, ACL]));
  assert.equal(spec.functions[0].result, LIST_RESULT);
  assert.deepEqual(spec.definer_writes, ['public.mortgage_handling_requests', 'public.shared_checks', 'public.tenant_documents', 'public.tenants']);
  for (const name of ['auth.uid()', 'public.is_platform_owner()', 'public.aws_is_mortgage_ops_agent()', 'public.has_role(uuid, public.app_role)']) {
    assert.ok(spec.prerequisites.includes(name), name);
    assert.ok(TEXT.includes(name.replace('(uuid, public.app_role)', '(')), name);
  }
  for (const kind of ['tables', 'policies', 'table_privileges', 'column_acl', 'acl_functions', 'dropped_functions', 'views', 'indexes', 'added_columns', 'constraints', 'triggers', 'altered_relations']) {
    assert.equal(spec[kind], undefined, kind);
  }
  assert.deepEqual(releaseUnrelatedScope(KEY).skip_functions, FNS);
  const text = releaseStateText(KEY, releaseIntendedState(KEY, TEXT));
  assert.match(text, /^release sql156 v1\n/);
  assert.ok(text.includes(`function ${LIST_FN}: lang=plpgsql vol=s parallel=u secdef=true result=${LIST_RESULT} config=row_security=off;search_path=public prosrc=${sha(defs.aws_mortgage_desk_shared_library_documents.prosrc)} acl=checksops EXECUTE;owner EXECUTE\n`));
  assert.equal(releaseStateText(KEY, {}), ['release sql156 v1', `function ${LIST_FN}: absent`, `function ${PATH_FN}: absent`].join('\n'));
});

test('PostgreSQL 16: SQL 156 through the executor: the absent state as derived, a pending pin and drift cannot apply, one apply on the intended fingerprint, then already in place; a drifted grant is not intended', { timeout: 600000 }, async (t) => {
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
  const fx = await releaseFixture(pg, 'pg-sql156-exec-', 59740, { extra: [HELPERS] });
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

    // Both functions absent: the derived state.
    const r = await inspect();
    assert.deepEqual(r.precondition_failures, [], JSON.stringify(r.release_sql_inspect));
    assert.deepEqual(r.release_sql_inspect.prerequisites_missing, []);
    assert.deepEqual(r.release_sql_inspect.definer_writes.map((w) => [w.name, w.ok]),
      [['mortgage_handling_requests', true], ['shared_checks', true], ['tenant_documents', true], ['tenants', true]]);
    assert.equal(r.already_applied, false);
    assert.equal(r.live_definition_sha256, ABSENT);
    // A pending pin cannot apply.
    const pendingCopy = Object.freeze({ ...pendingPin(PINS[KEY]), expected_live_definition_sha256: ABSENT });
    assert.equal((await handlerFor(connect, { pins: { [KEY]: pendingCopy } })(releaseEvent({ pin: pendingCopy }))).ok, false);
    // Drift between the recorded pre-state and the apply refuses.
    assert.equal((await apply('f'.repeat(64))).code, CODES.DEPLOYMENT_COLLISION);

    const applied = await apply(ABSENT);
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.before_hash, ABSENT);
    assert.equal(applied.details.receipt.after_hash, PINS[KEY].intended_replacement_sha256);
    const after = await inspect();
    assert.equal(after.already_applied, true);
    assert.deepEqual(after.precondition_failures, []);
    assert.equal(after.live_definition_sha256, PINS[KEY].intended_replacement_sha256);
    assert.deepEqual(after.release_sql_inspect.functions.map((row) => row.state), ['intended', 'intended']);
    assert.deepEqual(after.release_sql_inspect.function_acl.map((row) => row.acl), [ACL, ACL]);
    // The live TABLE result is the spec's.
    assert.equal((await admin.query('SELECT pg_get_function_result($1::regprocedure) AS r', [LIST_FN])).rows[0].r, LIST_RESULT);
    // No trigger or policy came with it; authenticated cannot call either function.
    const privs = (await admin.query(`SELECT has_function_privilege('authenticated', $1, 'EXECUTE') AS a, has_function_privilege('authenticated', $2, 'EXECUTE') AS b`, FNS)).rows[0];
    assert.deepEqual(privs, { a: false, b: false });
    // A second apply: refused, the database already past the pinned pre-state.
    assert.notEqual((await apply(ABSENT)).ok, true);
    // A drifted grant is not intended.
    await admin.query(`GRANT EXECUTE ON FUNCTION ${LIST_FN} TO authenticated`);
    try {
      const drifted = await inspect();
      assert.equal(drifted.already_applied, false);
    } finally {
      await admin.query(`REVOKE EXECUTE ON FUNCTION ${LIST_FN} FROM authenticated`);
    }
    // Re-running the reviewed bytes is a no-op on the fingerprint (idempotent).
    await asOwner(TEXT);
    assert.equal((await inspect()).live_definition_sha256, PINS[KEY].intended_replacement_sha256);
  } finally {
    await fx.close();
  }
});
