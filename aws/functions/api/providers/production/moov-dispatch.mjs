import { withIdentityWrite } from '../../data.mjs';
import { isProviderNetworkError, providerEgressFailure } from '../../sandbox-credentials.mjs';
import { bindMoovEnvironment, withMoovContext } from '../parity/moov-client.mjs';
import { fail, membershipsOf, resolveTenant } from '../parity/caller.mjs';
import { loadProviderSecrets } from '../../provider-secrets.mjs';
import {
  cancelWalletFunding,
  calculatePaymentFunding,
  disburse,
  initiateWalletFunding,
  processFundedPayment,
  transferCreate,
  transferGroupCreate,
  walletFund,
} from '../parity/moov-money.mjs';
import {
  denyAmbiguousMoovMode,
  PRODUCTION_MOOV_FUNCTIONS,
  productionMoovAmbiguousMode,
  productionMoovExecutionAllowed,
} from './moov-holds.mjs';

export const hasProductionMoovHandler = (name) => PRODUCTION_MOOV_FUNCTIONS.has(name);

const loadProductionMoovCredentials = async () => {
  const secrets = await loadProviderSecrets();
  const environment = String(secrets.MOOV_ENVIRONMENT || '').toLowerCase();
  if (environment !== 'production') {
    return fail('production_credentials_unavailable', 503, {
      message: 'Production Moov credentials are not bound. MOOV_ENVIRONMENT must be production.',
    });
  }
  if (!secrets.MOOV_PUBLIC_KEY || !secrets.MOOV_SECRET_KEY) {
    return fail('production_credentials_unavailable', 503, {
      message: 'Production Moov API keys are not configured.',
    });
  }
  return {
    environment: 'production',
    productionPublicKey: secrets.MOOV_PUBLIC_KEY,
    productionSecretKey: secrets.MOOV_SECRET_KEY,
    productionPlatformAccountId: secrets.MOOV_ACCOUNT_ID || null,
    allowedOrigin: secrets.MOOV_ALLOWED_ORIGIN || 'https://checksops.com',
    apiVersion: 'v2024.01.00',
    sandboxPublicKey: null,
    sandboxSecretKey: null,
  };
};

export async function moovProductionContext({ client, mapping, body, requireAdmin = false }) {
  if (!productionMoovExecutionAllowed()) {
    return fail('production_execution_blocked', 403, {
      message: 'Production Moov execution requires AWS_MOOV_ENABLED, AWS_PROVIDER_EXECUTION_ENABLED, and AWS_FINANCIAL_PERMISSIONS_ACTIVATED, with sandbox execution off.',
    });
  }
  const memberships = await membershipsOf(client, mapping.application_user_id);
  const tenant = await resolveTenant(client, {
    userId: mapping.application_user_id,
    body,
    memberships,
    requireAdmin,
  });
  if (tenant.error) return tenant;
  if (!tenant.tenantId) return fail('tenant_id is required', 400);

  const tenantRow = (await client.query(
    'SELECT moov_allowlisted, moov_environment FROM public.tenants WHERE id = $1::uuid',
    [tenant.tenantId],
  )).rows[0];
  if (!tenantRow) return fail('Organization not found', 404);
  if (tenantRow.moov_allowlisted === false) {
    return fail('This organization is not enabled for this payment provider.', 403);
  }
  const tenantEnv = String(tenantRow.moov_environment || '').toLowerCase();
  if (tenantEnv !== 'production') {
    return fail('tenant_moov_environment_not_production', 409, {
      message: 'This organization is not flagged for production Moov. Production dispatch will not use sandbox rows.',
    });
  }

  const moovContext = await loadProductionMoovCredentials();
  if (moovContext.error) return moovContext;
  bindMoovEnvironment('production');
  return {
    tenantId: tenant.tenantId,
    isAdmin: tenant.isAdmin,
    environment: 'production',
    productionAuthorized: true,
    userId: mapping.application_user_id,
    memberships,
    moovContext,
  };
}

const wrapMoney = (handler) => async (event, deps = {}) => (
  withIdentityWrite(event, async ({ client, mapping, claims, body, spoof }) => {
    const ctx = await moovProductionContext({
      client,
      mapping,
      body,
      requireAdmin: handler.requireAdmin === true,
    });
    if (ctx.error) {
      return {
        ...ctx,
        spoofFieldsIgnored: spoof,
        applicationUserId: mapping.application_user_id,
        productionExecution: false,
      };
    }
    try {
      const fetchImpl = deps.fetchImpl || fetch;
      const result = await withMoovContext({ ...ctx.moovContext, fetchImpl }, () => handler.run({
        client, mapping, claims, body, spoof, ctx, fetchImpl, event,
        send: deps.sendViaSesOrSink,
      }));
      return {
        ...result,
        spoofFieldsIgnored: spoof,
        applicationUserId: mapping.application_user_id,
        authUid: mapping.application_user_id,
        cognitoSub: claims.sub,
        productionExecution: true,
        environment: 'production',
        apiVersion: ctx.moovContext.apiVersion,
      };
    } catch (error) {
      if (isProviderNetworkError(error)) {
        return {
          ...providerEgressFailure('moov'),
          spoofFieldsIgnored: spoof,
          applicationUserId: mapping.application_user_id,
          productionExecution: true,
        };
      }
      const status = error?.status || error?.statusCode || 500;
      return fail(error.message, status, {
        spoofFieldsIgnored: spoof,
        applicationUserId: mapping.application_user_id,
        liveProviderCalled: true,
        productionExecution: true,
      });
    }
  }, deps)
);

