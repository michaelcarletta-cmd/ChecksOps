#!/usr/bin/env node
/**
 * Official production entry for SQL 139
 * (aws/workflows/sql/139_tenant_billing_accounts_write_policy_reconcile.sql): the authenticated write
 * policy aws_write_tenant_billing_accounts on public.tenant_billing_accounts replaced with the
 * repository's SQL 24 policy (FOR ALL TO authenticated USING / WITH CHECK
 * public.aws_can_write_tenant(tenant_id)), refused unless the live-only machine policy
 * aws_write_tenant_billing_accounts_job is intact. No predecessor. Production is unverified until a
 * read-only inspect; see ops/production-sql-139-apply.md.
 *
 *   --inspect                 read-only (BEGIN READ ONLY ... ROLLBACK): catalog state, the
 *                             fingerprint, prerequisites and preconditions; reads no table rows (catalog counts only)
 *   --apply --input <file>    receipt-gated apply (see lib/release-sql-production-cli.mjs and
 *                             ops/production-sql-139-apply.md)
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
    { key: 'sql139', scriptUrl: import.meta.url, enforceScriptGuard },
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
