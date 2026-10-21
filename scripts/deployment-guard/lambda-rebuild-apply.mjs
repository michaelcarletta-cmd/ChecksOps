#!/usr/bin/env node
/**
 * Receipt-gated full-package Lambda rebuild apply. Uploads the preflight's
 * candidate ZIP (built from main plus the lockfile install) only when the signed
 * receipt owns that exact ZIP SHA-256, the live package still matches the
 * receipt fingerprint (RevisionId CAS), and every live-vs-candidate difference is
 * listed in ops/deployment-guard/lambda-rebuild-plan.json.
 *
 * enforceScriptGuard runs before the apply library or live AWS adapter load.
 * Official update-function-code writer for rebuilds. Never call aws lambda
 * update-function-code directly, never restore an old ZIP.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, printResult, readInput } from './lib/cli.mjs';
import { CODES, fail } from './lib/errors.mjs';
import { REBUILD_DEPLOYMENT_TYPE } from './lib/lambda-rebuild.mjs';
import { repoRootFrom } from './lib/paths.mjs';
import { lookupSharedLambda } from './lib/shared-targets.mjs';
import { enforceScriptGuard, resolveGuardRoot } from './require-guard.mjs';

export async function main(argv = process.argv.slice(2), env = process.env) {
  const repoRoot = repoRootFrom(import.meta.url);
  const guardRoot = resolveGuardRoot({}, env);
  const { flags, opts } = parseArgs(argv);
  const input = readInput(opts, {});
  const functionName = opts['function-name'] || input.function_name || input.target_component || '';
  const shared = lookupSharedLambda(functionName);
  if (!shared) {
    return printResult(fail(CODES.UNRELATED_MUTATION, 'lambda rebuild may only target a registered shared Lambda', { function_name: functionName || null }));
  }
  enforceScriptGuard({
    script: import.meta.url,
    target_environment: shared.target_environment,
    target_component: shared.target_component,
    deployment_type: REBUILD_DEPLOYMENT_TYPE,
    workstream_id: input.workstream_id || env.CHECKSOPS_WORKSTREAM_ID || opts['workstream-id'],
    commit: input.commit || env.CHECKSOPS_COMMIT || opts.commit,
    receipt: input.receipt,
    receipt_path: opts.receipt || input.receipt_path,
  }, { root: guardRoot, env });

  if (!flags.has('apply') && input.apply !== true) {
    return printResult(fail(CODES.GUARD_APPLY_FORBIDDEN, 'lambda rebuild apply requires --apply plus a valid receipt'));
  }

  const [{ applyLambdaRebuild }, { createLiveAwsAdapter }] = await Promise.all([
    import('./lib/lambda-rebuild-apply.mjs'),
    import('./lib/aws-adapter.mjs'),
  ]);
  const aws = createLiveAwsAdapter({ region: env.AWS_REGION || env.AWS_DEFAULT_REGION || 'us-east-1' });
  const result = await applyLambdaRebuild({
    ...input,
    apply: true,
    function_name: functionName,
    workstream_id: input.workstream_id || env.CHECKSOPS_WORKSTREAM_ID || opts['workstream-id'],
    commit: input.commit || env.CHECKSOPS_COMMIT || opts.commit,
    receipt: input.receipt,
    receipt_path: opts.receipt || input.receipt_path,
  }, {
    env,
    guardRoot,
    repoRoot,
    aws,
    waitDelayMs: 1500,
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
