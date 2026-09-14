import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { LOOKUP_MAPPING_SQL, TENANT_MEMBERSHIP_SQL } from '../functions/api/identity.mjs';
import { handler } from '../functions/api/index.mjs';
import { handleProviderRequest } from '../functions/api/providers.mjs';
import { capabilitiesStillNeeded } from '../functions/api/providers/readiness.mjs';
import { capabilityFlags } from '../functions/api/providers/parity/moov-client.mjs';
import {
  capabilitiesToRequest,
  refuseKycOrCapabilityWrite,
} from '../functions/api/providers/production/moov-capability-policy.mjs';
import {
  FIRST_PRODUCTION_TRANSFER_CENTS,
  productionMoovExecutionAllowed,
} from '../functions/api/providers/production/moov-holds.mjs';
import { KNOWN_APPROVED_MOOV } from '../functions/api/providers/production/moov-accounts.mjs';
import {
  assertProductionMoovGet,
  assertProductionMoovTransferPost,
  ProductionMoovError,
  resetProductionMoovTokenCache,
} from '../functions/api/providers/production/moov-http.mjs';
import { sweepBlocksFirstCent } from '../functions/api/providers/production/moov-preflight.mjs';
import { loadProductionMoovReadSecrets } from '../functions/api/providers/production/moov-secrets.mjs';
import { handleProductionMoovWalletFund } from '../functions/api/providers/production/moov-wallet-fund.mjs';
import {
  handleProductionMoovProcessFundedPayment,
  handleProductionMoovWalletDisburse,
  handleProductionMoovWalletFundOnClear,
} from '../functions/api/providers/production/moov-wallet-disburse.mjs';
import { handleProductionMoovTenantFeeCharge } from '../functions/api/providers/production/moov-fee-collect.mjs';
import { handleProductionMoovRefund } from '../functions/api/providers/production/moov-refund.mjs';
import {
  handleProductionMoovReadiness,
  handleProductionMoovWalletStatus,
} from '../functions/api/providers/production/moov-live-read.mjs';
import { handleProductionMoovSweepConfig } from '../functions/api/providers/production/moov-sweep-config.mjs';
import { isDeniedDuplicateMoovAccount } from '../functions/api/providers/production/moov-accounts.mjs';
import { isPlatformOwnerCaller } from '../functions/api/providers/production/moov-roles.mjs';

const FREEDOM_APP = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const FREEDOM_TENANT = KNOWN_APPROVED_MOOV.freedom.tenantId;
const C1C_TENANT = KNOWN_APPROVED_MOOV.c1c.tenantId;
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const PLATFORM_APP = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const PLATFORM_SUB = '11111111-2222-4333-8333-555555555555';
const VENDOR_RECIPIENT_ID = KNOWN_APPROVED_MOOV.recipient.recipientId;
const UNVERIFIED_RECIPIENT_ID = 'aaaaaaaa-1111-4bbb-8ccc-dddddddddddd';
const CLEARED_DEPOSIT_ID = '11111111-2222-4333-8333-444444444444';
const PENDING_DEPOSIT_ID = '11111111-2222-4333-8333-444444444445';
const QUEUE_ID = '22222222-3333-4444-8555-666666666666';
const C1C_WALLET_ID = '33333333-4444-4555-8666-777777777777';
const PLATFORM_WALLET_PM = '44444444-5555-4666-8777-888888888888';

const jwtEvent = (pathName, method, body, extra = {}) => ({
  rawPath: pathName,
  headers: {
    authorization: extra.auth === null ? undefined : 'Bearer test-id-token',
    ...(extra.headers || {}),
  },
  body: body ? JSON.stringify(body) : undefined,
  requestContext: {
    stage: 'staging',
    http: { method, path: pathName },
    authorizer: extra.auth === null ? undefined : {
      jwt: { claims: { sub: extra.sub || COGNITO_SUB, email: 'owner@freedomadj.com', token_use: 'id' } },
    },
  },
});

const mapping = {
  application_user_id: FREEDOM_APP,
  cognito_sub: COGNITO_SUB,
  email: 'owner@freedomadj.com',
  status: 'active',
};

const platformMapping = {
  application_user_id: PLATFORM_APP,
  cognito_sub: PLATFORM_SUB,
  email: 'checksopsadmin@gmail.com',
  status: 'active',
};

