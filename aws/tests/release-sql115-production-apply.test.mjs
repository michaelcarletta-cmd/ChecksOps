/**
 * Production tool for SQL 115 (scripts/deployment-guard/sql115-provider-stakeholder-one-partner-
 * payout-production-apply.mjs on lib/release-sql-production-apply.mjs and
 * lib/release-sql-production-cli.mjs). release-sql90-97-production-apply.test.mjs runs every
 * release key (SQL 115 included) through the shared refusals; this file covers SQL 115's own:
 *
 *   - the pin has the release pin shape plus the applied record; it was execute-authorized (owner-
 *     approved pin change of 2026-10-27, #1290) with the production pre-state recorded after SQL 119
 *     and the staging apply (whose pre-state differs only in the EXECUTE ACL) as its acceptance, then
 *     applied on 2026-10-27 and retired (execute false); it is in step with the staging pin, the
 *     one-shot (no runs_before), the bypass inventory and the test lists;
 *   - no predecessor; the function it replaces is the restored supabase one, still fired by the
 *     same triggers; the runbook and the one-shot doc name it;
 *   - the pending (pre-authorization) pin refuses before connecting; the committed (retired) pin
 *     refuses and its authorized copy allows only the manifest bound to its recorded pre-state; an approved, accepted copy evaluates for the
 *     manifest built from it, and refuses with execute false, another live hash, another staging
 *     reference or a wrong phrase; the CLI spends no receipt.
 * The PostgreSQL 16 inspect / apply is aws/tests/sql115-provider-stakeholder-one-partner-payout-pg.test.mjs.
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
import { main } from '../../scripts/deployment-guard/sql115-provider-stakeholder-one-partner-payout-production-apply.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql115';
const SQL115_FILE = 'aws/workflows/sql/115_provider_stakeholder_one_partner_payout.sql';
const COMMITTED = loadReleaseProductionPin(KEY, ROOT);
const SQL96_PIN = loadReleaseProductionPin('sql96', ROOT);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PRE = 'e'.repeat(64);
// SQL 115's recorded production pre-state (read-only inspect of 2026-10-27 after SQL 119, SSM 6f6692d8,
// main a01deea9b): the restored supabase body, EXECUTE for the owner only.
const PRODUCTION_PRE = 'ee9d2d5222dd9f8850173384b13468154fa03def6487824c3ef378db4874775b';
// Production before SQL 119 (EXECUTE also for PUBLIC and checksops) and staging before its apply.
const PRODUCTION_BEFORE_SQL119 = '83d480ac50c23dbbe7c796a32be579aa69e25c4c020d00ecf171980a6b95cd6e';
const STAGING_PRE = '6dbf58792a5eb0f9863ac0a6e88265de6ec9931a9e7a31bac21d7b71f643bba0';
// The guarded staging apply of 2026-10-25.
const STAGING_ACCEPTANCE_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/40243363235';
const OWNER_WORDS = '"Approve a pin PR for SQL 119, then one for SQL 115"';
// SQL 115's production apply of 2026-10-27 (main 40678dc44), recorded in applied. The owner's words
// "AWS reconnected, apply SQL 115 in production" were passed to the run verbatim.
const SQL115_APPLIED = Object.freeze({ ssm: 'bf96510f-4f95-42d5-974b-cf99d9a952ac', run: '250cdbb8-0e46-42c8-a4a8-4a9a646ff07a', one_use_id: 'sql115-prod-2ee1c7dd-6d5b-4f25-a4ce-19a1a64be13e', commit: '40678dc44b8de71ceb3ca2c48a21cae480327cea', approval: 'AWS reconnected, apply SQL 115 in production', workstream: 'prod-sql115-provider-stakeholder-one-partner-payout-20261027' });
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const keyPaths = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? keyPaths(v, `${p}${k}.`) : [`${p}${k}`]));
const neverConnect = async () => { throw new Error('should-not-connect'); };
const consumedPath = () => path.join(os.tmpdir(), `sql115-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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
    build_timestamp: '2026-10-25T20:00:00.000Z',
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

test('pin: the release pin shape, applied and retired (owner approved 2026-10-27, on the staging apply), in step with the staging pin, the one-shot, the inventory and the test lists', () => {
  const pin = COMMITTED;
  const staging = STAGING[KEY];
  const shape = new Set(keyPaths(SQL96_PIN).filter((k) => !/^(applied|production_evidence)(\.|$)/.test(k)));
  assert.deepEqual([...shape].filter((k) => !keyPaths(pin).includes(k)), [], 'lacks the engine pin shape');
  // The record-and-retire change adds applied and production_evidence on top of the engine pin shape.
  assert.deepEqual(keyPaths(pin).filter((k) => !shape.has(k) && !/^(applied|production_evidence)\./.test(k)), []);
  assert.equal(pin.id, RELEASE_SQL_SPECS[KEY].production_pin_rel.split('/').pop().replace(/\.json$/, ''));
  assert.equal(pin.migration, KEY);
  // Owner-approved pin change of 2026-10-27: the read-only production inspect after SQL 119 (SSM
  // 6f6692d8, main a01deea9b) recorded as the pre-state; the staging apply (run 40243363235).
  // Applied 2026-10-27 and retired.
  assert.equal(pin.execute, false);
  assert.match(pin.authorization, /^Applied to production on 2026-10-27; execute is false again/);
  assert.doesNotMatch(pin.authorization, /^Owner approved/);
  assert.ok(pin.authorization.includes(OWNER_WORDS));
  assert.ok(pin.authorization.includes('"Merge the SQL 115 pin PR when green"'));
  assert.ok(pin.authorization.includes(`"${SQL115_APPLIED.approval}"`));
  assert.ok(pin.authorization.includes('#1290'));
  assert.ok(pin.authorization.includes(SQL115_APPLIED.workstream));
  assert.equal(pin.applied.date, '2026-10-27');
  assert.equal(pin.applied.result, 'applied');
  assert.equal(pin.applied.apply_ssm_command_id, SQL115_APPLIED.ssm);
  assert.equal(pin.applied.one_shot_run_id, SQL115_APPLIED.run);
  assert.equal(pin.applied.one_use_id, SQL115_APPLIED.one_use_id);
  assert.equal(pin.applied.one_use_id_consumed, true);
  assert.equal(pin.applied.workstream_id, SQL115_APPLIED.workstream);
  assert.equal(pin.applied.source_commit, SQL115_APPLIED.commit);
  assert.equal(pin.applied.source_tarball.sha256, '00a482aee47dfaa5001e7f68b9bd57cfb17b6bcbfa1b7e983e933ef8720f27b4');
  assert.equal(pin.applied.migration_source_sha256, pin.source_sha256);
  assert.equal(pin.applied.owner_approval, SQL115_APPLIED.approval);
  assert.ok(pin.applied.owner_approval_basis.includes(`"${SQL115_APPLIED.approval}"`));
  assert.equal(pin.applied.manifest_sha256, '6b076bf0c6895df7cb85e3cb318e758cdcb2a11dd6b8a4af701ba78a34a18f66');
  assert.equal(pin.applied.pre_apply_inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.applied.receipt.before_hash, PRODUCTION_PRE);
  assert.equal(pin.applied.receipt.after_hash, pin.intended_replacement_sha256);
  assert.equal(pin.applied.receipt.workstream, SQL115_APPLIED.workstream);
  assert.equal(pin.applied.receipt.staging_acceptance, pin.staging_acceptance.reference);
  assert.equal(pin.applied.receipt.unrelated_catalog_sha256, '7bebf20193526296a7dd20a319999fdec2eb1e36d8b99a533a86fcdcb7222ac1');
  assert.equal(pin.applied.receipt.result, 'applied');
  assert.equal(pin.applied.post_apply_inspect.already_applied, true);
  assert.equal(pin.applied.post_apply_inspect.live_definition_sha256, pin.intended_replacement_sha256);
  assert.deepEqual(pin.applied.post_apply_inspect.precondition_failures, []);
  assert.equal(pin.applied.later_inspect, undefined);
  assert.ok(pin.production_evidence['2026-10-27 apply'].includes(SQL115_APPLIED.ssm));
  assert.equal(pin.expected_live_definition_sha256, PRODUCTION_PRE);
  assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
  assert.equal(pin.production_inspect.status, 'recorded');
  assert.equal(pin.production_inspect.date, '2026-10-27');
  assert.equal(pin.production_inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.production_inspect.ssm_command_id, '6f6692d8-3801-4b70-b51c-dd9749e723b4');
  assert.equal(pin.production_inspect.source_commit, 'a01deea9b89154f79e2ba40d2de0d050c064806a');
  assert.equal(pin.production_inspect.read_only, true);
  assert.equal(pin.production_inspect.connected_as, 'checksops_admin');
  assert.equal(pin.production_inspect.apply_preconditions_met, false);
  assert.deepEqual(pin.production_inspect.precondition_failures, []);
  assert.ok(pin.production_inspect.note.includes('77e9e5d3f967ce8259518e6fcf1c64af8fb6c50c6b1fe8b44dce489bc0f70f07'));
  assert.ok(pin.production_inspect.note.includes(`migration source sha256 on the runner ${pin.source_sha256} == source_sha256`));
  assert.ok(pin.production_inspect.note.includes(PRODUCTION_BEFORE_SQL119));
  assert.ok(pin.production_inspect.note.includes(' Earlier: Pending: '));
  assert.match(pin.production_inspect.note, /If already_applied is true, or precondition_failures is not \[\], stop/);
  assert.match(pin.order_note, /SQL 115 runs immediately after SQL 119\.$/);
  // Staging acceptance: the guarded staging apply; its pre-state differs only in the EXECUTE ACL.
  assert.deepEqual([pin.staging_acceptance.ok, pin.staging_acceptance.reference], [true, STAGING_ACCEPTANCE_REF]);
  assert.match(pin.staging_acceptance.basis, /^Guarded staging apply of sql115-provider-stakeholder-one-partner-payout, run 40243363235/);
  assert.match(pin.staging_acceptance.basis, /result applied/);
  assert.ok(pin.staging_acceptance.basis.includes(`before ${STAGING_PRE}, after ${pin.intended_replacement_sha256}`));
  assert.match(pin.staging_acceptance.basis, /The pre-states differ only in the function's EXECUTE ACL/);
  assert.match(pin.staging_acceptance.basis, /already_applied true/);
  assert.deepEqual(Object.keys(pin.staging_acceptance).sort(), ['basis', 'ok', 'reference']);
  // The staging pin's recorded pre-state is the staging apply's before hash.
  assert.equal(staging.expected_live_definition_sha256, STAGING_PRE);
  assert.equal(pin.filename, SQL115_FILE);
  assert.equal(pin.source_sha256, staging.source_sha256);
  assert.equal(pin.staging_pin_commit, staging.commit);
  assert.equal(pin.intended_replacement_sha256, staging.intended_replacement_sha256);
  assert.equal(pin.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(pin.intended_replacement_sha256, '8aed39a49d988a60bdedac07a3a97f424a9de5c1499e4f50738f749326a62452');
  assert.deepEqual(pin.function_identities, ['public.sync_provider_stakeholder_account(uuid)']);
  assert.deepEqual(pin.function_identities, [...staging.function_identities]);
  assert.deepEqual(pin.predecessors, []);
  assert.deepEqual(pin.predecessors, RELEASE_SQL_SPECS[KEY].predecessors);
  assert.equal(pin.authorization_phrase, 'APPLY_PROVIDER_STAKEHOLDER_ONE_PARTNER_PAYOUT');
  for (const k of ['admin_login', 'rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(pin[k], SQL96_PIN[k], k);
  assert.equal(pin.tooling.status, 'built');
  assert.equal(pin.tooling.production_tool, RELEASE_PRODUCTION[KEY].cli);
  assert.equal(pin.tooling.production_tool, 'scripts/deployment-guard/sql115-provider-stakeholder-one-partner-payout-production-apply.mjs');
  assert.equal(pin.tooling.staging_workflow_choice, RELEASE_SQL_SPECS[KEY].choice);
  assert.equal(pin.tooling.one_shot_migration, KEY);
  assert.equal(pin.tooling.runbook, 'ops/production-sql-115-apply.md');
  for (const file of [pin.tooling.production_tool, pin.tooling.runbook, pin.tooling.fingerprint_engine, pin.tooling.production_lib, ...pin.tooling.tests]) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), file);
  }
  assert.equal(readPinnedReleaseSql(KEY, ROOT, pin).ok, true);
  // One-shot: the shared release tool, no order of its own (no hash in the registry).
  const tool = ONE_SHOT_TOOLS[KEY];
  assert.equal(tool.key, KEY);
  assert.equal(tool.script, RELEASE_PRODUCTION[KEY].cli);
  assert.deepEqual([...tool.args], []);
  assert.equal(tool.pin_rel, RELEASE_PRODUCTION[KEY].pin_rel);
  assert.equal(tool.allowed_key, 'sql115_production_apply_allowed');
  assert.equal(tool.runs_before, undefined);
  assert.equal(tool.inspect_requires, undefined);
  assert.doesNotMatch(JSON.stringify(tool), /[0-9a-f]{64}/);
  const rows = JSON.stringify(readJson('ops/deployment-guard/bypass-inventory.json'));
  assert.match(rows, /"path":"scripts\/deployment-guard\/sql115-provider-stakeholder-one-partner-payout-production-apply\.mjs","classification":"GUARDED","capabilities":\["sql115-production-apply"\]/);
  assert.match(rows, /sql112, sql113, sql114, sql115, sql116, sql117, sql118, sql119, sql120, sql121, sql122, sql123, sql124, sql125, sql126, sql127, sql128, sql129, sql130, sql131, sql132, sql133\)/);
  const scripts = readJson('package.json').scripts;
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/deployment-guard.yml'), 'utf8');
  for (const name of ['aws/tests/release-sql115-executor.test.mjs', 'aws/tests/release-sql115-production-apply.test.mjs']) {
    assert.ok(scripts['test:deployment-guard'].includes(name), name);
    assert.ok(workflow.includes(name), name);
  }
});

test('order: no predecessor; replaces the restored supabase function the triggers fire; the runbook and one-shot doc name it', () => {
  assert.match(COMMITTED.order_note, /^No predecessor and no order on this engine/);
  assert.match(COMMITTED.order_note, /20260728110453/);
  assert.match(COMMITTED.order_note, /stakeholder_accounts_one_partner_payout/);
  assert.match(COMMITTED.order_note, /already_applied true/);
  // The function, its triggers and the one-payout index come from the restored supabase schema.
  const supa = fs.readFileSync(path.join(ROOT, 'supabase/migrations/20260728110453_fa494314-aebe-4728-9c30-d7b7bd0fb095.sql'), 'utf8');
  assert.match(supa, /CREATE OR REPLACE FUNCTION public\.sync_provider_stakeholder_account\(_tenant_id uuid\)\nRETURNS uuid/);
  assert.match(supa, /CREATE TRIGGER trg_sync_provider_stakeholder_acct\nAFTER INSERT OR UPDATE ON public\.payment_provider_accounts/);
  assert.match(supa, /CREATE TRIGGER trg_sync_provider_stakeholder_bank\nAFTER INSERT OR UPDATE ON public\.payment_provider_methods/);
  const index = fs.readFileSync(path.join(ROOT, 'supabase/migrations/20260712161508_fe06a7a7-39fc-4f31-b7aa-ff81f89e8c77.sql'), 'utf8');
  assert.match(index, /CREATE UNIQUE INDEX IF NOT EXISTS stakeholder_accounts_one_partner_payout\n {2}ON public\.stakeholder_accounts \(tenant_id\)\n {2}WHERE is_partner_payout = true AND is_active = true;/);
  const runbook = fs.readFileSync(path.join(ROOT, COMMITTED.tooling.runbook), 'utf8');
  assert.ok(runbook.includes(COMMITTED.intended_replacement_sha256));
  assert.ok(runbook.includes(COMMITTED.source_sha256));
  assert.match(runbook, /\*\*Status:\*\* staging applied \(wave 16\); SQL 119 applied in production; applied to production \(2026-10-27\); the production pin is retired/);
  assert.match(runbook, /SSM\s+`6f6692d8-3801-4b70-b51c-dd9749e723b4`/);
  assert.match(runbook, /Apply run 40243363235/);
  assert.match(runbook, /read-live \(2026-10-25\)\.\*\* Run 40240434651/);
  const oneShot = fs.readFileSync(path.join(ROOT, 'ops/production-sql-one-shot.md'), 'utf8');
  assert.match(oneShot, /\| `sql115` \|/);
  assert.match(oneShot, /`sql117`, `sql118`, `sql119`, `sql120`, `sql121`, `sql122`, `sql123`, `sql124`, `sql125`, `sql126`, `sql127`, `sql128`, `sql129`, `sql130`, `sql131`, `sql132`, `sql133`\) \|/);
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/README.md'), 'utf8'), /sql115-provider-stakeholder-one-partner-payout-production-apply\.mjs --inspect/);
});

test('the pending (pre-authorization) pin refuses before connecting; the committed (retired) pin refuses and its authorized copy allows only its own manifest; execute false, other hashes and phrases refuse', async () => {
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

  // The committed (retired) pin, read from disk, refuses; its execute-authorized copy allows only
  // the manifest bound to the recorded pre-state, and the spent one_use_id is refused as a replay.
  const retired = await evaluateReleaseProductionApply(KEY, manifest(COMMITTED), { root: ROOT });
  assert.equal(retired.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const authorizedCopy = Object.freeze({ ...COMMITTED, authorization: 'Owner approved 2026-10-27 (test copy of the execute-authorized pin before its record-and-retire change)', execute: true });
  const copyOk = await evaluateReleaseProductionApply(KEY, manifest(authorizedCopy), { root: ROOT, pin: authorizedCopy });
  assert.equal(copyOk.ok, true, JSON.stringify(copyOk));
  assert.equal(copyOk.details.sql115_production_apply_allowed, true);
  assert.equal(copyOk.details.staging_acceptance, STAGING_ACCEPTANCE_REF);
  // Production's pre-SQL 119 state is refused: the pin is bound to the state after SQL 119.
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(authorizedCopy), live_definition_sha256: PRODUCTION_BEFORE_SQL119, expected_live_definition_sha256: PRODUCTION_BEFORE_SQL119 }, { root: ROOT, pin: authorizedCopy })).code, CODES.SQL_COLLISION);
  // The intended state is not production's pre-state: a manifest built on it is refused.
  const onIntended = COMMITTED.intended_replacement_sha256;
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(authorizedCopy), live_definition_sha256: onIntended, expected_live_definition_sha256: onIntended }, { root: ROOT, pin: authorizedCopy })).ok, false);
  const spentPath = consumedPath();
  fs.writeFileSync(spentPath, JSON.stringify({ consumed: [SQL115_APPLIED.one_use_id] }));
  try {
    assert.equal((await precheckReleaseProductionApply(KEY, { ...manifest(authorizedCopy), one_use_id: SQL115_APPLIED.one_use_id }, { root: ROOT, pin: authorizedCopy, consumedPath: spentPath })).code, CODES.RECEIPT_REUSED);
  } finally {
    fs.rmSync(spentPath, { force: true });
  }

  const pin = approved();
  const allowed = await evaluateReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(allowed.details.sql115_production_apply_allowed, true);
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect: neverConnect, consumedPath: consumedPath() })).ok, true);
  const otherLive = { ...manifest(pin), expected_live_definition_sha256: 'f'.repeat(64), live_definition_sha256: 'f'.repeat(64) };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherLive, { root: ROOT, pin })).code, CODES.SQL_COLLISION);
  const otherStaging = { ...manifest(pin), staging_acceptance: { ok: true, reference: 'https://example.invalid/x' } };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherStaging, { root: ROOT, pin })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await precheckReleaseProductionApply(KEY, { ...manifest(pin), authorization_phrase: 'APPLY' }, { root: ROOT, pin, consumedPath: consumedPath() })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const off = approved({ execute: false });
  const ctx = { root: ROOT, pin: off, connect: neverConnect, consumedPath: consumedPath() };
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  assert.equal((await executeReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  // A tampered file hash is a reconciliation stop.
  assert.equal(readPinnedReleaseSql(KEY, ROOT, { ...COMMITTED, source_sha256: 'f'.repeat(64) }).code, CODES.SQL_COLLISION);

  // CLI: --apply with the committed pin, read from disk, and a manifest on another pre-state refuses without connecting
  // or spending a receipt; credential flags are refused.
  const file = path.join(os.tmpdir(), `sql115-cli-${process.pid}.json`);
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
