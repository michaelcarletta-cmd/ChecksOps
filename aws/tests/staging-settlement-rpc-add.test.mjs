import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildOverlayReceiptInput,
  validateRequestedMember,
} from '../../scripts/deployment-guard/github-staging-lambda-overlay.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PIN_PATH = path.join(ROOT, 'ops/deployment-guard/staging-settlement-rpc-add.json');
const LOCKS_PATH = path.join(ROOT, 'ops/release-locks/locked-components.json');
const WORKFLOW_PATH = path.join(ROOT, '.github/workflows/guarded-staging-lambda-overlay.yml');

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function loadPin() {
  return JSON.parse(fs.readFileSync(PIN_PATH, 'utf8'));
}

const PIN = loadPin();

test('settlement RPC ADD pin is evaluate-only GO and does not authorize apply', () => {
  assert.equal(PIN.id, 'staging-settlement-rpc-add');
  assert.equal(PIN.verdict, 'GO');
  assert.equal(PIN.authorization, 'source-only');
  assert.equal(PIN.apply_authorized, false);
  assert.equal(PIN.execute, false);
  assert.equal(PIN.deploy, false);
  assert.equal(PIN.target_environment, 'staging');
  assert.equal(PIN.target_component, 'checksops-staging-api');
  assert.equal(PIN.deployment_type, 'lambda-overlay');
  assert.equal(PIN.operation, 'add');
  assert.equal(PIN.member, 'claim-settlement-rpc.mjs');
  assert.equal(PIN.live_member_state, 'ABSENT');
  assert.deepEqual(PIN.owned_components, ['claim-settlement-rpc.mjs']);
  assert.deepEqual(PIN.owned_member_ops, { replace: [], add: ['claim-settlement-rpc.mjs'] });
});

test('ADD source bytes match the accepted main member and SQL 53 pins', () => {
  assert.equal(sha256File(path.join(ROOT, PIN.source_path)), PIN.source_sha256);
  assert.equal(PIN.source_sha256, '4d0b312cadaeffb7bff2d96eea9c4815a1f23815c9c9dcbdbceea4e4d3203d64');
  assert.equal(sha256File(path.join(ROOT, PIN.sql53.filename)), PIN.sql53.source_sha256);
  assert.equal(PIN.sql53.source_sha256, '5a8f8bc35c69f2b339c78f3637d6bb1c606117967e3ab9d83b5dec1d37561197');
  assert.equal(PIN.sql53.exists, true);
  assert.equal(
    PIN.sql53.definitionSha256,
    '6542c3f6fb3f7d50b758b3d7352fe6fb49cbe8cd2bd5c6061dbc35a6e9fccf52',
  );
  assert.equal(PIN.sql53.function_identity, 'public.save_claim_settlement_breakdown(uuid,uuid,jsonb)');
  assert.equal(PIN.sql53.settlement_columns, '17/17');
  assert.equal(PIN.sql53.ledger_triggers, '3/3');
  assert.equal(PIN.sql53.public_triggers, '172/172');
});

