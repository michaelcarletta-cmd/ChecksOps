/**
 * Production tool for SQL 138 (scripts/deployment-guard/sql138-payee-setup-link-closed-after-verification-
 * production-apply.mjs on lib/release-sql-production-apply.mjs and lib/release-sql-production-cli.mjs).
 * release-sql90-97-production-apply.test.mjs runs every release key (SQL 138 included) through the
 * shared refusals; this file covers SQL 138's own:
 *
 *   - the pin has the release pin shape plus the applied record; it was execute-authorized (owner-
 *     approved pin change of 2026-11-01, #1505) with the recorded production pre-state (derived from SQL
 *     113's bytes in release-sql138-executor.test.mjs; the same one staging had) and the staging apply as
 *     its acceptance, then applied on 2026-11-01 and retired (execute false); it is in step with the
 *     staging pin, the one-shot, the bypass inventory and the test lists;
 *   - predecessor and supersedes SQL 113 (applied and retired, untouched here); the one replaced function
 *     (EXECUTE for checksops and the owner, PUBLIC revoked), the prerequisites, the definer writes; no
 *     table, view, policy, trigger or drop, and no grant but the REVOKE from PUBLIC and the GRANT to
 *     checksops on this one function; no overlay plan entry (no API change); the API reaches the function
 *     only through PAYEE_RECORD_SQL, maps the refusal to a non-500 answer, and calls the provider's
 *     disableBank only after the record succeeded; the runbook, one-shot doc and README name it;
 *   - the pending (pre-authorization) pin refuses before connecting; an execute-authorized copy of the
 *     committed (retired) pin allows only the manifest bound to its recorded pre-state, and the retired
 *     pin itself refuses before connecting; an approved, accepted copy evaluates for the
 *     manifest built from it, and refuses with execute false, another live hash, another staging
 *     reference or a wrong phrase; the CLI spends no receipt.
 * The behavior on PostgreSQL 16 is aws/tests/sql138-payee-setup-link-closed-pg.test.mjs; the
 * executor path is aws/tests/release-sql138-executor.test.mjs.
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
import { main } from '../../scripts/deployment-guard/sql138-payee-setup-link-closed-after-verification-production-apply.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql138';
const SQL138_FILE = 'aws/workflows/sql/138_payee_setup_link_closed_after_verification.sql';
const IDENTITY = 'public.aws_public_payee_record(text, text, jsonb)';
const HANDLERS = 'aws/functions/api/providers/payees/handlers.mjs';
const COMMITTED = loadReleaseProductionPin(KEY, ROOT);
const SQL96_PIN = loadReleaseProductionPin('sql96', ROOT);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PRE = 'e'.repeat(64);
// SQL 138's recorded production pre-state (read-only inspect of 2026-11-01, SSM 0cbe4c6b, main e8ef1f52d): the
// function as SQL 113 left it; staging recorded the same pre-state (read-live run 41239902526).
const PRODUCTION_PRE = 'ec36c29e3472a9777b4a1d08ff7c3da5c00b1dc70cb4b754ef5b04ff0e73633c';
// The guarded staging apply (wave 33).
const STAGING_ACCEPTANCE_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/41260586254';
// SQL 138's production apply of 2026-11-01 (main 10a8cd68c), recorded in applied, on the owner's "apply SQL 138 in production".
const SQL138_APPLIED = Object.freeze({ ssm: 'baf10f52-3883-4261-babc-667e0cdf1b2b', run: 'b3e76f4b-510f-4340-84c9-1a01cb3a48c4', one_use_id: 'sql138-prod-77b84091-f40c-4762-ba16-e4b192825b00', commit: '10a8cd68cdc322a9a4e25c1786a39022d1d1b44f', workstream: 'prod-sql138-payee-setup-link-closed-20261101', approval: 'apply SQL 138 in production' });
// The separate one-shot --phase inspect before the apply.
const PRE_INSPECT_SSM = '80ed0c70-4062-4474-bf6e-acce03997592';
const PRE_INSPECT_RUN = 'b60c9f68-9fd6-448e-911d-976d904bc0c4';
const OWNER_WORDS = Object.freeze(['"Okay, let\'s do option A and fix it correctly for SQL 138"', '"record the SQL 138 staging pin"', '"Merge 1500 when green"', '"apply SQL 138 in staging"', '"accept SQL 138 staging on the tests"', '"start the SQL runner for the SQL 138 production inspect"', '"record the SQL 138 production pin"']);
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const keyPaths = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? keyPaths(v, `${p}${k}.`) : [`${p}${k}`]));
const neverConnect = async () => { throw new Error('should-not-connect'); };
const consumedPath = () => path.join(os.tmpdir(), `sql138-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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
    build_timestamp: '2026-10-31T00:00:00.000Z',
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

test('pin: the release pin shape, applied and retired (owner approved 2026-11-01, on the staging apply; applied 2026-11-01), in step with the staging pin, the one-shot, the inventory and the test lists', () => {
  const pin = COMMITTED;
  const staging = STAGING[KEY];
  const shape = new Set(keyPaths(SQL96_PIN).filter((k) => !/^(applied|production_evidence)(\.|$)/.test(k)));
  assert.deepEqual([...shape].filter((k) => !keyPaths(pin).includes(k)), [], 'lacks the engine pin shape');
  // The record-and-retire change adds applied and production_evidence on top of the engine pin shape.
  assert.deepEqual(keyPaths(pin).filter((k) => !shape.has(k) && !/^(applied|production_evidence)(\.|$)/.test(k)), []);
  assert.equal(pin.id, RELEASE_SQL_SPECS[KEY].production_pin_rel.split('/').pop().replace(/\.json$/, ''));
  assert.equal(pin.migration, KEY);
  // Applied 2026-11-01 and retired. The pin change (#1505) recorded the read-only production inspect (SSM 0cbe4c6b,
  // main e8ef1f52d) as the pre-state and the staging apply (run 41260586254) as the acceptance; its words named the
  // staging steps, the inspect and the pin change, and the apply run had the owner's own words for it.
  assert.equal(pin.execute, false);
  assert.match(pin.authorization, /^Applied to production on 2026-11-01; execute is false again/);
  assert.doesNotMatch(pin.authorization, /^Owner approved/);
  for (const words of OWNER_WORDS) assert.ok(pin.authorization.includes(words), words);
  assert.match(pin.authorization, /none of them words for the production apply/);
  assert.ok(pin.authorization.includes('#1505'));
  assert.ok(pin.authorization.includes('"Merge the SQL 138 production pin when green"'));
  assert.ok(pin.authorization.includes(`${PRODUCTION_PRE.slice(0, 8)} -> ${pin.intended_replacement_sha256.slice(0, 8)}`));
  assert.ok(pin.authorization.includes(SQL138_APPLIED.workstream));
  assert.ok(pin.authorization.includes(`"${SQL138_APPLIED.approval}"`));
  assert.equal(pin.expected_live_definition_sha256, PRODUCTION_PRE);
  assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
  assert.equal(pin.applied.date, '2026-11-01');
  assert.equal(pin.applied.result, 'applied');
  assert.equal(pin.applied.apply_ssm_command_id, SQL138_APPLIED.ssm);
  assert.equal(pin.applied.one_shot_run_id, SQL138_APPLIED.run);
  assert.equal(pin.applied.one_use_id, SQL138_APPLIED.one_use_id);
  assert.equal(pin.applied.one_use_id_consumed, true);
  assert.equal(pin.applied.workstream_id, SQL138_APPLIED.workstream);
  assert.equal(pin.applied.source_commit, SQL138_APPLIED.commit);
  assert.equal(pin.applied.source_tarball.sha256, '3863477e0a72d9f8d23a1cd9308227975a4e66d64a61d68f7ab344883859d160');
  assert.equal(pin.applied.migration_source_sha256, pin.source_sha256);
  assert.equal(pin.applied.owner_approval, SQL138_APPLIED.approval);
  assert.ok(pin.applied.owner_approval_basis.includes('"Merge the SQL 138 production pin when green"'));
  assert.equal(pin.applied.operator, 'michaelcarletta-cmd');
  assert.equal(pin.applied.runner, 'i-0c35557c4e5385406');
  assert.deepEqual(pin.applied.steps, ['pin', 'source', 'inspect', 'contracts', 'manifest', 'source-recheck-before-preflight', 'preflight', 'evaluate', 'source-recheck-before-apply', 'apply', 'post-apply-inspect']);
  // The transfer run, the separate --phase inspect before the apply, the runner times, and that the JSON arrived whole.
  assert.match(pin.applied.one_shot_note, /transfer run 41305933006/);
  assert.ok(pin.applied.one_shot_note.includes(PRE_INSPECT_SSM));
  assert.ok(pin.applied.one_shot_note.includes(PRE_INSPECT_RUN));
  assert.match(pin.applied.one_shot_note, /started from stopped for this run at 2026-11-01T12:20:43Z/);
  assert.match(pin.applied.one_shot_note, /stopped again at 12:22:14Z/);
  assert.match(pin.applied.one_shot_note, /The run's JSON arrived whole/);
  assert.match(pin.applied.one_shot_note, /"record SQL 138"/);
  assert.equal(pin.applied.manifest_sha256, '9d007c7f302b66425816de8f4efd4f2016b072a4e34e1bf18e984574bd1f842c');
  assert.deepEqual(Object.values(pin.applied.contract_results).map((c) => c.evidence.split(' ')[0]), ['4/4', '6/6', '43/43']);
  for (const c of Object.values(pin.applied.contract_results)) assert.ok(c.evidence.includes(SQL138_APPLIED.run), c.test);
  assert.equal(pin.applied.pre_apply_inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.applied.pre_apply_inspect.live_matches_expected, true);
  assert.equal(pin.applied.pre_apply_inspect.already_applied, false);
  assert.deepEqual(pin.applied.pre_apply_inspect.precondition_failures, []);
  assert.deepEqual(pin.applied.pre_apply_inspect.predecessors, { sql113: true });
  assert.equal(pin.applied.receipt.before_hash, PRODUCTION_PRE);
  assert.equal(pin.applied.receipt.after_hash, pin.intended_replacement_sha256);
  assert.equal(pin.applied.receipt.workstream, SQL138_APPLIED.workstream);
  assert.equal(pin.applied.receipt.commit, SQL138_APPLIED.commit);
  assert.equal(pin.applied.receipt.sql_file, SQL138_FILE);
  assert.equal(pin.applied.receipt.staging_acceptance, pin.staging_acceptance.reference);
  assert.equal(pin.applied.receipt.unrelated_catalog_sha256, 'fabd8bfc44642720fe5b544c174330d641fcc542effc85e6f38759a1fe586623');
  assert.equal(pin.applied.receipt.unrelated_catalog_counts.functions, 1355);
  assert.equal(pin.applied.receipt.unrelated_catalog_counts.triggers, 184);
  assert.equal(pin.applied.receipt.result, 'applied');
  assert.equal(pin.applied.post_apply_inspect.already_applied, true);
  assert.equal(pin.applied.post_apply_inspect.live_definition_sha256, pin.intended_replacement_sha256);
  assert.deepEqual(pin.applied.post_apply_inspect.precondition_failures, []);
  assert.deepEqual(pin.applied.post_apply_inspect.predecessors, { sql113: true });
  // aws_public_payee_record intended with EXECUTE for checksops and the owner; both definer writes ok.
  const post = pin.applied.post_apply_inspect.release_sql_inspect;
  assert.deepEqual(post.functions, [{ name: 'aws_public_payee_record(text, text, jsonb)', state: 'intended' }]);
  assert.deepEqual(post.function_acl, [{ name: 'aws_public_payee_record(text, text, jsonb)', acl: ['checksops EXECUTE', 'owner EXECUTE'] }]);
  assert.deepEqual(post.definer_writes, [{ name: 'external_payment_recipients', ok: true }, { name: 'payment_provider_methods', ok: true }]);
  assert.deepEqual(pin.applied.receipt.release_sql_inspect, post);
  for (const evidence of [SQL138_APPLIED.ssm, SQL138_APPLIED.run, SQL138_APPLIED.one_use_id, PRE_INSPECT_SSM, `"${SQL138_APPLIED.approval}"`, '"record SQL 138"']) {
    assert.ok(pin.production_evidence['2026-11-01 apply'].includes(evidence), evidence);
  }
  assert.equal(pin.production_inspect.status, 'recorded');
  assert.equal(pin.production_inspect.date, '2026-11-01');
  assert.equal(pin.production_inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.production_inspect.ssm_command_id, '0cbe4c6b-5765-4f37-a543-1849ebcfe584');
  assert.equal(pin.production_inspect.source_commit, 'e8ef1f52dfaafd812b86aead3e6063f8f95d72c7');
  assert.equal(pin.production_inspect.read_only, true);
  assert.equal(pin.production_inspect.connected_as, 'checksops_admin');
  assert.equal(pin.production_inspect.apply_preconditions_met, false);
  assert.deepEqual(pin.production_inspect.precondition_failures, []);
  assert.ok(pin.production_inspect.note.includes('af52eb51781970da1b36757c9dc4e120d989cf2c96626ac8d93159486dba0552'));
  assert.ok(pin.production_inspect.note.includes(`migration source sha256 on the runner ${pin.source_sha256} == source_sha256`));
  assert.match(pin.production_inspect.note, /aws_public_payee_record\(text, text, jsonb\) different, function_acl checksops EXECUTE, owner EXECUTE; definer_writes external_payment_recipients ok true, payment_provider_methods ok true/);
  assert.match(pin.production_inspect.note, /predecessors \{"sql113": true\}, predecessors_applied true/);
  assert.match(pin.production_inspect.note, /If already_applied is true, or precondition_failures is not \[\], stop/);
  assert.ok(pin.production_inspect.note.includes(' Earlier: Pending: no read-only production inspect has been run for SQL 138 yet.'));
  for (const word of ['prerequisites_missing', 'predecessors', 'definer_can_write_relations', 'functions_owned_by_login', 'function_results_match', 'function_acl_replaceable']) {
    assert.match(pin.production_inspect.note, new RegExp(word), word);
  }
  assert.deepEqual([pin.staging_acceptance.ok, pin.staging_acceptance.reference], [true, STAGING_ACCEPTANCE_REF]);
  assert.match(pin.staging_acceptance.basis, /^Guarded staging SQL executor apply of sql138-payee-setup-link-closed-after-verification, run 41260586254/);
  assert.match(pin.staging_acceptance.basis, /deploy run 41260150790/);
  assert.match(pin.staging_acceptance.basis, /Read-live run 41260787304 then reported already_applied true/);
  assert.match(pin.staging_acceptance.basis, /"accept SQL 138 staging on the tests"/);
  assert.ok(pin.staging_acceptance.basis.includes(`before ${PRODUCTION_PRE}, after ${pin.intended_replacement_sha256} == intended`));
  assert.deepEqual(Object.keys(pin.staging_acceptance).sort(), ['basis', 'ok', 'reference']);
  // The staging pin recorded the same pre-state (wave 33): the function as SQL 113 left it in both environments.
  assert.equal(staging.expected_live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.expected_live_definition_sha256, staging.expected_live_definition_sha256);
  assert.equal(pin.filename, SQL138_FILE);
  assert.equal(pin.source_sha256, staging.source_sha256);
  assert.equal(pin.staging_pin_commit, staging.commit);
  assert.equal(pin.intended_replacement_sha256, staging.intended_replacement_sha256);
  assert.equal(pin.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(pin.intended_replacement_sha256, releaseIntendedHash(KEY, fs.readFileSync(path.join(ROOT, SQL138_FILE), 'utf8')));
  assert.deepEqual(pin.function_identities, RELEASE_SQL_SPECS[KEY].functions.map((fn) => fn.identity));
  assert.deepEqual(pin.function_identities, [IDENTITY]);
  assert.deepEqual(pin.function_identities, [...staging.function_identities]);
  assert.deepEqual(pin.predecessors, ['sql113']);
  assert.deepEqual(pin.predecessors, RELEASE_SQL_SPECS[KEY].predecessors);
  assert.equal(pin.authorization_phrase, 'APPLY_PAYEE_SETUP_LINK_CLOSED_AFTER_VERIFICATION');
  for (const k of ['admin_login', 'rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(pin[k], SQL96_PIN[k], k);
  assert.equal(pin.tooling.status, 'built');
  assert.equal(pin.tooling.production_tool, RELEASE_PRODUCTION[KEY].cli);
  assert.equal(pin.tooling.production_tool, 'scripts/deployment-guard/sql138-payee-setup-link-closed-after-verification-production-apply.mjs');
  assert.equal(pin.tooling.staging_workflow_choice, RELEASE_SQL_SPECS[KEY].choice);
  assert.equal(pin.tooling.one_shot_migration, KEY);
  assert.equal(pin.tooling.runbook, 'ops/production-sql-138-apply.md');
  for (const file of [pin.tooling.production_tool, pin.tooling.runbook, pin.tooling.fingerprint_engine, pin.tooling.production_lib, ...pin.tooling.tests]) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), file);
  }
  assert.equal(readPinnedReleaseSql(KEY, ROOT, pin).ok, true);
  // One-shot: the release tool (no hash in the registry).
  const tool = ONE_SHOT_TOOLS[KEY];
  assert.equal(tool.key, KEY);
  assert.equal(tool.script, RELEASE_PRODUCTION[KEY].cli);
  assert.deepEqual([...tool.args], []);
  assert.equal(tool.pin_rel, RELEASE_PRODUCTION[KEY].pin_rel);
  assert.equal(tool.allowed_key, 'sql138_production_apply_allowed');
  assert.equal(tool.runs_before, undefined);
  assert.equal(RELEASE_SQL_SPECS[KEY].runs_before, undefined);
  assert.equal(tool.inspect_requires, undefined);
  assert.doesNotMatch(JSON.stringify(tool), /[0-9a-f]{64}/);
  const rows = JSON.stringify(readJson('ops/deployment-guard/bypass-inventory.json'));
  assert.match(rows, /"path":"scripts\/deployment-guard\/sql138-payee-setup-link-closed-after-verification-production-apply\.mjs","classification":"GUARDED","capabilities":\["sql138-production-apply"\]/);
  assert.match(rows, /sql134, sql135, sql136, sql137, sql138, sql139\)/);
  const scripts = readJson('package.json').scripts;
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/deployment-guard.yml'), 'utf8');
  for (const name of ['aws/tests/release-sql138-executor.test.mjs', 'aws/tests/release-sql138-production-apply.test.mjs', 'aws/tests/sql138-payee-setup-link-closed-pg.test.mjs']) {
    assert.ok(scripts['test:deployment-guard'].includes(name), name);
    assert.ok(workflow.includes(name), name);
  }
});

test('order: predecessor and supersedes SQL 113 (untouched); the one replaced function, its prerequisites and definer writes; REVOKE, GRANT and COMMENT, nothing else; no plan entry; the API path and its order; the runbook, one-shot doc and README name it', () => {
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.predecessors, ['sql113']);
  assert.deepEqual(spec.supersedes, ['sql113']);
  assert.deepEqual(spec.functions, [{ identity: IDENTITY, acl: ['checksops EXECUTE', 'owner EXECUTE'] }]);
  // SQL 113's spec carries the same identity and ACL: the replacement keeps them.
  assert.deepEqual(RELEASE_SQL_SPECS.sql113.functions.find((fn) => fn.identity === IDENTITY), spec.functions[0]);
  assert.equal(spec.dropped_functions, undefined);
  assert.equal(spec.acl_functions, undefined);
  assert.deepEqual(spec.prerequisites.slice(0, 5), ['public.external_payment_recipients', 'public.payment_provider_methods', IDENTITY, 'public.aws_public_payee_by_token(text)', 'role checksops']);
  for (const column of ['verified_at', 'secure_token', 'setup_attempts', 'disconnected_at', 'token_expires_at']) {
    assert.ok(spec.prerequisites.includes(`column public.external_payment_recipients.${column}`), column);
  }
  assert.deepEqual(spec.definer_writes, ['public.external_payment_recipients', 'public.payment_provider_methods']);
  for (const absent of ['tables', 'views', 'policies', 'triggers', 'altered_relations', 'table_privileges', 'column_acl', 'added_columns']) assert.equal(spec[absent], undefined, absent);
  assert.match(COMMITTED.order_note, /^Predecessor and supersedes SQL 113 \(applied to production on 2026-10-23, pin retired\)/);
  assert.match(COMMITTED.order_note, /definer_can_write_relations/);
  assert.match(COMMITTED.order_note, /No API, Lambda or SPA change is part of this pin\./);
  assert.match(COMMITTED.order_note, /disableBank/);
  // SQL 113's production pin is as applied and retired; this change does not touch it.
  const sql113 = loadReleaseProductionPin('sql113', ROOT);
  assert.equal(sql113.execute, false);
  assert.equal(sql113.applied.result, 'applied');
  // No API change waits on this pin: the overlay plan has no SQL 138 prerequisite.
  const plan = readJson('ops/deployment-guard/production-api-overlay-plan.json');
  assert.equal(plan.sql_prerequisites?.[SQL138_FILE], undefined);
  assert.doesNotMatch(JSON.stringify(plan), /138_payee_setup_link_closed_after_verification/);

  // The API reaches the function only through PAYEE_RECORD_SQL, maps a refusal it does not know to a
  // 400 (never a 500), and calls the provider's disableBank only after the record step succeeded.
  const api = fs.readFileSync(path.join(ROOT, HANDLERS), 'utf8');
  assert.ok(api.includes("export const PAYEE_RECORD_SQL = 'SELECT public.aws_public_payee_record($1, $2, $3::jsonb) AS result';"));
  assert.equal([...api.matchAll(/aws_public_payee_record\(/g)].length, 1);
  assert.match(api, /const \[status, error, message\] = LINK_ERRORS\[code\] \|\| \[400, 'setup_step_refused', 'This step could not be saved\.'\];/);
  assert.doesNotMatch(api.slice(api.indexOf('const LINK_ERRORS'), api.indexOf('const linkError')), /already_verified/, 'already_verified is not a terminal link error');
  const bankAdd = api.slice(api.indexOf('async function publicBankAdd'), api.indexOf('async function publicBankVerify'));
  const providerCreate = bankAdd.indexOf('await addPayeeBank(');
  const recordCall = bankAdd.indexOf("await record(client, token, 'bank_linked'");
  const refusal = bankAdd.indexOf('if (!next || next.error) return linkError(next?.error);');
  const disable = bankAdd.indexOf('await disableBank(');
  assert.ok(providerCreate > 0 && recordCall > providerCreate, 'the provider bank create runs before the record (the residue the runbook names)');
  assert.ok(refusal > recordCall && disable > refusal, 'disableBank of the previous bank runs only after the record succeeded');
  assert.doesNotMatch(api, /UPDATE public\.payment_provider_methods|INSERT INTO public\.payment_provider_methods/);

  // One DO block, one CREATE OR REPLACE FUNCTION, the REVOKE from PUBLIC, the GRANT to checksops and the COMMENT on it.
  const text = fs.readFileSync(path.join(ROOT, SQL138_FILE), 'utf8').replace(/--[^\n]*/g, '');
  assert.doesNotMatch(text, /\bCREATE\s+(OR\s+REPLACE\s+)?(TRIGGER|VIEW|TABLE|POLICY)\b/i);
  assert.doesNotMatch(text, /\b(DROP|ALTER)\b/);
  assert.equal([...text.matchAll(/\bCREATE\s+OR\s+REPLACE\s+FUNCTION\b/gi)].length, 1);
  assert.equal([...text.matchAll(/\bDO\s+\$/g)].length, 1);
  assert.deepEqual([...text.matchAll(/^\s*(GRANT|REVOKE|COMMENT)\b.*$/gim)].map((m) => m[0].trim()), [
    `REVOKE ALL ON FUNCTION ${IDENTITY} FROM PUBLIC;`,
    `GRANT EXECUTE ON FUNCTION ${IDENTITY} TO checksops;`,
    `COMMENT ON FUNCTION ${IDENTITY} IS`,
  ]);
  assert.match(text, /IF rec\.verified_at IS NOT NULL THEN RETURN jsonb_build_object\('error', 'already_verified'\); END IF;/);
  const runbook = fs.readFileSync(path.join(ROOT, COMMITTED.tooling.runbook), 'utf8');
  assert.ok(runbook.includes(COMMITTED.intended_replacement_sha256));
  assert.ok(runbook.includes(COMMITTED.source_sha256));
  assert.match(runbook, /\*\*Status:\*\* applied to staging \(wave 33\) and to production \(2026-11-01\); the production pin is retired/);
  assert.match(runbook, /\*\*Production apply \(2026-11-01\)\.\*\*/);
  for (const evidence of [SQL138_APPLIED.ssm, SQL138_APPLIED.run, SQL138_APPLIED.workstream, PRE_INSPECT_SSM, '41305933006', `"${SQL138_APPLIED.approval}"`, '"record SQL 138"']) {
    assert.ok(runbook.includes(evidence), evidence);
  }
  assert.match(runbook, /SSM\s+`0cbe4c6b-5765-4f37-a543-1849ebcfe584`/);
  assert.match(runbook, /"accept SQL 138 staging on the tests"/);
  assert.match(runbook, /\*\*Staging apply \(2026-11-01\)\.\*\* Apply run 41260586254/);
  assert.match(runbook, /Read-live run 41260787304/);
  assert.match(runbook, /read-live \(2026-10-31\)\.\*\* Run 41239902526/);
  assert.ok(runbook.includes('ec36c29e3472a9777b4a1d08ff7c3da5c00b1dc70cb4b754ef5b04ff0e73633c'));
  assert.match(runbook, /\*\*Predecessor\.\*\* SQL 113/);
  assert.match(runbook, /"Okay, let's do option A and fix it correctly for SQL 138"/);
  assert.match(runbook, /APPLY_PAYEE_SETUP_LINK_CLOSED_AFTER_VERIFICATION/);
  assert.match(runbook, /\*\*Known API residue \(outside this file\)\.\*\*/);
  const oneShot = fs.readFileSync(path.join(ROOT, 'ops/production-sql-one-shot.md'), 'utf8');
  assert.match(oneShot, /\| `sql138` \|/);
  assert.match(oneShot, /`sql134`, `sql135`, `sql136`, `sql137`, `sql138`, `sql139`\) \|/);
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/README.md'), 'utf8'), /sql138-payee-setup-link-closed-after-verification-production-apply\.mjs --inspect/);
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

  // The committed (authorized) pin allows only the manifest bound to its recorded pre-state: not
  // another hash, not the intended state.
  // The committed pin is retired (execute false): an execute-authorized copy of it, before the
  // record-and-retire change, allows only the manifest bound to its recorded pre-state.
  const AUTHORIZED = Object.freeze({ ...COMMITTED, execute: true, authorization: 'Owner approved 2026-11-01 (test copy of the execute-authorized pin before its record-and-retire change)' });
  const committedOk = await evaluateReleaseProductionApply(KEY, manifest(AUTHORIZED), { root: ROOT, pin: AUTHORIZED });
  assert.equal(committedOk.ok, true, JSON.stringify(committedOk));
  assert.equal(committedOk.details.sql138_production_apply_allowed, true);
  assert.equal(committedOk.details.staging_acceptance, STAGING_ACCEPTANCE_REF);
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(AUTHORIZED), live_definition_sha256: PRE, expected_live_definition_sha256: PRE }, { root: ROOT, pin: AUTHORIZED })).code, CODES.SQL_COLLISION);
  const onIntended = COMMITTED.intended_replacement_sha256;
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(AUTHORIZED), live_definition_sha256: onIntended, expected_live_definition_sha256: onIntended }, { root: ROOT, pin: AUTHORIZED })).ok, false);
  // The retired committed pin refuses before connecting.
  assert.equal((await executeReleaseProductionApply(KEY, manifest(COMMITTED), { root: ROOT, connect: neverConnect, consumedPath: consumedPath() })).ok, false);

  const pin = approved();
  const allowed = await evaluateReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(allowed.details.sql138_production_apply_allowed, true);
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect: neverConnect, consumedPath: consumedPath() })).ok, true);
  const otherLive = { ...manifest(pin), expected_live_definition_sha256: 'f'.repeat(64), live_definition_sha256: 'f'.repeat(64) };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherLive, { root: ROOT, pin })).code, CODES.SQL_COLLISION);
  const otherStaging = { ...manifest(pin), staging_acceptance: { ok: true, reference: 'https://example.invalid/x' } };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherStaging, { root: ROOT, pin })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await precheckReleaseProductionApply(KEY, { ...manifest(pin), authorization_phrase: 'APPLY_PAYEE_SETUP' }, { root: ROOT, pin, consumedPath: consumedPath() })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const off = approved({ execute: false });
  const ctx = { root: ROOT, pin: off, connect: neverConnect, consumedPath: consumedPath() };
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  assert.equal((await executeReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  // A tampered file hash is a reconciliation stop.
  assert.equal(readPinnedReleaseSql(KEY, ROOT, { ...COMMITTED, source_sha256: 'f'.repeat(64) }).code, CODES.SQL_COLLISION);

  // CLI: --apply with the committed pin, read from disk, and a manifest on another pre-state refuses without connecting
  // or spending a receipt; credential flags are refused.
  const file = path.join(os.tmpdir(), `sql138-cli-${process.pid}.json`);
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
