/**
 * Production tool for SQL 128 (scripts/deployment-guard/sql128-contractor-verification-from-compliance-
 * production-apply.mjs on lib/release-sql-production-apply.mjs and lib/release-sql-production-cli.mjs).
 * release-sql90-97-production-apply.test.mjs runs every release key (SQL 128 included) through the
 * shared refusals; this file covers SQL 128's own:
 *
 *   - the pin has the release pin shape plus the applied record; it was execute-authorized (owner-
 *     approved pin change of 2026-10-30, #1437) with the recorded production pre-state (derived from
 *     bytes in release-sql128-executor.test.mjs) and the staging apply as its acceptance, then applied
 *     on 2026-10-30 and retired (execute false); it is in step with the staging pin, the one-shot, the
 *     bypass inventory and the test lists;
 *   - no predecessor and no order; the function (EXECUTE for checksops and the owner), the
 *     prerequisites (the function, the five tables and their columns, role checksops) and the
 *     dropped orphan trigger function; no table, view, policy or trigger (the DB validator is not
 *     concerned); no plan entry; the API's existing calls keep the same signature; the runbook,
 *     one-shot doc and README name it;
 *   - the pending (pre-authorization) pin refuses before connecting; the committed pin allows only
 *     the manifest bound to its recorded pre-state; an approved, accepted copy evaluates for the
 *     manifest built from it, and refuses with execute false, another live hash, another staging
 *     reference or a wrong phrase; the CLI spends no receipt.
 * The behavior on PostgreSQL 16 is aws/tests/sql128-contractor-verification-pg.test.mjs; the
 * executor path is aws/tests/release-sql128-executor.test.mjs.
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
import { main } from '../../scripts/deployment-guard/sql128-contractor-verification-from-compliance-production-apply.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql128';
const SQL128_FILE = 'aws/workflows/sql/128_contractor_verification_from_compliance.sql';
const SQL128_IDENTITIES = Object.freeze(['public.contractor_verification_status(uuid)']);
const COMMITTED = loadReleaseProductionPin(KEY, ROOT);
const SQL96_PIN = loadReleaseProductionPin('sql96', ROOT);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PRE = 'e'.repeat(64);
// SQL 128's recorded production pre-state (read-only inspect of 2026-10-30, SSM 54ccb458, main c19b0444a):
// the restored supabase function and the orphan docs trigger function, EXECUTE for PUBLIC, checksops and
// the owner on both; staging's pre-state lacked the checksops grant.
const PRODUCTION_PRE = '127bf5da500b4e5975686249b373ab0913f370ce5557292c5c49394e0ad775e8';
const STAGING_PRE = '8bd6b42d189ff05b77e19d178ddba0229a0d2b6bca0a2d1d98221774fa8fbc5f';
// The guarded staging apply (wave 27).
const STAGING_ACCEPTANCE_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/41045591568';
const OWNER_WORDS = '"SQL 128 from the production state"';
// SQL 128's production apply of 2026-10-30 (main b7a4b3409), recorded in applied; the owner's words were
// passed to the run verbatim.
const SQL128_APPLIED = Object.freeze({ ssm: 'e9e25699-8a3f-4349-b5d5-cc8d5964d41e', run: '309640f4-ba8c-4e7e-aed1-a7b75ec63916', one_use_id: 'sql128-prod-39880651-2b89-4961-9c90-0d45497e461e', commit: 'b7a4b34091e2bc56d7de8435a87fd9c2480e0259', workstream: 'prod-sql128-contractor-verification-from-compliance-20261030', approval: 'apply SQL 128 in production' });
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const keyPaths = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? keyPaths(v, `${p}${k}.`) : [`${p}${k}`]));
const neverConnect = async () => { throw new Error('should-not-connect'); };
const consumedPath = () => path.join(os.tmpdir(), `sql128-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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
    build_timestamp: '2026-10-30T00:00:00.000Z',
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

test('pin: the release pin shape, applied and retired (owner approved 2026-10-30, on the staging apply), in step with the staging pin, the one-shot, the inventory and the test lists', () => {
  const pin = COMMITTED;
  const staging = STAGING[KEY];
  const shape = new Set(keyPaths(SQL96_PIN).filter((k) => !/^(applied|production_evidence)(\.|$)/.test(k)));
  assert.deepEqual([...shape].filter((k) => !keyPaths(pin).includes(k)), [], 'lacks the engine pin shape');
  // The record-and-retire change adds applied and production_evidence on top of the engine pin shape.
  assert.deepEqual(keyPaths(pin).filter((k) => !shape.has(k) && !/^(applied|production_evidence)(\.|$)/.test(k)), []);
  assert.equal(pin.id, RELEASE_SQL_SPECS[KEY].production_pin_rel.split('/').pop().replace(/\.json$/, ''));
  assert.equal(pin.migration, KEY);
  // Applied 2026-10-30 and retired. The pin change (#1437) recorded the read-only production inspect (SSM
  // 54ccb458, main c19b0444a) as the pre-state and the staging apply (run 41045591568) as the acceptance.
  assert.equal(pin.execute, false);
  assert.match(pin.authorization, /^Applied to production on 2026-10-30; execute is false again/);
  assert.doesNotMatch(pin.authorization, /^Owner approved/);
  assert.ok(pin.authorization.includes(OWNER_WORDS));
  assert.ok(pin.authorization.includes('"Start SQL 128 production"'));
  assert.ok(pin.authorization.includes('#1437'));
  assert.ok(pin.authorization.includes(SQL128_APPLIED.workstream));
  assert.ok(pin.authorization.includes(`"${SQL128_APPLIED.approval}"`));
  assert.equal(pin.expected_live_definition_sha256, PRODUCTION_PRE);
  assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
  assert.equal(pin.applied.date, '2026-10-30');
  assert.equal(pin.applied.result, 'applied');
  assert.equal(pin.applied.apply_ssm_command_id, SQL128_APPLIED.ssm);
  assert.equal(pin.applied.one_shot_run_id, SQL128_APPLIED.run);
  assert.equal(pin.applied.one_use_id, SQL128_APPLIED.one_use_id);
  assert.equal(pin.applied.one_use_id_consumed, true);
  assert.equal(pin.applied.workstream_id, SQL128_APPLIED.workstream);
  assert.equal(pin.applied.source_commit, SQL128_APPLIED.commit);
  assert.equal(pin.applied.source_tarball.sha256, '8cbf52bd777fd7375d2c16af23e13c4f93b646f03631fd383d84eafda1fa8190');
  assert.equal(pin.applied.migration_source_sha256, pin.source_sha256);
  assert.equal(pin.applied.owner_approval, SQL128_APPLIED.approval);
  assert.deepEqual(pin.applied.steps, ['pin', 'source', 'inspect', 'contracts', 'manifest', 'source-recheck-before-preflight', 'preflight', 'evaluate', 'source-recheck-before-apply', 'apply', 'post-apply-inspect']);
  assert.match(pin.applied.one_shot_note, /ba8d180e-5d0e-490a-b078-1991dd30216f/);
  assert.match(pin.applied.one_shot_note, /1dd5b8e0-7cd6-4a88-bc84-f19f01db6312/);
  assert.equal(pin.applied.manifest_sha256, '26e6f8317ae75705c3a1f48975b3ef3e2ee3871bde81a4a8435a6df803b2a736');
  assert.deepEqual(Object.values(pin.applied.contract_results).map((c) => c.evidence.split(' ')[0]), ['4/4', '6/6', '43/43']);
  assert.equal(pin.applied.pre_apply_inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.deepEqual(pin.applied.pre_apply_inspect.precondition_failures, []);
  assert.deepEqual(pin.applied.pre_apply_inspect.release_sql_inspect.functions.map((f) => f.state), ['different', 'present']);
  assert.deepEqual(pin.applied.pre_apply_inspect.release_sql_inspect.function_acl.map((f) => f.acl), [['PUBLIC EXECUTE', 'checksops EXECUTE', 'owner EXECUTE']]);
  assert.equal(pin.applied.receipt.before_hash, PRODUCTION_PRE);
  assert.equal(pin.applied.receipt.after_hash, pin.intended_replacement_sha256);
  assert.equal(pin.applied.receipt.workstream, SQL128_APPLIED.workstream);
  assert.equal(pin.applied.receipt.staging_acceptance, pin.staging_acceptance.reference);
  assert.equal(pin.applied.receipt.unrelated_catalog_sha256, '561693f18c034f56f6ddc27fd4cf52cf35aeca9595651be32abbcc1143cef69a');
  assert.equal(pin.applied.receipt.unrelated_catalog_counts.triggers, 184);
  assert.equal(pin.applied.receipt.result, 'applied');
  assert.equal(pin.applied.post_apply_inspect.already_applied, true);
  assert.equal(pin.applied.post_apply_inspect.live_definition_sha256, pin.intended_replacement_sha256);
  assert.deepEqual(pin.applied.post_apply_inspect.precondition_failures, []);
  assert.deepEqual(pin.applied.post_apply_inspect.release_sql_inspect.functions.map((f) => f.state), ['intended', 'intended']);
  assert.deepEqual(pin.applied.post_apply_inspect.release_sql_inspect.triggers, []);
  assert.deepEqual(pin.applied.post_apply_inspect.release_sql_inspect.function_acl.map((f) => f.acl), [['checksops EXECUTE', 'owner EXECUTE']]);
  assert.equal(pin.applied.post_apply_inspect.release_sql_inspect.dropped_function_dependents, 0);
  assert.ok(pin.production_evidence['2026-10-30 apply'].includes(SQL128_APPLIED.ssm));
  assert.equal(pin.production_inspect.status, 'recorded');
  assert.equal(pin.production_inspect.date, '2026-10-30');
  assert.equal(pin.production_inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.production_inspect.ssm_command_id, '54ccb458-4942-4bb9-9bdc-c3e06a6aad0a');
  assert.equal(pin.production_inspect.source_commit, 'c19b0444a9fb42323fd683e2e4e5ff3191be3f79');
  assert.equal(pin.production_inspect.read_only, true);
  assert.equal(pin.production_inspect.connected_as, 'checksops_admin');
  assert.equal(pin.production_inspect.apply_preconditions_met, false);
  assert.deepEqual(pin.production_inspect.precondition_failures, []);
  assert.ok(pin.production_inspect.note.includes('72f7c3a6f25d64eb0a699182557a8aec2119e01b6205fb0eeeda2c9c262aeacf'));
  assert.ok(pin.production_inspect.note.includes(`migration source sha256 on the runner ${pin.source_sha256} == source_sha256`));
  assert.match(pin.production_inspect.note, /function_acl PUBLIC EXECUTE, checksops EXECUTE and owner EXECUTE; _trg_recompute_contractor_tier_from_docs\(\) present/);
  assert.match(pin.production_inspect.note, /dropped_function_dependents 0, dropped_function_callers \[\]/);
  assert.ok(pin.production_inspect.note.includes(' Earlier: Pending: '));
  assert.match(pin.production_inspect.note, /If already_applied is true, or precondition_failures is not \[\], stop/);
  assert.deepEqual([pin.staging_acceptance.ok, pin.staging_acceptance.reference], [true, STAGING_ACCEPTANCE_REF]);
  assert.match(pin.staging_acceptance.basis, /^Guarded staging SQL executor apply of sql128-contractor-verification-from-compliance, run 41045591568/);
  assert.match(pin.staging_acceptance.basis, /deploy run 41045243433/);
  assert.match(pin.staging_acceptance.basis, /Read-live run 41046074638 then reported already_applied true/);
  assert.ok(pin.staging_acceptance.basis.includes(`receipt before ${STAGING_PRE}, after ${pin.intended_replacement_sha256} == intended`));
  assert.deepEqual(Object.keys(pin.staging_acceptance).sort(), ['basis', 'ok', 'reference']);
  // The staging pin recorded staging's pre-state (wave 27); production's differs by the checksops grant.
  assert.equal(staging.expected_live_definition_sha256, STAGING_PRE);
  assert.notEqual(pin.expected_live_definition_sha256, staging.expected_live_definition_sha256);
  assert.equal(pin.filename, SQL128_FILE);
  assert.equal(pin.source_sha256, staging.source_sha256);
  assert.equal(pin.staging_pin_commit, staging.commit);
  assert.equal(pin.intended_replacement_sha256, staging.intended_replacement_sha256);
  assert.equal(pin.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(pin.intended_replacement_sha256, releaseIntendedHash(KEY, fs.readFileSync(path.join(ROOT, SQL128_FILE), 'utf8')));
  assert.deepEqual(pin.function_identities, RELEASE_SQL_SPECS[KEY].functions.map((fn) => fn.identity));
  assert.deepEqual(pin.function_identities, SQL128_IDENTITIES);
  assert.deepEqual(pin.function_identities, [...staging.function_identities]);
  assert.deepEqual(pin.predecessors, []);
  assert.deepEqual(pin.predecessors, RELEASE_SQL_SPECS[KEY].predecessors);
  assert.equal(pin.authorization_phrase, 'APPLY_CONTRACTOR_VERIFICATION_FROM_COMPLIANCE');
  for (const k of ['admin_login', 'rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(pin[k], SQL96_PIN[k], k);
  assert.equal(pin.tooling.status, 'built');
  assert.equal(pin.tooling.production_tool, RELEASE_PRODUCTION[KEY].cli);
  assert.equal(pin.tooling.production_tool, 'scripts/deployment-guard/sql128-contractor-verification-from-compliance-production-apply.mjs');
  assert.equal(pin.tooling.staging_workflow_choice, RELEASE_SQL_SPECS[KEY].choice);
  assert.equal(pin.tooling.one_shot_migration, KEY);
  assert.equal(pin.tooling.runbook, 'ops/production-sql-128-apply.md');
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
  assert.equal(tool.allowed_key, 'sql128_production_apply_allowed');
  assert.equal(tool.runs_before, undefined);
  assert.equal(RELEASE_SQL_SPECS[KEY].runs_before, undefined);
  assert.equal(tool.inspect_requires, undefined);
  assert.doesNotMatch(JSON.stringify(tool), /[0-9a-f]{64}/);
  const rows = JSON.stringify(readJson('ops/deployment-guard/bypass-inventory.json'));
  assert.match(rows, /"path":"scripts\/deployment-guard\/sql128-contractor-verification-from-compliance-production-apply\.mjs","classification":"GUARDED","capabilities":\["sql128-production-apply"\]/);
  assert.match(rows, /sql122, sql123, sql124, sql125, sql126, sql127, sql128, sql129, sql130, sql131, sql132, sql133\)/);
  const scripts = readJson('package.json').scripts;
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/deployment-guard.yml'), 'utf8');
  for (const name of ['aws/tests/release-sql128-executor.test.mjs', 'aws/tests/release-sql128-production-apply.test.mjs', 'aws/tests/sql128-contractor-verification-pg.test.mjs']) {
    assert.ok(scripts['test:deployment-guard'].includes(name), name);
    assert.ok(workflow.includes(name), name);
  }
});

test('order: no predecessor and no order; the function, its prerequisites and the dropped orphan trigger function; no table, view, policy, trigger or plan entry; the API keeps its calls; the runbook, one-shot doc and README name it', () => {
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.predecessors, []);
  assert.deepEqual(spec.functions.map((fn) => fn.identity), SQL128_IDENTITIES);
  for (const fn of spec.functions) {
    assert.deepEqual(fn.acl, ['checksops EXECUTE', 'owner EXECUTE'], fn.identity);
    assert.deepEqual(fn.revokes, ['PUBLIC EXECUTE', 'anon EXECUTE', 'authenticated EXECUTE', 'service_role EXECUTE'], fn.identity);
  }
  assert.deepEqual(spec.dropped_functions, ['public._trg_recompute_contractor_tier_from_docs()']);
  // The function first, then the tables it reads, then role checksops and the columns.
  assert.deepEqual(spec.prerequisites.slice(0, 7), [
    'public.contractor_verification_status(uuid)',
    'public.contractor_profiles',
    'public.contractor_reviews',
    'public.tenant_users',
    'public.moov_compliance_documents',
    'public.tenant_documents',
    'role checksops',
  ]);
  for (const column of ['contractor_profiles.user_id', 'moov_compliance_documents.purpose', 'moov_compliance_documents.status', 'tenant_documents.doc_type', 'tenant_documents.expires_at']) {
    assert.ok(spec.prerequisites.includes(`column public.${column}`), column);
  }
  for (const absent of ['tables', 'views', 'policies', 'triggers', 'altered_relations', 'definer_writes']) assert.equal(spec[absent], undefined, absent);
  assert.match(COMMITTED.order_note, /^No release-engine predecessor and no ordering constraint\./);
  assert.match(COMMITTED.order_note, /No API, Lambda or SPA change is part of this pin\./);
  const plan = readJson('ops/deployment-guard/production-api-overlay-plan.json');
  assert.equal((plan.sql_prerequisites || {})[SQL128_FILE], undefined);
  assert.ok(!JSON.stringify(plan.members).includes(SQL128_FILE));
  // The API's existing calls of the replaced function keep its signature.
  assert.match(fs.readFileSync(path.join(ROOT, 'aws/functions/api/workflow-rpc.mjs'), 'utf8'),
    /'SELECT \* FROM public\.contractor_verification_status\(\$1::uuid\)'/);
  assert.match(fs.readFileSync(path.join(ROOT, 'aws/functions/api/data.mjs'), 'utf8'), /contractor_verification_status: \{ contractor: 'p_contractor_id' \}/);
  // No trigger, table, view or policy: the DB validator's public trigger count is not concerned.
  const text = fs.readFileSync(path.join(ROOT, SQL128_FILE), 'utf8').replace(/--[^\n]*/g, '');
  assert.doesNotMatch(text, /\bCREATE\s+(OR\s+REPLACE\s+)?(TRIGGER|VIEW|TABLE|POLICY)\b/i);
  assert.deepEqual([...text.matchAll(/\bDROP\b[^;]*;/gi)].map((m) => m[0]), ['DROP FUNCTION IF EXISTS public._trg_recompute_contractor_tier_from_docs();']);
  const runbook = fs.readFileSync(path.join(ROOT, COMMITTED.tooling.runbook), 'utf8');
  assert.ok(runbook.includes(COMMITTED.intended_replacement_sha256));
  assert.ok(runbook.includes(COMMITTED.source_sha256));
  assert.match(runbook, /\*\*Status:\*\* applied to staging \(wave 27\) and to production \(2026-10-30\); the production pin is retired/);
  assert.match(runbook, /\*\*Production apply \(2026-10-30\)\.\*\*/);
  assert.match(runbook, /SSM\s+`54ccb458-4942-4bb9-9bdc-c3e06a6aad0a`/);
  assert.match(runbook, /Staging apply \(2026-10-30\)\.\*\* Run 41045591568/);
  assert.match(runbook, /read-live \(2026-10-30\)\.\*\* Run 41042517205/);
  const oneShot = fs.readFileSync(path.join(ROOT, 'ops/production-sql-one-shot.md'), 'utf8');
  assert.match(oneShot, /\| `sql128` \|/);
  assert.match(oneShot, /`sql126`, `sql127`, `sql128`, `sql129`, `sql130`, `sql131`, `sql132`, `sql133`\) \|/);
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/README.md'), 'utf8'), /sql128-contractor-verification-from-compliance-production-apply\.mjs --inspect/);
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
  // record-and-retire change, allows only the manifest bound to its recorded pre-state: not
  // staging's pre-state, not another hash, not the intended state.
  const AUTHORIZED = Object.freeze({ ...COMMITTED, execute: true, authorization: 'Owner approved 2026-10-30 (test copy of the execute-authorized pin before its record-and-retire change)' });
  const committedOk = await evaluateReleaseProductionApply(KEY, manifest(AUTHORIZED), { root: ROOT, pin: AUTHORIZED });
  assert.equal(committedOk.ok, true, JSON.stringify(committedOk));
  assert.equal(committedOk.details.sql128_production_apply_allowed, true);
  assert.equal(committedOk.details.staging_acceptance, STAGING_ACCEPTANCE_REF);
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(AUTHORIZED), live_definition_sha256: STAGING_PRE, expected_live_definition_sha256: STAGING_PRE }, { root: ROOT, pin: AUTHORIZED })).code, CODES.SQL_COLLISION);
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(AUTHORIZED), live_definition_sha256: PRE, expected_live_definition_sha256: PRE }, { root: ROOT, pin: AUTHORIZED })).code, CODES.SQL_COLLISION);
  const onIntended = COMMITTED.intended_replacement_sha256;
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(AUTHORIZED), live_definition_sha256: onIntended, expected_live_definition_sha256: onIntended }, { root: ROOT, pin: AUTHORIZED })).ok, false);
  // The retired committed pin refuses before connecting.
  assert.equal((await executeReleaseProductionApply(KEY, manifest(COMMITTED), { root: ROOT, connect: neverConnect, consumedPath: consumedPath() })).ok, false);

  const pin = approved();
  const allowed = await evaluateReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(allowed.details.sql128_production_apply_allowed, true);
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
  const file = path.join(os.tmpdir(), `sql128-cli-${process.pid}.json`);
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