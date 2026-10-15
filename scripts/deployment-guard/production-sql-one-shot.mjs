#!/usr/bin/env node
/**
 * One runner invocation for one production SQL migration (SQL 77, 78, 79, 80,
 * or any tool registered in lib/production-sql-one-shot.mjs).
 *
 *   node scripts/deployment-guard/production-sql-one-shot.mjs \
 *     --migration sql80 --commit <main sha> --workstream-id <id> \
 *     --approval-statement "<the owner's exact words>" \
 *     --source-tarball /path/source-<main sha>.tar.gz \
 *     --phase inspect|apply [--runner <instance id>] [--operator <login>]
 *
 * inspect: source checks, read-only inspect, runner contracts; writes nothing.
 * apply:   all of that again, then manifest, preflight receipt, evaluate,
 *          apply and post-apply inspect.
 *
 * Run from the extracted transfer tarball on the SQL53 runner only (see
 * ops/production-sql-one-shot.md). It takes no receipt, manifest or input file,
 * refuses to start with any CHECKSOPS_DEPLOYMENT_GUARD_* variable set, and
 * refuses a pin with execute false. The per-migration tools remain the only
 * code that connects to the database. Prints one JSON summary.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, printResult } from './lib/cli.mjs';
import { CODES, fail } from './lib/errors.mjs';
import { repoRootFrom } from './lib/paths.mjs';
import { runProductionSqlOneShot } from './lib/production-sql-one-shot.mjs';

export function spawnRunner({ command, args, cwd, env, timeout }) {
  const res = spawnSync(command, args, { cwd, env, timeout, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, error: res.error || null };
}

export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const { opts, positional } = parseArgs(argv);
  if (positional.length) {
    return printResult(fail(CODES.INVALID_MANIFEST, 'positional arguments are not accepted', { positional }));
  }
  const result = await runProductionSqlOneShot(opts, {
    root: deps.root || repoRootFrom(import.meta.url),
    env,
    run: deps.run || spawnRunner,
    nodePath: deps.nodePath || process.execPath,
    ...deps,
  });
  return printResult(result);
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) process.exitCode = await main();
