/**
 * SQL 155 (aws/workflows/sql/155_claim_owner_org_stamp.sql) in the staging guarded executor, on the release engine
 * shared with SQL 90-154 (scripts/deployment-guard/lib/release-sql-state.mjs). Owner 2026-11-11: "Keep it, adopt it
 * through the guarded path" (claims.trg_aws_stamp_claim_org_id, applied to production directly on 2026-09-22 from
 * aws/rls/sql/39_claim_owner_org.sql of the unmerged PR #429).
 * release-sql90-97-executor.test.mjs runs what every release key shares (SQL 155 included); this file covers what is new:
 *
 *   - the pin: staging-authorized (wave 47) from staging read-live run 43077253195, code-derived, selectable, packed, in step with the pending production pin; the pinned commit
 *     authored the bytes; no predecessor, supersedes nothing;
 *   - the file and spec: two DEFINER functions (EXECUTE authenticated, checksops and the owner) and the trigger on
 *     claims; no other release migration touches them; the everything-absent state and the intended state derived;
 *   - on PostgreSQL 16 (the release fixture, tenants.slug added): the absent state read back as derived; a pending pin
 *     and drift cannot apply; one apply through the executor reaches the intended fingerprint, then is refused as
 *     already in place; the file run by hand first, as production ran file 39, already reads intended (the
 *     verified_live case), and a drifted ACL is not intended.
 * The behavior (the stamp) is aws/tests/sql155-claim-owner-org-stamp-pg.test.mjs.
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
  AUTHORIZED_SQL155_CLAIM_OWNER_ORG_STAMP,
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

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-11-11T12:00:00.000Z';
const KEY = 'sql155';
const OWNER_FN = 'public.aws_claim_owner_tenant_id()';
const STAMP_FN = 'public.aws_stamp_claim_org_id()';
const ACL = ['authenticated EXECUTE', 'checksops EXECUTE', 'owner EXECUTE'];
const FNS = [OWNER_FN, STAMP_FN];
const TRIGGER_DEF = 'CREATE TRIGGER trg_aws_stamp_claim_org_id BEFORE INSERT OR UPDATE ON public.claims FOR EACH ROW EXECUTE FUNCTION public.aws_stamp_claim_org_id()';
const sha = (text) => createHash('sha256').update(text).digest('hex');
const TEXT = fs.readFileSync(path.join(ROOT, PINS[KEY].filename), 'utf8');
/** Everything SQL 155 creates absent. */
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
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql155-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

// tenants.slug, which the release fixture lacks (production's tenants has it).
const SLUG_SCHEMA = 'ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS slug text;';

