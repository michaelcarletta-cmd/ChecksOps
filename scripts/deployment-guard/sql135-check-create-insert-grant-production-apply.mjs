#!/usr/bin/env node
/**
 * Official production entry for SQL 135
 * (aws/workflows/sql/135_check_create_insert_grant.sql): INSERT (id, tenant_id, uploaded_by,
 * status, check_stage, ocr_status, front_image_path, back_image_path, ocr_needs_verification,
 * carrier_name, check_number, payee_line, property_address, funds_type, review_notes,
 * payee_address, expiration_days, is_multi_payee, issue_date, amount, claim_id, cash_job_id,
 * check_source, cash_job_payment_class) on public.check_intake_items to checksops, and the same
 * columns' INSERT revoked from authenticated: the column privileges the check create
 * (handleCreateCheck, POST /workflow/checks) needs, which no migration granted for claim_id and
 * the cash-job columns. No predecessor; see ops/production-sql-135-apply.md.
 *
 *   --inspect                 read-only (BEGIN READ ONLY ... ROLLBACK): catalog state, the
 *                             fingerprint, prerequisites and preconditions; reads no table rows
 *   --apply --input <file>    receipt-gated apply (see lib/release-sql-production-cli.mjs and
 *                             ops/production-sql-135-apply.md)
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
    { key: 'sql135', scriptUrl: import.meta.url, enforceScriptGuard },
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
