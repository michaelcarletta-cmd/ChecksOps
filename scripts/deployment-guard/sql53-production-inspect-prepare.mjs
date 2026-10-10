#!/usr/bin/env node
/**
 * Evaluate-only planner for the production SQL53 read-only inspect window.
 * Never sets credentials, changes IAM, updates Lambda configuration, or invokes.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, printResult, readInput } from './lib/cli.mjs';
import { evaluateSql53InspectPrepare } from './lib/sql53-production-inspect-prepare.mjs';

export function main(argv = process.argv.slice(2)) {
  const { flags, opts } = parseArgs(argv);
  const input = readInput(opts, {});
  if (flags.has('apply') || input.apply === true) {
    return printResult(evaluateSql53InspectPrepare({ ...input, apply: true }));
  }
  return printResult(evaluateSql53InspectPrepare(input));
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) process.exitCode = main();
