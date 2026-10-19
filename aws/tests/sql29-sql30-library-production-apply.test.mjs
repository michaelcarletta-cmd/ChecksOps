/**
 * Production apply tools for SQL 29 and SQL 30
 * (scripts/deployment-guard/sql29-mortgage-ops-library-parity-production-apply.mjs,
 * scripts/deployment-guard/sql30-tenant-documents-doc-type-production-apply.mjs; lib
 * sql29-sql30-library-production-apply.mjs), mirroring the SQL 88/89 tool tests:
 *
 *   - SQL 29's committed pin records the production pre-state of the read-only inspect of
 *     2026-10-19, the owner-accepted substitute staging evidence and the production apply of
 *     2026-10-19 in applied; it is retired (execute false, authorization "Applied to
 *     production …") and refuses before connecting, also with execute flipped and with the
 *     spent one_use_id; the execute-authorized state it had before the apply (unlocked29()
 *     copy) allows only the manifest bound to it; SQL 30's committed pin likewise records the
 *     production pre-state of the read-only inspect of 2026-10-19 after SQL 29, the
 *     owner-accepted substitute staging evidence and the production apply of 2026-10-19 in
 *     applied; it is retired (execute false, authorization "Applied to production …") and
 *     refuses before connecting, also with execute flipped and with the spent one_use_id; the
 *     execute-authorized state it had before the apply (unlocked30() copy) allows only the
 *     manifest bound to it; the locked-state refusals run on explicit pending copies of both;
 *     both are bound to the staging pins and the production RDS;
 *   - evaluate / precheck / apply refuse before connecting (no pre-state, no approval, the
 *     staging acceptance, execute false, the phrase, the single-use id, replay, binding);
 *   - the CLI refuses credential flags and arbitrary SQL, and never spends a receipt or
 *     connects on a refusal; a staging receipt cannot authorize production;
 *   - on PostgreSQL 16: --inspect is BEGIN READ ONLY ... ROLLBACK, reads only aggregate
 *     counts of table rows and changes nothing; an execute-authorized copy applies once as
 *     checksops_admin; the superuser login is refused.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import { acquireLease } from '../../scripts/deployment-guard/lib/lease.mjs';
import { issueReceipt } from '../../scripts/deployment-guard/lib/receipt.mjs';
import { refuseUnguardedDeploy } from '../../scripts/deployment-guard/require-guard.mjs';
import { LIBRARY_SQL_PINS } from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import {
  LIBRARY_PRODUCTION,
  evaluateLibraryProductionApply,
  executeLibraryProductionApply,
  inspectLibraryProduction,
  loadLibraryProductionPin,
  precheckLibraryProductionApply,
  readPinnedLibrarySql,
} from '../../scripts/deployment-guard/lib/sql29-sql30-library-production-apply.mjs';
import { main as main29 } from '../../scripts/deployment-guard/sql29-mortgage-ops-library-parity-production-apply.mjs';
import { main as main30 } from '../../scripts/deployment-guard/sql30-tenant-documents-doc-type-production-apply.mjs';
import { libraryFixture, pgSkipReason } from './helpers/library-sql-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEYS = Object.freeze(['sql29', 'sql30']);
const MAINS = Object.freeze({ sql29: main29, sql30: main30 });
const CLIS = Object.freeze({
  sql29: path.join(ROOT, 'scripts/deployment-guard/sql29-mortgage-ops-library-parity-production-apply.mjs'),
  sql30: path.join(ROOT, 'scripts/deployment-guard/sql30-tenant-documents-doc-type-production-apply.mjs'),
});
const COMMITTED = Object.freeze({ sql29: loadLibraryProductionPin('sql29', ROOT), sql30: loadLibraryProductionPin('sql30', ROOT) });
// SQL 29's production read-only inspect of 2026-10-19, after SQL 103 (SSM 45639f6b-68cf-4502-a127-458d99865ae8, main dbaa93c90).
const SQL29_PRODUCTION_PRE = 'd8247ab9a31a7c1c57a464a768a650397059e67519f9e1522f881293e28e0079';
// SQL 29's owner-accepted substitute staging evidence: the guarded staging read-live (SQL 90 on top in staging).
const SQL29_STAGING_ACCEPTANCE_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/39188780526';
// SQL 29's production apply of 2026-10-19 recorded in applied (its one_use_id is spent).
const SQL29_APPLIED = Object.freeze({
  apply_ssm_command_id: '64604f67-e7f0-4152-a9a8-208543d41937',
  one_shot_run_id: '6f2461fa-dfa2-4e63-abad-00409f1facd3',
  later_inspect_ssm_command_id: 'f8fc5eca-5c56-46eb-a7fa-f1e893dd3d9b',
  one_use_id: 'sql29-prod-238d917c-fdc1-4f3b-8909-a89cf8d74e8f',
  workstream_id: 'prod-sql29-mortgage-ops-library-parity-20261019',
  source_commit: 'c765e926bac217cdbd7bf84535fc1def6498c686',
  tarball_sha256: '69070d7b795b46b307e93a3842edbffa38a86668baf4eda5e1915f378af6d76b',
  manifest_sha256: 'fa284e7bb5131b5a5a6d424e640e7888178b3dd91f7e397a7cf8170e9dab51f5',
  unrelated_catalog_sha256: 'dcfbdb2aec3fa8372e52a7ca680e87cb6a460d170f9955e2cc451e8ee2fbc2d1',
});
// SQL 30's production read-only inspect of 2026-10-19, after SQL 29 (SSM f8fc5eca-5c56-46eb-a7fa-f1e893dd3d9b, main c765e926b).
const SQL30_PRODUCTION_PRE = '37f22340383b1a5e1b1350fc602b2953c2bb72d32234456888616fd749cbf504';
// SQL 30's owner-accepted substitute staging evidence: the same guarded staging read-live (SQL 94 on top in staging).
const SQL30_STAGING_ACCEPTANCE_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/39188780526';
// SQL 30's production apply of 2026-10-19 recorded in applied (its one_use_id is spent; no later inspect was run).
const SQL30_APPLIED = Object.freeze({
  apply_ssm_command_id: '84f9be05-e363-4f08-900a-c13abacda916',
  one_shot_run_id: 'ad8ea42e-18d8-4c23-a892-998c7330bf81',
  one_use_id: 'sql30-prod-f8b43a96-8a7a-418f-aaae-caf95176b964',
  workstream_id: 'prod-sql30-tenant-documents-doc-type-20261019',
  source_commit: 'c0fe074fcf7fa92b32e595b62604ffb601011d08',
  tarball_sha256: '6ef5ee5d67c4136ed1927422129a394b433fe10cbac14ee95170f75a058f45c1',
  manifest_sha256: '6915157c79e8d95416200a87f4310b73be118bda78c1b64d00f5a0353704b22d',
  unrelated_catalog_sha256: '108eb9d146d17c99c0f8be8f20e5e68649b4fa60007af4ba1ec158889141c610',
});
/** SQL 29's execute-authorized state before the apply (PR #1049), as an explicit copy of the retired pin. */
const SQL29_UNLOCKED_AUTHORIZATION = 'Owner approved 2026-10-19 (test copy of the execute-authorized pin before its record-and-retire change)';
const unlocked29 = (extra = {}) => Object.freeze({ ...COMMITTED.sql29, authorization: SQL29_UNLOCKED_AUTHORIZATION, execute: true, ...extra });
/** SQL 30's execute-authorized state before the apply, as an explicit copy of the retired pin. */
const SQL30_UNLOCKED_AUTHORIZATION = 'Owner approved 2026-10-19 (test copy of the execute-authorized pin before its record-and-retire change)';
const unlocked30 = (extra = {}) => Object.freeze({ ...COMMITTED.sql30, authorization: SQL30_UNLOCKED_AUTHORIZATION, execute: true, ...extra });
/** The pre-authorization state of a committed pin (explicit copy). */
const pendingCopy = (pin) => Object.freeze({
  ...pin,
  authorization: 'pending',
  execute: false,
  expected_live_definition_sha256: null,
  staging_acceptance: { ok: false, reference: null, basis: 'Pending' },
});
const PENDING = Object.freeze({ sql29: pendingCopy(COMMITTED.sql29), sql30: pendingCopy(COMMITTED.sql30) });
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const COMMIT = 'a'.repeat(40);
const PRE = 'e'.repeat(64);
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK|BEGIN READ ONLY)\b/i;

