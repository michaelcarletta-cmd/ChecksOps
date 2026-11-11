#!/usr/bin/env node
/**
 * Official production entry for SQL 152 (aws/workflows/sql/152_invoice_and_failed_deposit_fees.sql): the agreement's
 * $0.30 invoice fee and $2.00 failed deposit fee as usage events. The file adds the one-row table
 * tenant_usage_fee_launch (no grant to anyone), five owner-only functions, the triggers on moov_invoices and
 * checkalt_deposits, a partial unique index on check_billing_events and four columns on tenant_maintenance_payments. It
 * replaces SQL 149, never applied (owner 2026-11-10, "work on these fixes"; 2026-11-11, "Yes"); see
 * ops/production-sql-152-apply.md.
 *
 *   --inspect                 read-only (BEGIN READ ONLY ... ROLLBACK): catalog state, the
 *                             fingerprint, prerequisites, the predecessor and preconditions; reads no table rows
 *   --apply --input <file>    receipt-gated apply (see lib/release-sql-production-cli.mjs and
 *                             ops/production-sql-152-apply.md)
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
    { key: 'sql152', scriptUrl: import.meta.url, enforceScriptGuard },
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
