#!/usr/bin/env node
/**
 * Official production entry for SQL 136
 * (aws/workflows/sql/136_money_write_restrictive_policies.sql): three RESTRICTIVE policies TO
 * authenticated (INSERT, UPDATE, DELETE) on each of the 24 money tables, all calling the new SECURITY
 * INVOKER public.aws_money_write_allowed(), so an authenticated session writes a money table only on a
 * server write path that set request.money_write, request.financial_execution or SQL 91's onboarding /
 * webhook GUC (security audit 2026-10-29, finding 14, step 2 of 2). No predecessor. Must not be applied
 * before #1498's API is live in production; see ops/production-sql-136-apply.md.
 *
 *   --inspect                 read-only (BEGIN READ ONLY ... ROLLBACK): catalog state, the
 *                             fingerprint, prerequisites and preconditions; reads no table rows (catalog counts only)
 *   --apply --input <file>    receipt-gated apply (see lib/release-sql-production-cli.mjs and
 *                             ops/production-sql-136-apply.md)
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
    { key: 'sql136', scriptUrl: import.meta.url, enforceScriptGuard },
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
