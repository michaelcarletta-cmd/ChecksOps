#!/usr/bin/env node
/**
 * Privileged-operator Gate 3D apply. Do not run as Step3Temp.
 * Keep Step3Temp kms:* deny. Do not broaden that role.
 *
 * Changes only checksops-production-origin-verify environment:
 * preserve every existing variable and set ORIGIN_VERIFY_REQUIRE=true.
 * Uses RevisionId. Requires CHECKSOPS_GATE3D_ID_TOKEN for live apply.
 * Never prints the token, secret, hash, prefix, or HeaderValue.
 *
 * Plan (default): prints guards and exits 2.
 * Apply: CHECKSOPS_OPERATOR_GATE3D=I_UNDERSTAND_PRODUCTION
 *        CHECKSOPS_OPERATOR_EXECUTE=1
 *        CHECKSOPS_GATE3D_ID_TOKEN=<id token, not printed>
 */
import { LAMBDA_NAME, awsJson } from './lib.mjs';
import {
  REQUIRE_KEY,
  collectObserveAndHolds,
  collectPreflight,
  evaluatePreflight,
  idTokenPresent,
  mergeOriginVerifyRequire,
  refuseStep3Temp,
  requireLiveIdToken,
  rollbackOriginVerifyRequireAndConfirm,
  updateOriginVerifyRequire,
  waitForLambdaReady,
} from './gate3d-lib.mjs';
import { validateGate3d } from './validate-gate3d.mjs';

const plan = {
  gate: '3D',
  operatorOnly: true,
  doNotUseStep3Temp: true,
  doNotBroadenStep3TempKms: true,
  lambdaName: LAMBDA_NAME,
  change: `${REQUIRE_KEY}=true`,
  preserveExistingEnv: true,
  onlyAuthorizerLambdaEnv: true,
  revisionIdRequired: true,
  idTokenRequired: true,
  idTokenPrinted: false,
  DisableExecuteApiEndpoint: false,
  cloudfront: 'unchanged',
  waf: 'unchanged',
  secretPrinted: false,
};

if (String(process.env.CHECKSOPS_OPERATOR_GATE3D || '') !== 'I_UNDERSTAND_PRODUCTION'
  || String(process.env.CHECKSOPS_OPERATOR_EXECUTE || '') !== '1') {
  console.log(JSON.stringify({
    ...plan,
    mode: 'plan',
    note: 'Plan only. Privileged operator sets CHECKSOPS_OPERATOR_GATE3D=I_UNDERSTAND_PRODUCTION and CHECKSOPS_OPERATOR_EXECUTE=1. Do not use Step3Temp. Live apply requires CHECKSOPS_GATE3D_ID_TOKEN.',
  }));
  process.exit(2);
}

if (!idTokenPresent()) {
  console.error('CHECKSOPS_GATE3D_ID_TOKEN_required');
  process.exit(2);
}
requireLiveIdToken();

const identity = awsJson(['sts', 'get-caller-identity']);
refuseStep3Temp(identity.Arn);

const base = collectPreflight();
const observe = await collectObserveAndHolds();
const preflight = evaluatePreflight(base, observe, { requireStep3TempCaller: false });
if (!preflight.ok) {
  console.log(JSON.stringify({ gate: '3D', mode: 'preflight_refused', operatorOnly: true, checks: preflight.checks }));
  throw new Error('gate3d_preflight_refused');
}

const before = awsJson(['lambda', 'get-function-configuration', '--function-name', LAMBDA_NAME]);
const merged = mergeOriginVerifyRequire(before.Environment?.Variables || {}, 'true');

let applied = false;
try {
  const updated = updateOriginVerifyRequire('true');
  applied = true;
  waitForLambdaReady();
  await new Promise((r) => setTimeout(r, 2000));
  const report = await validateGate3d({ requireMode: true });
  if (!report.ok) {
    const rollback = await rollbackOriginVerifyRequireAndConfirm();
    console.log(JSON.stringify({
      ...plan,
      mode: 'rolled_back',
      preservedKeys: merged.preservedKeys,
      validation: report.checks,
      rollback,
    }));
    throw new Error('gate3d_validation_failed_rolled_back');
  }
  console.log(JSON.stringify({
    ...plan,
    mode: 'executed',
    requireFlag: updated.requireFlag,
    preservedKeys: merged.preservedKeys,
    envKeys: updated.envKeys,
    revisionIdUsed: Boolean(updated.revisionIdUsed),
    validation: report.checks,
    executeApiEnabled: report.executeApiEnabled,
  }));
} catch (err) {
  if (applied && !String(err?.message || '').includes('rolled_back') && !String(err?.message || '').includes('GATE3D_ROLLBACK_FATAL')) {
    await rollbackOriginVerifyRequireAndConfirm();
  }
  throw err;
}
