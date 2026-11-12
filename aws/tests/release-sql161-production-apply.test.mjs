/**
 * Production tool for SQL 161 (scripts/deployment-guard/sql161-tg-mortgage-handling-billing-checksops-execute-production-apply.mjs
 * on lib/release-sql-production-apply.mjs and lib/release-sql-production-cli.mjs). Owner 2026-11-12: "A new SQL 161 that
 * gives staging that one permission, then SQL 160". release-sql90-97-production-apply.test.mjs runs every release key
 * (SQL 161 included) through the shared refusals; this file covers SQL 161's own:
 *
 *   - the pin has the release pin shape, is pending (execute false, no pre-state, no approval) and is in step with the
 *     staging pin, the one-shot, the bypass inventory and the test lists;
 *   - no predecessor; one existing function's EXECUTE ACL (acl_functions, revokes []), nothing created or replaced; no
 *     table, policy, trigger or other grant change; no overlay plan entry; production expected already in the intended
 *     state (not production_noop); the runbook, one-shot doc and README name it;
 *   - the pending pin refuses before connecting; an approved, accepted copy evaluates for the manifest built from it,
 *     and refuses with execute false, another live hash, another staging reference or a wrong phrase; the CLI spends no
 *     receipt.
 * The behavior on PostgreSQL 16 is aws/tests/sql161-tg-mortgage-handling-billing-checksops-execute-pg.test.mjs; the
 * executor path is aws/tests/release-sql161-executor.test.mjs.
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
import { RELEASE_SQL_SPECS, releaseIntendedHash, releaseIntendedState, releaseStateHash } from '../../scripts/deployment-guard/lib/release-sql-state.mjs';
import {
  RELEASE_PRODUCTION,
  evaluateReleaseProductionApply,
  executeReleaseProductionApply,
  loadReleaseProductionPin,
  precheckReleaseProductionApply,
  readPinnedReleaseSql,
} from '../../scripts/deployment-guard/lib/release-sql-production-apply.mjs';
import { main } from '../../scripts/deployment-guard/sql161-tg-mortgage-handling-billing-checksops-execute-production-apply.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql161';
const SQL161_FILE = 'aws/workflows/sql/161_tg_mortgage_handling_billing_checksops_execute.sql';
const FN = 'public.tg_record_mortgage_handling_billing()';
const COMMITTED = loadReleaseProductionPin(KEY, ROOT);
const SQL96_PIN = loadReleaseProductionPin('sql96', ROOT);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PRE = 'e'.repeat(64);
const TEXT = fs.readFileSync(path.join(ROOT, SQL161_FILE), 'utf8');
/** Staging's derived pre-state: PUBLIC and the owner (SQL 160's staging read-live, run 43307779123). */
const STAGING_PRE = (() => {
  const state = releaseIntendedState(KEY, TEXT);
  state.acl_functions[FN].acl = ['PUBLIC EXECUTE grantor=owner', 'owner EXECUTE grantor=owner'];
  return releaseStateHash(KEY, state);
})();
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const keyPaths = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? keyPaths(v, `${p}${k}.`) : [`${p}${k}`]));
const neverConnect = async () => { throw new Error('should-not-connect'); };
const consumedPath = () => path.join(os.tmpdir(), `sql161-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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
    build_timestamp: '2026-11-12T00:00:00.000Z',
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

test('pin: the release pin shape, pending, in step with the staging pin, the one-shot, the inventory and the test lists', () => {
  const pin = COMMITTED;
  const staging = STAGING[KEY];
  const shape = new Set(keyPaths(SQL96_PIN).filter((k) => !/^(applied|production_evidence)(\.|$)/.test(k)));
  assert.deepEqual([...shape].filter((k) => !keyPaths(pin).includes(k)), [], 'lacks the engine pin shape');
  assert.deepEqual(keyPaths(pin).filter((k) => !shape.has(k)), []);
  assert.equal(pin.id, RELEASE_SQL_SPECS[KEY].production_pin_rel.split('/').pop().replace(/\.json$/, ''));
  assert.equal(pin.migration, KEY);
  assert.equal(pin.execute, false);
  assert.equal(pin.authorization, 'pending');
  assert.equal(pin.expected_live_definition_sha256, null);
  assert.equal(pin.applied, undefined);
  assert.equal(pin.production_inspect.status, 'pending');
  assert.equal(pin.production_inspect.live_definition_sha256, null);
  for (const text of ['prerequisites_missing', 'already_applied true', 'precondition_failures', 'INVALID_MANIFEST', pin.intended_replacement_sha256, STAGING_PRE]) {
    assert.ok(pin.production_inspect.note.includes(text), text);
  }
  assert.deepEqual([pin.staging_acceptance.ok, pin.staging_acceptance.reference], [false, null]);
  assert.match(pin.staging_acceptance.basis, /read-live and the staging apply of SQL 161/);
  assert.match(pin.staging_acceptance.basis, /wave 52/);
  assert.equal(pin.filename, SQL161_FILE);
  assert.equal(pin.source_sha256, staging.source_sha256);
  assert.equal(pin.staging_pin_commit, staging.commit);
  assert.equal(pin.intended_replacement_sha256, staging.intended_replacement_sha256);
  assert.equal(pin.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(pin.intended_replacement_sha256, releaseIntendedHash(KEY, TEXT));
  assert.deepEqual(pin.function_identities, RELEASE_SQL_SPECS[KEY].acl_functions.map((fn) => fn.identity));
  assert.deepEqual(pin.function_identities, [FN]);
  assert.deepEqual(pin.function_identities, [...staging.function_identities]);
  assert.deepEqual(pin.predecessors, []);
  assert.deepEqual(pin.predecessors, RELEASE_SQL_SPECS[KEY].predecessors);
  assert.equal(pin.authorization_phrase, 'GRANT_CHECKSOPS_EXECUTE_ON_MORTGAGE_HANDLING_TRIGGER_FUNCTION');
  for (const k of ['admin_login', 'rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(pin[k], SQL96_PIN[k], k);
  assert.equal(pin.tooling.status, 'built');
  assert.equal(pin.tooling.production_tool, RELEASE_PRODUCTION[KEY].cli);
  assert.equal(pin.tooling.production_tool, 'scripts/deployment-guard/sql161-tg-mortgage-handling-billing-checksops-execute-production-apply.mjs');
  assert.equal(pin.tooling.staging_workflow_choice, RELEASE_SQL_SPECS[KEY].choice);
  assert.equal(pin.tooling.one_shot_migration, KEY);
  assert.equal(pin.tooling.runbook, 'ops/production-sql-161-apply.md');
  for (const file of [pin.tooling.production_tool, pin.tooling.runbook, pin.tooling.fingerprint_engine, pin.tooling.production_lib, ...pin.tooling.tests]) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), file);
  }
  assert.equal(readPinnedReleaseSql(KEY, ROOT, pin).ok, true);
  // One-shot: the release tool, no order (no hash in the registry).
  const tool = ONE_SHOT_TOOLS[KEY];
  assert.equal(tool.key, KEY);
  assert.equal(tool.script, RELEASE_PRODUCTION[KEY].cli);
  assert.deepEqual([...tool.args], []);
  assert.equal(tool.pin_rel, RELEASE_PRODUCTION[KEY].pin_rel);
  assert.equal(tool.allowed_key, 'sql161_production_apply_allowed');
  assert.equal(tool.runs_before, undefined);
  assert.equal(tool.inspect_requires, undefined);
  assert.doesNotMatch(JSON.stringify(tool), /[0-9a-f]{64}/);
  const rows = JSON.stringify(readJson('ops/deployment-guard/bypass-inventory.json'));
  assert.match(rows, /"path":"scripts\/deployment-guard\/sql161-tg-mortgage-handling-billing-checksops-execute-production-apply\.mjs","classification":"GUARDED","capabilities":\["sql161-production-apply"\]/);
  assert.match(rows, /sql159, sql160, sql161\)/);
  const scripts = readJson('package.json').scripts;
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/deployment-guard.yml'), 'utf8');
  for (const name of ['aws/tests/release-sql161-executor.test.mjs', 'aws/tests/release-sql161-production-apply.test.mjs', 'aws/tests/sql161-tg-mortgage-handling-billing-checksops-execute-pg.test.mjs']) {
    assert.ok(scripts['test:deployment-guard'].includes(name), name);
    assert.ok(workflow.includes(name), name);
  }
});

test('order: no predecessor; one function\'s EXECUTE ACL, nothing created or replaced; no table, policy, trigger or other grant; no overlay plan entry; the runbook, one-shot doc and README name it', () => {
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.predecessors, []);
  assert.equal(spec.supersedes, undefined);
  assert.equal(spec.production_only, undefined);
  // Production is expected to read as already intended, but the spec does not require it (not production_noop): an
  // inspect that reads otherwise is a stop for the owner, not a refusal coded here.
  assert.equal(spec.production_noop, undefined);
  assert.deepEqual(spec.functions, []);
  assert.deepEqual(spec.acl_functions.map((fn) => [fn.identity, fn.acl, fn.revokes]),
    [[FN, ['PUBLIC EXECUTE grantor=owner', 'checksops EXECUTE grantor=owner', 'owner EXECUTE grantor=owner'], []]]);
  assert.deepEqual(spec.prerequisites, [FN, 'role checksops']);
  for (const absent of ['tables', 'views', 'policies', 'table_privileges', 'column_acl', 'dropped_functions', 'indexes', 'added_columns', 'constraints', 'triggers', 'altered_relations', 'definer_writes']) {
    assert.equal(spec[absent], undefined, absent);
  }
  assert.match(COMMITTED.order_note, /^No predecessor\. SQL 161 sets only the EXECUTE ACL of public\.tg_record_mortgage_handling_billing\(\)/);
  for (const text of ['"A new SQL 161 that gives staging that one permission, then SQL 160"', '43307779123', '83a508fb10b32c30ff702231443ff11f7df68163',
    'observed_functions', 'sql161_function_missing', 'sql161_role_missing', 'revokes []', 'tr_record_mortgage_handling_billing',
    'SQL 160 does not name SQL 161 and is not changed by it', 'No table, trigger, policy, body or other grant change; no API, Lambda or SPA change is part of this pin',
    COMMITTED.intended_replacement_sha256, STAGING_PRE]) {
    assert.ok(COMMITTED.order_note.includes(text), text);
  }
  // No API member waits on SQL 161.
  const plan = readJson('ops/deployment-guard/production-api-overlay-plan.json');
  assert.equal(plan.sql_prerequisites?.[SQL161_FILE], undefined);
  const runbook = fs.readFileSync(path.join(ROOT, COMMITTED.tooling.runbook), 'utf8');
  for (const value of [COMMITTED.intended_replacement_sha256, COMMITTED.source_sha256, STAGING_PRE, 'GRANT_CHECKSOPS_EXECUTE_ON_MORTGAGE_HANDLING_TRIGGER_FUNCTION', 'wave 52', '43307779123']) {
    assert.ok(runbook.includes(value), value);
  }
  assert.match(runbook, /\*\*Status:\*\* staging pin execute-authorized \(wave 52\); not applied anywhere\. The production pin is pending\./);
  const oneShot = fs.readFileSync(path.join(ROOT, 'ops/production-sql-one-shot.md'), 'utf8');
  assert.match(oneShot, /\| `sql161` \|/);
  assert.match(oneShot, /`sql159`, `sql160`, `sql161`\) \|/);
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/README.md'), 'utf8'), /sql161-tg-mortgage-handling-billing-checksops-execute-production-apply\.mjs --inspect/);
});

test('the pending pin refuses before connecting; an approved copy allows only its own manifest; execute false, other hashes and phrases refuse', async () => {
  const noPre = await evaluateReleaseProductionApply(KEY, manifest({ ...COMMITTED, expected_live_definition_sha256: PRE }), { root: ROOT });
  assert.equal(noPre.code, CODES.SQL_COLLISION);
  const withPre = { ...COMMITTED, expected_live_definition_sha256: PRE };
  assert.equal((await evaluateReleaseProductionApply(KEY, manifest(withPre), { root: ROOT, pin: withPre })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await executeReleaseProductionApply(KEY, manifest(withPre), { root: ROOT, pin: withPre, connect: neverConnect, consumedPath: consumedPath() })).ok, false);
  // execute true alone does not authorize it.
  const flipped = { ...withPre, execute: true };
  assert.equal((await evaluateReleaseProductionApply(KEY, manifest(flipped), { root: ROOT, pin: flipped })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);

  const pin = approved();
  const allowed = await evaluateReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(allowed.details.sql161_production_apply_allowed, true);
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect: neverConnect, consumedPath: consumedPath() })).ok, true);
  const otherLive = { ...manifest(pin), expected_live_definition_sha256: 'f'.repeat(64), live_definition_sha256: 'f'.repeat(64) };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherLive, { root: ROOT, pin })).code, CODES.SQL_COLLISION);
  const otherStaging = { ...manifest(pin), staging_acceptance: { ok: true, reference: 'https://example.invalid/x' } };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherStaging, { root: ROOT, pin })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  // SQL 160's phrase does not authorize SQL 161.
  assert.equal((await precheckReleaseProductionApply(KEY, { ...manifest(pin), authorization_phrase: 'STOP_ADDITIONAL_CHECK_AND_OUTSIDE_DEPOSIT_CHARGES' }, { root: ROOT, pin, consumedPath: consumedPath() })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const off = approved({ execute: false });
  const ctx = { root: ROOT, pin: off, connect: neverConnect, consumedPath: consumedPath() };
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  assert.equal((await executeReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  // A tampered file hash is a reconciliation stop.
  assert.equal(readPinnedReleaseSql(KEY, ROOT, { ...COMMITTED, source_sha256: 'f'.repeat(64) }).code, CODES.SQL_COLLISION);

  // CLI: --apply with the committed (pending) pin, read from disk, refuses without connecting
  // or spending a receipt; credential flags are refused.
  const file = path.join(os.tmpdir(), `sql161-cli-${process.pid}.json`);
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
