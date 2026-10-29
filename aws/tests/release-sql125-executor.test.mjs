/**
 * SQL 125 (aws/workflows/sql/125_deposit_views_security_invoker.sql) in the staging guarded executor,
 * on the release engine shared with SQL 90-124 (scripts/deployment-guard/lib/release-sql-state.mjs).
 * release-sql90-97-executor.test.mjs runs what every release key shares (SQL 125 included); this
 * file covers what is new:
 *
 *   - the pin: staging-authorized from its read-live (wave 24), code-derived, selectable, packed, in step with the production pin; the
 *     pinned commit authored the bytes; no predecessor;
 *   - the file and spec: security_invoker on the four deposit views, each only when present and
 *     owned by the login; no function, definition, grant, table, policy or trigger; the views are
 *     the prerequisites and the altered relations; the ownership pre-condition refuses;
 *   - on PostgreSQL 16: the views the supabase migrations create render as the spec pins them;
 *     refused while a view is missing and while another role owns one; a pending pin cannot apply;
 *     one apply through the executor reaches the intended fingerprint with only the views' options
 *     changed (PR #1372 keeps them out of the unrelated relations snapshot), then is refused as
 *     already in place.
 * The behavior (a member reads only their own tenants' deposit items through each view) is
 * aws/tests/sql125-deposit-views-pg.test.mjs.
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
  AUTHORIZED_SQL125_DEPOSIT_VIEWS_SECURITY_INVOKER,
  AUTHORIZED_STAGING_SQL,
  RELEASE_2026_10_17_PENDING_SQL_PINS as PINS,
  authorizationFingerprint,
  resolveAuthorizedMigration,
} from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import {
  RELEASE_SQL_KEYS,
  RELEASE_SQL_SPECS,
  collapse,
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
import { DEPOSIT_VIEWS, SUPABASE_VIEW_FILES, depositViewsSchema, supabaseViewStatement } from './helpers/sql125-deposit-views-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-10-29T12:00:00.000Z';
const KEY = 'sql125';
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
    expiry: '2026-10-29T13:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    ...rest,
  };
  event.preflight_live_fingerprint = authorizationFingerprint(event);
  return event;
}
const inspectEvent = () => releaseEvent({ action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL });

function handlerFor(connect, { pins = {} } = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql125-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

test('pin: SQL 125 staging-authorized from its read-live, code-derived, selectable, packed, in step with the production pin; no predecessor', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL125_DEPOSIT_VIEWS_SECURITY_INVOKER, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/125_deposit_views_security_invoker.sql');
  assert.equal(pin.migration_id, '125_deposit_views_security_invoker');
  assert.equal(spec.choice, 'sql125-deposit-views-security-invoker');
  assert.doesNotMatch(spec.choice, /production/);
  assert.equal(sha(TEXT), pin.source_sha256);
  // Staging apply authorized (owner approved 2026-10-29) from staging read-live run 40886747687: the
  // four views with the reviewed definitions and no options, so SQL 125 was not yet applied there.
  assertStagingPinState(assert, KEY, pin);
  assert.equal(pin.execute, true);
  assert.equal(pin.authorization, 'Owner approved 2026-10-29: staging apply (wave 24) from staging read-live run 40886747687');
  assert.equal(pin.expected_live_definition_sha256, '9b31cf5dad3f82bf69fcddd03e0c26c0dc0fdd5ff6bd40137d1af316f1fd6541');
  assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
  // That pre-state is the reviewed definitions without options, derived on the engine.
  const reviewed = (options) => ({ views: Object.fromEntries(spec.views.map((v) => [v.name, { exists: true, def: v.definition, options }])) });
  assert.equal(releaseStateHash(KEY, reviewed([])), pin.expected_live_definition_sha256);
  assert.equal(releaseStateHash(KEY, reviewed(['security_invoker=true'])), pin.intended_replacement_sha256);
  assert.equal(releaseIntendedHash(KEY, TEXT), pin.intended_replacement_sha256);
  // Everything absent (a database without the views) has a fingerprint of its own.
  assert.notEqual(releaseStateHash(KEY, {}), pin.intended_replacement_sha256);
  assert.equal(pin.superseded_intended_sha256, undefined);
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql125-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], []);
  assert.deepEqual(spec.functions, []);
  assert.deepEqual(spec.predecessors, []);
  assert.equal(spec.runs_before, undefined);
  assert.equal(spec.supersedes, undefined);
  assert.equal(spec.refuse_after, undefined);
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes(KEY)
    || (RELEASE_SQL_SPECS[key].refuse_after || []).some((m) => m.key === KEY)
    || (RELEASE_SQL_SPECS[key].predecessors || []).includes(KEY)), []);
  const prod = productionPin();
  assert.equal(prod.intended_replacement_sha256, pin.intended_replacement_sha256);
  assert.equal(prod.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(prod.staging_pin_commit, pin.commit);
  assert.equal(prod.source_sha256, pin.source_sha256);
  assert.deepEqual(prod.predecessors, []);
  // Production pin execute-authorized (owner-approved pin change of 2026-10-29) on the staging apply. Its
  // pre-state is production's own (read-only inspect SSM 9e7ea74b), the same as staging's.
  assert.equal(prod.execute, true);
  assert.match(prod.authorization, /^Owner approved 2026-10-29 /);
  assert.equal(prod.expected_live_definition_sha256, '9b31cf5dad3f82bf69fcddd03e0c26c0dc0fdd5ff6bd40137d1af316f1fd6541');
  assert.equal(prod.expected_live_definition_sha256, pin.expected_live_definition_sha256);
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

test('reviewed file and spec: security_invoker on the four views when present and owned; no function, definition, grant or trigger; the views are the prerequisites and altered relations; pre- and post-conditions', () => {
  assert.equal(releaseSqlExecutableText(KEY, TEXT), TEXT);
  assert.deepEqual(releaseFunctionDefinitions(TEXT), {});
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.views.map((v) => v.name), DEPOSIT_VIEWS);
  assert.deepEqual(spec.prerequisites, DEPOSIT_VIEWS);
  assert.deepEqual(spec.altered_relations, DEPOSIT_VIEWS);
  for (const view of spec.views) {
    assert.deepEqual(view.options, ['security_invoker=true'], view.name);
    // The definition is a rendering of the supabase migration's view: same source table.
    assert.match(view.definition, /FROM public\.deposit_items di\b/, view.name);
    assert.equal(view.definition, collapse(view.definition), view.name);
    assert.ok(fs.existsSync(path.join(ROOT, 'supabase/migrations', SUPABASE_VIEW_FILES[view.name])), view.name);
  }
  const source = TEXT.replace(/--[^\n]*/g, '');
  // The four views, by name, each set to security_invoker inside the ownership check.
  assert.match(source, /ARRAY\['deposit_queue_scored', 'deposit_owner_performance', 'deposit_reminder_queue', 'deposit_aging_dashboard'\]/);
  assert.match(source, /format\('ALTER VIEW public\.%I SET \(security_invoker = true\)', v_view\)/);
  assert.match(source, /c\.relkind = 'v'\s+AND c\.relowner = \(SELECT r\.oid FROM pg_catalog\.pg_roles r WHERE r\.rolname = current_user\)/);
  assert.match(source, /'sql125_not_view_owner: /);
  assert.doesNotMatch(source, /\b(GRANT|REVOKE|DROP|CREATE|TRIGGER|POLICY|security_barrier)\b/i);
  assert.equal((source.match(/\bALTER\s+VIEW\b/gi) || []).length, 1);
  // The unrelated snapshot leaves these four views' options to the fingerprint (PR #1372) and
  // skips nothing else.
  const scope = releaseUnrelatedScope(KEY);
  assert.deepEqual(scope.skip_views, DEPOSIT_VIEWS);
  assert.deepEqual(scope.skip_relations, []);
  assert.deepEqual(scope.skip_functions, []);
  const text = releaseStateText(KEY, releaseIntendedState(KEY, TEXT));
  assert.equal(text.split('\n')[0], 'release sql125 v1');
  for (const view of spec.views) {
    assert.ok(text.includes(`view ${view.name}: def=${sha(view.definition)} options=security_invoker=true`), view.name);
  }
  assert.equal(text.split('\n').length, 1 + DEPOSIT_VIEWS.length);

  // Pre-conditions: every view present and owned by the login.
  const owned = Object.fromEntries(DEPOSIT_VIEWS.map((v) => [v, { exists: true, owner_is_login: true }]));
  const base = { prerequisites_missing: [], predecessors_applied: true, successors_applied: [], dropped_function_callers: [], functions: {}, altered: owned };
  const pre = (over = {}) => releaseSharedPreconditionFailures(KEY, { ...base, ...over }, TEXT);
  assert.deepEqual(pre(), []);
  assert.deepEqual(pre({ prerequisites_missing: ['public.deposit_queue_scored'] }), ['prerequisites_present']);
  assert.deepEqual(pre({ altered: { ...owned, 'public.deposit_reminder_queue': { exists: true, owner_is_login: false } } }), ['altered_relations_owned_by_login']);
  assert.deepEqual(pre({ altered: { ...owned, 'public.deposit_aging_dashboard': { exists: false } } }), ['altered_relations_owned_by_login']);
  // Post-conditions: the intended fingerprint with the views' owner unchanged.
  const after = (over = {}) => ({ live_definition_sha256: PINS[KEY].intended_replacement_sha256, functions: {}, altered: owned, ...over });
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, { altered: owned }, after(), PINS[KEY]), []);
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, { altered: owned }, after({ live_definition_sha256: 'f'.repeat(64) }), PINS[KEY]), ['intended_state']);
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, { altered: owned },
    after({ altered: { ...owned, 'public.deposit_queue_scored': { exists: true, owner_is_login: false } } }), PINS[KEY]), ['altered_relations_owner_unchanged']);
});

