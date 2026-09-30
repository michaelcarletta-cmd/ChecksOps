#!/usr/bin/env node
/**
 * Official #539/#543 production Lambda overlay apply.
 *
 * Requires a valid signed receipt for checksops-production-prep-api.
 * Re-reads live CodeSha256 + RevisionId immediately before write (TOCTOU).
 * If production moved: STOP DEPLOYMENT_COLLISION. Do not write. Do not regenerate.
 * Uses UpdateFunctionCode with RevisionId compare-and-swap. Never changes env.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, printResult } from './lib/cli.mjs';
import { CODES, fail, ok } from './lib/errors.mjs';
import { evaluateFingerprintCas } from './lib/lambda-overlay.mjs';
import { enforceScriptGuard, enforceSharedLambdaTarget } from './require-guard.mjs';

const AWS = process.env.AWS_CLI || process.env.AWS || 'aws';
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

export function main(argv = process.argv.slice(2), env = process.env) {
  const { flags, opts } = parseArgs(argv);
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

  if (!flags.has('confirm-apply') && opts['confirm-apply'] !== true) {
    return printResult(fail(
      CODES.GUARD_APPLY_FORBIDDEN,
      'production Lambda apply requires --confirm-apply after a valid receipt; no AWS write performed',
      { receipt: authorized.details.receipt_file },
    ));
  }

  const zipPath = path.resolve(opts.zip || '');
  if (!zipPath || !fs.existsSync(zipPath)) {
    return printResult(fail(CODES.STALE_PACKAGE, 'candidate zip is required and must exist', { zip: opts.zip || null }));
  }

  const receiptFp = fingerprintFields(authorized.details.receipt.preflight_live_fingerprint);
  let immediatelyBefore;
  try {
    immediatelyBefore = readLiveLambdaFingerprint(FUNCTION_NAME, env);
  } catch (error) {
    return printResult(fail(CODES.DEPLOYMENT_COLLISION, `failed to re-read live Lambda before write: ${error.message}`));
  }

  const cas = evaluateFingerprintCas({
    preflight: receiptFp,
    immediatelyBefore,
  });
  if (!cas.ok) return printResult(cas);
  if (receiptFp.codeSha256 !== immediatelyBefore.codeSha256 || receiptFp.revisionId !== immediatelyBefore.revisionId) {
    return printResult(fail(
      CODES.DEPLOYMENT_COLLISION,
      'production Lambda changed after receipt issuance; STOP. Do not write. Do not regenerate in this write step.',
      { receipt: receiptFp, immediately_before: immediatelyBefore },
    ));
  }

  const updated = awsJson([
    'lambda', 'update-function-code',
    '--function-name', FUNCTION_NAME,
    '--zip-file', `fileb://${zipPath}`,
    '--revision-id', immediatelyBefore.revisionId,
  ], env);
  try {
    execFileSync(AWS, [
      '--region', REGION, 'lambda', 'wait', 'function-updated',
      '--function-name', FUNCTION_NAME,
    ], { encoding: 'utf8', env });
  } catch {
    /* describe below */
  }
  const after = readLiveLambdaFingerprint(FUNCTION_NAME, env);
  return printResult(ok({
    environment: 'production',
    function_name: FUNCTION_NAME,
    before: immediatelyBefore,
    update: {
      codeSha256: updated.CodeSha256 || null,
      revisionId: updated.RevisionId || null,
      lastModified: updated.LastModified || null,
    },
    after,
    env_changed: false,
    receipt: authorized.details.receipt_file,
    compare_and_swap: true,
  }));
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) process.exitCode = main();
