#!/usr/bin/env node
/**
 * Official production entry for SQL 110 (aws/workflows/sql/110_homeowner_preclaim_links.sql):
 * DELETE on public.homeowner_ledger_tokens for checksops (a real Delete for pre-claim links,
 * under aws_write_homeowner_ledger_tokens) and the SECURITY DEFINER public homeowner upload
 * writer public.aws_public_homeowner_ledger_upload (EXECUTE checksops only). No predecessor; see
 * ops/production-sql-110-apply.md.
 *
 *   --inspect                 read-only (BEGIN READ ONLY ... ROLLBACK): catalog state, the
 *                             fingerprint, prerequisites and preconditions; reads no table rows
 *   --apply --input <file>    receipt-gated apply (see lib/release-sql-production-cli.mjs and
 *                             ops/production-sql-110-apply.md)
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
    { key: 'sql110', scriptUrl: import.meta.url, enforceScriptGuard },
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
