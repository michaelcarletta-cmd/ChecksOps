#!/usr/bin/env node
/**
 * Official production entry for SQL 153 (aws/workflows/sql/153_second_mortgagee_fee.sql): the flat $5 for a check's 2nd
 * mortgage company (owner 2026-11-10/11: "Flat $5", "it should be an additional $5 if 2 mortgage companies are on
 * check"). The partial unique index check_billing_events_one_second_mortgagee_per_check and two integer columns on
 * tenant_maintenance_payments; the file's event_type CHECK step is not modelled and requires that no such CHECK exists
 * (no_event_type_check); see ops/production-sql-153-apply.md.
 *
 *   --inspect                 read-only (BEGIN READ ONLY ... ROLLBACK): catalog state, the
 *                             fingerprint, prerequisites, the predecessor and preconditions; reads no table rows
 *   --apply --input <file>    receipt-gated apply (see lib/release-sql-production-cli.mjs and
 *                             ops/production-sql-153-apply.md)
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
    { key: 'sql153', scriptUrl: import.meta.url, enforceScriptGuard },
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