test('PostgreSQL 16: SQL 125 through the executor: the supabase views render as the spec pins them; refused while a view is missing and while another role owns one; a pending pin cannot apply; one apply on the intended fingerprint, then already in place', { timeout: 600000 }, async (t) => {
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
  const fx = await releaseFixture(pg, 'pg-sql125-exec-', 59650, { extra: [depositViewsSchema()] });
  const { connectAs } = fx;
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
    const views = async () => (await fx.admin.query(`SELECT c.oid::regclass::text AS name, pg_catalog.pg_get_userbyid(c.relowner) AS owner,
        COALESCE(c.reloptions, ARRAY[]::text[]) AS options, pg_catalog.pg_get_viewdef(c.oid) AS def
      FROM pg_catalog.pg_class c WHERE c.oid = ANY($1::regclass[]) ORDER BY 1`, [DEPOSIT_VIEWS])).rows;
    await fx.admin.query("SELECT pg_catalog.set_config('search_path', 'pg_catalog', false)");

    // The views the supabase migrations create (helpers/sql125-deposit-views-schema.mjs copies them
    // out of those files) render as the spec pins them, owned by checksops_admin, without options.
    const before = await views();
    assert.deepEqual(before.map((v) => v.name).sort(), [...DEPOSIT_VIEWS].sort());
    for (const view of RELEASE_SQL_SPECS[KEY].views) {
      const row = before.find((v) => v.name === view.name);
      assert.equal(collapse(row.def), view.definition, view.name);
      assert.deepEqual(row.options, [], view.name);
      assert.equal(row.owner, 'checksops_admin', view.name);
      assert.ok(supabaseViewStatement(view.name).startsWith('CREATE OR REPLACE VIEW '), view.name);
    }

    // A view missing: refused, nothing applied.
    await fx.admin.query('ALTER VIEW public.deposit_reminder_queue RENAME TO deposit_reminder_queue_moved');
    const missing = await inspect();
    assert.deepEqual(missing.release_sql_inspect.prerequisites_missing, ['public.deposit_reminder_queue']);
    assert.ok(missing.precondition_failures.includes('prerequisites_present'));
    assert.equal((await apply(missing.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
    await fx.admin.query('ALTER VIEW public.deposit_reminder_queue_moved RENAME TO deposit_reminder_queue');

    // A view owned by another role: refused, nothing applied.
    await fx.admin.query('ALTER VIEW public.deposit_owner_performance OWNER TO ubuntu');
    const foreign = await inspect();
    assert.deepEqual(foreign.precondition_failures, ['altered_relations_owned_by_login'], JSON.stringify(foreign.release_sql_inspect));
    assert.equal((await apply(foreign.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
    assert.deepEqual((await views()).map((v) => v.options), [[], [], [], []]);
    await fx.admin.query('ALTER VIEW public.deposit_owner_performance OWNER TO checksops_admin');

    const r = await inspect();
    assert.deepEqual(r.precondition_failures, [], JSON.stringify(r.release_sql_inspect));
    assert.equal(r.already_applied, false);
    assert.notEqual(r.live_definition_sha256, PINS[KEY].intended_replacement_sha256);
    // A pending pin cannot apply (the committed pin is staging-authorized, so pend a copy).
    const pendingCopy = pendingPin(PINS[KEY]);
    const pending = await handlerFor(connect, { pins: { [KEY]: pendingCopy } })(releaseEvent({ pin: pendingCopy, expected_live_definition_sha256: r.live_definition_sha256 }));
    assert.equal(pending.ok, false);
    assert.deepEqual((await views()).map((v) => v.options), [[], [], [], []]);

    const applied = await apply(r.live_definition_sha256);
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.before_hash, r.live_definition_sha256);
    assert.equal(applied.details.receipt.after_hash, PINS[KEY].intended_replacement_sha256);
    const after = await inspect();
    assert.equal(after.already_applied, true);
    assert.equal(after.live_definition_sha256, PINS[KEY].intended_replacement_sha256);
    assert.deepEqual(after.precondition_failures, []);
    // Only the options changed: same definitions, same owner.
    const now = await views();
    for (const row of now) {
      const was = before.find((v) => v.name === row.name);
      assert.deepEqual(row.options, ['security_invoker=true'], row.name);
      assert.equal(row.def, was.def, row.name);
      assert.equal(row.owner, 'checksops_admin', row.name);
    }
    assert.equal((await apply(r.live_definition_sha256)).code, CODES.UNRELATED_MUTATION);
  } finally {
    await fx.close();
  }
});
