#!/usr/bin/env node
/**
 * Official production entry for SQL 100 (aws/workflows/sql/100_mortgage_desk_live_access.sql):
 * it records the Mortgage Desk access production already has (three helpers, the five
 * mortgage_handling_requests policies, the table and column grants). Needs SQL 90.
 *
 * On production SQL 100 is a strict no-op, so this tool never runs the file there: an apply is
 * refused unless the live state is already the intended fingerprint
 * (production_state_already_intended), and then refused as already in place. The read-only
 * --inspect (already_applied true, policy comments and grantors included in the fingerprint)
 * is the production record.
 *
 *   --inspect                 read-only (BEGIN READ ONLY ... ROLLBACK): catalog state, the
 *                             fingerprint, prerequisites, predecessors and preconditions;
 *                             reads no table rows
 *   --apply --input <file>    receipt-gated, and always refused on production (see above)
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
    { key: 'sql100', scriptUrl: import.meta.url, enforceScriptGuard },
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
