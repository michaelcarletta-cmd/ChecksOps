#!/usr/bin/env node
/**
 * Official production entry for SQL 162 (aws/workflows/sql/162_shared_check_source_sends.sql): a partner
 * learns which checks shared with it the sharing organization has paid from by a send to someone else.
 * The new SECURITY DEFINER get_shared_check_source_sends(uuid) re-checks the API's tenant gate in the
 * database (aws_can_access_tenant, 42501) and returns, per check and sharing organization, the check
 * id, the sharing organization and the newest such send's time; never an amount, a payee or a status;
 * EXECUTE for checksops and the owner; no predecessor (owner 2026-11-12, "Sends to someone other than
 * the partner"); see ops/production-sql-162-apply.md.
 *
 *   --inspect                 read-only (BEGIN READ ONLY ... ROLLBACK): catalog state, the
 *                             fingerprint, prerequisites and preconditions; reads no table rows
 *   --apply --input <file>    receipt-gated apply (see lib/release-sql-production-cli.mjs and
 *                             ops/production-sql-162-apply.md)
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
    { key: 'sql162', scriptUrl: import.meta.url, enforceScriptGuard },
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
