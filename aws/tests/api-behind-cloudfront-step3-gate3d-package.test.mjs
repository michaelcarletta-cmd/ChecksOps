import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { evaluateOriginVerify } from '../functions/origin-verify/authorizer.mjs';
import {
  inspectLambdaUpdate,
  mergeOriginVerifyRequire,
  requirePrivilegedOperator,
  sanitizeLambdaFailureReason,
  waitForLambdaReady,
} from '../origin-verify/gate3d-lib.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const run = (rel, env = {}) =>
  spawnSync(process.execPath, [path.join(ROOT, rel)], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CHECKSOPS_STEP3_EXECUTE: '',
      CHECKSOPS_APPLY_GATE3A: '',
      CHECKSOPS_APPLY_GATE3B: '',
      CHECKSOPS_APPLY_GATE3C: '',
      CHECKSOPS_APPLY_GATE3D: '',
      CHECKSOPS_GATE3D_ENFORCE: '',
      CHECKSOPS_GATE3D_VALIDATE: '',
      CHECKSOPS_GATE3D_ID_TOKEN: '',
      CHECKSOPS_APPLY_ROLLBACK: '',
      CHECKSOPS_ROLLBACK_GATE: '',
      CHECKSOPS_OPERATOR_GATE3B: '',
      CHECKSOPS_OPERATOR_GATE3D: '',
      CHECKSOPS_OPERATOR_ROLLBACK_GATE3D: '',
      CHECKSOPS_OPERATOR_EXECUTE: '',
      ORIGIN_VERIFY_REQUIRE: '',
      ...env,
    },
  });

const apply = read('aws/origin-verify/apply-gate3d.mjs');
const rollback = read('aws/origin-verify/rollback-gate3d.mjs');
const preflight = read('aws/origin-verify/preflight-gate3d.mjs');
const validate = read('aws/origin-verify/validate-gate3d.mjs');
const lib = read('aws/origin-verify/gate3d-lib.mjs');
const operatorApply = read('aws/origin-verify/operator-apply-gate3d.mjs');
const operatorRollback = read('aws/origin-verify/operator-rollback-gate3d.mjs');
const design = read('aws/cutover/API_PERIMETER_STEP3_GATE3D.md');
const operatorDoc = read('aws/cutover/API_PERIMETER_STEP3_OPERATOR_GATE3D.md');
const sql = read('aws/financial/sql/64_financial_activation_grants.sql');

