#!/usr/bin/env node
/**
 * Official production entry for SQL 143
 * (aws/workflows/sql/143_mortgage_companies_member_delete_unused.sql): any member of any tenant or an active
 * mortgage desk agent may add, edit and delete active rows of the shared mortgage company directory, and a company
 * is deleted only while no claim, loss draft or check case uses it. The helper
 * public.aws_can_edit_mortgage_company_directory(), the guard public.aws_mortgage_company_in_use_guard() and its
 * BEFORE DELETE OR UPDATE OF id trigger, three PERMISSIVE policies TO authenticated replacing SQL 142's two; the
 * platform-owner policy aws_write_mortgage_companies must be intact and is not changed. Predecessor SQL 142, which it
 * supersedes. Production is unverified until a read-only inspect; see ops/production-sql-143-apply.md.
 *
 *   --inspect                 read-only (BEGIN READ ONLY ... ROLLBACK): catalog state, the
 *                             fingerprint, prerequisites and preconditions; reads no table rows (catalog counts only)
 *   --apply --input <file>    receipt-gated apply (see lib/release-sql-production-cli.mjs and
 *                             ops/production-sql-143-apply.md)
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
    { key: 'sql143', scriptUrl: import.meta.url, enforceScriptGuard },
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
