#!/usr/bin/env node
/**
 * Gate 3D rollback: set ORIGIN_VERIFY_REQUIRE=false on the authorizer Lambda only.
 * Independent of apply. Preserves every other existing environment variable.
 * Does not touch CloudFront, WAF, HTTP API routes, or DisableExecuteApiEndpoint.
 */
import { LAMBDA_NAME, awsJson, requireGate, requireStep3Temp, shouldExecute } from './lib.mjs';
import {
  REQUIRE_KEY,
  mergeOriginVerifyRequire,
  requireFlagValue,
  updateOriginVerifyRequire,
  waitForLambdaReady,
} from './gate3d-lib.mjs';

if (String(process.env.CHECKSOPS_ROLLBACK_GATE || '') !== '3D') {
  console.error('Set CHECKSOPS_ROLLBACK_GATE=3D');
  process.exit(2);
}
requireGate('CHECKSOPS_APPLY_ROLLBACK');

const plan = {
  gate: '3D',
  action: 'rollback',
  lambdaName: LAMBDA_NAME,
  change: `${REQUIRE_KEY}=false`,
  preserveExistingEnv: true,
  DisableExecuteApiEndpoint: false,
  cloudfront: 'unchanged',
  waf: 'unchanged',
  spaDnsCognitoRds: 'unchanged',
  financialSql: 'not_applied',
};

if (!shouldExecute()) {
  console.log(JSON.stringify({
    ...plan,
    mode: 'plan',
    note: 'Plan only. Set CHECKSOPS_STEP3_EXECUTE=1 to roll back independently.',
  }));
  process.exit(2);
}

const identity = requireStep3Temp();
const before = awsJson(['lambda', 'get-function-configuration', '--function-name', LAMBDA_NAME]);
const merged = mergeOriginVerifyRequire(before.Environment?.Variables || {}, 'false');
const after = updateOriginVerifyRequire('false');
waitForLambdaReady();
const api = awsJson(['apigatewayv2', 'get-api', '--api-id', 'kiqojucc02']);

console.log(JSON.stringify({
  ...plan,
  mode: 'executed',
  identity,
  requireFlagBefore: requireFlagValue(before) ?? '<unset>',
  requireFlagAfter: after.requireFlag,
  preservedKeys: merged.preservedKeys,
  executeApiEnabled: api.DisableExecuteApiEndpoint === false,
  secretPrinted: false,
}));
