import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LOOKUP_MAPPING_SQL, TENANT_MEMBERSHIP_SQL } from '../functions/api/identity.mjs';
import { handleProviderRequest } from '../functions/api/providers.mjs';
import { resetMoovTokenCache } from '../functions/api/providers/parity/moov-client.mjs';
import { selectRail } from '../functions/api/providers/parity/rail-router.mjs';
import { formatCheckAltUserAmount } from '../functions/api/providers/amounts.mjs';

const FREEDOM_APP = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const FREEDOM_TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const MOOV_ACCOUNT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEST_ACCOUNT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SOURCE_METHOD_ROW = '11111111-1111-4111-8111-111111111111';
const DEST_METHOD_ROW = '22222222-2222-4222-8222-222222222222';
const RECIPIENT_ID = '33333333-3333-4333-8333-333333333333';
const CHECK_ID = '44444444-4444-4444-8444-444444444444';
const PLATFORM_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const jwtEvent = (path, method, body) => ({
  rawPath: path,
  headers: { authorization: 'Bearer test-id-token' },
  body: JSON.stringify(body || {}),
  requestContext: {
    stage: 'staging',
    http: { method, path },
    authorizer: {
      jwt: { claims: { sub: COGNITO_SUB, email: 'checksops-tester@freedomadj.com', token_use: 'id' } },
    },
  },
});

const mapping = {
  application_user_id: FREEDOM_APP,
  cognito_sub: COGNITO_SUB,
  email: 'checksops-tester@freedomadj.com',
  status: 'active',
};

const sandboxCreds = () => ({
  moov: {
    environment: 'sandbox',
    host: 'https://api.moov.io',
    publicKey: 'pk_sandbox',
    secretKey: 'sk_sandbox',
    platformAccountId: PLATFORM_ID,
    origin: 'https://checksops.com',
    apiVersion: 'v2024.01.00',
  },
  checkalt: {
    environment: 'uat',
    baseUrl: 'https://uatapi.checkalt.com',
    username: 'api-login',
    userId: 'api-login',
    password: 'api-password',
    fiKey: 'fi-key-uat',
    merchant: 'lockbox5',
  },
});

