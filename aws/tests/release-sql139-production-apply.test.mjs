/**
 * Production tool for SQL 139 (scripts/deployment-guard/sql139-tenant-billing-accounts-write-policy-reconcile-
 * production-apply.mjs on lib/release-sql-production-apply.mjs and lib/release-sql-production-cli.mjs).
 * release-sql90-97-production-apply.test.mjs runs every release key (SQL 139 included) through the shared
 * refusals; this file covers SQL 139's own:
 *
 *   - the pin has the release pin shape; it is execute-authorized (owner-approved pin change of 2026-11-02)
 *     with the recorded production pre-state (read-only inspect, recorded as read: not derivable; the same one
 *     staging had) and the staging apply as its acceptance; it is in step with the staging pin, the one-shot,
 *     the bypass inventory and the test lists;
 *   - no predecessor; no function; the one SQL 24 policy on tenant_billing_accounts; no table, view, trigger, drop
 *     or grant; no overlay plan entry; the runbook, one-shot doc and README name it;
 *   - the pending (pre-authorization) pin refuses before connecting; the committed pin allows only the manifest
 *     bound to its recorded pre-state; an approved, accepted copy evaluates for the manifest built from
 *     it, and refuses with execute false, another live hash, another staging reference or a wrong phrase; the CLI
 *     spends no receipt.
 * The behaviour on PostgreSQL 16 is aws/tests/sql139-billing-write-policy-pg.test.mjs; the executor path is
 * aws/tests/release-sql139-executor.test.mjs.
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
import { RELEASE_SQL_SPECS, releaseIntendedHash } from '../../scripts/deployment-guard/lib/release-sql-state.mjs';
import {
  RELEASE_PRODUCTION,
  evaluateReleaseProductionApply,
  executeReleaseProductionApply,
  loadReleaseProductionPin,
  precheckReleaseProductionApply,
  readPinnedReleaseSql,
} from '../../scripts/deployment-guard/lib/release-sql-production-apply.mjs';
import { main } from '../../scripts/deployment-guard/sql139-tenant-billing-accounts-write-policy-reconcile-production-apply.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql139';
const SQL139_FILE = 'aws/workflows/sql/139_tenant_billing_accounts_write_policy_reconcile.sql';
const COMMITTED = loadReleaseProductionPin(KEY, ROOT);
const SQL96_PIN = loadReleaseProductionPin('sql96', ROOT);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PRE = 'e'.repeat(64);
// SQL 139's recorded production pre-state (read-only inspect of 2026-11-02, SSM 5eb60937, main 0984b4049): the
// drifted aws_write_tenant_billing_accounts as that inspect read it; staging recorded the same pre-state (read-live
// run 41367825238).
const PRODUCTION_PRE = '8727ecb1f834f9623c1ea7f568621f64a4212dadf3d28a5a7741a6a542cdb22f';
// The guarded staging apply (wave 35).
const STAGING_ACCEPTANCE_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/41369892057';
const OWNER_WORDS = Object.freeze(['"record the SQL 139 staging pin"', '"apply SQL 139 in staging"', '"It saved, record SQL 139 staging"', '"start the SQL runner for the SQL 139 production inspect"', '"record the SQL 139 production pin"']);
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const readJson = (rel) => JSON.parse(read(rel));
const keyPaths = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? keyPaths(v, `${p}${k}.`) : [`${p}${k}`]));
const neverConnect = async () => { throw new Error('should-not-connect'); };
const consumedPath = () => path.join(os.tmpdir(), `sql139-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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
    build_timestamp: '2026-10-31T00:00:00.000Z',
  };
}
/** An approved, accepted copy of the committed pin with a recorded pre-state (test only). */
const approved = (extra = {}) => Object.freeze({
  ...COMMITTED,
  authorization: 'Owner approved test fixture',
  execute: true,
  expected_live_definition_sha256: PRE,
  staging_acceptance: { ok: true, reference: STAGING_REF, basis: 'test fixture' },
  ...extra,
});


