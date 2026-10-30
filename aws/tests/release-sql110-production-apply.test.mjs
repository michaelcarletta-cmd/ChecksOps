/**
 * Production tool for SQL 110 (scripts/deployment-guard/sql110-homeowner-preclaim-links-
 * production-apply.mjs on lib/release-sql-production-apply.mjs and
 * lib/release-sql-production-cli.mjs). release-sql90-97-production-apply.test.mjs runs every
 * release key (SQL 110 included) through the shared refusals; this file covers SQL 110's own:
 *
 *   - the pin has the release pin shape plus the applied / production_evidence record; it was
 *     execute-authorized (owner-approved pin change of 2026-10-22, #1167) with the recorded
 *     production pre-state and the staging apply from the same pre-state as its acceptance, applied
 *     on 2026-10-22 and retired (execute false again); it is in step with the staging pin, the
 *     one-shot (no runs_before), the bypass inventory and the test lists;
 *   - no predecessor; the runbook and the one-shot doc name it;
 *   - the pending (pre-authorization) pin refuses before connecting; the committed (retired) pin
 *     refuses; its execute-authorized copy allows only the manifest bound to its recorded
 *     pre-state and its spent one_use_id is a replay; an approved, accepted copy evaluates for the
 *     manifest built from it, and refuses with execute false, another live hash, another staging
 *     reference or a wrong phrase; the CLI spends no receipt.
 * The PostgreSQL 16 inspect / apply is aws/tests/sql110-homeowner-preclaim-links-pg.test.mjs.
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
import { main } from '../../scripts/deployment-guard/sql110-homeowner-preclaim-links-production-apply.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql110';
const SQL110_FILE = 'aws/workflows/sql/110_homeowner_preclaim_links.sql';
const WRITER = 'public.aws_public_homeowner_ledger_upload(text, text, text, text, numeric, text)';
const COMMITTED = loadReleaseProductionPin(KEY, ROOT);
const SQL96_PIN = loadReleaseProductionPin('sql96', ROOT);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PRE = 'e'.repeat(64);
// SQL 110's recorded production pre-state (read-only inspect of 2026-10-22, SSM 85ee4f39, main
// 7c3b7abc7): the writer absent and no checksops DELETE; the same as staging's before its apply.
const PRODUCTION_PRE = '3fdbb3d323c1c0edab0c2ee7e4a6c1b08aa30c1a021c7d81899e95a616f186fd';
const PRODUCTION_STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/39838878110';
const OWNER_WORDS = '"apply SQL 110 in production"';
// SQL 110's production apply of 2026-10-22 (main e29b971fb), recorded in applied.
const SQL110_APPLIED = Object.freeze({ ssm: 'dff74531-5a77-4f17-9027-e927f7f10644', inspect_ssm: 'c0dce565-8dce-46fa-9f2d-42702987afe1', run: '04f2dadf-1866-492e-a9e9-d301a2766b2b', one_use_id: 'sql110-prod-a04eae17-2564-42ba-87a1-51bc200582ff', commit: 'e29b971fbf9c33d89cdf133155853d0c5e9c9b26', approval: 'apply SQL 110 in production', workstream: 'prod-sql110-homeowner-preclaim-links-20261022' });
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const keyPaths = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? keyPaths(v, `${p}${k}.`) : [`${p}${k}`]));
const neverConnect = async () => { throw new Error('should-not-connect'); };
const consumedPath = () => path.join(os.tmpdir(), `sql110-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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
    build_timestamp: '2026-10-22T20:00:00.000Z',
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

test('pin: the release pin shape, applied and retired (owner approved 2026-10-22, on the staging apply), in step with the staging pin, the one-shot, the inventory and the test lists', () => {
  const pin = COMMITTED;
  const staging = STAGING[KEY];
  const shape = new Set(keyPaths(SQL96_PIN).filter((k) => !/^(applied|production_evidence)(\.|$)/.test(k)));
  assert.deepEqual([...shape].filter((k) => !keyPaths(pin).includes(k)), [], 'lacks the engine pin shape');
  // The record-and-retire change adds applied and production_evidence on top of the engine pin shape.
  assert.deepEqual(keyPaths(pin).filter((k) => !shape.has(k) && !/^(applied|production_evidence)\./.test(k)), []);
  assert.equal(pin.id, RELEASE_SQL_SPECS[KEY].production_pin_rel.split('/').pop().replace(/\.json$/, ''));
  assert.equal(pin.migration, KEY);
  // Owner-approved pin change of 2026-10-22: the read-only production inspect (SSM 85ee4f39, main
  // 7c3b7abc7) recorded as the pre-state; the staging apply (run 39838878110) from the same pre-state.
  // Applied 2026-10-22 and retired.
  assert.equal(pin.execute, false);
  assert.match(pin.authorization, /^Applied to production on 2026-10-22; execute is false again/);
  assert.doesNotMatch(pin.authorization, /^Owner approved/);
  assert.ok(pin.authorization.includes(OWNER_WORDS));
  assert.ok(pin.authorization.includes('#1167'));
  assert.ok(pin.authorization.includes(SQL110_APPLIED.workstream));
  assert.equal(pin.applied.result, 'applied');
  assert.equal(pin.applied.apply_ssm_command_id, SQL110_APPLIED.ssm);
  assert.equal(pin.applied.one_shot_run_id, SQL110_APPLIED.run);
  assert.equal(pin.applied.one_use_id, SQL110_APPLIED.one_use_id);
  assert.equal(pin.applied.one_use_id_consumed, true);
  assert.equal(pin.applied.workstream_id, SQL110_APPLIED.workstream);
  assert.equal(pin.applied.source_commit, SQL110_APPLIED.commit);
  assert.equal(pin.applied.source_tarball.sha256, 'a86f2b286e579e75695ffed3e66919846a19995ea6654f1416ece5f9079abc19');
  assert.equal(pin.applied.migration_source_sha256, pin.source_sha256);
  assert.equal(pin.applied.owner_approval, SQL110_APPLIED.approval);
  assert.ok(pin.applied.one_shot_note.includes(SQL110_APPLIED.inspect_ssm));
  assert.equal(pin.applied.manifest_sha256, 'ce9d1d6c262aa25e8fd358482f212fbfc08e77c464ff07d79bba732c5f428587');
  assert.equal(pin.applied.pre_apply_inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.applied.receipt.before_hash, PRODUCTION_PRE);
  assert.equal(pin.applied.receipt.after_hash, pin.intended_replacement_sha256);
  assert.equal(pin.applied.receipt.workstream, SQL110_APPLIED.workstream);
  assert.equal(pin.applied.receipt.unrelated_catalog_sha256, '9d4cf0677f4806f30f75374f56c27d79bc5258b1e6b9c2e106dd60e63b01499a');
  assert.equal(pin.applied.receipt.staging_acceptance, pin.staging_acceptance.reference);
  assert.equal(pin.applied.post_apply_inspect.already_applied, true);
  assert.equal(pin.applied.post_apply_inspect.live_definition_sha256, pin.intended_replacement_sha256);
  assert.deepEqual(pin.applied.post_apply_inspect.precondition_failures, []);
  assert.equal(pin.applied.later_inspect, undefined);
  assert.ok(pin.production_evidence['2026-10-22 apply'].includes(SQL110_APPLIED.ssm));
  assert.equal(pin.expected_live_definition_sha256, PRODUCTION_PRE);
  assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
  // Production's pre-state is the staging pin's recorded pre-state (staging read-live run 39836749684).
  assert.equal(pin.expected_live_definition_sha256, staging.expected_live_definition_sha256);
  assert.equal(pin.production_inspect.status, 'recorded');
  assert.equal(pin.production_inspect.date, '2026-10-22');
  assert.equal(pin.production_inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.production_inspect.ssm_command_id, '85ee4f39-7234-42a4-b1d8-79cd1390fdbc');
  assert.equal(pin.production_inspect.source_commit, '7c3b7abc760bf3c7fbf136f10614426d715eeed4');
  assert.equal(pin.production_inspect.read_only, true);
  assert.deepEqual(pin.production_inspect.precondition_failures, []);
  assert.ok(pin.production_inspect.note.includes('58bd457946f37e970501c83fe226b9d18a5092d9aff80d150c7b34b19a8bde21'));
  assert.ok(pin.production_inspect.note.includes('state absent'));
  assert.ok(pin.production_inspect.note.includes(' Earlier: Pending: '));
  assert.deepEqual([pin.staging_acceptance.ok, pin.staging_acceptance.reference], [true, PRODUCTION_STAGING_REF]);
  assert.match(pin.staging_acceptance.basis, /^Guarded staging apply from the same pre-state as production/);
  assert.match(pin.staging_acceptance.basis, /result applied/);
  assert.ok(pin.staging_acceptance.basis.includes(`before ${PRODUCTION_PRE}, after ${pin.intended_replacement_sha256}`));
  assert.match(pin.staging_acceptance.basis, /already_applied true/);
  assert.deepEqual(Object.keys(pin.staging_acceptance).sort(), ['basis', 'ok', 'reference']);
  assert.equal(pin.filename, SQL110_FILE);
  assert.equal(pin.source_sha256, staging.source_sha256);
  assert.equal(pin.staging_pin_commit, staging.commit);
  assert.equal(pin.intended_replacement_sha256, staging.intended_replacement_sha256);
  assert.equal(pin.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.deepEqual(pin.function_identities, [WRITER]);
  assert.deepEqual(pin.function_identities, [...staging.function_identities]);
  assert.deepEqual(pin.predecessors, []);
  assert.deepEqual(pin.predecessors, RELEASE_SQL_SPECS[KEY].predecessors);
  assert.equal(pin.authorization_phrase, 'APPLY_HOMEOWNER_PRECLAIM_LINKS');
  for (const k of ['admin_login', 'rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(pin[k], SQL96_PIN[k], k);
  assert.equal(pin.tooling.status, 'built');
  assert.equal(pin.tooling.production_tool, RELEASE_PRODUCTION[KEY].cli);
  assert.equal(pin.tooling.production_tool, 'scripts/deployment-guard/sql110-homeowner-preclaim-links-production-apply.mjs');
  assert.equal(pin.tooling.staging_workflow_choice, RELEASE_SQL_SPECS[KEY].choice);
  assert.equal(pin.tooling.one_shot_migration, KEY);
  assert.equal(pin.tooling.runbook, 'ops/production-sql-110-apply.md');
  for (const file of [pin.tooling.production_tool, pin.tooling.runbook, pin.tooling.fingerprint_engine, pin.tooling.production_lib, ...pin.tooling.tests]) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), file);
  }
  assert.equal(readPinnedReleaseSql(KEY, ROOT, pin).ok, true);
  const tool = ONE_SHOT_TOOLS[KEY];
  assert.equal(tool.key, KEY);
  assert.equal(tool.script, RELEASE_PRODUCTION[KEY].cli);
  assert.deepEqual([...tool.args], []);
  assert.equal(tool.pin_rel, RELEASE_PRODUCTION[KEY].pin_rel);
  assert.equal(tool.allowed_key, 'sql110_production_apply_allowed');
  assert.equal(tool.runs_before, undefined);
  assert.equal(tool.inspect_requires, undefined);
  assert.doesNotMatch(JSON.stringify(tool), /[0-9a-f]{64}/);
  const rows = JSON.stringify(readJson('ops/deployment-guard/bypass-inventory.json'));
  assert.match(rows, /"path":"scripts\/deployment-guard\/sql110-homeowner-preclaim-links-production-apply\.mjs","classification":"GUARDED","capabilities":\["sql110-production-apply"\]/);
  assert.match(rows, /sql106, sql108, sql109, sql110, sql111, sql112, sql113, sql114, sql115, sql116, sql117, sql118, sql119, sql120, sql121, sql122, sql123, sql124, sql125, sql126, sql127, sql128, sql129, sql130, sql131, sql132\)/);
  const scripts = readJson('package.json').scripts;
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/deployment-guard.yml'), 'utf8');
  for (const name of ['aws/tests/release-sql110-executor.test.mjs', 'aws/tests/release-sql110-production-apply.test.mjs']) {
    assert.ok(scripts['test:deployment-guard'].includes(name), name);
    assert.ok(workflow.includes(name), name);
  }
});

test('order: no predecessor; the runbook, the one-shot doc and the guard README name it', () => {
  assert.match(COMMITTED.order_note, /^No predecessor/);
  const runbook = fs.readFileSync(path.join(ROOT, COMMITTED.tooling.runbook), 'utf8');
  assert.ok(runbook.includes(COMMITTED.intended_replacement_sha256));
  assert.ok(runbook.includes(COMMITTED.source_sha256));
  assert.match(runbook, /ON DELETE SET NULL/);
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/production-sql-one-shot.md'), 'utf8'), /\| `sql110` \|/);
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/README.md'), 'utf8'), /sql110-homeowner-preclaim-links-production-apply\.mjs --inspect/);
});

test('the pending (pre-authorization) pin refuses before connecting; an approved copy allows only its own manifest; execute false, other hashes and phrases refuse', async () => {
  // The pin before its owner-approved change: no pre-state, no owner approval, no staging acceptance.
  const PENDING = Object.freeze({ ...COMMITTED, authorization: 'pending', execute: false, expected_live_definition_sha256: null, staging_acceptance: { ok: false, reference: null, basis: 'Pending' } });
  const noPre = await evaluateReleaseProductionApply(KEY, manifest({ ...PENDING, expected_live_definition_sha256: PRE }), { root: ROOT, pin: PENDING });
  assert.equal(noPre.code, CODES.SQL_COLLISION);
  const withPre = { ...PENDING, expected_live_definition_sha256: PRE };
  assert.equal((await evaluateReleaseProductionApply(KEY, manifest(withPre), { root: ROOT, pin: withPre })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await executeReleaseProductionApply(KEY, manifest(withPre), { root: ROOT, pin: withPre, connect: neverConnect, consumedPath: consumedPath() })).ok, false);
  // The committed (retired) pin, read from disk, refuses; its execute-authorized copy allows only
  // the manifest bound to the recorded pre-state, and the spent one_use_id is refused as a replay.
  const retired = await evaluateReleaseProductionApply(KEY, manifest(COMMITTED), { root: ROOT });
  assert.equal(retired.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const authorizedCopy = Object.freeze({ ...COMMITTED, authorization: 'Owner approved 2026-10-22 (test copy of the execute-authorized pin before its record-and-retire change)', execute: true });
  const copyOk = await evaluateReleaseProductionApply(KEY, manifest(authorizedCopy), { root: ROOT, pin: authorizedCopy });
  assert.equal(copyOk.ok, true, JSON.stringify(copyOk));
  assert.equal(copyOk.details.sql110_production_apply_allowed, true);
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(authorizedCopy), live_definition_sha256: PRE, expected_live_definition_sha256: PRE }, { root: ROOT, pin: authorizedCopy })).code, CODES.SQL_COLLISION);
  // The intended state is not production's pre-state: a manifest built on it is refused.
  const onIntended = COMMITTED.intended_replacement_sha256;
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(authorizedCopy), live_definition_sha256: onIntended, expected_live_definition_sha256: onIntended }, { root: ROOT, pin: authorizedCopy })).ok, false);
  const spentPath = consumedPath();
  fs.writeFileSync(spentPath, JSON.stringify({ consumed: [SQL110_APPLIED.one_use_id] }));
  try {
    assert.equal((await precheckReleaseProductionApply(KEY, { ...manifest(authorizedCopy), one_use_id: SQL110_APPLIED.one_use_id }, { root: ROOT, pin: authorizedCopy, consumedPath: spentPath })).code, CODES.RECEIPT_REUSED);
  } finally {
    fs.rmSync(spentPath, { force: true });
  }
  const flipped = { ...withPre, execute: true };
  assert.equal((await evaluateReleaseProductionApply(KEY, manifest(flipped), { root: ROOT, pin: flipped })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);

  const pin = approved();
  const allowed = await evaluateReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(allowed.details.sql110_production_apply_allowed, true);
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
  assert.equal(readPinnedReleaseSql(KEY, ROOT, { ...COMMITTED, source_sha256: 'f'.repeat(64) }).code, CODES.SQL_COLLISION);

  const file = path.join(os.tmpdir(), `sql110-cli-${process.pid}.json`);
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
