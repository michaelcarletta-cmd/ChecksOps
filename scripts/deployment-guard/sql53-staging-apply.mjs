#!/usr/bin/env node
/**
 * Evaluate-only staging SQL 53 authorization.
 * Does not connect to a database, invoke AWS, or apply SQL.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, printResult, readInput } from './lib/cli.mjs';
import { repoRootFrom } from './lib/paths.mjs';
import { evaluateSql53StagingApply } from './lib/sql53-staging-apply.mjs';

export function main(argv = process.argv.slice(2), root = repoRootFrom(import.meta.url)) {
  const { opts } = parseArgs(argv);
  return printResult(evaluateSql53StagingApply(readInput(opts, {}), { root }));
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) process.exitCode = main();
