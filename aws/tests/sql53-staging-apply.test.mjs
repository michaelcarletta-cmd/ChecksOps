import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import { evaluateDeployment } from '../../scripts/deployment-guard/lib/guard.mjs';
import {
  AUTHORIZED_STAGING_SQL,
  evaluateSqlExecutorAuthorization,
} from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import {
  classifySql53LivePrerequisite,
  evaluateSql53PostApplyInspect,
  evaluateSql53StagingApply,
  hashFileSha256,
  isSql53StagingApply,
  loadSql53Pin,
} from '../../scripts/deployment-guard/lib/sql53-staging-apply.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PIN = loadSql53Pin(ROOT);
const NOW = '2026-10-09T15:00:00.000Z';
const COMMIT = 'fc86ce981adc057d244fc5fbfb60af3701ddd49b';

const authorizeInput = (overrides = {}) => ({
  workstream_id: 'staging-sql53-3bc9',
  branch: 'cursor/staging-sql53-auth-3bc9',
  commit: COMMIT,
  operator: 'test-agent',
  target_environment: 'staging',
  target_component: 'staging-sql',
  deployment_type: 'sql-apply',
  owned_components: [PIN.filename],
  filename: PIN.filename,
  migration_id: PIN.migration_id,
  source_sha256: PIN.source_sha256,
  expected_live_definition_sha256: PIN.absent_live_definition_sha256,
  live_definition_sha256: PIN.absent_live_definition_sha256,
  exists: false,
  apply: false,
  execute: false,
  action: 'authorize',
  build_timestamp: NOW,
  preflight_live_fingerprint: { sql: PIN.absent_live_definition_sha256 },
  ...overrides,
});

test('SQL 53 pin matches current source bytes and does not broaden other migrations', () => {
  assert.equal(PIN.apply_authorized, false);
  assert.equal(PIN.execute, false);
  assert.equal(PIN.target_environment, 'staging');
  assert.equal(PIN.deployment_type, 'sql-apply');
  assert.equal(hashFileSha256(ROOT, PIN.filename), PIN.source_sha256);
  assert.equal(PIN.source_sha256, '5a8f8bc35c69f2b339c78f3637d6bb1c606117967e3ab9d83b5dec1d37561197');
  assert.equal(PIN.intended_definition_sha256, '6542c3f6fb3f7d50b758b3d7352fe6fb49cbe8cd2bd5c6061dbc35a6e9fccf52');
  assert.equal(PIN.function_identity, 'public.save_claim_settlement_breakdown(uuid,uuid,jsonb)');
  assert.deepEqual(PIN.owned_components, [PIN.filename]);
  assert.ok(PIN.forbidden_owned_components.includes('aws/write-path/sql/44_claim_ledger_link_or_create.sql'));
  assert.ok(PIN.forbidden_owned_components.includes('supabase/migrations/20261007193200_skip_claim_ledger_event_for_endorsement_stage.sql'));
  assert.ok(PIN.forbidden_owned_components.includes('supabase/migrations/20260918170040_one_check_received_writer.sql'));
  // 24 reviewed pins plus the forty-seven release 2026-10-17 pins (SQL 90-106, 108-135, 137, 138).
  assert.equal(AUTHORIZED_STAGING_SQL.length, 71);
  assert.equal(AUTHORIZED_STAGING_SQL.some((row) => row.filename === PIN.filename), true);
});

test('SQL 53 source creates only the settlement RPC and does not touch ledger SQL', () => {
  const sql = fs.readFileSync(path.join(ROOT, PIN.filename), 'utf8');
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.save_claim_settlement_breakdown\(/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.save_claim_settlement_breakdown[\s\S]*TO checksops/);
  assert.doesNotMatch(sql, /DROP\s+(?:FUNCTION|TRIGGER|TABLE)/i);
  assert.doesNotMatch(sql, /sync_homeowner_ledger_from_check|hle_on_check_intake_insert|20261007193200|one_check_received_writer|claim_ledger_link_or_create/);
});

test('absent live settlement function is ready for later independent apply', () => {
  const live = classifySql53LivePrerequisite({
    exists: false,
    live_definition_sha256: PIN.absent_live_definition_sha256,
  }, PIN);
  assert.equal(live.ok, true, live.message);
  assert.equal(live.details.state, 'absent');
  const ready = evaluateSql53StagingApply(authorizeInput(), { root: ROOT });
  assert.equal(ready.ok, true, ready.message);
  assert.equal(ready.details.sql53_authorization_ready, true);
  assert.equal(ready.details.apply_executed, false);
  assert.equal(ready.details.apply_authorized, false);
  assert.equal(ready.details.independent_apply_authorization_required, true);
  assert.equal(ready.details.executor_invoke_forbidden, true);
  assert.equal(ready.details.intended_definition_sha256, PIN.intended_definition_sha256);
  assert.equal(isSql53StagingApply(authorizeInput()), true);
});

