/**
 * Production tool for SQL 103 (scripts/deployment-guard/sql103-share-library-trigger-acl-
 * production-apply.mjs on lib/release-sql-production-apply.mjs and
 * lib/release-sql-production-cli.mjs). release-sql90-97-production-apply.test.mjs runs every
 * release key (SQL 103 included) through the shared refusals; this file covers SQL 103's own:
 *
 *   - the pin has the release pin shape (plus the recorded inspect fields) and is
 *     execute-authorized (owner approved 2026-10-19): the production pre-state of the read-only
 *     inspect of 2026-10-19 and the staging read-live acceptance; it is in step with the staging
 *     pin (still pending: no staging apply), the one-shot (runs_before sql29) and the bypass
 *     inventory;
 *   - the order: immediately before SQL 29 (pin order_note, runbook, one-shot), no plan entry
 *     (like SQL 29 / SQL 30 it holds no Lambda member);
 *   - the committed pin evaluates for the manifest built from it; its pre-authorization state
 *     (pending() copy) and an execute-false copy refuse before connecting.
 * The PostgreSQL 16 inspect / apply (then SQL 29) is aws/tests/sql103-share-library-trigger-acl-pg.test.mjs.
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
  evaluateReleaseProductionApply,
  executeReleaseProductionApply,
  loadReleaseProductionPin,
  precheckReleaseProductionApply,
  readPinnedReleaseSql,
} from '../../scripts/deployment-guard/lib/release-sql-production-apply.mjs';
import { loadLibraryProductionPin } from '../../scripts/deployment-guard/lib/sql29-sql30-library-production-apply.mjs';
import { main } from '../../scripts/deployment-guard/sql103-share-library-trigger-acl-production-apply.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql103';
const SQL103_FILE = 'aws/workflows/sql/103_share_library_trigger_acl.sql';
const COMMITTED = loadReleaseProductionPin(KEY, ROOT);
const SQL96_PIN = loadReleaseProductionPin('sql96', ROOT);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PRE = 'e'.repeat(64);
// Production read-only inspect of 2026-10-19 (SSM 1b740312-6e58-4412-9464-feac28e6bdf1, main 03e238afb).
const PRODUCTION_PRE = 'bade6813d689c91e3c8e39e33203e64eca23cc363f557062a7669407a01d5b9c';
// Staging guarded executor read-live run (already_applied true; no staging apply).
const STAGING_ACCEPTANCE_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/39188618156';
// The fields the recorded inspect adds to the engine pin shape.
const RECORDED_EXTRA_KEYS = Object.freeze([
  'production_inspect.source_tarball_sha256',
  'production_inspect.runner',
  'production_inspect.already_applied',
  'production_inspect.prerequisites_missing',
  'production_inspect.successors_applied',
  'staging_acceptance.production_differs',
]);
/** The pre-authorization state of the committed pin (explicit copy). */
const pending = (pin = COMMITTED) => Object.freeze({
  ...pin,
  authorization: 'pending',
  execute: false,
  expected_live_definition_sha256: null,
  staging_acceptance: { ok: false, reference: null, basis: 'Pending' },
});
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const keyPaths = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? keyPaths(v, `${p}${k}.`) : [`${p}${k}`]));
const neverConnect = async () => { throw new Error('should-not-connect'); };
const consumedPath = () => path.join(os.tmpdir(), `sql103-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

function manifest(pin) {
  const live = pin.expected_live_definition_sha256;
  const fingerprint = { sql: live };
  const workstream = `prod-${KEY}-release-test`;
  return {
    workstream_id: workstream,
    branch: 'main',
    commit: 'a'.repeat(40),
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
    build_timestamp: '2026-10-19T20:00:00.000Z',
  };
}

test('pin: the release pin shape, execute-authorized, in step with the staging pin, the one-shot and the inventory', () => {
  const pin = COMMITTED;
  const staging = STAGING[KEY];
  const shape = new Set(keyPaths(SQL96_PIN));
  assert.deepEqual([...shape].filter((k) => !keyPaths(pin).includes(k)), [], 'lacks the engine pin shape');
  assert.deepEqual(keyPaths(pin).filter((k) => !shape.has(k)), [...RECORDED_EXTRA_KEYS]);
  assert.equal(pin.id, RELEASE_SQL_SPECS[KEY].production_pin_rel.split('/').pop().replace(/\.json$/, ''));
  assert.equal(pin.migration, KEY);
  // Execute-authorized by the owner-approved, reviewed pin change of 2026-10-19.
  assert.equal(pin.execute, true);
  assert.match(pin.authorization, /^Owner approved 2026-10-19 /);
  assert.ok(pin.authorization.includes(`${PRODUCTION_PRE} -> ${pin.intended_replacement_sha256}`));
  assert.match(pin.authorization, /each apply still needs the owner's run-time approval/);
  assert.equal(pin.expected_live_definition_sha256, PRODUCTION_PRE);
  assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
  // The recorded read-only production inspect.
  const inspect = pin.production_inspect;
  assert.equal(inspect.status, 'recorded');
  assert.equal(inspect.date, '2026-10-19');
  assert.equal(inspect.ssm_command_id, '1b740312-6e58-4412-9464-feac28e6bdf1');
  assert.equal(inspect.source_commit, '03e238afb0fab0be09b6c09f1bd3c812375c3717');
  assert.equal(inspect.source_tarball_sha256, '1493cf711bb233c6fefc273d93aff0bf28b3c1b34ecf4e4247d161410f1ea4ff');
  assert.equal(inspect.runner, 'i-0c35557c4e5385406');
  assert.equal(inspect.read_only, true);
  assert.equal(inspect.connected_as, 'checksops_admin');
  assert.equal(inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.equal(inspect.already_applied, false);
  assert.deepEqual(inspect.precondition_failures, []);
  assert.deepEqual(inspect.prerequisites_missing, []);
  assert.deepEqual(inspect.successors_applied, []);
  assert.equal(inspect.apply_preconditions_met, false, 'no pre-state was recorded at inspect time');
  // Staging acceptance: the guarded staging read-live (already in place there; no staging apply).
  assert.equal(pin.staging_acceptance.ok, true);
  assert.equal(pin.staging_acceptance.reference, STAGING_ACCEPTANCE_REF);
  assert.match(pin.staging_acceptance.basis, /read-live of sql103-share-library-trigger-acl, run 39188618156/);
  assert.match(pin.staging_acceptance.basis, /deploy run 39188486411, executor package CodeSha256 jJioB\/XfKHPR0FgWuzGcah3QpYTa64h4Frue6QsQYQ8=/);
  assert.match(pin.staging_acceptance.basis, /already_applied true, precondition_failures \[\]/);
  assert.match(pin.staging_acceptance.basis, /no staging apply was needed or run/);
  assert.ok(pin.staging_acceptance.basis.includes(pin.intended_replacement_sha256));
  assert.ok(pin.staging_acceptance.production_differs.includes(PRODUCTION_PRE));
  // The staging pin stays pending: no staging apply.
  assert.equal(staging.execute, false);
  assert.equal(staging.authorization, 'pending');
  assert.equal(staging.expected_live_definition_sha256, null);
  assert.equal(pin.filename, SQL103_FILE);
  assert.equal(pin.source_sha256, staging.source_sha256);
  assert.equal(pin.staging_pin_commit, staging.commit);
  assert.equal(pin.intended_replacement_sha256, staging.intended_replacement_sha256);
  assert.equal(pin.intended_replacement_sha256, '4b909c5929f0357ef442a1b2ebcb6bf8312e93be257010ed8a32072accf02aae');
  assert.deepEqual(pin.function_identities, [...staging.function_identities]);
  assert.deepEqual(pin.predecessors, []);
  assert.equal(pin.authorization_phrase, 'APPLY_SHARE_LIBRARY_TRIGGER_ACL');
  for (const k of ['admin_login', 'rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(pin[k], SQL96_PIN[k], k);
  assert.equal(pin.tooling.status, 'built');
  assert.equal(pin.tooling.production_tool, RELEASE_PRODUCTION[KEY].cli);
  assert.equal(pin.tooling.production_tool, 'scripts/deployment-guard/sql103-share-library-trigger-acl-production-apply.mjs');
  assert.equal(pin.tooling.staging_workflow_choice, RELEASE_SQL_SPECS[KEY].choice);
  assert.equal(pin.tooling.one_shot_migration, KEY);
  assert.equal(pin.tooling.runbook, 'ops/production-sql-103-apply.md');
  for (const file of [pin.tooling.production_tool, pin.tooling.runbook, pin.tooling.fingerprint_engine, pin.tooling.production_lib, ...pin.tooling.tests]) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), file);
  }
  assert.equal(readPinnedReleaseSql(KEY, ROOT, pin).ok, true);
  // One-shot: the release tool with its order (no hash in the registry).
  const tool = ONE_SHOT_TOOLS[KEY];
  assert.equal(tool.key, KEY);
  assert.equal(tool.script, RELEASE_PRODUCTION[KEY].cli);
  assert.deepEqual([...tool.args], []);
  assert.equal(tool.pin_rel, RELEASE_PRODUCTION[KEY].pin_rel);
  assert.equal(tool.allowed_key, 'sql103_production_apply_allowed');
  assert.deepEqual([...tool.runs_before], ['sql29']);
  assert.deepEqual([...tool.runs_before], RELEASE_SQL_SPECS[KEY].runs_before);
  assert.ok(Object.hasOwn(ONE_SHOT_TOOLS, 'sql29'));
  assert.equal(tool.inspect_requires, undefined);
  assert.doesNotMatch(JSON.stringify(tool), /[0-9a-f]{64}/);
  const rows = JSON.stringify(readJson('ops/deployment-guard/bypass-inventory.json'));
  assert.match(rows, /"path":"scripts\/deployment-guard\/sql103-share-library-trigger-acl-production-apply\.mjs","classification":"GUARDED","capabilities":\["sql103-production-apply"\]/);
  assert.match(rows, /sql101, sql102, sql103\)/);
  const scripts = readJson('package.json').scripts;
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/deployment-guard.yml'), 'utf8');
  for (const name of ['aws/tests/release-sql103-executor.test.mjs', 'aws/tests/release-sql103-production-apply.test.mjs']) {
    assert.ok(scripts['test:deployment-guard'].includes(name), name);
    assert.ok(workflow.includes(name), name);
  }
});

test('order: immediately before SQL 29 (unchanged, intended 1271ea9b...); no plan entry, like SQL 29 and SQL 30', () => {
  const sql29 = loadLibraryProductionPin('sql29', ROOT);
  assert.equal(sql29.intended_replacement_sha256, '1271ea9b61ec983f88e911b23c569403979fb5f560880021b58d3b1e57243c79');
  assert.equal(sql29.source_sha256, 'e8d416a58e1920cff27d5d744f0b1b4ff414a866a7eb483bb299bb794c0849be');
  assert.match(COMMITTED.order_note, /^Immediately before SQL 29/);
  assert.match(COMMITTED.order_note, /SQL 103, SQL 29, SQL 30, then SQL 90/);
  const plan = readJson('ops/deployment-guard/production-api-overlay-plan.json');
  for (const file of [SQL103_FILE, sql29.filename]) assert.equal(plan.sql_prerequisites[file], undefined, file);
  assert.ok(!JSON.stringify(plan.members).includes(SQL103_FILE));
  const runbook = fs.readFileSync(path.join(ROOT, COMMITTED.tooling.runbook), 'utf8');
  assert.match(runbook, /SQL 103 → SQL 29 → SQL 30 → SQL 90 → … → SQL 102/);
  assert.ok(runbook.includes(COMMITTED.intended_replacement_sha256));
  assert.ok(runbook.includes(COMMITTED.source_sha256));
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/production-sql-29-30-apply.md'), 'utf8'), /SQL 103 immediately before SQL 29/);
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/production-sql-one-shot.md'), 'utf8'), /\| `sql103` \|/);
});

test('the committed pin allows only the manifest bound to it; its pre-authorization state and an execute-false copy refuse before connecting', async () => {
  // The committed (execute-authorized) pin: the evaluator, loading it from disk, allows the
  // manifest built from it, and the cheap prechecks pass; nothing connects.
  const allowed = await evaluateReleaseProductionApply(KEY, manifest(COMMITTED), { root: ROOT });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(allowed.details.sql103_production_apply_allowed, true);
  assert.equal(allowed.details.expected_live_definition_sha256, PRODUCTION_PRE);
  assert.equal(allowed.details.staging_acceptance, STAGING_ACCEPTANCE_REF);
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(COMMITTED), { root: ROOT, connect: neverConnect, consumedPath: consumedPath() })).ok, true);
  // A manifest with another live hash, or another staging reference, is refused.
  const otherLive = { ...manifest(COMMITTED), expected_live_definition_sha256: PRE, live_definition_sha256: PRE };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherLive, { root: ROOT })).code, CODES.SQL_COLLISION);
  const otherStaging = { ...manifest(COMMITTED), staging_acceptance: { ok: true, reference: STAGING_REF } };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherStaging, { root: ROOT })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await precheckReleaseProductionApply(KEY, { ...manifest(COMMITTED), authorization_phrase: 'APPLY' }, { root: ROOT, consumedPath: consumedPath() })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);

  // The pre-authorization state (explicit pending() copy) refuses.
  const locked = pending();
  const noPre = await evaluateReleaseProductionApply(KEY, manifest({ ...locked, expected_live_definition_sha256: PRE }), { root: ROOT, pin: locked });
  assert.equal(noPre.code, CODES.SQL_COLLISION);
  const withPre = { ...locked, expected_live_definition_sha256: PRE };
  assert.equal((await evaluateReleaseProductionApply(KEY, manifest(withPre), { root: ROOT, pin: withPre })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  // Approved and accepted, but execute false: refused before connecting.
  const approved = Object.freeze({ ...withPre, authorization: 'Owner approved test fixture', staging_acceptance: { ok: true, reference: STAGING_REF, basis: 'test fixture' } });
  assert.equal((await evaluateReleaseProductionApply(KEY, manifest(approved), { root: ROOT, pin: approved })).ok, true);
  const ctx = { root: ROOT, pin: approved, connect: neverConnect, consumedPath: consumedPath() };
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(approved), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  assert.equal((await executeReleaseProductionApply(KEY, manifest(approved), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  // A tampered file hash is a reconciliation stop.
  assert.equal(readPinnedReleaseSql(KEY, ROOT, { ...COMMITTED, source_sha256: 'f'.repeat(64) }).code, CODES.SQL_COLLISION);
  // CLI: --apply with the committed pin and a manifest not bound to its recorded pre-state
  // refuses without connecting or spending a receipt.
  const file = path.join(os.tmpdir(), `sql103-cli-${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify(otherLive));
  const writes = [];
  let spent = 0;
  const orig = { out: process.stdout.write, err: process.stderr.write };
  process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
  try {
    await main(['--apply', '--input', file], { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' }, {
      root: ROOT, consumeReceiptOnce: () => { spent += 1; return { ok: true }; }, connect: neverConnect, consumedPath: consumedPath(),
    });
    await main(['--inspect', '--password', 'x'], {}, { root: ROOT, connect: neverConnect });
  } finally {
    process.stdout.write = orig.out;
    process.stderr.write = orig.err;
    fs.rmSync(file, { force: true });
  }
  const out = writes.join('');
  assert.equal(spent, 0);
  assert.doesNotMatch(out, /should-not-connect/);
  assert.match(out, /SQL_COLLISION|PRODUCTION_APPROVAL_REQUIRED|DEPLOYMENT_GUARD_REQUIRED/);
  assert.match(out, /credential flags are refused/);
});
