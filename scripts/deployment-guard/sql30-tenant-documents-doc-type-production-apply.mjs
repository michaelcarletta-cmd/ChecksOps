#!/usr/bin/env node
/**
 * Official production entry for SQL 30 (aws/rls/sql/30_tenant_documents_mortgage_doc_type.sql):
 * public.tenant_documents_doc_type_check from the 3- or 6-value predecessor to the 13-value
 * list (6 legacy values plus the 7 canonical library:mortgage:* values). The file's own
 * BEGIN/COMMIT is not executed: the bytes between them run in the tool's transaction.
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
    { key: 'sql30', scriptUrl: import.meta.url, enforceScriptGuard },
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
