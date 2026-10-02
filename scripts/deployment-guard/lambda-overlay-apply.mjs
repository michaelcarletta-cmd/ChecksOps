#!/usr/bin/env node
/**
 * Receipt-gated Lambda overlay apply. Starts from CURRENT live ZIP, replaces
 * only receipt-owned members, and uses RevisionId CAS. Never restores an old
 * ZIP or replaces the function from repository source.
 *
 * enforceScriptGuard runs before the apply library or live AWS adapter load.
 * Official update-function-code writer. Never call aws lambda update-function-code.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, printResult, readInput } from './lib/cli.mjs';
import { CODES, fail } from './lib/errors.mjs';
import { repoRootFrom } from './lib/paths.mjs';
import { lookupSharedLambda } from './lib/shared-targets.mjs';
import { enforceScriptGuard, resolveGuardRoot } from './require-guard.mjs';

export async function main(argv = process.argv.slice(2), env = process.env) {
  const repoRoot = repoRootFrom(import.meta.url);
  const guardRoot = resolveGuardRoot({}, env);
  const { flags, opts } = parseArgs(argv);
  const input = readInput(opts, {});
  const functionName = opts['function-name'] || input.function_name || input.target_component
    || 'checksops-staging-api';
  const shared = lookupSharedLambda(functionName) || {
    target_environment: input.target_environment || 'staging',
    target_component: input.target_component || functionName,
    deployment_type: 'lambda-overlay',
  };
  enforceScriptGuard({
    script: import.meta.url,
    target_environment: shared.target_environment,
    target_component: shared.target_component,
    deployment_type: 'lambda-overlay',
    workstream_id: input.workstream_id || env.CHECKSOPS_WORKSTREAM_ID || opts['workstream-id'],
    commit: input.commit || env.CHECKSOPS_COMMIT || opts.commit,
    receipt: input.receipt,
    receipt_path: opts.receipt || input.receipt_path,
  }, { root: guardRoot, env });

  if (flags.apply !== true && input.apply !== true) {
    return printResult(fail(
      CODES.GUARD_APPLY_FORBIDDEN,
      'lambda overlay apply requires --apply plus a valid receipt',
    ));
  }

  const [{ applyLambdaOverlay }, { createLiveAwsAdapter }] = await Promise.all([
    import('./lib/lambda-overlay-apply.mjs'),
    import('./lib/aws-adapter.mjs'),
  ]);
  const aws = createLiveAwsAdapter({
    region: env.AWS_REGION || env.AWS_DEFAULT_REGION || 'us-east-1',
  });
  const result = await applyLambdaOverlay({
    ...input,
    apply: true,
    function_name: functionName,
    workstream_id: input.workstream_id || env.CHECKSOPS_WORKSTREAM_ID || opts['workstream-id'],
    commit: input.commit || env.CHECKSOPS_COMMIT || opts.commit,
    receipt: input.receipt,
    receipt_path: opts.receipt || input.receipt_path,
    member_sources: input.member_sources,
  }, {
    env,
    guardRoot,
    repoRoot,
    aws,
    script: fileURLToPath(import.meta.url),
  });
  return printResult(result);
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: error?.code || CODES.DEPLOYMENT_COLLISION,
      message: error?.message || String(error),
      details: error?.details || {},
    }, null, 2)}\n`);
    process.exitCode = 2;
  });
}
