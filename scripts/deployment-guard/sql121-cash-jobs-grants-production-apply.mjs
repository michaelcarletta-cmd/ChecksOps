#!/usr/bin/env node
/**
 * Official production entry for SQL 121 (aws/workflows/sql/121_cash_jobs_production_grants.sql):
 * Cash Jobs on AWS. SELECT / INSERT / UPDATE / DELETE on cash_jobs, cash_job_line_items and
 * cash_job_attachments for checksops and authenticated; sync_cash_job_check_payment() SECURITY
 * DEFINER with search_path public, pg_temp and EXECUTE for its owner only; the cash-job payment
 * recorded when a check's Check Alt deposit is approved or accepted (once per check), removed when
 * the deposit is then rejected and the check did not go through; see
 * ops/production-sql-121-apply.md.
 *
 *   --inspect                 read-only (BEGIN READ ONLY ... ROLLBACK): catalog state, the
 *                             fingerprint, prerequisites and preconditions; reads no table rows
 *   --apply --input <file>    receipt-gated apply (see lib/release-sql-production-cli.mjs and
 *                             ops/production-sql-121-apply.md)
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
    { key: 'sql121', scriptUrl: import.meta.url, enforceScriptGuard },
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
