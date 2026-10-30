/**
 * Production tool for SQL 113 (scripts/deployment-guard/sql113-payee-setup-production-apply.mjs on
 * lib/release-sql-production-apply.mjs and lib/release-sql-production-cli.mjs).
 * release-sql90-97-production-apply.test.mjs runs every release key (SQL 113 included) through the
 * shared refusals; this file covers SQL 113's own:
 *
 *   - the pin has the release pin shape plus the applied / production_evidence record; it was
 *     execute-authorized (owner-approved pin change of 2026-10-23, #1208) with the recorded
 *     production pre-state and the staging apply from the same pre-state as its acceptance,
 *     applied on 2026-10-23 and retired (execute false again); it is in step with the staging
 *     pin, the one-shot (no runs_before), the bypass inventory and the test lists;
 *   - no predecessor; the order note names the supabase migrations and origin check it depends on
 *     and the payee functions; the runbook carries the code-derived fingerprint and the one-shot
 *     doc and the README name it;
 *   - the pending (pre-authorization) pin refuses before connecting; the committed (retired) pin
 *     refuses; its execute-authorized copy allows only the manifest bound to its recorded
 *     pre-state and its spent one_use_id is a replay; an approved, accepted copy evaluates for the
 *     manifest built from it, and refuses with execute false, another live hash, another staging
 *     reference or a wrong phrase; the CLI spends no receipt.
 * The PostgreSQL 16 inspect / apply is aws/tests/sql113-payee-setup-pg.test.mjs.
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
import { RELEASE_SQL_SPECS, releaseIntendedHash, releaseIntendedState, releaseStateText } from '../../scripts/deployment-guard/lib/release-sql-state.mjs';
import {
  RELEASE_PRODUCTION,
  evaluateReleaseProductionApply,
  executeReleaseProductionApply,
  loadReleaseProductionPin,
  precheckReleaseProductionApply,
  readPinnedReleaseSql,
} from '../../scripts/deployment-guard/lib/release-sql-production-apply.mjs';
import { main } from '../../scripts/deployment-guard/sql113-payee-setup-production-apply.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql113';
const SQL113_FILE = 'aws/workflows/sql/113_payee_setup.sql';
const COMMITTED = loadReleaseProductionPin(KEY, ROOT);
const SQL96_PIN = loadReleaseProductionPin('sql96', ROOT);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PRE = 'e'.repeat(64);
// SQL 113's recorded production pre-state (read-only inspect of 2026-10-23, SSM 8ee0c634, main
// b6e8d56bf): the six functions absent; the same as staging's before its apply.
const PRODUCTION_PRE = '88787a89c85585f25c18ea31d60740a6526522377a1b0d7b02e7902fe18970c1';
const PRODUCTION_STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/40022413642';
const OWNER_WORDS = '"Approve SQL 113 for production"';
// SQL 113's production apply of 2026-10-23 (main 09425a013), recorded in applied.
const SQL113_APPLIED = Object.freeze({ ssm: '9f209788-6247-47ed-bc6e-838d5791a42e', inspect_ssm: 'f77ae429-c9e4-458d-9152-06bf767f28c1', run: '594619a2-671f-45f5-a260-7f991d5007ef', one_use_id: 'sql113-prod-86f11689-ab1d-4459-9f15-10ff2d135818', commit: '09425a01389ce92e703f34eb2bcc526d532f1c13', approval: 'apply SQL 113 in production and merge 1209 when green', workstream: 'prod-sql113-payee-setup-20261023' });
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const keyPaths = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? keyPaths(v, `${p}${k}.`) : [`${p}${k}`]));
const neverConnect = async () => { throw new Error('should-not-connect'); };
const consumedPath = () => path.join(os.tmpdir(), `sql113-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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
    build_timestamp: '2026-10-23T20:00:00.000Z',
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

test('pin: the release pin shape, applied and retired (owner approved 2026-10-23, on the staging apply), in step with the staging pin, the one-shot, the inventory and the test lists', () => {
  const pin = COMMITTED;
  const staging = STAGING[KEY];
  const shape = new Set(keyPaths(SQL96_PIN).filter((k) => !/^(applied|production_evidence)(\.|$)/.test(k)));
  assert.deepEqual([...shape].filter((k) => !keyPaths(pin).includes(k)), [], 'lacks the engine pin shape');
  // The record-and-retire change adds applied and production_evidence on top of the engine pin shape.
  assert.deepEqual(keyPaths(pin).filter((k) => !shape.has(k) && !/^(applied|production_evidence)\./.test(k)), []);
  assert.equal(pin.id, RELEASE_SQL_SPECS[KEY].production_pin_rel.split('/').pop().replace(/\.json$/, ''));
  assert.equal(pin.migration, KEY);
  // Owner-approved pin change of 2026-10-23: the read-only production inspect (SSM 8ee0c634, main
  // b6e8d56bf) recorded as the pre-state; the staging apply (run 40022413642) from the same pre-state.
  // Applied 2026-10-23 and retired.
  assert.equal(pin.execute, false);
  assert.match(pin.authorization, /^Applied to production on 2026-10-23; execute is false again/);
  assert.doesNotMatch(pin.authorization, /^Owner approved/);
  assert.ok(pin.authorization.includes(OWNER_WORDS));
  assert.ok(pin.authorization.includes(`"${SQL113_APPLIED.approval}"`));
  assert.ok(pin.authorization.includes('#1208'));
  assert.ok(pin.authorization.includes(SQL113_APPLIED.workstream));
  assert.equal(pin.applied.result, 'applied');
  assert.equal(pin.applied.apply_ssm_command_id, SQL113_APPLIED.ssm);
  assert.equal(pin.applied.one_shot_run_id, SQL113_APPLIED.run);
  assert.equal(pin.applied.one_use_id, SQL113_APPLIED.one_use_id);
  assert.equal(pin.applied.one_use_id_consumed, true);
  assert.equal(pin.applied.workstream_id, SQL113_APPLIED.workstream);
  assert.equal(pin.applied.source_commit, SQL113_APPLIED.commit);
  assert.equal(pin.applied.source_tarball.sha256, '201d6e0840d0aba76c7d1378ad8782acbfbaf26c3f6a47a8b612753c0d77b3ef');
  assert.equal(pin.applied.migration_source_sha256, pin.source_sha256);
  assert.equal(pin.applied.owner_approval, SQL113_APPLIED.approval);
  assert.ok(pin.applied.one_shot_note.includes(SQL113_APPLIED.inspect_ssm));
  assert.equal(pin.applied.manifest_sha256, 'be0e945aebe8eccde693c49db1aba1a4814ef6c80a8356b122367d43932a97d0');
  assert.equal(pin.applied.pre_apply_inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.applied.receipt.before_hash, PRODUCTION_PRE);
  assert.equal(pin.applied.receipt.after_hash, pin.intended_replacement_sha256);
  assert.equal(pin.applied.receipt.workstream, SQL113_APPLIED.workstream);
  assert.equal(pin.applied.receipt.staging_acceptance, pin.staging_acceptance.reference);
  assert.equal(pin.applied.receipt.unrelated_catalog_sha256, 'd080ebf0630da8db6a80ac6290f7a5c9045400bfa3bbd41d4edc9e055b0f0c6a');
  assert.equal(pin.applied.receipt.result, 'applied');
  assert.equal(pin.applied.post_apply_inspect.already_applied, true);
  assert.equal(pin.applied.post_apply_inspect.live_definition_sha256, pin.intended_replacement_sha256);
  assert.deepEqual(pin.applied.post_apply_inspect.precondition_failures, []);
  assert.equal(pin.applied.later_inspect, undefined);
  assert.ok(pin.production_evidence['2026-10-23 apply'].includes(SQL113_APPLIED.ssm));
  assert.equal(pin.expected_live_definition_sha256, PRODUCTION_PRE);
  assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
  // Production's pre-state is the staging pin's recorded pre-state (staging read-live run 40018316361).
  assert.equal(pin.expected_live_definition_sha256, staging.expected_live_definition_sha256);
  assert.equal(pin.production_inspect.status, 'recorded');
  assert.equal(pin.production_inspect.date, '2026-10-23');
  assert.equal(pin.production_inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.production_inspect.ssm_command_id, '8ee0c634-8fa3-457e-88aa-adbeb392b4fc');
  assert.equal(pin.production_inspect.source_commit, 'b6e8d56bf2b4f8c70a45ca89db42367607346be5');
  assert.equal(pin.production_inspect.read_only, true);
  assert.equal(pin.production_inspect.connected_as, 'checksops_admin');
  assert.equal(pin.production_inspect.apply_preconditions_met, false);
  assert.deepEqual(pin.production_inspect.precondition_failures, []);
  assert.ok(pin.production_inspect.note.includes('df13b10343fb19667dcfd5309d06f836b1b0e2e2c0cfc253066a8236d81b05a8'));
  assert.ok(pin.production_inspect.note.includes(`migration source sha256 on the runner ${pin.source_sha256} == source_sha256`));
  assert.ok(pin.production_inspect.note.includes('state absent'));
  assert.ok(pin.production_inspect.note.includes(' Earlier: Pending: '));
  assert.match(pin.production_inspect.note, /If already_applied is true, or precondition_failures is not \[\], stop/);
  assert.deepEqual([pin.staging_acceptance.ok, pin.staging_acceptance.reference], [true, PRODUCTION_STAGING_REF]);
  assert.match(pin.staging_acceptance.basis, /^Guarded staging apply from the same pre-state as production/);
  assert.match(pin.staging_acceptance.basis, /result applied/);
  assert.ok(pin.staging_acceptance.basis.includes(`before ${PRODUCTION_PRE}, after ${pin.intended_replacement_sha256}`));
  assert.match(pin.staging_acceptance.basis, /The pre-states are identical/);
  assert.match(pin.staging_acceptance.basis, /already_applied true/);
  assert.deepEqual(Object.keys(pin.staging_acceptance).sort(), ['basis', 'ok', 'reference']);
  assert.equal(pin.filename, SQL113_FILE);
  assert.equal(pin.source_sha256, staging.source_sha256);
  assert.equal(pin.staging_pin_commit, staging.commit);
  assert.equal(pin.intended_replacement_sha256, staging.intended_replacement_sha256);
  assert.equal(pin.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(pin.intended_replacement_sha256, releaseIntendedHash(KEY, fs.readFileSync(path.join(ROOT, SQL113_FILE), 'utf8')));
  assert.deepEqual(pin.function_identities, RELEASE_SQL_SPECS[KEY].functions.map((fn) => fn.identity));
  assert.equal(pin.function_identities.length, 6);
  assert.deepEqual(pin.function_identities, [...staging.function_identities]);
  assert.deepEqual(pin.predecessors, []);
  assert.deepEqual(pin.predecessors, RELEASE_SQL_SPECS[KEY].predecessors);
  assert.equal(pin.authorization_phrase, 'APPLY_PAYEE_SETUP');
  for (const k of ['admin_login', 'rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(pin[k], SQL96_PIN[k], k);
  assert.equal(pin.tooling.status, 'built');
  assert.equal(pin.tooling.production_tool, RELEASE_PRODUCTION[KEY].cli);
  assert.equal(pin.tooling.production_tool, 'scripts/deployment-guard/sql113-payee-setup-production-apply.mjs');
  assert.equal(pin.tooling.staging_workflow_choice, RELEASE_SQL_SPECS[KEY].choice);
  assert.equal(pin.tooling.one_shot_migration, KEY);
  assert.equal(pin.tooling.runbook, 'ops/production-sql-113-apply.md');
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
  assert.equal(tool.allowed_key, 'sql113_production_apply_allowed');
  assert.equal(tool.runs_before, undefined);
  assert.equal(tool.inspect_requires, undefined);
  assert.doesNotMatch(JSON.stringify(tool), /[0-9a-f]{64}/);
  const rows = JSON.stringify(readJson('ops/deployment-guard/bypass-inventory.json'));
  assert.match(rows, /"path":"scripts\/deployment-guard\/sql113-payee-setup-production-apply\.mjs","classification":"GUARDED","capabilities":\["sql113-production-apply"\]/);
  assert.match(rows, /sql110, sql111, sql112, sql113, sql114, sql115, sql116, sql117, sql118, sql119, sql120, sql121, sql122, sql123, sql124, sql125, sql126, sql127, sql128, sql129, sql130, sql131, sql132, sql133, sql134\)/);
  const scripts = readJson('package.json').scripts;
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/deployment-guard.yml'), 'utf8');
  for (const name of ['aws/tests/release-sql113-executor.test.mjs', 'aws/tests/release-sql113-production-apply.test.mjs']) {
    assert.ok(scripts['test:deployment-guard'].includes(name), name);
    assert.ok(workflow.includes(name), name);
  }
});

test('order: no predecessor; the note names the supabase origin check and the payee functions; the runbook and one-shot doc name it', () => {
  assert.match(COMMITTED.order_note, /^No predecessor and no order on this engine/);
  for (const migration of ['20260727224957', '20260728120105', '20260728110453']) assert.ok(COMMITTED.order_note.includes(migration), migration);
  assert.match(COMMITTED.order_note, /sql113_origin_check_unexpected/);
  assert.match(COMMITTED.order_note, /without FORCE ROW LEVEL SECURITY/);
  for (const fn of RELEASE_SQL_SPECS[KEY].functions.map((f) => /^public\.([a-z_]+)\(/.exec(f.identity)[1])) assert.ok(COMMITTED.order_note.includes(fn), fn);
  assert.match(COMMITTED.intended_post_state.note, /releaseIntendedHash\('sql113', file bytes\)/);
  assert.ok(COMMITTED.intended_post_state.note.includes(COMMITTED.intended_replacement_sha256));
  const runbook = fs.readFileSync(path.join(ROOT, COMMITTED.tooling.runbook), 'utf8');
  assert.ok(runbook.includes(COMMITTED.intended_replacement_sha256));
  assert.ok(runbook.includes(COMMITTED.source_sha256));
  assert.match(runbook, /\*\*Status:\*\* applied to staging and to production \(2026-10-23\)/);
  assert.ok(runbook.includes(SQL113_APPLIED.ssm));
  assert.match(runbook, /SSM\s+`8ee0c634-8fa3-457e-88aa-adbeb392b4fc`/);
  // The runbook's fingerprint block is the code-derived state text.
  const text = fs.readFileSync(path.join(ROOT, SQL113_FILE), 'utf8');
  assert.ok(runbook.includes(`\`\`\`\n${releaseStateText(KEY, releaseIntendedState(KEY, text))}\n\`\`\``));
  const oneShot = fs.readFileSync(path.join(ROOT, 'ops/production-sql-one-shot.md'), 'utf8');
  assert.match(oneShot, /\| `sql113` \|/);
  assert.match(oneShot, /`sql117`, `sql118`, `sql119`, `sql120`, `sql121`, `sql122`, `sql123`, `sql124`, `sql125`, `sql126`, `sql127`, `sql128`, `sql129`, `sql130`, `sql131`, `sql132`, `sql133`, `sql134`\) \|/);
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/README.md'), 'utf8'), /sql113-payee-setup-production-apply\.mjs --inspect/);
});

test('the pending (pre-authorization) pin refuses before connecting; the committed (retired) pin refuses and its authorized copy allows only its own manifest; execute false, other hashes and phrases refuse', async () => {
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
  const authorizedCopy = Object.freeze({ ...COMMITTED, authorization: 'Owner approved 2026-10-23 (test copy of the execute-authorized pin before its record-and-retire change)', execute: true });
  const copyOk = await evaluateReleaseProductionApply(KEY, manifest(authorizedCopy), { root: ROOT, pin: authorizedCopy });
  assert.equal(copyOk.ok, true, JSON.stringify(copyOk));
  assert.equal(copyOk.details.sql113_production_apply_allowed, true);
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(authorizedCopy), live_definition_sha256: PRE, expected_live_definition_sha256: PRE }, { root: ROOT, pin: authorizedCopy })).code, CODES.SQL_COLLISION);
  // The intended state is not production's pre-state: a manifest built on it is refused.
  const onIntended = COMMITTED.intended_replacement_sha256;
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(authorizedCopy), live_definition_sha256: onIntended, expected_live_definition_sha256: onIntended }, { root: ROOT, pin: authorizedCopy })).ok, false);
  const spentPath = consumedPath();
  fs.writeFileSync(spentPath, JSON.stringify({ consumed: [SQL113_APPLIED.one_use_id] }));
  try {
    assert.equal((await precheckReleaseProductionApply(KEY, { ...manifest(authorizedCopy), one_use_id: SQL113_APPLIED.one_use_id }, { root: ROOT, pin: authorizedCopy, consumedPath: spentPath })).code, CODES.RECEIPT_REUSED);
  } finally {
    fs.rmSync(spentPath, { force: true });
  }
  // execute true alone does not authorize it.
  const flipped = { ...withPre, execute: true };
  assert.equal((await evaluateReleaseProductionApply(KEY, manifest(flipped), { root: ROOT, pin: flipped })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);

  const pin = approved();
  const allowed = await evaluateReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(allowed.details.sql113_production_apply_allowed, true);
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
  const file = path.join(os.tmpdir(), `sql113-cli-${process.pid}.json`);
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