test('omitted live hashes and exists:false with a live body fail closed', () => {
  const missing = classifySql53LivePrerequisite({}, PIN);
  assert.equal(missing.ok, false);
  assert.equal(missing.code, CODES.SQL_COLLISION);

  const existsOnly = classifySql53LivePrerequisite({ exists: false }, PIN);
  assert.equal(existsOnly.ok, false);
  assert.equal(existsOnly.code, CODES.SQL_COLLISION);

  const bodyOverridesAbsent = classifySql53LivePrerequisite({
    exists: false,
    live_definition: 'CREATE FUNCTION public.save_claim_settlement_breakdown() RETURNS void AS $$ SELECT 1 $$',
  }, PIN);
  assert.equal(bodyOverridesAbsent.ok, false);
  assert.equal(bodyOverridesAbsent.code, CODES.SQL_COLLISION);

  const omitted = evaluateSql53StagingApply(authorizeInput({
    exists: undefined,
    expected_live_definition_sha256: undefined,
    live_definition_sha256: undefined,
  }), { root: ROOT });
  assert.equal(omitted.ok, false);
  assert.equal(omitted.code, CODES.SQL_COLLISION);
  assert.notEqual(omitted.details.sql53_authorization_ready, true);

  const expectedOnly = evaluateSql53StagingApply(authorizeInput({
    live_definition_sha256: undefined,
  }), { root: ROOT });
  assert.equal(expectedOnly.ok, false);
  assert.equal(expectedOnly.code, CODES.SQL_COLLISION);
  assert.notEqual(expectedOnly.details.sql53_authorization_ready, true);

  const liveBody = evaluateSql53StagingApply(authorizeInput({
    live_definition: 'CREATE FUNCTION public.save_claim_settlement_breakdown() RETURNS void AS $$ SELECT 1 $$',
  }), { root: ROOT });
  assert.equal(liveBody.ok, false);
  assert.equal(liveBody.code, CODES.SQL_COLLISION);
  assert.notEqual(liveBody.details.sql53_authorization_ready, true);
});

test('unexpected existing settlement definition fails closed', () => {
  const unexpected = classifySql53LivePrerequisite({
    exists: true,
    live_definition_sha256: '9'.repeat(64),
  }, PIN);
  assert.equal(unexpected.ok, false);
  assert.equal(unexpected.code, CODES.SQL_COLLISION);
  assert.match(unexpected.message, /unexpected definition/);

  const evaled = evaluateSql53StagingApply(authorizeInput({
    exists: true,
    live_definition_sha256: '9'.repeat(64),
    expected_live_definition_sha256: '9'.repeat(64),
  }), { root: ROOT });
  assert.equal(evaled.ok, false);
  assert.equal(evaled.code, CODES.SQL_COLLISION);
});

test('intended existing settlement definition refuses replace', () => {
  const already = classifySql53LivePrerequisite({
    exists: true,
    live_definition_sha256: PIN.intended_definition_sha256,
  }, PIN);
  assert.equal(already.ok, false);
  assert.equal(already.code, CODES.UNRELATED_MUTATION);
});

