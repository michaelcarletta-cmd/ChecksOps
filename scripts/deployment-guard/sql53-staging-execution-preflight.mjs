#!/usr/bin/env node
/**
 * Evaluate-only staging SQL 53 execution preflight.
 * Does not connect to a database, invoke AWS, issue a receipt, or apply SQL.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, printResult, readInput } from './lib/cli.mjs';
import { repoRootFrom } from './lib/paths.mjs';
import {
  evaluateSql53FailClosedSurfaces,
  evaluateSql53StagingExecutionPreflight,
} from './lib/sql53-staging-execution-preflight.mjs';

export function main(argv = process.argv.slice(2), root = repoRootFrom(import.meta.url)) {
  const { opts } = parseArgs(argv);
  const input = readInput(opts, {});
  const preflight = evaluateSql53StagingExecutionPreflight(input, { root });
  if (!preflight.ok) return printResult(preflight);
  const failClosed = evaluateSql53FailClosedSurfaces(input, { root });
  if (!failClosed.ok) return printResult(failClosed);
  return printResult({
    ...preflight,
    details: {
      ...preflight.details,
      fail_closed: failClosed.details,
    },
  });
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) process.exitCode = main();
