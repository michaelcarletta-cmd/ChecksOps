#!/usr/bin/env node
/**
 * Receipt-gated Lambda environment-variable apply. Changes only the keys the
 * reviewed plan section lists (ops/deployment-guard/lambda-config-plan.json),
 * only when the signed receipt owns that exact change SHA-256 and the live
 * RevisionId still matches the receipt fingerprint (CAS).
 *
 * enforceScriptGuard runs before the apply library or live AWS adapter load.
 * Official update-function-configuration writer. Never call
 * aws lambda update-function-configuration directly.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, printResult, readInput } from './lib/cli.mjs';
import { CODES, fail } from './lib/errors.mjs';
import { CONFIG_DEPLOYMENT_TYPE } from './lib/lambda-config.mjs';
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
    return printResult(fail(CODES.UNRELATED_MUTATION, 'lambda config may only target a registered shared Lambda', { function_name: functionName || null }));
  }
  enforceScriptGuard({
    script: import.meta.url,
    target_environment: shared.target_environment,
    target_component: shared.target_component,
    deployment_type: CONFIG_DEPLOYMENT_TYPE,
    workstream_id: input.workstream_id || env.CHECKSOPS_WORKSTREAM_ID || opts['workstream-id'],
    commit: input.commit || env.CHECKSOPS_COMMIT || opts.commit,
    receipt: input.receipt,
    receipt_path: opts.receipt || input.receipt_path,
  }, { root: guardRoot, env });

  if (!flags.has('apply') && input.apply !== true) {
    return printResult(fail(CODES.GUARD_APPLY_FORBIDDEN, 'lambda config apply requires --apply plus a valid receipt'));
  }

  const [{ applyLambdaConfig }, { createLiveAwsAdapter }] = await Promise.all([
    import('./lib/lambda-config-apply.mjs'),
    import('./lib/aws-adapter.mjs'),
  ]);
  const aws = createLiveAwsAdapter({ region: env.AWS_REGION || env.AWS_DEFAULT_REGION || 'us-east-1', environmentWrites: true });
  const result = await applyLambdaConfig({
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
