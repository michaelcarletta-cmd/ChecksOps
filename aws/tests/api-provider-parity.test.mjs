import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LOOKUP_MAPPING_SQL, TENANT_MEMBERSHIP_SQL } from '../functions/api/identity.mjs';
import { handleProviderRequest } from '../functions/api/providers.mjs';
import { resetMoovTokenCache } from '../functions/api/providers/parity/moov-client.mjs';
import { selectRail } from '../functions/api/providers/parity/rail-router.mjs';
import { runParityHandler } from '../functions/api/providers/parity/dispatch.mjs';
import { resolveTenant } from '../functions/api/providers/parity/caller.mjs';
import { formatCheckAltUserAmount } from '../functions/api/providers/amounts.mjs';
import { syntheticCheckRaster } from '../functions/api/providers/parity/checkalt-image.mjs';

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
  tenantRole = 'admin',
  platformAdmin = true,
  platformOwner = false,
} = {}) => {
  const queries = [];
  return {
    queries,
    connect: async () => {},
    end: async () => {},
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (sql.includes('is_platform_owner()')) return { rows: [{ is_owner: platformOwner, ok: platformOwner }] };
      if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT' || sql === 'SET TRANSACTION READ WRITE') {
        return { rows: [] };
      }
      if (sql.startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
      if (sql === LOOKUP_MAPPING_SQL) return { rows: params[0] === mapping.cognito_sub ? [mapping] : [] };
      if (sql.includes('FROM public.tenant_users') || sql === TENANT_MEMBERSHIP_SQL) {
        // tenantRole null: the caller has no tenant_users row at all.
        if (!tenantRole) return { rows: [] };
        if (sql.includes('AND tenant_id = $2') && params[1] !== FREEDOM_TENANT) return { rows: [] };
        return { rows: [{ tenant_id: FREEDOM_TENANT, role: tenantRole, tenant_name: 'Freedom', tenant_slug: 'freedom' }] };
      }
      if (sql.includes('FROM public.user_roles')) return { rows: platformAdmin ? [{ role: 'admin' }] : [] };
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
        // Filter by the bound params, as Postgres would, so lookups by id,
        // by provider reference and by tenant are really exercised.
        const limit = Number(/LIMIT (\d+)/.exec(sql)?.[1] || Infinity);
        let rows = operations.filter((op) => (op.provider || 'checkalt') === 'checkalt');
        if (/WHERE id = \$1/.test(sql)) rows = rows.filter((op) => op.id === params[0]);
        else if (/provider_reference = \$1/.test(sql)) rows = rows.filter((op) => String(op.provider_reference) === String(params[0]));
        else if (/tenant_id = \$1/.test(sql)) rows = rows.filter((op) => op.tenant_id === params[0] && op.provider_reference != null);
        else throw new Error(`unmocked aws_provider_sandbox_operations query: ${sql}`);
        return { rows: rows.slice(0, limit) };
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
          return syntheticCheckRaster({ width: 1400, height: 700, flat: true });
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
    assert.equal(result.imagePipeline, 'browser_prepare_aws_base64');
    const sandboxGuc = client.queries.find((q) => q.sql.includes('set_config') && q.params?.[0] === 'request.provider_sandbox');
    assert.ok(sandboxGuc);
    assert.equal(sandboxGuc.params[1], '1');
  });
});

test('checkalt-submit-deposit Base64s prepared paths and ignores injected client images', async () => {
  const frontBytes = syntheticCheckRaster({ width: 1600, height: 800, seed: 21 });
  const backBytes = syntheticCheckRaster({ width: 1200, height: 583, flat: true });
  const { fetchImpl, calls } = recordedFetch([
    { match: '/public/fincapture/authenticate', method: 'POST', body: 'header.payload.sig' },
    { match: '/fincapture/deposit/process', method: 'POST', body: { referenceNumber: 111, status: 127 } },
  ]);
  const downloaded = [];
  await withEnv({
    AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'true',
    AWS_PROVIDER_EXECUTION_ENABLED: 'false',
    AWS_CHECKALT_ENABLED: 'false',
  }, async () => {
    const client = parityClient({
      checks: [{
        id: CHECK_ID,
        tenant_id: FREEDOM_TENANT,
        amount: 123.45,
        check_number: '1001',
        front_image_path: `checks/${CHECK_ID}/front.jpg`,
        back_image_path: `checks/${CHECK_ID}/back.jpg`,
        back_image_deposit_path: `checks/${CHECK_ID}/endorsed.jpg`,
      }],
    });
    const result = await handleProviderRequest(
      jwtEvent('/functions/v1/checkalt-submit-deposit', 'POST', {
        tenant_id: FREEDOM_TENANT,
        check_intake_item_id: CHECK_ID,
        deposit_front_path: `checks/${CHECK_ID}/front.deposit2.jpg`,
        deposit_back_path: `checks/${CHECK_ID}/endorsed.deposit2.jpg`,
        frontImage: 'SHOULD_BE_IGNORED',
        rearImage: 'ALSO_IGNORED',
      }),
      '/functions/v1/checkalt-submit-deposit',
      'POST',
      {
        loadDatabaseCredentials: async () => ({ host: 'localhost', username: 'checksops', password: 'x', database: 'checksops' }),
        createClient: () => client,
        loadSandboxCredentials: async () => sandboxCreds(),
        fetchImpl,
        downloadClaimFile: async (p) => {
          downloaded.push(p);
          if (String(p).includes('front.deposit2')) return frontBytes;
          if (String(p).includes('endorsed.deposit2')) return backBytes;
          throw new Error(`unexpected download ${p}`);
        },
      },
    );
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.imagePipeline, 'browser_prepare_aws_base64');
    const process = calls.find((c) => c.url.includes('/fincapture/deposit/process'));
    const processBody = JSON.parse(process.body);
    assert.equal(processBody.frontImage, frontBytes.toString('base64'));
    assert.equal(processBody.rearImage, backBytes.toString('base64'));
    assert.notEqual(processBody.frontImage, 'SHOULD_BE_IGNORED');
    assert.ok(Math.max(1200, 583) < 1300);
    assert.deepEqual(downloaded, [
      `checks/${CHECK_ID}/front.deposit2.jpg`,
      `checks/${CHECK_ID}/endorsed.deposit2.jpg`,
    ]);
  });
});

