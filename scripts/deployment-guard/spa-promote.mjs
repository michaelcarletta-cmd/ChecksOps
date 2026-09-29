#!/usr/bin/env node
/**
 * Evaluate SPA / CloudFront promote safety. Does not upload or invalidate.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, printResult, readInput } from './lib/cli.mjs';
import { evaluateSpaPromote } from './lib/spa-promote.mjs';
import { repoRootFrom } from './lib/paths.mjs';

export function main(argv = process.argv.slice(2), _root = repoRootFrom(import.meta.url)) {
  const { opts } = parseArgs(argv);
  return printResult(evaluateSpaPromote(readInput(opts, {})));
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) process.exitCode = main();