test('pin: SQL 155 staging-authorized from its read-live, code-derived, selectable, packed, in step with the pending production pin; no predecessor', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL155_CLAIM_OWNER_ORG_STAMP, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/155_claim_owner_org_stamp.sql');
  assert.equal(pin.migration_id, '155_claim_owner_org_stamp');
  assert.equal(spec.choice, 'sql155-claim-owner-org-stamp');
  assert.doesNotMatch(spec.choice, /production/);
  assert.equal(sha(TEXT), pin.source_sha256);
  // Staging apply authorized (owner approved 2026-11-11, "Record the SQL 155 staging pin and merge it when green") from
  // staging read-live run 43077253195: already_applied false, precondition_failures []. It read the derived state
  // (everything SQL 155 creates absent).
  assertStagingPinState(assert, KEY, pin);
  assert.equal(pin.execute, true);
  assert.equal(pin.authorization, 'Owner approved 2026-11-11: staging apply (wave 47) from staging read-live run 43077253195');
  assert.equal(pin.expected_live_definition_sha256, ABSENT);
  assert.equal(releaseIntendedHash(KEY, TEXT), pin.intended_replacement_sha256);
  assert.notEqual(ABSENT, pin.intended_replacement_sha256);
  assert.ok(RELEASE_STAGING_SQL_KEYS.includes(KEY));
  // The runbook names the absent and intended states (derived here), the intended fingerprint and the source.
  const runbook = fs.readFileSync(path.join(ROOT, 'ops/production-sql-155-apply.md'), 'utf8');
  for (const value of [ABSENT, pin.intended_replacement_sha256, pin.source_sha256]) assert.ok(runbook.includes(value), value);
  assert.match(runbook, /\*\*Status:\*\* applied to staging \(wave 47, 2026-11-11\); production verified live \(2026-11-11, already as intended; nothing applied there\)\./);
  assert.match(runbook, /read-live \(2026-11-11\)\.\*\* Run 43077253195/);
  assert.ok(runbook.includes(`\`\`\`\n${releaseStateText(KEY, releaseIntendedState(KEY, TEXT))}\n\`\`\``));
  assert.ok(runbook.includes(`\`\`\`\n${releaseStateText(KEY, {})}\n\`\`\``));
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql155-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], FNS);
  assert.deepEqual([...pin.function_identities], spec.functions.map((fn) => fn.identity));
  assert.deepEqual(spec.predecessors, []);
  for (const absent of ['supersedes', 'runs_before', 'refuse_after', 'production_only']) assert.equal(spec[absent], undefined, absent);
  // Production already had the intended state: the production tool never runs the file there (as SQL 100).
  assert.equal(spec.production_noop, true);
  // Nothing supersedes, refuses after or depends on SQL 155, and no other release migration touches its objects.
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes(KEY)
    || (RELEASE_SQL_SPECS[key].refuse_after || []).some((m) => m.key === KEY)
    || (RELEASE_SQL_SPECS[key].predecessors || []).includes(KEY)), []);
  for (const key of RELEASE_SQL_KEYS.filter((k) => k !== KEY)) {
    const other = RELEASE_SQL_SPECS[key];
    const touched = [...(other.functions || []).map((fn) => fn.identity), ...(other.dropped_functions || []), ...(other.acl_functions || []).map((fn) => fn.identity)];
    for (const fn of FNS) assert.ok(!touched.includes(fn), `${key} ${fn}`);
    assert.ok(!(other.triggers || []).some((t) => t.name === 'trg_aws_stamp_claim_org_id'), key);
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
  assert.equal(prod.authorization_phrase, 'ADOPT_CLAIM_OWNER_ORG_STAMP');
  assert.equal(prod.expected_live_definition_sha256, null);
  assert.equal(prod.production_inspect.status, 'recorded');
  assert.equal(prod.production_inspect.live_definition_sha256, pin.intended_replacement_sha256);
  assert.equal(prod.staging_acceptance.ok, false);
  assert.ok(prod.production_inspect.note.includes(ABSENT));
  assert.ok(prod.production_inspect.note.includes(pin.intended_replacement_sha256));
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

test('reviewed file and spec: two DEFINER functions with their ACLs and the trigger on claims; no other object', () => {
  assert.equal(releaseSqlExecutableText(KEY, TEXT), TEXT);
  const defs = releaseFunctionDefinitions(TEXT);
  assert.deepEqual(Object.keys(defs).sort(), ['aws_claim_owner_tenant_id', 'aws_stamp_claim_org_id']);
  for (const name of Object.keys(defs)) {
    assert.equal(defs[name].security_definer, true, name);
    assert.deepEqual([...defs[name].config].sort(), ['row_security=off', 'search_path=public'], name);
  }
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.functions.map((fn) => [fn.identity, fn.acl]), FNS.map((fn) => [fn, ACL]));
  assert.deepEqual(spec.triggers, [{ table: 'public.claims', name: 'trg_aws_stamp_claim_org_id', def: TRIGGER_DEF }]);
  assert.deepEqual(spec.definer_writes, ['public.tenants', 'public.tenant_users']);
  assert.deepEqual(spec.altered_relations, ['public.claims']);
  for (const name of ['auth.uid()', 'public.aws_is_cross_tenant_reader()']) {
    assert.ok(spec.prerequisites.includes(name), name);
    assert.ok(TEXT.includes(name), name);
  }
  for (const kind of ['tables', 'policies', 'table_privileges', 'column_acl', 'acl_functions', 'dropped_functions', 'views', 'indexes', 'added_columns', 'constraints']) {
    assert.equal(spec[kind], undefined, kind);
  }
  assert.deepEqual(releaseUnrelatedScope(KEY).skip_functions, FNS);
  const text = releaseStateText(KEY, releaseIntendedState(KEY, TEXT));
  assert.match(text, /^release sql155 v1\n/);
  assert.ok(text.includes(`function ${STAMP_FN}: lang=plpgsql vol=v parallel=u secdef=true result=trigger config=row_security=off;search_path=public prosrc=${sha(defs.aws_stamp_claim_org_id.prosrc)} acl=authenticated EXECUTE;checksops EXECUTE;owner EXECUTE\n`));
  assert.equal(releaseStateText(KEY, {}), [
    'release sql155 v1',
    `function ${OWNER_FN}: absent`,
    `function ${STAMP_FN}: absent`,
    'trigger public.claims trg_aws_stamp_claim_org_id: absent',
  ].join('\n'));
});