test('production, apply flags, extra migrations, and wrong source hash are refused', () => {
  assert.equal(evaluateSql53StagingApply(authorizeInput({
    target_environment: 'production',
    target_component: 'production-sql',
  }), { root: ROOT }).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal(evaluateSql53StagingApply(authorizeInput({ apply: true }), { root: ROOT }).code, CODES.GUARD_APPLY_FORBIDDEN);
  assert.equal(evaluateSql53StagingApply(authorizeInput({ execute: true }), { root: ROOT }).code, CODES.GUARD_APPLY_FORBIDDEN);
  assert.equal(evaluateSql53StagingApply(authorizeInput({ action: 'apply' }), { root: ROOT }).code, CODES.GUARD_APPLY_FORBIDDEN);
  assert.equal(evaluateSql53StagingApply(authorizeInput({
    sql_text: 'CREATE FUNCTION public.other() RETURNS void AS $$ SELECT 1 $$',
  }), { root: ROOT }).code, CODES.UNRELATED_MUTATION);
  assert.equal(evaluateSql53StagingApply(authorizeInput({
    owned_components: [PIN.filename, 'supabase/migrations/20261007193200_skip_claim_ledger_event_for_endorsement_stage.sql'],
  }), { root: ROOT }).code, CODES.UNRELATED_MUTATION);
  assert.equal(evaluateSql53StagingApply(authorizeInput({
    owned_components: ['aws/write-path/sql/44_claim_ledger_link_or_create.sql'],
    filename: PIN.filename,
  }), { root: ROOT }).code, CODES.UNRELATED_MUTATION);
  assert.equal(evaluateSql53StagingApply(authorizeInput({
    source_sha256: '1'.repeat(64),
  }), { root: ROOT }).code, CODES.SQL_COLLISION);
  assert.equal(evaluateSql53StagingApply(authorizeInput({
    deployment_type: 'sql-executor-invoke',
  }), { root: ROOT }).code, CODES.RECEIPT_MISMATCH);
});

test('SQL 53 executor pin requires the exact #835 commit/hash tuple', () => {
  const exact = evaluateSqlExecutorAuthorization({
    workstream_id: 'staging-sql53-3bc9',
    branch: 'cursor/staging-sql53-execute-3bc9',
    commit: '8de7888606b00e7d9a5f0776f2f9c4afe7c14fd1',
    operator: 'test-agent',
    target_environment: 'staging',
    target_component: 'staging-sql',
    deployment_type: 'sql-executor-invoke',
    owned_components: [PIN.filename],
    filename: PIN.filename,
    migration_id: PIN.migration_id,
    source_sha256: PIN.source_sha256,
    intended_replacement_sha256: PIN.intended_definition_sha256,
    expected_live_definition_sha256: PIN.absent_live_definition_sha256,
    one_use_id: 'sql53-apply-0001',
    expiry: '2026-10-09T16:00:00.000Z',
    action: 'authorize',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    preflight_live_fingerprint: { sql: PIN.absent_live_definition_sha256 },
  }, { now: Date.parse(NOW) });
  assert.equal(exact.ok, true, exact.message);

  const wrongCommit = evaluateSqlExecutorAuthorization({
    workstream_id: 'staging-sql53-3bc9',
    branch: 'cursor/staging-sql53-execute-3bc9',
    commit: COMMIT,
    operator: 'test-agent',
    target_environment: 'staging',
    target_component: 'staging-sql',
    deployment_type: 'sql-executor-invoke',
    owned_components: [PIN.filename],
    filename: PIN.filename,
    migration_id: PIN.migration_id,
    source_sha256: PIN.source_sha256,
    intended_replacement_sha256: PIN.intended_definition_sha256,
    expected_live_definition_sha256: PIN.absent_live_definition_sha256,
    one_use_id: 'sql53-apply-0002',
    expiry: '2026-10-09T16:00:00.000Z',
    action: 'authorize',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    preflight_live_fingerprint: { sql: PIN.absent_live_definition_sha256 },
  }, { now: Date.parse(NOW) });
  assert.equal(wrongCommit.ok, false);
  assert.equal(wrongCommit.code, CODES.SQL_COLLISION);
});

test('evaluateDeployment routes SQL 53 sql-apply through the staging pin', () => {
  const result = evaluateDeployment(authorizeInput(), { root: ROOT, skip_contracts: true });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.details.evaluation.sql53_authorization_ready, true);
  assert.equal(result.details.evaluation.apply_authorized, false);
});

test('post-apply inspect accepts the intended hash and preserves unrelated functions', () => {
  const okInspect = evaluateSql53PostApplyInspect({
    functions: [
      { identity: PIN.function_identity, exists: true, definitionSha256: PIN.intended_definition_sha256 },
      { identity: 'public.sync_homeowner_ledger_from_check()', exists: true, definitionSha256: '9'.repeat(64) },
      { identity: 'public.aws_can_write_claim(uuid)', exists: true, definitionSha256: 'a'.repeat(64) },
      { identity: 'public.hle_on_check_intake_insert()', exists: true, definitionSha256: 'b'.repeat(64) },
    ],
  }, PIN);
  assert.equal(okInspect.ok, true, okInspect.message);
  assert.equal(okInspect.details.workflow, PIN.post_apply_verification.workflow);

  assert.equal(evaluateSql53PostApplyInspect({
    functions: [
      { identity: PIN.function_identity, exists: true, definitionSha256: 'c'.repeat(64) },
    ],
  }, PIN).code, CODES.SQL_COLLISION);
  assert.equal(evaluateSql53PostApplyInspect({
    functions: [
      { identity: PIN.function_identity, exists: true, definitionSha256: PIN.intended_definition_sha256 },
    ],
  }, PIN).code, CODES.SQL_COLLISION);
});

test('evaluate-only CLI never applies and the diagnostic workflow remains the verifier', () => {
  const workflow = fs.readFileSync(path.join(ROOT, PIN.post_apply_verification.workflow), 'utf8');
  assert.match(workflow, /Staging DB read-only diagnostic/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /environment: staging/);
  const cli = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts/deployment-guard/sql53-staging-apply.mjs'),
    '--json',
    JSON.stringify(authorizeInput({ apply: true })),
  ], { encoding: 'utf8' });
  assert.notEqual(cli.status, 0);
  assert.match(`${cli.stderr}${cli.stdout}`, /GUARD_APPLY_FORBIDDEN/);
});
