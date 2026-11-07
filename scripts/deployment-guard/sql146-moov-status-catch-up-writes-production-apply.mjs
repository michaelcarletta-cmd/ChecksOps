#!/usr/bin/env node
/**
 * Official production entry for SQL 146 (aws/workflows/sql/146_moov_status_catch_up_writes.sql): the Moov status
 * catch-up locks its rows and writes a fee collection leg's Moov status. The new SECURITY DEFINER
 * aws_moov_catch_up_lock_rows(...) and aws_moov_apply_collection_leg_status(...) run only in the Moov webhook apply
 * context (aws_moov_webhook_apply_active(), 42501), the lock for the platform owner only and the leg writer for the
 * platform owner or no user (42501); EXECUTE for checksops and the owner; no predecessor (owner 2026-11-07, "build the
 * catch-up update fix"); see ops/production-sql-146-apply.md.
 *
 *   --inspect                 read-only (BEGIN READ ONLY ... ROLLBACK): catalog state, the
 *                             fingerprint, prerequisites and preconditions; reads no table rows
 *   --apply --input <file>    receipt-gated apply (see lib/release-sql-production-cli.mjs and
 *                             ops/production-sql-146-apply.md)
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
    { key: 'sql146', scriptUrl: import.meta.url, enforceScriptGuard },
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
