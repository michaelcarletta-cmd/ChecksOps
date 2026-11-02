/**
 * SQL 139 (aws/workflows/sql/139_tenant_billing_accounts_write_policy_reconcile.sql) in the staging guarded
 * executor, on the release engine shared with SQL 90-139 (scripts/deployment-guard/lib/release-sql-state.mjs).
 * release-sql90-97-executor.test.mjs runs what every release key shares (SQL 139 included); this file covers what
 * is new:
 *
 *   - the pin: staging-authorized (wave 35) from staging read-live run 41367825238 (the pre-state is the live
 *     drifted policy, whose text is unknown, so it is recorded as read, not derived), code-derived, selectable,
 *     packed, in step with the pending production pin; the pinned commit authored the bytes; no predecessor;
 *   - the spec: no function, one PERMISSIVE FOR ALL policy TO authenticated (SQL 24's), the table as
 *     altered_relations; the three extra preconditions read catalog counts and fail closed unless each is 1;
 *   - on PostgreSQL 16 (helpers/sql139-billing-schema.mjs, owned by checksops_admin): the read-live reads the
 *     fixture's drifted pre-state (derived here from the stand-in rendering), read-only; a changed _job policy,
 *     RLS disabled or a RESTRICTIVE write policy is seen read-only and refuses the apply; a pending pin and drift
 *     cannot apply; one apply reaches the intended fingerprint, the other policies unchanged, then is refused as
 *     already in place; a table that already has the repository policy reads as already applied.
 * The behaviour of the policy is aws/tests/sql139-billing-write-policy-pg.test.mjs.
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
  AUTHORIZED_SQL139_TENANT_BILLING_ACCOUNTS_WRITE_POLICY_RECONCILE,
  AUTHORIZED_STAGING_SQL,
  RELEASE_2026_10_17_PENDING_SQL_PINS as PINS,
  authorizationFingerprint,
  resolveAuthorizedMigration,
} from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import {
  RELEASE_SQL_KEYS,
  RELEASE_SQL_SPECS,
  releaseIntendedHash,
  releaseIntendedState,
  releaseSharedPreconditionFailures,
  releaseStateHash,
  releaseStateText,
} from '../../scripts/deployment-guard/lib/release-sql-state.mjs';
import { EXECUTOR_PACK_MEMBERS } from '../../scripts/deployment-guard/sql-executor-ensure.mjs';
import { MIGRATIONS } from '../../scripts/deployment-guard/github-staging-sql-executor.mjs';
import { READ_LIVE_EXPECTED_SENTINEL } from '../../scripts/deployment-guard/lib/sql-executor-read-live.mjs';
import { importGuardedSqlExecutor } from './helpers/import-guarded-sql-executor.mjs';
import { assertStagingPinState, pendingPin } from './helpers/staging-sql-wave1.mjs';
import { MEMBER_A, pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';
import { billingSchema } from './helpers/sql139-billing-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-11-02T12:00:00.000Z';
const KEY = 'sql139';
const TABLE = 'public.tenant_billing_accounts';
const POLICY = 'aws_write_tenant_billing_accounts';
const WRITE = 'public.aws_can_write_tenant(tenant_id)';
const sha = (text) => createHash('sha256').update(text).digest('hex');
const TEXT = fs.readFileSync(path.join(ROOT, PINS[KEY].filename), 'utf8');
const FILES = Object.freeze(Object.fromEntries(RELEASE_SQL_KEYS.map((key) => [key, path.join(ROOT, PINS[key].filename)])));
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK|BEGIN READ ONLY)\b/i;
const productionPin = () => JSON.parse(fs.readFileSync(path.join(ROOT, RELEASE_SQL_SPECS[KEY].production_pin_rel), 'utf8'));
const INTENDED = releaseIntendedState(KEY, TEXT);
/** The fixture's stand-in drift (helpers/sql139-billing-schema.mjs DRIFTED) as pg_get_expr renders it with search_path pg_catalog. */
const DRIFTED_RENDERED = "(public.is_platform_owner() OR (current_setting('request.sql139_test_drift'::text, true) = '1'::text))";
const fixtureDrift = () => ({
  ...INTENDED,
  policies: { [`${TABLE} ${POLICY}`]: { exists: true, cmd: 'ALL', permissive: true, roles: ['authenticated'], qual: DRIFTED_RENDERED, with_check: DRIFTED_RENDERED } },
});
/** The PostgreSQL 16 fixture's pre-state (a test value only: staging's is recorded by its read-live, never derived). */
const FIXTURE_PRE = releaseStateHash(KEY, fixtureDrift());

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
    expiry: '2026-11-02T13:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    ...rest,
  };
  event.preflight_live_fingerprint = authorizationFingerprint(event);
  return event;
}
const inspectEvent = () => releaseEvent({ action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL });

