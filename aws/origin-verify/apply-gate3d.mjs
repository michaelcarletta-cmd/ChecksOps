#!/usr/bin/env node
/**
 * Gate 3D apply: ORIGIN_VERIFY_REQUIRE=true on checksops-production-origin-verify only.
 * STOP FOR REVIEW. Do not execute from the design PR.
 *
 * Requires all three:
 *   CHECKSOPS_APPLY_GATE3D=I_UNDERSTAND_PRODUCTION
 *   CHECKSOPS_GATE3D_ENFORCE=I_ACCEPT_REQUIRE_MODE
 *   CHECKSOPS_STEP3_EXECUTE=1
 *
 * Preserves every existing Lambda environment variable.
 * Rolls back to ORIGIN_VERIFY_REQUIRE=false if CloudFront/API validation fails.
 * Does not disable execute-api. Does not modify CloudFront, WAF, SPA, DNS,
 * Cognito, RDS, prep Lambda, or financial/provider flags.
 */
import {
  LAMBDA_NAME,
  requireGate,
  requireStep3Temp,
  shouldExecute,
} from './lib.mjs';
import {
  REQUIRE_KEY,
  collectObserveAndHolds,
  collectPreflight,
  evaluatePreflight,
  mergeOriginVerifyRequire,
  updateOriginVerifyRequire,
  waitForLambdaReady,
} from './gate3d-lib.mjs';
import { validateGate3d } from './validate-gate3d.mjs';
import { awsJson } from './lib.mjs';

requireGate('CHECKSOPS_APPLY_GATE3D');
requireGate('CHECKSOPS_GATE3D_ENFORCE', 'I_ACCEPT_REQUIRE_MODE');

const plan = {
  gate: '3D',
  lambdaName: LAMBDA_NAME,
  change: `${REQUIRE_KEY}=true`,
  preserveExistingEnv: true,
  onlyAuthorizerLambdaEnv: true,
  DisableExecuteApiEndpoint: false,
  cloudfront: 'unchanged',
  waf: 'unchanged',
  spaDnsCognitoRds: 'unchanged',
  financialSql: 'not_applied',
  automaticRollback: `${REQUIRE_KEY}=false if CloudFront/API validation fails`,
  independentRollback: 'node aws/origin-verify/rollback-gate3d.mjs',
};

if (!shouldExecute()) {
  console.log(JSON.stringify({
    ...plan,
    mode: 'plan',
    note: 'Plan only. STOP FOR REVIEW. Do not execute Gate 3D from this PR.',
  }));
  process.exit(2);
}

const identity = requireStep3Temp();
const base = collectPreflight();
const observe = await collectObserveAndHolds();
const preflight = evaluatePreflight(base, observe);
if (!preflight.ok) {
  console.log(JSON.stringify({ gate: '3D', mode: 'preflight_refused', checks: preflight.checks }));
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
    updateOriginVerifyRequire('false');
    waitForLambdaReady();
    console.log(JSON.stringify({
      ...plan,
      mode: 'rolled_back',
      identity,
      preservedKeys: merged.preservedKeys,
      validation: report.checks,
      secretPrinted: false,
    }));
    throw new Error('gate3d_validation_failed_rolled_back');
  }
  console.log(JSON.stringify({
    ...plan,
    mode: 'executed',
    identity,
    requireFlag: updated.requireFlag,
    preservedKeys: merged.preservedKeys,
    envKeys: updated.envKeys,
    validation: report.checks,
    executeApiEnabled: report.executeApiEnabled,
    secretPrinted: false,
  }));
} catch (err) {
  if (applied && !String(err?.message || '').includes('rolled_back')) {
    try {
      updateOriginVerifyRequire('false');
      waitForLambdaReady();
    } catch {
      console.error('GATE3D_ROLLBACK_FAILED');
    }
  }
  throw err;
}
