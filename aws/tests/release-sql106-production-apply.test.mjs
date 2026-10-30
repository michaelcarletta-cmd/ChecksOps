/**
 * Production tool for SQL 106 (scripts/deployment-guard/sql106-financial-stepup-log-append-only-
 * production-apply.mjs on lib/release-sql-production-apply.mjs and
 * lib/release-sql-production-cli.mjs). release-sql90-97-production-apply.test.mjs runs every
 * release key (SQL 106 included) through the shared refusals; this file covers SQL 106's own:
 *
 *   - the pin has the release pin shape plus the applied / production_evidence record; it was
 *     execute-authorized (owner-approved pin change of 2026-10-21, #1120) with the recorded
 *     production pre-state and the owner-accepted substitute staging evidence, applied on
 *     2026-10-21 and retired (execute false again); it is in step with the staging pin, the
 *     one-shot (runs_before sql97), the bypass inventory and the test lists;
 *   - the order: before SQL 97 (no predecessor, applied after SQL 106 on 2026-10-21), whose file,
 *     fingerprints and spec are unchanged; no plan entry; the runbooks (SQL 106's, SQL 90-97's
 *     review note) name it;
 *   - the pending (pre-authorization) pin refuses before connecting; the committed (retired) pin
 *     refuses; its execute-authorized copy allows only the manifest bound to its recorded
 *     pre-state and its spent one_use_id is a replay; an approved, accepted copy evaluates
 *     for the manifest built from it, and refuses with execute false, another live hash, another
 *     staging reference or a wrong phrase; the CLI spends no receipt.
 * The PostgreSQL 16 inspect / apply is aws/tests/sql106-financial-stepup-log-append-only-pg.test.mjs.
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
import { main } from '../../scripts/deployment-guard/sql106-financial-stepup-log-append-only-production-apply.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql106';
const SQL106_FILE = 'aws/workflows/sql/106_financial_stepup_log_append_only.sql';
const SQL97_FILE = 'aws/workflows/sql/97_financial_stepup_log_server_writer.sql';
const COMMITTED = loadReleaseProductionPin(KEY, ROOT);
const SQL96_PIN = loadReleaseProductionPin('sql96', ROOT);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PRE = 'e'.repeat(64);
// SQL 106's recorded production pre-state (read-only inspect of 2026-10-21, SSM 4539d0f0, main
// fd1e059b5): checksops DELETE and UPDATE on financial_stepup_log.
const PRODUCTION_PRE = '56b5e4bb1a2db3133c32c9cc3cca02c1e7fb876839544dbdfd0717aad8f25880';
const PRODUCTION_STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/39633390440';
// SQL 106's production apply of 2026-10-21 (main 7124a160b), recorded in applied.
const SQL106_APPLIED = Object.freeze({ ssm: '43070c9e-2bb5-4e49-80f3-97fe6f35e3d0', run: '0ae3e5dc-a34f-4799-ba75-d79a9b2ade28', one_use_id: 'sql106-prod-c994fcc1-bbff-414b-bfad-3b864d96d4a6', commit: '7124a160b9848d6334bc4328d69e9404aebddff3', approval: 'apply SQL 106 and SQL 97 in production', workstream: 'prod-sql106-financial-stepup-log-append-only-20261021' });
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const keyPaths = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? keyPaths(v, `${p}${k}.`) : [`${p}${k}`]));
const neverConnect = async () => { throw new Error('should-not-connect'); };
const consumedPath = () => path.join(os.tmpdir(), `sql106-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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
    build_timestamp: '2026-10-21T20:00:00.000Z',
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

test('pin: the release pin shape, applied and retired (owner approved 2026-10-21, substitute staging evidence), in step with the staging pin, the one-shot (runs before SQL 97), the inventory and the test lists', () => {
  const pin = COMMITTED;
  const staging = STAGING[KEY];
  // SQL 96's pin is the engine pin shape without its record-only applied / production_evidence sections.
  const shape = new Set(keyPaths(SQL96_PIN).filter((k) => !/^(applied|production_evidence)(\.|$)/.test(k)));
  // Exactly the engine pin shape: nothing missing, nothing extra.
  assert.deepEqual([...shape].filter((k) => !keyPaths(pin).includes(k)), [], 'lacks the engine pin shape');
  // The record-and-retire change adds applied and production_evidence on top of the engine pin shape.
  assert.deepEqual(keyPaths(pin).filter((k) => !shape.has(k) && !/^(applied|production_evidence)\./.test(k)), []);
  assert.equal(pin.id, RELEASE_SQL_SPECS[KEY].production_pin_rel.split('/').pop().replace(/\.json$/, ''));
  assert.equal(pin.migration, KEY);
  // Owner-approved pin change of 2026-10-21: the read-only production inspect (SSM 4539d0f0, main
  // fd1e059b5) recorded as the pre-state; the staging read-live (run 39633390440, SQL 106 already in
  // effect in staging) accepted as substitute evidence. Applied 2026-10-21 and retired.
  assert.equal(pin.execute, false);
  assert.match(pin.authorization, /^Applied to production on 2026-10-21; execute is false again/);
  assert.doesNotMatch(pin.authorization, /^Owner approved/);
  assert.ok(pin.authorization.includes('"build SQL 106 and merge when green"'));
  assert.ok(pin.authorization.includes('#1120'));
  assert.ok(pin.authorization.includes(`"${SQL106_APPLIED.approval}"`));
  assert.equal(pin.applied.result, 'applied');
  assert.equal(pin.applied.apply_ssm_command_id, SQL106_APPLIED.ssm);
  assert.equal(pin.applied.one_shot_run_id, SQL106_APPLIED.run);
  assert.equal(pin.applied.one_use_id, SQL106_APPLIED.one_use_id);
  assert.equal(pin.applied.one_use_id_consumed, true);
  assert.equal(pin.applied.workstream_id, SQL106_APPLIED.workstream);
  assert.equal(pin.applied.source_commit, SQL106_APPLIED.commit);
  assert.equal(pin.applied.source_tarball.sha256, '48713c464437e21c91dd63360fe33c27495918c332a32951ac8f3ec692089dde');
  assert.equal(pin.applied.migration_source_sha256, pin.source_sha256);
  assert.equal(pin.applied.owner_approval, SQL106_APPLIED.approval);
  assert.equal(pin.applied.manifest_sha256, '8ca15d2dd526629cc3bdfbfcd5091f6a8a6c29c003cfe7ec31fa11414c8a9c07');
  assert.equal(pin.applied.pre_apply_inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.applied.receipt.before_hash, PRODUCTION_PRE);
  assert.equal(pin.applied.receipt.after_hash, pin.intended_replacement_sha256);
  assert.equal(pin.applied.receipt.workstream, SQL106_APPLIED.workstream);
  assert.equal(pin.applied.receipt.unrelated_catalog_sha256, '22332dfcb6056258de39f047dd67ea32d65112ce93e14b744f18afbc33b208d3');
  assert.equal(pin.applied.receipt.staging_acceptance, pin.staging_acceptance.reference);
  assert.equal(pin.applied.post_apply_inspect.already_applied, true);
  assert.equal(pin.applied.post_apply_inspect.live_definition_sha256, pin.intended_replacement_sha256);
  assert.deepEqual(pin.applied.post_apply_inspect.precondition_failures, []);
  assert.equal(pin.applied.later_inspect, undefined);
  assert.ok(pin.production_evidence['2026-10-21 apply'].includes(SQL106_APPLIED.ssm));
  assert.equal(pin.expected_live_definition_sha256, PRODUCTION_PRE);
  assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
  assert.equal(pin.production_inspect.status, 'recorded');
  assert.equal(pin.production_inspect.date, '2026-10-21');
  assert.equal(pin.production_inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.production_inspect.ssm_command_id, '4539d0f0-b715-42f6-ba19-ef03252e87c7');
  assert.equal(pin.production_inspect.source_commit, 'fd1e059b573ce16dfe51c07c37827aad2fb9bd04');
  assert.equal(pin.production_inspect.read_only, true);
  assert.deepEqual(pin.production_inspect.precondition_failures, []);
  assert.ok(pin.production_inspect.note.includes('72a7355b26183e3621eec75a09b8b54eeef7a9f507ed23eacd2731775df64238'));
  // What the inspect showed on the table, the same as SQL 97's production inspect of 2026-10-21.
  assert.ok(pin.production_inspect.note.includes('lines ["checksops DELETE", "checksops UPDATE"]'));
  assert.ok(pin.production_inspect.note.includes('16bcba87-7ad4-48b1-a63b-a2de20d25eee'));
  assert.ok(pin.production_inspect.note.includes(' Earlier: Pending: '));
  assert.deepEqual([pin.staging_acceptance.ok, pin.staging_acceptance.reference], [true, PRODUCTION_STAGING_REF]);
  assert.match(pin.staging_acceptance.basis, /^Owner-accepted substitute evidence/);
  assert.match(pin.staging_acceptance.basis, /already_applied true/);
  assert.ok(pin.staging_acceptance.basis.includes(`equal to the intended ${pin.intended_replacement_sha256}`));
  assert.match(pin.staging_acceptance.basis, /The pre-states differ/);
  assert.deepEqual(Object.keys(pin.staging_acceptance).sort(), ['basis', 'ok', 'reference']);
  assert.equal(pin.filename, SQL106_FILE);
  assert.equal(pin.source_sha256, staging.source_sha256);
  assert.equal(pin.staging_pin_commit, staging.commit);
  assert.equal(pin.intended_replacement_sha256, staging.intended_replacement_sha256);
  assert.equal(pin.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(pin.intended_replacement_sha256, '0a159961b80a1887b551d7bc9f187811f62614ef352c00b12bbfe621f109088f');
  assert.deepEqual(pin.function_identities, []);
  assert.deepEqual(pin.function_identities, [...staging.function_identities]);
  assert.deepEqual(pin.predecessors, []);
  assert.deepEqual(pin.predecessors, RELEASE_SQL_SPECS[KEY].predecessors);
  assert.equal(pin.authorization_phrase, 'APPLY_FINANCIAL_STEPUP_LOG_APPEND_ONLY');
  for (const k of ['admin_login', 'rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(pin[k], SQL96_PIN[k], k);
  assert.equal(pin.tooling.status, 'built');
  assert.equal(pin.tooling.production_tool, RELEASE_PRODUCTION[KEY].cli);
  assert.equal(pin.tooling.production_tool, 'scripts/deployment-guard/sql106-financial-stepup-log-append-only-production-apply.mjs');
  assert.equal(pin.tooling.staging_workflow_choice, RELEASE_SQL_SPECS[KEY].choice);
  assert.equal(pin.tooling.one_shot_migration, KEY);
  assert.equal(pin.tooling.runbook, 'ops/production-sql-106-apply.md');
  for (const file of [pin.tooling.production_tool, pin.tooling.runbook, pin.tooling.fingerprint_engine, pin.tooling.production_lib, ...pin.tooling.tests]) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), file);
  }
  assert.equal(readPinnedReleaseSql(KEY, ROOT, pin).ok, true);
  // One-shot: the shared release tool, with its order (like SQL 103 before SQL 29), no hash in the registry.
  const tool = ONE_SHOT_TOOLS[KEY];
  assert.equal(tool.key, KEY);
  assert.equal(tool.script, RELEASE_PRODUCTION[KEY].cli);
  assert.deepEqual([...tool.args], []);
  assert.equal(tool.pin_rel, RELEASE_PRODUCTION[KEY].pin_rel);
  assert.equal(tool.allowed_key, 'sql106_production_apply_allowed');
  assert.deepEqual([...tool.runs_before], ['sql97']);
  assert.deepEqual([...tool.runs_before], RELEASE_SQL_SPECS[KEY].runs_before);
  assert.ok(Object.hasOwn(ONE_SHOT_TOOLS, 'sql97'));
  assert.equal(tool.inspect_requires, undefined);
  assert.doesNotMatch(JSON.stringify(tool), /[0-9a-f]{64}/);
  const cli = fs.readFileSync(path.join(ROOT, tool.script), 'utf8');
  assert.match(cli, /runReleaseProductionTool\(\s*\{ key: 'sql106'/);
  const rows = JSON.stringify(readJson('ops/deployment-guard/bypass-inventory.json'));
  assert.match(rows, /"path":"scripts\/deployment-guard\/sql106-financial-stepup-log-append-only-production-apply\.mjs","classification":"GUARDED","capabilities":\["sql106-production-apply"\]/);
  assert.match(rows, /sql104, sql105, sql106, sql108, sql109, sql110, sql111, sql112, sql113, sql114, sql115, sql116, sql117, sql118, sql119, sql120, sql121, sql122, sql123, sql124, sql125, sql126, sql127, sql128, sql129, sql130\)/);
  const scripts = readJson('package.json').scripts;
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/deployment-guard.yml'), 'utf8');
  for (const name of ['aws/tests/release-sql106-executor.test.mjs', 'aws/tests/release-sql106-production-apply.test.mjs']) {
    assert.ok(scripts['test:deployment-guard'].includes(name), name);
    assert.ok(workflow.includes(name), name);
  }
});

test('order: before SQL 97 (SQL 97 applied after it on 2026-10-21), whose file, fingerprints and spec are unchanged; no plan entry; the runbooks and one-shot doc name it', () => {
  const sql97 = loadReleaseProductionPin('sql97', ROOT);
  // SQL 97's production pin: its file and fingerprints unchanged by SQL 106; applied 2026-10-21
  // after SQL 106 from the same recorded pre-state (SQL 106 does not move SQL 97's fingerprint).
  assert.equal(sql97.source_sha256, 'e3c8fd413f1d60030dd65192bb8696387229a4fd33fc2ae234cd61e52fbb79db');
  assert.equal(sql97.expected_live_definition_sha256, '56b1f63192df1147fbbdd0206226129aeea35467d13c8bf0c8bc399316d06079');
  assert.equal(sql97.intended_replacement_sha256, '5d9b50f5c71da4ca06810c229a67ff1dfd3839ecba83ba4e1829da15eb28edef');
  assert.equal(sql97.applied.result, 'applied');
  assert.equal(sql97.applied.pre_apply_inspect.live_definition_sha256, sql97.expected_live_definition_sha256);
  assert.ok(sql97.applied.one_shot_note.includes(SQL106_APPLIED.ssm));
  assert.ok(sql97.applied.one_shot_note.includes('other_write_grants []'));
  assert.equal(sql97.execute, false);
  assert.deepEqual(sql97.predecessors, []);
  assert.equal(STAGING.sql97.source_sha256, sql97.source_sha256);
  assert.equal(STAGING.sql97.intended_replacement_sha256, sql97.intended_replacement_sha256);
  // SQL 97's file revokes INSERT only; SQL 106's revokes UPDATE / DELETE / TRUNCATE only.
  const sql97Text = fs.readFileSync(path.join(ROOT, SQL97_FILE), 'utf8');
  assert.match(sql97Text, /BEFORE INSERT ON public\.financial_stepup_log/);
  assert.doesNotMatch(sql97Text, /REVOKE (UPDATE|DELETE|TRUNCATE)/);
  assert.match(COMMITTED.order_note, /^Before SQL 97/);
  assert.ok(COMMITTED.order_note.includes('16bcba87-7ad4-48b1-a63b-a2de20d25eee'));
  const plan = readJson('ops/deployment-guard/production-api-overlay-plan.json');
  assert.equal((plan.sql_prerequisites || {})[SQL106_FILE], undefined);
  assert.ok(!JSON.stringify(plan.members).includes(SQL106_FILE));
  const runbook = fs.readFileSync(path.join(ROOT, COMMITTED.tooling.runbook), 'utf8');
  assert.ok(runbook.includes(COMMITTED.intended_replacement_sha256));
  assert.ok(runbook.includes(COMMITTED.source_sha256));
  assert.match(runbook, /before SQL 97/i);
  // SQL 97's review note points at SQL 106.
  const release = fs.readFileSync(path.join(ROOT, 'ops/production-sql-90-97-apply.md'), 'utf8');
  assert.match(release, /SQL 97's guard is BEFORE INSERT only[\s\S]{0,1200}SQL 106/);
  assert.match(release, /ops\/production-sql-106-apply\.md/);
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/production-sql-one-shot.md'), 'utf8'), /\| `sql106` \|/);
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/README.md'), 'utf8'), /sql106-financial-stepup-log-append-only-production-apply\.mjs --inspect/);
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
  const authorizedCopy = Object.freeze({ ...COMMITTED, authorization: 'Owner approved 2026-10-21 (test copy of the execute-authorized pin before its record-and-retire change)', execute: true });
  const copyOk = await evaluateReleaseProductionApply(KEY, manifest(authorizedCopy), { root: ROOT, pin: authorizedCopy });
  assert.equal(copyOk.ok, true, JSON.stringify(copyOk));
  assert.equal(copyOk.details.sql106_production_apply_allowed, true);
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(authorizedCopy), live_definition_sha256: PRE, expected_live_definition_sha256: PRE }, { root: ROOT, pin: authorizedCopy })).code, CODES.SQL_COLLISION);
  // The intended state (staging's) is not production's pre-state: a manifest built on it is refused.
  const onIntended = COMMITTED.intended_replacement_sha256;
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(authorizedCopy), live_definition_sha256: onIntended, expected_live_definition_sha256: onIntended }, { root: ROOT, pin: authorizedCopy })).ok, false);
  const spentPath = consumedPath();
  fs.writeFileSync(spentPath, JSON.stringify({ consumed: [SQL106_APPLIED.one_use_id] }));
  try {
    assert.equal((await precheckReleaseProductionApply(KEY, { ...manifest(authorizedCopy), one_use_id: SQL106_APPLIED.one_use_id }, { root: ROOT, pin: authorizedCopy, consumedPath: spentPath })).code, CODES.RECEIPT_REUSED);
  } finally {
    fs.rmSync(spentPath, { force: true });
  }
  // execute true alone does not authorize it.
  const flipped = { ...withPre, execute: true };
  assert.equal((await evaluateReleaseProductionApply(KEY, manifest(flipped), { root: ROOT, pin: flipped })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);

  const pin = approved();
  const allowed = await evaluateReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(allowed.details.sql106_production_apply_allowed, true);
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect: neverConnect, consumedPath: consumedPath() })).ok, true);
  const otherLive = { ...manifest(pin), expected_live_definition_sha256: 'f'.repeat(64), live_definition_sha256: 'f'.repeat(64) };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherLive, { root: ROOT, pin })).code, CODES.SQL_COLLISION);
  const otherStaging = { ...manifest(pin), staging_acceptance: { ok: true, reference: 'https://example.invalid/x' } };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherStaging, { root: ROOT, pin })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await precheckReleaseProductionApply(KEY, { ...manifest(pin), authorization_phrase: 'APPLY' }, { root: ROOT, pin, consumedPath: consumedPath() })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  // SQL 97's phrase does not authorize SQL 106.
  assert.equal((await precheckReleaseProductionApply(KEY, { ...manifest(pin), authorization_phrase: 'APPLY_FINANCIAL_STEPUP_LOG_SERVER_WRITER' }, { root: ROOT, pin, consumedPath: consumedPath() })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const off = approved({ execute: false });
  const ctx = { root: ROOT, pin: off, connect: neverConnect, consumedPath: consumedPath() };
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  assert.equal((await executeReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  // A tampered file hash is a reconciliation stop.
  assert.equal(readPinnedReleaseSql(KEY, ROOT, { ...COMMITTED, source_sha256: 'f'.repeat(64) }).code, CODES.SQL_COLLISION);

  // CLI: --apply with the committed pin, read from disk, and a manifest not bound to it refuses without connecting
  // or spending a receipt; credential flags are refused.
  const file = path.join(os.tmpdir(), `sql106-cli-${process.pid}.json`);
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