test('checkalt-submit-deposit rejects a prepared path that is not this check', async () => {
  const { fetchImpl } = recordedFetch([
    { match: '/public/fincapture/authenticate', method: 'POST', body: 'header.payload.sig' },
  ]);
  await withEnv({
    AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'true',
    AWS_PROVIDER_EXECUTION_ENABLED: 'false',
    AWS_CHECKALT_ENABLED: 'false',
  }, async () => {
    const result = await handleProviderRequest(
      jwtEvent('/functions/v1/checkalt-submit-deposit', 'POST', {
        tenant_id: FREEDOM_TENANT,
        check_intake_item_id: CHECK_ID,
        deposit_front_path: 'checks/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/front.deposit2.jpg',
      }),
      '/functions/v1/checkalt-submit-deposit',
      'POST',
      {
        loadDatabaseCredentials: async () => ({ host: 'localhost', username: 'checksops', password: 'x', database: 'checksops' }),
        createClient: () => parityClient(),
        loadSandboxCredentials: async () => sandboxCreds(),
        fetchImpl,
        downloadClaimFile: async () => syntheticCheckRaster({ width: 1400, height: 700, flat: true }),
      },
    );
    assert.equal(result.success, false);
    assert.equal(result.error, 'prepared_path_denied');
    assert.equal(result.statusCode, 403);
  });
});

