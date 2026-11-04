/**
 * Official production entry for SQL 141
 * (aws/workflows/sql/141_permanent_vendor_payees.sql): permanent vendors and vendor payees by
 * Partner Code (owner decision 2026-11-03). Creates public.vendor_tenants and
 * public.tenant_vendor_payees (RLS on, one SELECT policy each TO authenticated, SELECT only for
 * checksops and authenticated) and the SECURITY DEFINER functions aws_vendor_payee_add(uuid, text),
 * aws_vendor_payee_remove(uuid, uuid) and aws_platform_owner_set_tenant_vendor(uuid, boolean)
 * (EXECUTE: checksops and the owner). No partnership, no shared record, nothing moves money;
 * public.tenants is not changed. No predecessor; see ops/production-sql-141-apply.md.
 *
 *   --inspect                 read-only (BEGIN READ ONLY ... ROLLBACK): catalog state, the
 *                             fingerprint, prerequisites and preconditions; reads no table rows
 *   --apply --input <file>    receipt-gated apply (see lib/release-sql-production-cli.mjs and
 *                             ops/production-sql-141-apply.md)
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
    { key: 'sql141', scriptUrl: import.meta.url, enforceScriptGuard },
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