const withEnv = async (vars, fn) => {
  const previous = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const productionFlags = {
  AWS_PROVIDER_EXECUTION_ENABLED: 'true',
  AWS_MOOV_ENABLED: 'true',
  AWS_FINANCIAL_PERMISSIONS_ACTIVATED: 'true',
  AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: undefined,
  AWS_CHECKALT_ENABLED: 'false',
  PROVIDER_SECRETS_ARN: 'arn:aws:secretsmanager:us-east-1:806168576068:secret:checksops/production/providers',
};

const productionSecrets = {
  MOOV_PUBLIC_KEY: 'pk_live_test',
  MOOV_SECRET_KEY: 'sk_live_test',
  MOOV_ENVIRONMENT: 'production',
  MOOV_ALLOWED_ORIGIN: 'https://checksops.com',
};

const grantStepUp = (store, extra = {}) => {
  store.stepups.push({
    id: crypto.randomUUID(),
    user_id: FREEDOM_APP,
    tenant_id: FREEDOM_TENANT,
    action_key: extra.actionKey || 'wallet.fund',
    factor_type: 'totp',
    succeeded: true,
    metadata: {
      amount_cents: extra.amountCents ?? 1,
      source_payment_method_id: extra.sourcePm || KNOWN_APPROVED_MOOV.freedom.achDebitFundPm,
      destination_payment_method_id: extra.destPm || KNOWN_APPROVED_MOOV.freedom.walletPm,
    },
    created_at: new Date().toISOString(),
  });
};

const createStore = () => ({
  memberships: [{ tenant_id: FREEDOM_TENANT, role: 'admin', tenant_name: 'Freedom', tenant_slug: 'freedom' }],
  stepups: [],
  transfers: [],
  role: 'admin',
  accounts: [
    { tenant_id: FREEDOM_TENANT, provider_account_id: KNOWN_APPROVED_MOOV.freedom.moovAccountId, onboarding_status: 'active', verification_status: 'verified', disabled: false },
    { tenant_id: C1C_TENANT, provider_account_id: KNOWN_APPROVED_MOOV.c1c.moovAccountId, onboarding_status: 'active', verification_status: 'verified', disabled: false },
  ],
  wallets: [
    { tenant_id: FREEDOM_TENANT, provider_wallet_id: KNOWN_APPROVED_MOOV.freedom.walletId, wallet_type: 'operating' },
  ],
  recipients: [
    {
      id: VENDOR_RECIPIENT_ID,
      tenant_id: FREEDOM_TENANT,
      recipient_type: 'vendor',
      relationship: 'shared_vendor',
      provider_account_id: KNOWN_APPROVED_MOOV.recipient.moovAccountId,
      onboarding_status: 'active',
      stakeholder_account_id: 'bbbbbbbb-2222-4ccc-8ddd-eeeeeeeeeeee',
    },
    {
      id: UNVERIFIED_RECIPIENT_ID,
      tenant_id: FREEDOM_TENANT,
      recipient_type: 'homeowner',
      relationship: 'homeowner',
      provider_account_id: null,
      onboarding_status: 'pending',
      stakeholder_account_id: null,
    },
  ],
  stakeholders: [
    {
      id: 'bbbbbbbb-2222-4ccc-8ddd-eeeeeeeeeeee',
      tenant_id: FREEDOM_TENANT,
      account_type: 'vendor',
      provider_account_id: KNOWN_APPROVED_MOOV.recipient.moovAccountId,
      verification_status: 'pending',
      is_active: true,
    },
  ],
  deposits: [
    {
      id: CLEARED_DEPOSIT_ID,
      tenant_id: FREEDOM_TENANT,
      status: 'cleared',
      cleared_at: '2026-09-13T00:00:00Z',
      check_intake_item_id: null,
      returned_at: null,
    },
    {
      id: PENDING_DEPOSIT_ID,
      tenant_id: FREEDOM_TENANT,
      status: 'submitted',
      cleared_at: null,
      check_intake_item_id: null,
      returned_at: null,
    },
  ],
  batches: [],
  queue: [
    {
      id: QUEUE_ID,
      tenant_id: FREEDOM_TENANT,
      fund_cents: 1,
      checkalt_deposit_id: CLEARED_DEPOSIT_ID,
      check_intake_item_id: null,
      status: 'queued',
    },
  ],
});

const identityClient = (store, session = mapping) => ({
  connect: async () => {},
  end: async () => {},
  query: async (sql, params = []) => {
    const text = String(sql);
    if (text === 'BEGIN' || text === 'ROLLBACK' || text === 'COMMIT' || text === 'SET TRANSACTION READ WRITE'
      || text.startsWith('SAVEPOINT') || text.startsWith('RELEASE SAVEPOINT') || text.startsWith('ROLLBACK TO SAVEPOINT')) {
      return { rows: [] };
    }
    if (text.startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
    if (text === LOOKUP_MAPPING_SQL) {
      if (params[0] === session.cognito_sub) return { rows: [session] };
      if (params[0] === mapping.cognito_sub) return { rows: [mapping] };
      if (params[0] === platformMapping.cognito_sub) return { rows: [platformMapping] };
      return { rows: [] };
    }
    if (text === TENANT_MEMBERSHIP_SQL || text.includes('FROM public.tenant_users tu')) {
      return { rows: store.memberships };
    }
    if (text.includes('FROM public.user_roles')) {
      return { rows: [{ role: store.role || 'admin' }] };
    }
    if (text.includes('FROM public.tenant_users WHERE user_id') && text.includes('AND tenant_id')) {
      const match = store.memberships.find((row) => row.tenant_id === params[1]);
      return { rows: match ? [{ role: match.role }] : [] };
    }
    if (text.includes('UPDATE public.payment_provider_accounts')) {
      const row = (store.accounts || []).find((item) => item.tenant_id === params[0]);
      if (row) {
        row.onboarding_status = params[1];
        row.verification_status = params[2];
        row.can_send_payments = params[4];
        row.can_receive_payments = params[5];
        row.can_ach_credit = params[6];
        row.can_ach_debit = params[7];
        store.accountPersists = (store.accountPersists || 0) + 1;
      }
      return { rows: [] };
    }
    if (text.includes('UPDATE public.stakeholder_accounts')) {
      for (const row of store.stakeholders || []) {
        if (row.tenant_id === params[0] && row.provider_account_id === params[1]) {
          row.verification_status = 'verified';
          store.stakeholderPersists = (store.stakeholderPersists || 0) + 1;
        }
      }
      return { rows: [] };
    }
    if (text.includes('UPDATE public.external_payment_recipients')) {
      for (const row of store.recipients || []) {
        if (row.tenant_id === params[0] && row.provider_account_id === params[1]) {
          row.onboarding_status = 'verified';
        }
      }
      return { rows: [] };
    }
    if (text.includes('FROM public.external_payment_recipients') && text.includes('provider_account_id IS NOT NULL')) {
      return {
        rows: (store.recipients || []).filter((row) => row.tenant_id === params[0] && row.provider_account_id),
      };
    }
    if (text.includes('FROM public.stakeholder_accounts') && text.includes('provider_account_id IS NOT NULL')) {
      return {
        rows: (store.stakeholders || []).filter((row) => row.tenant_id === params[0] && row.provider_account_id),
      };
    }
    if (text.includes('FROM public.payment_provider_accounts')) {
      return { rows: (store.accounts || []).filter((row) => row.tenant_id === params[0]) };
    }
    if (text.includes('FROM public.payment_wallets')) {
      return { rows: (store.wallets || []).filter((row) => row.tenant_id === params[0]) };
    }
    if (text.includes('FROM public.external_payment_recipients')) {
      return {
        rows: (store.recipients || []).filter((row) => row.id === params[0] && row.tenant_id === params[1]),
      };
    }
    if (text.includes('FROM public.stakeholder_accounts')) {
      return {
        rows: (store.stakeholders || []).filter((row) => row.id === params[0] && row.tenant_id === params[1]),
      };
    }
    if (text.includes('FROM public.checkalt_deposits') && text.includes('WHERE id =')) {
      return {
        rows: (store.deposits || []).filter((row) => row.id === params[0] && row.tenant_id === params[1]),
      };
    }
    if (text.includes('FROM public.checkalt_deposits')) {
      return {
        rows: (store.deposits || []).filter((row) => row.check_intake_item_id === params[0] && row.tenant_id === params[1]),
      };
    }
    if (text.includes('FROM public.disbursement_batches')) {
      return { rows: (store.batches || []).filter((row) => row.id === params[0]) };
    }
    if (text.includes('FROM public.wallet_funding_queue')) {
      return { rows: (store.queue || []).filter((row) => row.id === params[0]) };
    }
    if (text.includes('FROM public.financial_stepup_log')) {
      const [userId, tenantId, actionKey, since, amountCents] = params;
      return {
        rows: store.stepups.filter((row) => (
          row.user_id === userId
          && row.tenant_id === tenantId
          && row.action_key === actionKey
          && row.succeeded === true
          && Number(row.metadata?.amount_cents) === Number(amountCents)
          && new Date(row.created_at) >= new Date(since)
        )),
      };
    }
    if (text.includes('INSERT INTO public.payment_transfers')) {
      const row = {
        id: crypto.randomUUID(),
        tenant_id: params[0],
        provider: 'moov',
        environment: 'production',
        status: 'ready',
        idempotency_key: params[1],
        amount_cents: params[2],
        description: params[3],
        source_tenant_account_id: params[4],
        source_payment_method_id: params[5],
        destination_tenant_id: params[6],
        destination_recipient_id: params[7],
        destination_payment_method_id: params[8],
        wallet_id: params[9],
        leg_role: params[10],
        created_by: params[11],
        provider_transfer_id: null,
      };
      store.transfers.push(row);
      return { rows: [row] };
    }
    if (text.includes('UPDATE public.payment_transfers') && text.includes("status = 'submitting'")) {
      const row = store.transfers.find((item) => item.id === params[0] && item.status === 'ready' && !item.provider_transfer_id);
      if (!row) return { rows: [] };
      row.status = 'submitting';
      return { rows: [row] };
    }
    if (text.includes('UPDATE public.payment_transfers')) {
      const row = store.transfers.find((item) => item.id === params[0]);
      if (!row) return { rows: [] };
      row.provider_transfer_id = params[1];
      row.provider_status = params[2];
      row.status = params[3];
      row.provider_metadata = typeof params[4] === 'string' ? JSON.parse(params[4]) : params[4];
      row.failure_reason = params[5];
      row.submitted_at = new Date().toISOString();
      return { rows: [row] };
    }
    if (text.includes('FROM public.payment_transfers') && text.includes('leg_role')) {
      return { rows: (store.transfers || []).filter((row) => row.tenant_id === params[0]) };
    }
    if (text.includes('FROM public.payment_transfers')) {
      return { rows: store.transfers.filter((row) => row.tenant_id === params[0] && row.idempotency_key === params[1]) };
    }
    return { rows: [] };
  },
});

const jsonResponse = (body, status = 200) => ({
  ok: status < 400,
  status,
  text: async () => JSON.stringify(body),
});

const mockMoovFetch = (store, { sweepMin = '0.00', sweepStatus = 'enabled', walletAvailable = 0, extraPending = 0 } = {}) => {
  store.moovCalls = [];
  return async (url, options = {}) => {
    const target = String(url);
    const method = String(options.method || 'GET').toUpperCase();
    store.moovCalls.push({ method, url: target, body: options.body || null });
    if (target.includes('/oauth2/token')) {
      return jsonResponse({ access_token: 'tok_live', expires_in: 300, token_type: 'Bearer' });
    }
    if (method === 'POST' && /\/accounts\/[^/]+\/capabilities/.test(target)) {
      store.capabilityPosts = (store.capabilityPosts || 0) + 1;
      return jsonResponse({ error: 'should_not_post_capabilities' }, 500);
    }
    if (method === 'POST' && /\/accounts\/[^/]+\/transfers$/.test(target)) {
      store.transferPosts = (store.transferPosts || 0) + 1;
      return jsonResponse({ transferID: 'tr_test_1', status: 'pending' });
    }
    if ((method === 'POST' || method === 'PATCH') && target.includes('/sweep-configs')) {
      store.sweepWrites = (store.sweepWrites || 0) + 1;
      return jsonResponse({
        sweepConfigID: '2d2c900d-6efb-43a2-ba90-2fd77e22afdd',
        walletID: KNOWN_APPROVED_MOOV.freedom.walletId,
        status: 'enabled',
        minimumBalance: { value: '150.00', currency: 'USD' },
      });
    }
    if (target.includes('/sweep-configs')) {
      return jsonResponse([{
        sweepConfigID: '2d2c900d-6efb-43a2-ba90-2fd77e22afdd',
        walletID: KNOWN_APPROVED_MOOV.freedom.walletId,
        status: sweepStatus,
        minimumBalance: { value: sweepMin, currency: 'USD' },
        pushPaymentMethodID: KNOWN_APPROVED_MOOV.freedom.achCreditStandardPm,
      }]);
    }
    if (target.includes('/capabilities')) {
      const accountId = target.match(/accounts\/([^/]+)/)?.[1];
      if (accountId === KNOWN_APPROVED_MOOV.platform.moovAccountId) {
        return jsonResponse([{ capability: 'transfers', status: 'enabled' }]);
      }
      if (accountId === KNOWN_APPROVED_MOOV.c1c.moovAccountId) {
        return jsonResponse([
          { capability: 'send-funds', status: 'enabled' },
          { capability: 'transfers', status: 'enabled' },
          { capability: 'wallet', status: 'enabled' },
        ]);
      }
      return jsonResponse([
        { capability: 'collect-funds', status: 'enabled' },
        { capability: 'send-funds', status: 'enabled' },
        { capability: 'transfers', status: 'enabled' },
        { capability: 'wallet', status: 'enabled' },
      ]);
    }
    if (target.includes('/bank-accounts')) {
      const accountId = target.match(/accounts\/([^/]+)/)?.[1];
      if (accountId === KNOWN_APPROVED_MOOV.recipient.moovAccountId) {
        return jsonResponse([{
          bankAccountID: KNOWN_APPROVED_MOOV.recipient.bankId,
          bankName: 'CHASE',
          lastFourAccountNumber: '1506',
          status: 'verified',
        }]);
      }
      if (accountId === KNOWN_APPROVED_MOOV.c1c.moovAccountId) {
        return jsonResponse([]);
      }
      return jsonResponse([{
        bankAccountID: KNOWN_APPROVED_MOOV.freedom.bankId,
        bankName: 'WELLS FARGO BANK',
        lastFourAccountNumber: '4573',
        status: 'verified',
      }]);
    }
    if (target.includes('/payment-methods')) {
      const accountId = target.match(/accounts\/([^/]+)/)?.[1];
      if (accountId === KNOWN_APPROVED_MOOV.recipient.moovAccountId) {
        return jsonResponse([{
          paymentMethodID: KNOWN_APPROVED_MOOV.recipient.achCreditStandardPm,
          paymentMethodType: 'ach-credit-standard',
          bankAccountID: KNOWN_APPROVED_MOOV.recipient.bankId,
        }]);
      }
      if (accountId === KNOWN_APPROVED_MOOV.platform.moovAccountId) {
        return jsonResponse([{
          paymentMethodID: PLATFORM_WALLET_PM,
          paymentMethodType: 'moov-wallet',
          walletID: 'platform-wallet',
        }]);
      }
      if (accountId === KNOWN_APPROVED_MOOV.c1c.moovAccountId) {
        return jsonResponse([{
          paymentMethodID: 'c1c-wallet-pm',
          paymentMethodType: 'moov-wallet',
          walletID: C1C_WALLET_ID,
          wallet: { walletID: C1C_WALLET_ID, partnerAccountID: KNOWN_APPROVED_MOOV.platform.moovAccountId },
        }]);
      }
      return jsonResponse([
        {
          paymentMethodID: KNOWN_APPROVED_MOOV.freedom.achDebitFundPm,
          paymentMethodType: 'ach-debit-fund',
          bankAccountID: KNOWN_APPROVED_MOOV.freedom.bankId,
        },
        {
          paymentMethodID: KNOWN_APPROVED_MOOV.freedom.walletPm,
          paymentMethodType: 'moov-wallet',
          walletID: KNOWN_APPROVED_MOOV.freedom.walletId,
          wallet: { walletID: KNOWN_APPROVED_MOOV.freedom.walletId, partnerAccountID: KNOWN_APPROVED_MOOV.platform.moovAccountId },
          partnerAccountID: KNOWN_APPROVED_MOOV.platform.moovAccountId,
        },
        {
          paymentMethodID: KNOWN_APPROVED_MOOV.freedom.achCreditStandardPm,
          paymentMethodType: 'ach-credit-standard',
          bankAccountID: KNOWN_APPROVED_MOOV.freedom.bankId,
        },
      ]);
    }
    if (target.includes('/sweeps')) {
      return jsonResponse([{
        sweepID: 'sweep-1',
        status: sweepStatus,
        minimumBalance: { value: sweepMin, currency: 'USD' },
      }]);
    }
    if (/\/wallets\/[^/]+$/.test(target) || target.includes('/wallets/')) {
      const accountId = target.match(/accounts\/([^/]+)/)?.[1];
      const walletId = accountId === KNOWN_APPROVED_MOOV.c1c.moovAccountId
        ? C1C_WALLET_ID
        : KNOWN_APPROVED_MOOV.freedom.walletId;
      return jsonResponse({
        walletID: walletId,
        status: 'active',
        availableBalance: { value: walletAvailable, currency: 'USD' },
        pendingBalance: { value: extraPending, currency: 'USD' },
      });
    }
    if (/\/wallets$/.test(target)) {
      const accountId = target.match(/accounts\/([^/]+)/)?.[1];
      if (accountId === KNOWN_APPROVED_MOOV.c1c.moovAccountId) {
        return jsonResponse([{ walletID: C1C_WALLET_ID, name: 'Operating' }]);
      }
      if (accountId === KNOWN_APPROVED_MOOV.platform.moovAccountId) {
        return jsonResponse([{ walletID: 'platform-wallet', name: 'Platform' }]);
      }
      return jsonResponse([{ walletID: KNOWN_APPROVED_MOOV.freedom.walletId, name: 'Operating' }]);
    }
    if (/\/accounts\/[^/]+$/.test(target)) {
      const accountId = target.split('/').pop();
      const verified = { verification: { status: 'verified' } };
      const profile = accountId === KNOWN_APPROVED_MOOV.recipient.moovAccountId
        ? { individual: { ...verified, name: { firstName: 'Vendor' } } }
        : { business: { legalBusinessName: 'Tenant', ...verified } };
      return jsonResponse({
        accountID: accountId,
        termsOfService: { acceptedDate: '2026-01-01T00:00:00Z' },
        profile,
      });
    }
    return jsonResponse({ error: 'unexpected' }, 404);
  };
};

const fundDeps = (store, extra = {}) => ({
  loadDatabaseCredentials: async () => ({ host: 'localhost', username: 'checksops', password: 'x', database: 'checksops' }),
  createClient: () => identityClient(store),
  fetchImpl: extra.fetchImpl || mockMoovFetch(store, extra),
  loadProductionSecrets: async () => loadProductionMoovReadSecrets(async () => productionSecrets),
});

describe('M7.2 no-re-KYC Moov sequences', { concurrency: 1 }, () => {
test('family-enabled capabilities are never requested again', () => {
  const freedom = [
    { capability: 'collect-funds', status: 'enabled' },
    { capability: 'send-funds', status: 'enabled' },
    { capability: 'transfers', status: 'enabled' },
    { capability: 'wallet', status: 'enabled' },
  ];
  assert.deepEqual(capabilitiesToRequest(freedom), []);
  assert.deepEqual(capabilitiesStillNeeded(freedom, ['send-funds.ach', 'wallet.balance']), []);
  const flags = capabilityFlags(freedom);
  assert.equal(flags.can_ach_debit, true);
  assert.equal(flags.can_ach_credit, true);
  assert.equal(flags.can_send_payments, true);
});

test('KYC, capability POST, and account create are blocked', () => {
  assert.equal(refuseKycOrCapabilityWrite({ method: 'POST', path: '/accounts/abc/capabilities' }).error, 'moov_kyc_rerequest_blocked');
  assert.equal(refuseKycOrCapabilityWrite({ method: 'POST', path: '/accounts' }).error, 'moov_kyc_rerequest_blocked');
  assert.equal(refuseKycOrCapabilityWrite({ method: 'GET', path: '/accounts/abc/capabilities' }), null);
});

test('production HTTP allowlist allows GET including sweep-configs, transfer POST, and sweep PATCH', () => {
  assert.doesNotThrow(() => assertProductionMoovGet({
    method: 'GET',
    path: `/accounts/${KNOWN_APPROVED_MOOV.freedom.moovAccountId}/capabilities`,
  }));
  assert.doesNotThrow(() => assertProductionMoovGet({
    method: 'GET',
    path: `/accounts/${KNOWN_APPROVED_MOOV.freedom.moovAccountId}/sweep-configs`,
  }));
  assert.doesNotThrow(() => assertProductionMoovTransferPost({
    method: 'POST',
    path: `/accounts/${KNOWN_APPROVED_MOOV.platform.moovAccountId}/transfers`,
  }));
  assert.throws(
    () => assertProductionMoovTransferPost({
      method: 'POST',
      path: `/accounts/${KNOWN_APPROVED_MOOV.freedom.moovAccountId}/capabilities`,
    }),
    (error) => error instanceof ProductionMoovError && error.code === 'moov_kyc_rerequest_blocked',
  );
  assert.throws(
    () => assertProductionMoovGet({
      method: 'POST',
      path: `/accounts/${KNOWN_APPROVED_MOOV.freedom.moovAccountId}/capabilities`,
    }),
    (error) => error.code === 'read_only_method_denied',
  );
});

test('enabled sweep with $0 minimum blocks Test 1', () => {
  assert.equal(sweepBlocksFirstCent([{ status: 'enabled', minimumBalance: { value: 0 } }]), true);
  assert.equal(sweepBlocksFirstCent([{ status: 'enabled', minimumBalance: { value: '0.00' } }]), true);
  assert.equal(sweepBlocksFirstCent([{ status: 'disabled', minimumBalance: { value: 0 } }]), false);
  assert.equal(sweepBlocksFirstCent([{ status: 'enabled', minimumBalance: { value: 150 } }]), false);
});

test('default holds keep production Moov writers unreachable', async () => {
  const result = await withEnv({
    AWS_PROVIDER_EXECUTION_ENABLED: undefined,
    AWS_MOOV_ENABLED: undefined,
    AWS_FINANCIAL_PERMISSIONS_ACTIVATED: undefined,
    AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: undefined,
  }, () => handler(jwtEvent('/functions/v1/moov-wallet-fund', 'POST', {
    tenant_id: FREEDOM_TENANT,
    amount_cents: 1,
  })));
  const body = JSON.parse(result.body);
  assert.equal(result.statusCode, 403);
  assert.ok(['provider_disabled', 'production_execution_blocked'].includes(body.error));
  assert.equal(productionMoovExecutionAllowed(), false);
  assert.notEqual(body.liveProviderCalled, true);
});

test('initiate-wallet-funding is refused so A and B stay separate', async () => {
  const store = createStore();
  const result = await withEnv(productionFlags, () => handleProviderRequest(
    jwtEvent('/functions/v1/initiate-wallet-funding', 'POST', { tenant_id: FREEDOM_TENANT, amount_cents: 1 }),
    '/functions/v1/initiate-wallet-funding',
    'POST',
    fundDeps(store),
  ));
  assert.equal(result.statusCode, 403);
  assert.equal(result.error, 'use_separate_fund_and_disburse');
  assert.equal(result.liveProviderCalled, false);
  assert.equal(store.transferPosts || 0, 0);
});

test('BANK→WALLET refuses amounts above the 1 cent first-transfer cap', async () => {
  resetProductionMoovTokenCache();
  const store = createStore();
  grantStepUp(store, { amountCents: 2 });
  const result = await withEnv(productionFlags, () => handleProductionMoovWalletFund({
    client: identityClient(store),
    mapping,
    claims: { sub: COGNITO_SUB },
    body: { tenant_id: FREEDOM_TENANT, amount_cents: 2 },
    spoof: {},
    fetchImpl: mockMoovFetch(store),
    deps: fundDeps(store),
  }));
  assert.equal(result.error, 'first_transfer_cap');
  assert.equal(result.liveProviderCalled, false);
  assert.equal(FIRST_PRODUCTION_TRANSFER_CENTS, 1);
});

test('BANK→WALLET refuses when Sweep minimum is $0; no transfer POST', async () => {
  resetProductionMoovTokenCache();
  const store = createStore();
  grantStepUp(store);
  const result = await withEnv(productionFlags, () => handleProductionMoovWalletFund({
    client: identityClient(store),
    mapping,
    claims: { sub: COGNITO_SUB },
    body: { tenant_id: FREEDOM_TENANT, amount_cents: 1 },
    spoof: {},
    fetchImpl: mockMoovFetch(store, { sweepMin: '0.00', sweepStatus: 'enabled' }),
    deps: { loadProductionSecrets: async () => loadProductionMoovReadSecrets(async () => productionSecrets) },
  }));
  assert.equal(result.error, 'sweep_minimum_blocks_test');
  assert.equal(result.kycRequested, false);
  assert.equal(result.capabilitiesPosted, false);
  assert.equal(store.transferPosts || 0, 0);
  assert.equal(store.capabilityPosts || 0, 0);
  assert.ok(store.moovCalls.every((call) => call.method === 'GET' || call.url.includes('/oauth2/token')));
});

test('BANK→WALLET requires Financial TOTP bound to wallet.fund', async () => {
  resetProductionMoovTokenCache();
  const store = createStore();
  const result = await withEnv(productionFlags, () => handleProductionMoovWalletFund({
    client: identityClient(store),
    mapping,
    claims: { sub: COGNITO_SUB },
    body: { tenant_id: FREEDOM_TENANT, amount_cents: 1 },
    spoof: {},
    fetchImpl: mockMoovFetch(store, { sweepStatus: 'disabled' }),
    deps: { loadProductionSecrets: async () => loadProductionMoovReadSecrets(async () => productionSecrets) },
  }));
  assert.equal(result.error, 'financial_totp_required');
  assert.equal(store.transferPosts || 0, 0);
});

test('BANK→WALLET posts one facilitator transfer after TOTP when sweep is contained', async () => {
  resetProductionMoovTokenCache();
  const store = createStore();
  grantStepUp(store);
  const result = await withEnv(productionFlags, () => handleProductionMoovWalletFund({
    client: identityClient(store),
    mapping,
    claims: { sub: COGNITO_SUB },
    body: { tenant_id: FREEDOM_TENANT, amount_cents: 1, idempotency_key: 'fund-test-1' },
    spoof: {},
    fetchImpl: mockMoovFetch(store, { sweepStatus: 'disabled' }),
    deps: { loadProductionSecrets: async () => loadProductionMoovReadSecrets(async () => productionSecrets) },
  }));
  assert.equal(result.ok, true, result.error || JSON.stringify(result));
  assert.equal(result.operation, 'wallet.fund');
  assert.equal(result.kycRequested, false);
  assert.equal(result.capabilitiesPosted, false);
  assert.equal(result.autoSendAfterFunding, false);
  assert.equal(store.transferPosts, 1);
  assert.equal(store.capabilityPosts || 0, 0);
  assert.equal(store.transfers[0].environment, 'production');
  assert.equal(store.transfers[0].provider_transfer_id, 'tr_test_1');
  assert.ok(store.moovCalls.some((call) => call.method === 'POST' && /\/transfers$/.test(call.url)));
  assert.ok(!store.moovCalls.some((call) => /capabilities/.test(call.url) && call.method === 'POST'));
});

test('WALLET→RECIPIENT refuses internal bypass and bank fallback', async () => {
  const store = createStore();
  const bypass = await withEnv(productionFlags, () => handleProductionMoovWalletDisburse({
    client: identityClient(store),
    mapping,
    claims: { sub: COGNITO_SUB },
    body: { tenant_id: FREEDOM_TENANT, amount_cents: 1 },
    spoof: {},
    fetchImpl: mockMoovFetch(store),
    deps: { internalBypass: true },
  }));
  assert.equal(bypass.error, 'internal_bypass_refused');
  assert.equal(bypass.liveProviderCalled, false);

  const bank = await withEnv(productionFlags, () => handleProductionMoovWalletDisburse({
    client: identityClient(store),
    mapping,
    claims: { sub: COGNITO_SUB },
    body: { tenant_id: FREEDOM_TENANT, amount_cents: 1, source_kind: 'bank' },
    spoof: {},
    fetchImpl: mockMoovFetch(store),
    deps: {},
  }));
  assert.equal(bank.error, 'bank_to_recipient_refused');
  assert.equal(store.transferPosts || 0, 0);
});

test('WALLET→RECIPIENT refuses when wallet available is below 1 cent', async () => {
  resetProductionMoovTokenCache();
  const store = createStore();
  grantStepUp(store, {
    actionKey: 'wallet.disburse',
    sourcePm: KNOWN_APPROVED_MOOV.freedom.walletPm,
    destPm: KNOWN_APPROVED_MOOV.recipient.achCreditStandardPm,
  });
  const result = await withEnv(productionFlags, () => handleProductionMoovWalletDisburse({
    client: identityClient(store),
    mapping,
    claims: { sub: COGNITO_SUB },
    body: {
      tenant_id: FREEDOM_TENANT,
      amount_cents: 1,
      source_kind: 'wallet',
      external_recipient_id: VENDOR_RECIPIENT_ID,
      checkalt_deposit_id: CLEARED_DEPOSIT_ID,
    },
    spoof: {},
    fetchImpl: mockMoovFetch(store, { walletAvailable: 0 }),
    deps: { loadProductionSecrets: async () => loadProductionMoovReadSecrets(async () => productionSecrets) },
  }));
  assert.equal(result.error, 'wallet_balance_insufficient');
  assert.equal(result.bankFallback, false);
  assert.equal(store.transferPosts || 0, 0);
});

test('WALLET→RECIPIENT requires a named already-verified payee', async () => {
  const store = createStore();
  const result = await withEnv(productionFlags, () => handleProductionMoovWalletDisburse({
    client: identityClient(store),
    mapping,
    claims: { sub: COGNITO_SUB },
    body: { tenant_id: FREEDOM_TENANT, amount_cents: 1, checkalt_deposit_id: CLEARED_DEPOSIT_ID },
    spoof: {},
    fetchImpl: mockMoovFetch(store),
    deps: {},
  }));
  assert.equal(result.error, 'recipient_required');
  assert.equal(store.transferPosts || 0, 0);
});

test('WALLET→RECIPIENT refuses an unverified payee without KYC', async () => {
  const store = createStore();
  const result = await withEnv(productionFlags, () => handleProductionMoovWalletDisburse({
    client: identityClient(store),
    mapping,
    claims: { sub: COGNITO_SUB },
    body: {
      tenant_id: FREEDOM_TENANT,
      amount_cents: 1,
      external_recipient_id: UNVERIFIED_RECIPIENT_ID,
      checkalt_deposit_id: CLEARED_DEPOSIT_ID,
    },
    spoof: {},
    fetchImpl: mockMoovFetch(store),
    deps: {},
  }));
  assert.equal(result.error, 'unknown_recipient_do_not_kyc');
  assert.equal(store.transferPosts || 0, 0);
  assert.equal(store.capabilityPosts || 0, 0);
});

test('WALLET→RECIPIENT refuses before CheckAlt has cleared', async () => {
  const store = createStore();
  const missing = await withEnv(productionFlags, () => handleProductionMoovWalletDisburse({
    client: identityClient(store),
    mapping,
    claims: { sub: COGNITO_SUB },
    body: { tenant_id: FREEDOM_TENANT, amount_cents: 1, external_recipient_id: VENDOR_RECIPIENT_ID },
    spoof: {},
    fetchImpl: mockMoovFetch(store),
    deps: {},
  }));
  assert.equal(missing.error, 'check_not_cleared');

  const pending = await withEnv(productionFlags, () => handleProductionMoovWalletDisburse({
    client: identityClient(store),
    mapping,
    claims: { sub: COGNITO_SUB },
    body: {
      tenant_id: FREEDOM_TENANT,
      amount_cents: 1,
      external_recipient_id: VENDOR_RECIPIENT_ID,
      checkalt_deposit_id: PENDING_DEPOSIT_ID,
    },
    spoof: {},
    fetchImpl: mockMoovFetch(store),
    deps: {},
  }));
  assert.equal(pending.error, 'check_not_cleared');
  assert.equal(store.transferPosts || 0, 0);
});

test('Tenant Management cannot send payouts for a tenant they are not a member of', async () => {
  resetProductionMoovTokenCache();
  const store = createStore();
  store.memberships = [];
  grantStepUp(store, {
    actionKey: 'wallet.disburse',
    sourcePm: KNOWN_APPROVED_MOOV.freedom.walletPm,
    destPm: KNOWN_APPROVED_MOOV.recipient.achCreditStandardPm,
  });
  store.stepups[0].user_id = PLATFORM_APP;
  const result = await withEnv(productionFlags, () => handleProductionMoovWalletDisburse({
    client: identityClient(store, platformMapping),
    mapping: platformMapping,
    claims: { sub: PLATFORM_SUB, email: 'spoof@example.com' },
    body: {
      tenant_id: FREEDOM_TENANT,
      amount_cents: 1,
      source_kind: 'wallet',
      external_recipient_id: VENDOR_RECIPIENT_ID,
      checkalt_deposit_id: CLEARED_DEPOSIT_ID,
      idempotency_key: 'disburse-admin-1',
    },
    spoof: {},
    fetchImpl: mockMoovFetch(store, { walletAvailable: 1, sweepStatus: 'disabled' }),
    deps: { loadProductionSecrets: async () => loadProductionMoovReadSecrets(async () => productionSecrets) },
  }));
  assert.equal(result.error, 'tenant_management_send_refused');
  assert.equal(result.ok, false);
  assert.equal(store.transferPosts || 0, 0);
});

test('process-funded-payment requires a manual send and refuses internal auto-send', async () => {
  const store = createStore();
  const bypass = await withEnv(productionFlags, () => handleProductionMoovProcessFundedPayment({
    client: identityClient(store),
    mapping,
    claims: { sub: COGNITO_SUB },
    body: { payment_id: QUEUE_ID, internal: true },
    spoof: {},
    deps: { internalBypass: true },
  }));
  assert.equal(bypass.error, 'internal_bypass_refused');

  const manual = await withEnv(productionFlags, () => handleProductionMoovProcessFundedPayment({
    client: identityClient(store),
    mapping,
    claims: { sub: COGNITO_SUB },
    body: { payment_id: QUEUE_ID },
    spoof: {},
    deps: {},
  }));
  assert.equal(manual.reason, 'manual_send_required');
  assert.equal(manual.autoSend, false);
  assert.equal(store.transferPosts || 0, 0);
});

test('Tenant Management can fee-collect without tenant membership; tenant members cannot', async () => {
  resetProductionMoovTokenCache();
  const store = createStore();
  store.memberships = [];
  grantStepUp(store, {
    actionKey: 'platform.fee_collect',
    sourcePm: KNOWN_APPROVED_MOOV.freedom.achDebitFundPm,
    destPm: PLATFORM_WALLET_PM,
  });
  store.stepups[0].user_id = PLATFORM_APP;

  const tenantDenied = await withEnv(productionFlags, () => handleProductionMoovTenantFeeCharge({
    client: identityClient(store),
    mapping,
    claims: { sub: COGNITO_SUB, email: 'checksopsadmin@gmail.com' },
    body: { tenant_id: FREEDOM_TENANT, amount_cents: 1 },
    spoof: {},
    fetchImpl: mockMoovFetch(store, { sweepStatus: 'disabled' }),
    deps: { loadProductionSecrets: async () => loadProductionMoovReadSecrets(async () => productionSecrets) },
  }));
  assert.equal(tenantDenied.error, 'platform_owner_required');
  assert.equal(isPlatformOwnerCaller(mapping), false);
  assert.equal(isPlatformOwnerCaller({ ...mapping, email: 'checksopsadmin@gmail.com', application_user_id: PLATFORM_APP }), true);

  const pulled = await withEnv(productionFlags, () => handleProductionMoovTenantFeeCharge({
    client: identityClient(store, platformMapping),
    mapping: platformMapping,
    claims: { sub: PLATFORM_SUB, email: 'spoof@example.com' },
    body: { tenant_id: FREEDOM_TENANT, amount_cents: 1, idempotency_key: 'fee-test-1' },
    spoof: {},
    fetchImpl: mockMoovFetch(store, { sweepStatus: 'disabled' }),
    deps: { loadProductionSecrets: async () => loadProductionMoovReadSecrets(async () => productionSecrets) },
  }));
  assert.equal(pulled.ok, true, pulled.error || JSON.stringify(pulled));
  assert.equal(pulled.operation, 'platform.fee_collect');
  assert.equal(pulled.kycRequested, false);
  assert.equal(pulled.capabilitiesPosted, false);
  assert.equal(store.transferPosts, 1);
  assert.equal(store.capabilityPosts || 0, 0);
});

test('C1C BANK→WALLET and fee-collect refuse without collect-funds and never POST capabilities', async () => {
  resetProductionMoovTokenCache();
  const store = createStore();
  store.memberships = [{ tenant_id: C1C_TENANT, role: 'admin', tenant_name: 'C1C', tenant_slug: 'c1c' }];
  grantStepUp(store, { amountCents: 1 });
  store.stepups[0].tenant_id = C1C_TENANT;
  const fund = await withEnv(productionFlags, () => handleProductionMoovWalletFund({
    client: identityClient(store),
    mapping,
    claims: { sub: COGNITO_SUB },
    body: { tenant_id: C1C_TENANT, amount_cents: 1 },
    spoof: {},
    fetchImpl: mockMoovFetch(store, { sweepStatus: 'disabled' }),
    deps: { loadProductionSecrets: async () => loadProductionMoovReadSecrets(async () => productionSecrets) },
  }));
  assert.equal(fund.error, 'collect_funds_not_enabled');
  assert.equal(store.transferPosts || 0, 0);
  assert.equal(store.capabilityPosts || 0, 0);
  assert.ok(isDeniedDuplicateMoovAccount('7c50c273-89ec-4651-addc-f27330fd4360'));

  grantStepUp(store, {
    actionKey: 'platform.fee_collect',
    sourcePm: KNOWN_APPROVED_MOOV.freedom.achDebitFundPm,
    destPm: PLATFORM_WALLET_PM,
  });
  store.stepups.at(-1).user_id = PLATFORM_APP;
  store.stepups.at(-1).tenant_id = C1C_TENANT;
  const fee = await withEnv(productionFlags, () => handleProductionMoovTenantFeeCharge({
    client: identityClient(store, platformMapping),
    mapping: platformMapping,
    claims: { sub: PLATFORM_SUB },
    body: { tenant_id: C1C_TENANT, amount_cents: 1 },
    spoof: {},
    fetchImpl: mockMoovFetch(store),
    deps: { loadProductionSecrets: async () => loadProductionMoovReadSecrets(async () => productionSecrets) },
  }));
  assert.equal(fee.error, 'collect_funds_not_enabled');
  assert.equal(store.transferPosts || 0, 0);
  assert.equal(store.capabilityPosts || 0, 0);
});

test('wallet-fund-on-clear funds after CheckAlt clear and does not auto-disburse', async () => {
  resetProductionMoovTokenCache();
  const store = createStore();
  grantStepUp(store);
  const result = await withEnv(productionFlags, () => handleProductionMoovWalletFundOnClear({
    client: identityClient(store),
    mapping,
    claims: { sub: COGNITO_SUB },
    body: { queue_id: QUEUE_ID },
    spoof: {},
    fetchImpl: mockMoovFetch(store, { sweepStatus: 'disabled' }),
    deps: { loadProductionSecrets: async () => loadProductionMoovReadSecrets(async () => productionSecrets) },
  }));
  assert.equal(result.ok, true, result.error || JSON.stringify(result));
  assert.equal(result.operation, 'wallet.fund');
  assert.equal(result.autoSendAfterFunding, false);
  assert.equal(store.transferPosts, 1);
});

test('Tenant Management can refund; tenant members cannot; TM cannot fund', async () => {
  resetProductionMoovTokenCache();
  const store = createStore();
  store.memberships = [];
  grantStepUp(store, {
    actionKey: 'platform.refund',
    sourcePm: PLATFORM_WALLET_PM,
    destPm: KNOWN_APPROVED_MOOV.freedom.walletPm,
  });
  store.stepups[0].user_id = PLATFORM_APP;

  const tenantDenied = await withEnv(productionFlags, () => handleProductionMoovRefund({
    client: identityClient(store),
    mapping,
    claims: { sub: COGNITO_SUB, email: 'checksopsadmin@gmail.com' },
    body: { tenant_id: FREEDOM_TENANT, amount_cents: 1 },
    spoof: {},
    fetchImpl: mockMoovFetch(store, { sweepStatus: 'disabled' }),
    deps: { loadProductionSecrets: async () => loadProductionMoovReadSecrets(async () => productionSecrets) },
  }));
  assert.equal(tenantDenied.error, 'platform_owner_required');

  const refunded = await withEnv(productionFlags, () => handleProductionMoovRefund({
    client: identityClient(store, platformMapping),
    mapping: platformMapping,
    claims: { sub: PLATFORM_SUB, email: 'spoof@example.com' },
    body: { tenant_id: FREEDOM_TENANT, amount_cents: 1, idempotency_key: 'refund-test-1' },
    spoof: {},
    fetchImpl: mockMoovFetch(store, { sweepStatus: 'disabled' }),
    deps: { loadProductionSecrets: async () => loadProductionMoovReadSecrets(async () => productionSecrets) },
  }));
  assert.equal(refunded.ok, true, refunded.error || JSON.stringify(refunded));
  assert.equal(refunded.operation, 'platform.refund');
  assert.equal(refunded.kycRequested, false);
  assert.equal(refunded.capabilitiesPosted, false);
  assert.equal(store.transferPosts, 1);

  grantStepUp(store, { actionKey: 'wallet.fund' });
  store.stepups.at(-1).user_id = PLATFORM_APP;
  const fund = await withEnv(productionFlags, () => handleProductionMoovWalletFund({
    client: identityClient(store, platformMapping),
    mapping: platformMapping,
    claims: { sub: PLATFORM_SUB },
    body: { tenant_id: FREEDOM_TENANT, amount_cents: 1 },
    spoof: {},
    fetchImpl: mockMoovFetch(store, { sweepStatus: 'disabled' }),
    deps: { loadProductionSecrets: async () => loadProductionMoovReadSecrets(async () => productionSecrets) },
  }));
  assert.equal(fund.error, 'tenant_management_send_refused');
  assert.equal(store.transferPosts, 1);
});

test('live-read wallet snapshot works with money flags false and never POSTs transfers or capabilities', async () => {
  resetProductionMoovTokenCache();
  const store = createStore();
  store.transfers.push({
    tenant_id: FREEDOM_TENANT,
    amount_cents: 250,
    status: 'pending',
    leg_role: 'funding',
  });
  store.transfers.push({
    tenant_id: FREEDOM_TENANT,
    amount_cents: 75,
    status: 'submitted',
    leg_role: 'payout',
  });
  const liveReads = {
    AWS_PROVIDER_LIVE_READS_ENABLED: 'true',
    AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: undefined,
    AWS_PROVIDER_EXECUTION_ENABLED: undefined,
    AWS_MOOV_ENABLED: undefined,
    AWS_FINANCIAL_PERMISSIONS_ACTIVATED: undefined,
    PROVIDER_SECRETS_ARN: productionFlags.PROVIDER_SECRETS_ARN,
  };
  const result = await withEnv(liveReads, () => handleProductionMoovWalletStatus({
    client: identityClient(store),
    mapping,
    claims: { sub: COGNITO_SUB },
    body: { tenant_id: FREEDOM_TENANT },
    spoof: {},
    fetchImpl: mockMoovFetch(store, { walletAvailable: 1234, extraPending: 50, sweepStatus: 'enabled', sweepMin: '0.00' }),
    deps: { loadProductionSecrets: async () => loadProductionMoovReadSecrets(async () => productionSecrets) },
  }));
  assert.equal(result.ok, true, result.error || JSON.stringify(result));
  assert.equal(result.productionExecution, false);
  assert.equal(result.kycRequested, false);
  assert.equal(result.capabilitiesPosted, false);
  assert.equal(store.transferPosts || 0, 0);
  assert.equal(store.capabilityPosts || 0, 0);
  assert.equal(result.wallet.available_cents, 1234);
  assert.equal(result.pending_in_cents, 250);
  assert.equal(result.pending_out_cents, 75);
  assert.equal(result.verification.account_verified, true);
  assert.ok(result.verification.what_is_verified.some((item) => /identity/i.test(item)));
  assert.equal(result.settlement_method.last_four, '4573');
  assert.equal(result.sweep_config.status, 'enabled');
  assert.equal(result.sweep_config.minimum_balance_cents, 0);
  assert.ok((result.readiness?.checks || []).some((check) => check.id === 'identity_verification'));
  assert.ok(store.moovCalls.every((call) => call.method === 'GET' || call.url.includes('/oauth2/token')));
});

test('moov-readiness live GET never POSTs capabilities', async () => {
  resetProductionMoovTokenCache();
  const store = createStore();
  const result = await withEnv({
    AWS_PROVIDER_LIVE_READS_ENABLED: 'true',
    AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: undefined,
    PROVIDER_SECRETS_ARN: productionFlags.PROVIDER_SECRETS_ARN,
  }, () => handleProductionMoovReadiness({
    client: identityClient(store),
    mapping,
    claims: { sub: COGNITO_SUB },
    body: { tenant_id: FREEDOM_TENANT },
    spoof: {},
    fetchImpl: mockMoovFetch(store),
    deps: { loadProductionSecrets: async () => loadProductionMoovReadSecrets(async () => productionSecrets) },
  }));
  assert.equal(result.ok, true, result.error || JSON.stringify(result));
  assert.equal(result.readiness.liveProviderCalled, true);
  assert.equal(result.readiness.overall, 'ready');
  assert.equal(result.readiness.canMoveMoney, true);
  assert.equal(result.readiness.isSandbox, false);
  const feePlan = (result.readiness.checks || []).find((check) => check.id === 'fee_plan');
  assert.equal(feePlan?.state, 'ready');
  const collect = (result.readiness.checks || []).find((check) => check.id === 'collect_funds_ach');
  assert.equal(collect?.state, 'ready');
  assert.equal(store.capabilityPosts || 0, 0);
  assert.equal(store.transferPosts || 0, 0);
  assert.equal(store.accounts[0].can_ach_debit, true);
  assert.equal(store.accounts[0].can_ach_credit, true);
  assert.equal(store.stakeholders[0].verification_status, 'verified');
  assert.ok((result.payees || []).some((payee) => (
    payee.moov_account_id === KNOWN_APPROVED_MOOV.recipient.moovAccountId
    && payee.verification_status === 'verified'
    && payee.bank_verified === true
  )));
  assert.ok(store.moovCalls.every((call) => call.method === 'GET' || call.url.includes('/oauth2/token')));
});

test('C1C live readiness is send-ready without collect-funds and never requests it', async () => {
  resetProductionMoovTokenCache();
  const store = createStore();
  store.memberships.push({ tenant_id: C1C_TENANT, role: 'admin', tenant_name: 'C1C', tenant_slug: 'c1c' });
  const result = await withEnv({
    AWS_PROVIDER_LIVE_READS_ENABLED: 'true',
    AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: undefined,
    PROVIDER_SECRETS_ARN: productionFlags.PROVIDER_SECRETS_ARN,
  }, () => handleProductionMoovReadiness({
    client: identityClient(store),
    mapping,
    claims: { sub: COGNITO_SUB },
    body: { tenant_id: C1C_TENANT },
    spoof: {},
    fetchImpl: mockMoovFetch(store),
    deps: { loadProductionSecrets: async () => loadProductionMoovReadSecrets(async () => productionSecrets) },
  }));
  assert.equal(result.ok, true, result.error || JSON.stringify(result));
  const collect = (result.readiness.checks || []).find((check) => check.id === 'collect_funds_ach');
  assert.equal(collect?.state, 'not_started');
  assert.equal(result.readiness.canMoveMoney, false, 'C1C has no settlement bank in the fixture');
  assert.equal(store.capabilityPosts || 0, 0);
});

test('sweep GET is live-read; enabling at $0 is refused even when money flags are on', async () => {
  resetProductionMoovTokenCache();
  const store = createStore();
  const liveGet = await withEnv({
    AWS_PROVIDER_LIVE_READS_ENABLED: 'true',
    AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: undefined,
    PROVIDER_SECRETS_ARN: productionFlags.PROVIDER_SECRETS_ARN,
  }, () => handleProductionMoovSweepConfig({
    client: identityClient(store),
    mapping,
    claims: { sub: COGNITO_SUB },
    body: { tenant_id: FREEDOM_TENANT, action: 'get' },
    spoof: {},
    fetchImpl: mockMoovFetch(store, { sweepStatus: 'enabled', sweepMin: '0.00' }),
    deps: { loadProductionSecrets: async () => loadProductionMoovReadSecrets(async () => productionSecrets) },
  }));
  assert.equal(liveGet.ok, true, liveGet.error || JSON.stringify(liveGet));
  assert.equal(liveGet.sweep_config.status, 'enabled');
  assert.equal(store.sweepWrites || 0, 0);
  assert.equal(store.transferPosts || 0, 0);

  const blockedWrite = await withEnv({
    AWS_PROVIDER_LIVE_READS_ENABLED: 'true',
    AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: undefined,
    PROVIDER_SECRETS_ARN: productionFlags.PROVIDER_SECRETS_ARN,
  }, () => handleProductionMoovSweepConfig({
    client: identityClient(store),
    mapping,
    claims: { sub: COGNITO_SUB },
    body: {
      tenant_id: FREEDOM_TENANT,
      action: 'create',
      minimum_balance_cents: 15000,
      push_rail: 'ach-credit-standard',
    },
    spoof: {},
    fetchImpl: mockMoovFetch(store),
    deps: { loadProductionSecrets: async () => loadProductionMoovReadSecrets(async () => productionSecrets) },
  }));
  assert.equal(blockedWrite.error, 'production_execution_blocked');
  assert.equal(store.sweepWrites || 0, 0);

  const zeroMin = await withEnv(productionFlags, () => handleProductionMoovSweepConfig({
    client: identityClient(store),
    mapping,
    claims: { sub: COGNITO_SUB },
    body: {
      tenant_id: FREEDOM_TENANT,
      action: 'create',
      minimum_balance_cents: 0,
      status: 'enabled',
      push_rail: 'ach-credit-standard',
    },
    spoof: {},
    fetchImpl: mockMoovFetch(store),
    deps: { loadProductionSecrets: async () => loadProductionMoovReadSecrets(async () => productionSecrets) },
  }));
  assert.equal(zeroMin.error, 'sweep_minimum_blocks_test');
  assert.equal(store.sweepWrites || 0, 0);
});

test('handleProviderRequest serves wallet-status when live reads are on and money flags are off', async () => {
  resetProductionMoovTokenCache();
  const store = createStore();
  const result = await withEnv({
    AWS_PROVIDER_LIVE_READS_ENABLED: 'true',
    AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: undefined,
    AWS_PROVIDER_EXECUTION_ENABLED: undefined,
    AWS_MOOV_ENABLED: undefined,
    AWS_FINANCIAL_PERMISSIONS_ACTIVATED: undefined,
    PROVIDER_SECRETS_ARN: productionFlags.PROVIDER_SECRETS_ARN,
  }, () => handleProviderRequest(
    jwtEvent('/functions/v1/moov-wallet-status', 'POST', { tenant_id: FREEDOM_TENANT }),
    '/functions/v1/moov-wallet-status',
    'POST',
    fundDeps(store, { walletAvailable: 50, extraPending: 10, sweepStatus: 'disabled' }),
  ));
  assert.equal(result.ok, true, result.error || JSON.stringify(result));
  assert.equal(result.operation, 'wallet.status');
  assert.equal(result.productionExecution, false);
  assert.equal(store.transferPosts || 0, 0);
  assert.ok(result.wallet);
});
});
