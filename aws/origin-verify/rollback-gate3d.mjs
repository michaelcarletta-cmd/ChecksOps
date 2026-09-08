#!/usr/bin/env node
/**
 * Gate 3D rollback: set ORIGIN_VERIFY_REQUIRE=false on the authorizer Lambda only.
 * Independent of apply. Preserves every other existing environment variable.
 * Uses RevisionId. Re-reads Lambda and requires REQUIRE=false plus CloudFront/raw health.
 * Does not touch CloudFront, WAF, HTTP API routes, or DisableExecuteApiEndpoint.
 */
import { LAMBDA_NAME, requireGate, requireStep3Temp, shouldExecute } from './lib.mjs';
import {
  REQUIRE_KEY,
  rollbackOriginVerifyRequireAndConfirm,
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
  revisionIdRequired: true,
  DisableExecuteApiEndpoint: false,
  cloudfront: 'unchanged',
  waf: 'unchanged',
  spaDnsCognitoRds: 'unchanged',
  financialSql: 'not_applied',
  confirmRequireFalse: true,
  confirmCloudfrontAndRawHealth: true,
  operatorPath: 'aws/origin-verify/operator-rollback-gate3d.mjs',
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
const rollback = await rollbackOriginVerifyRequireAndConfirm();
console.log(JSON.stringify({
  ...plan,
  mode: 'executed',
  identity,
  rollback,
  secretPrinted: false,
}));