test('checkalt-submit-deposit requires browser prep for oversized originals', async () => {
  const oversized = syntheticCheckRaster({ width: 2200, height: 1400, seed: 11 });
  assert.ok(oversized.length > 450_000);
  const { fetchImpl, calls } = recordedFetch([
    { match: '/public/fincapture/authenticate', method: 'POST', body: 'header.payload.sig' },
    { match: '/fincapture/deposit/process', method: 'POST', body: { referenceNumber: 1, status: 127 } },
  ]);
  await withEnv({
    AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'true',
    AWS_PROVIDER_EXECUTION_ENABLED: 'false',
    AWS_CHECKALT_ENABLED: 'false',
  }, async () => {
    const result = await handleProviderRequest(
      jwtEvent('/functions/v1/checkalt-submit-deposit', 'POST', {
        tenant_id: FREEDOM_TENANT,
        check_intake_item_id: CHECK_ID,
      }),
      '/functions/v1/checkalt-submit-deposit',
      'POST',
      {
        loadDatabaseCredentials: async () => ({ host: 'localhost', username: 'checksops', password: 'x', database: 'checksops' }),
        createClient: () => parityClient(),
        loadSandboxCredentials: async () => sandboxCreds(),
        fetchImpl,
        downloadClaimFile: async () => oversized,
      },
    );
    assert.equal(result.success, false);
    assert.equal(result.error, 'browser_prepare_required');
    assert.equal(result.statusCode, 400);
    assert.equal(calls.some((c) => c.url.includes('/fincapture/deposit/process')), false);
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

const OTHER_TENANT = '88888888-8888-4888-8888-888888888888';
const UAT_DEPOSIT_ID = '66666666-6666-4666-8666-666666666666';
const parityDeps = (client, fetchImpl) => ({
  loadDatabaseCredentials: async () => ({ host: 'localhost', username: 'checksops', password: 'x', database: 'checksops' }),
  createClient: () => client,
  loadSandboxCredentials: async () => sandboxCreds(),
  fetchImpl,
  downloadClaimFile: async () => syntheticCheckRaster({ width: 1400, height: 700, flat: true }),
});
const pendingUatOp = (tenantId = FREEDOM_TENANT) => [{
  id: UAT_DEPOSIT_ID,
  tenant_id: tenantId,
  provider_reference: '98765',
  status: 'pending_approval',
  metadata: {},
}];
const uatProviderFetch = () => recordedFetch([
  { match: '/public/fincapture/authenticate', method: 'POST', body: 'header.payload.sig' },
  { match: '/fincapture/deposit/process', method: 'POST', body: { referenceNumber: 98765, status: 127 } },
  { match: '/fincapture/deposit/approve', method: 'POST', body: { success: true, status: 'Approved', statusDescription: 'OK' } },
]);
const parityApprove = (client, fetchImpl, body) => handleProviderRequest(
  jwtEvent('/functions/v1/checkalt-approve-deposit', 'POST', body),
  '/functions/v1/checkalt-approve-deposit',
  'POST',
  parityDeps(client, fetchImpl),
);
const paritySubmit = (client, fetchImpl, body = { check_intake_item_id: CHECK_ID }) => handleProviderRequest(
  jwtEvent('/functions/v1/checkalt-submit-deposit', 'POST', body),
  '/functions/v1/checkalt-submit-deposit',
  'POST',
  parityDeps(client, fetchImpl),
);
const providerCalled = (calls, path) => calls.some((c) => c.url.includes(path));

test('UAT Check Alt approve/reject: owner policy, a member whose stored role is viewer is allowed (role ignored)', async () => {
  await withEnv({ AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'true' }, async () => {
    for (const action of ['approve', 'reject']) {
      const { fetchImpl, calls } = uatProviderFetch();
      const client = parityClient({ tenantRole: 'viewer', platformAdmin: false, operations: pendingUatOp() });
      const result = await parityApprove(client, fetchImpl, { tenant_id: FREEDOM_TENANT, deposit_id: UAT_DEPOSIT_ID, action });
      assert.equal(result.success, true, `${action} ${JSON.stringify(result)}`);
      assert.equal(providerCalled(calls, '/fincapture/deposit/approve'), true);
    }
  });
});

test('UAT Check Alt approve/reject: a platform admin with no tenant membership is refused', async () => {
  await withEnv({ AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'true' }, async () => {
    for (const body of [
      { tenant_id: FREEDOM_TENANT, deposit_id: UAT_DEPOSIT_ID, action: 'approve' },
      { deposit_id: UAT_DEPOSIT_ID, action: 'reject' },
      { tenant_id: FREEDOM_TENANT, referenceNumber: '98765', action: 'approve' },
    ]) {
      const { fetchImpl, calls } = uatProviderFetch();
      const client = parityClient({ tenantRole: null, platformAdmin: true, operations: pendingUatOp() });
      const result = await parityApprove(client, fetchImpl, body);
      assert.equal(result.statusCode, 403, JSON.stringify(body));
      assert.equal(providerCalled(calls, '/fincapture/deposit/approve'), false);
    }
    // A member of another tenant who is a platform admin cannot act on this tenant's deposit.
    const { fetchImpl, calls } = uatProviderFetch();
    const client = parityClient({ tenantRole: 'admin', platformAdmin: true, operations: pendingUatOp(OTHER_TENANT) });
    const result = await parityApprove(client, fetchImpl, { tenant_id: OTHER_TENANT, deposit_id: UAT_DEPOSIT_ID, action: 'approve' });
    assert.equal(result.statusCode, 403);
    // A supplied tenant_id that is not one of the caller's memberships is refused
    // by resolveTenant (no global admin bypass), before the handler runs.
    assert.equal(result.error, 'cross_tenant_denied');
    assert.equal(providerCalled(calls, '/fincapture/deposit/approve'), false);
  });
});

test('UAT Check Alt approve: a bare reference with no recorded deposit is refused', async () => {
  await withEnv({ AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'true' }, async () => {
    const { fetchImpl, calls } = uatProviderFetch();
    const client = parityClient({ tenantRole: 'owner', platformAdmin: true, operations: [] });
    const result = await parityApprove(client, fetchImpl, { referenceNumber: '98765', action: 'approve' });
    assert.equal(result.statusCode, 404);
    assert.equal(providerCalled(calls, '/fincapture/deposit/approve'), false);
  });
});

test('UAT Check Alt approve by reference: two recorded deposits sharing it -> 409, no provider call', async () => {
  await withEnv({ AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'true' }, async () => {
    const { fetchImpl, calls } = uatProviderFetch();
    const operations = [
      ...pendingUatOp(),
      { ...pendingUatOp()[0], id: '99999999-9999-4999-8999-999999999999' },
    ];
    const client = parityClient({ tenantRole: 'operator', platformAdmin: false, operations });
    const result = await parityApprove(client, fetchImpl, { referenceNumber: '98765', action: 'approve' });
    assert.equal(result.statusCode, 409);
    assert.equal(providerCalled(calls, '/fincapture/deposit/approve'), false);
    assert.equal(client.queries.some((q) => q.sql.includes('UPDATE public.aws_provider_sandbox_operations')), false);
  });
});

test('UAT Check Alt approve by reference: one deposit of the caller tenant, operator -> allowed and that row updated', async () => {
  await withEnv({ AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'true' }, async () => {
    const { fetchImpl, calls } = uatProviderFetch();
    const operations = [
      ...pendingUatOp(),
      { ...pendingUatOp(OTHER_TENANT)[0], id: '99999999-9999-4999-8999-999999999999', provider_reference: '11111' },
    ];
    const client = parityClient({ tenantRole: 'operator', platformAdmin: false, operations });
    const result = await parityApprove(client, fetchImpl, { referenceNumber: '98765', action: 'approve' });
    assert.equal(result.success, true, JSON.stringify(result));
    const approve = calls.find((c) => c.url.includes('/fincapture/deposit/approve'));
    assert.ok(approve);
    assert.equal(JSON.parse(approve.body).referenceNumber, 98765);
    const update = client.queries.find((q) => q.sql.includes('UPDATE public.aws_provider_sandbox_operations'));
    assert.equal(update.params[0], UAT_DEPOSIT_ID);
  });
});

test('UAT Check Alt approve by reference: one deposit of another tenant -> refused, even for a platform admin', async () => {
  await withEnv({ AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'true' }, async () => {
    for (const platformAdmin of [false, true]) {
      const { fetchImpl, calls } = uatProviderFetch();
      const operations = [
        { ...pendingUatOp(OTHER_TENANT)[0], provider_reference: '55555' },
        ...pendingUatOp(),
      ];
      const client = parityClient({ tenantRole: 'operator', platformAdmin, operations });
      const result = await parityApprove(client, fetchImpl, { referenceNumber: '55555', action: 'approve' });
      assert.equal(result.statusCode, 403, String(platformAdmin));
      assert.equal(result.error, 'financial_unauthorized');
      assert.equal(providerCalled(calls, '/fincapture/deposit/approve'), false);
      assert.equal(client.queries.some((q) => q.sql.includes('UPDATE public.aws_provider_sandbox_operations')), false);
    }
  });
});

test('UAT Check Alt approve/reject: a tenant operator without platform admin is allowed', async () => {
  await withEnv({ AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'true' }, async () => {
    for (const body of [
      { deposit_id: UAT_DEPOSIT_ID, action: 'approve' },
      { deposit_id: UAT_DEPOSIT_ID, action: 'reject' },
      { referenceNumber: '98765', action: 'approve' },
    ]) {
      const { fetchImpl, calls } = uatProviderFetch();
      const client = parityClient({ tenantRole: 'operator', platformAdmin: false, operations: pendingUatOp() });
      const result = await parityApprove(client, fetchImpl, body);
      assert.equal(result.success, true, JSON.stringify(result));
      assert.equal(providerCalled(calls, '/fincapture/deposit/approve'), true);
    }
  });
});

test('UAT Check Alt submit: tenant membership decides; platform admin is ignored', async () => {
  await withEnv({
    AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'true',
    AWS_PROVIDER_EXECUTION_ENABLED: 'false',
    AWS_CHECKALT_ENABLED: 'false',
  }, async () => {
    // Platform admin without a membership of the check's tenant: refused.
    for (const [tenantRole, body] of [
      [null, { tenant_id: FREEDOM_TENANT, check_intake_item_id: CHECK_ID }],
      [null, { check_intake_item_id: CHECK_ID }],
    ]) {
      const { fetchImpl, calls } = uatProviderFetch();
      const client = parityClient({ tenantRole, platformAdmin: true });
      const result = await paritySubmit(client, fetchImpl, body);
      assert.equal(result.statusCode, 403, `${tenantRole} ${JSON.stringify(body)}`);
      assert.equal(providerCalled(calls, '/fincapture/deposit/process'), false);
      assert.equal(client.queries.some((q) => q.sql.includes('INSERT INTO public.aws_provider_sandbox_operations')), false);
    }
    // Owner policy: any member, whatever its stored role, may submit.
    for (const tenantRole of ['operator', 'viewer']) {
      const { fetchImpl, calls } = uatProviderFetch();
      const client = parityClient({ tenantRole, platformAdmin: false });
      const result = await paritySubmit(client, fetchImpl);
      assert.equal(result.success, true, `${tenantRole} ${JSON.stringify(result)}`);
      assert.equal(providerCalled(calls, '/fincapture/deposit/process'), true);
    }
  });
});

const parityCall = (fn, client, fetchImpl, body = {}) => handleProviderRequest(
  jwtEvent(`/functions/v1/${fn}`, 'POST', body),
  `/functions/v1/${fn}`,
  'POST',
  parityDeps(client, fetchImpl),
);
const uatReadFetch = () => recordedFetch([
  { match: '/public/fincapture/authenticate', method: 'POST', body: 'header.payload.sig' },
  { match: '/fincapture/deposit/item', method: 'POST', body: { referenceNumber: 98765, status: 'Approved' } },
  { match: '/fincapture/deposit/history', method: 'POST', body: { items: [] } },
  { match: '/fincapture/useraccount', method: 'POST', body: { ssoKey: 'sso-from-register' } },
]);
const submittedUatOps = () => [
  { ...pendingUatOp()[0], status: 'submitted' },
  { ...pendingUatOp(OTHER_TENANT)[0], id: '99999999-9999-4999-8999-999999999999', provider_reference: '55555', status: 'submitted' },
];
// handleProviderRequest always sends checkalt-poll-status to the production
// status-read path, so the UAT poll handler is exercised through the parity
// dispatcher directly (defence in depth if that routing ever changes).
const parityPoll = (client, fetchImpl, body = {}) => runParityHandler(
  'checkalt-poll-status',
  jwtEvent('/functions/v1/checkalt-poll-status', 'POST', body),
  parityDeps(client, fetchImpl),
);
const anyProviderCall = (calls) => calls.some((c) => !c.url.includes('/public/fincapture/authenticate'));
const pollUpdated = (client) => client.queries.some((q) => q.sql.includes('UPDATE public.aws_provider_sandbox_operations'));

test('UAT Check Alt poll-status: platform-only admins and other tenants are refused, no rows updated', async () => {
  await withEnv({ AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'true'  }, async () => {
    for (const [tenantRole, platformAdmin, body] of [
      [null, true, {}],
      [null, true, { tenant_id: FREEDOM_TENANT }],
      // Platform admin who is an admin of Freedom names another tenant.
      ['admin', true, { tenant_id: OTHER_TENANT }],
    ]) {
      const { fetchImpl, calls } = uatReadFetch();
      const client = parityClient({ tenantRole, platformAdmin, operations: submittedUatOps() });
      const result = await parityPoll(client, fetchImpl, body);
      const label = `${tenantRole} ${platformAdmin} ${JSON.stringify(body)}`;
      assert.equal(result.statusCode, 403, label);
      // A named tenant the caller is not a member of: refused by resolveTenant.
      assert.equal(result.error, body.tenant_id ? 'cross_tenant_denied' : 'financial_unauthorized', label);
      assert.equal(anyProviderCall(calls), false, label);
      assert.equal(pollUpdated(client), false, label);
    }
  });
});

test('UAT Check Alt poll-status: a member (stored role viewer) polls and updates only own-tenant rows', async () => {
  await withEnv({ AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'true'  }, async () => {
    const { fetchImpl, calls } = uatReadFetch();
    const client = parityClient({ tenantRole: 'viewer', platformAdmin: false, operations: submittedUatOps() });
    const result = await parityPoll(client, fetchImpl, {});
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.polled, 1);
    const items = calls.filter((c) => c.url.includes('/fincapture/deposit/item'));
    assert.equal(items.length, 1);
    assert.equal(JSON.parse(items[0].body).referenceNumber, 98765);
    const updates = client.queries.filter((q) => q.sql.includes('UPDATE public.aws_provider_sandbox_operations'));
    assert.equal(updates.length, 1);
    assert.equal(updates[0].params[0], UAT_DEPOSIT_ID);
    assert.equal(updates[0].params[3], FREEDOM_TENANT);
    assert.match(updates[0].sql, /tenant_id = \$4::uuid/);
  });
});

test('UAT Check Alt prepare-image: non-members and platform admins of another tenant are refused', async () => {
  await withEnv({ AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'true' }, async () => {
    for (const [tenantRole, platformAdmin, checkTenant] of [
      [null, true, FREEDOM_TENANT],
      ['admin', true, OTHER_TENANT],
    ]) {
      const { fetchImpl } = uatReadFetch();
      const client = parityClient({
        tenantRole,
        platformAdmin,
        checks: [{
          id: CHECK_ID,
          tenant_id: checkTenant,
          amount: 123.45,
          front_image_path: `checks/${CHECK_ID}/front.jpg`,
          back_image_path: `checks/${CHECK_ID}/back.jpg`,
        }],
      });
      const result = await parityCall('checkalt-prepare-image', client, fetchImpl, { check_intake_item_id: CHECK_ID, side: 'front' });
      assert.equal(result.statusCode, 403, `${tenantRole} ${platformAdmin} ${checkTenant}`);
      assert.equal(result.error, 'financial_unauthorized');
    }
    for (const tenantRole of ['operator', 'viewer']) {
      const { fetchImpl } = uatReadFetch();
      const client = parityClient({ tenantRole, platformAdmin: false });
      const result = await parityCall('checkalt-prepare-image', client, fetchImpl, { check_intake_item_id: CHECK_ID, side: 'front' });
      assert.notEqual(result.statusCode, 403, `${tenantRole} ${JSON.stringify(result)}`);
      assert.notEqual(result.error, 'financial_unauthorized');
    }
  });
});

test('UAT Check Alt deposit-history and account-status: scoped to a tenant the caller belongs to', async () => {
  await withEnv({ AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'true' }, async () => {
    for (const fn of ['checkalt-deposit-history', 'checkalt-account-status']) {
      for (const [tenantRole, platformAdmin, body] of [
        [null, true, {}],
        [null, true, { tenant_id: FREEDOM_TENANT }],
        ['admin', true, { tenant_id: OTHER_TENANT }],
      ]) {
        const { fetchImpl, calls } = uatReadFetch();
        const client = parityClient({ tenantRole, platformAdmin });
        const result = await parityCall(fn, client, fetchImpl, body);
        const label = `${fn} ${tenantRole} ${platformAdmin} ${JSON.stringify(body)}`;
        assert.equal(result.statusCode, 403, label);
        assert.equal(result.error, body.tenant_id ? 'cross_tenant_denied' : 'financial_unauthorized', label);
        assert.equal(anyProviderCall(calls), false, label);
      }
      // A non-member naming another tenant is refused before the handler runs.
      {
        const { fetchImpl, calls } = uatReadFetch();
        const client = parityClient({ tenantRole: 'operator', platformAdmin: false });
        const result = await parityCall(fn, client, fetchImpl, { tenant_id: OTHER_TENANT });
        assert.equal(result.statusCode, 403, fn);
        assert.equal(anyProviderCall(calls), false, fn);
      }
      for (const [tenantRole, body] of [['operator', {}], ['viewer', {}], ['viewer', { tenant_id: FREEDOM_TENANT }]]) {
        const { fetchImpl, calls } = uatReadFetch();
        const client = parityClient({ tenantRole, platformAdmin: false });
        const result = await parityCall(fn, client, fetchImpl, body);
        assert.equal(result.success, true, `${fn} ${JSON.stringify(result)}`);
        assert.equal(anyProviderCall(calls), true, fn);
        const scoped = client.queries.find((q) => q.sql.includes('FROM public.aws_provider_sandbox_objects'));
        assert.equal(scoped.params[0], FREEDOM_TENANT, fn);
      }
    }
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
        createClient: () => parityClient({ platformOwner: true }),
        loadSandboxCredentials: async () => sandboxCreds(),
        fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{}' }),
      },
    );
    assert.equal(result.statusCode, 400);
    assert.equal(result.error, 'uat_depositor_must_not_be_api_login');
  });
});

test('UAT Check Alt setup: platform owner only (register, verify, test-connection); members and global admins refused', async () => {
  await withEnv({ AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'true' }, async () => {
    const depositorRowWritten = (client) => client.queries.some((q) => q.sql.includes('INSERT INTO public.aws_provider_sandbox_objects'));
    // The platform owner sets up a tenant's UAT depositor (it need not be a member).
    {
      const { fetchImpl } = uatReadFetch();
      const client = parityClient({ tenantRole: null, platformAdmin: false, platformOwner: true });
      const result = await parityCall('checkalt-register-account', client, fetchImpl, {
        tenant_id: FREEDOM_TENANT, sso_user_id: 'depositor-2', deposit_account_number: '90002222',
      });
      assert.equal(result.success, true, JSON.stringify(result));
      assert.equal(depositorRowWritten(client), true);
    }
    // Members (any stored role) and a global user_roles admin are refused before any provider call.
    for (const fn of ['checkalt-register-account', 'checkalt-verify-account', 'checkalt-test-connection']) {
      for (const [tenantRole, platformAdmin] of [['viewer', false], ['operator', false], ['owner', false], [null, true], ['admin', true]]) {
        const { fetchImpl, calls } = uatReadFetch();
        const client = parityClient({ tenantRole, platformAdmin, platformOwner: false });
        const result = await parityCall(fn, client, fetchImpl, { sso_user_id: 'depositor-2', deposit_account_number: '90002222', action: 'status' });
        assert.equal(result.statusCode, 403, `${fn} ${tenantRole} ${platformAdmin}`);
        assert.equal(calls.length, 0, fn);
        assert.equal(depositorRowWritten(client), false, fn);
      }
    }
  });
});

test('UAT Check Alt verify: status reads the UAT row (no provider call); live lookups come back masked to the last four', async () => {
  await withEnv({ AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'true' }, async () => {
    let { fetchImpl, calls } = uatReadFetch();
    let result = await parityCall('checkalt-verify-account', parityClient({ platformOwner: true }), fetchImpl, { tenant_id: FREEDOM_TENANT, action: 'status' });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.status, 'registered');
    assert.equal(result.environment, 'uat');
    assert.equal(result.account_last4, '1111');
    assert.equal(calls.length, 0);
    assert.equal(JSON.stringify(result).includes('90001111'), false);

    result = await parityCall('checkalt-verify-account', parityClient({ uatAccounts: [], platformOwner: true }), fetchImpl, { tenant_id: FREEDOM_TENANT, action: 'status' });
    assert.equal(result.status, 'not_registered');
    assert.equal(result.registered, false);

    ({ fetchImpl, calls } = recordedFetch([
      { match: '/public/fincapture/authenticate', method: 'POST', body: 'header.payload.sig' },
      { match: '/fincapture/useraccount/getDepositAccountInformation', method: 'POST', body: { accountNumber: '90001111', note: 'acct 90001111 ok' } },
    ]));
    result = await parityCall('checkalt-verify-account', parityClient({ platformOwner: true }), fetchImpl, { tenant_id: FREEDOM_TENANT, action: 'account' });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.data.accountNumber, '****1111');
    assert.equal(result.data.note, 'acct ****1111 ok');
    assert.equal(JSON.stringify(result).includes('90001111'), false);
    assert.ok(calls.some((c) => c.url.includes('getDepositAccountInformation')));
  });
});

