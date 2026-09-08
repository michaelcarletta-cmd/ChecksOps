#!/usr/bin/env node
/**
 * Privileged-operator Gate 3D rollback. Do not run as Step3Temp.
 * Keep Step3Temp kms:* deny. Do not broaden that role.
 *
 * Changes only checksops-production-origin-verify environment:
 * preserve every existing variable and set ORIGIN_VERIFY_REQUIRE=false.
 * Uses RevisionId. Re-reads Lambda and requires REQUIRE=false plus
 * CloudFront and raw health. Fatal if that cannot be confirmed.
 */
import { LAMBDA_NAME, awsJson } from './lib.mjs';
import {
  REQUIRE_KEY,
  refuseStep3Temp,
  rollbackOriginVerifyRequireAndConfirm,
} from './gate3d-lib.mjs';

const plan = {
  gate: '3D',
  action: 'rollback',
  operatorOnly: true,
  doNotUseStep3Temp: true,
  doNotBroadenStep3TempKms: true,
  lambdaName: LAMBDA_NAME,
  change: `${REQUIRE_KEY}=false`,
  preserveExistingEnv: true,
  revisionIdRequired: true,
  DisableExecuteApiEndpoint: false,
  cloudfront: 'unchanged',
  waf: 'unchanged',
  confirmRequireFalse: true,
  confirmCloudfrontAndRawHealth: true,
  secretPrinted: false,
};

if (String(process.env.CHECKSOPS_OPERATOR_ROLLBACK_GATE3D || '') !== 'I_UNDERSTAND_PRODUCTION'
  || String(process.env.CHECKSOPS_OPERATOR_EXECUTE || '') !== '1') {
  console.log(JSON.stringify({
    ...plan,
    mode: 'plan',
    note: 'Plan only. Privileged operator sets CHECKSOPS_OPERATOR_ROLLBACK_GATE3D=I_UNDERSTAND_PRODUCTION and CHECKSOPS_OPERATOR_EXECUTE=1. Do not use Step3Temp.',
  }));
  process.exit(2);
}

const identity = awsJson(['sts', 'get-caller-identity']);
refuseStep3Temp(identity.Arn);
const rollback = await rollbackOriginVerifyRequireAndConfirm();
console.log(JSON.stringify({
  ...plan,
  mode: 'executed',
  rollback,
}));
