#!/usr/bin/env node
/**
 * Gate 3C: OPTIONS /{proxy+} NONE, strip origin header on jci10de,
 * attach REQUEST authorizer to $default in observe mode (REQUIRE=false).
 *
 * DO NOT set ORIGIN_VERIFY_REQUIRE=true. Gate 3D is a separate human approval.
 * DO NOT RUN unless CHECKSOPS_APPLY_GATE3C=I_UNDERSTAND_PRODUCTION after review.
 */
import { requireGate, refuseRequireMode, API_ID, INTEGRATION_ID, HEADER_NAME } from './lib.mjs';

refuseRequireMode();
requireGate('CHECKSOPS_APPLY_GATE3C');

console.log(JSON.stringify({
  gate: '3C',
  apiId: API_ID,
  optionsRoute: 'OPTIONS /{proxy+}',
  optionsAuthorization: 'NONE',
  integrationId: INTEGRATION_ID,
  headerRemoved: HEADER_NAME,
  attachMode: 'observe',
  ORIGIN_VERIFY_REQUIRE: false,
  note: 'Stops for review after observe attach. Does not flip require-mode.',
}));
process.exit(2);