test('pin: the release pin shape, execute-authorized on the staging apply, in step with the staging pin, the one-shot, the inventory and the test lists', () => {
  const pin = COMMITTED;
  const staging = STAGING[KEY];
  const shape = new Set(keyPaths(SQL96_PIN).filter((k) => !/^(applied|production_evidence)(\.|$)/.test(k)));
  assert.deepEqual([...shape].filter((k) => !keyPaths(pin).includes(k)), [], 'lacks the engine pin shape');
  assert.deepEqual(keyPaths(pin).filter((k) => !shape.has(k)), []);
  assert.equal(pin.id, RELEASE_SQL_SPECS[KEY].production_pin_rel.split('/').pop().replace(/\.json$/, ''));
  assert.equal(pin.migration, KEY);
  // Owner-approved pin change of 2026-11-02: the read-only production inspect (SSM 5eb60937, main 0984b4049)
  // recorded as the pre-state; the staging apply (run 41369892057) as the acceptance. The owner's words so far name
  // the staging steps, the inspect and this pin: the production apply still needs the owner's words for that run.
  assert.equal(pin.execute, true);
  assert.match(pin.authorization, /^Owner approved 2026-11-02 /);
  for (const words of OWNER_WORDS) assert.ok(pin.authorization.includes(words), words);
  assert.match(pin.authorization, /none of them words for the production apply/);
  assert.ok(pin.authorization.includes(`${PRODUCTION_PRE} -> ${pin.intended_replacement_sha256}`));
  assert.match(pin.authorization, /execute true takes effect only when the owner reviews and merges this change\. It does not itself run or approve a run/);
  assert.match(pin.authorization, /each apply still needs the owner's run-time approval/);
  assert.equal(pin.expected_live_definition_sha256, PRODUCTION_PRE);
  assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
  assert.equal(pin.applied, undefined);
  assert.equal(pin.production_inspect.status, 'recorded');
  assert.equal(pin.production_inspect.date, '2026-11-02');
  assert.equal(pin.production_inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.production_inspect.ssm_command_id, '5eb60937-5d3d-4196-93b8-bd874aac63db');
  assert.equal(pin.production_inspect.source_commit, '0984b4049b3b02d28b0d602d4d62dbbd4cc21d22');
  assert.equal(pin.production_inspect.read_only, true);
  assert.equal(pin.production_inspect.connected_as, 'checksops_admin');
  assert.equal(pin.production_inspect.apply_preconditions_met, false);
  assert.deepEqual(pin.production_inspect.precondition_failures, []);
  assert.ok(pin.production_inspect.note.includes('3f0588a912f05605b93098573641f89b0eab7cde90bcae2296ee1bf1b7e8c46d'));
  assert.ok(pin.production_inspect.note.includes(`migration source sha256 on the runner ${pin.source_sha256} == source_sha256`));
  assert.match(pin.production_inspect.note, /policy tenant_billing_accounts aws_write_tenant_billing_accounts different; counts billing_table_rls_enabled 1, billing_write_policy_permissive_all 1, billing_job_policy_intact 1; prerequisites_missing \[\]/);
  assert.match(pin.production_inspect.note, /If already_applied is true, or precondition_failures is not \[\], stop/);
  assert.ok(pin.production_inspect.note.includes(' Earlier: Pending: no read-only production inspect has been run for SQL 139.'));
  for (const word of ['prerequisites_missing', 'already_applied', 'billing_table_rls_enabled', 'billing_write_policy_permissive_all', 'billing_job_policy_intact', 'Production is unverified']) {
    assert.ok(pin.production_inspect.note.includes(word), word);
  }
  for (const code of ['sql139_table_missing', 'sql139_rls_disabled', 'sql139_write_policy_missing', 'sql139_write_policy_shape', 'sql139_job_policy_missing',
    'sql139_job_policy_collision', 'aws_monthly_billing_job()', 'The production pre-state cannot be derived', '8c72ef93d1e5']) {
    assert.ok(pin.order_note.includes(code), code);
  }
  assert.deepEqual([pin.staging_acceptance.ok, pin.staging_acceptance.reference], [true, STAGING_ACCEPTANCE_REF]);
  assert.match(pin.staging_acceptance.basis, /^Guarded staging SQL executor apply of sql139-tenant-billing-accounts-write-policy-reconcile, run 41369892057/);
  assert.match(pin.staging_acceptance.basis, /deploy run 41369655188/);
  assert.match(pin.staging_acceptance.basis, /Read-live run 41370841522 then reported already_applied true/);
  assert.match(pin.staging_acceptance.basis, /"It saved, record SQL 139 staging"/);
  assert.ok(pin.staging_acceptance.basis.includes(`before ${PRODUCTION_PRE}, after ${pin.intended_replacement_sha256} == intended`));
  assert.deepEqual(Object.keys(pin.staging_acceptance).sort(), ['basis', 'ok', 'reference']);
  // The staging pin recorded the same pre-state (wave 35): the drifted write policy in both environments.
  assert.equal(staging.expected_live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.expected_live_definition_sha256, staging.expected_live_definition_sha256);
  assert.equal(pin.filename, SQL139_FILE);
  assert.equal(pin.source_sha256, staging.source_sha256);
  assert.equal(pin.staging_pin_commit, staging.commit);
  assert.equal(pin.intended_replacement_sha256, staging.intended_replacement_sha256);
  assert.equal(pin.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(pin.intended_replacement_sha256, releaseIntendedHash(KEY, read(SQL139_FILE)));
  assert.deepEqual(pin.function_identities, []);
  assert.deepEqual(pin.function_identities, [...staging.function_identities]);
  assert.deepEqual(pin.predecessors, []);
  assert.deepEqual(pin.predecessors, RELEASE_SQL_SPECS[KEY].predecessors);
  assert.equal(pin.authorization_phrase, 'APPLY_TENANT_BILLING_ACCOUNTS_WRITE_POLICY_RECONCILE');
  for (const k of ['admin_login', 'rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(pin[k], SQL96_PIN[k], k);
  assert.equal(pin.tooling.status, 'built');
  assert.equal(pin.tooling.production_tool, RELEASE_PRODUCTION[KEY].cli);
  assert.equal(pin.tooling.production_tool, 'scripts/deployment-guard/sql139-tenant-billing-accounts-write-policy-reconcile-production-apply.mjs');
  assert.equal(pin.tooling.staging_workflow_choice, RELEASE_SQL_SPECS[KEY].choice);
  assert.equal(pin.tooling.one_shot_migration, KEY);
  assert.equal(pin.tooling.runbook, 'ops/production-sql-139-apply.md');
  for (const file of [pin.tooling.production_tool, pin.tooling.runbook, pin.tooling.fingerprint_engine, pin.tooling.production_lib, ...pin.tooling.tests]) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), file);
  }
  assert.equal(readPinnedReleaseSql(KEY, ROOT, pin).ok, true);
  const tool = ONE_SHOT_TOOLS[KEY];
  assert.equal(tool.key, KEY);
  assert.equal(tool.script, RELEASE_PRODUCTION[KEY].cli);
  assert.deepEqual([...tool.args], []);
  assert.equal(tool.pin_rel, RELEASE_PRODUCTION[KEY].pin_rel);
  assert.equal(tool.allowed_key, 'sql139_production_apply_allowed');
  assert.equal(tool.runs_before, undefined);
  assert.equal(tool.inspect_requires, undefined);
  assert.doesNotMatch(JSON.stringify(tool), /[0-9a-f]{64}/);
  const rows = JSON.stringify(readJson('ops/deployment-guard/bypass-inventory.json'));
  assert.match(rows, /"path":"scripts\/deployment-guard\/sql139-tenant-billing-accounts-write-policy-reconcile-production-apply\.mjs","classification":"GUARDED","capabilities":\["sql139-production-apply"\]/);
  assert.match(rows, /sql135, sql136, sql137, sql138, sql139\)/);
  const scripts = readJson('package.json').scripts;
  const workflow = read('.github/workflows/deployment-guard.yml');
  for (const name of ['aws/tests/release-sql139-executor.test.mjs', 'aws/tests/release-sql139-production-apply.test.mjs', 'aws/tests/sql139-billing-write-policy-pg.test.mjs']) {
    assert.ok(scripts['test:deployment-guard'].includes(name), name);
    assert.ok(workflow.includes(name), name);
  }
});

