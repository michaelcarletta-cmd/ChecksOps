/**
 * Production tool for SQL 119 (scripts/deployment-guard/sql119-provider-stakeholder-sync-acl-
 * production-apply.mjs on lib/release-sql-production-apply.mjs and
 * lib/release-sql-production-cli.mjs). release-sql90-97-production-apply.test.mjs runs every
 * release key (SQL 119 included) through the shared refusals; this file covers SQL 119's own:
 *
 *   - the pin has the release pin shape; it is execute-authorized (owner-approved pin change of
 *     2026-10-27) with the recorded production pre-state and the staging read-live (already in the
 *     intended state there) as its acceptance; it is in step with the staging pin (still pending: no
 *     staging apply), the one-shot (runs_before sql115), the bypass inventory and the test lists;
 *   - the order: immediately before SQL 115 (pin order_note, runbook, SQL 115's runbook,
 *     one-shot), whose file and fingerprint are unchanged; no plan entry (no Lambda member);
 *   - the pending (pre-authorization) pin refuses before connecting; the committed pin allows only
 *     the manifest bound to its recorded pre-state; an approved, accepted copy evaluates for the
 *     manifest built from it, and refuses with execute false, another live hash, another staging
 *     reference or a wrong phrase; the CLI spends no receipt.
 * The PostgreSQL 16 inspect / apply (then SQL 115) is aws/tests/sql119-provider-stakeholder-sync-acl-pg.test.mjs.
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
import { main } from '../../scripts/deployment-guard/sql119-provider-stakeholder-sync-acl-production-apply.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql119';
const SQL119_FILE = 'aws/workflows/sql/119_provider_stakeholder_sync_acl.sql';
const FN = 'public.sync_provider_stakeholder_account(uuid)';
const COMMITTED = loadReleaseProductionPin(KEY, ROOT);
const SQL96_PIN = loadReleaseProductionPin('sql96', ROOT);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PRE = 'e'.repeat(64);
// SQL 119's recorded production pre-state (read-only inspect of 2026-10-27, SSM 0019857c, main
// 24c7c545e): EXECUTE for PUBLIC, checksops and the owner, each granted by the owner.
const PRODUCTION_PRE = '249237decc1f079bf04915a5f42862792efb13f00729a8d0bbbfdb8b5c456e35';
// The guarded staging read-live (already in the intended state there; no staging apply).
const STAGING_ACCEPTANCE_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/40501861802';
const OWNER_WORDS = '"Approve a pin PR for SQL 119, then one for SQL 115"';
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const keyPaths = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? keyPaths(v, `${p}${k}.`) : [`${p}${k}`]));
const neverConnect = async () => { throw new Error('should-not-connect'); };
const consumedPath = () => path.join(os.tmpdir(), `sql119-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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
    build_timestamp: '2026-10-27T00:00:00.000Z',
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

test('pin: the release pin shape, execute-authorized on the staging read-live, in step with the staging pin, the one-shot, the inventory and the test lists', () => {
  const pin = COMMITTED;
  const staging = STAGING[KEY];
  const shape = new Set(keyPaths(SQL96_PIN).filter((k) => !/^(applied|production_evidence)(\.|$)/.test(k)));
  assert.deepEqual([...shape].filter((k) => !keyPaths(pin).includes(k)), [], 'lacks the engine pin shape');
  assert.deepEqual(keyPaths(pin).filter((k) => !shape.has(k)), []);
  assert.equal(pin.id, RELEASE_SQL_SPECS[KEY].production_pin_rel.split('/').pop().replace(/\.json$/, ''));
  assert.equal(pin.migration, KEY);
  // Owner-approved pin change of 2026-10-27: the read-only production inspect (SSM 0019857c, main
  // 24c7c545e) recorded as the pre-state; the staging read-live (run 40501861802) as the acceptance.
  assert.equal(pin.execute, true);
  assert.match(pin.authorization, /^Owner approved 2026-10-27 /);
  assert.ok(pin.authorization.includes(OWNER_WORDS));
  assert.ok(pin.authorization.includes(`${PRODUCTION_PRE} -> ${pin.intended_replacement_sha256}`));
  assert.match(pin.authorization, /each apply still needs the owner's run-time approval/);
  assert.equal(pin.expected_live_definition_sha256, PRODUCTION_PRE);
  assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
  assert.equal(pin.applied, undefined);
  assert.equal(pin.production_inspect.status, 'recorded');
  assert.equal(pin.production_inspect.date, '2026-10-27');
  assert.equal(pin.production_inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.production_inspect.ssm_command_id, '0019857c-86f0-46da-94e4-1805e6cd6cd7');
  assert.equal(pin.production_inspect.source_commit, '24c7c545e4bbf7c68c4ee2db1d257ae0c25f1380');
  assert.equal(pin.production_inspect.read_only, true);
  assert.equal(pin.production_inspect.connected_as, 'checksops_admin');
  assert.equal(pin.production_inspect.apply_preconditions_met, false);
  assert.deepEqual(pin.production_inspect.precondition_failures, []);
  assert.ok(pin.production_inspect.note.includes('87d41441e36b92bd669e11c36078c9fd830f283b0ca7d284cec65a8fd8670dad'));
  assert.ok(pin.production_inspect.note.includes(`migration source sha256 on the runner ${pin.source_sha256} == source_sha256`));
  assert.ok(pin.production_inspect.note.includes('PUBLIC EXECUTE grantor=owner, checksops EXECUTE grantor=owner, owner EXECUTE grantor=owner'));
  assert.ok(pin.production_inspect.note.includes(' Earlier: Pending: '));
  assert.match(pin.production_inspect.note, /If already_applied is true, or precondition_failures is not \[\], stop/);
  // Staging acceptance: the guarded staging read-live (already in place there; no staging apply).
  assert.deepEqual([pin.staging_acceptance.ok, pin.staging_acceptance.reference], [true, STAGING_ACCEPTANCE_REF]);
  assert.match(pin.staging_acceptance.basis, /^Guarded staging SQL executor read-live of sql119-provider-stakeholder-sync-acl, run 40501861802/);
  assert.match(pin.staging_acceptance.basis, /deploy run 40501540682/);
  assert.match(pin.staging_acceptance.basis, /already_applied true, precondition_failures \[\]/);
  assert.match(pin.staging_acceptance.basis, /no staging apply was needed or run/);
  assert.ok(pin.staging_acceptance.basis.includes(`${pin.intended_replacement_sha256} == intended`));
  assert.ok(pin.staging_acceptance.basis.includes(`production (production_inspect) is ${PRODUCTION_PRE}`));
  assert.deepEqual(Object.keys(pin.staging_acceptance).sort(), ['basis', 'ok', 'reference']);
  // The staging pin stays pending: no staging apply.
  assert.equal(staging.execute, false);
  assert.equal(staging.authorization, 'pending');
  assert.equal(staging.expected_live_definition_sha256, null);
  assert.equal(pin.filename, SQL119_FILE);
  assert.equal(pin.source_sha256, staging.source_sha256);
  assert.equal(pin.staging_pin_commit, staging.commit);
  assert.equal(pin.intended_replacement_sha256, staging.intended_replacement_sha256);
  assert.equal(pin.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(pin.intended_replacement_sha256, '3d62a511f479415b3a30ec532583527dc0f457ef3e6a2810bdccfab707dc0888');
  assert.deepEqual(pin.function_identities, RELEASE_SQL_SPECS[KEY].acl_functions.map((fn) => fn.identity));
  assert.deepEqual(pin.function_identities, [FN]);
  assert.deepEqual(pin.function_identities, [...staging.function_identities]);
  assert.deepEqual(pin.predecessors, []);
  assert.deepEqual(pin.predecessors, RELEASE_SQL_SPECS[KEY].predecessors);
  assert.equal(pin.authorization_phrase, 'APPLY_PROVIDER_STAKEHOLDER_SYNC_ACL');
  for (const k of ['admin_login', 'rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(pin[k], SQL96_PIN[k], k);
  assert.equal(pin.tooling.status, 'built');
  assert.equal(pin.tooling.production_tool, RELEASE_PRODUCTION[KEY].cli);
  assert.equal(pin.tooling.production_tool, 'scripts/deployment-guard/sql119-provider-stakeholder-sync-acl-production-apply.mjs');
  assert.equal(pin.tooling.staging_workflow_choice, RELEASE_SQL_SPECS[KEY].choice);
  assert.equal(pin.tooling.one_shot_migration, KEY);
  assert.equal(pin.tooling.runbook, 'ops/production-sql-119-apply.md');
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
  assert.equal(tool.allowed_key, 'sql119_production_apply_allowed');
  assert.deepEqual([...tool.runs_before], ['sql115']);
  assert.deepEqual([...tool.runs_before], RELEASE_SQL_SPECS[KEY].runs_before);
  assert.ok(Object.hasOwn(ONE_SHOT_TOOLS, 'sql115'));
  assert.equal(tool.inspect_requires, undefined);
  assert.doesNotMatch(JSON.stringify(tool), /[0-9a-f]{64}/);
  const rows = JSON.stringify(readJson('ops/deployment-guard/bypass-inventory.json'));
  assert.match(rows, /"path":"scripts\/deployment-guard\/sql119-provider-stakeholder-sync-acl-production-apply\.mjs","classification":"GUARDED","capabilities":\["sql119-production-apply"\]/);
  assert.match(rows, /sql115, sql116, sql117, sql118, sql119\)/);
  const scripts = readJson('package.json').scripts;
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/deployment-guard.yml'), 'utf8');
  for (const name of ['aws/tests/release-sql119-executor.test.mjs', 'aws/tests/release-sql119-production-apply.test.mjs']) {
    assert.ok(scripts['test:deployment-guard'].includes(name), name);
    assert.ok(workflow.includes(name), name);
  }
});

test('order: immediately before SQL 115 (unchanged, intended 8aed39a4...), whose guard refuses the checksops line; no plan entry; the runbooks and one-shot doc name it', () => {
  const sql115 = loadReleaseProductionPin('sql115', ROOT);
  assert.equal(sql115.intended_replacement_sha256, '8aed39a49d988a60bdedac07a3a97f424a9de5c1499e4f50738f749326a62452');
  assert.equal(sql115.source_sha256, STAGING.sql115.source_sha256);
  // SQL 115's production pin records the pre-state taken after SQL 119's production apply (owner EXECUTE
  // only), not production's state before it.
  assert.equal(sql115.execute, true);
  assert.equal(sql115.expected_live_definition_sha256, 'ee9d2d5222dd9f8850173384b13468154fa03def6487824c3ef378db4874775b');
  assert.notEqual(sql115.expected_live_definition_sha256, '83d480ac50c23dbbe7c796a32be579aa69e25c4c020d00ecf171980a6b95cd6e');
  assert.deepEqual(sql115.function_identities, [FN]);
  // SQL 115's spec keeps the owner's EXECUTE only and revokes PUBLIC, anon, authenticated and
  // service_role: production's checksops line is not one it may revoke (function_acl_replaceable).
  assert.deepEqual(RELEASE_SQL_SPECS.sql115.functions[0].revokes, ['PUBLIC EXECUTE', 'anon EXECUTE', 'authenticated EXECUTE', 'service_role EXECUTE']);
  assert.deepEqual(RELEASE_SQL_SPECS[KEY].acl_functions[0].acl, ['owner EXECUTE grantor=owner']);
  assert.ok(RELEASE_SQL_SPECS[KEY].acl_functions[0].revokes.includes('checksops EXECUTE grantor=owner'));
  assert.deepEqual(RELEASE_SQL_SPECS[KEY].predecessors, []);
  assert.deepEqual(RELEASE_SQL_SPECS[KEY].runs_before, ['sql115']);
  assert.match(COMMITTED.order_note, /^Immediately before SQL 115/);
  assert.match(COMMITTED.order_note, /SSM 2db258df-47a8-414b-b7c6-b9686768c5b9/);
  assert.match(COMMITTED.order_note, /precondition_failures \[function_acl_replaceable\]/);
  const plan = readJson('ops/deployment-guard/production-api-overlay-plan.json');
  assert.equal((plan.sql_prerequisites || {})[SQL119_FILE], undefined);
  assert.ok(!JSON.stringify(plan.members).includes(SQL119_FILE));
  const runbook = fs.readFileSync(path.join(ROOT, COMMITTED.tooling.runbook), 'utf8');
  assert.ok(runbook.includes(COMMITTED.intended_replacement_sha256));
  assert.ok(runbook.includes(COMMITTED.source_sha256));
  assert.match(runbook, /\*\*Status:\*\* staging already in the intended state \(no apply\); production pin execute-authorized/);
  assert.match(runbook, /SSM\s+`0019857c-86f0-46da-94e4-1805e6cd6cd7`/);
  assert.match(runbook, /read-live \(2026-10-27\)\.\*\* Run 40501861802/);
  assert.match(runbook, /1\. \*\*SQL 119\*\* \(this runbook\)\.\n2\. \*\*SQL 115\*\*/);
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/production-sql-115-apply.md'), 'utf8'), /\*\*Production: SQL 119 first\.\*\*/);
  const oneShot = fs.readFileSync(path.join(ROOT, 'ops/production-sql-one-shot.md'), 'utf8');
  assert.match(oneShot, /\| `sql119` \|/);
  assert.match(oneShot, /`sql118`, `sql119`\) \|/);
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/README.md'), 'utf8'), /sql119-provider-stakeholder-sync-acl-production-apply\.mjs --inspect/);
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

  // The committed (authorized) pin allows only the manifest bound to its recorded pre-state.
  const committedOk = await evaluateReleaseProductionApply(KEY, manifest(COMMITTED), { root: ROOT });
  assert.equal(committedOk.ok, true, JSON.stringify(committedOk));
  assert.equal(committedOk.details.sql119_production_apply_allowed, true);
  assert.equal(committedOk.details.staging_acceptance, STAGING_ACCEPTANCE_REF);
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(COMMITTED), live_definition_sha256: PRE, expected_live_definition_sha256: PRE }, { root: ROOT })).code, CODES.SQL_COLLISION);
  // The intended state is not production's pre-state: a manifest built on it is refused.
  const onIntended = COMMITTED.intended_replacement_sha256;
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(COMMITTED), live_definition_sha256: onIntended, expected_live_definition_sha256: onIntended }, { root: ROOT })).ok, false);

  const pin = approved();
  const allowed = await evaluateReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(allowed.details.sql119_production_apply_allowed, true);
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
  const file = path.join(os.tmpdir(), `sql119-cli-${process.pid}.json`);
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