test('RPC value columns match the accepted staging diagnostic 17/17 set', () => {
  const rpc = fs.readFileSync(path.join(ROOT, PIN.source_path), 'utf8');
  const columnBlock = rpc.match(/CLAIM_SETTLEMENT_VALUE_COLUMNS = Object\.freeze\(\[([\s\S]*?)\]\)/)?.[1] || '';
  const columns = [...columnBlock.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
  assert.deepEqual(columns, PIN.sql53.value_columns);
  assert.equal(columns.length, 17);
  assert.equal(PIN.compatibility.value_column_count, 17);
  assert.match(
    rpc,
    /SELECT public\.save_claim_settlement_breakdown\(\$1::uuid, \$2::uuid, \$3::jsonb\)/,
  );
  assert.deepEqual(PIN.sql53.preserved_function_hashes, {
    'public.sync_homeowner_ledger_from_check()': '9f6ec2dc9a5bcb7b7651d5b556788eb73ba5b567d457196fe82544f98aca8699',
    'public.aws_can_write_claim(uuid)': '0a7e62b26bf4dd07ce9c06a104773d472ccff6b5a0207d338de4ba594eb32caf',
    'public.hle_on_check_intake_insert()': 'bdd9ec4b45b79ef3b3b21c5f18c2785d901edc606695fbc84f0daedecff5ff48',
  });
});

test('accepted staging data.mjs already routes the missing RPC and exports its helpers', () => {
  const dataPath = path.join(ROOT, 'aws/functions/api/data.mjs');
  const flagsPath = path.join(ROOT, 'aws/functions/api/workflow-flags.mjs');
  const data = fs.readFileSync(dataPath, 'utf8');
  const flags = fs.readFileSync(flagsPath, 'utf8');
  assert.equal(sha256File(dataPath), PIN.preserve_live_members['data.mjs']);
  assert.equal(sha256File(flagsPath), PIN.preserve_live_members['workflow-flags.mjs']);
  assert.match(data, /export const parseBody = /);
  assert.match(data, /export const withIdentityWrite = /);
  assert.match(data, /earlyName === 'save_claim_settlement_breakdown'/);
  assert.match(data, /await import\('\.\/claim-settlement-rpc\.mjs'\)/);
  assert.match(flags, /export const applicationWorkflowWritesEnabled = /);
  assert.equal(PIN.compatibility.data_exports_parseBody, true);
  assert.equal(PIN.compatibility.data_exports_withIdentityWrite, true);
  assert.equal(PIN.compatibility.data_early_routes_settlement, true);
  assert.equal(PIN.compatibility.data_dynamic_imports_rpc, true);
  assert.equal(PIN.compatibility.workflow_flags_export, 'applicationWorkflowWritesEnabled');
  assert.equal(PIN.compatibility.AWS_APPLICATION_WORKFLOW_WRITES_ENABLED, 'true');
  assert.equal(PIN.compatibility.claim_settlement_rpc_absent, true);
});

test('overlay must preserve accepted workflow members and must not REPLACE them', () => {
  assert.equal(
    sha256File(path.join(ROOT, 'aws/functions/api/workflow.mjs')),
    PIN.preserve_live_members['workflow.mjs'],
  );
  assert.equal(
    sha256File(path.join(ROOT, 'aws/functions/api/workflow-rpc.mjs')),
    PIN.preserve_live_members['workflow-rpc.mjs'],
  );
  assert.equal(
    sha256File(path.join(ROOT, 'aws/functions/api/workflow-transitions.mjs')),
    PIN.origin_main_source_members['workflow-transitions.mjs'],
  );
  assert.notEqual(
    PIN.origin_main_source_members['workflow-transitions.mjs'],
    PIN.preserve_live_members['workflow-transitions.mjs'],
  );
  assert.deepEqual(PIN.do_not_overlay, [
    'workflow.mjs',
    'workflow-rpc.mjs',
    'data.mjs',
    'workflow-transitions.mjs',
  ]);
  for (const member of PIN.do_not_overlay) {
    assert.equal(PIN.owned_member_ops.replace.includes(member), false);
    assert.equal(PIN.owned_components.includes(member), false);
    assert.equal(PIN.forbidden_owned_components.includes(member), true);
  }
  assert.equal(PIN.forbidden.replace_workflow, true);
  assert.equal(PIN.forbidden.replace_workflow_rpc, true);
  assert.equal(PIN.forbidden.replace_data, true);
  assert.equal(PIN.forbidden.replace_workflow_transitions, true);
});

test('official ADD receipt is single-member add bound to the inspected live CAS', () => {
  const requested = validateRequestedMember(PIN.member);
  assert.equal(requested.ok, true);
  assert.equal(requested.details.member, 'claim-settlement-rpc.mjs');
  const identity = {
    workstreamId: 'github-staging-overlay-test',
    branch: 'main',
    commit: PIN.approved_commit_at_review,
    operator: 'test-agent',
  };
  const live = {
    member: PIN.member,
    memberState: 'ABSENT',
    memberSha256: null,
    codeSha256: PIN.live_fingerprint.codeSha256,
    revisionId: PIN.live_fingerprint.revisionId,
  };
  const input = buildOverlayReceiptInput(identity, live, 'add');
  assert.deepEqual(input.owned_components, ['claim-settlement-rpc.mjs']);
  assert.deepEqual(input.owned_member_ops, { replace: [], add: ['claim-settlement-rpc.mjs'] });
  assert.deepEqual(input.preflight_live_fingerprint, {
    codeSha256: '+U2BumLiTZSNZe4N9rAkMinxS4k/UyOvfcyYdMrOuu4=',
    revisionId: '455f7685-97d1-4dc0-a7bc-b58ce7ba4e93',
  });
  assert.equal(input.target_environment, 'staging');
  assert.equal(input.target_component, 'checksops-staging-api');
  assert.equal(input.deployment_type, 'lambda-overlay');
});

test('ADD refuses a present member and does not authorize REPLACE of protected files', () => {
  const identity = {
    workstreamId: 'github-staging-overlay-test',
    branch: 'main',
    commit: PIN.approved_commit_at_review,
    operator: 'test-agent',
  };
  assert.throws(() => buildOverlayReceiptInput(identity, {
    member: PIN.member,
    memberState: 'PRESENT',
    memberSha256: PIN.source_sha256,
    codeSha256: PIN.live_fingerprint.codeSha256,
    revisionId: PIN.live_fingerprint.revisionId,
  }, 'add'), { code: 'DEPLOYMENT_COLLISION' });
  for (const member of PIN.do_not_overlay) {
    assert.throws(() => buildOverlayReceiptInput(identity, {
      member,
      memberState: 'PRESENT',
      memberSha256: PIN.preserve_live_members[member],
      codeSha256: PIN.live_fingerprint.codeSha256,
      revisionId: PIN.live_fingerprint.revisionId,
    }, 'add'), { code: 'DEPLOYMENT_COLLISION' });
  }
});

test('official overlay workflow and post-apply diagnostic pins stay exact', () => {
  const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  assert.match(workflow, /name: Guarded staging Lambda overlay/);
  assert.match(workflow, /options:\n {10}- replace\n {10}- add\n/);
  assert.match(workflow, /CHECKSOPS_STAGING_OVERLAY_OPERATION/);
  assert.match(workflow, /accept_public_validator_unhealthy/);
  assert.equal(PIN.official_workflow.path, '.github/workflows/guarded-staging-lambda-overlay.yml');
  assert.deepEqual(PIN.official_workflow.inspect, {
    mode: 'inspect',
    operation: 'add',
    member: 'claim-settlement-rpc.mjs',
    approved_commit: '',
    expected_live_member_sha256: '',
    accept_public_validator_unhealthy: false,
  });
  assert.deepEqual(PIN.official_workflow.apply, {
    mode: 'apply',
    operation: 'add',
    member: 'claim-settlement-rpc.mjs',
    approved_commit: '3b186ef27f9a3e27a10b8368ef2eb737998898f2',
    expected_live_member_sha256: '',
    accept_public_validator_unhealthy: false,
  });
  assert.equal(PIN.post_apply_diagnostic.workflow_run, 37973071977);
  assert.equal(PIN.post_apply_diagnostic.head_sha, '3b186ef27f9a3e27a10b8368ef2eb737998898f2');
  assert.equal(PIN.post_apply_diagnostic.http_status, 200);
  assert.equal(PIN.post_apply_diagnostic.status, 'ok');
  assert.equal(PIN.expected_after_add.member_sha256, PIN.source_sha256);
  assert.equal(PIN.expected_after_add.codeSha256, 'unknown_until_apply');
});

test('pin does not retarget Release Locks or forbidden migrations', () => {
  const locks = JSON.parse(fs.readFileSync(LOCKS_PATH, 'utf8'));
  assert.equal(locks.components['production-spa'].classification, 'PRODUCTION_LOCKED');
  assert.equal(locks.components['production-spa'].artifact.name, '/assets/index-CBOwj-7W.js');
  assert.equal(PIN.release_locks['production-spa'], 'PRODUCTION_LOCKED');
  assert.equal(PIN.release_locks.production_spa_artifact, '/assets/index-CBOwj-7W.js');
  assert.equal(
    locks.components['database-rls'].source.tree_hash,
    PIN.release_locks['database-rls_tree_hash'],
  );
  assert.equal(PIN.forbidden.production, true);
  assert.equal(PIN.forbidden.sql_execution, true);
  assert.equal(PIN.forbidden.production_spa, true);
  assert.equal(PIN.forbidden.release_lock_changes, true);
  assert.ok(PIN.forbidden_owned_components.includes('aws/write-path/sql/44_claim_ledger_link_or_create.sql'));
  assert.ok(PIN.forbidden_owned_components.includes('supabase/migrations/20261007193200_skip_claim_ledger_event_for_endorsement_stage.sql'));
  assert.ok(PIN.forbidden_owned_components.includes('supabase/migrations/20260918170040_one_check_received_writer.sql'));
});