test('order: no predecessor; no function; SQL 24\'s one policy on tenant_billing_accounts; no plan entry; the runbook, one-shot doc and README name it', () => {
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.predecessors, []);
  assert.deepEqual(spec.functions, []);
  assert.deepEqual(spec.policies.map((p) => `${p.table} ${p.name}`), ['public.tenant_billing_accounts aws_write_tenant_billing_accounts']);
  for (const none of ['tables', 'views', 'triggers', 'dropped_functions', 'dropped_policies', 'dropped_triggers', 'added_columns', 'column_acl', 'table_privileges', 'indexes', 'acl_functions']) {
    assert.ok(spec[none] === undefined || spec[none].length === 0, none);
  }
  const plan = readJson('ops/deployment-guard/production-api-overlay-plan.json');
  assert.ok(!JSON.stringify(plan).includes(SQL139_FILE));
  const runbook = read(COMMITTED.tooling.runbook);
  assert.ok(runbook.includes(COMMITTED.intended_replacement_sha256));
  assert.ok(runbook.includes(COMMITTED.source_sha256));
  assert.match(runbook, /\*\*Status:\*\* applied in staging \(wave 35, 2026-11-02\); staging acceptance: owner tested in staging \(the billing account saved\); production pin execute-authorized; not applied to production/);
  assert.match(runbook, /SSM\s+`5eb60937-5d3d-4196-93b8-bd874aac63db`/);
  assert.match(runbook, /"It saved, record SQL 139 staging"/);
  assert.match(runbook, /\*\*Staging apply \(2026-11-02\)\.\*\* Apply run 41369892057/);
  assert.match(runbook, /Read-live run 41370841522/);
  assert.match(runbook, /APPLY_TENANT_BILLING_ACCOUNTS_WRITE_POLICY_RECONCILE/);
  assert.match(runbook, /#1515/);
  const oneShot = read('ops/production-sql-one-shot.md');
  assert.match(oneShot, /\| `sql139` \|/);
  assert.match(oneShot, /`sql136`, `sql137`, `sql138`, `sql139`\) \|/);
  assert.match(read('ops/deployment-guard/README.md'), /sql139-tenant-billing-accounts-write-policy-reconcile-production-apply\.mjs --inspect/);
});

