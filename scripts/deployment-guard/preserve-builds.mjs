#!/usr/bin/env node
/**
 * Evaluate preserve-builds isolation, main reconciliation, composition,
 * stale-artifact, exclusive-lock, and no-rollback rules. Never writes AWS.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, printResult, readInput } from './lib/cli.mjs';
import { evaluatePreserveBuilds } from './lib/preserve-builds.mjs';
import { loadContractRegistry } from './lib/contracts.mjs';
import { loadCompositionRegistry } from './lib/source-composition.mjs';
import { repoRootFrom } from './lib/paths.mjs';

export function main(argv = process.argv.slice(2), root = repoRootFrom(import.meta.url)) {
  const { flags, opts } = parseArgs(argv);
  const input = readInput(opts, {});
  const result = evaluatePreserveBuilds(input, {
    root,
    registry: flags['skip-contracts'] ? null : loadContractRegistry(root),
    compositionRegistry: loadCompositionRegistry(root),
    skip_contracts: flags['skip-contracts'] === true,
    require_mutating_only: false,
    official: true,
  });
  return printResult(result);
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) process.exitCode = main();
