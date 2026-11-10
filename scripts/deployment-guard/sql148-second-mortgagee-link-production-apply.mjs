#!/usr/bin/env node
/**
 * Official production entry for SQL 148 (aws/workflows/sql/148_second_mortgagee_link.sql): Send to Mortgage Desk
 * sends a 2nd mortgagee while the 1st request is open. The unique index
 * public.mortgage_handling_requests_one_open_per_check is redefined in place from the Supabase definition
 * (check_intake_item_id) to (check_intake_item_id, COALESCE(endorsement_order, 1)) for open requests, refused unless the
 * live index is one of the two (replaced_indexes_replaceable), and the new SECURITY DEFINER
 * aws_link_second_mortgagee(uuid, uuid) links the two requests 1 of 2 / 2 of 2 for a member of the tenant
 * (aws_can_write_tenant), both rows locked FOR UPDATE; EXECUTE for checksops and the owner; no predecessor (owner
 * 2026-11-10, "build the second-mortgagee fix"); see ops/production-sql-148-apply.md.
 *
 *   --inspect                 read-only (BEGIN READ ONLY ... ROLLBACK): catalog state, the
 *                             fingerprint, prerequisites, preconditions and which index definition
 *                             is live; reads no table rows
 *   --apply --input <file>    receipt-gated apply (see lib/release-sql-production-cli.mjs and
 *                             ops/production-sql-148-apply.md)
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
    { key: 'sql148', scriptUrl: import.meta.url, enforceScriptGuard },
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