test('PostgreSQL 16: SQL 155 through the executor: the absent state as derived, a pending pin and drift cannot apply, one apply on the intended fingerprint, then already in place; the file run by hand (as production ran file 39) reads intended', { timeout: 600000 }, async (t) => {
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
  const fx = await releaseFixture(pg, 'pg-sql155-exec-', 59640, { extra: [SLUG_SCHEMA] });
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
    const triggers = async () => (await admin.query(`SELECT pg_catalog.pg_get_triggerdef(t.oid) AS def FROM pg_catalog.pg_trigger t
      WHERE t.tgrelid = 'public.claims'::regclass AND NOT t.tgisinternal`)).rows.map((r) => r.def);

    // Everything absent: the derived state.
    const r = await inspect();
    assert.deepEqual(r.precondition_failures, [], JSON.stringify(r.release_sql_inspect));
    assert.deepEqual(r.release_sql_inspect.prerequisites_missing, []);
    assert.deepEqual(r.release_sql_inspect.definer_writes, [{ name: 'tenants', ok: true }, { name: 'tenant_users', ok: true }]);
    assert.equal(r.already_applied, false);
    assert.equal(r.live_definition_sha256, ABSENT);
    // A pending pin cannot apply.
    const pendingCopy = Object.freeze({ ...pendingPin(PINS[KEY]), expected_live_definition_sha256: ABSENT });
    assert.equal((await handlerFor(connect, { pins: { [KEY]: pendingCopy } })(releaseEvent({ pin: pendingCopy }))).ok, false);
    // Drift between the recorded pre-state and the apply refuses.
    assert.equal((await apply('f'.repeat(64))).code, CODES.DEPLOYMENT_COLLISION);
    assert.deepEqual(await triggers(), []);

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
    assert.deepEqual(await triggers(), [TRIGGER_DEF.replace('public.aws_stamp_claim_org_id', 'aws_stamp_claim_org_id')]);
    // A second apply: refused, the database already past the pinned pre-state.
    assert.notEqual((await apply(ABSENT)).ok, true);

    // As production: the objects dropped, then the file run by hand (production ran file 39's same text): it reads
    // intended, already_applied, so the production record is verified_live with nothing applied.
    await admin.query(`DROP TRIGGER trg_aws_stamp_claim_org_id ON public.claims; DROP FUNCTION ${STAMP_FN}; DROP FUNCTION ${OWNER_FN};`);
    assert.equal((await inspect()).live_definition_sha256, ABSENT);
    await asOwner(TEXT);
    const byHand = await inspect();
    assert.equal(byHand.already_applied, true);
    assert.equal(byHand.live_definition_sha256, PINS[KEY].intended_replacement_sha256);
    // ...but not when an EXECUTE grant differs (production's state is read, not assumed).
    await admin.query(`REVOKE EXECUTE ON FUNCTION ${OWNER_FN} FROM authenticated`);
    try {
      const drifted = await inspect();
      assert.equal(drifted.already_applied, false);
      assert.notEqual(drifted.live_definition_sha256, PINS[KEY].intended_replacement_sha256);
    } finally {
      await admin.query(`GRANT EXECUTE ON FUNCTION ${OWNER_FN} TO authenticated`);
    }
    // Re-running the reviewed bytes is a no-op on the fingerprint (idempotent).
    await asOwner(TEXT);
    assert.equal((await inspect()).live_definition_sha256, PINS[KEY].intended_replacement_sha256);
  } finally {
    await fx.close();
  }
});
