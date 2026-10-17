#!/usr/bin/env node
/**
 * Official production entry for SQL 98 (aws/workflows/sql/98_tenant_fee_collection.sql): manual
 * tenant fee collection (per-check price stamping, one charge per tenant period, the
 * platform-owner-only fee destination, the append-only billing audit and invoice outbox) and
 * the per-tenant deposits switch (tenants.deposits_enabled, its reader, setter and audit, and
 * SQL 96's column guard replaced). Needs SQL 96.
 *
 *   --inspect                 read-only (BEGIN READ ONLY ... ROLLBACK): catalog state, the
 *                             fingerprint, prerequisites, predecessors and preconditions;
 *                             of table rows only aggregate COUNT(*)s (duplicate tenant
 *                             periods, duplicate check billing events, check_billing_config rows)
 *   --apply --input <file>    receipt-gated apply (see lib/release-sql-production-cli.mjs and
 *                             ops/production-sql-90-97-apply.md)
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
    { key: 'sql98', scriptUrl: import.meta.url, enforceScriptGuard },
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
