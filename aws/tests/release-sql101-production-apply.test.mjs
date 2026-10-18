/**
 * Production tool for SQL 101 (scripts/deployment-guard/sql101-invite-identity-insert-order-
 * production-apply.mjs on lib/release-sql-production-apply.mjs and
 * lib/release-sql-production-cli.mjs). release-sql90-97-production-apply.test.mjs runs every
 * release key (SQL 101 included) through the shared refusals (pending pins, binding, evaluate /
 * precheck, the CLI, the real guard); this file covers SQL 101's own:
 *
 *   - the pin has the SQL 90-97 pin shape and stays execute false / pending; it is in step with
 *     the staging pin, the one-shot and the bypass inventory;
 *   - SQL 101 before tenant-admin.mjs is an operator gate (pin order_note, runbook): the plan's
 *     sql_before still holds tenant-admin.mjs on SQL 90 only;
 *   - on PostgreSQL 16: --inspect is read-only; refused before SQL 90; once SQL 90 is in, one
 *     apply as checksops_admin (the superuser login refused) on the intended fingerprint, then
 *     refused as already in place.
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
import { RELEASE_SQL_SPECS } from '../../scripts/deployment-guard/lib/release-sql-state.mjs';
import {
  RELEASE_PRODUCTION,
  executeReleaseProductionApply,
  inspectReleaseProduction,
  loadReleaseProductionPin,
  readPinnedReleaseSql,
} from '../../scripts/deployment-guard/lib/release-sql-production-apply.mjs';
import { pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql101';
const SQL101_FILE = 'aws/workflows/sql/101_invite_identity_insert_order.sql';
const COMMITTED = loadReleaseProductionPin(KEY, ROOT);
const SQL96_PIN = loadReleaseProductionPin('sql96', ROOT);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const COMMIT = 'a'.repeat(40);
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK|BEGIN READ ONLY)\b/i;
const text = (key) => fs.readFileSync(path.join(ROOT, STAGING[key].filename), 'utf8');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

const keyPaths = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? keyPaths(v, `${p}${k}.`) : [`${p}${k}`]));

const authorized = (live) => Object.freeze({
  ...COMMITTED,
  authorization: 'Owner approved test fixture',
  execute: true,
  expected_live_definition_sha256: live,
  staging_acceptance: { ok: true, reference: STAGING_REF, basis: 'test fixture' },
});
function manifest(pin) {
  const live = pin.expected_live_definition_sha256;
  const fingerprint = { sql: live };
  const workstream = `prod-${KEY}-release-test`;
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
    one_use_id: `${KEY}-prod-${process.pid}-${Math.random().toString(16).slice(2)}`,
    build_timestamp: '2026-10-18T20:00:00.000Z',
  };
}
const consumedPath = () => path.join(os.tmpdir(), `sql101-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

test('pin: the SQL 90-97 pin shape, pending, in step with the staging pin, the one-shot and the inventory', () => {
  const pin = COMMITTED;
  const staging = STAGING[KEY];
  const shape = new Set(keyPaths(SQL96_PIN));
  assert.deepEqual([...shape].filter((k) => !keyPaths(pin).includes(k)), [], 'lacks the engine pin shape');
  assert.deepEqual(keyPaths(pin).filter((k) => !shape.has(k)), []);
  assert.equal(pin.id, RELEASE_SQL_SPECS[KEY].production_pin_rel.split('/').pop().replace(/\.json$/, ''));
  assert.equal(pin.migration, KEY);
  assert.equal(pin.execute, false);
  assert.equal(pin.authorization, 'pending');
  assert.equal(pin.expected_live_definition_sha256, null);
  assert.equal(pin.staging_acceptance.ok, false);
  assert.equal(pin.production_inspect.status, 'pending');
  assert.equal(pin.filename, SQL101_FILE);
  assert.equal(pin.source_sha256, staging.source_sha256);
  assert.equal(pin.staging_pin_commit, staging.commit);
  assert.equal(pin.intended_replacement_sha256, staging.intended_replacement_sha256);
  assert.deepEqual(pin.function_identities, [...staging.function_identities]);
  assert.deepEqual(pin.predecessors, ['sql90']);
  assert.equal(pin.authorization_phrase, 'APPLY_INVITE_IDENTITY_INSERT_ORDER');
  for (const k of ['admin_login', 'rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(pin[k], SQL96_PIN[k], k);
  assert.equal(pin.tooling.status, 'built');
  assert.equal(pin.tooling.production_tool, RELEASE_PRODUCTION[KEY].cli);
  assert.equal(pin.tooling.production_tool, 'scripts/deployment-guard/sql101-invite-identity-insert-order-production-apply.mjs');
  assert.equal(pin.tooling.staging_workflow_choice, RELEASE_SQL_SPECS[KEY].choice);
  assert.equal(pin.tooling.one_shot_migration, KEY);
  for (const file of [pin.tooling.production_tool, pin.tooling.runbook, pin.tooling.fingerprint_engine, pin.tooling.production_lib, ...pin.tooling.tests]) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), file);
  }
  assert.equal(readPinnedReleaseSql(KEY, ROOT, pin).ok, true);
  assert.equal(ONE_SHOT_TOOLS[KEY].script, RELEASE_PRODUCTION[KEY].cli);
  const rows = JSON.stringify(readJson('ops/deployment-guard/bypass-inventory.json'));
  assert.match(rows, /"path":"scripts\/deployment-guard\/sql101-invite-identity-insert-order-production-apply\.mjs","classification":"GUARDED","capabilities":\["sql101-production-apply"\]/);
  assert.match(rows, /sql98, sql99, sql100, sql101\)/);
  const scripts = readJson('package.json').scripts;
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/deployment-guard.yml'), 'utf8');
  for (const name of ['aws/tests/release-sql101-executor.test.mjs', 'aws/tests/release-sql101-production-apply.test.mjs']) {
    assert.ok(scripts['test:deployment-guard'].includes(name), name);
    assert.ok(workflow.includes(name), name);
  }
  const runbook = fs.readFileSync(path.join(ROOT, pin.tooling.runbook), 'utf8');
  assert.match(runbook, /12\. \*\*SQL 101\*\* after SQL 90/);
  assert.match(runbook, new RegExp(`\\| \`sql101\` \\| \`${pin.intended_replacement_sha256}\` \\|`));
});

test('plan: SQL 101 before tenant-admin.mjs is the operator\'s gate; the plan still holds tenant-admin.mjs on SQL 90 only', () => {
  const plan = readJson('ops/deployment-guard/production-api-overlay-plan.json');
  const stagingLive = readJson('ops/deployment-guard/staging-sql-live.json');
  // tenant-admin.mjs (which calls aws_invite_create_user_identity) is held by SQL 90; SQL 101 is
  // not a plan prerequisite, so the pin's order_note and the runbook carry the SQL 101 gate.
  assert.equal(plan.members['tenant-admin.mjs'].sql_before, 'aws/workflows/sql/90_users_only_tenant_roles.sql');
  assert.equal(Object.hasOwn(plan.sql_prerequisites, SQL101_FILE), false);
  assert.equal(Object.hasOwn(stagingLive.sql, SQL101_FILE), false);
  assert.match(COMMITTED.order_note, /before tenant-admin\.mjs/);
  assert.match(COMMITTED.order_note, /operator's gate/);
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
  const fx = await releaseFixture(pg, prefix, port);
  try {
    await fn(fx);
  } finally {
    await fx.close();
  }
}

test('PostgreSQL 16: read-only inspect; refused before SQL 90; one apply as checksops_admin, then already in place', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql101-prod-', 63500, async ({ connectAs, applyPredecessors }) => {
  await applyPredecessors();
  const seen = [];
  const connectWith = (user) => async () => {
    const client = await connectAs(user);
    const query = client.query.bind(client);
    client.query = (sql, params) => { seen.push(String(sql)); return query(sql, params); };
    return client;
  };
  const connect = connectWith('checksops_admin');
  const inspect = async (pin = COMMITTED) => {
    seen.length = 0;
    const inspected = await inspectReleaseProduction(KEY, { connect, pin, root: ROOT });
    assert.equal(inspected.ok, true, JSON.stringify(inspected));
    assert.equal(seen[0], 'BEGIN READ ONLY');
    assert.equal(seen.at(-1), 'ROLLBACK');
    assert.ok(seen.slice(1, -1).every((sql) => READ_ONLY_STATEMENT_RE.test(sql)), JSON.stringify(seen.filter((sql) => !READ_ONLY_STATEMENT_RE.test(sql))));
    assert.doesNotMatch(JSON.stringify(inspected.details), /Private|example\.invalid|checksopsadmin@|11111111-1111/);
    return inspected.details;
  };

  // Before SQL 90.
  let d = await inspect();
  assert.equal(d.read_only, true);
  assert.equal(d.pin_execute, false);
  assert.ok(d.precondition_failures.includes('predecessors_applied'), JSON.stringify(d.precondition_failures));
  let pin = authorized(d.live_definition_sha256);
  const early = await executeReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(early.code, CODES.DEPLOYMENT_COLLISION, JSON.stringify(early));
  assert.ok(early.details.failed.includes('predecessors_applied'));

  const owner = await connectAs('checksops_admin');
  try {
    await owner.query(text('sql90'));
  } finally {
    await owner.end();
  }
  d = await inspect();
  assert.deepEqual(d.precondition_failures, [], JSON.stringify(d.release_sql_inspect));
  assert.equal(d.already_applied, false);
  assert.equal(d.apply_preconditions_met, false, 'no recorded pre-state');
  assert.equal(d.production_noop, undefined);
  pin = authorized(d.live_definition_sha256);
  const asSuper = await executeReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect: connectWith('ubuntu'), consumedPath: consumedPath() });
  assert.equal(asSuper.code, CODES.DEPLOYMENT_COLLISION);
  assert.ok(asSuper.details.failed.includes('login_is_pinned_admin'));
  const applied = await executeReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.after_hash, pin.intended_replacement_sha256);
  assert.equal((await inspect(pin)).already_applied, true);
  const replay = await executeReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(replay.code, CODES.UNRELATED_MUTATION);
}));
