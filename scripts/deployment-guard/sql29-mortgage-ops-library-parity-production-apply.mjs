#!/usr/bin/env node
/**
 * Official production entry for SQL 29 (aws/rls/sql/29_mortgage_ops_library_parity.sql):
 * the Mortgage Ops library helpers, the two policies on
 * public.mortgage_request_library_documents and its SELECT/INSERT-only grants.
 *
 *   --inspect                 read-only (BEGIN READ ONLY ... ROLLBACK); of table rows only
 *                             aggregate COUNT(*)s
 *   --apply --input <file>    receipt-gated apply (see lib/library-production-cli.mjs and
 *                             ops/production-sql-29-30-apply.md)
 *
 * Credentials come only from the pinned production admin secret. Run only on a host with
 * private reachability into the production VPC; never from GitHub-hosted runners or Lambda.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoRootFrom } from './lib/paths.mjs';
import { runLibraryProductionTool } from './lib/library-production-cli.mjs';
import { enforceScriptGuard } from './require-guard.mjs';

export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  return runLibraryProductionTool(
    { key: 'sql29', scriptUrl: import.meta.url, enforceScriptGuard },
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
