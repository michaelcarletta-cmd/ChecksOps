#!/usr/bin/env node
/**
 * Official production entry for SQL 174 (aws/workflows/sql/174_checkalt_reset_stranded_attempt.sql): the one Check Alt
 * deposit attempt stranded before the provider sign-in (2026-11-24 19:58 UTC, sign-in 504, no deposit request sent)
 * goes back to queued so the next Deposit press claims it. One new owner-only SECURITY DEFINER function,
 * aws_checkalt_reset_stranded_attempt(timestamptz, timestamptz), which the file calls once for that minute; exactly one
 * stranded attempt must be there before the apply (checkalt_stranded_attempt_in_window); no predecessor (owner
 * 2026-11-24, "start step 3"); see ops/production-sql-174-apply.md.
 *
 *   --inspect                 read-only (BEGIN READ ONLY ... ROLLBACK): catalog state, the
 *                             fingerprint, prerequisites, the declared aggregate counts and preconditions
 *   --apply --input <file>    receipt-gated apply (see lib/release-sql-production-cli.mjs and
 *                             ops/production-sql-174-apply.md)
 *
 * Credentials come only from the pinned production admin secret. Run only on a host with
 * private reachability into the production VPC; never from GitHub-hosted runners or Lambda.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoRootFrom } from './lib/paths.mjs';
import { runReleaseProductionTool } from './lib/release-sql-production-cli.mjs';
import { enforceScriptGuard } from './require-guard.mjs';

export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  return runReleaseProductionTool(
    { key: 'sql174', scriptUrl: import.meta.url, enforceScriptGuard },
    argv,
    env,
    { root: repoRootFrom(import.meta.url), ...deps },
  );
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  const code = await main();
  process.exitCode = typeof code === 'number' ? code : (code ? 0 : 1);
}