const parityClient = ({
  accounts = [{
    id: 'acct-1',
    tenant_id: FREEDOM_TENANT,
    provider: 'moov',
    environment: 'sandbox',
    provider_account_id: MOOV_ACCOUNT,
    onboarding_status: 'active',
    can_send_payments: true,
    can_receive_payments: true,
    can_ach_debit: true,
    can_ach_credit: true,
    display_name: 'Freedom',
    tos_accepted_at: '2024-01-01T00:00:00Z',
  }],
  methods = [{
    id: SOURCE_METHOD_ROW,
    tenant_id: FREEDOM_TENANT,
    provider: 'moov',
    environment: 'sandbox',
    provider_account_id: MOOV_ACCOUNT,
    provider_bank_account_id: 'bank-src',
    provider_payment_method_id: null,
    connection_status: 'connected',
    is_default: true,
    rail_payment_method_ids: { 'ach-debit-fund': 'pm-debit-src' },
  }, {
    id: DEST_METHOD_ROW,
    tenant_id: FREEDOM_TENANT,
    provider: 'moov',
    environment: 'sandbox',
    provider_account_id: DEST_ACCOUNT,
    provider_bank_account_id: 'bank-dst',
    provider_payment_method_id: 'pm-ach-std',
    connection_status: 'connected',
    external_recipient_id: RECIPIENT_ID,
    rail_payment_method_ids: { 'ach-credit-standard': 'pm-ach-std' },
  }],
  recipients = [{
    id: RECIPIENT_ID,
    tenant_id: FREEDOM_TENANT,
    provider_account_id: DEST_ACCOUNT,
    display_name: 'Payee',
  }],
  transfers = [],
  checks = [{
    id: CHECK_ID,
    tenant_id: FREEDOM_TENANT,
    amount: 123.45,
    check_number: '1001',
    front_image_path: 'checks/44444444-4444-4444-8444-444444444444/front.jpg',
    back_image_path: 'checks/44444444-4444-4444-8444-444444444444/back.jpg',
  }],
  uatAccounts = [{
    sandbox_provider_id: 'depositor-1',
    metadata: {
      sso_user_id: 'depositor-1',
      deposit_account_number: '90001111',
      sso_key: 'sso-from-register',
    },
  }],
  operations = [],
} = {}) => {
  const queries = [];
  return {
    queries,
    connect: async () => {},
    end: async () => {},
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT' || sql === 'SET TRANSACTION READ WRITE') {
        return { rows: [] };
      }
      if (sql.startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
      if (sql === LOOKUP_MAPPING_SQL) return { rows: params[0] === mapping.cognito_sub ? [mapping] : [] };
      if (sql.includes('FROM public.tenant_users') || sql === TENANT_MEMBERSHIP_SQL) {
        return { rows: [{ tenant_id: FREEDOM_TENANT, role: 'admin', tenant_name: 'Freedom', tenant_slug: 'freedom' }] };
      }
      if (sql.includes('FROM public.user_roles')) return { rows: [{ role: 'admin' }] };
      if (sql.includes('FROM public.tenants') && sql.includes('moov_allowlisted')) {
        return { rows: [{ moov_allowlisted: true, moov_environment: 'sandbox' }] };
      }
      if (sql.includes('FROM public.tenants')) {
        return { rows: [{ id: FREEDOM_TENANT, name: 'Freedom', legal_business_name: 'Freedom Adj', email_reply_to: 'ops@example.com' }] };
      }
      if (sql.includes('INSERT INTO public.payment_idempotency_keys')) return { rows: [] };
      if (sql.includes('FROM public.payment_provider_accounts') || sql.includes('UPDATE public.payment_provider_accounts')) {
        return { rows: accounts };
      }
      if (sql.includes('INSERT INTO public.payment_provider_accounts')) return { rows: accounts };
      if (sql.includes('FROM public.payment_provider_methods') || sql.includes('UPDATE public.payment_provider_methods')) {
        if (sql.includes('external_recipient_id')) {
          return { rows: methods.filter((m) => m.external_recipient_id === params[0]) };
        }
        return { rows: methods.filter((m) => !m.external_recipient_id || m.provider_account_id === params[1]) };
      }
      if (sql.includes('FROM public.external_payment_recipients')) {
        return { rows: recipients };
      }
      if (sql.includes('FROM public.payment_transfers') && sql.includes('idempotency_key')) {
        return { rows: transfers.filter((t) => t.idempotency_key === params[1]) };
      }
      if (sql.includes('INSERT INTO public.payment_transfers')) {
        const row = {
          id: '55555555-5555-4555-8555-555555555555',
          tenant_id: params[0],
          status: 'ready',
          amount_cents: params[2],
          idempotency_key: params[1],
        };
        transfers.push(row);
        return { rows: [row] };
      }
      if (sql.includes('UPDATE public.payment_transfers')) {
        const row = { ...(transfers[0] || {}), status: params[3], provider_transfer_id: params[1] };
        return { rows: [row] };
      }
      if (sql.includes('INSERT INTO public.payment_event_log')) return { rows: [] };
      if (sql.includes('FROM public.check_intake_items')) {
        return { rows: checks.filter((c) => c.id === params[0] || !params[0]) };
      }
      if (sql.includes('FROM public.aws_provider_sandbox_objects')) {
        return { rows: uatAccounts };
      }
      if (sql.includes('INSERT INTO public.aws_provider_sandbox_operations')) {
        const row = {
          id: '66666666-6666-4666-8666-666666666666',
          tenant_id: params[0],
          status: 'queued',
          amount_cents: params[2],
        };
        operations.push(row);
        return { rows: [row] };
      }
      if (sql.includes('UPDATE public.aws_provider_sandbox_operations')) {
        return { rows: operations };
      }
      if (sql.includes('FROM public.aws_provider_sandbox_operations')) {
        return { rows: operations };
      }
      if (sql.includes('FROM public.payment_wallet_ledger')) return { rows: [] };
      if (sql.includes('FROM public.payment_wallet_sub_ledgers')) return { rows: [] };
      if (sql.includes('FROM public.payment_wallets') || sql.includes('INSERT INTO public.payment_wallets')) {
        return { rows: [{
          id: '77777777-7777-4777-8777-777777777777',
          tenant_id: FREEDOM_TENANT,
          provider_wallet_id: 'wallet-1',
          provider_payment_method_id: 'pm-wallet',
          available_cents: 0,
          pending_cents: 0,
        }] };
      }
      return { rows: [] };
    },
  };
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