test('the pending (pre-authorization) pin refuses before connecting; the committed pin allows only its own manifest; execute false, other hashes and phrases refuse', async () => {
  // The pin before its owner-approved change: no pre-state, no owner approval, no staging acceptance.
  const PENDING = Object.freeze({ ...COMMITTED, authorization: 'pending', execute: false, expected_live_definition_sha256: null, staging_acceptance: { ok: false, reference: null, basis: 'Pending' } });
  const noPre = await evaluateReleaseProductionApply(KEY, manifest({ ...PENDING, expected_live_definition_sha256: PRE }), { root: ROOT, pin: PENDING });
  assert.equal(noPre.code, CODES.SQL_COLLISION);
  const withPre = { ...PENDING, expected_live_definition_sha256: PRE };
  assert.equal((await evaluateReleaseProductionApply(KEY, manifest(withPre), { root: ROOT, pin: withPre })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await executeReleaseProductionApply(KEY, manifest(withPre), { root: ROOT, pin: withPre, connect: neverConnect, consumedPath: consumedPath() })).ok, false);
  // execute true alone does not authorize it.
  const flipped = { ...withPre, execute: true };
  assert.equal((await evaluateReleaseProductionApply(KEY, manifest(flipped), { root: ROOT, pin: flipped })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);

  // The committed (authorized) pin allows only the manifest bound to its recorded pre-state: not
  // another hash, not the intended state.
  const committedOk = await evaluateReleaseProductionApply(KEY, manifest(COMMITTED), { root: ROOT });
  assert.equal(committedOk.ok, true, JSON.stringify(committedOk));
  assert.equal(committedOk.details.sql139_production_apply_allowed, true);
  assert.equal(committedOk.details.staging_acceptance, STAGING_ACCEPTANCE_REF);
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(COMMITTED), live_definition_sha256: PRE, expected_live_definition_sha256: PRE }, { root: ROOT })).code, CODES.SQL_COLLISION);
  const onIntended = COMMITTED.intended_replacement_sha256;
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(COMMITTED), live_definition_sha256: onIntended, expected_live_definition_sha256: onIntended }, { root: ROOT })).ok, false);

  const pin = approved();
  const allowed = await evaluateReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(allowed.details.sql139_production_apply_allowed, true);
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect: neverConnect, consumedPath: consumedPath() })).ok, true);
  const otherLive = { ...manifest(pin), expected_live_definition_sha256: 'f'.repeat(64), live_definition_sha256: 'f'.repeat(64) };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherLive, { root: ROOT, pin })).code, CODES.SQL_COLLISION);
  const otherStaging = { ...manifest(pin), staging_acceptance: { ok: true, reference: 'https://example.invalid/x' } };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherStaging, { root: ROOT, pin })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await precheckReleaseProductionApply(KEY, { ...manifest(pin), authorization_phrase: 'APPLY_TENANT_BILLING' }, { root: ROOT, pin, consumedPath: consumedPath() })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const off = approved({ execute: false });
  const ctx = { root: ROOT, pin: off, connect: neverConnect, consumedPath: consumedPath() };
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  assert.equal((await executeReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  // A tampered file hash is a reconciliation stop.
  assert.equal(readPinnedReleaseSql(KEY, ROOT, { ...COMMITTED, source_sha256: 'f'.repeat(64) }).code, CODES.SQL_COLLISION);

  // CLI: --apply with the committed pin, read from disk, and a manifest on another pre-state refuses without connecting
  // or spending a receipt; credential flags are refused.
  const file = path.join(os.tmpdir(), `sql139-cli-${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify(manifest(pin)));
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
