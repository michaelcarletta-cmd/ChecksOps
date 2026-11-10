#!/usr/bin/env node
/**
 * Official production entry for SQL 147 (aws/workflows/sql/147_external_disbursement_record.sql): a payment made
 * outside ChecksOps is recorded against a check in one server transaction. The new SECURITY DEFINER
 * aws_record_external_disbursement(uuid, uuid, jsonb, text) writes one completed disbursement batch and one settled
 * external_check split per payee, only for a member of the tenant (aws_can_write_tenant, 42501), the check locked
 * FOR UPDATE, idempotent by key and never above the amount still available; EXECUTE for checksops and the owner; no
 * predecessor (owner 2026-11-09, "apply SQL 147 in staging"); see ops/production-sql-147-apply.md.
 *
 *   --inspect                 read-only (BEGIN READ ONLY ... ROLLBACK): catalog state, the
 *                             fingerprint, prerequisites and preconditions; reads no table rows
 *   --apply --input <file>    receipt-gated apply (see lib/release-sql-production-cli.mjs and
 *                             ops/production-sql-147-apply.md)
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
    { key: 'sql147', scriptUrl: import.meta.url, enforceScriptGuard },
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
