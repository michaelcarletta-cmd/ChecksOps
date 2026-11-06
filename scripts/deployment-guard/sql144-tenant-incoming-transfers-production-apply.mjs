#!/usr/bin/env node
/**
 * Official production entry for SQL 144 (aws/workflows/sql/144_tenant_incoming_transfers.sql): an
 * organization reads the payments other organizations sent into its wallet. The new SECURITY DEFINER
 * get_tenant_incoming_transfers(uuid) re-checks the API's tenant gate in the database
 * (aws_can_access_tenant, 42501) and returns the send legs whose destination_tenant_id is that
 * organization, with narrow columns and check context only for a check the sender shares with it;
 * EXECUTE for checksops and the owner; no predecessor (owner 2026-11-06, "yes build it, include partner
 * payments as income not tax"); see ops/production-sql-144-apply.md.
 *
 *   --inspect                 read-only (BEGIN READ ONLY ... ROLLBACK): catalog state, the
 *                             fingerprint, prerequisites and preconditions; reads no table rows
 *   --apply --input <file>    receipt-gated apply (see lib/release-sql-production-cli.mjs and
 *                             ops/production-sql-144-apply.md)
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
    { key: 'sql144', scriptUrl: import.meta.url, enforceScriptGuard },
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
