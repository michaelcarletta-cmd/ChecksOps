#!/usr/bin/env node
/**
 * Official production entry for SQL 120 (aws/workflows/sql/120_usage_events_at_approval_and_send.sql):
 * usage events at Check Alt approval and at send time. The check_processing event when a Check Alt
 * deposit is approved or accepted (voided, uninvoiced, when it is then rejected), the next-day /
 * same-day fee per recipient of a send when its first leg is posted (voided, uninvoiced, when every
 * leg failed or was canceled), the one-fee-per-leg unique index and a backfill from 2026-10-01; see
 * ops/production-sql-120-apply.md.
 *
 *   --inspect                 read-only (BEGIN READ ONLY ... ROLLBACK): catalog state, the
 *                             fingerprint, prerequisites and preconditions, and one aggregate
 *                             count (duplicated (payment_transfer_id, event_type) pairs)
 *   --apply --input <file>    receipt-gated apply (see lib/release-sql-production-cli.mjs and
 *                             ops/production-sql-120-apply.md)
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
    { key: 'sql120', scriptUrl: import.meta.url, enforceScriptGuard },
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
