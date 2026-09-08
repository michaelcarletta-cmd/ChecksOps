import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { evaluateOriginVerify } from '../functions/origin-verify/authorizer.mjs';
import { mergeOriginVerifyRequire } from '../origin-verify/gate3d-lib.mjs';

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
      CHECKSOPS_APPLY_ROLLBACK: '',
      CHECKSOPS_ROLLBACK_GATE: '',
      CHECKSOPS_OPERATOR_GATE3B: '',
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
const design = read('aws/cutover/API_PERIMETER_STEP3_GATE3D.md');
const sql = read('aws/financial/sql/64_financial_activation_grants.sql');

test('Gate 3D design is review-only and does not execute', () => {
  assert.match(design, /STOP FOR REVIEW\. DO NOT APPLY GATE 3D/);
  assert.match(design, /28b9026cc183956198260b5f481674fcb7cae88e/);
  assert.match(design, /CHECKSOPS_APPLY_GATE3D=I_UNDERSTAND_PRODUCTION/);
  assert.match(design, /CHECKSOPS_GATE3D_ENFORCE=I_ACCEPT_REQUIRE_MODE/);
  assert.match(design, /CHECKSOPS_STEP3_EXECUTE=1/);
  assert.match(design, /automatic rollback/i);
  assert.match(design, /Do \*\*not\*\* disable the execute-api endpoint/);
  assert.match(design, /64_financial_activation_grants\.sql/);
  assert.match(design, /DenyKmsAndRoleChaining/);
  assert.match(design, /Read-only preflight/);
  assert.match(design, /Apply was \*\*not\*\* executed/);
  assert.doesNotMatch(design, /DisableExecuteApiEndpoint=true/);
  assert.doesNotMatch(design, /HeaderValue\s*[:=]\s*["'][^"']{4,}/);
  assert.doesNotMatch(design, /SecretString/);
  assert.doesNotMatch(design, /"current"\s*:\s*"[A-Za-z0-9+/=]{8,}"/);
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
  assert.match(twoGates.stdout, /automaticRollback/);
  assert.doesNotMatch(`${twoGates.stdout}${twoGates.stderr}`, /SecretString|HeaderValue/);

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
  assert.doesNotMatch(`${rollbackPlan.stdout}${rollbackPlan.stderr}`, /SecretString|HeaderValue/);

  const validatePlan = run('aws/origin-verify/validate-gate3d.mjs');
  assert.equal(validatePlan.status, 2);
  assert.match(validatePlan.stdout, /"mode":"plan"/);
});

test('only the authorizer Lambda environment may change', () => {
  for (const src of [apply, rollback, lib]) {
    assert.match(src, /checksops-production-origin-verify|LAMBDA_NAME/);
    assert.match(src, /update-function-configuration|UpdateFunctionConfiguration|updateOriginVerifyRequire/);
    assert.doesNotMatch(src, /update-distribution/i);
    assert.doesNotMatch(src, /update-api/);
    assert.doesNotMatch(src, /update-route/);
    assert.doesNotMatch(src, /update-integration/);
    assert.doesNotMatch(src, /DisableExecuteApiEndpoint["']?\s*:\s*true/);
    assert.doesNotMatch(src, /GetSecretValue/);
    assert.doesNotMatch(src, /64_financial_activation_grants\.sql/);
    assert.doesNotMatch(src, /MOOV_ENABLED["']?\s*:\s*["']true["']/);
  }
  assert.match(apply, /preserveExistingEnv/);
  assert.match(apply, /updateOriginVerifyRequire\('true'\)/);
  assert.match(apply, /updateOriginVerifyRequire\('false'\)/);
  assert.match(apply, /gate3d_validation_failed_rolled_back/);
  assert.match(rollback, /updateOriginVerifyRequire\('false'\)/);
  assert.doesNotMatch(rollback, /updateOriginVerifyRequire\('true'\)/);
  assert.match(preflight, /Read-only|Does not mutate AWS/);
  assert.doesNotMatch(preflight, /update-function-configuration/);
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
  assert.doesNotMatch(`${apply}${rollback}${preflight}${validate}`, /DisableExecuteApiEndpoint=true/);
  assert.doesNotMatch(apply, /GetSecretValue/);
  assert.doesNotMatch(validate, /HeaderValue\s*[:=]\s*["'][^"']{4,}/);
  assert.match(validate, /headerValuePrinted: false/);
});
