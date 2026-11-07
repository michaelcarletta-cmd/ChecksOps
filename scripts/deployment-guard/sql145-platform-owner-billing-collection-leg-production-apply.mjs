#!/usr/bin/env node
/**
 * Official production entry for SQL 145 (aws/workflows/sql/145_platform_owner_billing_collection_leg.sql): the
 * platform owner's fee collection records its payment_transfers leg. The new SECURITY DEFINER
 * aws_platform_owner_insert_billing_collection_leg(...) inserts only a tenant-collection-v2 leg of an existing
 * obligation, for the platform owner (is_platform_owner(), 42501) on a server write path (aws_money_write_allowed(),
 * 42501); EXECUTE for checksops and the owner; no predecessor (owner 2026-11-07, "build the fee leg fix"); see
 * ops/production-sql-145-apply.md.
 *
 *   --inspect                 read-only (BEGIN READ ONLY ... ROLLBACK): catalog state, the
 *                             fingerprint, prerequisites and preconditions; reads no table rows
 *   --apply --input <file>    receipt-gated apply (see lib/release-sql-production-cli.mjs and
 *                             ops/production-sql-145-apply.md)
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
    { key: 'sql145', scriptUrl: import.meta.url, enforceScriptGuard },
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
