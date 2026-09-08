#!/usr/bin/env node
/**
 * Gate 3A plan: create secret + authorizer Lambda + unattached REQUEST authorizer.
 * REQUIRE stays false. This package does not perform the AWS writes.
 *
 * DO NOT RUN for real from this PR. Even with the gate, this script only prints
 * the plan and exits 2 so Step 3 cannot be deployed accidentally.
 */
import { requireGate, refuseRequireMode, SECRET_NAME, LAMBDA_NAME, API_ID } from './lib.mjs';

refuseRequireMode();
requireGate('CHECKSOPS_APPLY_GATE3A');

console.log(JSON.stringify({
  gate: '3A',
  secretName: SECRET_NAME,
  lambdaName: LAMBDA_NAME,
  apiId: API_ID,
  ORIGIN_VERIFY_REQUIRE: false,
  attached: false,
  secretValuePrinted: false,
  note: 'CreateSecret / CreateFunction / create-authorizer are not executed from this package.',
}));
process.exit(2);