function refuteSecrets(text) {
  assert.doesNotMatch(text, /SecretString|HeaderValue\s*[:=]\s*["'][^"']{4,}/);
  assert.doesNotMatch(text, /"current"\s*:\s*"[A-Za-z0-9+/=]{8,}"/);
  assert.doesNotMatch(text, /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\./);
  assert.doesNotMatch(text, /Bearer [A-Za-z0-9._-]+/);
}

test('Gate 3D design is review-only and does not execute', () => {
  assert.match(design, /STOP FOR REVIEW\. DO NOT APPLY GATE 3D/);
  assert.match(design, /28b9026cc183956198260b5f481674fcb7cae88e/);
  assert.match(design, /CHECKSOPS_APPLY_GATE3D=I_UNDERSTAND_PRODUCTION/);
  assert.match(design, /CHECKSOPS_GATE3D_ENFORCE=I_ACCEPT_REQUIRE_MODE/);
  assert.match(design, /CHECKSOPS_STEP3_EXECUTE=1/);
  assert.match(design, /CHECKSOPS_GATE3D_ID_TOKEN/);
  assert.match(design, /RevisionId/);
  assert.match(design, /GATE3D_ROLLBACK_FATAL/);
  assert.match(design, /operator-apply-gate3d/);
  assert.match(design, /automatic rollback/i);
  assert.match(design, /Do \*\*not\*\* disable the execute-api endpoint/);
  assert.match(design, /64_financial_activation_grants\.sql/);
  assert.match(design, /DenyKmsAndRoleChaining/);
  assert.match(design, /Read-only preflight/);
  assert.match(design, /Apply was \*\*not\*\* executed/);
  assert.doesNotMatch(design, /DisableExecuteApiEndpoint=true/);
  refuteSecrets(design);
  refuteSecrets(operatorDoc);
  assert.match(operatorDoc, /DO NOT EXECUTE FROM THIS PR/);
  assert.match(operatorDoc, /Do \*\*not\*\* broaden that role/);
  assert.match(operatorDoc, /ChecksOpsCursorApiPerimeterStep3Temp/);
  assert.match(operatorDoc, /Refuse if the caller ARN/);
  assert.match(operatorDoc, /806168576068/);
  assert.match(operatorDoc, /Do \*\*not\*\* set `CHECKSOPS_GATE3D_ID_TOKEN`/);
  assert.match(operatorDoc, /passwordless|EMAIL_OTP|CloudShell/);
  assert.doesNotMatch(operatorDoc, /CHECKSOPS_T0_TESTER_PASSWORD|COGNITO_PASSWORD_FILE/);
  assert.match(design, /privileged-operator apply path does \*\*not\*\* take/);
  assert.match(design, /LastUpdateStatus=Successful/);
});

test('apply and rollback are plan-only without explicit production and execute gates', () => {
  const blocked = run('aws/origin-verify/apply-gate3d.mjs');
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /DO_NOT_DEPLOY/);

  const confirmOnly = run('aws/origin-verify/apply-gate3d.mjs', {
    CHECKSOPS_APPLY_GATE3D: 'I_UNDERSTAND_PRODUCTION',
  });
  assert.equal(confirmOnly.status, 2);
  assert.match(confirmOnly.stderr, /DO_NOT_DEPLOY/);

  const twoGates = run('aws/origin-verify/apply-gate3d.mjs', {
    CHECKSOPS_APPLY_GATE3D: 'I_UNDERSTAND_PRODUCTION',
    CHECKSOPS_GATE3D_ENFORCE: 'I_ACCEPT_REQUIRE_MODE',
  });
  assert.equal(twoGates.status, 2);
  assert.match(twoGates.stdout, /"mode":"plan"/);
  assert.match(twoGates.stdout, /STOP FOR REVIEW/);
  assert.match(twoGates.stdout, /"DisableExecuteApiEndpoint":false/);
  assert.match(twoGates.stdout, /"idTokenRequired":true/);
  assert.match(twoGates.stdout, /"idTokenPrinted":false/);
  assert.match(twoGates.stdout, /"revisionIdRequired":true/);
  assert.match(twoGates.stdout, /automaticRollback/);
  refuteSecrets(`${twoGates.stdout}${twoGates.stderr}`);

  const rollbackBlocked = run('aws/origin-verify/rollback-gate3d.mjs');
  assert.equal(rollbackBlocked.status, 2);
  assert.match(rollbackBlocked.stderr, /CHECKSOPS_ROLLBACK_GATE=3D/);

  const rollbackPlan = run('aws/origin-verify/rollback-gate3d.mjs', {
    CHECKSOPS_ROLLBACK_GATE: '3D',
    CHECKSOPS_APPLY_ROLLBACK: 'I_UNDERSTAND_PRODUCTION',
  });
  assert.equal(rollbackPlan.status, 2);
  assert.match(rollbackPlan.stdout, /"mode":"plan"/);
  assert.match(rollbackPlan.stdout, /ORIGIN_VERIFY_REQUIRE=false/);
  assert.match(rollbackPlan.stdout, /"preserveExistingEnv":true/);
  assert.match(rollbackPlan.stdout, /"confirmRequireFalse":true/);
  refuteSecrets(`${rollbackPlan.stdout}${rollbackPlan.stderr}`);

  const validatePlan = run('aws/origin-verify/validate-gate3d.mjs');
  assert.equal(validatePlan.status, 2);
  assert.match(validatePlan.stdout, /"mode":"plan"/);
  assert.match(validatePlan.stdout, /authenticated read-only \/prep\/data\/query=200/);
});

test('live apply is blocked by deployment guard before legacy ID-token gating', () => {
  assert.match(apply, /idTokenPresent\(\)/);
  assert.match(apply, /requireLiveIdToken\(\)/);
  assert.match(apply, /CHECKSOPS_GATE3D_ID_TOKEN_required/);
  assert.match(validate, /requireLiveIdToken\(\)/);
  assert.match(validate, /authenticated\.skipped === false/);
  assert.doesNotMatch(validate, /authenticated\.skipped \|\|/);
  assert.match(lib, /CHECKSOPS_GATE3D_ID_TOKEN_required/);

  const missingToken = run('aws/origin-verify/apply-gate3d.mjs', {
    CHECKSOPS_APPLY_GATE3D: 'I_UNDERSTAND_PRODUCTION',
    CHECKSOPS_GATE3D_ENFORCE: 'I_ACCEPT_REQUIRE_MODE',
    CHECKSOPS_STEP3_EXECUTE: '1',
  });
  assert.equal(missingToken.status, 2);
  assert.match(missingToken.stderr, /DEPLOYMENT_GUARD_REQUIRED/);
  refuteSecrets(`${missingToken.stdout}${missingToken.stderr}`);
});

test('only the authorizer Lambda environment may change, with RevisionId', () => {
  for (const src of [apply, rollback, lib, operatorApply, operatorRollback]) {
    assert.match(src, /checksops-production-origin-verify|LAMBDA_NAME/);
    assert.match(src, /update-function-configuration|updateOriginVerifyRequire|rollbackOriginVerifyRequireAndConfirm/);
    assert.doesNotMatch(src, /update-distribution/i);
    assert.doesNotMatch(src, /update-api/);
    assert.doesNotMatch(src, /update-route/);
    assert.doesNotMatch(src, /update-integration/);
    assert.doesNotMatch(src, /DisableExecuteApiEndpoint["']?\s*:\s*true/);
    assert.doesNotMatch(src, /GetSecretValue/);
    assert.doesNotMatch(src, /64_financial_activation_grants\.sql/);
    assert.doesNotMatch(src, /MOOV_ENABLED["']?\s*:\s*["']true["']/);
  }
  assert.match(lib, /--revision-id/);
  assert.match(lib, /RevisionId/);
  assert.match(lib, /lambda_revision_conflict/);
  assert.match(apply, /preserveExistingEnv/);
  assert.match(apply, /updateOriginVerifyRequire\('true'\)/);
  assert.match(apply, /rollbackOriginVerifyRequireAndConfirm/);
  assert.match(rollback, /rollbackOriginVerifyRequireAndConfirm/);
  assert.doesNotMatch(rollback, /updateOriginVerifyRequire\('true'\)/);
  assert.match(lib, /GATE3D_ROLLBACK_FATAL/);
  assert.match(lib, /requireFlag === 'false'/);
  assert.match(preflight, /Read-only|Does not mutate AWS/);
  assert.doesNotMatch(preflight, /update-function-configuration/);
});

test('waitForLambdaReady requires Active and Successful and fails closed', () => {
  assert.deepEqual(inspectLambdaUpdate({ State: 'Active', LastUpdateStatus: 'InProgress' }), { status: 'retry' });
  assert.deepEqual(inspectLambdaUpdate({ State: 'Pending', LastUpdateStatus: 'Successful' }), { status: 'retry' });
  assert.deepEqual(inspectLambdaUpdate({ State: 'Active', LastUpdateStatus: 'Successful' }), { status: 'ready' });

  const failedState = inspectLambdaUpdate({
    State: 'Failed',
    LastUpdateStatus: 'InProgress',
    StateReason: 'HeaderValue="super-secret" Environment={ORIGIN_VERIFY_REQUIRE:true}',
  });
  assert.equal(failedState.status, 'failed');
  assert.doesNotMatch(failedState.reason, /super-secret/);
  assert.doesNotMatch(failedState.reason, /ORIGIN_VERIFY_REQUIRE=true|ORIGIN_VERIFY_REQUIRE:true/);

  const failedUpdate = inspectLambdaUpdate({
    State: 'Active',
    LastUpdateStatus: 'Failed',
    LastUpdateStatusReason: 'SecretString={"current":"abcdef0123456789"}',
  });
  assert.equal(failedUpdate.status, 'failed');
  assert.doesNotMatch(failedUpdate.reason, /abcdef0123456789/);

  const sanitized = sanitizeLambdaFailureReason('Variables={"KEEP":"1"} HeaderValue="abc"');
  assert.match(sanitized, /REDACTED/);
  assert.doesNotMatch(sanitized, /"KEEP"/);
  assert.doesNotMatch(sanitized, /HeaderValue":"abc"/);

  const inProgressThenOk = [
    { State: 'Active', LastUpdateStatus: 'InProgress' },
    { State: 'Active', LastUpdateStatus: 'Successful' },
  ];
  const ready = waitForLambdaReady({
    getConfig: () => inProgressThenOk.shift(),
    sleep: () => {},
    maxAttempts: 3,
    intervalMs: 0,
  });
  assert.equal(ready.LastUpdateStatus, 'Successful');
  assert.equal(ready.State, 'Active');

  assert.throws(
    () => waitForLambdaReady({
      getConfig: () => ({ State: 'Active', LastUpdateStatus: 'Failed', LastUpdateStatusReason: 'HeaderValue="nope"' }),
      sleep: () => {},
      maxAttempts: 5,
      intervalMs: 0,
    }),
    /origin_verify_lambda_update_failed/,
  );
  assert.throws(
    () => waitForLambdaReady({
      getConfig: () => ({ State: 'Active', LastUpdateStatus: 'InProgress' }),
      sleep: () => {},
      maxAttempts: 2,
      intervalMs: 0,
    }),
    /origin_verify_lambda_update_timeout/,
  );
});

test('privileged-operator path remains separately gated and direct execution is guard-blocked', () => {
  assert.match(operatorApply, /requirePrivilegedOperator/);
  assert.match(operatorRollback, /requirePrivilegedOperator/);
  assert.match(operatorApply, /806168576068/);
  assert.throws(
    () => requirePrivilegedOperator({
      Account: '806168576068',
      Arn: 'arn:aws:sts::806168576068:assumed-role/ChecksOpsCursorApiPerimeterStep3Temp/x',
    }),
    /refusing_step3temp/,
  );
  assert.throws(
    () => requirePrivilegedOperator({
      Account: '000000000000',
      Arn: 'arn:aws:sts::000000000000:assumed-role/Admin/x',
    }),
    /refusing_wrong_account/,
  );
  assert.equal(
    requirePrivilegedOperator({
      Account: '806168576068',
      Arn: 'arn:aws:sts::806168576068:assumed-role/Privileged/x',
    }),
    'arn:aws:sts::806168576068:assumed-role/Privileged/x',
  );
  assert.match(operatorApply, /Do not broaden|doNotBroadenStep3TempKms/);
  assert.match(operatorApply, /preserveExistingEnv/);
  assert.match(operatorApply, /mintT0IdTokenViaPasswordless|passwordless\/start/);
  assert.doesNotMatch(operatorApply, /requireLiveIdToken/);
  assert.doesNotMatch(operatorApply, /GetSecretValue/);
  assert.doesNotMatch(operatorApply, /admin-set-user-password|AdminSetUserPassword|cognito-idp/);
  assert.doesNotMatch(operatorApply, /CHECKSOPS_T0_TESTER_PASSWORD|COGNITO_PASSWORD_FILE/);
  assert.doesNotMatch(operatorRollback, /GetSecretValue/);

  const planned = run('aws/origin-verify/operator-apply-gate3d.mjs');
  assert.equal(planned.status, 2);
  assert.match(planned.stdout, /"operatorOnly":true/);
  assert.match(planned.stdout, /"doNotUseStep3Temp":true/);
  assert.match(planned.stdout, /"expectedAccount":"806168576068"/);
  assert.match(planned.stdout, /"manualIdTokenRequired":false/);
  assert.match(planned.stdout, /"inProcessT0Login":true/);
  assert.doesNotMatch(planned.stdout, /"idTokenRequired":true/);
  refuteSecrets(`${planned.stdout}${planned.stderr}`);

  const rollbackPlan = run('aws/origin-verify/operator-rollback-gate3d.mjs');
  assert.equal(rollbackPlan.status, 2);
  assert.match(rollbackPlan.stdout, /"operatorOnly":true/);
  assert.match(rollbackPlan.stdout, /"confirmRequireFalse":true/);
  refuteSecrets(`${rollbackPlan.stdout}${rollbackPlan.stderr}`);

  const missingTty = run('aws/origin-verify/operator-apply-gate3d.mjs', {
    CHECKSOPS_OPERATOR_GATE3D: 'I_UNDERSTAND_PRODUCTION',
    CHECKSOPS_OPERATOR_EXECUTE: '1',
  });
  assert.equal(missingTty.status, 2);
  assert.match(missingTty.stderr, /DEPLOYMENT_GUARD_REQUIRED/);
  assert.doesNotMatch(missingTty.stderr, /CHECKSOPS_GATE3D_ID_TOKEN_required|cloudshell_tty_required/);
  refuteSecrets(`${missingTty.stdout}${missingTty.stderr}`);
});

test('mergeOriginVerifyRequire preserves existing keys and only flips REQUIRE', () => {
  const merged = mergeOriginVerifyRequire({ KEEP: '1', ORIGIN_VERIFY_REQUIRE: 'false' }, 'true');
  assert.deepEqual(merged.next, { KEEP: '1', ORIGIN_VERIFY_REQUIRE: 'true' });
  assert.deepEqual(merged.preservedKeys, ['KEEP', 'ORIGIN_VERIFY_REQUIRE']);
  assert.deepEqual(merged.changedKeys, ['ORIGIN_VERIFY_REQUIRE']);
  assert.deepEqual(merged.extraKeysAdded, []);
  const empty = mergeOriginVerifyRequire({}, 'false');
  assert.deepEqual(empty.next, { ORIGIN_VERIFY_REQUIRE: 'false' });
});

test('require-mode authorizer denies missing and wrong headers without leaking secrets', () => {
  const secrets = { current: 'current-secret-value', next: '' };
  const missing = evaluateOriginVerify({ header: '', secrets, require: true });
  assert.equal(missing.isAuthorized, false);
  const wrong = evaluateOriginVerify({ header: 'nope', secrets, require: true });
  assert.equal(wrong.isAuthorized, false);
  const ok = evaluateOriginVerify({ header: 'current-secret-value', secrets, require: true });
  assert.equal(ok.isAuthorized, true);
  const observe = evaluateOriginVerify({ header: '', secrets, require: false });
  assert.equal(observe.isAuthorized, true);
});

test('financial activation and execute-api disable cannot occur from this package', () => {
  assert.match(sql, /DO NOT APPLY THIS FILE/);
  assert.match(validate, /executeApiEnabled/);
  assert.match(validate, /providerFinancialFlagsFalse/);
  assert.match(validate, /financialActivationSqlAppliedFalse/);
  assert.match(preflight, /financialActivationSqlAppliedFalse/);
  assert.doesNotMatch(`${apply}${rollback}${preflight}${validate}${operatorApply}${operatorRollback}`, /DisableExecuteApiEndpoint=true/);
  assert.doesNotMatch(apply, /GetSecretValue/);
  assert.doesNotMatch(validate, /HeaderValue\s*[:=]\s*["'][^"']{4,}/);
  assert.match(validate, /idTokenPrinted: false/);
});