/** An execute-authorized copy with a recorded pre-state and staging acceptance (test only). */
const authorized = (key, live = PRE, extra = {}) => Object.freeze({
  ...COMMITTED[key],
  authorization: 'Owner approved test fixture',
  execute: true,
  expected_live_definition_sha256: live,
  staging_acceptance: { ok: true, reference: STAGING_REF, basis: 'test fixture' },
  ...extra,
});

function manifest(key, pin, overrides = {}) {
  const live = pin.expected_live_definition_sha256;
  const fingerprint = { sql: live };
  const workstream = `prod-${key}-library-test`;
  return {
    workstream_id: workstream,
    branch: 'main',
    commit: COMMIT,
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
    one_use_id: `${key}-prod-${process.pid}-${Math.random().toString(16).slice(2)}`,
    build_timestamp: '2026-10-16T20:00:00.000Z',
    ...overrides,
  };
}
const consumedPath = () => path.join(os.tmpdir(), `sql2930-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
const neverConnect = async () => { throw new Error('should-not-connect'); };

async function runCli(key, argv, { env = { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' }, input, deps = {} } = {}) {
  let file = null;
  if (input) {
    file = path.join(os.tmpdir(), `sql2930-prod-input-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
    fs.writeFileSync(file, JSON.stringify(input));
  }
  const writes = [];
  let spent = 0;
  const orig = { out: process.stdout.write, err: process.stderr.write };
  process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
  try {
    await MAINS[key](file ? [...argv, '--input', file] : argv, env, {
      root: ROOT,
      consumeReceiptOnce: () => { spent += 1; return { ok: true }; },
      connect: neverConnect,
      consumedPath: consumedPath(),
      ...deps,
    });
  } finally {
    process.stdout.write = orig.out;
    process.stderr.write = orig.err;
    if (file) fs.rmSync(file, { force: true });
  }
  return { out: writes.join(''), spent };
}

