/**
 * Production tool for SQL 147 (scripts/deployment-guard/sql147-external-disbursement-record-production-apply.mjs on
 * lib/release-sql-production-apply.mjs and lib/release-sql-production-cli.mjs).
 * release-sql90-97-production-apply.test.mjs runs every release key (SQL 147 included) through the
 * shared refusals; this file covers SQL 147's own:
 *
 *   - the pin has the release pin shape plus the applied record; it was execute-authorized (owner-approved pin
 *     change of 2026-11-10, #1736) with the recorded production pre-state (read-only inspect; the derived one, the
 *     same one staging had) and the staging apply as its acceptance, then applied on 2026-11-10 and retired
 *     (execute false); it is in step with the staging pin, the one-shot, the bypass inventory and the test lists;
 *   - no predecessor; the one new DEFINER function (EXECUTE for checksops and the owner; PUBLIC, anon,
 *     authenticated and service_role revoked, RETURNS jsonb), the prerequisites (the disbursement, check, transfer
 *     and stakeholder columns, SQL 90's aws_can_write_tenant(uuid), auth.uid(), role checksops), the six definer
 *     relations; no table, view, policy, trigger or drop, and no grant but the REVOKEs and the GRANT to checksops on
 *     this function; the runbook, one-shot doc and README name it;
 *   - the pending (pre-authorization) pin refuses before connecting; an execute-authorized copy of the committed
 *     (retired) pin allows only the manifest bound to its recorded pre-state, and the retired pin itself refuses
 *     before connecting; an approved, accepted copy evaluates for the manifest built from it, and refuses with
 *     execute false, another live hash, another staging reference or a wrong phrase; the CLI spends no receipt.
 * The behavior on PostgreSQL 16 is aws/tests/sql147-external-disbursement-pg.test.mjs; the executor path is
 * aws/tests/release-sql147-executor.test.mjs.
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
import { main } from '../../scripts/deployment-guard/sql147-external-disbursement-record-production-apply.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql147';
const SQL147_FILE = 'aws/workflows/sql/147_external_disbursement_record.sql';
const IDENTITY = 'public.aws_record_external_disbursement(uuid, uuid, jsonb, text)';
const IDENTITIES = Object.freeze([IDENTITY]);
const RELATIONS = Object.freeze(['public.disbursement_batches', 'public.disbursement_splits', 'public.check_intake_items',
  'public.payment_transfers', 'public.stakeholder_accounts', 'public.check_stakeholders']);
const COMMITTED = loadReleaseProductionPin(KEY, ROOT);
// The derived pre-state (the function absent; derived by release-sql147-executor.test.mjs).
const ABSENT_PRE = 'a60b06089007f083007ac7b24ae41cdd1cd33b0cbd04c63985c09faa9b666286';
// SQL 147's recorded production pre-state (read-only inspect of 2026-11-10, SSM ea4ffd03, main 3fe023b75): the
// function absent, the derived pre-state; staging recorded the same (read-live runs 42833250784, 42838391624).
const PRODUCTION_PRE = ABSENT_PRE;
// The guarded staging apply (wave 42).
const STAGING_ACCEPTANCE_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/42838778413';
const OWNER_WORDS = Object.freeze(['"apply SQL 147 in staging"', '"record the SQL 147 staging pin"', '"SQL 147 accepted in staging"', '"run the read-only SQL 147 production inspect"', '"record the SQL 147 production pin"']);
// SQL 147's production apply of 2026-11-10 (main c80bfff4b), recorded in applied, on the owner's "apply SQL 147 in production".
const SQL147_APPLIED = Object.freeze({ ssm: '746d8c0b-fa12-484a-bcc5-fc00260d55d1', run: '0ca1d312-a5a4-4671-a1fa-cda94a5f8c53', one_use_id: 'sql147-prod-f6fa5c00-7940-4534-8cc4-00b942e6841a', commit: 'c80bfff4bfdbb4b456590ec517872a70fa5a66e9', workstream: 'prod-sql147-external-disbursement-record-20261110', approval: 'apply SQL 147 in production' });
// The separate one-shot --phase inspect before the apply.
const PRE_INSPECT_SSM = 'd9e9595d-13df-4d7c-be50-00f16d2f1a99';
const PRE_INSPECT_RUN = '1504752a-f2e8-4dec-9576-e13ff77127b0';
const DEFINER_RELATIONS = Object.freeze(RELATIONS.map((relation) => relation.replace(/^public\./, '')));
const FUNCTION_NAMES = Object.freeze(IDENTITIES.map((identity) => identity.replace(/^public\./, '')));
const SQL96_PIN = loadReleaseProductionPin('sql96', ROOT);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PRE = 'e'.repeat(64);
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const keyPaths = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? keyPaths(v, `${p}${k}.`) : [`${p}${k}`]));
const neverConnect = async () => { throw new Error('should-not-connect'); };
const consumedPath = () => path.join(os.tmpdir(), `sql147-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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
    build_timestamp: '2026-11-10T00:00:00.000Z',
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

test('pin: the release pin shape, applied and retired (owner approved 2026-11-10, on the staging apply; applied 2026-11-10), in step with the staging pin, the one-shot, the inventory and the test lists', () => {
  const pin = COMMITTED;
  const staging = STAGING[KEY];
  const shape = new Set(keyPaths(SQL96_PIN).filter((k) => !/^(applied|production_evidence)(\.|$)/.test(k)));
  assert.deepEqual([...shape].filter((k) => !keyPaths(pin).includes(k)), [], 'lacks the engine pin shape');
  // The record-and-retire change adds applied and production_evidence on top of the engine pin shape.
  assert.deepEqual(keyPaths(pin).filter((k) => !shape.has(k) && !/^(applied|production_evidence)(\.|$)/.test(k)), []);
  assert.equal(pin.id, RELEASE_SQL_SPECS[KEY].production_pin_rel.split('/').pop().replace(/\.json$/, ''));
  assert.equal(pin.migration, KEY);
  // Applied 2026-11-10 and retired. The pin change (#1736) recorded the read-only production inspect (SSM ea4ffd03,
  // main 3fe023b75) as the pre-state and the staging apply (run 42838778413) as the acceptance; its words named the
  // staging steps, the inspect and the pin change, and the apply run had the owner's own words for it.
  assert.equal(pin.execute, false);
  assert.match(pin.authorization, /^Applied to production on 2026-11-10; execute is false again/);
  assert.doesNotMatch(pin.authorization, /^Owner approved/);
  for (const words of OWNER_WORDS) assert.ok(pin.authorization.includes(words), words);
  assert.match(pin.authorization, /none of them words for the production apply/);
  assert.ok(pin.authorization.includes('#1736'));
  assert.ok(pin.authorization.includes(`${PRODUCTION_PRE.slice(0, 8)} -> ${pin.intended_replacement_sha256.slice(0, 8)}`));
  assert.ok(pin.authorization.includes(SQL147_APPLIED.workstream));
  assert.ok(pin.authorization.includes(`"${SQL147_APPLIED.approval}"`));
  assert.equal(pin.expected_live_definition_sha256, PRODUCTION_PRE);
  assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
  assert.equal(pin.applied.date, '2026-11-10');
  assert.equal(pin.applied.result, 'applied');
  assert.equal(pin.applied.apply_ssm_command_id, SQL147_APPLIED.ssm);
  assert.equal(pin.applied.one_shot_run_id, SQL147_APPLIED.run);
  assert.equal(pin.applied.one_use_id, SQL147_APPLIED.one_use_id);
  assert.equal(pin.applied.one_use_id_consumed, true);
  assert.equal(pin.applied.workstream_id, SQL147_APPLIED.workstream);
  assert.equal(pin.applied.source_commit, SQL147_APPLIED.commit);
  assert.equal(pin.applied.source_tarball.sha256, '205c6e9d19155f7344daef9ddd65743a1eeb2a5e64ae89ede3b6f831ca540d27');
  assert.equal(pin.applied.migration_source_sha256, pin.source_sha256);
  assert.equal(pin.applied.owner_approval, SQL147_APPLIED.approval);
  assert.ok(pin.applied.owner_approval_basis.includes('#1736'));
  assert.equal(pin.applied.operator, 'michaelcarletta-cmd');
  assert.equal(pin.applied.runner, 'i-0c35557c4e5385406');
  assert.deepEqual(pin.applied.steps, ['pin', 'source', 'inspect', 'contracts', 'manifest', 'source-recheck-before-preflight', 'preflight', 'evaluate', 'source-recheck-before-apply', 'apply', 'post-apply-inspect']);
  // The transfer run, the separate --phase inspect before the apply, and that the run's JSON arrived whole.
  // Production acceptance was not yet reported when this was recorded, and the record says so.
  assert.match(pin.applied.one_shot_note, /transfer run 42851941315/);
  assert.ok(pin.applied.one_shot_note.includes(PRE_INSPECT_SSM));
  assert.ok(pin.applied.one_shot_note.includes(PRE_INSPECT_RUN));
  assert.match(pin.applied.one_shot_note, /The run's JSON arrived whole/);
  assert.match(pin.applied.one_shot_note, /Production acceptance: not yet reported by the owner/);
  assert.equal(pin.applied.manifest_sha256, '9020b9b4067522c7f98b6b9cce0bd4ced543622750eefb2a5f7ea64829f8f72b');
  assert.deepEqual(Object.values(pin.applied.contract_results).map((c) => c.evidence.split(' ')[0]), ['4/4', '6/6', '43/43']);
  for (const c of Object.values(pin.applied.contract_results)) assert.ok(c.evidence.includes(SQL147_APPLIED.run), c.test);
  assert.equal(pin.applied.pre_apply_inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.applied.pre_apply_inspect.live_matches_expected, true);
  assert.equal(pin.applied.pre_apply_inspect.already_applied, false);
  assert.deepEqual(pin.applied.pre_apply_inspect.precondition_failures, []);
  assert.deepEqual(pin.applied.pre_apply_inspect.predecessors, {});
  assert.equal(pin.applied.pre_apply_inspect.counts, null);
  assert.deepEqual(pin.applied.pre_apply_inspect.release_sql_inspect.functions.map((f) => [f.name, f.state]), FUNCTION_NAMES.map((name) => [name, 'absent']));
  assert.deepEqual(pin.applied.pre_apply_inspect.release_sql_inspect.definer_writes, DEFINER_RELATIONS.map((name) => ({ name, ok: true })));
  assert.equal(pin.applied.receipt.before_hash, PRODUCTION_PRE);
  assert.equal(pin.applied.receipt.after_hash, pin.intended_replacement_sha256);
  assert.equal(pin.applied.receipt.workstream, SQL147_APPLIED.workstream);
  assert.equal(pin.applied.receipt.commit, SQL147_APPLIED.commit);
  assert.equal(pin.applied.receipt.sql_file, SQL147_FILE);
  assert.equal(pin.applied.receipt.staging_acceptance, pin.staging_acceptance.reference);
  assert.equal(pin.applied.receipt.unrelated_catalog_sha256, 'c46081943487945643c4480d4d8f47ed7f3e0dbf8eaf5c6a3d99593f959381a5');
  assert.equal(pin.applied.receipt.unrelated_catalog_counts.policies, 479);
  assert.equal(pin.applied.receipt.unrelated_catalog_counts.functions, 1363);
  assert.equal(pin.applied.receipt.result, 'applied');
  assert.equal(pin.applied.post_apply_inspect.already_applied, true);
  assert.equal(pin.applied.post_apply_inspect.live_definition_sha256, pin.intended_replacement_sha256);
  assert.deepEqual(pin.applied.post_apply_inspect.precondition_failures, []);
  assert.deepEqual(pin.applied.post_apply_inspect.predecessors, {});
  assert.equal(pin.applied.post_apply_inspect.counts, null);
  // The function intended with EXECUTE for checksops and the owner; all six definer relations ok; no prerequisite missing.
  const post = pin.applied.post_apply_inspect.release_sql_inspect;
  assert.deepEqual(post.functions.map((f) => [f.name, f.state]), FUNCTION_NAMES.map((name) => [name, 'intended']));
  assert.deepEqual(post.function_acl, FUNCTION_NAMES.map((name) => ({ name, acl: ['checksops EXECUTE', 'owner EXECUTE'] })));
  assert.deepEqual(post.definer_writes, DEFINER_RELATIONS.map((name) => ({ name, ok: true })));
  for (const absent of ['policies', 'views', 'tables', 'columns', 'constraints', 'triggers', 'table_privileges']) assert.deepEqual(post[absent], [], absent);
  assert.deepEqual(post.prerequisites_missing, []);
  assert.deepEqual(pin.applied.receipt.release_sql_inspect, post);
  for (const evidence of [SQL147_APPLIED.ssm, SQL147_APPLIED.run, SQL147_APPLIED.one_use_id, PRE_INSPECT_SSM, `"${SQL147_APPLIED.approval}"`, '"DEPLOY external-disbursement.mjs TO PRODUCTION"']) {
    assert.ok(pin.production_evidence['2026-11-10 apply'].includes(evidence), evidence);
  }
  assert.equal(pin.production_inspect.status, 'recorded');
  assert.equal(pin.production_inspect.date, '2026-11-10');
  assert.equal(pin.production_inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.production_inspect.ssm_command_id, 'ea4ffd03-2f1d-4e05-9439-793653e554b1');
  assert.equal(pin.production_inspect.source_commit, '3fe023b75616afc4e20af25141625af11a02e773');
  assert.equal(pin.production_inspect.read_only, true);
  assert.equal(pin.production_inspect.connected_as, 'checksops_admin');
  assert.equal(pin.production_inspect.apply_preconditions_met, false);
  assert.deepEqual(pin.production_inspect.precondition_failures, []);
  assert.ok(pin.production_inspect.note.includes('a82f5980c33dad76b413b3365b8914da4ae81178fa587c26daf0e3bf81e3ddf3'));
  assert.ok(pin.production_inspect.note.includes(`migration source sha256 on the runner ${pin.source_sha256} == source_sha256`));
  assert.match(pin.production_inspect.note, /with the function absent/);
  assert.match(pin.production_inspect.note, /already_applied false\), live_matches_expected false, precondition_failures \[\], apply_preconditions_met false, errors \[\]/);
  assert.match(pin.production_inspect.note, /definer_can_write_relations \(the applying login reaches all six relations/);
  assert.match(pin.production_inspect.note, /prerequisites_present \(prerequisites_missing \[\]\)/);
  assert.match(pin.production_inspect.note, /If already_applied is true, or precondition_failures is not \[\], stop/);
  assert.ok(pin.production_inspect.note.includes(' Earlier: Pending: no release-engine production inspect has been run for SQL 147 yet.'));
  assert.match(pin.production_inspect.note, /prerequisites_missing/);
  assert.match(pin.production_inspect.note, /definer_can_write_relations/);
  assert.match(pin.production_inspect.note, /functions_owned_by_login/);
  assert.match(pin.production_inspect.note, /function_results_match/);
  assert.match(pin.production_inspect.note, /function_acl_replaceable/);
  assert.deepEqual([pin.staging_acceptance.ok, pin.staging_acceptance.reference], [true, STAGING_ACCEPTANCE_REF]);
  assert.match(pin.staging_acceptance.basis, /^Guarded staging SQL executor apply of sql147-external-disbursement-record, run 42838778413/);
  assert.match(pin.staging_acceptance.basis, /deploy run 42837424211/);
  assert.match(pin.staging_acceptance.basis, /Read-live run 42839223253 then reported already_applied true/);
  assert.match(pin.staging_acceptance.basis, /under the owner's words "apply SQL 147 in staging"/);
  assert.match(pin.staging_acceptance.basis, /"SQL 147 accepted in staging"/);
  assert.ok(pin.staging_acceptance.basis.includes(`before ${PRODUCTION_PRE}, after ${pin.intended_replacement_sha256} == intended`));
  assert.deepEqual(Object.keys(pin.staging_acceptance).sort(), ['basis', 'ok', 'reference']);
  // The staging pin recorded the same pre-state (wave 42).
  assert.equal(staging.expected_live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.expected_live_definition_sha256, staging.expected_live_definition_sha256);
  assert.equal(pin.filename, SQL147_FILE);
  assert.equal(pin.source_sha256, staging.source_sha256);
  assert.equal(pin.staging_pin_commit, staging.commit);
  assert.equal(pin.intended_replacement_sha256, staging.intended_replacement_sha256);
  assert.equal(pin.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(pin.intended_replacement_sha256, releaseIntendedHash(KEY, fs.readFileSync(path.join(ROOT, SQL147_FILE), 'utf8')));
  assert.deepEqual(pin.function_identities, RELEASE_SQL_SPECS[KEY].functions.map((fn) => fn.identity));
  assert.deepEqual(pin.function_identities, [...IDENTITIES]);
  assert.deepEqual(pin.function_identities, [...staging.function_identities]);
  assert.deepEqual(pin.predecessors, []);
  assert.deepEqual(pin.predecessors, RELEASE_SQL_SPECS[KEY].predecessors);
  assert.equal(pin.authorization_phrase, 'APPLY_EXTERNAL_DISBURSEMENT_RECORD');
  for (const k of ['admin_login', 'rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(pin[k], SQL96_PIN[k], k);
  assert.equal(pin.tooling.status, 'built');
  assert.equal(pin.tooling.production_tool, RELEASE_PRODUCTION[KEY].cli);
  assert.equal(pin.tooling.production_tool, 'scripts/deployment-guard/sql147-external-disbursement-record-production-apply.mjs');
  assert.equal(pin.tooling.staging_workflow_choice, RELEASE_SQL_SPECS[KEY].choice);
  assert.equal(pin.tooling.one_shot_migration, KEY);
  assert.equal(pin.tooling.runbook, 'ops/production-sql-147-apply.md');
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
  assert.equal(tool.allowed_key, 'sql147_production_apply_allowed');
  assert.equal(tool.runs_before, undefined);
  assert.equal(RELEASE_SQL_SPECS[KEY].runs_before, undefined);
  assert.equal(tool.inspect_requires, undefined);
  assert.doesNotMatch(JSON.stringify(tool), /[0-9a-f]{64}/);
  const rows = JSON.stringify(readJson('ops/deployment-guard/bypass-inventory.json'));
  assert.match(rows, /"path":"scripts\/deployment-guard\/sql147-external-disbursement-record-production-apply\.mjs","classification":"GUARDED","capabilities":\["sql147-production-apply"\]/);
  assert.match(rows, /sql145, sql146, sql147, sql148, sql150, sql152, sql154\)/);
  const scripts = readJson('package.json').scripts;
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/deployment-guard.yml'), 'utf8');
  for (const name of ['aws/tests/release-sql147-executor.test.mjs', 'aws/tests/release-sql147-production-apply.test.mjs', 'aws/tests/sql147-external-disbursement-pg.test.mjs']) {
    assert.ok(scripts['test:deployment-guard'].includes(name), name);
    assert.ok(workflow.includes(name), name);
  }
});

test('order: no predecessor; the one new DEFINER function, its prerequisites and the six definer relations; the REVOKEs and the GRANT to checksops, nothing else; the runbook, one-shot doc and README name it', () => {
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.predecessors, []);
  assert.equal(spec.supersedes, undefined);
  assert.deepEqual(spec.functions.map((fn) => fn.identity), [...IDENTITIES]);
  for (const fn of spec.functions) {
    assert.deepEqual(fn.acl, ['checksops EXECUTE', 'owner EXECUTE'], fn.identity);
    assert.deepEqual(fn.revokes, ['PUBLIC EXECUTE', 'anon EXECUTE', 'authenticated EXECUTE', 'service_role EXECUTE'], fn.identity);
    assert.equal(fn.result, undefined, fn.identity);
  }
  assert.equal(spec.dropped_functions, undefined);
  assert.equal(spec.acl_functions, undefined);
  assert.deepEqual(spec.prerequisites.slice(0, 9), [...RELATIONS, 'public.aws_can_write_tenant(uuid)', 'auth.uid()', 'role checksops']);
  for (const column of ['disbursement_batches.approved_amount_cents', 'disbursement_splits.idempotence_key', 'disbursement_splits.external_check_number',
    'check_intake_items.pa_fee_pct', 'payment_transfers.leg_role', 'stakeholder_accounts.nickname', 'check_stakeholders.stakeholder_account_id']) {
    assert.ok(spec.prerequisites.includes(`column public.${column}`), column);
  }
  assert.deepEqual(spec.definer_writes, [...RELATIONS]);
  for (const absent of ['tables', 'views', 'policies', 'triggers', 'altered_relations']) assert.equal(spec[absent], undefined, absent);
  assert.match(COMMITTED.order_note, /^No predecessor: SQL 147 creates one new SECURITY DEFINER function/);
  assert.match(COMMITTED.order_note, /definer_can_write_relations/);
  assert.match(COMMITTED.order_note, /SQL 90's aws_can_write_tenant\(uuid\)/);
  assert.match(COMMITTED.order_note, /No API, Lambda or SPA change is part of this pin\./);
  // One prerequisite DO block, one CREATE OR REPLACE FUNCTION, one REVOKE DO block; the REVOKE from PUBLIC and the
  // GRANT to checksops on it; nothing else. The only writes are the batch and split INSERTs; the check is locked once.
  const text = fs.readFileSync(path.join(ROOT, SQL147_FILE), 'utf8').replace(/--[^\n]*/g, '');
  assert.doesNotMatch(text, /\bCREATE\s+(OR\s+REPLACE\s+)?(TRIGGER|VIEW|TABLE|POLICY)\b/i);
  assert.doesNotMatch(text, /\b(DROP|ALTER)\b/);
  assert.deepEqual([...text.matchAll(/\b(INSERT\s+INTO\s+\S+|UPDATE\s+public\.\S+|DELETE|TRUNCATE)\b/g)].map((m) => m[0]),
    ['INSERT INTO public.disbursement_batches', 'INSERT INTO public.disbursement_splits']);
  assert.equal([...text.matchAll(/\bFOR UPDATE\b/g)].length, 1);
  assert.equal([...text.matchAll(/\bCREATE\s+OR\s+REPLACE\s+FUNCTION\b/gi)].length, 1);
  assert.equal([...text.matchAll(/\bDO\s+\$/g)].length, 2);
  assert.deepEqual([...text.matchAll(/^\s*(GRANT|REVOKE)\b.*$/gim)].map((m) => m[0].trim()), [
    `REVOKE ALL ON FUNCTION ${IDENTITY} FROM PUBLIC;`,
    `GRANT EXECUTE ON FUNCTION ${IDENTITY} TO checksops;`,
  ]);
  assert.ok(text.includes(`EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ${IDENTITY} FROM %I', v_role);`));
  assert.match(text, /FOREACH v_role IN ARRAY ARRAY\['anon', 'authenticated', 'service_role'\] LOOP/);
  assert.match(text, /RAISE EXCEPTION 'external_disbursement_forbidden'\s+USING ERRCODE = '42501'/);
  const runbook = fs.readFileSync(path.join(ROOT, COMMITTED.tooling.runbook), 'utf8');
  assert.ok(runbook.includes(COMMITTED.intended_replacement_sha256));
  assert.ok(runbook.includes(COMMITTED.source_sha256));
  assert.match(runbook, /\*\*Status:\*\* applied to staging \(wave 42\) and to production \(2026-11-10\); the production pin is retired/);
  assert.match(runbook, /\*\*Production apply \(2026-11-10\)\.\*\*/);
  for (const evidence of [SQL147_APPLIED.ssm, SQL147_APPLIED.run, SQL147_APPLIED.workstream, PRE_INSPECT_SSM, PRE_INSPECT_RUN, '42851941315', `"${SQL147_APPLIED.approval}"`]) {
    assert.ok(runbook.includes(evidence), evidence);
  }
  assert.match(runbook, /SSM\s+`ea4ffd03-2f1d-4e05-9439-793653e554b1`/);
  assert.match(runbook, /\*\*Staging apply \(2026-11-10\)\.\*\* Apply run 42838778413/);
  assert.match(runbook, /Read-live run 42839223253/);
  assert.match(runbook, /"SQL 147 accepted in staging"/);
  assert.match(runbook, /\*\*Predecessor\.\*\* None/);
  assert.match(runbook, /Owner\s+2026-11-09: "apply SQL 147 in\s+staging"/);
  for (const evidence of ['FINANCIAL_OR_PROVIDER_TABLES', 'table_not_allowlisted', 'external-disbursement.mjs', '#1729']) {
    assert.ok(runbook.includes(evidence), evidence);
  }
  assert.match(runbook, /APPLY_EXTERNAL_DISBURSEMENT_RECORD/);
  const oneShot = fs.readFileSync(path.join(ROOT, 'ops/production-sql-one-shot.md'), 'utf8');
  assert.match(oneShot, /\| `sql147` \|/);
  assert.match(oneShot, /`sql145`, `sql146`, `sql147`, `sql148`, `sql150`, `sql152`, `sql154`\) \|/);
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/README.md'), 'utf8'), /sql147-external-disbursement-record-production-apply\.mjs --inspect/);
});