test('UAT Check Alt register refuses a non-digit deposit account number before calling Check Alt', async () => {
  await withEnv({ AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'true' }, async () => {
    for (const bad of ['1234-5678', 'abc12345', '123', '123456789012345678']) {
      const { fetchImpl, calls } = uatReadFetch();
      const result = await parityCall('checkalt-register-account', parityClient({ platformOwner: true }), fetchImpl, {
        tenant_id: FREEDOM_TENANT, sso_user_id: 'depositor-2', deposit_account_number: bad,
      });
      assert.equal(result.statusCode, 400, bad);
      assert.equal(result.error, 'invalid_deposit_account_number', bad);
      assert.equal(calls.length, 0, bad);
    }
  });
});

test('UAT Check Alt verify: a missing or unknown action is 400 with no provider call', async () => {
  await withEnv({ AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'true' }, async () => {
    for (const body of [{ tenant_id: FREEDOM_TENANT }, { tenant_id: FREEDOM_TENANT, action: 'history' }]) {
      const { fetchImpl, calls } = uatReadFetch();
      const result = await parityCall('checkalt-verify-account', parityClient({ platformOwner: true }), fetchImpl, body);
      assert.equal(result.statusCode, 400, JSON.stringify(body));
      assert.equal(result.error, 'invalid_action', JSON.stringify(body));
      assert.equal(calls.length, 0, JSON.stringify(body));
    }
  });
});


