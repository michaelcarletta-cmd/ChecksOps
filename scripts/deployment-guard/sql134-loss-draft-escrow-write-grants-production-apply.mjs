#!/usr/bin/env node
/**
 * Official production entry for SQL 134
 * (aws/workflows/sql/134_loss_draft_escrow_write_grants.sql): UPDATE (total_escrowed,
 * draw_amount_requested, draw_stage, draw_amount_released, holdback_amount) on
 * public.loss_draft_tracking and INSERT (loss_draft_id, draw_number, amount_requested,
 * amount_released, release_date, released_at, status, notes, created_by) on
 * public.loss_draft_releases, for checksops and authenticated: the column grants the Loss Draft
 * escrow and draw records (loss_draft_action mark_escrowed, request_draw, record_release,
 * record_holdback, mark_final_release) need, which no migration granted. No predecessor; see
 * ops/production-sql-134-apply.md.
 *
 *   --inspect                 read-only (BEGIN READ ONLY ... ROLLBACK): catalog state, the
 *                             fingerprint, prerequisites and preconditions; reads no table rows
 *   --apply --input <file>    receipt-gated apply (see lib/release-sql-production-cli.mjs and
 *                             ops/production-sql-134-apply.md)
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
    { key: 'sql134', scriptUrl: import.meta.url, enforceScriptGuard },
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
