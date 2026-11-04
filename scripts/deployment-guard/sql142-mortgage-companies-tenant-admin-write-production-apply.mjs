#!/usr/bin/env node
/**
 * Official production entry for SQL 142
 * (aws/workflows/sql/142_mortgage_companies_tenant_admin_write.sql): tenant admins may add and edit the
 * shared mortgage company directory. Two PERMISSIVE policies TO authenticated on public.mortgage_companies,
 * aws_insert_mortgage_companies_tenant_admin FOR INSERT and aws_update_mortgage_companies_tenant_admin FOR
 * UPDATE, on public.aws_is_tenant_manager_admin() AND is_active; the platform-owner policy
 * aws_write_mortgage_companies must be intact and is not changed. No predecessor. Production is unverified
 * until a read-only inspect; see ops/production-sql-142-apply.md.
 *
 *   --inspect                 read-only (BEGIN READ ONLY ... ROLLBACK): catalog state, the
 *                             fingerprint, prerequisites and preconditions; reads no table rows (catalog counts only)
 *   --apply --input <file>    receipt-gated apply (see lib/release-sql-production-cli.mjs and
 *                             ops/production-sql-142-apply.md)
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
    { key: 'sql142', scriptUrl: import.meta.url, enforceScriptGuard },
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
