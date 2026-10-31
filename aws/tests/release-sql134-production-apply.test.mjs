/**
 * Production tool for SQL 134 (scripts/deployment-guard/sql134-loss-draft-escrow-write-grants-
 * production-apply.mjs on lib/release-sql-production-apply.mjs and lib/release-sql-production-cli.mjs).
 * release-sql90-97-production-apply.test.mjs runs every release key (SQL 134 included) through the
 * shared refusals; this file covers SQL 134's own:
 *
 *   - the pin has the release pin shape plus the applied record; it was execute-authorized (owner-
 *     approved pin change of 2026-10-31, #1473) with the recorded production pre-state (derived from
 *     the spec in release-sql134-executor.test.mjs; the same one staging had) and the staging apply as
 *     its acceptance, then applied on 2026-10-31 and retired (execute false); it is in step with the
 *     staging pin, the one-shot, the bypass inventory and the test lists;
 *   - no predecessor; no function; the fourteen column grants (UPDATE on five loss_draft_tracking
 *     columns, INSERT on nine loss_draft_releases columns, to checksops and authenticated) and
 *     nothing else; the columns are exactly the ones the Loss Draft escrow actions write; SQL 50
 *     and SQL 51 are not edited; the policies stay the boundary; the runbook, one-shot doc and
 *     README name it;
 *   - the pending (pre-authorization) pin refuses before connecting; an execute-authorized copy of the
 *     committed (retired) pin allows only the manifest bound to its recorded pre-state, and the retired
 *     pin itself refuses before connecting; an approved, accepted copy evaluates for the
 *     manifest built from it, and refuses with execute false, another live hash, another staging
 *     reference or a wrong phrase; the CLI spends no receipt.
 * The grants on PostgreSQL 16 are aws/tests/sql134-loss-draft-escrow-write-grants-pg.test.mjs; the
 * executor path is aws/tests/release-sql134-executor.test.mjs.
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
import { main } from '../../scripts/deployment-guard/sql134-loss-draft-escrow-write-grants-production-apply.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql134';
const SQL134_FILE = 'aws/workflows/sql/134_loss_draft_escrow_write_grants.sql';
const TRACKING = 'public.loss_draft_tracking';
const RELEASES = 'public.loss_draft_releases';
/** The columns SQL 134 grants, in file order. */
const UPDATE_COLUMNS = Object.freeze(['total_escrowed', 'draw_amount_requested', 'draw_stage', 'draw_amount_released', 'holdback_amount']);
const INSERT_COLUMNS = Object.freeze(['loss_draft_id', 'draw_number', 'amount_requested', 'amount_released', 'release_date', 'released_at', 'status', 'notes', 'created_by']);
const COMMITTED = loadReleaseProductionPin(KEY, ROOT);
const SQL96_PIN = loadReleaseProductionPin('sql96', ROOT);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PRE = 'e'.repeat(64);
// SQL 134's recorded production pre-state (read-only inspect of 2026-10-31, SSM 6a2f2c2c, main d0ac2e079):
// no grant on any of the fourteen columns; staging recorded the same pre-state (read-live run 41130749260).
const PRODUCTION_PRE = '7827f4c87e5bc9e7bd0def01d5f201a0a1fc26365480921896aa452e1403466d';
// The guarded staging apply (wave 30).
const STAGING_ACCEPTANCE_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/41134571358';
const OWNER_WORDS = Object.freeze(['"Merge 1468 when green"', '"start the SQL 134 staging apply"', '"merge 1471 when green"', '"Yes" to the read-only production inspect', '"Yes" to the pin change']);
// SQL 134's production apply of 2026-10-31 (main 60ebc82c2), recorded in applied, on the owner's "apply SQL 134 in production".
const SQL134_APPLIED = Object.freeze({ ssm: 'd709209e-4873-4d95-aa22-35e49b02472c', run: 'cab03139-9b20-4a34-9773-6aeb3145b971', one_use_id: 'sql134-prod-c44fcefe-878b-4a63-9819-8898861cce64', commit: '60ebc82c2f793c9cab8a87accd3aa1090f3739ea', workstream: 'prod-sql134-loss-draft-escrow-write-grants-20261031', approval: 'apply SQL 134 in production' });
const POST_INSPECT_SSM = 'b931146e-bb1d-4215-9161-655268967451';
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const keyPaths = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? keyPaths(v, `${p}${k}.`) : [`${p}${k}`]));
const neverConnect = async () => { throw new Error('should-not-connect'); };
const consumedPath = () => path.join(os.tmpdir(), `sql134-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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

test('pin: the release pin shape, applied and retired (owner approved 2026-10-31, on the staging apply; applied 2026-10-31), in step with the staging pin, the one-shot, the inventory and the test lists', () => {
  const pin = COMMITTED;
  const staging = STAGING[KEY];
  const shape = new Set(keyPaths(SQL96_PIN).filter((k) => !/^(applied|production_evidence)(\.|$)/.test(k)));
  assert.deepEqual([...shape].filter((k) => !keyPaths(pin).includes(k)), [], 'lacks the engine pin shape');
  // The record-and-retire change adds applied and production_evidence on top of the engine pin shape.
  assert.deepEqual(keyPaths(pin).filter((k) => !shape.has(k) && !/^(applied|production_evidence)(\.|$)/.test(k)), []);
  assert.equal(pin.id, RELEASE_SQL_SPECS[KEY].production_pin_rel.split('/').pop().replace(/\.json$/, ''));
  assert.equal(pin.migration, KEY);
  // Applied 2026-10-31 and retired. The pin change (#1473) recorded the read-only production inspect (SSM
  // 6a2f2c2c, main d0ac2e079) as the pre-state and the staging apply (run 41134571358) as the acceptance; its
  // words named the merges, the staging step, the inspect and the pin change, and the apply run had the owner's
  // own words for it.
  assert.equal(pin.execute, false);
  assert.match(pin.authorization, /^Applied to production on 2026-10-31; execute is false again/);
  assert.doesNotMatch(pin.authorization, /^Owner approved/);
  for (const words of OWNER_WORDS) assert.ok(pin.authorization.includes(words), words);
  assert.match(pin.authorization, /none of them words for the production apply/);
  assert.ok(pin.authorization.includes('#1473'));
  assert.ok(pin.authorization.includes('"Merge 1473"'));
  assert.ok(pin.authorization.includes(`${PRODUCTION_PRE.slice(0, 8)} -> ${pin.intended_replacement_sha256.slice(0, 8)}`));
  assert.ok(pin.authorization.includes(SQL134_APPLIED.workstream));
  assert.ok(pin.authorization.includes(`"${SQL134_APPLIED.approval}"`));
  assert.equal(pin.expected_live_definition_sha256, PRODUCTION_PRE);
  assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
  assert.equal(pin.applied.date, '2026-10-31');
  assert.equal(pin.applied.result, 'applied');
  assert.equal(pin.applied.apply_ssm_command_id, SQL134_APPLIED.ssm);
  assert.equal(pin.applied.one_shot_run_id, SQL134_APPLIED.run);
  assert.equal(pin.applied.one_use_id, SQL134_APPLIED.one_use_id);
  assert.equal(pin.applied.one_use_id_consumed, true);
  assert.equal(pin.applied.workstream_id, SQL134_APPLIED.workstream);
  assert.equal(pin.applied.source_commit, SQL134_APPLIED.commit);
  assert.equal(pin.applied.source_tarball.sha256, '20550289cb1a7c1e7a044e868f97e64b091471eb8b3bb7b1831e7b0cbe008589');
  assert.equal(pin.applied.migration_source_sha256, pin.source_sha256);
  assert.equal(pin.applied.owner_approval, SQL134_APPLIED.approval);
  assert.ok(pin.applied.owner_approval_basis.includes('"Merge 1473"'));
  assert.equal(pin.applied.operator, 'michaelcarletta-cmd');
  assert.equal(pin.applied.runner, 'i-0c35557c4e5385406');
  assert.deepEqual(pin.applied.steps, ['pin', 'source', 'inspect', 'contracts', 'manifest', 'source-recheck-before-preflight', 'preflight', 'evaluate', 'source-recheck-before-apply', 'apply', 'post-apply-inspect']);
  // The transfer run, the separate read-only --inspect after the apply, and where SSM cut the run's JSON.
  assert.match(pin.applied.one_shot_note, /transfer run 41154179368/);
  assert.match(pin.applied.one_shot_note, new RegExp(POST_INSPECT_SSM));
  assert.match(pin.applied.one_shot_note, /The run's JSON did not arrive whole: SSM returned the first 24000 characters/);
  assert.match(pin.applied.one_shot_note, /inside applied\.receipt at after_hash \(380 characters of the receipt printed\)/);
  assert.match(pin.applied.one_shot_note, /380 characters of applied\.receipt that were printed are a byte-for-byte prefix of details\.apply_result/);
  assert.match(pin.applied.one_shot_note, /receipt: applyRecord, post_apply_inspect: summary\.post_apply_inspect/);
  assert.equal(pin.applied.manifest_sha256, '29e18734e0b0e07e33e09a162cfcd6b65e9886ad30970293001beff1ca51d16a');
  assert.deepEqual(Object.values(pin.applied.contract_results).map((c) => c.evidence.split(' ')[0]), ['4/4', '6/6', '43/43']);
  for (const c of Object.values(pin.applied.contract_results)) assert.ok(c.evidence.includes(SQL134_APPLIED.run), c.test);
  assert.equal(pin.applied.pre_apply_inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.applied.pre_apply_inspect.live_matches_expected, true);
  assert.equal(pin.applied.pre_apply_inspect.already_applied, false);
  assert.deepEqual(pin.applied.pre_apply_inspect.precondition_failures, []);
  assert.deepEqual(pin.applied.pre_apply_inspect.predecessors, {});
  assert.ok(pin.applied.pre_apply_inspect.release_sql_inspect.columns.every((c) => c.acl.length === 0));
  assert.equal(pin.applied.pre_apply_inspect.release_sql_inspect.columns.length, 14);
  assert.equal(pin.applied.receipt.before_hash, PRODUCTION_PRE);
  assert.equal(pin.applied.receipt.after_hash, pin.intended_replacement_sha256);
  assert.equal(pin.applied.receipt.workstream, SQL134_APPLIED.workstream);
  assert.equal(pin.applied.receipt.commit, SQL134_APPLIED.commit);
  assert.equal(pin.applied.receipt.sql_file, SQL134_FILE);
  assert.equal(pin.applied.receipt.staging_acceptance, pin.staging_acceptance.reference);
  assert.equal(pin.applied.receipt.unrelated_catalog_sha256, '68edc0809867cfa7aa716a0b9ff75b1589a90bdd7d30f17bd4c9b148370464ab');
  assert.equal(pin.applied.receipt.unrelated_catalog_counts.functions, 1356);
  assert.equal(pin.applied.receipt.unrelated_catalog_counts.triggers, 184);
  assert.equal(pin.applied.receipt.result, 'applied');
  assert.equal(pin.applied.post_apply_inspect.already_applied, true);
  assert.equal(pin.applied.post_apply_inspect.live_definition_sha256, pin.intended_replacement_sha256);
  assert.deepEqual(pin.applied.post_apply_inspect.precondition_failures, []);
  assert.deepEqual(pin.applied.post_apply_inspect.predecessors, {});
  // Each of the fourteen columns carries exactly its two pinned grants.
  const columns = pin.applied.post_apply_inspect.release_sql_inspect.columns;
  assert.equal(columns.length, 14);
  for (const c of columns) {
    assert.equal(c.state, 'intended', c.name);
    const verb = c.name.startsWith('loss_draft_tracking.') ? 'UPDATE' : 'INSERT';
    assert.deepEqual(c.acl, [`authenticated ${verb}`, `checksops ${verb}`], c.name);
  }
  assert.deepEqual(pin.applied.post_apply_inspect.release_sql_inspect.triggers, []);
  assert.deepEqual(pin.applied.receipt.release_sql_inspect, pin.applied.post_apply_inspect.release_sql_inspect);
  for (const evidence of [SQL134_APPLIED.ssm, SQL134_APPLIED.run, SQL134_APPLIED.one_use_id, POST_INSPECT_SSM, `"${SQL134_APPLIED.approval}"`]) {
    assert.ok(pin.production_evidence['2026-10-31 apply'].includes(evidence), evidence);
  }
  assert.equal(pin.production_inspect.status, 'recorded');
  assert.equal(pin.production_inspect.date, '2026-10-31');
  assert.equal(pin.production_inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.production_inspect.ssm_command_id, '6a2f2c2c-cf5b-4e6f-9df6-12fe8221a1e9');
  assert.equal(pin.production_inspect.source_commit, 'd0ac2e0798ffc6d54b590a1c0705ca903351f6ba');
  assert.equal(pin.production_inspect.read_only, true);
  assert.equal(pin.production_inspect.connected_as, 'checksops_admin');
  assert.equal(pin.production_inspect.apply_preconditions_met, false);
  assert.deepEqual(pin.production_inspect.precondition_failures, []);
  assert.ok(pin.production_inspect.note.includes('abb179d5613b6bf008c35f74576561edd929535045c9956dc72e6c713ffb3fe7'));
  assert.ok(pin.production_inspect.note.includes(`migration source sha256 on the runner ${pin.source_sha256} == source_sha256`));
  assert.match(pin.production_inspect.note, /release_sql_inspect\.columns: all fourteen column ACLs \[\]/);
  assert.match(pin.production_inspect.note, /predecessors \{\} \(none\), predecessors_applied true/);
  assert.match(pin.production_inspect.note, /Not read: the inspect prints no table ACL of loss_draft_tracking or loss_draft_releases/);
  assert.ok(pin.production_inspect.note.includes(' Earlier: Pending: no read-only production inspect has been run for SQL 134 yet.'));
  assert.match(pin.production_inspect.note, /SQL 50's column grants on loss_draft_tracking/);
  assert.match(pin.production_inspect.note, /If already_applied is true, or precondition_failures is not \[\], stop/);
  assert.deepEqual([pin.staging_acceptance.ok, pin.staging_acceptance.reference], [true, STAGING_ACCEPTANCE_REF]);
  assert.match(pin.staging_acceptance.basis, /^Guarded staging SQL executor apply of sql134-loss-draft-escrow-write-grants, run 41134571358/);
  assert.match(pin.staging_acceptance.basis, /deploy run 41133133498/);
  assert.match(pin.staging_acceptance.basis, /Read-live run 41134851274 then reported already_applied true/);
  assert.ok(pin.staging_acceptance.basis.includes(`receipt before ${PRODUCTION_PRE}, after ${pin.intended_replacement_sha256} == intended`));
  assert.deepEqual(Object.keys(pin.staging_acceptance).sort(), ['basis', 'ok', 'reference']);
  // The staging pin recorded the same pre-state (wave 30): no grant on the fourteen columns in both environments.
  assert.equal(staging.expected_live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.expected_live_definition_sha256, staging.expected_live_definition_sha256);
  assert.equal(pin.filename, SQL134_FILE);
  assert.equal(pin.source_sha256, staging.source_sha256);
  assert.equal(pin.staging_pin_commit, staging.commit);
  assert.equal(pin.intended_replacement_sha256, staging.intended_replacement_sha256);
  assert.equal(pin.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(pin.intended_replacement_sha256, releaseIntendedHash(KEY, fs.readFileSync(path.join(ROOT, SQL134_FILE), 'utf8')));
  assert.deepEqual(pin.function_identities, []);
  assert.deepEqual(pin.function_identities, [...staging.function_identities]);
  assert.deepEqual(pin.predecessors, []);
  assert.deepEqual(pin.predecessors, RELEASE_SQL_SPECS[KEY].predecessors);
  assert.equal(pin.authorization_phrase, 'APPLY_LOSS_DRAFT_ESCROW_WRITE_GRANTS');
  for (const k of ['admin_login', 'rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(pin[k], SQL96_PIN[k], k);
  assert.equal(pin.tooling.status, 'built');
  assert.equal(pin.tooling.production_tool, RELEASE_PRODUCTION[KEY].cli);
  assert.equal(pin.tooling.production_tool, 'scripts/deployment-guard/sql134-loss-draft-escrow-write-grants-production-apply.mjs');
  assert.equal(pin.tooling.staging_workflow_choice, RELEASE_SQL_SPECS[KEY].choice);
  assert.equal(pin.tooling.one_shot_migration, KEY);
  assert.equal(pin.tooling.runbook, 'ops/production-sql-134-apply.md');
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
  assert.equal(tool.allowed_key, 'sql134_production_apply_allowed');
  assert.equal(tool.runs_before, undefined);
  assert.equal(RELEASE_SQL_SPECS[KEY].runs_before, undefined);
  assert.equal(tool.inspect_requires, undefined);
  assert.doesNotMatch(JSON.stringify(tool), /[0-9a-f]{64}/);
  const rows = JSON.stringify(readJson('ops/deployment-guard/bypass-inventory.json'));
  assert.match(rows, /"path":"scripts\/deployment-guard\/sql134-loss-draft-escrow-write-grants-production-apply\.mjs","classification":"GUARDED","capabilities":\["sql134-production-apply"\]/);
  assert.match(rows, /sql128, sql129, sql130, sql131, sql132, sql133, sql134, sql135, sql138\)/);
  const scripts = readJson('package.json').scripts;
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/deployment-guard.yml'), 'utf8');
  for (const name of ['aws/tests/release-sql134-executor.test.mjs', 'aws/tests/release-sql134-production-apply.test.mjs', 'aws/tests/sql134-loss-draft-escrow-write-grants-pg.test.mjs']) {
    assert.ok(scripts['test:deployment-guard'].includes(name), name);
    assert.ok(workflow.includes(name), name);
  }
});

test('order: no predecessor; no function; the fourteen column grants the Loss Draft escrow actions need, nothing else; SQL 50 and SQL 51 unchanged; the policies stay the boundary; the runbook, one-shot doc and README name it', () => {
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.predecessors, []);
  for (const absent of ['supersedes', 'refuse_after', 'runs_before', 'acl_functions', 'dropped_functions', 'tables', 'views', 'policies', 'triggers', 'table_privileges', 'definer_writes', 'whole_tables', 'render']) {
    assert.equal(spec[absent], undefined, absent);
  }
  assert.deepEqual(spec.functions, []);
  assert.deepEqual(spec.column_acl.map((c) => [c.table, c.column, [...c.acl]]), [
    ...UPDATE_COLUMNS.map((c) => [TRACKING, c, ['authenticated UPDATE', 'checksops UPDATE']]),
    ...INSERT_COLUMNS.map((c) => [RELEASES, c, ['authenticated INSERT', 'checksops INSERT']]),
  ]);
  assert.deepEqual(spec.altered_relations, [TRACKING, RELEASES]);
  assert.deepEqual(spec.prerequisites, [
    TRACKING, RELEASES,
    ...UPDATE_COLUMNS.map((c) => `column ${TRACKING}.${c}`),
    ...INSERT_COLUMNS.map((c) => `column ${RELEASES}.${c}`),
    'role checksops', 'role authenticated',
  ]);
  // Nothing in the release refuses after SQL 134, supersedes it or needs it.
  assert.deepEqual(Object.keys(RELEASE_SQL_SPECS).filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes(KEY)
    || (RELEASE_SQL_SPECS[key].refuse_after || []).some((m) => m.key === KEY)
    || (RELEASE_SQL_SPECS[key].predecessors || []).includes(KEY)), []);
  assert.match(COMMITTED.order_note, /^No predecessor and no order on this engine/);
  assert.match(COMMITTED.order_note, /SQL 50 already grants to checksops and authenticated/);
  assert.match(COMMITTED.order_note, /id from gen_random_uuid\(\), no sequence/);
  assert.match(COMMITTED.order_note, /a draft without a claim_id still gets no Draws row/);
  assert.match(COMMITTED.order_note, /already_applied true/);
  assert.match(COMMITTED.order_note, /The API change itself is deployed through the guarded Lambda path, not by this pin\./);
  // The file: exactly the two column-scoped GRANTs, to the two roles; nothing else.
  const text = fs.readFileSync(path.join(ROOT, SQL134_FILE), 'utf8').replace(/--[^\n]*/g, '');
  const statements = text.split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  assert.deepEqual(statements, [
    `GRANT UPDATE ( ${UPDATE_COLUMNS.join(', ')} ) ON TABLE ${TRACKING} TO checksops, authenticated`,
    `GRANT INSERT ( ${INSERT_COLUMNS.join(', ')} ) ON TABLE ${RELEASES} TO checksops, authenticated`,
  ]);
  // SQL 50 grants the other columns the escrow actions set (escrow_status, check_received_date,
  // updated_at) to the same two roles, and none of SQL 134's; no repository SQL grants INSERT on
  // loss_draft_releases.
  const sql50 = fs.readFileSync(path.join(ROOT, 'aws/workflows/sql/50_tranche5_write_grants.sql'), 'utf8');
  const tracking50 = sql50.slice(sql50.indexOf('GRANT UPDATE (\n  mortgage_servicer,'), sql50.indexOf(`ON TABLE ${TRACKING} TO checksops, authenticated;`, sql50.indexOf('GRANT UPDATE (\n  mortgage_servicer,')));
  for (const c of ['escrow_status', 'check_received_date', 'updated_at']) assert.match(tracking50, new RegExp(`\\b${c},?\\n`), c);
  for (const c of UPDATE_COLUMNS) assert.doesNotMatch(tracking50, new RegExp(`\\b${c}\\b`), c);
  assert.match(sql50, new RegExp(`GRANT SELECT, INSERT, DELETE ON TABLE ${TRACKING.replace('.', '\\.')} TO checksops, authenticated;`));
  const sqlDir = path.join(ROOT, 'aws/workflows/sql');
  for (const file of fs.readdirSync(sqlDir).filter((f) => f.endsWith('.sql') && f !== path.basename(SQL134_FILE))) {
    assert.doesNotMatch(fs.readFileSync(path.join(sqlDir, file), 'utf8').replace(/--[^\n]*/g, ''), /GRANT[^;]*\bINSERT\b[^;]*ON\s+(TABLE\s+)?public\.loss_draft_releases\b/i, file);
  }
  // The policies that stay the boundary are the repository's FOR ALL policies.
  const policies = fs.readFileSync(path.join(ROOT, 'aws/rls/sql/24_complete_write_policies.sql'), 'utf8');
  assert.match(policies, /CREATE POLICY aws_write_loss_draft_releases ON public\.loss_draft_releases\n {2}FOR ALL TO authenticated\n {2}USING \(EXISTS \(SELECT 1 FROM public\.loss_draft_tracking ldt WHERE ldt\.id = loss_draft_id {3}AND public\.aws_can_write_claim\(ldt\.claim_id\)\)\)/);
  assert.match(policies, /CREATE POLICY aws_write_loss_draft_tracking ON public\.loss_draft_tracking\n {2}FOR ALL TO authenticated\n {2}USING \(public\.aws_can_write_check\(check_intake_item_id\)\)/);
  const runbook = fs.readFileSync(path.join(ROOT, COMMITTED.tooling.runbook), 'utf8');
  assert.ok(runbook.includes(COMMITTED.intended_replacement_sha256));
  assert.ok(runbook.includes(COMMITTED.source_sha256));
  assert.match(runbook, /\*\*Status:\*\* applied to staging \(wave 30\) and to production \(2026-10-31\); the production pin is retired/);
  assert.match(runbook, /\*\*Production apply \(2026-10-31\)\.\*\*/);
  for (const evidence of [SQL134_APPLIED.ssm, SQL134_APPLIED.run, SQL134_APPLIED.workstream, POST_INSPECT_SSM, '41154179368', `"${SQL134_APPLIED.approval}"`, 'first 24000 characters']) {
    assert.ok(runbook.includes(evidence), evidence);
  }
  assert.match(runbook, /SSM\s+`6a2f2c2c-cf5b-4e6f-9df6-12fe8221a1e9`/);
  assert.match(runbook, /Staging apply \(2026-10-30\)\.\*\* Run 41134571358/);
  assert.match(runbook, /Read-live run 41130749260/);
  assert.match(runbook, /APPLY_LOSS_DRAFT_ESCROW_WRITE_GRANTS/);
  assert.match(runbook, /`aws_can_write_claim\(NULL\)` is false/);
  const oneShot = fs.readFileSync(path.join(ROOT, 'ops/production-sql-one-shot.md'), 'utf8');
  assert.match(oneShot, /\| `sql134` \|/);
  assert.match(oneShot, /`sql130`, `sql131`, `sql132`, `sql133`, `sql134`, `sql135`, `sql138`\) \|/);
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/README.md'), 'utf8'), /sql134-loss-draft-escrow-write-grants-production-apply\.mjs --inspect/);
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
  // record-and-retire change, allows only the manifest bound to its recorded pre-state: not another
  // hash, not the intended state (which is production's current state).
  const AUTHORIZED = Object.freeze({ ...COMMITTED, execute: true, authorization: 'Owner approved 2026-10-31 (test copy of the execute-authorized pin before its record-and-retire change)' });
  const committedOk = await evaluateReleaseProductionApply(KEY, manifest(AUTHORIZED), { root: ROOT, pin: AUTHORIZED });
  assert.equal(committedOk.ok, true, JSON.stringify(committedOk));
  assert.equal(committedOk.details.sql134_production_apply_allowed, true);
  assert.equal(committedOk.details.staging_acceptance, STAGING_ACCEPTANCE_REF);
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(AUTHORIZED), live_definition_sha256: PRE, expected_live_definition_sha256: PRE }, { root: ROOT, pin: AUTHORIZED })).code, CODES.SQL_COLLISION);
  const onIntended = COMMITTED.intended_replacement_sha256;
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(AUTHORIZED), live_definition_sha256: onIntended, expected_live_definition_sha256: onIntended }, { root: ROOT, pin: AUTHORIZED })).ok, false);
  // The retired committed pin refuses before connecting.
  assert.equal((await executeReleaseProductionApply(KEY, manifest(COMMITTED), { root: ROOT, connect: neverConnect, consumedPath: consumedPath() })).ok, false);

  const pin = approved();
  const allowed = await evaluateReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(allowed.details.sql134_production_apply_allowed, true);
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect: neverConnect, consumedPath: consumedPath() })).ok, true);
  const otherLive = { ...manifest(pin), expected_live_definition_sha256: 'f'.repeat(64), live_definition_sha256: 'f'.repeat(64) };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherLive, { root: ROOT, pin })).code, CODES.SQL_COLLISION);
  const otherStaging = { ...manifest(pin), staging_acceptance: { ok: true, reference: 'https://example.invalid/x' } };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherStaging, { root: ROOT, pin })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await precheckReleaseProductionApply(KEY, { ...manifest(pin), authorization_phrase: 'APPLY_STAKEHOLDER_SETTINGS_UPDATE_GRANT' }, { root: ROOT, pin, consumedPath: consumedPath() })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const off = approved({ execute: false });
  const ctx = { root: ROOT, pin: off, connect: neverConnect, consumedPath: consumedPath() };
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  assert.equal((await executeReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  // A tampered file hash is a reconciliation stop.
  assert.equal(readPinnedReleaseSql(KEY, ROOT, { ...COMMITTED, source_sha256: 'f'.repeat(64) }).code, CODES.SQL_COLLISION);

  // CLI: --apply with the committed pin, read from disk, and a manifest on another pre-state refuses without connecting
  // or spending a receipt; credential flags are refused.
  const file = path.join(os.tmpdir(), `sql134-cli-${process.pid}.json`);
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
