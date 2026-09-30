#!/usr/bin/env node
/**
 * Official SPA/index.html upload entry. Direct invocation without a receipt
 * fails closed. This phase never uploads to S3 or invalidates CloudFront.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, printResult } from './lib/cli.mjs';
import { enforceScriptGuard } from './require-guard.mjs';
import { CODES, fail } from './lib/errors.mjs';

export function main(argv = process.argv.slice(2), env = process.env) {
  const { opts } = parseArgs(argv);
  const environment = opts.environment || 'production';
  const component = opts.component || (environment === 'production' ? 'production-spa' : 'staging-frontend');
  const authorized = enforceScriptGuard({
    script: import.meta.url,
    target_environment: environment,
    target_component: component,
    deployment_type: 'spa-promote',
  });
  return printResult(fail(
    CODES.GUARD_APPLY_FORBIDDEN,
    'SPA upload is evaluate-only in this safeguard workstream; receipt was valid but no S3/CloudFront mutation is performed',
    { receipt: authorized.details.receipt_file, environment, component },
  ));
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) process.exitCode = main();