// --- resolveTenant: users only, no tiers, no global admin bypass ----------------

const ownerQueryClient = (isOwner) => ({
  query: async (sql) => {
    if (sql.includes('is_platform_owner')) return { rows: [{ is_owner: isOwner }] };
    if (sql.includes('FROM public.user_roles')) return { rows: [{ role: 'admin' }] };
    return { rows: [] };
  },
});
const MEMBERSHIP = { tenant_id: FREEDOM_TENANT, role: 'viewer', tenant_name: 'Freedom', tenant_slug: 'freedom' };

test('resolveTenant: a member (any stored role, requireAdmin too) resolves its own tenant; an omitted tenant_id uses its OWN membership', async () => {
  for (const requireAdmin of [false, true]) {
    const named = await resolveTenant(ownerQueryClient(false), { body: { tenant_id: FREEDOM_TENANT }, memberships: [MEMBERSHIP], requireAdmin });
    assert.deepEqual(named, { tenantId: FREEDOM_TENANT, isPlatformOwner: false });
    const omitted = await resolveTenant(ownerQueryClient(false), { body: {}, memberships: [MEMBERSHIP], requireAdmin });
    assert.deepEqual(omitted, { tenantId: FREEDOM_TENANT, isPlatformOwner: false });
  }
  // The fallback only ever picks one of the caller's own memberships.
  const second = await resolveTenant(ownerQueryClient(false), {
    body: {}, memberships: [{ tenant_id: OTHER_TENANT, role: 'operator' }, MEMBERSHIP],
  });
  assert.equal(second.tenantId, OTHER_TENANT);
});

