#!/usr/bin/env node
/**
 * Compare preflight vs immediately-before live fingerprints. No AWS writes.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, printResult, readInput } from './lib/cli.mjs';
import { verifyLiveState } from './lib/verify-live.mjs';
import { repoRootFrom } from './lib/paths.mjs';

export function main(argv = process.argv.slice(2), _root = repoRootFrom(import.meta.url)) {
  const { opts } = parseArgs(argv);
  return printResult(verifyLiveState(readInput(opts, {})));
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) process.exitCode = main();