const walletSync = {
  run: async ({ client, ctx, fetchImpl }) => {
    const { loadMoovAccount } = await import('../parity/db.mjs');
    const { syncWallet, readWallet } = await import('../parity/moov-wallet.mjs');
    const { jsonResult, fail } = await import('../parity/caller.mjs');
    const account = await loadMoovAccount(client, ctx.tenantId, 'production');
    if (!account?.provider_account_id) return fail('Set up your payment account first.', 409);
    const wallet = await syncWallet(client, {
      tenantId: ctx.tenantId,
      accountId: account.provider_account_id,
      environment: 'production',
      walletType: 'operating',
      fetchImpl,
    });
    const ledger = (await client.query(
      `SELECT * FROM public.payment_wallet_ledger WHERE wallet_id = $1::uuid ORDER BY created_at DESC NULLS LAST LIMIT 50`,
      [wallet.id],
    )).rows;
    const stored = await readWallet(client, ctx.tenantId, 'production', 'operating');
    return jsonResult({
      success: true,
      wallet: stored || wallet,
      ledger,
      liveProviderCalled: account.onboarding_status === 'active',
    });
  },
};

const transferStatus = {
  run: async ({ client, body, ctx, fetchImpl }) => {
    const { fail, jsonResult } = await import('../parity/caller.mjs');
    const { facilitatorAccountId, moovFetch, scopes, normalizeTransferStatus } = await import('../parity/moov-client.mjs');
    const { updateTransferAfterMoov } = await import('../parity/db.mjs');
    const providerTransferId = body.provider_transfer_id || body.transfer_id;
    if (!providerTransferId) return fail('provider_transfer_id is required', 400);
    const row = (await client.query(
      `SELECT * FROM public.payment_transfers
       WHERE provider = 'moov' AND environment = 'production'
         AND (provider_transfer_id = $1 OR id::text = $1)
         AND tenant_id = $2::uuid
       LIMIT 1`,
      [String(providerTransferId), ctx.tenantId],
    )).rows[0];
    if (!row) return fail('Transfer not found.', 404);
    if (!row.provider_transfer_id) {
      return jsonResult({ success: true, transfer: row, liveProviderCalled: false });
    }
    const account = (await client.query(
      `SELECT provider_account_id FROM public.payment_provider_accounts
       WHERE tenant_id = $1::uuid AND provider = 'moov' AND environment = 'production'
       LIMIT 1`,
      [ctx.tenantId],
    )).rows[0];
    if (!account?.provider_account_id) return fail('Set up your payment account first.', 409);
    const facilitatorId = await facilitatorAccountId(account.provider_account_id, fetchImpl);
    const live = await moovFetch(`/accounts/${facilitatorId}/transfers/${row.provider_transfer_id}`, {
      scopes: scopes.transfersRead(facilitatorId),
      fetchImpl,
    });
    const status = normalizeTransferStatus(live?.status ?? row.status);
    const updated = await updateTransferAfterMoov(client, row.id, {
      provider_transfer_id: row.provider_transfer_id,
      provider_status: live?.status ?? row.provider_status,
      status,
      provider_metadata: live || {},
    });
    return jsonResult({ success: true, transfer: updated, liveProviderCalled: true });
  },
};

const HANDLERS = {
  'moov-wallet-fund': wrapMoney(walletFund),
  'initiate-wallet-funding': wrapMoney(initiateWalletFunding),
  'cancel-wallet-funding': wrapMoney(cancelWalletFunding),
  'calculate-payment-funding': wrapMoney(calculatePaymentFunding),
  'moov-wallet-sync': wrapMoney(walletSync),
  'moov-transfer-create': wrapMoney(transferCreate),
  'moov-transfer-group-create': wrapMoney(transferGroupCreate),
  'moov-transfer-status': wrapMoney(transferStatus),
  'moov-disburse': wrapMoney(disburse),
  'process-funded-payment': wrapMoney(processFundedPayment),
};

export const runProductionMoovHandler = (name, event, deps = {}) => {
  if (productionMoovAmbiguousMode()) return denyAmbiguousMoovMode(name);
  if (!productionMoovExecutionAllowed()) return null;
  const handler = HANDLERS[name];
  if (!handler) return null;
  return handler(event, deps);
};