test('resolveTenant: a global user_roles admin who is not a member is refused, named tenant or not', async () => {
  const named = await resolveTenant(ownerQueryClient(false), { body: { tenant_id: FREEDOM_TENANT }, memberships: [], requireAdmin: true });
  assert.equal(named.statusCode, 403);
  assert.equal(named.error, 'cross_tenant_denied');
  const omitted = await resolveTenant(ownerQueryClient(false), { body: {}, memberships: [] });
  assert.equal(omitted.statusCode, 403);
  // A member of one tenant cannot name another.
  const other = await resolveTenant(ownerQueryClient(false), { body: { tenant_id: OTHER_TENANT }, memberships: [MEMBERSHIP] });
  assert.equal(other.error, 'cross_tenant_denied');
});

test('resolveTenant: the platform owner reaches a foreign tenant only through platform-owner handlers', async () => {
  const ordinary = await resolveTenant(ownerQueryClient(true), { body: { tenant_id: FREEDOM_TENANT }, memberships: [] });
  assert.equal(ordinary.error, 'cross_tenant_denied');
  const platform = await resolveTenant(ownerQueryClient(true), {
    body: { tenant_id: FREEDOM_TENANT }, memberships: [], allowPlatformOwner: true,
  });
  assert.deepEqual(platform, { tenantId: FREEDOM_TENANT, isPlatformOwner: true });
  const noTenant = await resolveTenant(ownerQueryClient(true), { body: {}, memberships: [], allowPlatformOwner: true });
  assert.deepEqual(noTenant, { tenantId: null, isPlatformOwner: true });
  // allowPlatformOwner does nothing for someone who is not the platform owner.
  const admin = await resolveTenant(ownerQueryClient(false), {
    body: { tenant_id: FREEDOM_TENANT }, memberships: [], allowPlatformOwner: true,
  });
  assert.equal(admin.error, 'cross_tenant_denied');
});

