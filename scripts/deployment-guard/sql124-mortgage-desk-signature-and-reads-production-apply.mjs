#!/usr/bin/env node
/**
 * Official production entry for SQL 124 (aws/workflows/sql/124_mortgage_desk_signature_and_reads.sql):
 * the Mortgage Desk sends a check's document for signature, reads the check's thread, files and
 * signature requests, and posts homeowner timeline updates. Eight SECURITY DEFINER functions: seven
 * with EXECUTE for checksops (the check's messages, files and signature requests, the storage-read
 * check of a path, the create of a draft signature request on a .pdf / .docx of the check, the record
 * of its email sends, a homeowner timeline row) and the internal readable-request check for the owner
 * only; see ops/production-sql-124-apply.md.
 *
 *   --inspect                 read-only (BEGIN READ ONLY ... ROLLBACK): catalog state, the
 *                             fingerprint, prerequisites and preconditions; reads no table rows
 *   --apply --input <file>    receipt-gated apply (see lib/release-sql-production-cli.mjs and
 *                             ops/production-sql-124-apply.md)
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
    { key: 'sql124', scriptUrl: import.meta.url, enforceScriptGuard },
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
