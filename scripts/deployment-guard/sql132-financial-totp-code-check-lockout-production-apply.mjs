#!/usr/bin/env node
/**
 * Official production entry for SQL 132 (aws/workflows/sql/132_financial_totp_code_check_lockout.sql):
 * the financial TOTP lockout. The new SECURITY DEFINER financial_totp_count_code_check(uuid) counts a
 * code check against financial_totp_enrollments.failed_attempts before the API compares the code,
 * locks the enrollment for 15 minutes at the tenth consecutive check without a success and refuses
 * while locked; EXECUTE for checksops and the owner; predecessor SQL 130 (owner 2026-10-30, "restart
 * SQL 131 and the lockout fix"); see ops/production-sql-132-apply.md.
 *
 *   --inspect                 read-only (BEGIN READ ONLY ... ROLLBACK): catalog state, the
 *                             fingerprint, prerequisites and preconditions; reads no table rows
 *   --apply --input <file>    receipt-gated apply (see lib/release-sql-production-cli.mjs and
 *                             ops/production-sql-132-apply.md)
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
    { key: 'sql132', scriptUrl: import.meta.url, enforceScriptGuard },
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
