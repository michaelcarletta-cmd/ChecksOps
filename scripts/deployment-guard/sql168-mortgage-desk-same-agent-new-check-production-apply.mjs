#!/usr/bin/env node
/**
 * Official production entry for SQL 168 (aws/workflows/sql/168_mortgage_desk_same_agent_new_check.sql): a
 * new check on a claim the Mortgage Desk already handles goes to the same agent. Two new SECURITY DEFINER
 * functions, aws_mortgage_desk_route_same_agent(uuid, text) and aws_mortgage_desk_route_same_agent_trigger()
 * (EXECUTE for the owner only), and two triggers (AFTER INSERT ON loss_draft_tracking; AFTER UPDATE ON
 * check_intake_items when claim_id is set or changed): a check with a claim and a loss draft, not deposited,
 * voided or returned, with no request, gets one request accepted for the still-active agent of the same
 * tenant's in-progress (else completed) request on that claim, its details copied, with one
 * mortgage_ops_request_audit row; no predecessor (owner 2026-11-16, "We need to make sure once a mortgage
 * agent handles a check, if another check comes in they handle each one for that check file"); see
 * ops/production-sql-168-apply.md.
 *
 *   --inspect                 read-only (BEGIN READ ONLY ... ROLLBACK): catalog state, the
 *                             fingerprint, prerequisites and preconditions; reads no table rows
 *   --apply --input <file>    receipt-gated apply (see lib/release-sql-production-cli.mjs and
 *                             ops/production-sql-168-apply.md)
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
    { key: 'sql168', scriptUrl: import.meta.url, enforceScriptGuard },
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