test('committed pins: SQL 29 and SQL 30 applied and retired; both bound to the staging pins and the production RDS', () => {
  for (const key of KEYS) {
    const pin = COMMITTED[key];
    const staging = LIBRARY_SQL_PINS[key];
    assert.equal(pin.migration, key);
    if (key === 'sql30') {
      // Retired after the 2026-10-19 apply: execute false, the authorization no longer an owner approval.
      assert.equal(pin.execute, false);
      assert.match(pin.authorization, /^Applied to production on 2026-10-19; execute is false again/);
      assert.doesNotMatch(pin.authorization, /^Owner approved/);
      assert.ok(pin.authorization.includes('"accept that evidence for SQL 30"'));
      assert.ok(pin.authorization.includes('(37f22340 -> e573962e)'));
      assert.ok(pin.authorization.includes(`workstream ${SQL30_APPLIED.workstream_id}`));
      // The owner's exact words (with their double space).
      assert.ok(pin.authorization.includes('"approve #1053 then  SQL 30 in production"'));
      assert.match(pin.authorization, /That approval covered that run only$/);
      assert.equal(pin.expected_live_definition_sha256, SQL30_PRODUCTION_PRE);
      // The production apply of 2026-10-19 (guarded production SQL one-shot).
      const applied = pin.applied;
      assert.equal(applied.date, '2026-10-19');
      assert.equal(applied.result, 'applied');
      assert.equal(applied.runner, 'i-0c35557c4e5385406');
      assert.equal(applied.apply_ssm_command_id, SQL30_APPLIED.apply_ssm_command_id);
      assert.equal(applied.one_shot_run_id, SQL30_APPLIED.one_shot_run_id);
      assert.equal(applied.source_commit, SQL30_APPLIED.source_commit);
      assert.deepEqual(applied.source_tarball, { file: `source-${SQL30_APPLIED.source_commit}.tar.gz`, sha256: SQL30_APPLIED.tarball_sha256 });
      assert.equal(applied.migration_source_sha256, pin.source_sha256);
      assert.equal(applied.workstream_id, SQL30_APPLIED.workstream_id);
      assert.equal(applied.operator, 'michaelcarletta-cmd');
      assert.equal(applied.owner_approval, 'approve #1053 then  SQL 30 in production');
      assert.equal(applied.one_use_id, SQL30_APPLIED.one_use_id);
      assert.equal(applied.one_use_id_consumed, true);
      assert.equal(applied.manifest_sha256, SQL30_APPLIED.manifest_sha256);
      assert.deepEqual(applied.steps, ['pin', 'source', 'inspect', 'contracts', 'manifest', 'source-recheck-before-preflight', 'preflight', 'evaluate', 'source-recheck-before-apply', 'apply', 'post-apply-inspect']);
      assert.deepEqual(Object.fromEntries(Object.entries(applied.contract_results).map(([id, r]) => [id, [r.ok, r.passed]])), {
        'claim-ledger': [true, '4/4'],
        'tenant-isolation': [true, '6/6'],
        'financial-write-protections': [true, '43/43'],
      });
      assert.equal(applied.pre_apply_inspect.read_only, true);
      assert.equal(applied.pre_apply_inspect.live_definition_sha256, SQL30_PRODUCTION_PRE);
      assert.equal(applied.pre_apply_inspect.live_matches_expected, true);
      assert.equal(applied.pre_apply_inspect.already_applied, false);
      assert.deepEqual(applied.pre_apply_inspect.precondition_failures, []);
      assert.equal(applied.pre_apply_inspect.sql90_applied, false);
      assert.equal(applied.receipt.result, 'applied');
      assert.equal(applied.receipt.migration, 'sql30');
      assert.equal(applied.receipt.workstream, SQL30_APPLIED.workstream_id);
      assert.equal(applied.receipt.commit, SQL30_APPLIED.source_commit);
      assert.equal(applied.receipt.sql_file, pin.filename);
      assert.equal(applied.receipt.before_hash, SQL30_PRODUCTION_PRE);
      assert.equal(applied.receipt.after_hash, pin.intended_replacement_sha256);
      assert.equal(applied.receipt.unrelated_catalog_sha256, SQL30_APPLIED.unrelated_catalog_sha256);
      assert.deepEqual(applied.receipt.unrelated_catalog_counts, { relations: 861, columns: 3409, constraints: 2124, policies: 368, functions: 1282, triggers: 173, schema: 2 });
      assert.equal(applied.receipt.staging_acceptance, SQL30_STAGING_ACCEPTANCE_REF);
      assert.equal(applied.post_apply_inspect.read_only, true);
      assert.equal(applied.post_apply_inspect.already_applied, true);
      assert.equal(applied.post_apply_inspect.live_definition_sha256, pin.intended_replacement_sha256);
      // Expected after the apply: the live CHECK is SQL 30's own, no longer a supported predecessor (a re-apply would refuse).
      assert.deepEqual(applied.post_apply_inspect.precondition_failures, ['check_is_supported_predecessor']);
      assert.equal(applied.post_apply_inspect.sql90_applied, false);
      // No later read-only inspect was run after SQL 30's apply.
      assert.equal(applied.later_inspect, undefined);
      assert.match(pin.production_evidence['2026-10-19 apply'], /execute is false/);
      assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
      assert.equal(pin.intended_replacement_sha256, 'e573962eb3d7a427d6b4a2fe1fc48fa3c49f4ad22c6ae66372fb236017ca2556');
      assert.equal(pin.authorization_phrase, 'APPLY_TENANT_DOCUMENTS_MORTGAGE_DOC_TYPE_CHECK');
      const inspect = pin.production_inspect;
      assert.equal(inspect.status, 'recorded');
      assert.equal(inspect.date, '2026-10-19');
      assert.equal(inspect.ssm_command_id, 'f8fc5eca-5c56-46eb-a7fa-f1e893dd3d9b');
      assert.equal(inspect.source_commit, 'c765e926bac217cdbd7bf84535fc1def6498c686');
      assert.equal(inspect.source_tarball_sha256, '69070d7b795b46b307e93a3842edbffa38a86668baf4eda5e1915f378af6d76b');
      assert.equal(inspect.runner, 'i-0c35557c4e5385406');
      assert.equal(inspect.read_only, true);
      assert.equal(inspect.connected_as, 'checksops_admin');
      assert.equal(inspect.live_definition_sha256, SQL30_PRODUCTION_PRE);
      assert.deepEqual(inspect.sql30, {
        live_definition_sha256: SQL30_PRODUCTION_PRE,
        table_present: true,
        doc_type: 'text/NO',
        check_shape: 'predecessor_6',
        check_validated: true,
        check_value_count: 6,
        check_definition_sha256: '24faa402b16ace084d16a69c19266fd89002b50cb84d1c1b515159048b76125c',
      });
      assert.equal(inspect.already_applied, false);
      assert.equal(inspect.sql90_applied, false);
      assert.deepEqual(inspect.precondition_failures, []);
      assert.deepEqual(inspect.prerequisites_missing, []);
      assert.equal(inspect.apply_preconditions_met, false, 'no pre-state was recorded at inspect time');
      assert.deepEqual(inspect.counts.tenant_documents_by_category, { legacy: 1, mortgage: 0, template: 0, shingle: 0, siding: 0, catalog: 0, letterhead: 0, library_other: 0, other: 0 });
      assert.deepEqual(inspect.counts.tenant_documents_by_path_form, { aws_library: 0, url: 0, bucket_prefixed: 0, other_tenant_library: 0, other: 1 });
      assert.equal(inspect.counts.rows_outside_sql30_values, 0);
      assert.equal(inspect.counts.shared_with_homeowners_true, 0);
      assert.equal(inspect.counts.mortgage_request_library_documents, 0);
      // SQL 29 was applied before this inspect (informational).
      assert.equal(inspect.sql29_live_definition_sha256, COMMITTED.sql29.intended_replacement_sha256);
      assert.equal(inspect.sql29_already_applied, true);
      // Staging acceptance: the owner-accepted substitute evidence (SQL 94 is on top in staging).
      assert.equal(pin.staging_acceptance.ok, true);
      assert.equal(pin.staging_acceptance.reference, SQL30_STAGING_ACCEPTANCE_REF);
      assert.ok(pin.staging_acceptance.basis.includes('"accept that evidence for SQL 30"'));
      assert.match(pin.staging_acceptance.basis, /read-live of sql29-mortgage-ops-library-parity, run 39188780526 \(executor from main 03e238af\)/);
      assert.match(pin.staging_acceptance.basis, /check_shape sql94 \(validated, check_definition_sha256 4ff37c4f18b5102b9f51f7cc0bb8fbd1e23d69e23926da14e29eeafdb4e69143\)/);
      assert.ok(pin.staging_acceptance.basis.includes('82d768184da8c496fe56731d8557cfc452bea856939f78c80bb2e2383302cd22'));
      assert.match(pin.staging_acceptance.basis, /rows_outside_sql30_values 0, sql90_applied true/);
      for (const file of ['aws/tests/sql29-sql30-library-production-apply.test.mjs', 'aws/tests/tenant-documents-mortgage-doc-type-pg.test.mjs']) {
        assert.ok(pin.staging_acceptance.basis.includes(file), file);
        assert.ok(fs.existsSync(path.join(ROOT, file)), file);
      }
      assert.ok(pin.staging_acceptance.basis.includes(pin.intended_replacement_sha256));
      assert.ok(pin.staging_acceptance.production_differs.includes(SQL30_PRODUCTION_PRE));
    } else {
      // Retired after the 2026-10-19 apply: execute false, the authorization no longer an owner approval.
      assert.equal(pin.execute, false);
      assert.match(pin.authorization, /^Applied to production on 2026-10-19; execute is false again/);
      assert.doesNotMatch(pin.authorization, /^Owner approved/);
      assert.ok(pin.authorization.includes('"accept that evidence for SQL 29"'));
      assert.ok(pin.authorization.includes(`workstream ${SQL29_APPLIED.workstream_id}`));
      assert.ok(pin.authorization.includes('"apply SQL 29 in production"'));
      assert.match(pin.authorization, /That approval covered that run only$/);
      assert.equal(pin.expected_live_definition_sha256, SQL29_PRODUCTION_PRE);
      // The production apply of 2026-10-19 (guarded production SQL one-shot).
      const applied = pin.applied;
      assert.equal(applied.date, '2026-10-19');
      assert.equal(applied.result, 'applied');
      assert.equal(applied.runner, 'i-0c35557c4e5385406');
      assert.equal(applied.apply_ssm_command_id, SQL29_APPLIED.apply_ssm_command_id);
      assert.equal(applied.one_shot_run_id, SQL29_APPLIED.one_shot_run_id);
      assert.equal(applied.source_commit, SQL29_APPLIED.source_commit);
      assert.deepEqual(applied.source_tarball, { file: `source-${SQL29_APPLIED.source_commit}.tar.gz`, sha256: SQL29_APPLIED.tarball_sha256 });
      assert.equal(applied.migration_source_sha256, pin.source_sha256);
      assert.equal(applied.workstream_id, SQL29_APPLIED.workstream_id);
      assert.equal(applied.operator, 'michaelcarletta-cmd');
      assert.equal(applied.owner_approval, 'apply SQL 29 in production');
      assert.equal(applied.one_use_id, SQL29_APPLIED.one_use_id);
      assert.equal(applied.one_use_id_consumed, true);
      assert.equal(applied.manifest_sha256, SQL29_APPLIED.manifest_sha256);
      assert.deepEqual(applied.steps, ['pin', 'source', 'inspect', 'contracts', 'manifest', 'source-recheck-before-preflight', 'preflight', 'evaluate', 'source-recheck-before-apply', 'apply', 'post-apply-inspect']);
      assert.deepEqual(Object.fromEntries(Object.entries(applied.contract_results).map(([id, r]) => [id, [r.ok, r.passed]])), {
        'claim-ledger': [true, '4/4'],
        'tenant-isolation': [true, '6/6'],
        'financial-write-protections': [true, '43/43'],
      });
      assert.equal(applied.pre_apply_inspect.read_only, true);
      assert.equal(applied.pre_apply_inspect.live_definition_sha256, SQL29_PRODUCTION_PRE);
      assert.equal(applied.pre_apply_inspect.live_matches_expected, true);
      assert.deepEqual(applied.pre_apply_inspect.precondition_failures, []);
      assert.equal(applied.pre_apply_inspect.sql90_applied, false);
      assert.equal(applied.receipt.result, 'applied');
      assert.equal(applied.receipt.migration, 'sql29');
      assert.equal(applied.receipt.workstream, SQL29_APPLIED.workstream_id);
      assert.equal(applied.receipt.commit, SQL29_APPLIED.source_commit);
      assert.equal(applied.receipt.sql_file, pin.filename);
      assert.equal(applied.receipt.before_hash, SQL29_PRODUCTION_PRE);
      assert.equal(applied.receipt.after_hash, pin.intended_replacement_sha256);
      assert.equal(applied.receipt.unrelated_catalog_sha256, SQL29_APPLIED.unrelated_catalog_sha256);
      assert.deepEqual(applied.receipt.unrelated_catalog_counts, { relations: 861, columns: 3409, constraints: 2125, policies: 366, functions: 1277, triggers: 173, schema: 2 });
      assert.equal(applied.receipt.staging_acceptance, SQL29_STAGING_ACCEPTANCE_REF);
      assert.equal(applied.post_apply_inspect.read_only, true);
      assert.equal(applied.post_apply_inspect.already_applied, true);
      assert.equal(applied.post_apply_inspect.live_definition_sha256, pin.intended_replacement_sha256);
      assert.deepEqual(applied.post_apply_inspect.precondition_failures, []);
      assert.equal(applied.post_apply_inspect.sql90_applied, false);
      assert.equal(applied.later_inspect.ssm_command_id, SQL29_APPLIED.later_inspect_ssm_command_id);
      assert.equal(applied.later_inspect.read_only, true);
      assert.equal(applied.later_inspect.source_commit, SQL29_APPLIED.source_commit);
      assert.equal(applied.later_inspect.source_tarball_sha256, SQL29_APPLIED.tarball_sha256);
      assert.equal(applied.later_inspect.live_definition_sha256, pin.intended_replacement_sha256);
      assert.equal(applied.later_inspect.already_applied, true);
      assert.match(pin.production_evidence['2026-10-19 apply'], /execute is false/);
      assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
      assert.equal(pin.authorization_phrase, 'APPLY_MORTGAGE_OPS_LIBRARY_PARITY');
      const inspect = pin.production_inspect;
      assert.equal(inspect.status, 'recorded');
      assert.equal(inspect.date, '2026-10-19');
      assert.equal(inspect.ssm_command_id, '45639f6b-68cf-4502-a127-458d99865ae8');
      assert.equal(inspect.source_commit, 'dbaa93c90e1dd4c60b276d1eee2690652352fc97');
      assert.equal(inspect.source_tarball_sha256, '94d7499a9fd3eadb867bd3e89412872e0c6cb8e8cacb3a3fe116f327059ed8e3');
      assert.equal(inspect.runner, 'i-0c35557c4e5385406');
      assert.equal(inspect.read_only, true);
      assert.equal(inspect.connected_as, 'checksops_admin');
      assert.equal(inspect.live_definition_sha256, SQL29_PRODUCTION_PRE);
      assert.equal(inspect.sql29.live_definition_sha256, SQL29_PRODUCTION_PRE);
      assert.equal(inspect.already_applied, false);
      assert.equal(inspect.sql90_applied, false);
      assert.deepEqual(inspect.precondition_failures, []);
      assert.deepEqual(inspect.prerequisites_missing, []);
      assert.equal(inspect.apply_preconditions_met, false, 'no pre-state was recorded at inspect time');
      assert.deepEqual(inspect.counts.tenant_documents_by_category, { legacy: 1, mortgage: 0, template: 0, shingle: 0, siding: 0, catalog: 0, letterhead: 0, library_other: 0, other: 0 });
      assert.deepEqual(inspect.counts.tenant_documents_by_path_form, { aws_library: 0, url: 0, bucket_prefixed: 0, other_tenant_library: 0, other: 1 });
      assert.equal(inspect.counts.rows_outside_sql30_values, 0);
      assert.equal(inspect.counts.shared_with_homeowners_true, 0);
      assert.equal(inspect.counts.mortgage_request_library_documents, 0);
      assert.deepEqual(inspect.sql29.api_functions_acl, ['PUBLIC EXECUTE', 'checksops EXECUTE', 'owner EXECUTE']);
      assert.deepEqual(inspect.sql29.trigger_function_acl, ['owner EXECUTE']);
      assert.equal(inspect.sql30_live_definition_sha256, '37f22340383b1a5e1b1350fc602b2953c2bb72d32234456888616fd749cbf504');
      // Staging acceptance: the owner-accepted substitute evidence (SQL 90 is on top in staging).
      assert.equal(pin.staging_acceptance.ok, true);
      assert.equal(pin.staging_acceptance.reference, SQL29_STAGING_ACCEPTANCE_REF);
      assert.ok(pin.staging_acceptance.basis.includes('"accept that evidence for SQL 29"'));
      assert.match(pin.staging_acceptance.basis, /read-live of sql29-mortgage-ops-library-parity, run 39188780526 \(executor from main 03e238af\)/);
      assert.match(pin.staging_acceptance.basis, /sql90_applied true/);
      assert.ok(pin.staging_acceptance.basis.includes('711fb084edbcb25d18657df0a9dc82923fc8f50697ca7c6669fabe2957e34a7d'));
      assert.ok(pin.staging_acceptance.basis.includes('aws/tests/sql103-share-library-trigger-acl-pg.test.mjs'));
      assert.ok(pin.staging_acceptance.basis.includes(pin.intended_replacement_sha256));
      assert.ok(pin.staging_acceptance.production_differs.includes(SQL29_PRODUCTION_PRE));
    }
    assert.equal(pin.filename, staging.filename);
    assert.equal(pin.migration_id, staging.migration_id);
    assert.equal(pin.source_sha256, staging.source_sha256);
    assert.equal(pin.staging_pin_commit, staging.commit);
    assert.equal(pin.intended_replacement_sha256, staging.intended_replacement_sha256);
    assert.equal(pin.admin_login, 'checksops_admin');
    assert.equal(pin.rds_identifier, 'checksops-production');
    assert.match(pin.admin_secret_arn, /^arn:aws:secretsmanager:us-east-1:806168576068:secret:rds-db-credentials\/checksops-production\/checksops_admin\//);
    assert.equal(LIBRARY_PRODUCTION[key].pin_rel, `ops/deployment-guard/${pin.id}.json`);
    assert.equal(readPinnedLibrarySql(key, ROOT, pin).ok, true);
  }
  const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/bypass-inventory.json'), 'utf8'));
  const rows = JSON.stringify(inventory);
  assert.match(rows, /sql29-mortgage-ops-library-parity-production-apply\.mjs/);
  assert.match(rows, /sql30-tenant-documents-doc-type-production-apply\.mjs/);
});

test('a tampered pin or file is refused', () => {
  for (const key of KEYS) {
    for (const field of ['filename', 'source_sha256', 'intended_replacement_sha256', 'target_environment', 'staging_pin_commit']) {
      const bad = { ...COMMITTED[key], [field]: field === 'target_environment' ? 'staging' : 'x' };
      const result = readPinnedLibrarySql(key, ROOT, bad);
      assert.equal(result.code, CODES.SQL_COLLISION, `${key} ${field}`);
    }
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sql2930-tamper-'));
  try {
    const pin = COMMITTED.sql30;
    fs.mkdirSync(path.join(tmp, path.dirname(pin.filename)), { recursive: true });
    fs.writeFileSync(path.join(tmp, pin.filename), `${fs.readFileSync(path.join(ROOT, pin.filename), 'utf8')}\nSELECT 1;\n`);
    assert.equal(readPinnedLibrarySql('sql30', tmp, pin).code, CODES.SOURCE_RECONCILIATION_REQUIRED);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('evaluate, precheck and apply refuse before connecting', async () => {
  for (const key of KEYS) {
    // The pre-authorization state (explicit copies of both committed pins).
    const committed = await evaluateLibraryProductionApply(key, manifest(key, { ...PENDING[key], expected_live_definition_sha256: PRE }), { root: ROOT, pin: PENDING[key] });
    assert.equal(committed.code, CODES.SQL_COLLISION, key);
    assert.match(committed.message, /no recorded pre-apply live definition hash/);
    const pendingWithPre = { ...PENDING[key], expected_live_definition_sha256: PRE };
    const notApproved = await evaluateLibraryProductionApply(key, manifest(key, pendingWithPre), { root: ROOT, pin: pendingWithPre });
    assert.equal(notApproved.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
    const pin = authorized(key);
    const good = await evaluateLibraryProductionApply(key, manifest(key, pin), { root: ROOT, pin });
    assert.equal(good.ok, true, JSON.stringify(good));
    assert.equal(good.details[LIBRARY_PRODUCTION[key].allowed_key], true);
    const wrongLive = await evaluateLibraryProductionApply(key, manifest(key, pin, { live_definition_sha256: 'f'.repeat(64) }), { root: ROOT, pin });
    assert.equal(wrongLive.code, CODES.SQL_COLLISION);
    const wrongStaging = await evaluateLibraryProductionApply(key, manifest(key, pin, { staging_acceptance: { ok: true, reference: 'https://example.invalid/x' } }), { root: ROOT, pin });
    assert.equal(wrongStaging.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
    const noApproval = await evaluateLibraryProductionApply(key, manifest(key, pin, { approval: null }), { root: ROOT, pin });
    assert.equal(noApproval.ok, false);

    const ctx = { root: ROOT, pin, consumedPath: consumedPath(), connect: neverConnect };
    const executeFalse = await executeLibraryProductionApply(key, manifest(key, pin), { ...ctx, pin: authorized(key, PRE, { execute: false }) });
    assert.equal(executeFalse.code, CODES.GUARD_APPLY_FORBIDDEN);
    const wrongPhrase = await executeLibraryProductionApply(key, manifest(key, pin, { authorization_phrase: 'APPLY' }), ctx);
    assert.equal(wrongPhrase.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
    const noOneUse = await executeLibraryProductionApply(key, manifest(key, pin, { one_use_id: 'x' }), ctx);
    assert.equal(noOneUse.code, CODES.INVALID_MANIFEST);
    const spentPath = consumedPath();
    fs.writeFileSync(spentPath, JSON.stringify({ consumed: ['reused-id-0001'] }));
    const replay = await precheckLibraryProductionApply(key, manifest(key, pin, { one_use_id: 'reused-id-0001' }), { root: ROOT, pin, consumedPath: spentPath });
    assert.equal(replay.code, CODES.RECEIPT_REUSED);
  }
});

test('the committed (retired) SQL 29 pin refuses before connecting, also with the spent one_use_id; flipping execute alone does not revive it', async () => {
  const pin = COMMITTED.sql29;
  for (const opts of [{ root: ROOT }, { root: ROOT, pin }]) {
    const refused = await evaluateLibraryProductionApply('sql29', manifest('sql29', pin), opts);
    assert.equal(refused.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
    assert.match(refused.message, /authorization is not an owner approval/);
    assert.equal((await executeLibraryProductionApply('sql29', manifest('sql29', pin), { ...opts, connect: neverConnect, consumedPath: consumedPath() })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  }
  // execute true on the retired pin is still refused: its authorization records the spent run.
  const flipped = { ...pin, execute: true };
  assert.equal((await evaluateLibraryProductionApply('sql29', manifest('sql29', pin), { root: ROOT, pin: flipped })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await precheckLibraryProductionApply('sql29', manifest('sql29', pin), { root: ROOT, pin: flipped, connect: neverConnect, consumedPath: consumedPath() })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await executeLibraryProductionApply('sql29', manifest('sql29', pin), { root: ROOT, pin: flipped, connect: neverConnect, consumedPath: consumedPath() })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  // An owner approval with execute false (the retired pin's execute) refuses the apply.
  assert.equal((await executeLibraryProductionApply('sql29', manifest('sql29', pin), { root: ROOT, pin: unlocked29({ execute: false }), connect: neverConnect, consumedPath: consumedPath() })).code, CODES.GUARD_APPLY_FORBIDDEN);
  // The spent one_use_id is refused as a replay, even on an execute-authorized copy.
  const spentFile = consumedPath();
  fs.writeFileSync(spentFile, JSON.stringify({ consumed: [SQL29_APPLIED.one_use_id] }));
  try {
    const spent = manifest('sql29', pin, { one_use_id: SQL29_APPLIED.one_use_id });
    assert.equal((await precheckLibraryProductionApply('sql29', spent, { root: ROOT, pin: unlocked29(), connect: neverConnect, consumedPath: spentFile })).code, CODES.RECEIPT_REUSED);
    assert.equal((await executeLibraryProductionApply('sql29', spent, { root: ROOT, pin: unlocked29(), connect: neverConnect, consumedPath: spentFile })).code, CODES.RECEIPT_REUSED);
    assert.equal((await executeLibraryProductionApply('sql29', spent, { root: ROOT, connect: neverConnect, consumedPath: spentFile })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  } finally {
    fs.rmSync(spentFile, { force: true });
  }
  // CLI: --apply with the committed (retired) pin, read from disk, refuses without connecting or
  // calling the guard (no receipt spent).
  const cli = await runCli('sql29', ['--apply'], { input: manifest('sql29', pin), deps: { enforceScriptGuard: () => { throw new Error('guard-called'); } } });
  assert.equal(cli.spent, 0);
  assert.match(cli.out, /PRODUCTION_APPROVAL_REQUIRED/);
  assert.doesNotMatch(cli.out, /guard-called|should-not-connect/);
});

test('SQL 29\'s execute-authorized copy (before the record-and-retire change) allows only the manifest bound to it; the cheap prechecks pass without connecting', async () => {
  const pin = unlocked29();
  const allowed = await evaluateLibraryProductionApply('sql29', manifest('sql29', pin), { root: ROOT, pin });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(allowed.details.sql29_production_apply_allowed, true);
  assert.equal(allowed.details.expected_live_definition_sha256, SQL29_PRODUCTION_PRE);
  assert.equal(allowed.details.staging_acceptance, SQL29_STAGING_ACCEPTANCE_REF);
  const prechecked = await precheckLibraryProductionApply('sql29', manifest('sql29', pin), { root: ROOT, pin, consumedPath: consumedPath() });
  assert.equal(prechecked.ok, true, JSON.stringify(prechecked));
  const wrongLive = await evaluateLibraryProductionApply('sql29', manifest('sql29', pin, { live_definition_sha256: 'f'.repeat(64) }), { root: ROOT, pin });
  assert.equal(wrongLive.code, CODES.SQL_COLLISION);
  const wrongStaging = await evaluateLibraryProductionApply('sql29', manifest('sql29', pin, { staging_acceptance: { ok: true, reference: 'https://example.invalid/x' } }), { root: ROOT, pin });
  assert.equal(wrongStaging.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const executeFalse = await executeLibraryProductionApply('sql29', manifest('sql29', pin), { root: ROOT, pin: { ...pin, execute: false }, consumedPath: consumedPath(), connect: neverConnect });
  assert.equal(executeFalse.code, CODES.GUARD_APPLY_FORBIDDEN);
  const wrongPhrase = await executeLibraryProductionApply('sql29', manifest('sql29', pin, { authorization_phrase: 'APPLY' }), { root: ROOT, pin, consumedPath: consumedPath(), connect: neverConnect });
  assert.equal(wrongPhrase.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
});

test('the committed (retired) SQL 30 pin refuses before connecting, also with the spent one_use_id; flipping execute alone does not revive it', async () => {
  const pin = COMMITTED.sql30;
  for (const opts of [{ root: ROOT }, { root: ROOT, pin }]) {
    const refused = await evaluateLibraryProductionApply('sql30', manifest('sql30', pin), opts);
    assert.equal(refused.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
    assert.match(refused.message, /authorization is not an owner approval/);
    assert.equal((await executeLibraryProductionApply('sql30', manifest('sql30', pin), { ...opts, connect: neverConnect, consumedPath: consumedPath() })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  }
  // execute true on the retired pin is still refused: its authorization records the spent run.
  const flipped = { ...pin, execute: true };
  assert.equal((await evaluateLibraryProductionApply('sql30', manifest('sql30', pin), { root: ROOT, pin: flipped })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await precheckLibraryProductionApply('sql30', manifest('sql30', pin), { root: ROOT, pin: flipped, connect: neverConnect, consumedPath: consumedPath() })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await executeLibraryProductionApply('sql30', manifest('sql30', pin), { root: ROOT, pin: flipped, connect: neverConnect, consumedPath: consumedPath() })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  // An owner approval with execute false (the retired pin's execute) refuses the apply.
  assert.equal((await executeLibraryProductionApply('sql30', manifest('sql30', pin), { root: ROOT, pin: unlocked30({ execute: false }), connect: neverConnect, consumedPath: consumedPath() })).code, CODES.GUARD_APPLY_FORBIDDEN);
  // The spent one_use_id is refused as a replay, even on an execute-authorized copy.
  const spentFile = consumedPath();
  fs.writeFileSync(spentFile, JSON.stringify({ consumed: [SQL30_APPLIED.one_use_id] }));
  try {
    const spent = manifest('sql30', pin, { one_use_id: SQL30_APPLIED.one_use_id });
    assert.equal((await precheckLibraryProductionApply('sql30', spent, { root: ROOT, pin: unlocked30(), connect: neverConnect, consumedPath: spentFile })).code, CODES.RECEIPT_REUSED);
    assert.equal((await executeLibraryProductionApply('sql30', spent, { root: ROOT, pin: unlocked30(), connect: neverConnect, consumedPath: spentFile })).code, CODES.RECEIPT_REUSED);
    assert.equal((await executeLibraryProductionApply('sql30', spent, { root: ROOT, connect: neverConnect, consumedPath: spentFile })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  } finally {
    fs.rmSync(spentFile, { force: true });
  }
  // CLI: --apply with the committed (retired) pin, read from disk, refuses without connecting or
  // calling the guard (no receipt spent).
  const cli = await runCli('sql30', ['--apply'], { input: manifest('sql30', pin), deps: { enforceScriptGuard: () => { throw new Error('guard-called'); } } });
  assert.equal(cli.spent, 0);
  assert.match(cli.out, /PRODUCTION_APPROVAL_REQUIRED/);
  assert.doesNotMatch(cli.out, /guard-called|should-not-connect/);
});

test('SQL 30\'s execute-authorized copy (before the record-and-retire change) allows only the manifest bound to it; the cheap prechecks pass without connecting', async () => {
  const pin = unlocked30();
  const allowed = await evaluateLibraryProductionApply('sql30', manifest('sql30', pin), { root: ROOT, pin });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(allowed.details.sql30_production_apply_allowed, true);
  assert.equal(allowed.details.expected_live_definition_sha256, SQL30_PRODUCTION_PRE);
  assert.equal(allowed.details.staging_acceptance, SQL30_STAGING_ACCEPTANCE_REF);
  const prechecked = await precheckLibraryProductionApply('sql30', manifest('sql30', pin), { root: ROOT, pin, consumedPath: consumedPath() });
  assert.equal(prechecked.ok, true, JSON.stringify(prechecked));
  const wrongLive = await evaluateLibraryProductionApply('sql30', manifest('sql30', pin, { live_definition_sha256: 'f'.repeat(64) }), { root: ROOT, pin });
  assert.equal(wrongLive.code, CODES.SQL_COLLISION);
  const wrongStaging = await evaluateLibraryProductionApply('sql30', manifest('sql30', pin, { staging_acceptance: { ok: true, reference: 'https://example.invalid/x' } }), { root: ROOT, pin });
  assert.equal(wrongStaging.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const executeFalse = await executeLibraryProductionApply('sql30', manifest('sql30', pin), { root: ROOT, pin: { ...pin, execute: false }, consumedPath: consumedPath(), connect: neverConnect });
  assert.equal(executeFalse.code, CODES.GUARD_APPLY_FORBIDDEN);
  const wrongPhrase = await executeLibraryProductionApply('sql30', manifest('sql30', pin, { authorization_phrase: 'APPLY' }), { root: ROOT, pin, consumedPath: consumedPath(), connect: neverConnect });
  assert.equal(wrongPhrase.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
});

test('CLI: credential flags and arbitrary SQL are refused; pending pins stop before the guard; no receipt is spent and nothing connects', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sql2930-cli-'));
  try {
    for (const key of KEYS) {
      for (const flag of ['--password=x', '--database-url=postgresql://u:p@h/d', '--host=h', '--user=u', '--secret-arn=x']) {
        const result = spawnSync(process.execPath, [CLIS[key], '--inspect', flag], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir } });
        assert.notEqual(result.status, 0, flag);
        assert.match(`${result.stdout}${result.stderr}`, /credential flags are refused/, flag);
        assert.doesNotMatch(`${result.stdout}${result.stderr}`, /secretsmanager|ECONNREFUSED/i, flag);
      }
      const committed = await runCli(key, ['--apply'], { input: manifest(key, { ...PENDING[key], expected_live_definition_sha256: PRE }), deps: { pin: PENDING[key], enforceScriptGuard: () => { throw new Error('guard-called'); } } });
      assert.equal(committed.spent, 0);
      assert.match(committed.out, /SQL_COLLISION/);
      assert.doesNotMatch(committed.out, /guard-called|should-not-connect/);
      const sqlText = await runCli(key, ['--apply'], { input: { ...manifest(key, authorized(key)), sql_text: 'DROP TABLE x' }, deps: { pin: authorized(key) } });
      assert.match(sqlText.out, /arbitrary SQL text is forbidden/);
      const emptyRoot = fs.mkdtempSync(path.join(dir, 'noreceipt-'));
      const noReceipt = await runCli(key, ['--apply'], {
        input: manifest(key, authorized(key)),
        deps: { pin: authorized(key), enforceScriptGuard: (spec) => refuseUnguardedDeploy(spec, { root: emptyRoot, env: { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' } }) },
      });
      assert.equal(noReceipt.spent, 0);
      assert.match(noReceipt.out, /DEPLOYMENT_GUARD_REQUIRED/);
      const noFlag = await runCli(key, ['--apply'], {
        env: {},
        input: manifest(key, authorized(key)),
        deps: { pin: authorized(key), enforceScriptGuard: () => ({ ok: true, details: { receipt: { owned_components: [COMMITTED[key].filename] } } }) },
      });
      assert.equal(noFlag.spent, 0);
      assert.match(noFlag.out, /GUARD_APPLY_FORBIDDEN/);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the real guard: a staging receipt cannot authorize production; a production receipt is spent once and a refusing DB rolls back', async () => {
  const NOW = Date.parse('2026-10-16T20:00:00.000Z');
  for (const key of KEYS) {
    const pin = authorized(key);
    const issue = (root, overrides) => {
      const input = manifest(key, pin);
      const spec = {
        workstream_id: input.workstream_id,
        branch: 'main',
        commit: COMMIT,
        operator: 'owner',
        target_environment: 'production',
        target_component: 'production-sql',
        deployment_type: 'sql-apply',
        owned_components: [pin.filename],
        preflight_live_fingerprint: input.preflight_live_fingerprint,
        ...overrides,
      };
      const lease = acquireLease(root, {
        workstream_id: spec.workstream_id, component: spec.target_component, environment: spec.target_environment, commit: spec.commit, operator: spec.operator,
      }, NOW);
      assert.equal(lease.ok, true, lease.message);
      spec.lease = lease.details.lease;
      const issued = issueReceipt(root, spec, { now: NOW, ttlMs: 15 * 60 * 1000 });
      assert.equal(issued.ok, true, issued.message);
      return { input, receipt: issued.details.receipt };
    };
    const guardWith = (root, receipt) => (spec) => refuseUnguardedDeploy({ ...spec, receipt_path: undefined, receipt }, { root, now: NOW + 1000, env: {} });
    const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${key}-staging-receipt-`));
    const prodRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${key}-prod-receipt-`));
    try {
      const staging = issue(stagingRoot, { target_environment: 'staging', target_component: 'staging-sql' });
      const refused = await runCli(key, ['--apply'], { input: staging.input, deps: { pin, enforceScriptGuard: guardWith(stagingRoot, staging.receipt) } });
      assert.equal(refused.spent, 0);
      assert.match(refused.out, /RECEIPT_MISMATCH/);
      const prod = issue(prodRoot, {});
      const refusingDb = async () => ({ query: async () => { throw new Error('db-unavailable'); }, end: async () => {} });
      const valid = await runCli(key, ['--apply'], { input: prod.input, deps: { pin, enforceScriptGuard: guardWith(prodRoot, prod.receipt), connect: refusingDb } });
      assert.equal(valid.spent, 1);
      assert.match(valid.out, /rolled back/);
    } finally {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
      fs.rmSync(prodRoot, { recursive: true, force: true });
    }
  }
});

async function withPg(t, prefix, port, fn) {
  const reason = pgSkipReason();
  if (reason) {
    t.skip(reason);
    return;
  }
  let pg;
  try {
    pg = (await import('pg')).default;
  } catch {
    t.skip('pg module is not installed');
    return;
  }
  const fx = await libraryFixture(pg, prefix, port);
  try {
    await fn(fx);
  } finally {
    await fx.close();
  }
}

test('PostgreSQL 16: inspect is read-only and counts only; an authorized copy applies once as checksops_admin; the superuser is refused', { timeout: 300000 }, async (t) => withPg(t, 'pg-sql2930-prod-', 57600, async ({ admin, connectAs }) => {
  await admin.query(`INSERT INTO public.tenant_documents (tenant_id, doc_type, file_path, file_name, shared_with_homeowners)
    VALUES ('11111111-1111-4111-8111-111111111111', 'w9', 'https://x.supabase.co/storage/v1/object/sign/tenant-documents/a/w9.pdf', 'Private W-9.pdf', true),
           ('11111111-1111-4111-8111-111111111111', 'license', '11111111-1111-4111-8111-111111111111/library/mortgage/l.pdf', 'Private License.pdf', false)`);
  const seen = [];
  const connectWith = (user) => async () => {
    const client = await connectAs(user);
    const query = client.query.bind(client);
    client.query = (sql, params) => { seen.push(String(sql)); return query(sql, params); };
    return client;
  };
  const connect = connectWith('checksops_admin');
  for (const key of KEYS) {
    seen.length = 0;
    const inspected = await inspectLibraryProduction(key, { connect, pin: PENDING[key], root: ROOT });
    assert.equal(inspected.ok, true, JSON.stringify(inspected));
    const d = inspected.details;
    assert.equal(d.read_only, true);
    assert.equal(d.source_ok, true);
    assert.equal(d.pin_execute, false);
    assert.equal(d.apply_preconditions_met, false, 'no recorded pre-state');
    assert.deepEqual(d.precondition_failures, []);
    assert.deepEqual(d.counts.tenant_documents_by_category, { legacy: 2, mortgage: 0, template: 0, shingle: 0, siding: 0, catalog: 0, letterhead: 0, library_other: 0, other: 0 });
    assert.deepEqual(d.counts.tenant_documents_by_path_form, { aws_library: 1, url: 1, bucket_prefixed: 0, other_tenant_library: 0, other: 0 });
    assert.equal(d.counts.shared_with_homeowners_true, 1);
    assert.equal(d.counts.mortgage_request_library_documents, 0);
    assert.equal(d.sql30.check_shape, 'predecessor_6');
    assert.match(d.sql30.check_definition_sha256, /^[0-9a-f]{64}$/);
    // SQL 29 runs first: before it only the Lovable trigger function exists.
    assert.equal(d.sql29.functions_present, key === 'sql29' ? 1 : 5);
    assert.equal(seen[0], 'BEGIN READ ONLY');
    assert.equal(seen.at(-1), 'ROLLBACK');
    assert.ok(seen.slice(1, -1).every((text) => READ_ONLY_STATEMENT_RE.test(text)), JSON.stringify(seen.filter((text) => !READ_ONLY_STATEMENT_RE.test(text))));
    assert.doesNotMatch(JSON.stringify(d), /Private|supabase\.co/);

    const pin = authorized(key, d.live_definition_sha256);
    const asSuper = await executeLibraryProductionApply(key, manifest(key, pin), { root: ROOT, pin, connect: connectWith('ubuntu'), consumedPath: consumedPath() });
    assert.equal(asSuper.code, CODES.DEPLOYMENT_COLLISION);
    assert.ok(asSuper.details.failed.includes('login_is_pinned_admin'));
    const applied = await executeLibraryProductionApply(key, manifest(key, pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.after_hash, pin.intended_replacement_sha256);
    const after = await inspectLibraryProduction(key, { connect, pin, root: ROOT });
    assert.equal(after.details.already_applied, true);
    const replay = await executeLibraryProductionApply(key, manifest(key, pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
    assert.equal(replay.code, CODES.UNRELATED_MUTATION);
  }
}));
