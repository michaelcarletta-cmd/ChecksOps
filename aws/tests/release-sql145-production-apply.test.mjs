/**
 * Production tool for SQL 145 (scripts/deployment-guard/sql145-platform-owner-billing-collection-leg-production-apply.mjs
 * on lib/release-sql-production-apply.mjs and lib/release-sql-production-cli.mjs).
 * release-sql90-97-production-apply.test.mjs runs every release key (SQL 145 included) through the
 * shared refusals; this file covers SQL 145's own:
 *
 *   - the pin has the release pin shape plus the applied record; it was execute-authorized (owner-approved pin
 *     change of 2026-11-07, #1685) with the recorded production pre-state (read-only inspect; the derived one, the
 *     same one staging had) and the staging apply as its acceptance, then applied on 2026-11-07 and retired
 *     (execute false); it is in step with the staging pin, the one-shot, the bypass inventory and the test lists;
 *   - no predecessor; the one new DEFINER writer (EXECUTE for checksops and the owner; PUBLIC, anon,
 *     authenticated and service_role revoked, RETURNS public.payment_transfers), the prerequisites (the
 *     payment transfer and obligation columns, the unique index, is_platform_owner(), SQL 136's gate,
 *     auth.uid(), role checksops), the two definer relations; no table, view, policy, trigger or drop, and
 *     no grant but the REVOKEs and the GRANT to checksops on this one function; the runbook, one-shot doc
 *     and README name it;
 *   - the pending (pre-authorization) pin refuses before connecting; an execute-authorized copy of the committed
 *     (retired) pin allows only the manifest bound to its recorded pre-state, and the retired pin itself refuses
 *     before connecting; an approved, accepted copy evaluates for the manifest built from it, and refuses with
 *     execute false, another live hash, another staging reference or a wrong phrase; the CLI spends no receipt.
 * The behavior on PostgreSQL 16 is aws/tests/sql145-platform-owner-billing-collection-leg-pg.test.mjs; the
 * executor path is aws/tests/release-sql145-executor.test.mjs.
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
import { main } from '../../scripts/deployment-guard/sql145-platform-owner-billing-collection-leg-production-apply.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql145';
const SQL145_FILE = 'aws/workflows/sql/145_platform_owner_billing_collection_leg.sql';
const IDENTITY = 'public.aws_platform_owner_insert_billing_collection_leg(uuid, text, text, text, bigint, text, text, uuid, text, text, text, text, jsonb)';
const RELATIONS = Object.freeze(['public.payment_transfers', 'public.tenant_maintenance_payments']);
const COMMITTED = loadReleaseProductionPin(KEY, ROOT);
// The derived pre-state (the function absent; derived by release-sql145-executor.test.mjs).
const ABSENT_PRE = 'c622469dcfbfc0ad8f54c0bb038457b9eb3247a17ee0c855390ddc709ee1d594';
// SQL 145's recorded production pre-state (read-only inspect of 2026-11-07, SSM f359138f, main b65d091a2): the function
// absent, the derived pre-state; staging recorded the same (read-live runs 42331198486, 42333924185).
const PRODUCTION_PRE = ABSENT_PRE;
// The guarded staging apply (wave 40).
const STAGING_ACCEPTANCE_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/42334108246';
const OWNER_WORDS = Object.freeze(['"build the fee leg fix"', '"record the SQL 145 staging pin"', '"apply SQL 145 in staging"', '"SQL 145 accepted in staging"', '"run the read-only SQL 145 production inspect"', '"record the SQL 145 production pin"']);
// SQL 145's production apply of 2026-11-07 (main fda298fa3), recorded in applied, on the owner's "apply SQL 145 in production".
const SQL145_APPLIED = Object.freeze({ ssm: '937dcbbd-13f5-4f27-8a27-c522bbd34813', run: '8d17051e-163f-43c6-a2d7-0f174fb6c2dd', one_use_id: 'sql145-prod-4c3e24cf-8250-4e96-bf49-b8121ca5b8bd', commit: 'fda298fa34ad03e4cadcb66340183ebfd2f67bcb', workstream: 'prod-sql145-platform-owner-billing-collection-leg-20261107', approval: 'apply SQL 145 in production' });
// The separate one-shot --phase inspect before the apply.
const PRE_INSPECT_SSM = 'a05bd401-5731-4e5e-88c2-1698529d496f';
const PRE_INSPECT_RUN = 'bc75684f-874a-4327-a71c-1ff01752ac0d';
// The read-only fee obligation policy check before the apply (owner: "yes, run the read-only fee obligation policy check").
const POLICY_CHECK_SSM = '8a2063ee-4dbf-49fe-b35a-e3a767666621';
const DEFINER_RELATIONS = Object.freeze(['payment_transfers', 'tenant_maintenance_payments']);
const FUNCTION_NAME = IDENTITY.replace(/^public\./, '');
const SQL96_PIN = loadReleaseProductionPin('sql96', ROOT);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PRE = 'e'.repeat(64);
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const keyPaths = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? keyPaths(v, `${p}${k}.`) : [`${p}${k}`]));
const neverConnect = async () => { throw new Error('should-not-connect'); };
const consumedPath = () => path.join(os.tmpdir(), `sql145-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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
    build_timestamp: '2026-11-07T00:00:00.000Z',
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

test('pin: the release pin shape, applied and retired (owner approved 2026-11-07, on the staging apply; applied 2026-11-07), in step with the staging pin, the one-shot, the inventory and the test lists', () => {
  const pin = COMMITTED;
  const staging = STAGING[KEY];
  const shape = new Set(keyPaths(SQL96_PIN).filter((k) => !/^(applied|production_evidence)(\.|$)/.test(k)));
  assert.deepEqual([...shape].filter((k) => !keyPaths(pin).includes(k)), [], 'lacks the engine pin shape');
  // The record-and-retire change adds applied and production_evidence on top of the engine pin shape.
  assert.deepEqual(keyPaths(pin).filter((k) => !shape.has(k) && !/^(applied|production_evidence)(\.|$)/.test(k)), []);
  assert.equal(pin.id, RELEASE_SQL_SPECS[KEY].production_pin_rel.split('/').pop().replace(/\.json$/, ''));
  assert.equal(pin.migration, KEY);
  // Applied 2026-11-07 and retired. The pin change (#1685) recorded the read-only production inspect (SSM f359138f,
  // main b65d091a2) as the pre-state and the staging apply (run 42334108246) as the acceptance; its words named the
  // staging steps, the inspect and the pin change, and the apply run had the owner's own words for it.
  assert.equal(pin.execute, false);
  assert.match(pin.authorization, /^Applied to production on 2026-11-07; execute is false again/);
  assert.doesNotMatch(pin.authorization, /^Owner approved/);
  for (const words of OWNER_WORDS) assert.ok(pin.authorization.includes(words), words);
  assert.match(pin.authorization, /none of them words for the production apply/);
  assert.ok(pin.authorization.includes('#1685'));
  assert.ok(pin.authorization.includes(`${PRODUCTION_PRE.slice(0, 8)} -> ${pin.intended_replacement_sha256.slice(0, 8)}`));
  assert.ok(pin.authorization.includes(SQL145_APPLIED.workstream));
  assert.ok(pin.authorization.includes(`"${SQL145_APPLIED.approval}"`));
  assert.equal(pin.expected_live_definition_sha256, PRODUCTION_PRE);
  assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
  assert.equal(pin.applied.date, '2026-11-07');
  assert.equal(pin.applied.result, 'applied');
  assert.equal(pin.applied.apply_ssm_command_id, SQL145_APPLIED.ssm);
  assert.equal(pin.applied.one_shot_run_id, SQL145_APPLIED.run);
  assert.equal(pin.applied.one_use_id, SQL145_APPLIED.one_use_id);
  assert.equal(pin.applied.one_use_id_consumed, true);
  assert.equal(pin.applied.workstream_id, SQL145_APPLIED.workstream);
  assert.equal(pin.applied.source_commit, SQL145_APPLIED.commit);
  assert.equal(pin.applied.source_tarball.sha256, 'bf0cd2e1b166ef4398085bdc149f1a3c4f50628bc332285a04d0a76613f96725');
  assert.equal(pin.applied.migration_source_sha256, pin.source_sha256);
  assert.equal(pin.applied.owner_approval, SQL145_APPLIED.approval);
  assert.ok(pin.applied.owner_approval_basis.includes('#1685'));
  assert.equal(pin.applied.operator, 'michaelcarletta-cmd');
  assert.equal(pin.applied.runner, 'i-0c35557c4e5385406');
  assert.deepEqual(pin.applied.steps, ['pin', 'source', 'inspect', 'contracts', 'manifest', 'source-recheck-before-preflight', 'preflight', 'evaluate', 'source-recheck-before-apply', 'apply', 'post-apply-inspect']);
  // The transfer run, the separate --phase inspect before the apply, the read-only policy check, and that the run's
  // JSON arrived whole. Production acceptance was not yet reported when this was recorded, and the record says so.
  assert.match(pin.applied.one_shot_note, /transfer run 42364538127/);
  assert.ok(pin.applied.one_shot_note.includes(PRE_INSPECT_SSM));
  assert.ok(pin.applied.one_shot_note.includes(PRE_INSPECT_RUN));
  assert.ok(pin.applied.one_shot_note.includes(POLICY_CHECK_SSM));
  assert.match(pin.applied.one_shot_note, /The run's JSON arrived whole/);
  assert.match(pin.applied.one_shot_note, /Production acceptance: not yet reported by the owner/);
  assert.equal(pin.applied.manifest_sha256, '19a727250fec1a1eeb3858788c0d528bd87892a14a81a28de7e4d60a1893687b');
  assert.deepEqual(Object.values(pin.applied.contract_results).map((c) => c.evidence.split(' ')[0]), ['4/4', '6/6', '43/43']);
  for (const c of Object.values(pin.applied.contract_results)) assert.ok(c.evidence.includes(SQL145_APPLIED.run), c.test);
  assert.equal(pin.applied.pre_apply_inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.applied.pre_apply_inspect.live_matches_expected, true);
  assert.equal(pin.applied.pre_apply_inspect.already_applied, false);
  assert.deepEqual(pin.applied.pre_apply_inspect.precondition_failures, []);
  assert.deepEqual(pin.applied.pre_apply_inspect.predecessors, {});
  assert.equal(pin.applied.pre_apply_inspect.counts, null);
  assert.deepEqual(pin.applied.pre_apply_inspect.release_sql_inspect.functions.map((f) => [f.name, f.state]), [[FUNCTION_NAME, 'absent']]);
  assert.equal(pin.applied.receipt.before_hash, PRODUCTION_PRE);
  assert.equal(pin.applied.receipt.after_hash, pin.intended_replacement_sha256);
  assert.equal(pin.applied.receipt.workstream, SQL145_APPLIED.workstream);
  assert.equal(pin.applied.receipt.commit, SQL145_APPLIED.commit);
  assert.equal(pin.applied.receipt.sql_file, SQL145_FILE);
  assert.equal(pin.applied.receipt.staging_acceptance, pin.staging_acceptance.reference);
  assert.equal(pin.applied.receipt.unrelated_catalog_sha256, 'fdf7d3cb6048bde1e2318f68e63c64c1099fc5df687c33f204f2f09cc44c6dd6');
  assert.equal(pin.applied.receipt.unrelated_catalog_counts.policies, 479);
  assert.equal(pin.applied.receipt.unrelated_catalog_counts.functions, 1360);
  assert.equal(pin.applied.receipt.result, 'applied');
  assert.equal(pin.applied.post_apply_inspect.already_applied, true);
  assert.equal(pin.applied.post_apply_inspect.live_definition_sha256, pin.intended_replacement_sha256);
  assert.deepEqual(pin.applied.post_apply_inspect.precondition_failures, []);
  assert.deepEqual(pin.applied.post_apply_inspect.predecessors, {});
  assert.equal(pin.applied.post_apply_inspect.counts, null);
  // The function intended with EXECUTE for checksops and the owner; both definer relations ok; no prerequisite missing.
  const post = pin.applied.post_apply_inspect.release_sql_inspect;
  assert.deepEqual(post.functions.map((f) => [f.name, f.state]), [[FUNCTION_NAME, 'intended']]);
  assert.deepEqual(post.function_acl, [{ name: FUNCTION_NAME, acl: ['checksops EXECUTE', 'owner EXECUTE'] }]);
  assert.deepEqual(post.definer_writes, DEFINER_RELATIONS.map((name) => ({ name, ok: true })));
  for (const absent of ['policies', 'views', 'tables', 'columns', 'constraints', 'triggers', 'table_privileges']) assert.deepEqual(post[absent], [], absent);
  assert.deepEqual(post.prerequisites_missing, []);
  assert.deepEqual(pin.applied.receipt.release_sql_inspect, post);
  for (const evidence of [SQL145_APPLIED.ssm, SQL145_APPLIED.run, SQL145_APPLIED.one_use_id, PRE_INSPECT_SSM, `"${SQL145_APPLIED.approval}"`]) {
    assert.ok(pin.production_evidence['2026-11-07 apply'].includes(evidence), evidence);
  }
  assert.equal(pin.production_inspect.status, 'recorded');
  assert.equal(pin.production_inspect.date, '2026-11-07');
  assert.equal(pin.production_inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.production_inspect.ssm_command_id, 'f359138f-4605-4b46-b4fa-cd807fbd3af6');
  assert.equal(pin.production_inspect.source_commit, 'b65d091a2925d046b3f160bbdbfc37ff4f8659af');
  assert.equal(pin.production_inspect.read_only, true);
  assert.equal(pin.production_inspect.connected_as, 'checksops_admin');
  assert.equal(pin.production_inspect.apply_preconditions_met, false);
  assert.deepEqual(pin.production_inspect.precondition_failures, []);
  assert.ok(pin.production_inspect.note.includes('12ac21a3f5af5c4801a06d7dfc7c8ea19edd1bfff34740c43c1bb7bb277dcc6e'));
  assert.ok(pin.production_inspect.note.includes(`migration source sha256 on the runner ${pin.source_sha256} == source_sha256`));
  assert.match(pin.production_inspect.note, /definer_writes ok true on both relations \(payment_transfers, tenant_maintenance_payments\)/);
  assert.match(pin.production_inspect.note, /prerequisites_missing \[\], missing_dependencies \[\], predecessors \{\} \(none\)/);
  assert.match(pin.production_inspect.note, /If already_applied is true, or precondition_failures is not \[\], stop/);
  assert.ok(pin.production_inspect.note.includes(' Earlier: Pending: no release-engine production inspect has been run for SQL 145 yet.'));
  assert.match(pin.production_inspect.note, /prerequisites_missing/);
  assert.match(pin.production_inspect.note, /definer_can_write_relations/);
  assert.match(pin.production_inspect.note, /functions_owned_by_login/);
  assert.match(pin.production_inspect.note, /function_results_match/);
  assert.match(pin.production_inspect.note, /function_acl_replaceable/);
  assert.deepEqual([pin.staging_acceptance.ok, pin.staging_acceptance.reference], [true, STAGING_ACCEPTANCE_REF]);
  assert.match(pin.staging_acceptance.basis, /^Guarded staging SQL executor apply of sql145-platform-owner-billing-collection-leg, run 42334108246/);
  assert.match(pin.staging_acceptance.basis, /deploy run 42333499880/);
  assert.match(pin.staging_acceptance.basis, /Read-live run 42334267158 then reported already_applied true/);
  assert.match(pin.staging_acceptance.basis, /"SQL 145 accepted in staging"/);
  assert.ok(pin.staging_acceptance.basis.includes(`before ${PRODUCTION_PRE}, after ${pin.intended_replacement_sha256} == intended`));
  assert.deepEqual(Object.keys(pin.staging_acceptance).sort(), ['basis', 'ok', 'reference']);
  // The staging pin recorded the same pre-state (wave 40).
  assert.equal(staging.expected_live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.expected_live_definition_sha256, staging.expected_live_definition_sha256);
  assert.equal(pin.filename, SQL145_FILE);
  assert.equal(pin.source_sha256, staging.source_sha256);
  assert.equal(pin.staging_pin_commit, staging.commit);
  assert.equal(pin.intended_replacement_sha256, staging.intended_replacement_sha256);
  assert.equal(pin.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(pin.intended_replacement_sha256, releaseIntendedHash(KEY, fs.readFileSync(path.join(ROOT, SQL145_FILE), 'utf8')));
  assert.deepEqual(pin.function_identities, RELEASE_SQL_SPECS[KEY].functions.map((fn) => fn.identity));
  assert.deepEqual(pin.function_identities, [IDENTITY]);
  assert.deepEqual(pin.function_identities, [...staging.function_identities]);
  assert.deepEqual(pin.predecessors, []);
  assert.deepEqual(pin.predecessors, RELEASE_SQL_SPECS[KEY].predecessors);
  assert.equal(pin.authorization_phrase, 'APPLY_PLATFORM_OWNER_BILLING_COLLECTION_LEG');
  for (const k of ['admin_login', 'rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(pin[k], SQL96_PIN[k], k);
  assert.equal(pin.tooling.status, 'built');
  assert.equal(pin.tooling.production_tool, RELEASE_PRODUCTION[KEY].cli);
  assert.equal(pin.tooling.production_tool, 'scripts/deployment-guard/sql145-platform-owner-billing-collection-leg-production-apply.mjs');
  assert.equal(pin.tooling.staging_workflow_choice, RELEASE_SQL_SPECS[KEY].choice);
  assert.equal(pin.tooling.one_shot_migration, KEY);
  assert.equal(pin.tooling.runbook, 'ops/production-sql-145-apply.md');
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
  assert.equal(tool.allowed_key, 'sql145_production_apply_allowed');
  assert.equal(tool.runs_before, undefined);
  assert.equal(RELEASE_SQL_SPECS[KEY].runs_before, undefined);
  assert.equal(tool.inspect_requires, undefined);
  assert.doesNotMatch(JSON.stringify(tool), /[0-9a-f]{64}/);
  const rows = JSON.stringify(readJson('ops/deployment-guard/bypass-inventory.json'));
  assert.match(rows, /"path":"scripts\/deployment-guard\/sql145-platform-owner-billing-collection-leg-production-apply\.mjs","classification":"GUARDED","capabilities":\["sql145-production-apply"\]/);
  assert.match(rows, /sql143, sql144, sql145, sql146, sql147, sql148, sql150\)/);
  const scripts = readJson('package.json').scripts;
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/deployment-guard.yml'), 'utf8');
  for (const name of ['aws/tests/release-sql145-executor.test.mjs', 'aws/tests/release-sql145-production-apply.test.mjs', 'aws/tests/sql145-platform-owner-billing-collection-leg-pg.test.mjs']) {
    assert.ok(scripts['test:deployment-guard'].includes(name), name);
    assert.ok(workflow.includes(name), name);
  }
});

test('order: no predecessor; the one new DEFINER writer, its prerequisites and the two definer relations; the REVOKEs and the GRANT to checksops, nothing else; the runbook, one-shot doc and README name it', () => {
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.predecessors, []);
  assert.equal(spec.supersedes, undefined);
  assert.deepEqual(spec.functions.map((fn) => fn.identity), [IDENTITY]);
  for (const fn of spec.functions) {
    assert.deepEqual(fn.acl, ['checksops EXECUTE', 'owner EXECUTE'], fn.identity);
    assert.deepEqual(fn.revokes, ['PUBLIC EXECUTE', 'anon EXECUTE', 'authenticated EXECUTE', 'service_role EXECUTE'], fn.identity);
    assert.equal(fn.result, 'public.payment_transfers');
  }
  assert.equal(spec.dropped_functions, undefined);
  assert.equal(spec.acl_functions, undefined);
  assert.deepEqual(spec.prerequisites.slice(0, 7), ['public.payment_transfers', 'public.payment_transfers_idempotency_uniq',
    'public.tenant_maintenance_payments', 'public.is_platform_owner()', 'public.aws_money_write_allowed()', 'auth.uid()', 'role checksops']);
  for (const column of ['payment_transfers.idempotency_key', 'payment_transfers.leg_role', 'payment_transfers.provider_metadata',
    'payment_transfers.net_amount_cents', 'tenant_maintenance_payments.amount_cents', 'tenant_maintenance_payments.billing_period']) {
    assert.ok(spec.prerequisites.includes(`column public.${column}`), column);
  }
  assert.deepEqual(spec.definer_writes, [...RELATIONS]);
  for (const absent of ['tables', 'views', 'policies', 'triggers', 'altered_relations']) assert.equal(spec[absent], undefined, absent);
  assert.match(COMMITTED.order_note, /^No predecessor: SQL 145 creates one new SECURITY DEFINER writer/);
  assert.match(COMMITTED.order_note, /definer_can_write_relations/);
  assert.match(COMMITTED.order_note, /SQL 136's gate aws_money_write_allowed\(\)/);
  assert.match(COMMITTED.order_note, /No API, Lambda or SPA change is part of this pin\./);
  // One prerequisite DO block, one CREATE OR REPLACE FUNCTION, one REVOKE DO block; the REVOKE from PUBLIC and the
  // GRANT to checksops on it; nothing else. The only write is the function body's INSERT (with its ON CONFLICT update).
  const text = fs.readFileSync(path.join(ROOT, SQL145_FILE), 'utf8').replace(/--[^\n]*/g, '');
  assert.doesNotMatch(text, /\bCREATE\s+(OR\s+REPLACE\s+)?(TRIGGER|VIEW|TABLE|POLICY)\b/i);
  assert.doesNotMatch(text, /\b(DROP|ALTER)\b/);
  assert.deepEqual([...text.matchAll(/\b(INSERT\s+INTO\s+\S+|UPDATE\s+\S+|DELETE|TRUNCATE)\b/g)].map((m) => m[0]),
    ['INSERT INTO public.payment_transfers', 'UPDATE SET']);
  assert.equal([...text.matchAll(/\bCREATE\s+OR\s+REPLACE\s+FUNCTION\b/gi)].length, 1);
  assert.equal([...text.matchAll(/\bDO\s+\$/g)].length, 2);
  assert.deepEqual([...text.matchAll(/^\s*(GRANT|REVOKE)\b.*$/gim)].map((m) => m[0].trim()), [
    `REVOKE ALL ON FUNCTION ${IDENTITY} FROM PUBLIC;`,
    `GRANT EXECUTE ON FUNCTION ${IDENTITY} TO checksops;`,
  ]);
  assert.match(text, /EXECUTE pg_catalog\.format\('REVOKE ALL ON FUNCTION public\.aws_platform_owner_insert_billing_collection_leg\(uuid, text, text, text, bigint, text, text, uuid, text, text, text, text, jsonb\) FROM %I', v_role\)/);
  assert.match(text, /FOREACH v_role IN ARRAY ARRAY\['anon', 'authenticated', 'service_role'\] LOOP/);
  assert.match(text, /RAISE EXCEPTION 'billing_collection_leg_forbidden'\s+USING ERRCODE = '42501'/);
  assert.match(text, /RAISE EXCEPTION 'billing_collection_leg_not_server_write'\s+USING ERRCODE = '42501'/);
  const runbook = fs.readFileSync(path.join(ROOT, COMMITTED.tooling.runbook), 'utf8');
  assert.ok(runbook.includes(COMMITTED.intended_replacement_sha256));
  assert.ok(runbook.includes(COMMITTED.source_sha256));
  assert.match(runbook, /\*\*Status:\*\* applied to staging \(wave 40\) and to production \(2026-11-07\); the production pin is retired/);
  assert.match(runbook, /\*\*Production apply \(2026-11-07\)\.\*\*/);
  for (const evidence of [SQL145_APPLIED.ssm, SQL145_APPLIED.run, SQL145_APPLIED.workstream, PRE_INSPECT_SSM, POLICY_CHECK_SSM, '42364538127', `"${SQL145_APPLIED.approval}"`]) {
    assert.ok(runbook.includes(evidence), evidence);
  }
  assert.match(runbook, /SSM\s+`f359138f-4605-4b46-b4fa-cd807fbd3af6`/);
  assert.match(runbook, /"SQL 145 accepted in staging"/);
  assert.match(runbook, /\*\*Staging apply \(2026-11-07\)\.\*\* Apply run 42334108246/);
  assert.match(runbook, /Read-live run 42334267158/);
  assert.match(runbook, /\*\*Predecessor\.\*\* None/);
  assert.match(runbook, /Owner 2026-11-07: "build the fee leg fix"/);
  assert.match(runbook, /2026-11-06T22:53:11Z/);
  assert.match(runbook, /APPLY_PLATFORM_OWNER_BILLING_COLLECTION_LEG/);
  const oneShot = fs.readFileSync(path.join(ROOT, 'ops/production-sql-one-shot.md'), 'utf8');
  assert.match(oneShot, /\| `sql145` \|/);
  assert.match(oneShot, /`sql143`, `sql144`, `sql145`, `sql146`, `sql147`, `sql148`, `sql150`\) \|/);
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/README.md'), 'utf8'), /sql145-platform-owner-billing-collection-leg-production-apply\.mjs --inspect/);
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
  const AUTHORIZED = Object.freeze({ ...COMMITTED, execute: true, authorization: 'Owner approved 2026-11-07 (test copy of the execute-authorized pin before its record-and-retire change)' });
  const committedOk = await evaluateReleaseProductionApply(KEY, manifest(AUTHORIZED), { root: ROOT, pin: AUTHORIZED });
  assert.equal(committedOk.ok, true, JSON.stringify(committedOk));
  assert.equal(committedOk.details.sql145_production_apply_allowed, true);
  assert.equal(committedOk.details.staging_acceptance, STAGING_ACCEPTANCE_REF);
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(AUTHORIZED), live_definition_sha256: PRE, expected_live_definition_sha256: PRE }, { root: ROOT, pin: AUTHORIZED })).code, CODES.SQL_COLLISION);
  const onIntended = COMMITTED.intended_replacement_sha256;
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(AUTHORIZED), live_definition_sha256: onIntended, expected_live_definition_sha256: onIntended }, { root: ROOT, pin: AUTHORIZED })).ok, false);
  // The retired committed pin refuses before connecting.
  assert.equal((await executeReleaseProductionApply(KEY, manifest(COMMITTED), { root: ROOT, connect: neverConnect, consumedPath: consumedPath() })).ok, false);

  const pin = approved();
  const allowed = await evaluateReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(allowed.details.sql145_production_apply_allowed, true);
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect: neverConnect, consumedPath: consumedPath() })).ok, true);
  const otherLive = { ...manifest(pin), expected_live_definition_sha256: 'f'.repeat(64), live_definition_sha256: 'f'.repeat(64) };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherLive, { root: ROOT, pin })).code, CODES.SQL_COLLISION);
  const otherStaging = { ...manifest(pin), staging_acceptance: { ok: true, reference: 'https://example.invalid/x' } };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherStaging, { root: ROOT, pin })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await precheckReleaseProductionApply(KEY, { ...manifest(pin), authorization_phrase: 'APPLY_TENANT_INCOMING_TRANSFERS' }, { root: ROOT, pin, consumedPath: consumedPath() })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const off = approved({ execute: false });
  const ctx = { root: ROOT, pin: off, connect: neverConnect, consumedPath: consumedPath() };
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  assert.equal((await executeReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  // A tampered file hash is a reconciliation stop.
  assert.equal(readPinnedReleaseSql(KEY, ROOT, { ...COMMITTED, source_sha256: 'f'.repeat(64) }).code, CODES.SQL_COLLISION);

  // CLI: --apply with the committed pin, read from disk, and a manifest on another pre-state refuses without connecting
  // or spending a receipt; credential flags are refused.
  const file = path.join(os.tmpdir(), `sql145-cli-${process.pid}.json`);
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
