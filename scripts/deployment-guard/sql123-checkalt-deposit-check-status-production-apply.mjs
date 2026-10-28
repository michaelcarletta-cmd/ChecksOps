#!/usr/bin/env node
/**
 * Official production entry for SQL 123 (aws/workflows/sql/123_checkalt_deposit_check_status.sql):
 * a Check Alt deposit approved or accepted moves its check to Deposited; rejected, error, duplicate or
 * returned after approval moves it to Returned. Two SECURITY DEFINER functions with EXECUTE for the
 * owner only (aws_checkalt_mark_check_deposited, aws_apply_checkalt_check_status) and the trigger
 * aws_checkalt_deposit_apply_check_status on checkalt_deposits, which fires before SQL 120's and
 * SQL 121's; a one-time move of checks already approved and billed; see
 * ops/production-sql-123-apply.md.
 *
 *   --inspect                 read-only (BEGIN READ ONLY ... ROLLBACK): catalog state, the
 *                             fingerprint, prerequisites, preconditions and the declared counts
 *   --apply --input <file>    receipt-gated apply (see lib/release-sql-production-cli.mjs and
 *                             ops/production-sql-123-apply.md)
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
    { key: 'sql123', scriptUrl: import.meta.url, enforceScriptGuard },
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
