#!/usr/bin/env node
/**
 * Official production entry for SQL 167 (aws/workflows/sql/167_claim_ledger_relink_check.sql): a linked
 * check whose claim number was wrong moves to the existing claim the corrected number names. The new
 * SECURITY DEFINER claim_ledger_relink_check(uuid, uuid, text, text, uuid) (inspect | relink) locks the
 * check, refuses a deposited, voided or returned check (SQL 43's rule), finds the claim with SQL 44's
 * same-tenant match (ambiguous, cross_tenant, no_match; never creates a claim), and moves the check, its
 * loss draft and its signature requests on the old claim with one check_audit_log row; EXECUTE for
 * checksops and the owner; no predecessor (owner 2026-11-14, "Need to be able to change/correct claim
 * number once edited for ledger to link to existing claim"); see ops/production-sql-167-apply.md.
 *
 *   --inspect                 read-only (BEGIN READ ONLY ... ROLLBACK): catalog state, the
 *                             fingerprint, prerequisites and preconditions; reads no table rows
 *   --apply --input <file>    receipt-gated apply (see lib/release-sql-production-cli.mjs and
 *                             ops/production-sql-167-apply.md)
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
    { key: 'sql167', scriptUrl: import.meta.url, enforceScriptGuard },
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
