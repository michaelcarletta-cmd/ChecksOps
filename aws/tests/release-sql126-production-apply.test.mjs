/**
 * Production tool for SQL 126 (scripts/deployment-guard/sql126-definer-reads-caller-gates-production-
 * apply.mjs on lib/release-sql-production-apply.mjs and lib/release-sql-production-cli.mjs).
 * release-sql90-97-production-apply.test.mjs runs every release key (SQL 126 included) through the
 * shared refusals; this file covers SQL 126's own:
 *
 *   - the pin has the release pin shape plus the applied record; it was execute-authorized (owner-
 *     approved pin change of 2026-10-29, #1394) with the recorded production pre-state (staging's plus a
 *     checksops EXECUTE grant) and the staging apply as its acceptance, then applied on 2026-10-29 and
 *     retired (execute false); it is in step with the staging pin, the one-shot, the bypass inventory
 *     and the test lists;
 *   - no predecessor and no order; the thirteen functions (EXECUTE for checksops and the owner) and
 *     the file's prerequisites; no table, view, policy or trigger (the DB validator is not
 *     concerned); no plan entry and no API change (PR #1379's API gates stay in front of the same
 *     functions); the runbook, one-shot doc and README name it;
 *   - the pending (pre-authorization) pin refuses before connecting; the committed pin allows only
 *     the manifest bound to its recorded pre-state; an approved, accepted copy evaluates for the
 *     manifest built from it, and refuses with execute false, another live hash, another staging
 *     reference or a wrong phrase; the CLI spends no receipt.
 * The behavior on PostgreSQL 16 is aws/tests/sql126-definer-reads-caller-gates-pg.test.mjs; the
 * executor path is aws/tests/release-sql126-executor.test.mjs.
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
import { main } from '../../scripts/deployment-guard/sql126-definer-reads-caller-gates-production-apply.mjs';
import { SQL126_IDENTITIES } from './helpers/sql126-definer-reads-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql126';
const SQL126_FILE = 'aws/workflows/sql/126_definer_reads_caller_gates.sql';
const COMMITTED = loadReleaseProductionPin(KEY, ROOT);
const SQL96_PIN = loadReleaseProductionPin('sql96', ROOT);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PRE = 'e'.repeat(64);
// SQL 126's recorded production pre-state (read-only inspect of 2026-10-29, SSM a98a1794, main 56a748c06): the
// thirteen functions with their supabase bodies and EXECUTE PUBLIC, checksops and the owner.
const PRODUCTION_PRE = '9ebc7455de1e0e467eabf59e697899bc64dc360efb8c34a3e00106e68b7754ed';
// The guarded staging apply (wave 25).
const STAGING_ACCEPTANCE_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/40921170890';
const OWNER_WORDS = '"open the SQL 126 production pin PR"';
// SQL 126's production apply of 2026-10-29 (main 67a0ed214), recorded in applied; the owner's words were
// passed to the run verbatim.
const SQL126_APPLIED = Object.freeze({ ssm: '9edcb2f7-365f-47cb-a395-17d033b4e179', run: '423ed639-30de-4aa0-99a0-981f1aeeb8a6', one_use_id: 'sql126-prod-04d193c4-cf33-4b78-9510-4cc0b643de2b', commit: '67a0ed2147e7d87c113b1ea08dedb52fc630d186', workstream: 'prod-sql126-definer-reads-caller-gates-20261029', approval: 'apply SQL 126 in production' });
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const keyPaths = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? keyPaths(v, `${p}${k}.`) : [`${p}${k}`]));
const neverConnect = async () => { throw new Error('should-not-connect'); };
const consumedPath = () => path.join(os.tmpdir(), `sql126-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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
    build_timestamp: '2026-10-29T00:00:00.000Z',
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

test('pin: the release pin shape, applied and retired (owner approved 2026-10-29, on the staging apply), in step with the staging pin, the one-shot, the inventory and the test lists', () => {
  const pin = COMMITTED;
  const staging = STAGING[KEY];
  const shape = new Set(keyPaths(SQL96_PIN).filter((k) => !/^(applied|production_evidence)(\.|$)/.test(k)));
  assert.deepEqual([...shape].filter((k) => !keyPaths(pin).includes(k)), [], 'lacks the engine pin shape');
  // The record-and-retire change adds applied and production_evidence on top of the engine pin shape.
  assert.deepEqual(keyPaths(pin).filter((k) => !shape.has(k) && !/^(applied|production_evidence)(\.|$)/.test(k)), []);
  assert.equal(pin.id, RELEASE_SQL_SPECS[KEY].production_pin_rel.split('/').pop().replace(/\.json$/, ''));
  assert.equal(pin.migration, KEY);
  // Applied 2026-10-29 and retired.
  assert.equal(pin.execute, false);
  assert.match(pin.authorization, /^Applied to production on 2026-10-29; execute is false again/);
  assert.doesNotMatch(pin.authorization, /^Owner approved/);
  assert.ok(pin.authorization.includes(OWNER_WORDS));
  assert.ok(pin.authorization.includes('#1394'));
  assert.ok(pin.authorization.includes(SQL126_APPLIED.workstream));
  assert.ok(pin.authorization.includes(`"${SQL126_APPLIED.approval}"`));
  assert.equal(pin.expected_live_definition_sha256, PRODUCTION_PRE);
  assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
  assert.equal(pin.applied.date, '2026-10-29');
  assert.equal(pin.applied.result, 'applied');
  assert.equal(pin.applied.apply_ssm_command_id, SQL126_APPLIED.ssm);
  assert.equal(pin.applied.one_shot_run_id, SQL126_APPLIED.run);
  assert.equal(pin.applied.one_use_id, SQL126_APPLIED.one_use_id);
  assert.equal(pin.applied.one_use_id_consumed, true);
  assert.equal(pin.applied.workstream_id, SQL126_APPLIED.workstream);
  assert.equal(pin.applied.source_commit, SQL126_APPLIED.commit);
  assert.equal(pin.applied.source_tarball.sha256, 'e787b68a7bd5ed5eaf6850664ea9cc72674af78e2b70909f243ad7a7041123d1');
  assert.equal(pin.applied.migration_source_sha256, pin.source_sha256);
  assert.equal(pin.applied.owner_approval, SQL126_APPLIED.approval);
  assert.deepEqual(pin.applied.steps, ['pin', 'source', 'inspect', 'contracts', 'manifest', 'source-recheck-before-preflight', 'preflight', 'evaluate', 'source-recheck-before-apply', 'apply', 'post-apply-inspect']);
  assert.deepEqual(Object.values(pin.applied.contract_results).map((c) => c.ok), [true, true, true]);
  assert.equal(pin.applied.manifest_sha256, '1c7cfda5088935a035ffbcebbe325632895ed82d86b57044320406f7038bfb52');
  assert.equal(pin.applied.receipt.unrelated_catalog_sha256, 'afd0eb25ad38ef96d95184abc9af409e2d8676b98303a9c82bc1d9d43f6fee15');
  assert.match(pin.applied.one_shot_note, /SSM 2d484262-acf7-40ac-8df4-ad5a4ec566c5/);
  assert.match(pin.applied.one_shot_note, /SSM b0915da8-e5d7-41ea-9ccc-4cd819c76465/);
  // What the record could not capture is stated, not reconstructed.
  assert.match(pin.applied.one_shot_note, /Not captured from the apply run: the contract test counts/);
  assert.equal(pin.applied.receipt.unrelated_catalog_counts, undefined);
  assert.equal(pin.applied.pre_apply_inspect.release_sql_inspect.functions, undefined);
  assert.match(pin.applied.one_shot_note, /stopped 18:21:44/);
  assert.equal(pin.applied.pre_apply_inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.applied.pre_apply_inspect.live_matches_expected, true);
  assert.deepEqual(pin.applied.pre_apply_inspect.precondition_failures, []);
  assert.equal(pin.applied.receipt.before_hash, PRODUCTION_PRE);
  assert.equal(pin.applied.receipt.after_hash, pin.intended_replacement_sha256);
  assert.equal(pin.applied.receipt.staging_acceptance, pin.staging_acceptance.reference);
  assert.equal(pin.applied.receipt.result, 'applied');
  assert.equal(pin.applied.post_apply_inspect.already_applied, true);
  assert.equal(pin.applied.post_apply_inspect.live_definition_sha256, pin.intended_replacement_sha256);
  assert.deepEqual(pin.applied.post_apply_inspect.precondition_failures, []);
  assert.ok(pin.production_evidence['2026-10-29 apply'].includes(SQL126_APPLIED.ssm));
  assert.equal(pin.production_inspect.status, 'recorded');
  assert.equal(pin.production_inspect.date, '2026-10-29');
  assert.equal(pin.production_inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.production_inspect.ssm_command_id, 'a98a1794-509b-4689-ada4-1a35f32bbdaa');
  assert.equal(pin.production_inspect.source_commit, '56a748c06e78220c6d0a82c0c83b623e9e116574');
  assert.equal(pin.production_inspect.read_only, true);
  assert.equal(pin.production_inspect.connected_as, 'checksops_admin');
  assert.equal(pin.production_inspect.apply_preconditions_met, false);
  assert.deepEqual(pin.production_inspect.precondition_failures, []);
  assert.ok(pin.production_inspect.note.includes('26e22d758d452b17a87ffe0e5572bad38f74d009ca83c66dc6d94dd1ec4c4321'));
  assert.ok(pin.production_inspect.note.includes(`migration source sha256 on the runner ${pin.source_sha256} == source_sha256`));
  assert.match(pin.production_inspect.note, /stopped 17:50:05/);
  assert.match(pin.production_inspect.note, /function_acl on every one PUBLIC EXECUTE, checksops EXECUTE and owner EXECUTE/);
  assert.match(pin.production_inspect.note, /differs from staging's \(read-live run 40917478177, [0-9a-f]{64}: the same bodies with EXECUTE PUBLIC and the owner only\) by the checksops EXECUTE grant alone/);
  assert.ok(pin.production_inspect.note.includes(' Earlier: Pending: '));
  assert.match(pin.production_inspect.note, /If already_applied is true, or precondition_failures is not \[\], stop/);
  assert.match(pin.production_inspect.note, /prerequisites_missing/);
  assert.match(pin.production_inspect.note, /functions_owned_by_login/);
  assert.match(pin.production_inspect.note, /function_results_match/);
  assert.match(pin.production_inspect.note, /function_acl_replaceable/);
  assert.deepEqual([pin.staging_acceptance.ok, pin.staging_acceptance.reference], [true, STAGING_ACCEPTANCE_REF]);
  assert.match(pin.staging_acceptance.basis, /^Guarded staging SQL executor apply of sql126-definer-reads-caller-gates, run 40921170890/);
  assert.match(pin.staging_acceptance.basis, /deploy run 40920738142/);
  assert.match(pin.staging_acceptance.basis, /Read-live run 40921576727 then reported live 3aebf853/);
  assert.ok(pin.staging_acceptance.basis.includes(`receipt before ${staging.expected_live_definition_sha256}, after ${pin.intended_replacement_sha256} == intended`));
  assert.match(pin.staging_acceptance.basis, /The pre-states differ/);
  assert.deepEqual(Object.keys(pin.staging_acceptance).sort(), ['basis', 'ok', 'reference']);
  // Staging's recorded pre-state (wave 25) is not production's: production also grants checksops EXECUTE.
  assert.notEqual(staging.expected_live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.filename, SQL126_FILE);
  assert.equal(pin.source_sha256, staging.source_sha256);
  assert.equal(pin.staging_pin_commit, staging.commit);
  assert.equal(pin.intended_replacement_sha256, staging.intended_replacement_sha256);
  assert.equal(pin.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(pin.intended_replacement_sha256, releaseIntendedHash(KEY, fs.readFileSync(path.join(ROOT, SQL126_FILE), 'utf8')));
  assert.deepEqual(pin.function_identities, RELEASE_SQL_SPECS[KEY].functions.map((fn) => fn.identity));
  assert.deepEqual(pin.function_identities, SQL126_IDENTITIES);
  assert.deepEqual(pin.function_identities, [...staging.function_identities]);
  assert.deepEqual(pin.predecessors, []);
  assert.deepEqual(pin.predecessors, RELEASE_SQL_SPECS[KEY].predecessors);
  assert.equal(pin.authorization_phrase, 'APPLY_DEFINER_READS_CALLER_GATES');
  for (const k of ['admin_login', 'rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(pin[k], SQL96_PIN[k], k);
  assert.equal(pin.tooling.status, 'built');
  assert.equal(pin.tooling.production_tool, RELEASE_PRODUCTION[KEY].cli);
  assert.equal(pin.tooling.production_tool, 'scripts/deployment-guard/sql126-definer-reads-caller-gates-production-apply.mjs');
  assert.equal(pin.tooling.staging_workflow_choice, RELEASE_SQL_SPECS[KEY].choice);
  assert.equal(pin.tooling.one_shot_migration, KEY);
  assert.equal(pin.tooling.runbook, 'ops/production-sql-126-apply.md');
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
  assert.equal(tool.allowed_key, 'sql126_production_apply_allowed');
  assert.equal(tool.runs_before, undefined);
  assert.equal(RELEASE_SQL_SPECS[KEY].runs_before, undefined);
  assert.equal(tool.inspect_requires, undefined);
  assert.doesNotMatch(JSON.stringify(tool), /[0-9a-f]{64}/);
  const rows = JSON.stringify(readJson('ops/deployment-guard/bypass-inventory.json'));
  assert.match(rows, /"path":"scripts\/deployment-guard\/sql126-definer-reads-caller-gates-production-apply\.mjs","classification":"GUARDED","capabilities":\["sql126-production-apply"\]/);
  assert.match(rows, /sql120, sql121, sql122, sql123, sql124, sql125, sql126, sql127, sql128, sql129, sql130, sql131, sql132, sql133, sql134, sql135\)/);
  const scripts = readJson('package.json').scripts;
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/deployment-guard.yml'), 'utf8');
  for (const name of ['aws/tests/release-sql126-executor.test.mjs', 'aws/tests/release-sql126-production-apply.test.mjs', 'aws/tests/sql126-definer-reads-caller-gates-pg.test.mjs']) {
    assert.ok(scripts['test:deployment-guard'].includes(name), name);
    assert.ok(workflow.includes(name), name);
  }
});

test('order: no predecessor and no order; the thirteen functions and the file\'s prerequisites; no table, view, policy, trigger, plan entry or API change; the runbook, one-shot doc and README name it', () => {
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.predecessors, []);
  assert.deepEqual(spec.functions.map((fn) => fn.identity), SQL126_IDENTITIES);
  for (const fn of spec.functions) assert.deepEqual(fn.acl, ['checksops EXECUTE', 'owner EXECUTE'], fn.identity);
  assert.deepEqual(spec.prerequisites.slice(0, SQL126_IDENTITIES.length), SQL126_IDENTITIES);
  assert.equal(spec.prerequisites.at(-1), 'role checksops');
  for (const absent of ['tables', 'views', 'policies', 'triggers', 'altered_relations', 'definer_writes']) assert.equal(spec[absent], undefined, absent);
  assert.match(COMMITTED.order_note, /^No predecessor and no ordering constraint\./);
  assert.match(COMMITTED.order_note, /no API or SPA change is needed/);
  const plan = readJson('ops/deployment-guard/production-api-overlay-plan.json');
  assert.equal((plan.sql_prerequisites || {})[SQL126_FILE], undefined);
  assert.ok(!JSON.stringify(plan.members).includes(SQL126_FILE));
  // No API change: PR #1379's gates stay in front of the same functions.
  const data = fs.readFileSync(path.join(ROOT, 'aws/functions/api/data.mjs'), 'utf8');
  const from = data.indexOf('export const RPC_ACCESS_GATES');
  const gates = data.slice(from, data.indexOf('});', from));
  for (const name of ['get_all_checks_safety_net', 'get_stuck_checks', 'get_deposit_ops_kpis', 'get_deposit_exception_kpis', 'get_deposit_aging_summary',
    'get_check_dashboard_counts_for_tenant', 'get_loss_draft_dashboard_counts_for_tenant', 'get_tenant_check_usage', 'get_tenant_users_with_profiles',
    'is_checkalt_enabled_for_tenant', 'get_check_claim_settlement', 'has_permission']) {
    assert.match(gates, new RegExp(`\\b${name}: \\{`), name);
  }
  // No trigger, table, view or policy: the DB validator's public trigger count is not concerned.
  const text = fs.readFileSync(path.join(ROOT, SQL126_FILE), 'utf8').replace(/--[^\n]*/g, '');
  assert.doesNotMatch(text, /\bCREATE\s+(OR\s+REPLACE\s+)?(TRIGGER|VIEW|TABLE|POLICY)\b/i);
  assert.doesNotMatch(text, /\bDROP\b/i);
  const runbook = fs.readFileSync(path.join(ROOT, COMMITTED.tooling.runbook), 'utf8');
  assert.ok(runbook.includes(COMMITTED.intended_replacement_sha256));
  assert.ok(runbook.includes(COMMITTED.source_sha256));
  assert.match(runbook, /\*\*Status:\*\* applied to staging \(wave 25\) and to production \(2026-10-29\); the production pin is retired/);
  assert.match(runbook, /\*\*Production apply \(2026-10-29\)\.\*\*/);
  assert.match(runbook, /SSM\s+`a98a1794-509b-4689-ada4-1a35f32bbdaa`/);
  assert.match(runbook, /Apply run 40921170890 [^\n]*\n\s+before `04106521[0-9a-f]{56}`, after\n\s+`3aebf853[0-9a-f]{56}` \(intended\), result `applied`/);
  assert.match(runbook, /Read-live run 40921576727: live `3aebf853…`/);
  assert.match(runbook, /read-live \(2026-10-29\)\.\*\* Run 40917478177/);
  const oneShot = fs.readFileSync(path.join(ROOT, 'ops/production-sql-one-shot.md'), 'utf8');
  assert.match(oneShot, /\| `sql126` \|/);
  assert.match(oneShot, /`sql124`, `sql125`, `sql126`, `sql127`, `sql128`, `sql129`, `sql130`, `sql131`, `sql132`, `sql133`, `sql134`, `sql135`\) \|/);
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/README.md'), 'utf8'), /sql126-definer-reads-caller-gates-production-apply\.mjs --inspect/);
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

  // The committed pin is retired (execute false): an execute-authorized copy of it, before the
  // record-and-retire change, allows only the manifest bound to its recorded pre-state; staging's
  // pre-state (without the checksops grant) is not it.
  const AUTHORIZED = Object.freeze({ ...COMMITTED, execute: true, authorization: 'Owner approved 2026-10-29 (test copy of the execute-authorized pin before its record-and-retire change)' });
  const committedOk = await evaluateReleaseProductionApply(KEY, manifest(AUTHORIZED), { root: ROOT, pin: AUTHORIZED });
  assert.equal(committedOk.ok, true, JSON.stringify(committedOk));
  assert.equal(committedOk.details.sql126_production_apply_allowed, true);
  assert.equal(committedOk.details.staging_acceptance, STAGING_ACCEPTANCE_REF);
  for (const other of [PRE, STAGING[KEY].expected_live_definition_sha256]) {
    assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(AUTHORIZED), live_definition_sha256: other, expected_live_definition_sha256: other }, { root: ROOT, pin: AUTHORIZED })).code, CODES.SQL_COLLISION, other);
  }
  const onIntended = COMMITTED.intended_replacement_sha256;
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(AUTHORIZED), live_definition_sha256: onIntended, expected_live_definition_sha256: onIntended }, { root: ROOT, pin: AUTHORIZED })).ok, false);
  // The retired committed pin refuses before connecting.
  assert.equal((await executeReleaseProductionApply(KEY, manifest(COMMITTED), { root: ROOT, connect: neverConnect, consumedPath: consumedPath() })).ok, false);

  const pin = approved();
  const allowed = await evaluateReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(allowed.details.sql126_production_apply_allowed, true);
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
  const file = path.join(os.tmpdir(), `sql126-cli-${process.pid}.json`);
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