const recordedFetch = (routes) => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body });
    const hit = routes.find((r) => String(url).includes(r.match) && (!r.method || (init.method || 'GET') === r.method));
    const payload = hit ? hit.body : { ok: true };
    const status = hit?.status || 200;
    return {
      ok: status < 400,
      status,
      text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
    };
  };
  return { fetchImpl, calls };
};

test('rail router preserves production downgrade semantics', () => {
  const decision = selectRail({
    requestedSpeed: 'instant',
    amountCents: 1000,
    railPaymentMethodIds: { 'ach-credit-standard': 'pm-std' },
    fallbackPaymentMethodId: 'legacy',
  });
  assert.equal(decision.selectedSpeed, 'standard');
  assert.equal(decision.downgraded, true);
  assert.equal(decision.paymentMethodId, 'pm-std');
});

test('sandbox-disabled /functions/v1 still fail-closed', async () => {
  await withEnv({ AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: undefined }, async () => {
    const result = await handleProviderRequest(
      jwtEvent('/functions/v1/moov-transfer-create', 'POST', { tenant_id: FREEDOM_TENANT, amount_cents: 100 }),
      '/functions/v1/moov-transfer-create',
      'POST',
      {
        loadDatabaseCredentials: async () => ({ host: 'localhost', username: 'checksops', password: 'x', database: 'checksops' }),
        createClient: () => parityClient(),
        loadSandboxCredentials: async () => sandboxCreds(),
      },
    );
    assert.equal(result.statusCode, 403);
    assert.equal(result.error, 'provider_disabled');
  });
});

