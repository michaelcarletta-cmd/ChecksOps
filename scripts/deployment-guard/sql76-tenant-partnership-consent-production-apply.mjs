#!/usr/bin/env node
/**
 * Official production entry for SQL 76 (aws/workflows/sql/76_tenant_partnership_invitee_consent.sql): only the invitee
 * side can make a tenant_partnerships row live. The file creates the BEFORE INSERT OR UPDATE trigger
 * aws_tenant_partnership_consent_guard and its function (EXECUTE for the owner only) and drops the five Supabase-era
 * write and admin policies. Applied to staging on 2026-10-14 through its own staging pin; production through the release
 * engine (owner 2026-11-11, "apply SQL 76 to production through the guarded path", then "Option 1"); see
 * ops/production-sql-76-apply.md.
 *
 *   --inspect                 read-only (BEGIN READ ONLY ... ROLLBACK): catalog state, the
 *                             fingerprint, prerequisites, the predecessor and preconditions; reads no table rows
 *   --apply --input <file>    receipt-gated apply (see lib/release-sql-production-cli.mjs and
 *                             ops/production-sql-76-apply.md)
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
    { key: 'sql76', scriptUrl: import.meta.url, enforceScriptGuard },
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