test('the pending (pre-authorization) pin refuses before connecting; an execute-authorized copy of the retired pin allows only its own manifest; execute false, other hashes and phrases refuse', async () => {
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
  // record-and-retire change, allows only the manifest bound to its recorded pre-state: not another hash, not the
  // intended state.
  const AUTHORIZED = Object.freeze({ ...COMMITTED, execute: true, authorization: 'Owner approved 2026-11-10 (test copy of the execute-authorized pin before its record-and-retire change)' });
  const committedOk = await evaluateReleaseProductionApply(KEY, manifest(AUTHORIZED), { root: ROOT, pin: AUTHORIZED });
  assert.equal(committedOk.ok, true, JSON.stringify(committedOk));
  assert.equal(committedOk.details.sql147_production_apply_allowed, true);
  assert.equal(committedOk.details.staging_acceptance, STAGING_ACCEPTANCE_REF);
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(AUTHORIZED), live_definition_sha256: PRE, expected_live_definition_sha256: PRE }, { root: ROOT, pin: AUTHORIZED })).code, CODES.SQL_COLLISION);
  const onIntended = COMMITTED.intended_replacement_sha256;
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(AUTHORIZED), live_definition_sha256: onIntended, expected_live_definition_sha256: onIntended }, { root: ROOT, pin: AUTHORIZED })).ok, false);
  // The retired committed pin refuses before connecting.
  assert.equal((await executeReleaseProductionApply(KEY, manifest(COMMITTED), { root: ROOT, connect: neverConnect, consumedPath: consumedPath() })).ok, false);

  const pin = approved();
  const allowed = await evaluateReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(allowed.details.sql147_production_apply_allowed, true);
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect: neverConnect, consumedPath: consumedPath() })).ok, true);
  const otherLive = { ...manifest(pin), expected_live_definition_sha256: 'f'.repeat(64), live_definition_sha256: 'f'.repeat(64) };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherLive, { root: ROOT, pin })).code, CODES.SQL_COLLISION);
  const otherStaging = { ...manifest(pin), staging_acceptance: { ok: true, reference: 'https://example.invalid/x' } };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherStaging, { root: ROOT, pin })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await precheckReleaseProductionApply(KEY, { ...manifest(pin), authorization_phrase: 'APPLY_MOOV_STATUS_CATCH_UP_WRITES' }, { root: ROOT, pin, consumedPath: consumedPath() })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const off = approved({ execute: false });
  const ctx = { root: ROOT, pin: off, connect: neverConnect, consumedPath: consumedPath() };
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  assert.equal((await executeReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  // A tampered file hash is a reconciliation stop.
  assert.equal(readPinnedReleaseSql(KEY, ROOT, { ...COMMITTED, source_sha256: 'f'.repeat(64) }).code, CODES.SQL_COLLISION);

  // CLI: --apply with the committed pin, read from disk, and a manifest on another pre-state refuses without connecting
  // or spending a receipt; credential flags are refused.
  const file = path.join(os.tmpdir(), `sql147-cli-${process.pid}.json`);
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
