#!/usr/bin/env node
/**
 * Evaluate a Lambda safe overlay. Never uploads unless CHECKSOPS_DEPLOYMENT_GUARD_APPLY=1,
 * which this safeguard workstream does not set.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, printResult, readInput } from './lib/cli.mjs';
import { evaluateLambdaOverlay, planLambdaApply } from './lib/lambda-overlay.mjs';
import { createForbiddenAwsAdapter } from './lib/aws-adapter.mjs';
import { repoRootFrom } from './lib/paths.mjs';

export function main(argv = process.argv.slice(2), _root = repoRootFrom(import.meta.url), env = process.env) {
  const { flags, opts } = parseArgs(argv);
  const input = readInput(opts, {});
  const aws = createForbiddenAwsAdapter();
  const evaluation = evaluateLambdaOverlay(input);
  const planned = planLambdaApply(evaluation, { apply: flags.apply === true, env });
  planned.details = planned.details || {};
  planned.details.aws_adapter = aws.kind;
  planned.details.aws_calls = aws.calls;
  return printResult(planned);
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) process.exitCode = main();