test('moov-transfer-create ports production facilitator POST, integer cents, persist-before-HTTP, pinned version', async () => {
  resetMoovTokenCache();
  const { fetchImpl, calls } = recordedFetch([
    { match: '/oauth2/token', method: 'POST', body: { access_token: 'tok', expires_in: 300 } },
    { match: '/payment-methods', method: 'GET', body: [] },
    { match: '/transfers', method: 'POST', body: { transferID: 'tr_1', status: 'pending', facilitatorFee: { total: 25 } } },
  ]);
  await withEnv({
    AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'true',
    AWS_PROVIDER_EXECUTION_ENABLED: 'false',
    AWS_MOOV_ENABLED: 'false',
  }, async () => {
    const client = parityClient();
    const result = await handleProviderRequest(
      jwtEvent('/functions/v1/moov-transfer-create', 'POST', {
        tenant_id: FREEDOM_TENANT,
        amount_cents: 12345,
        external_recipient_id: RECIPIENT_ID,
        description: 'parity test',
      }),
      '/functions/v1/moov-transfer-create',
      'POST',
      {
        loadDatabaseCredentials: async () => ({ host: 'localhost', username: 'checksops', password: 'x', database: 'checksops' }),
        createClient: () => client,
        loadSandboxCredentials: async () => sandboxCreds(),
        fetchImpl,
      },
    );
    assert.equal(result.success, true);
    assert.equal(result.liveProviderCalled, true);
    assert.equal(result.productionExecution, false);
    assert.equal(result.duplicate, false);
    const oauth = calls.find((c) => c.url.endsWith('/oauth2/token'));
    assert.ok(oauth);
    assert.equal(oauth.headers.Origin, 'https://checksops.com');
    const transfer = calls.find((c) => c.url.includes('/transfers') && c.method === 'POST');
    assert.ok(transfer);
    assert.equal(transfer.url, `https://api.moov.io/accounts/${PLATFORM_ID}/transfers`);
    assert.equal(transfer.headers['x-moov-version'], 'v2024.01.00');
    assert.match(transfer.headers.Authorization, /^Bearer tok$/);
    const payload = JSON.parse(transfer.body);
    assert.deepEqual(payload.amount, { currency: 'USD', value: 12345 });
    assert.equal(payload.source.paymentMethodID, 'pm-debit-src');
    assert.equal(payload.destination.paymentMethodID, 'pm-ach-std');
    const insert = client.queries.find((q) => q.sql.includes('INSERT INTO public.payment_transfers'));
    assert.ok(insert);
    const methodsGet = calls.find((c) => c.url.includes('/payment-methods'));
    assert.ok(methodsGet);
    assert.equal(methodsGet.headers['Content-Type'], 'application/json');
    assert.equal(methodsGet.headers['x-moov-version'], 'v2024.01.00');
    const insertIdx = client.queries.findIndex((q) => q.sql.includes('INSERT INTO public.payment_transfers'));
    const transferCallOrder = calls.findIndex((c) => c.url.includes('/transfers') && c.method === 'POST');
    assert.ok(insertIdx >= 0);
    assert.equal(typeof transferCallOrder, 'number');
  });
});

test('checkalt-submit-deposit uses production auth path, integer cents from check amount, and persist-before-HTTP', async () => {
  const { fetchImpl, calls } = recordedFetch([
    { match: '/public/fincapture/authenticate', method: 'POST', body: 'header.payload.sig' },
    { match: '/fincapture/deposit/process', method: 'POST', body: { referenceNumber: 98765, status: 127 } },
  ]);
  await withEnv({
    AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'true',
    AWS_PROVIDER_EXECUTION_ENABLED: 'false',
    AWS_CHECKALT_ENABLED: 'false',
  }, async () => {
    const client = parityClient();
    const result = await handleProviderRequest(
      jwtEvent('/functions/v1/checkalt-submit-deposit', 'POST', {
        tenant_id: FREEDOM_TENANT,
        check_intake_item_id: CHECK_ID,
      }),
      '/functions/v1/checkalt-submit-deposit',
      'POST',
      {
        loadDatabaseCredentials: async () => ({ host: 'localhost', username: 'checksops', password: 'x', database: 'checksops' }),
        createClient: () => client,
        loadSandboxCredentials: async () => sandboxCreds(),
        fetchImpl,
        downloadClaimFile: async () => {
          const { syntheticCheckRaster } = await import('../functions/api/providers/parity/checkalt-image.mjs');
          return syntheticCheckRaster({ width: 200, height: 160, flat: true });
        },
      },
    );
    assert.equal(result.success, true);
    assert.equal(result.userAmount, 12345);
    assert.equal(formatCheckAltUserAmount(123.45).userAmount, 12345);
    assert.equal(result.scale, 'integer_cents');
    assert.equal(result.reference, '98765');
    assert.equal(result.productionRecordsMutated, false);
    const auth = calls.find((c) => c.url.includes('/public/fincapture/authenticate'));
    assert.ok(auth);
    assert.equal(auth.url, 'https://uatapi.checkalt.com/public/fincapture/authenticate');
    assert.equal(auth.headers.merchant, 'lockbox5');
    const authBody = JSON.parse(auth.body);
    assert.deepEqual(Object.keys(authBody).sort(), ['password', 'userName']);
    assert.equal(authBody.userName, 'api-login');
    const process = calls.find((c) => c.url.includes('/fincapture/deposit/process'));
    assert.ok(process);
    const processBody = JSON.parse(process.body);
    assert.equal(processBody.userAmount, 12345);
    assert.equal(processBody.ssoKey, 'sso-from-register');
    assert.equal(processBody.fiKey, 'fi-key-uat');
    assert.equal(processBody.depositAccountNumber, '90001111');
    assert.equal(processBody.testDeposit, undefined);
    assert.equal(processBody.performRiskAssessment, true);
    assert.equal(processBody.businessUnit, undefined);
    assert.equal(processBody.checkNumber, undefined);
    assert.ok(processBody.frontImage);
    assert.ok(processBody.rearImage);
    assert.ok(!String(processBody.frontImage).startsWith('data:'));
    assert.deepEqual(
      Object.keys(processBody).sort(),
      ['captureDateTime', 'depositAccountNumber', 'fiKey', 'frontImage', 'performRiskAssessment', 'rearImage', 'ssoKey', 'userAmount'],
    );
    assert.ok(!Object.values(processBody).includes('api-login') || processBody.ssoKey !== 'api-login');
    const queued = client.queries.find((q) => q.sql.includes('INSERT INTO public.aws_provider_sandbox_operations'));
    assert.ok(queued);
  });
});

