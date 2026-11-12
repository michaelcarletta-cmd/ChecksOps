/**
 * Production tool for SQL 150 (scripts/deployment-guard/sql150-external-disbursement-up-to-check-amount-production-apply.mjs
 * on lib/release-sql-production-apply.mjs and lib/release-sql-production-cli.mjs).
 * release-sql90-97-production-apply.test.mjs runs every release key (SQL 150 included) through the
 * shared refusals; this file covers SQL 150's own:
 *
 *   - the pin has the release pin shape plus the applied record; it was execute-authorized (owner-approved pin
 *     change of 2026-11-11, #1756) with the recorded production pre-state (read-only inspect; the derived one, the
 *     same one staging had) and the staging apply as its acceptance, then applied on 2026-11-11 and retired
 *     (execute false); it is in step with the staging pin, the one-shot, the bypass inventory and the test lists;
 *   - predecessor and supersedes SQL 147 (its pins untouched); SQL 147's one DEFINER function replaced in place (the
 *     same identity and ACL: EXECUTE for checksops and the owner; PUBLIC, anon, authenticated and service_role revoked),
 *     the prerequisites (SQL 147's less the two PA fee columns), the six definer relations; no table, view, policy,
 *     trigger or drop, and no grant but the REVOKEs and the GRANT to checksops on this function; no overlay plan entry
 *     (no API change waits on it); the runbook, one-shot doc and README name it;
 *   - the pending (pre-authorization) pin refuses before connecting; an execute-authorized copy of the committed
 *     (retired) pin allows only the manifest bound to its recorded pre-state, and the retired pin itself refuses
 *     before connecting; an approved, accepted copy evaluates for the
 *     manifest built from it, and refuses with execute false, another live hash, another staging
 *     reference or a wrong phrase; the CLI spends no receipt.
 * The behavior on PostgreSQL 16 is aws/tests/sql150-external-disbursement-pg.test.mjs; the executor path is
 * aws/tests/release-sql150-executor.test.mjs.
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
import { main } from '../../scripts/deployment-guard/sql150-external-disbursement-up-to-check-amount-production-apply.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql150';
const SQL150_FILE = 'aws/workflows/sql/150_external_disbursement_up_to_check_amount.sql';
const IDENTITY = 'public.aws_record_external_disbursement(uuid, uuid, jsonb, text)';
const IDENTITIES = Object.freeze([IDENTITY]);
const RELATIONS = Object.freeze(['public.disbursement_batches', 'public.disbursement_splits', 'public.check_intake_items',
  'public.payment_transfers', 'public.stakeholder_accounts', 'public.check_stakeholders']);
const COMMITTED = loadReleaseProductionPin(KEY, ROOT);
// SQL 150's recorded production pre-state (read-only inspect of 2026-11-11, SSM fd54c8e6, main e9ec71bda): the function
// exactly as SQL 147 left it, the derived pre-state (release-sql150-executor.test.mjs); staging recorded the same
// (read-live runs 42928033292, 42930941348).
const PRODUCTION_PRE = '650ad0d486b5eebdf647e4c25a56c8776ed7a412d8735cfc83aad1d449b959fa';
// The guarded staging apply (wave 44).
const STAGING_ACCEPTANCE_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/42931300437';
// SQL 150's production apply of 2026-11-11 (main d3103952f), recorded in applied, on the owner's "merge it when green and apply SQL 150 in production".
const SQL150_APPLIED = Object.freeze({ ssm: '50126850-40cf-4f2f-98de-479e9319f552', run: '8be4fdca-7282-4802-87ca-1eca97197648', one_use_id: 'sql150-prod-c6158d19-21ae-44e8-8ea2-48b509a4fb66', commit: 'd3103952fc6b5ed4f9277f92c6601d426132ee01', workstream: 'prod-sql150-external-disbursement-up-to-check-amount-20261111', approval: 'merge it when green and apply SQL 150 in production' });
// The separate one-shot --phase inspect before the apply.
const PRE_INSPECT_SSM = '8f598d80-bc65-4b79-a550-540e17d76472';
const PRE_INSPECT_RUN = '282a4432-d04e-467c-b970-0b1d7ef1613f';
const OWNER_WORDS = Object.freeze(['"I want to be able to record up to the check amount"', '"build the SQL 150 tooling and merge it when green"', '"apply SQL 150 in staging"', '"record the SQL 150 staging pin and merge it when green"', '"run the read-only SQL 150 production inspect"', '"record the SQL 150 production pin"', '"SQL 150 accepted in staging"']);
const SQL96_PIN = loadReleaseProductionPin('sql96', ROOT);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PRE = 'e'.repeat(64);
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const keyPaths = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? keyPaths(v, `${p}${k}.`) : [`${p}${k}`]));
const neverConnect = async () => { throw new Error('should-not-connect'); };
const consumedPath = () => path.join(os.tmpdir(), `sql150-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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

test('pin: the release pin shape, applied and retired (owner approved 2026-11-11, on the staging apply; applied 2026-11-11), in step with the staging pin, the one-shot, the inventory and the test lists', () => {
  const pin = COMMITTED;
  const staging = STAGING[KEY];
  const shape = new Set(keyPaths(SQL96_PIN).filter((k) => !/^(applied|production_evidence)(\.|$)/.test(k)));
  assert.deepEqual([...shape].filter((k) => !keyPaths(pin).includes(k)), [], 'lacks the engine pin shape');
  // The record-and-retire change adds applied and production_evidence on top of the engine pin shape.
  assert.deepEqual(keyPaths(pin).filter((k) => !shape.has(k) && !/^(applied|production_evidence)(\.|$)/.test(k)), []);
  assert.equal(pin.id, RELEASE_SQL_SPECS[KEY].production_pin_rel.split('/').pop().replace(/\.json$/, ''));
  assert.equal(pin.migration, KEY);
  // Owner-approved pin change of 2026-11-11: the read-only production inspect (SSM fd54c8e6, main e9ec71bda) recorded
  // as the pre-state; the staging apply (run 42931300437) as the acceptance.
  // Applied 2026-11-11 and retired (pin change #1756; the apply run had the owner's own words for it, passed verbatim).
  assert.equal(pin.execute, false);
  assert.match(pin.authorization, /^Applied to production on 2026-11-11; execute is false again/);
  assert.doesNotMatch(pin.authorization, /^Owner approved/);
  for (const words of OWNER_WORDS) assert.ok(pin.authorization.includes(words), words);
  assert.ok(pin.authorization.includes('#1756'));
  assert.ok(pin.authorization.includes(`${PRODUCTION_PRE.slice(0, 8)} -> ${pin.intended_replacement_sha256.slice(0, 8)}`));
  assert.ok(pin.authorization.includes(SQL150_APPLIED.workstream));
  assert.ok(pin.authorization.includes(`"${SQL150_APPLIED.approval}"`));
  assert.equal(pin.expected_live_definition_sha256, PRODUCTION_PRE);
  assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
  assert.equal(pin.applied.date, '2026-11-11');
  assert.equal(pin.applied.result, 'applied');
  assert.equal(pin.applied.apply_ssm_command_id, SQL150_APPLIED.ssm);
  assert.equal(pin.applied.one_shot_run_id, SQL150_APPLIED.run);
  assert.equal(pin.applied.one_use_id, SQL150_APPLIED.one_use_id);
  assert.equal(pin.applied.one_use_id_consumed, true);
  assert.equal(pin.applied.workstream_id, SQL150_APPLIED.workstream);
  assert.equal(pin.applied.source_commit, SQL150_APPLIED.commit);
  assert.equal(pin.applied.source_tarball.sha256, 'a421813a912047a2654afa9ae94643bddfd98c8e9504255ef87b9abcbb5cd5ae');
  assert.equal(pin.applied.migration_source_sha256, pin.source_sha256);
  assert.equal(pin.applied.owner_approval, SQL150_APPLIED.approval);
  assert.ok(pin.applied.owner_approval_basis.includes('#1756'));
  assert.equal(pin.applied.runner, 'i-0c35557c4e5385406');
  assert.deepEqual(pin.applied.steps, ['pin', 'source', 'inspect', 'contracts', 'manifest', 'source-recheck-before-preflight', 'preflight', 'evaluate', 'source-recheck-before-apply', 'apply', 'post-apply-inspect']);
  assert.match(pin.applied.one_shot_note, /transfer run 42935020477/);
  assert.ok(pin.applied.one_shot_note.includes(PRE_INSPECT_SSM));
  assert.ok(pin.applied.one_shot_note.includes(PRE_INSPECT_RUN));
  assert.match(pin.applied.one_shot_note, /The run's JSON arrived whole/);
  assert.match(pin.applied.one_shot_note, /Production acceptance: not yet reported by the owner/);
  assert.equal(pin.applied.manifest_sha256, '201051c135d9b2632a34b9ca8ccfd87306b77921b06fa72d010608aebec7f3f6');
  assert.deepEqual(Object.values(pin.applied.contract_results).map((c) => c.evidence.split(' ')[0]), ['4/4', '6/6', '43/43']);
  assert.equal(pin.applied.pre_apply_inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.applied.pre_apply_inspect.live_matches_expected, true);
  assert.deepEqual(pin.applied.pre_apply_inspect.precondition_failures, []);
  assert.deepEqual(pin.applied.pre_apply_inspect.predecessors, { sql147: true });
  assert.equal(pin.applied.receipt.before_hash, PRODUCTION_PRE);
  assert.equal(pin.applied.receipt.after_hash, pin.intended_replacement_sha256);
  assert.equal(pin.applied.receipt.workstream, SQL150_APPLIED.workstream);
  assert.equal(pin.applied.receipt.commit, SQL150_APPLIED.commit);
  assert.equal(pin.applied.receipt.staging_acceptance, pin.staging_acceptance.reference);
  assert.equal(pin.applied.receipt.unrelated_catalog_sha256, '3f3a1ddce8ba88806d81c4eceae9cbd15e8f34ec73d5d5f8008ac63924558570');
  assert.equal(pin.applied.receipt.result, 'applied');
  assert.equal(pin.applied.post_apply_inspect.already_applied, true);
  assert.equal(pin.applied.post_apply_inspect.live_definition_sha256, pin.intended_replacement_sha256);
  assert.deepEqual(pin.applied.post_apply_inspect.precondition_failures, []);
  assert.deepEqual(pin.applied.post_apply_inspect.predecessors, { sql147: true });
  const post = pin.applied.post_apply_inspect.release_sql_inspect;
  assert.deepEqual(post.functions.map((f) => [f.name, f.state]), [['aws_record_external_disbursement(uuid, uuid, jsonb, text)', 'intended']]);
  assert.deepEqual(post.function_acl, [{ name: 'aws_record_external_disbursement(uuid, uuid, jsonb, text)', acl: ['checksops EXECUTE', 'owner EXECUTE'] }]);
  assert.ok(post.definer_writes.length === 6 && post.definer_writes.every((w) => w.ok === true));
  assert.deepEqual(post.prerequisites_missing, []);
  assert.deepEqual(pin.applied.receipt.release_sql_inspect, post);
  for (const evidence of [SQL150_APPLIED.ssm, SQL150_APPLIED.run, SQL150_APPLIED.one_use_id, PRE_INSPECT_SSM, `"${SQL150_APPLIED.approval}"`, '"DEPLOY WEBSITE TO PRODUCTION"']) {
    assert.ok(pin.production_evidence['2026-11-11 apply'].includes(evidence), evidence);
  }
  assert.equal(pin.production_inspect.status, 'recorded');
  assert.equal(pin.production_inspect.date, '2026-11-11');
  assert.equal(pin.production_inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.production_inspect.ssm_command_id, 'fd54c8e6-bbeb-466e-92e4-d45645203570');
  assert.equal(pin.production_inspect.source_commit, 'e9ec71bdad1f90cac544dc21ec11c5af64e42f5a');
  assert.equal(pin.production_inspect.read_only, true);
  assert.equal(pin.production_inspect.apply_preconditions_met, false);
  assert.deepEqual(pin.production_inspect.precondition_failures, []);
  assert.ok(pin.production_inspect.note.includes('823eaf419e3529c1882fa18d5b239bebf696247881f08729c9b8283a77c1f108'));
  assert.ok(pin.production_inspect.note.includes(`migration source sha256 on the runner ${pin.source_sha256} == source_sha256`));
  assert.match(pin.production_inspect.note, /already_applied false\), live_matches_expected false, precondition_failures \[\], apply_preconditions_met false, errors \[\]/);
  assert.match(pin.production_inspect.note, /If already_applied is true, or precondition_failures is not \[\], stop/);
  assert.ok(pin.production_inspect.note.includes(' Earlier: Pending: no release-engine production inspect has been run for SQL 150 yet.'));
  for (const name of ['prerequisites_missing', 'predecessors_applied', 'definer_can_write_relations', 'functions_owned_by_login', 'function_results_match', 'function_acl_replaceable']) {
    assert.ok(pin.production_inspect.note.includes(name), name);
  }
  assert.match(pin.production_inspect.note, /SQL 147 applied \(predecessors \{"sql147": true\}\)/);
  assert.deepEqual([pin.staging_acceptance.ok, pin.staging_acceptance.reference], [true, STAGING_ACCEPTANCE_REF]);
  assert.match(pin.staging_acceptance.basis, /^Guarded staging SQL executor apply of sql150-external-disbursement-up-to-check-amount, run 42931300437/);
  assert.match(pin.staging_acceptance.basis, /deploy run 42930343151/);
  assert.match(pin.staging_acceptance.basis, /Read-live run 42931628662 \(job 130231543783\) then reported already_applied true/);
  assert.match(pin.staging_acceptance.basis, /under the owner's words "apply SQL 150 in staging"/);
  assert.match(pin.staging_acceptance.basis, /"SQL 150 accepted in staging"/);
  assert.ok(pin.staging_acceptance.basis.includes(`before ${PRODUCTION_PRE}, after ${pin.intended_replacement_sha256} == intended`));
  assert.deepEqual(Object.keys(pin.staging_acceptance).sort(), ['basis', 'ok', 'reference']);
  // The staging pin recorded the same pre-state (wave 44).
  assert.equal(staging.expected_live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.filename, SQL150_FILE);
  assert.equal(pin.source_sha256, staging.source_sha256);
  assert.equal(pin.staging_pin_commit, staging.commit);
  assert.equal(pin.intended_replacement_sha256, staging.intended_replacement_sha256);
  assert.equal(pin.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(pin.intended_replacement_sha256, releaseIntendedHash(KEY, fs.readFileSync(path.join(ROOT, SQL150_FILE), 'utf8')));
  assert.deepEqual(pin.function_identities, RELEASE_SQL_SPECS[KEY].functions.map((fn) => fn.identity));
  assert.deepEqual(pin.function_identities, [...IDENTITIES]);
  assert.deepEqual(pin.function_identities, [...staging.function_identities]);
  assert.deepEqual(pin.predecessors, ['sql147']);
  assert.deepEqual(pin.predecessors, RELEASE_SQL_SPECS[KEY].predecessors);
  assert.equal(pin.authorization_phrase, 'APPLY_EXTERNAL_DISBURSEMENT_UP_TO_CHECK_AMOUNT');
  for (const k of ['admin_login', 'rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(pin[k], SQL96_PIN[k], k);
  assert.equal(pin.tooling.status, 'built');
  assert.equal(pin.tooling.production_tool, RELEASE_PRODUCTION[KEY].cli);
  assert.equal(pin.tooling.production_tool, 'scripts/deployment-guard/sql150-external-disbursement-up-to-check-amount-production-apply.mjs');
  assert.equal(pin.tooling.staging_workflow_choice, RELEASE_SQL_SPECS[KEY].choice);
  assert.equal(pin.tooling.one_shot_migration, KEY);
  assert.equal(pin.tooling.runbook, 'ops/production-sql-150-apply.md');
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
  assert.equal(tool.allowed_key, 'sql150_production_apply_allowed');
  assert.equal(tool.runs_before, undefined);
  assert.equal(RELEASE_SQL_SPECS[KEY].runs_before, undefined);
  assert.equal(tool.inspect_requires, undefined);
  assert.doesNotMatch(JSON.stringify(tool), /[0-9a-f]{64}/);
  const rows = JSON.stringify(readJson('ops/deployment-guard/bypass-inventory.json'));
  assert.match(rows, /"path":"scripts\/deployment-guard\/sql150-external-disbursement-up-to-check-amount-production-apply\.mjs","classification":"GUARDED","capabilities":\["sql150-production-apply"\]/);
  assert.match(rows, /sql146, sql147, sql148, sql150, sql152, sql153, sql154, sql155, sql156, sql158, sql159, sql160\)/);
  const scripts = readJson('package.json').scripts;
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/deployment-guard.yml'), 'utf8');
  for (const name of ['aws/tests/release-sql150-executor.test.mjs', 'aws/tests/release-sql150-production-apply.test.mjs', 'aws/tests/sql150-external-disbursement-pg.test.mjs']) {
    assert.ok(scripts['test:deployment-guard'].includes(name), name);
    assert.ok(workflow.includes(name), name);
  }
});

test('order: predecessor and supersedes SQL 147 (untouched); SQL 147\'s one DEFINER function replaced in place, its prerequisites and the six definer relations; the REVOKEs and the GRANT to checksops, nothing else; no plan entry; the runbook, one-shot doc and README name it', () => {
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.predecessors, ['sql147']);
  assert.deepEqual(spec.supersedes, ['sql147']);
  assert.deepEqual(spec.functions.map((fn) => fn.identity), [...IDENTITIES]);
  for (const fn of spec.functions) {
    assert.deepEqual(fn.acl, ['checksops EXECUTE', 'owner EXECUTE'], fn.identity);
    assert.deepEqual(fn.revokes, ['PUBLIC EXECUTE', 'anon EXECUTE', 'authenticated EXECUTE', 'service_role EXECUTE'], fn.identity);
    assert.equal(fn.result, undefined, fn.identity);
  }
  // SQL 147's spec carries the same identity, ACL and revokes: the replacement keeps them.
  assert.deepEqual(spec.functions, RELEASE_SQL_SPECS.sql147.functions);
  assert.equal(spec.dropped_functions, undefined);
  assert.equal(spec.acl_functions, undefined);
  assert.deepEqual(spec.prerequisites.slice(0, 9), [...RELATIONS, 'public.aws_can_write_tenant(uuid)', 'auth.uid()', 'role checksops']);
  for (const column of ['disbursement_batches.approved_amount_cents', 'disbursement_splits.idempotence_key', 'disbursement_splits.external_check_number',
    'check_intake_items.amount', 'payment_transfers.leg_role', 'stakeholder_accounts.nickname', 'check_stakeholders.stakeholder_account_id']) {
    assert.ok(spec.prerequisites.includes(`column public.${column}`), column);
  }
  for (const column of ['check_intake_items.pa_fee_pct', 'check_intake_items.pa_fee_amount']) {
    assert.ok(!spec.prerequisites.includes(`column public.${column}`), column);
    assert.ok(RELEASE_SQL_SPECS.sql147.prerequisites.includes(`column public.${column}`), column);
  }
  assert.deepEqual(spec.definer_writes, [...RELATIONS]);
  for (const absent of ['tables', 'views', 'policies', 'triggers', 'altered_relations', 'table_privileges', 'column_acl', 'added_columns']) assert.equal(spec[absent], undefined, absent);
  assert.match(COMMITTED.order_note, /^Predecessor and supersedes SQL 147 \(applied to production on 2026-11-10, pin retired\)/);
  assert.match(COMMITTED.order_note, /predecessors_applied/);
  assert.match(COMMITTED.order_note, /definer_can_write_relations/);
  assert.match(COMMITTED.order_note, /SQL 90's aws_can_write_tenant\(uuid\)/);
  assert.match(COMMITTED.order_note, /No API, Lambda or SPA change is part of this pin\./);
  // SQL 147's production pin is as applied and retired; this change does not touch it.
  const sql147 = loadReleaseProductionPin('sql147', ROOT);
  assert.equal(sql147.execute, false);
  assert.equal(sql147.applied.result, 'applied');
  // No API change waits on this pin: the overlay plan has no SQL 150 prerequisite and names no SQL 150 file.
  const plan = readJson('ops/deployment-guard/production-api-overlay-plan.json');
  assert.equal(plan.sql_prerequisites?.[SQL150_FILE], undefined);
  assert.doesNotMatch(JSON.stringify(plan), /150_external_disbursement_up_to_check_amount/);
  // One prerequisite DO block, one CREATE OR REPLACE FUNCTION, one REVOKE DO block; the REVOKE from PUBLIC and the
  // GRANT to checksops on it; nothing else. The only writes are the batch and split INSERTs; the check is locked once.
  const text = fs.readFileSync(path.join(ROOT, SQL150_FILE), 'utf8').replace(/--[^\n]*/g, '');
  assert.doesNotMatch(text, /\bCREATE\s+(OR\s+REPLACE\s+)?(TRIGGER|VIEW|TABLE|POLICY)\b/i);
  assert.doesNotMatch(text, /\b(DROP|ALTER)\b/);
  assert.doesNotMatch(text, /pa_fee/);
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
  assert.match(text, /v_available := GREATEST\(0, v_gross - v_split_out - v_sent_out\);/);
  const runbook = fs.readFileSync(path.join(ROOT, COMMITTED.tooling.runbook), 'utf8');
  assert.ok(runbook.includes(COMMITTED.intended_replacement_sha256));
  assert.ok(runbook.includes(COMMITTED.source_sha256));
  assert.match(runbook, /\*\*Status:\*\* applied to staging \(wave 44\) and to production \(2026-11-11\); the production pin is retired/);
  assert.match(runbook, /\*\*Production apply \(2026-11-11\)\.\*\*/);
  for (const evidence of [SQL150_APPLIED.ssm, SQL150_APPLIED.run, SQL150_APPLIED.workstream, PRE_INSPECT_SSM, PRE_INSPECT_RUN, '42935020477', `"${SQL150_APPLIED.approval}"`]) {
    assert.ok(runbook.includes(evidence), evidence);
  }
  assert.match(runbook, /SSM\s+`fd54c8e6-bbeb-466e-92e4-d45645203570`/);
  assert.match(runbook, /\*\*Staging apply \(2026-11-11\)\.\*\* Apply run 42931300437/);
  assert.match(runbook, /\*\*Predecessor\.\*\* SQL 147/);
  for (const words of ['"I want to be able\nto record up to the check amount"', '"merge 1752 when green"', '"build the SQL 150 tooling\nand merge it when green"']) {
    assert.ok(runbook.replace(/\s+/g, ' ').includes(words.replace(/\s+/g, ' ')), words);
  }
  assert.ok(runbook.includes('#1752'));
  assert.match(runbook, /APPLY_EXTERNAL_DISBURSEMENT_UP_TO_CHECK_AMOUNT/);
  const oneShot = fs.readFileSync(path.join(ROOT, 'ops/production-sql-one-shot.md'), 'utf8');
  assert.match(oneShot, /\| `sql150` \|/);
  assert.match(oneShot, /`sql146`, `sql147`, `sql148`, `sql150`, `sql152`, `sql153`, `sql154`, `sql155`, `sql156`, `sql158`, `sql159`, `sql160`\) \|/);
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/README.md'), 'utf8'), /sql150-external-disbursement-up-to-check-amount-production-apply\.mjs --inspect/);
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

  // The committed (authorized) pin allows only the manifest bound to its recorded pre-state: not another hash, not the
  // intended state.
  const AUTHORIZED = Object.freeze({ ...COMMITTED, execute: true, authorization: 'Owner approved 2026-11-11 (test copy of the execute-authorized pin before its record-and-retire change)' });
  const committedOk = await evaluateReleaseProductionApply(KEY, manifest(AUTHORIZED), { root: ROOT, pin: AUTHORIZED });
  assert.equal(committedOk.ok, true, JSON.stringify(committedOk));
  assert.equal(committedOk.details.sql150_production_apply_allowed, true);
  assert.equal(committedOk.details.staging_acceptance, STAGING_ACCEPTANCE_REF);
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(AUTHORIZED), live_definition_sha256: PRE, expected_live_definition_sha256: PRE }, { root: ROOT, pin: AUTHORIZED })).code, CODES.SQL_COLLISION);
  const onIntended = COMMITTED.intended_replacement_sha256;
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(AUTHORIZED), live_definition_sha256: onIntended, expected_live_definition_sha256: onIntended }, { root: ROOT, pin: AUTHORIZED })).ok, false);
  // The retired committed pin refuses before connecting.
  assert.equal((await executeReleaseProductionApply(KEY, manifest(COMMITTED), { root: ROOT, connect: neverConnect, consumedPath: consumedPath() })).ok, false);

  const pin = approved();
  const allowed = await evaluateReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(allowed.details.sql150_production_apply_allowed, true);
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect: neverConnect, consumedPath: consumedPath() })).ok, true);
  const otherLive = { ...manifest(pin), expected_live_definition_sha256: 'f'.repeat(64), live_definition_sha256: 'f'.repeat(64) };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherLive, { root: ROOT, pin })).code, CODES.SQL_COLLISION);
  const otherStaging = { ...manifest(pin), staging_acceptance: { ok: true, reference: 'https://example.invalid/x' } };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherStaging, { root: ROOT, pin })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  // SQL 147's phrase does not authorize SQL 150.
  assert.equal((await precheckReleaseProductionApply(KEY, { ...manifest(pin), authorization_phrase: 'APPLY_EXTERNAL_DISBURSEMENT_RECORD' }, { root: ROOT, pin, consumedPath: consumedPath() })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const off = approved({ execute: false });
  const ctx = { root: ROOT, pin: off, connect: neverConnect, consumedPath: consumedPath() };
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  assert.equal((await executeReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  // A tampered file hash is a reconciliation stop.
  assert.equal(readPinnedReleaseSql(KEY, ROOT, { ...COMMITTED, source_sha256: 'f'.repeat(64) }).code, CODES.SQL_COLLISION);

  // CLI: --apply with the committed pin, read from disk, and a manifest on another pre-state refuses without connecting
  // or spending a receipt; credential flags are refused.
  const file = path.join(os.tmpdir(), `sql150-cli-${process.pid}.json`);
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