const withPlatformOwner = (client, isOwner) => {
  const base = client.query;
  client.query = async (sql, params) => (sql.includes('is_platform_owner')
    ? { rows: [{ is_owner: isOwner }] }
    : base(sql, params));
  return client;
};

test('platform bank and treasury: platform owner only; a member or a global admin is refused', async () => {
  await withEnv({ AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'true' }, async () => {
    for (const fn of ['moov-platform-bank', 'platform-treasury']) {
      // A tenant member (and global admin) who is not the platform owner.
      {
        const { fetchImpl, calls } = recordedFetch([]);
        const client = withPlatformOwner(parityClient({ tenantRole: 'owner', platformAdmin: true }), false);
        const result = await runParityHandler(fn, jwtEvent(`/functions/v1/${fn}`, 'POST', { action: 'list' }), parityDeps(client, fetchImpl));
        assert.equal(result.statusCode, 403, fn);
        assert.equal(result.error, 'Platform owner access required', fn);
        assert.equal(calls.some((c) => c.url.includes('/accounts/')), false, fn);
      }
      // A global admin naming a tenant it is not a member of.
      {
        const { fetchImpl, calls } = recordedFetch([]);
        const client = withPlatformOwner(parityClient({ tenantRole: null, platformAdmin: true }), false);
        const result = await runParityHandler(fn, jwtEvent(`/functions/v1/${fn}`, 'POST', { action: 'list', tenant_id: FREEDOM_TENANT }), parityDeps(client, fetchImpl));
        assert.equal(result.statusCode, 403, fn);
        assert.equal(calls.length, 0, fn);
      }
      // The platform owner, with no membership, naming a tenant: reaches the provider.
      {
        resetMoovTokenCache();
        const { fetchImpl, calls } = recordedFetch([
          { match: '/oauth2/token', method: 'POST', body: { access_token: 'tok', expires_in: 300 } },
          { match: `/accounts/${PLATFORM_ID}/`, body: [] },
        ]);
        const client = withPlatformOwner(parityClient({ tenantRole: null, platformAdmin: false }), true);
        const result = await runParityHandler(fn, jwtEvent(`/functions/v1/${fn}`, 'POST', { action: 'list', tenant_id: FREEDOM_TENANT }), parityDeps(client, fetchImpl));
        assert.equal(result.success, true, `${fn} ${JSON.stringify(result)}`);
        assert.equal(calls.some((c) => c.url.includes(`/accounts/${PLATFORM_ID}/`)), true, fn);
      }
      // The platform owner with no tenant at all (the SPA panels send no
      // tenant_id): the platform-owner-only handler still runs, on the
      // platform's own account.
      {
        resetMoovTokenCache();
        const { fetchImpl, calls } = recordedFetch([
          { match: '/oauth2/token', method: 'POST', body: { access_token: 'tok', expires_in: 300 } },
          { match: `/accounts/${PLATFORM_ID}/`, body: [] },
        ]);
        const client = withPlatformOwner(parityClient({ tenantRole: null, platformAdmin: false }), true);
        const result = await runParityHandler(fn, jwtEvent(`/functions/v1/${fn}`, 'POST', { action: 'list' }), parityDeps(client, fetchImpl));
        assert.notEqual(result.error, 'tenant_id is required', fn);
        assert.equal(result.success, true, `${fn} ${JSON.stringify(result)}`);
        assert.equal(calls.some((c) => c.url.includes(`/accounts/${PLATFORM_ID}/`)), true, fn);
      }
    }
    // Platform bank add never targets a tenant payment account: refused with a
    // tenant_id (any tenant) and without one.
    for (const [body, status] of [[{ action: 'add' }, 409], [{ action: 'add', tenant_id: FREEDOM_TENANT }, 403]]) {
      const { fetchImpl, calls } = recordedFetch([]);
      const client = withPlatformOwner(parityClient({ tenantRole: null, platformAdmin: false }), true);
      const result = await runParityHandler('moov-platform-bank', jwtEvent('/functions/v1/moov-platform-bank', 'POST', body), parityDeps(client, fetchImpl));
      assert.equal(result.statusCode, status, JSON.stringify(body));
      assert.equal(calls.some((c) => /bank-accounts/.test(c.url)), false);
    }
    // Other (tenant) Moov handlers still need a tenant, even for the platform owner.
    {
      const { fetchImpl, calls } = recordedFetch([]);
      const client = withPlatformOwner(parityClient({ tenantRole: null, platformAdmin: false }), true);
      const result = await runParityHandler('moov-fee-rollup', jwtEvent('/functions/v1/moov-fee-rollup', 'POST', {}), parityDeps(client, fetchImpl));
      assert.equal(result.statusCode, 403, JSON.stringify(result));
      assert.equal(calls.length, 0);
    }
  });
});
