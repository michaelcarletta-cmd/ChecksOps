/**
 * Official production entry for SQL 140
 * (aws/workflows/sql/140_wallet_funding_settings_write_grants.sql): column INSERT (tenant_id,
 * auto_funding_enabled, funding_bank_account_id, funding_payment_method_id, funding_strategy,
 * target_wallet_balance_cents, maximum_single_pull_cents, maximum_daily_pull_cents,
 * require_payment_approval, authorization_accepted_at, authorization_accepted_by,
 * authorization_version) and column UPDATE (the same but tenant_id, plus updated_at) on
 * public.tenant_wallet_funding_settings to checksops: the privileges the WalletOps automatic
 * funding save (save-tenant-wallet-funding-settings, #1524) needs, which no migration granted
 * (the restored AWS databases gave checksops SELECT only). No predecessor; see
 * ops/production-sql-140-apply.md.
 *
 *   --inspect                 read-only (BEGIN READ ONLY ... ROLLBACK): catalog state, the
 *                             fingerprint, prerequisites and preconditions; reads no table rows
 *   --apply --input <file>    receipt-gated apply (see lib/release-sql-production-cli.mjs and
 *                             ops/production-sql-140-apply.md)
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
    { key: 'sql140', scriptUrl: import.meta.url, enforceScriptGuard },
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
