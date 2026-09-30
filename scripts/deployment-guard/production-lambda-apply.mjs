#!/usr/bin/env node
/**
 * Official production Lambda overlay apply for checksops-production-prep-api.
 * Requires a valid signed production receipt, lease, and immediately-before
 * fingerprint that matches the reviewed baseline. Overlay-only. Never
 * restores an older package. Never changes configuration or provider flags.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, printResult } from './lib/cli.mjs';
import { CODES, fail, ok } from './lib/errors.mjs';
import { evaluateFingerprintCas } from './lib/lambda-overlay.mjs';
import { enforceScriptGuard, enforceSharedLambdaTarget } from './require-guard.mjs';
import {
  OWNED_LAMBDA_MEMBERS,
  CURRENT_LIVE_PRODUCTION_LAMBDA,
  evaluateReviewedBaselineMatch,
} from '../lib/settings-billing-branding-deposits.mjs';

const AWS = process.env.AWS_CLI || process.env.AWS || `${process.env.HOME}/.local/bin/aws`;
const REGION = process.env.AWS_REGION || 'us-east-1';
const FUNCTION_NAME = 'checksops-production-prep-api';

function awsJson(args, env = process.env) {
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
    encoding: 'utf8',
    env,
    maxBuffer: 16 * 1024 * 1024,
  });
  return out.trim() ? JSON.parse(out) : {};
}

export function readLiveLambdaFingerprint(functionName = FUNCTION_NAME, env = process.env) {
  const cfg = awsJson(['lambda', 'get-function-configuration', '--function-name', functionName], env);
  return {
    codeSha256: cfg.CodeSha256 || null,
    revisionId: cfg.RevisionId || null,
    lastModified: cfg.LastModified || null,
    codeSize: cfg.CodeSize || null,
  };
}

function fingerprintFields(value) {
  if (!value || typeof value !== 'object') return { codeSha256: null, revisionId: null };
  return {
    codeSha256: value.codeSha256 || value.CodeSha256 || null,
    revisionId: value.revisionId || value.RevisionId || null,
  };
}

export function evaluateProductionLambdaPolicy({
  environment,
  functionName,
  confirmApply,
  zipPath,
  receiptFingerprint,
  immediatelyBefore,
  reviewed = CURRENT_LIVE_PRODUCTION_LAMBDA,
} = {}) {
  if (environment === 'staging' || functionName === 'checksops-staging-api') {
    return fail(CODES.GUARD_APPLY_FORBIDDEN, 'production-lambda-apply must never target staging');
  }
  if (functionName && functionName !== FUNCTION_NAME) {
    return fail(CODES.GUARD_APPLY_FORBIDDEN, 'production-lambda-apply may only target checksops-production-prep-api', {
      function_name: functionName,
    });
  }
  if (!confirmApply) {
    return fail(
      CODES.GUARD_APPLY_FORBIDDEN,
      'production Lambda apply requires --confirm-apply after a valid receipt; no AWS write performed',
    );
  }
  if (!zipPath || !fs.existsSync(zipPath)) {
    return fail(CODES.STALE_PACKAGE, 'fresh overlay zip is required and must exist', { zip: zipPath || null });
  }
  const baseline = evaluateReviewedBaselineMatch({
    kind: 'lambda',
    reviewed: { codeSha256: reviewed.codeSha256, revisionId: reviewed.revisionId },
    live: immediatelyBefore,
  });
  if (!baseline.ok) {
    return fail(baseline.code, baseline.message, { diffs: baseline.diffs, reviewed, live: immediatelyBefore });
  }
  const cas = evaluateFingerprintCas({
    preflight: receiptFingerprint,
    immediatelyBefore,
  });
  if (!cas.ok) return cas;
  return ok({
    overlay_allowed: true,
    owned_members: OWNED_LAMBDA_MEMBERS.slice(),
    revision_id: immediatelyBefore.revisionId,
  });
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const { flags, opts } = parseArgs(argv);
  const environment = opts.environment || 'production';
  if (environment !== 'production') {
    return printResult(fail(CODES.GUARD_APPLY_FORBIDDEN, 'production-lambda-apply must target production only'));
  }
  const authorized = enforceScriptGuard({
    script: import.meta.url,
    target_environment: 'production',
    target_component: FUNCTION_NAME,
    deployment_type: 'lambda-overlay',
    workstream_id: opts['workstream-id'],
    commit: opts.commit,
  });
  enforceSharedLambdaTarget({
    script: import.meta.url,
    functionName: FUNCTION_NAME,
    workstream_id: opts['workstream-id'],
    commit: opts.commit,
  });

  const immediatelyBefore = readLiveLambdaFingerprint(FUNCTION_NAME, env);
  const policy = evaluateProductionLambdaPolicy({
    environment,
    functionName: opts.function || FUNCTION_NAME,
    confirmApply: flags.has('confirm-apply') || opts['confirm-apply'] === true,
    zipPath: opts.zip ? path.resolve(opts.zip) : '',
    receiptFingerprint: fingerprintFields(authorized.details.receipt.preflight_live_fingerprint),
    immediatelyBefore,
  });
  if (!policy.ok) return printResult(policy);

  const zipPath = path.resolve(opts.zip);
  const updated = awsJson([
    'lambda', 'update-function-code',
    '--function-name', FUNCTION_NAME,
    '--zip-file', `fileb://${zipPath}`,
    '--revision-id', immediatelyBefore.revisionId,
  ], env);
  const after = readLiveLambdaFingerprint(FUNCTION_NAME, env);
  return printResult(ok({
    environment: 'production',
    function_name: FUNCTION_NAME,
    before: immediatelyBefore,
    after,
    codeSha256: updated.CodeSha256 || after.codeSha256,
    revisionId: updated.RevisionId || after.revisionId,
    owned_members: OWNED_LAMBDA_MEMBERS.slice(),
    receipt: authorized.details.receipt_file,
    configuration_untouched: true,
    homeowner_untouched: true,
  }));
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) process.exitCode = main();