test('checkalt-approve-deposit accepts production deposit_id body and action 1/2', async () => {
  const { fetchImpl, calls } = recordedFetch([
    { match: '/public/fincapture/authenticate', method: 'POST', body: 'header.payload.sig' },
    { match: '/fincapture/deposit/approve', method: 'POST', body: { success: true, status: 'Approved', statusDescription: 'OK' } },
  ]);
  await withEnv({ AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'true' }, async () => {
    const result = await handleProviderRequest(
      jwtEvent('/functions/v1/checkalt-approve-deposit', 'POST', {
        tenant_id: FREEDOM_TENANT,
        deposit_id: '66666666-6666-4666-8666-666666666666',
        action: 'approve',
      }),
      '/functions/v1/checkalt-approve-deposit',
      'POST',
      {
        loadDatabaseCredentials: async () => ({ host: 'localhost', username: 'checksops', password: 'x', database: 'checksops' }),
        createClient: () => parityClient({
          operations: [{
            id: '66666666-6666-4666-8666-666666666666',
            tenant_id: FREEDOM_TENANT,
            provider_reference: '98765',
            status: 'pending_approval',
            metadata: {},
          }],
        }),
        loadSandboxCredentials: async () => sandboxCreds(),
        fetchImpl,
      },
    );
    assert.equal(result.success, true);
    assert.equal(result.status, 'submitted');
    const approve = calls.find((c) => c.url.includes('/fincapture/deposit/approve'));
    assert.ok(approve);
    const payload = JSON.parse(approve.body);
    assert.equal(payload.action, 1);
    assert.equal(payload.referenceNumber, 98765);
    assert.equal(payload.fiKey, 'fi-key-uat');
    assert.equal(payload.ssoKey, undefined);
  });
});

test('checkalt depositor identity is never the UAT API login', async () => {
  await withEnv({ AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'true' }, async () => {
    const result = await handleProviderRequest(
      jwtEvent('/functions/v1/checkalt-register-account', 'POST', {
        tenant_id: FREEDOM_TENANT,
        sso_user_id: 'api-login',
        deposit_account_number: '90001111',
      }),
      '/functions/v1/checkalt-register-account',
      'POST',
      {
        loadDatabaseCredentials: async () => ({ host: 'localhost', username: 'checksops', password: 'x', database: 'checksops' }),
        createClient: () => parityClient(),
        loadSandboxCredentials: async () => sandboxCreds(),
        fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{}' }),
      },
    );
    assert.equal(result.statusCode, 400);
    assert.equal(result.error, 'uat_depositor_must_not_be_api_login');
  });
});
