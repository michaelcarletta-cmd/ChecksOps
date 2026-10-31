/**
 * Production WalletOps balance refresh (moov-wallet-sync), read-only at Moov.
 *
 * Self-contained so it can be added to a live bundle without replacing the
 * environment-specific parity/moov-functions.mjs. Provider calls are GETs only
 * (wallet list and payment methods): no wallet, transfer or ledger is created.
 * The only write is this tenant's environment='production' payment_wallets row.
 */
import { financialPermissionsActivated } from '../../financial-flags.mjs';
import { MoovError, withMoovContext } from '../parity/moov-client.mjs';
import { fail, jsonResult, moovProductionReadContext } from '../parity/caller.mjs';
import { loadMoovAccount } from '../parity/db.mjs';
import { readWallet, syncWalletReadOnly } from '../parity/moov-wallet.mjs';
import { setMoneyWriteFlag } from '../../money-write-flag.mjs';

const ENVIRONMENT = 'production';

async function syncProductionWallet({ client, ctx, body, fetchImpl }) {
  const walletType = body.wallet_type || 'operating';
  if (!['operating', 'trust'].includes(walletType)) {
    return fail("wallet_type must be 'operating' or 'trust'", 400);
  }
  const account = await loadMoovAccount(client, ctx.tenantId, ENVIRONMENT);
  if (!account?.provider_account_id) return fail('Set up your payment account first.', 409);
  const ledgerLimit = Math.min(Number(body.ledger_limit) || 50, 200);

  let wallet;
  try {
    wallet = await syncWalletReadOnly(client, {
      tenantId: ctx.tenantId,
      accountId: account.provider_account_id,
      environment: ENVIRONMENT,
      walletType,
      skipProviderFetch: !body?.force && account.onboarding_status !== 'active',
      fetchImpl,
    });
  } catch (error) {
    const local = await readWallet(client, ctx.tenantId, ENVIRONMENT, walletType);
    if (!local) throw error;
    wallet = { ...local, status: 'sync_failed' };
  }
  if (wallet?.error === 'wallet_mismatch') {
    return fail('wallet_mismatch', 409, { message: 'The recorded Moov wallet was not returned by Moov. Nothing was changed.' });
  }
  if (!wallet || wallet.error) {
    return fail('wallet_not_found', 409, { message: 'No matching Moov wallet was found for this organization.' });
  }

  const ledger = (await client.query(
    `SELECT * FROM public.payment_wallet_ledger
     WHERE wallet_id = $1::uuid ORDER BY created_at DESC NULLS LAST LIMIT $2`,
    [wallet.id, ledgerLimit],
  )).rows;
  const subLedgers = (await client.query(
    `SELECT * FROM public.payment_wallet_sub_ledgers
     WHERE wallet_id = $1::uuid ORDER BY created_at DESC NULLS LAST`,
    [wallet.id],
  )).rows;
  return jsonResult({
    success: true,
    wallet,
    ledger,
    sub_ledgers: subLedgers,
    liveProviderCalled: account.onboarding_status === 'active',
  });
}

export async function handleProductionMoovWalletSync(event, deps = {}) {
  const { withIdentityWrite } = await import('../../data.mjs');
  return withIdentityWrite(event, async ({ client, mapping, claims, body, spoof }) => {
    const ctx = await moovProductionReadContext({
      client,
      mapping,
      body,
      requireAdmin: false,
      loadProviderSecrets: deps.loadProviderSecrets,
    });
    if (ctx.error) return { ...ctx, spoofFieldsIgnored: spoof, applicationUserId: mapping.application_user_id };
    // Lets a tenant member (not only platform staff) save the refreshed balance (SQL 72).
    await client.query("SELECT set_config('request.financial_execution', '1', true)");
    await client.query('SELECT set_config($1, $2, true)', [
      'request.aws_financial_permissions_activated',
      financialPermissionsActivated() ? '1' : '0',
    ]);
    // The SQL 72 pair above is active only with AWS_FINANCIAL_PERMISSIONS_ACTIVATED; the
    // server-only money-write flag covers the payment_wallets save either way (finding 14).
    await setMoneyWriteFlag(client);
    const fetchImpl = deps.fetchImpl || fetch;
    try {
      const result = await withMoovContext({ ...ctx.moovContext, fetchImpl }, () => syncProductionWallet({
        client, ctx, body, fetchImpl,
      }));
      return {
        ...result,
        spoofFieldsIgnored: spoof,
        applicationUserId: mapping.application_user_id,
        authUid: mapping.application_user_id,
        cognitoSub: claims.sub,
        productionExecution: false,
        environment: ENVIRONMENT,
        apiVersion: ctx.moovContext.apiVersion,
      };
    } catch (error) {
      const { isProviderNetworkError, providerEgressFailure } = await import('../../sandbox-credentials.mjs');
      if (isProviderNetworkError(error)) {
        return { ...providerEgressFailure('moov'), spoofFieldsIgnored: spoof, applicationUserId: mapping.application_user_id };
      }
      const status = error instanceof MoovError ? (error.status || 502) : 500;
      return fail(error.message, status, {
        spoofFieldsIgnored: spoof,
        applicationUserId: mapping.application_user_id,
        liveProviderCalled: true,
      });
    }
  }, deps);
}
