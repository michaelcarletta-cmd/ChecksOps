#!/usr/bin/env node
/**
 * One runner invocation for one production SQL migration (SQL 77 to 86,
 * or any tool registered in lib/production-sql-one-shot.mjs).
 *
 *   node scripts/deployment-guard/production-sql-one-shot.mjs \
 *     --migration sql80 --approval-scope sql80 --commit <main sha> \
 *     --workstream-id <id> --operator <login> \
 *     --approval-statement "<the owner's exact words>"   (or --approval-statement-b64 <base64>) \
 *     --source-tarball /path/source-<main sha>.tar.gz \
 *     --expected-tarball-sha256 <TARBALL_SHA256 from the transfer run log> \
 *     --phase inspect|apply [--runner <instance id>]
 *
 * inspect: source checks, read-only inspect, runner contracts; writes nothing.
 * apply:   all of that again, then manifest, preflight receipt, evaluate,
 *          apply and post-apply inspect.
 *
 * Run from the extracted transfer tarball on the SQL53 runner only (see
 * ops/production-sql-one-shot.md). It takes no receipt, manifest or input file,
 * refuses to start with any CHECKSOPS_DEPLOYMENT_GUARD_* or node loader
 * variable (NODE_OPTIONS, NODE_PATH, LD_PRELOAD, ...) or node flag set, and
 * refuses a pin with execute false. The per-migration tools remain the only
 * code that connects to the database. Prints one JSON summary.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, printResult } from './lib/cli.mjs';
import { CODES, fail } from './lib/errors.mjs';
import { repoRootFrom } from './lib/paths.mjs';
import { ONE_SHOT_EXCEPTION, runProductionSqlOneShot } from './lib/production-sql-one-shot.mjs';

export function spawnRunner({ command, args, cwd, env, timeout }) {
  const res = spawnSync(command, args, { cwd, env, timeout, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, error: res.error || null };
}

export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const { opts, positional } = parseArgs(argv);
  if (positional.length) {
    return printResult(fail(CODES.INVALID_MANIFEST, 'positional arguments are not accepted', { positional }));
  }
  let result;
  try {
    result = await runProductionSqlOneShot(opts, {
      root: deps.root || repoRootFrom(import.meta.url),
      env,
      run: deps.run || spawnRunner,
      nodePath: deps.nodePath || process.execPath,
      execArgv: process.execArgv,
      ...deps,
    });
  } catch (error) {
    // runProductionSqlOneShot already catches; this keeps the one-JSON-summary promise regardless.
    result = fail(ONE_SHOT_EXCEPTION, `unexpected exception: ${String(error?.message || error).slice(0, 300)}`, { ok: false, stopped_at: 'unknown (exception)' });
  }
  return printResult(result);
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) process.exitCode = await main();
