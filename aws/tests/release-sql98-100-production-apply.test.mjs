/**
 * Production tools for SQL 98, SQL 99 and SQL 100
 * (scripts/deployment-guard/sql98-…, sql99-…, sql100-…-production-apply.mjs on
 * lib/release-sql-production-apply.mjs and lib/release-sql-production-cli.mjs).
 * release-sql90-97-production-apply.test.mjs runs every release key (these three included)
 * through the shared refusals (pending pins, binding, evaluate / precheck, the CLI, the real
 * guard); this file covers what is new:
 *
 *   - the reconciled SQL 98 / SQL 99 pins keep their recorded hashes and notes and now have the
 *     SQL 90-97 pins' shape; the new SQL 100 pin has it too; all stay execute false / pending;
 *   - SQL 100 is production_noop: the production precondition production_state_already_intended;
 *   - on PostgreSQL 16: --inspect is read-only for all three; SQL 98 and SQL 99 apply once each as
 *     checksops_admin (the superuser login refused); SQL 100's tool never runs the file: it
 *     refuses while the live state is not production's (production_state_already_intended),
 *     then, once the live state is the intended one (the file already in place, as on
 *     production), reports already_applied and refuses as already in place; another grantor or
 *     a policy comment makes the live state not the intended one again.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import { ONE_SHOT_TOOLS } from '../../scripts/deployment-guard/lib/production-sql-one-shot.mjs';
import { RELEASE_2026_10_17_PENDING_SQL_PINS as STAGING } from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import { RELEASE_SQL_SPECS, readReleaseSqlState } from '../../scripts/deployment-guard/lib/release-sql-state.mjs';
import {
  RELEASE_PRODUCTION,
  executeReleaseProductionApply,
  inspectReleaseProduction,
  loadReleaseProductionPin,
  readPinnedReleaseSql,
  releaseProductionPreconditionFailures,
} from '../../scripts/deployment-guard/lib/release-sql-production-apply.mjs';
import { pgSkipReason, releaseFixture, sql98To100Schema } from './helpers/release-sql-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEYS = Object.freeze(['sql98', 'sql99', 'sql100']);
const BEFORE = Object.freeze(['sql90', 'sql91', 'sql92', 'sql93', 'sql94', 'sql96', 'sql97', 'sql95']);
const COMMITTED = Object.freeze(Object.fromEntries(KEYS.map((key) => [key, loadReleaseProductionPin(key, ROOT)])));
const SQL96_PIN = loadReleaseProductionPin('sql96', ROOT);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const COMMIT = 'a'.repeat(40);
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK|BEGIN READ ONLY)\b/i;
const text = (key) => fs.readFileSync(path.join(ROOT, STAGING[key].filename), 'utf8');

const keyPaths = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? keyPaths(v, `${p}${k}.`) : [`${p}${k}`]));

const authorized = (key, live) => Object.freeze({
  ...COMMITTED[key],
  authorization: 'Owner approved test fixture',
  execute: true,
  expected_live_definition_sha256: live,
  staging_acceptance: { ok: true, reference: STAGING_REF, basis: 'test fixture' },
});
function manifest(key, pin) {
  const live = pin.expected_live_definition_sha256;
  const fingerprint = { sql: live };
  const workstream = `prod-${key}-release-test`;
  return {
    workstream_id: workstream,
    branch: 'main',
    commit: COMMIT,
    operator: 'owner',
    target_environment: 'production',
    target_component: 'production-sql',
    deployment_type: 'sql-apply',
    owned_components: [pin.filename],
    filename: pin.filename,
    migration_id: pin.migration_id,
    source_sha256: pin.source_sha256,
    expected_live_definition_sha256: live,
    intended_replacement_sha256: pin.intended_replacement_sha256,
    live_definition_sha256: live,
    preflight_live_fingerprint: fingerprint,
    production_fingerprint: fingerprint,
    immediately_before_fingerprint: fingerprint,
    staging_acceptance: pin.staging_acceptance,
    approval: { approved: true, workstream_id: workstream },
    authorization_phrase: pin.authorization_phrase,
    one_use_id: `${key}-prod-${process.pid}-${Math.random().toString(16).slice(2)}`,
    build_timestamp: '2026-10-17T20:00:00.000Z',
  };
}
const consumedPath = () => path.join(os.tmpdir(), `sql98100-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

test('pins: the reconciled SQL 98 / SQL 99 pins keep their recorded hashes and notes; SQL 100 is new; all have the SQL 90-97 shape and stay pending', () => {
  const shape = new Set(keyPaths(SQL96_PIN));
  for (const key of KEYS) {
    const pin = COMMITTED[key];
    const staging = STAGING[key];
    const extra = keyPaths(pin).filter((k) => !shape.has(k)).sort();
    assert.deepEqual([...shape].filter((k) => !keyPaths(pin).includes(k)), [], `${key} lacks the engine pin shape`);
    assert.deepEqual(extra, key === 'sql100' ? ['production_inspect.already_applied', 'production_noop'] : ['tooling.superseded_note'], key);
    assert.equal(pin.id, `${RELEASE_SQL_SPECS[key].production_pin_rel.split('/').pop().replace(/\.json$/, '')}`);
    assert.equal(pin.execute, false, key);
    assert.equal(pin.authorization, 'pending', key);
    assert.equal(pin.expected_live_definition_sha256, null, key);
    assert.equal(pin.staging_acceptance.ok, false, key);
    assert.equal(pin.production_inspect.status, 'pending', key);
    assert.equal(pin.source_sha256, staging.source_sha256, key);
    assert.equal(pin.staging_pin_commit, staging.commit, key);
    assert.equal(pin.intended_replacement_sha256, staging.intended_replacement_sha256, key);
    assert.deepEqual(pin.function_identities, [...staging.function_identities], key);
    assert.equal(pin.tooling.status, 'built', key);
    assert.equal(pin.tooling.production_tool, RELEASE_PRODUCTION[key].cli, key);
    assert.equal(pin.tooling.staging_workflow_choice, RELEASE_SQL_SPECS[key].choice, key);
    assert.equal(pin.tooling.one_shot_migration, key, key);
    for (const file of [pin.tooling.production_tool, pin.tooling.runbook, pin.tooling.fingerprint_engine, pin.tooling.production_lib, ...pin.tooling.tests]) {
      assert.ok(fs.existsSync(path.join(ROOT, file)), `${key} ${file}`);
    }
    assert.equal(readPinnedReleaseSql(key, ROOT, pin).ok, true, key);
    assert.equal(ONE_SHOT_TOOLS[key].script, RELEASE_PRODUCTION[key].cli, key);
  }
  // The recorded hashes of the earlier pending pins (ops/fee-collection-deltas.md section 3).
  assert.equal(COMMITTED.sql98.source_sha256, '5a42e485c84f7c9976390d12c275cdf32612fbba7656b66f553110c0ae697c2a');
  assert.equal(COMMITTED.sql98.staging_pin_commit, '567772a9034cae4ec4d7c56b07c983fb4e797103');
  assert.equal(COMMITTED.sql99.source_sha256, '0c079fe41c932f34f33262ba00a17f3201f99960c89a944750f5312bd97f8b15');
  assert.equal(COMMITTED.sql99.staging_pin_commit, '600311866039adb0a85217be84d7dfb09f9eeec2');
  // ... and their notes (kept, with an update appended; the old tooling note kept as superseded_note).
  assert.match(COMMITTED.sql98.order_note, /^After SQL 96 \(SQL 98 refuses with 55000 sql98_prerequisite_missing/);
  assert.match(COMMITTED.sql98.production_inspect.note, /^Pending: no read-only production inspect has been run for SQL 98\. It must record/);
  assert.match(COMMITTED.sql98.tooling.superseded_note, /^Pending: no guarded tooling exists for SQL 98 yet/);
  assert.match(COMMITTED.sql98.intended_post_state.note, /^check_processing events stamped once per check/);
  assert.match(COMMITTED.sql99.order_note, /^After SQL 90 \(required: the file refuses with sql99_prerequisite_missing/);
  assert.match(COMMITTED.sql99.production_inspect.note, /^Pending: no read-only production inspect has been run for SQL 99/);
  assert.match(COMMITTED.sql99.tooling.superseded_note, /^Pending: no guarded tooling exists for SQL 99 yet/);
  assert.deepEqual(COMMITTED.sql98.predecessors, ['sql96']);
  assert.deepEqual(COMMITTED.sql99.predecessors, ['sql90']);
  assert.deepEqual(COMMITTED.sql100.predecessors, ['sql90']);
  assert.equal(COMMITTED.sql100.production_noop, true);
  for (const key of ['admin_login', 'rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(COMMITTED.sql100[key], COMMITTED.sql99[key], key);
});

test('SQL 100 is production_noop: production refuses unless the live state is already the intended one; other keys have no such rule', () => {
  const login = { current_user: 'checksops_admin', session_user: 'checksops_admin' };
  const intended = COMMITTED.sql100.intended_replacement_sha256;
  assert.ok(releaseProductionPreconditionFailures('sql100', { ...login, live_definition_sha256: 'e'.repeat(64) }, COMMITTED.sql100, text('sql100'))
    .includes('production_state_already_intended'));
  assert.ok(!releaseProductionPreconditionFailures('sql100', { ...login, live_definition_sha256: intended }, COMMITTED.sql100, text('sql100'))
    .includes('production_state_already_intended'));
  for (const key of ['sql98', 'sql99', 'sql90', 'sql96']) {
    assert.ok(!releaseProductionPreconditionFailures(key, { ...login, live_definition_sha256: 'e'.repeat(64) }, loadReleaseProductionPin(key, ROOT), text(key))
      .includes('production_state_already_intended'), key);
  }
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
  const fx = await releaseFixture(pg, prefix, port, { extra: sql98To100Schema() });
  try {
    await fn(fx);
  } finally {
    await fx.close();
  }
}

test('PostgreSQL 16: read-only inspects; SQL 98 and SQL 99 apply once as checksops_admin; SQL 100\'s tool never runs the file on production', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql98100-prod-', 59300, async ({ admin, connectAs, applyPredecessors }) => {
  await applyPredecessors();
  const owner = await connectAs('checksops_admin');
  try {
    for (const key of BEFORE) await owner.query(text(key));
  } finally {
    await owner.end();
  }
  const seen = [];
  const connectWith = (user) => async () => {
    const client = await connectAs(user);
    const query = client.query.bind(client);
    client.query = (sql, params) => { seen.push(String(sql)); return query(sql, params); };
    return client;
  };
  const connect = connectWith('checksops_admin');
  const inspect = async (key, pin = COMMITTED[key]) => {
    seen.length = 0;
    const inspected = await inspectReleaseProduction(key, { connect, pin, root: ROOT });
    assert.equal(inspected.ok, true, JSON.stringify(inspected));
    assert.equal(seen[0], 'BEGIN READ ONLY', key);
    assert.equal(seen.at(-1), 'ROLLBACK', key);
    assert.ok(seen.slice(1, -1).every((sql) => READ_ONLY_STATEMENT_RE.test(sql)), JSON.stringify(seen.filter((sql) => !READ_ONLY_STATEMENT_RE.test(sql))));
    assert.doesNotMatch(JSON.stringify(inspected.details), /Private|example\.invalid|checksopsadmin@|11111111-1111/, key);
    return inspected.details;
  };

  for (const key of ['sql98', 'sql99']) {
    const d = await inspect(key);
    assert.equal(d.read_only, true);
    assert.equal(d.pin_execute, false);
    assert.deepEqual(d.precondition_failures, [], `${key}: ${JSON.stringify(d.release_sql_inspect)}`);
    assert.equal(d.apply_preconditions_met, false, 'no recorded pre-state');
    assert.equal(d.production_noop, undefined, key);
    if (key === 'sql98') {
      assert.deepEqual(d.counts, { duplicate_billing_periods: 0, check_billing_event_duplicates: 0, check_billing_config_rows: 0, check_billing_config_active_rows: 0, platform_billing_destination_rows: null, platform_billing_destination_production_rows: null, platform_billing_destination_sandbox_rows: null, platform_billing_destination_reviewed_account_rows: null, platform_billing_destination_production_reviewed_account_rows: null, platform_billing_destination_payment_method_rows: null, platform_billing_destination_verified_rows: null });
    }
    const pin = authorized(key, d.live_definition_sha256);
    const asSuper = await executeReleaseProductionApply(key, manifest(key, pin), { root: ROOT, pin, connect: connectWith('ubuntu'), consumedPath: consumedPath() });
    assert.equal(asSuper.code, CODES.DEPLOYMENT_COLLISION, key);
    assert.ok(asSuper.details.failed.includes('login_is_pinned_admin'));
    const applied = await executeReleaseProductionApply(key, manifest(key, pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.after_hash, pin.intended_replacement_sha256);
    assert.equal((await inspect(key, pin)).already_applied, true, key);
    const replay = await executeReleaseProductionApply(key, manifest(key, pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
    assert.equal(replay.code, CODES.UNRELATED_MUTATION, key);
  }

  // SQL 100 against a database that is not production's state (12 / 24 / SQL 50): refused, nothing runs.
  const file100 = text('sql100');
  let d = await inspect('sql100');
  assert.deepEqual(d.production_noop, { required: true, live_is_intended: false });
  assert.deepEqual(d.precondition_failures, ['production_state_already_intended']);
  assert.equal(d.already_applied, false);
  assert.equal(d.apply_preconditions_met, false);
  const notProduction = d.live_definition_sha256;
  seen.length = 0;
  let pin = authorized('sql100', notProduction);
  const refused = await executeReleaseProductionApply('sql100', manifest('sql100', pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(refused.code, CODES.DEPLOYMENT_COLLISION, JSON.stringify(refused));
  assert.deepEqual(refused.details.failed, ['production_state_already_intended']);
  assert.ok(!seen.includes(file100), 'the SQL 100 file is never sent');
  assert.equal((await inspect('sql100')).live_definition_sha256, notProduction);

  // Production already has SQL 100's state (here: the file run outside the tool, as checksops_admin).
  const prod = await connectAs('checksops_admin');
  try {
    await prod.query(file100);
  } finally {
    await prod.end();
  }
  d = await inspect('sql100');
  assert.equal(d.already_applied, true);
  assert.deepEqual(d.production_noop, { required: true, live_is_intended: true });
  assert.deepEqual(d.precondition_failures, []);
  assert.equal(d.apply_preconditions_met, false);
  assert.equal(d.live_definition_sha256, COMMITTED.sql100.intended_replacement_sha256);
  // Even an authorized apply is refused as already in place, without sending the file.
  seen.length = 0;
  pin = authorized('sql100', notProduction);
  const inPlace = await executeReleaseProductionApply('sql100', manifest('sql100', pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(inPlace.code, CODES.UNRELATED_MUTATION, JSON.stringify(inPlace));
  assert.match(inPlace.message, /already in place/);
  assert.ok(!seen.includes(file100), 'the SQL 100 file is never sent');

  // Another grantor, a policy comment or a widened helper EXECUTE: production is no longer SQL 100's state.
  for (const setup of [
    ['GRANT UPDATE (status) ON public.mortgage_handling_requests TO checksops WITH GRANT OPTION', 'SET ROLE checksops',
      'GRANT UPDATE (note) ON public.mortgage_handling_requests TO authenticated', 'RESET ROLE'],
    ["COMMENT ON POLICY aws_select_mortgage_ops_agent_queue ON public.mortgage_handling_requests IS 'x'"],
    ['GRANT EXECUTE ON FUNCTION public.aws_is_mortgage_ops_agent() TO PUBLIC'],
    ['REVOKE EXECUTE ON FUNCTION public.aws_mortgage_agent_queue_visible(text, uuid) FROM checksops'],
    ["COMMENT ON POLICY aws_update_mortgage_ops_accept_complete ON public.mortgage_handling_requests IS 'edited'"],
  ]) {
    await admin.query('BEGIN');
    try {
      for (const sql of setup) await admin.query(sql);
      await admin.query("SELECT pg_catalog.set_config('search_path', 'pg_catalog', true)");
      const state = (await readReleaseSqlState(admin, 'sql100')).details;
      assert.notEqual(state.live_definition_sha256, COMMITTED.sql100.intended_replacement_sha256, setup.join('; '));
      assert.ok(releaseProductionPreconditionFailures('sql100', state, COMMITTED.sql100, file100).includes('production_state_already_intended'), setup.join('; '));
    } finally {
      await admin.query('ROLLBACK');
    }
  }
  assert.equal((await inspect('sql100')).already_applied, true);
}));