function handlerFor(connect, { pins = {} } = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql139-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

test('pin: SQL 139 staging-authorized from its read-live (pre-state recorded, not derivable), code-derived, selectable, packed, in step with the pending production pin; no predecessor', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL139_TENANT_BILLING_ACCOUNTS_WRITE_POLICY_RECONCILE, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/139_tenant_billing_accounts_write_policy_reconcile.sql');
  assert.equal(pin.migration_id, '139_tenant_billing_accounts_write_policy_reconcile');
  assert.equal(spec.choice, 'sql139-tenant-billing-accounts-write-policy-reconcile');
  assert.doesNotMatch(spec.choice, /production/);
  assert.equal(sha(TEXT), pin.source_sha256);
  // Staging apply authorized (owner approved 2026-11-02, "record the SQL 139 staging pin") from staging read-live
  // run 41367825238: already_applied false, precondition_failures []. The pre-state is the live drifted policy,
  // whose text is unknown: it is the value that run reported, not derivable from the fixture or any file.
  assertStagingPinState(assert, KEY, pin);
  assert.equal(pin.execute, true);
  assert.equal(pin.authorization, 'Owner approved 2026-11-02: staging apply (wave 35) from staging read-live run 41367825238');
  assert.equal(pin.expected_live_definition_sha256, '8727ecb1f834f9623c1ea7f568621f64a4212dadf3d28a5a7741a6a542cdb22f');
  assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
  assert.equal(releaseIntendedHash(KEY, TEXT), pin.intended_replacement_sha256);
  assert.equal(pin.intended_replacement_sha256, '17f07a31e274899a50f53877dc1df48839614ba6148047a4321000e474bd446d');
  assert.notEqual(FIXTURE_PRE, pin.intended_replacement_sha256);
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql139-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], []);
  assert.deepEqual(spec.predecessors, []);
  for (const none of ['supersedes', 'runs_before', 'refuse_after', 'definer_writes', 'table_privileges', 'whole_tables', 'dropped_policies']) assert.equal(spec[none], undefined, none);
  // Nothing supersedes, refuses after or depends on SQL 139; no other release key fingerprints its policy.
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes(KEY)
    || (RELEASE_SQL_SPECS[key].refuse_after || []).some((m) => m.key === KEY)
    || (RELEASE_SQL_SPECS[key].predecessors || []).includes(KEY)), []);
  for (const key of RELEASE_SQL_KEYS.filter((k) => k !== KEY)) {
    const other = RELEASE_SQL_SPECS[key];
    assert.ok(![...(other.policies || []), ...(other.dropped_policies || [])].some((p) => p.table === TABLE && !p.name.startsWith('aws_money_write_gate_')), key);
    assert.ok(!(other.whole_tables || []).some((w) => w.table === TABLE), key);
  }
  const prod = productionPin();
  assert.equal(prod.intended_replacement_sha256, pin.intended_replacement_sha256);
  assert.equal(prod.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(prod.staging_pin_commit, pin.commit);
  assert.equal(prod.source_sha256, pin.source_sha256);
  assert.deepEqual(prod.function_identities, []);
  assert.deepEqual(prod.predecessors, []);
  assert.equal(prod.execute, false);
  assert.equal(prod.authorization, 'pending');
  assert.equal(prod.expected_live_definition_sha256, null);
  assert.equal(prod.production_inspect.status, 'pending');
  assert.match(prod.production_inspect.note, /Production is unverified/);
  assert.match(prod.order_note, /The production pre-state cannot be derived/);
  // The runbook: the intended fingerprint and text, the source, the evidence; no derived pre-state.
  const runbook = fs.readFileSync(path.join(ROOT, 'ops/production-sql-139-apply.md'), 'utf8');
  assert.match(runbook, /\*\*Status:\*\* staging pin execute-authorized \(wave 35\); not applied anywhere\. The production pin is pending\./);
  assert.match(runbook, /read-live \(2026-11-02\)\.\*\* Run 41367825238/);
  assert.ok(runbook.includes(pin.expected_live_definition_sha256));
  assert.match(runbook, /\*\*Pre-state: not derivable\.\*\*/);
  assert.match(runbook, /\*\*Production: unverified\.\*\*/);
  for (const value of [pin.intended_replacement_sha256, pin.source_sha256, '8c72ef93d1e5', '1c3f7a3edd76', '7b9c86002fdd', '#1515']) assert.ok(runbook.includes(value), value);
  assert.ok(runbook.includes(`\`\`\`\n${releaseStateText(KEY, INTENDED)}\n\`\`\``));
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

test('reviewed file and spec: SQL 24\'s one policy, no function; prerequisites, the altered table and the fail-closed counts', () => {
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.functions, []);
  assert.deepEqual(spec.policies, [{ table: TABLE, name: POLICY, cmd: 'ALL', roles: ['authenticated'], permissive: true, qual: WRITE, with_check: WRITE }]);
  assert.deepEqual(INTENDED.policies, { [`${TABLE} ${POLICY}`]: { exists: true, cmd: 'ALL', permissive: true, roles: ['authenticated'], qual: WRITE, with_check: WRITE } });
  assert.deepEqual([...spec.altered_relations], [TABLE]);
  assert.deepEqual([...spec.prerequisites], [TABLE, `column ${TABLE}.tenant_id`, 'public.aws_can_write_tenant(uuid)', 'public.aws_monthly_billing_job()', 'role checksops', 'role authenticated']);
  assert.deepEqual([...spec.extra_preconditions], ['billing_table_rls_enabled', 'billing_write_policy_permissive_all', 'billing_job_policy_intact']);
  assert.deepEqual(Object.keys(spec.counts), ['billing_table_rls_enabled', 'billing_write_policy_permissive_all', 'billing_job_policy_intact']);
  // Catalog only: every count reads pg_catalog, never the table's rows.
  for (const [name, count] of Object.entries(spec.counts)) {
    assert.match(count.sql, /^SELECT count\(\*\)::int AS n FROM pg_catalog\./, name);
    assert.doesNotMatch(count.sql.replace(/'(?:[^']|'')*'/g, "''"), /\bpublic\./, name);
  }
  for (const form of ['aws_monthly_billing_job()', '(aws_monthly_billing_job())', 'public.aws_monthly_billing_job()', '(public.aws_monthly_billing_job())']) {
    assert.ok(spec.counts.billing_job_policy_intact.sql.includes(`'${form}'`), form);
    assert.ok(TEXT.includes(`'${form}'`), form);
  }

  const live = (counts) => ({
    current_user: 'checksops_admin',
    prerequisites_missing: [],
    predecessors_applied: true,
    successors_applied: [],
    dependents: {},
    dropped_function_callers: [],
    functions: {},
    altered: { [TABLE]: { exists: true, owner_is_login: true } },
    counts: { billing_table_rls_enabled: 1, billing_write_policy_permissive_all: 1, billing_job_policy_intact: 1, ...counts },
  });
  assert.deepEqual(releaseSharedPreconditionFailures(KEY, live({}), TEXT), []);
  assert.deepEqual(releaseSharedPreconditionFailures(KEY, live({ billing_table_rls_enabled: 0 }), TEXT), ['billing_table_rls_enabled']);
  assert.deepEqual(releaseSharedPreconditionFailures(KEY, live({ billing_write_policy_permissive_all: 0 }), TEXT), ['billing_write_policy_permissive_all']);
  assert.deepEqual(releaseSharedPreconditionFailures(KEY, live({ billing_job_policy_intact: 0 }), TEXT), ['billing_job_policy_intact']);
  assert.deepEqual(releaseSharedPreconditionFailures(KEY, live({ billing_job_policy_intact: 2 }), TEXT), ['billing_job_policy_intact']);
  assert.deepEqual(releaseSharedPreconditionFailures(KEY, live({ billing_table_rls_enabled: null, billing_job_policy_intact: null }), TEXT),
    ['billing_table_rls_enabled', 'billing_job_policy_intact']);
  const notOwned = live({});
  notOwned.altered[TABLE] = { exists: true, owner_is_login: false };
  assert.deepEqual(releaseSharedPreconditionFailures(KEY, notOwned, TEXT), ['altered_relations_owned_by_login']);
});

