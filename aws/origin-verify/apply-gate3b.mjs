#!/usr/bin/env node
/**
 * Gate 3B: add CloudFront origin header on ProductionPrepHttpApi.
 * Waits for Deployed. Does not attach the authorizer. Does not print the secret.
 *
 * DO NOT RUN unless CHECKSOPS_APPLY_GATE3B=I_UNDERSTAND_PRODUCTION after review.
 */
import { requireGate, refuseRequireMode, HEADER_NAME, DISTRIBUTION_ID } from './lib.mjs';

refuseRequireMode();
requireGate('CHECKSOPS_APPLY_GATE3B');

console.log(JSON.stringify({
  gate: '3B',
  distributionId: DISTRIBUTION_ID,
  originId: 'ProductionPrepHttpApi',
  headerName: HEADER_NAME,
  headerValuePrinted: false,
  note: 'Operator applies via redacting GetDistributionConfig + UpdateDistribution. This script refuses to dump config.',
}));
process.exit(2);