test('PostgreSQL 16: SQL 139 through the executor: the drifted pre-state read-only; a changed _job policy, RLS off or a RESTRICTIVE write policy refuse first; a pending pin and drift cannot apply; one apply on the intended fingerprint, then refused', { timeout: 600000 }, async (t) => {
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
  const fx = await releaseFixture(pg, 'pg-sql139-exec-', 61395, { extra: [billingSchema({ member: MEMBER_A })] });
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
    const others = async () => (await admin.query(`SELECT pol.polname, pol.polcmd::text AS cmd, pol.polpermissive, pol.polroles::text AS roles,
      pg_catalog.pg_get_expr(pol.polqual, pol.polrelid) AS q, pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid) AS w
      FROM pg_catalog.pg_policy pol WHERE pol.polrelid = 'public.tenant_billing_accounts'::regclass AND pol.polname <> $1 ORDER BY 1`, [POLICY])).rows;
    const P = 'ON public.tenant_billing_accounts';

    const pre = await inspect();
    assert.deepEqual(pre.precondition_failures, [], JSON.stringify(pre.release_sql_inspect));
    assert.deepEqual(pre.release_sql_inspect.prerequisites_missing, []);
    assert.equal(pre.already_applied, false);
    assert.equal(pre.live_definition_sha256, FIXTURE_PRE, 'the fixture pre-state equals the one derived from its rendering');
    assert.deepEqual(pre.release_sql_inspect.counts, { billing_table_rls_enabled: 1, billing_write_policy_permissive_all: 1, billing_job_policy_intact: 1 });
    const before = await others();

    // Each fail-closed condition is seen read-only first and refuses the apply; nothing changes.
    await admin.query(`ALTER POLICY aws_write_tenant_billing_accounts_job ${P} USING (true)`);
    const job = await inspect();
    assert.deepEqual(job.precondition_failures, ['billing_job_policy_intact']);
    assert.equal(job.live_definition_sha256, FIXTURE_PRE, 'the _job policy is not in the fingerprint');
    assert.equal((await apply(FIXTURE_PRE)).code, CODES.DEPLOYMENT_COLLISION);
    await admin.query(`ALTER POLICY aws_write_tenant_billing_accounts_job ${P} USING (public.aws_monthly_billing_job())`);
    await admin.query(`ALTER POLICY aws_write_tenant_billing_accounts_job ${P} TO checksops, authenticated`);
    assert.deepEqual((await inspect()).precondition_failures, ['billing_job_policy_intact']);
    await admin.query(`ALTER POLICY aws_write_tenant_billing_accounts_job ${P} TO checksops`);
    await admin.query('ALTER TABLE public.tenant_billing_accounts DISABLE ROW LEVEL SECURITY');
    assert.deepEqual((await inspect()).precondition_failures, ['billing_table_rls_enabled']);
    assert.equal((await apply(FIXTURE_PRE)).code, CODES.DEPLOYMENT_COLLISION);
    await admin.query('ALTER TABLE public.tenant_billing_accounts ENABLE ROW LEVEL SECURITY');
    await admin.query(`DROP POLICY ${POLICY} ${P}; CREATE POLICY ${POLICY} ${P} AS RESTRICTIVE FOR ALL TO authenticated USING (true) WITH CHECK (true)`);
    const restrictive = await inspect();
    assert.deepEqual(restrictive.precondition_failures, ['billing_write_policy_permissive_all']);
    assert.equal((await apply(restrictive.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
    await admin.query(`DROP POLICY ${POLICY} ${P}; ${billingSchema().split('\n').filter((l) => l.startsWith('CREATE POLICY aws_write_tenant_billing_accounts ON') || l.startsWith('  FOR ALL TO authenticated')).join('\n')}`);
    assert.equal((await inspect()).live_definition_sha256, FIXTURE_PRE);
    assert.deepEqual(await others(), before);

    // A pending pin cannot apply; a wrong recorded state refuses.
    const pendingCopy = Object.freeze({ ...pendingPin(PINS[KEY]), expected_live_definition_sha256: FIXTURE_PRE });
    assert.equal((await handlerFor(connect, { pins: { [KEY]: pendingCopy } })(releaseEvent({ pin: pendingCopy }))).ok, false);
    assert.equal((await apply(PINS[KEY].intended_replacement_sha256)).code, CODES.INVALID_MANIFEST);
    assert.equal((await apply('f'.repeat(64))).code, CODES.DEPLOYMENT_COLLISION);
    assert.equal((await inspect()).live_definition_sha256, FIXTURE_PRE);

    // One apply on the intended fingerprint.
    const applied = await apply(FIXTURE_PRE);
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.before_hash, FIXTURE_PRE);
    assert.equal(applied.details.receipt.after_hash, PINS[KEY].intended_replacement_sha256);
    const after = await inspect();
    assert.equal(after.already_applied, true);
    assert.equal(after.live_definition_sha256, PINS[KEY].intended_replacement_sha256);
    assert.deepEqual(after.precondition_failures, []);
    assert.deepEqual(await others(), before, 'SELECT and _job policies unchanged');
    const rendered = (await admin.query(`SET search_path = pg_catalog; SELECT pg_catalog.pg_get_expr(pol.polqual, pol.polrelid) AS q,
      pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid) AS w FROM pg_catalog.pg_policy pol WHERE pol.polname = '${POLICY}'`))[1].rows;
    await admin.query('RESET search_path');
    assert.deepEqual(rendered, [{ q: WRITE, w: WRITE }]);
    // A second apply: refused, the database already past the pinned pre-state.
    assert.equal((await apply(FIXTURE_PRE)).code, CODES.UNRELATED_MUTATION);
    assert.equal((await inspect()).live_definition_sha256, PINS[KEY].intended_replacement_sha256);
  } finally {
    await fx.close();
  }

  // A table that already has the repository policy reads as applied (nothing to do).
  const fx2 = await releaseFixture(pg, 'pg-sql139-exec2-', 61397, { extra: [billingSchema({ member: MEMBER_A, write: WRITE })] });
  try {
    const connect = async () => fx2.connectAs('checksops_admin');
    const result = await handlerFor(connect)(inspectEvent());
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.details.receipt.already_applied, true);
    assert.equal(result.details.receipt.live_definition_sha256, PINS[KEY].intended_replacement_sha256);
  } finally {
    await fx2.close();
  }
});
