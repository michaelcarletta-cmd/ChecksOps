import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handler } from '../functions/api/index.mjs';
import { LOOKUP_MAPPING_SQL, TENANT_MEMBERSHIP_SQL } from '../functions/api/identity.mjs';
import { handleSandboxRequest } from '../functions/api/sandbox.mjs';
import {
  classifyCheckAltSandbox,
  classifyMoovSandbox,
  classifyPlaidSandbox,
  looksLikeSandboxHost,
  sandboxCredentialSnapshot,
} from '../functions/api/sandbox-credentials.mjs';
import {
  buildMoovSandboxTransferBody,
  idempotencyUuid,
  SANDBOX_MIN_CENTS,
} from '../functions/api/providers/moov-sandbox.mjs';
import { buildCheckAltSandboxDeposit } from '../functions/api/providers/checkalt-sandbox.mjs';
import { hmacBase64 } from '../functions/api/providers/hmac.mjs';
import { providerSandboxExecutionEnabled } from '../functions/api/sandbox-flags.mjs';

const FREEDOM_APP = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const FREEDOM_TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const C1C_TENANT = '4f172140-f57a-4744-8050-95f4f07b13b4';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const SPOOF_ID = '00000000-0000-0000-0000-000000000099';
const OP_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const jwtEvent = (path, method, body, extra = {}) => ({
  rawPath: path,
  headers: {
    authorization: extra.auth === null ? undefined : 'Bearer test-id-token',
    'x-user-id': SPOOF_ID,
    'x-tenant-id': C1C_TENANT,
    ...(extra.headers || {}),
  },
  body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  requestContext: {
    stage: 'staging',
    http: { method, path },
    authorizer: extra.auth === null ? undefined : {
      jwt: { claims: { sub: extra.sub || COGNITO_SUB, email: 'checksops-tester@freedomadj.com', token_use: 'id' } },
    },
  },
});

const mappingFor = () => ({
  application_user_id: FREEDOM_APP,
  cognito_sub: COGNITO_SUB,
  email: 'checksops-tester@freedomadj.com',
  status: 'active',
});

const mockClient = ({
  mapping = mappingFor(),
  memberships = [{ tenant_id: FREEDOM_TENANT, role: 'staff', tenant_name: 'Freedom', tenant_slug: 'freedom' }],
  operations = [],
  objects = [],
  webhooks = [],
} = {}) => {
  const queries = [];
  const ops = [...operations];
  const objs = [...objects];
  const hooks = [...webhooks];
  const audits = [];
  return {
    queries,
    ops,
    objs,
    hooks,
    audits,
    connect: async () => {},
    end: async () => {},
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT' || sql === 'SET TRANSACTION READ WRITE') {
        return { rows: [] };
      }
      if (sql.startsWith('SELECT set_config') || sql.includes('set_config($1')) {
        return { rows: [{ set_config: params[1] || '1' }] };
      }
      if (sql === LOOKUP_MAPPING_SQL) {
        return { rows: params[0] === mapping.cognito_sub ? [mapping] : [] };
      }
      if (sql === TENANT_MEMBERSHIP_SQL || sql.includes('FROM public.tenant_users tu')) {
        return { rows: memberships };
      }
      if (sql.includes('INSERT INTO public.aws_provider_sandbox_audit')) {
        audits.push({ outcome: params[6] });
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO public.aws_provider_sandbox_objects')) {
        const row = {
          id: 'obj-1',
          tenant_id: params[0],
          provider: params[1],
          object_type: params[2],
          sandbox_provider_id: params[3],
          environment: 'sandbox',
        };
        objs.push(row);
        return { rows: [row] };
      }
      if (sql.includes('FROM public.aws_provider_sandbox_objects')) {
        return {
          rows: objs.filter((row) => {
            if (sql.includes('sandbox_provider_id = $2') && params[1]) {
              return row.provider === params[0] && row.sandbox_provider_id === params[1];
            }
            if (params[2]) return row.tenant_id === params[0] && row.provider === params[1] && row.object_type === params[2];
            return row.tenant_id === params[0];
          }),
        };
      }
      if (sql.includes('INSERT INTO public.aws_provider_sandbox_operations')) {
        const existing = ops.find((row) => row.tenant_id === params[0] && row.idempotency_key === params[3]);
        if (existing) return { rows: [existing] };
        const row = {
          id: OP_ID,
          tenant_id: params[0],
          application_user_id: params[1],
          operation_type: sql.includes('checkalt') ? 'checkalt_sandbox_deposit' : 'moov_sandbox_transfer',
          provider: sql.includes('checkalt') ? 'checkalt' : 'moov',
          amount_cents: params[2],
          currency: 'USD',
          idempotency_key: params[3],
          status: params[4] || 'failed',
          provider_reference: params[5] || null,
          sandbox_http_called: false,
          production_execution: false,
          failure_class: params[4] === 'failed' ? params[4] : null,
          metadata: {},
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        if (typeof params[4] === 'string' && ['failed', 'provider_pending'].includes(params[4])) {
          row.status = params[4];
          row.provider_reference = params[5] || null;
        }
        ops.push(row);
        return { rows: [row] };
      }
      if (sql.includes('FROM public.aws_provider_sandbox_operations')) {
        if (params[1] && String(sql).includes('idempotency_key')) {
          return { rows: ops.filter((row) => row.tenant_id === params[0] && row.idempotency_key === params[1]) };
        }
        if (params[0] && String(sql).includes('id =')) {
          return { rows: ops.filter((row) => row.id === params[0]) };
        }
        return { rows: ops.filter((row) => !params[0] || row.tenant_id === params[0]) };
      }
      if (sql.includes('INSERT INTO public.aws_provider_sandbox_webhooks')) {
        const row = {
          provider: params[0],
          external_event_id: params[1],
          mapped_tenant_id: params[2],
        };
        hooks.push(row);
        return { rows: [row] };
      }
      if (sql.includes('FROM public.aws_provider_sandbox_webhooks')) {
        return { rows: hooks.filter((row) => row.provider === params[0] && row.external_event_id === params[1]) };
      }
      if (sql.includes('DELETE FROM public.aws_provider_sandbox_operations')) {
        const removed = ops.splice(0, ops.length);
        return { rows: removed };
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

const depsFor = (client, extra = {}) => ({
  loadDatabaseCredentials: async () => ({ host: 'localhost', username: 'checksops', password: 'x', database: 'checksops' }),
  createClient: () => client,
  ...extra,
});

test('sandbox flag is independent of production execution', () => {
  const previousExec = process.env.AWS_PROVIDER_EXECUTION_ENABLED;
  const previousSandbox = process.env.AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED;
  try {
    process.env.AWS_PROVIDER_EXECUTION_ENABLED = 'false';
    process.env.AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED = 'true';
    assert.equal(providerSandboxExecutionEnabled(), true);
    process.env.AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED = 'TRUE';
    assert.equal(providerSandboxExecutionEnabled(), false);
  } finally {
    if (previousExec === undefined) delete process.env.AWS_PROVIDER_EXECUTION_ENABLED;
    else process.env.AWS_PROVIDER_EXECUTION_ENABLED = previousExec;
    if (previousSandbox === undefined) delete process.env.AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED;
    else process.env.AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED = previousSandbox;
  }
});

test('Moov sandbox classification refuses production keys', () => {
  const missing = classifyMoovSandbox({ MOOV_PUBLIC_KEY: 'pk_live', MOOV_SECRET_KEY: 'sk_live' });
  assert.equal(missing.available, false);
  assert.equal(missing.reason, 'sandbox_keys_missing');
  assert.equal(missing.refuseProductionKeys, true);
  assert.equal(missing.productionKeysPresent, true);
  const present = classifyMoovSandbox({
    MOOV_SANDBOX_PUBLIC_KEY: 'pk_sbox',
    MOOV_SANDBOX_SECRET_KEY: 'sk_sbox',
  });
  assert.equal(present.available, true);
  assert.equal(present.host, 'https://api.moov.io');
});

test('CheckAlt has no implicit sandbox and rejects production hosts', () => {
  assert.equal(looksLikeSandboxHost('https://api.clearingworks.com'), false);
  assert.equal(looksLikeSandboxHost('https://uat.clearingworks.com'), true);
  const none = classifyCheckAltSandbox({
    CHECKALT_USERNAME: 'prod-user',
    CHECKALT_PASSWORD: 'prod-pass',
    CHECKALT_BASE_URL: 'https://api.clearingworks.com',
  });
  assert.equal(none.available, false);
  assert.equal(none.reason, 'no_sandbox_fincapture_environment');
  assert.equal(none.refuseNegotiableCheck, true);
  const badUrl = classifyCheckAltSandbox({
    CHECKALT_SANDBOX_USERNAME: 'u',
    CHECKALT_SANDBOX_PASSWORD: 'p',
    CHECKALT_SANDBOX_BASE_URL: 'https://api.clearingworks.com',
  });
  assert.equal(badUrl.available, false);
  assert.equal(badUrl.reason, 'sandbox_base_url_not_test_host');
});

test('Plaid sandbox is not the money path', () => {
  const missing = classifyPlaidSandbox({});
  assert.equal(missing.available, false);
  assert.equal(missing.relevantToMoneyPath, false);
  const sandbox = classifyPlaidSandbox({
    PLAID_SANDBOX_CLIENT_ID: 'id',
    PLAID_SANDBOX_SECRET: 'secret',
  });
  assert.equal(sandbox.available, true);
  assert.equal(sandbox.host, 'https://sandbox.plaid.com');
});

test('sandbox credential snapshot never returns secret values', () => {
  const snap = sandboxCredentialSnapshot({
    MOOV_SANDBOX_PUBLIC_KEY: 'super-secret-key-value',
    MOOV_SANDBOX_SECRET_KEY: 'another-secret-key-value',
  });
  const encoded = JSON.stringify(snap);
  assert.equal(encoded.includes('super-secret-key-value'), false);
  assert.equal(encoded.includes('another-secret-key-value'), false);
  assert.equal(snap.moov.available, true);
});

test('Moov sandbox transfer body uses 1 cent and a stable UUID key', () => {
  const body = buildMoovSandboxTransferBody({
    sourcePaymentMethodId: 'src',
    destinationPaymentMethodId: 'dst',
    amountCents: SANDBOX_MIN_CENTS,
  });
  assert.deepEqual(body.amount, { currency: 'USD', value: 1 });
  const first = idempotencyUuid('tenant|moov_sandbox_transfer|resource|1|USD');
  const second = idempotencyUuid('tenant|moov_sandbox_transfer|resource|1|USD');
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

test('CheckAlt sandbox deposit converts cents without a check image', () => {
  const deposit = buildCheckAltSandboxDeposit({ amountCents: 1, reference: 'ref' });
  assert.equal(deposit.userAmount, 1);
  assert.equal(deposit.negotiableCheck, false);
  assert.equal(deposit.imageIncluded, false);
});

test('GET /sandbox/status reports capability and production guards', async () => {
  await withEnv({
    AWS_PROVIDER_EXECUTION_ENABLED: 'false',
    AWS_FINANCIAL_PERMISSIONS_ACTIVATED: 'false',
    AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'true',
    AWS_MOOV_ENABLED: 'false',
    AWS_CHECKALT_ENABLED: 'false',
  }, async () => {
    const response = await handler(jwtEvent('/sandbox/status', 'GET'));
    const body = JSON.parse(response.body);
    assert.equal(response.statusCode, 200);
    assert.equal(body.flags.AWS_PROVIDER_EXECUTION_ENABLED, false);
    assert.equal(body.flags.AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED, true);
    assert.equal(body.productionExecution, false);
    assert.equal(body.cutover.executed, false);
    assert.equal(body.capability.moov.available, false);
    assert.equal(body.capability.checkalt.available, false);
    assert.equal(body.amountUnits.sandboxMinCents, 1);
  });
});

test('sandbox routes refuse production execution and browser amounts', async () => {
  await withEnv({
    AWS_PROVIDER_EXECUTION_ENABLED: 'true',
    AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'true',
    AWS_FINANCIAL_PERMISSIONS_ACTIVATED: 'false',
  }, async () => {
    const client = mockClient();
    const blocked = await handleSandboxRequest(
      jwtEvent('/sandbox/moov/transfer', 'POST', {}),
      '/sandbox/moov/transfer',
      'POST',
      depsFor(client, { loadSandboxCredentials: async () => ({ moov: null, snapshot: { moov: { available: false } } }) }),
    );
    assert.equal(blocked.error, 'production_execution_blocked');
  });

  await withEnv({
    AWS_PROVIDER_EXECUTION_ENABLED: 'false',
    AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'true',
    AWS_FINANCIAL_PERMISSIONS_ACTIVATED: 'false',
  }, async () => {
    const client = mockClient();
    const rejected = await handleSandboxRequest(
      jwtEvent('/sandbox/moov/transfer', 'POST', { amount: 9.99 }),
      '/sandbox/moov/transfer',
      'POST',
      depsFor(client),
    );
    assert.equal(rejected.error, 'untrusted_amount');
  });
});

test('missing sandbox credentials fail closed and stay idempotent', async () => {
  await withEnv({
    AWS_PROVIDER_EXECUTION_ENABLED: 'false',
    AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'true',
    AWS_FINANCIAL_PERMISSIONS_ACTIVATED: 'false',
  }, async () => {
    const client = mockClient();
    const creds = async () => ({
      moov: null,
      checkalt: null,
      plaid: null,
      snapshot: {
        moov: classifyMoovSandbox({}),
        checkalt: classifyCheckAltSandbox({}),
        plaid: classifyPlaidSandbox({}),
      },
    });
    const first = await handleSandboxRequest(
      jwtEvent('/sandbox/moov/transfer', 'POST', {}),
      '/sandbox/moov/transfer',
      'POST',
      depsFor(client, { loadSandboxCredentials: creds }),
    );
    assert.equal(first.failClosed, true);
    assert.equal(first.error, 'sandbox_credentials_unavailable');
    assert.equal(first.ok, true);
    assert.equal(first.productionExecution, false);
    const second = await handleSandboxRequest(
      jwtEvent('/sandbox/moov/transfer', 'POST', {}),
      '/sandbox/moov/transfer',
      'POST',
      depsFor(client, { loadSandboxCredentials: creds }),
    );
    assert.equal(second.duplicate, true);
    assert.equal(second.replayed, true);
    assert.equal(second.sandboxHttpCalled, false);
    assert.equal(client.ops.length, 1);
  });
});

test('mocked Moov sandbox HTTP creates one transfer and replays the same key', async () => {
  await withEnv({
    AWS_PROVIDER_EXECUTION_ENABLED: 'false',
    AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'true',
    AWS_FINANCIAL_PERMISSIONS_ACTIVATED: 'false',
  }, async () => {
    const client = mockClient({
      objects: [
        { tenant_id: FREEDOM_TENANT, provider: 'moov', object_type: 'source_payment_method', sandbox_provider_id: 'pm_src_sbox' },
        { tenant_id: FREEDOM_TENANT, provider: 'moov', object_type: 'destination_payment_method', sandbox_provider_id: 'pm_dst_sbox' },
      ],
    });
    let posts = 0;
    const fetchImpl = async (url, opts = {}) => {
      if (String(url).endsWith('/oauth2/token')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'tok', expires_in: 300 }) };
      }
      if (opts.method === 'POST' && String(url).includes('/transfers')) {
        posts += 1;
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ transferID: 'xfer_sbox_1', status: 'pending', amount: { currency: 'USD', value: 1 } }),
        };
      }
      return { ok: false, status: 404, text: async () => '{}' };
    };
    const creds = async () => ({
      moov: {
        environment: 'sandbox',
        host: 'https://api.moov.io',
        publicKey: 'pk_sbox',
        secretKey: 'sk_sbox',
        platformAccountId: 'acct_sbox',
        origin: 'https://checksops.com',
        apiVersion: 'v2024.01.00',
      },
      snapshot: { moov: { available: true } },
    });
    const first = await handleSandboxRequest(
      jwtEvent('/sandbox/moov/transfer', 'POST', {}),
      '/sandbox/moov/transfer',
      'POST',
      depsFor(client, { loadSandboxCredentials: creds, fetchImpl }),
    );
    assert.equal(first.ok, true);
    assert.equal(first.sandboxHttpCalled, true);
    assert.equal(first.amount.value, 1);
    assert.equal(first.provider.redacted_id, 'xfer…ox_1');
    const second = await handleSandboxRequest(
      jwtEvent('/sandbox/moov/transfer', 'POST', {}),
      '/sandbox/moov/transfer',
      'POST',
      depsFor(client, { loadSandboxCredentials: creds, fetchImpl }),
    );
    assert.equal(second.duplicate, true);
    assert.equal(posts, 1);
  });
});

test('C1C cannot operate on Freedom sandbox membership', async () => {
  await withEnv({
    AWS_PROVIDER_EXECUTION_ENABLED: 'false',
    AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'true',
  }, async () => {
    const client = mockClient({
      mapping: { ...mappingFor(), application_user_id: 'fd857564-9534-4b0f-95ac-624ed1273725' },
      memberships: [{ tenant_id: C1C_TENANT, role: 'staff', tenant_name: 'C1C', tenant_slug: 'c1c' }],
      operations: [{
        id: OP_ID,
        tenant_id: FREEDOM_TENANT,
        application_user_id: FREEDOM_APP,
        operation_type: 'moov_sandbox_transfer',
        provider: 'moov',
        amount_cents: 1,
        idempotency_key: 'abc',
        status: 'provider_pending',
        provider_reference: 'xfer_sbox_1',
        sandbox_http_called: true,
        production_execution: false,
      }],
    });
    const result = await handleSandboxRequest(
      jwtEvent('/sandbox/moov/retrieve', 'POST', { operation_id: OP_ID }),
      '/sandbox/moov/retrieve',
      'POST',
      depsFor(client, {
        loadSandboxCredentials: async () => ({ moov: null, snapshot: { moov: { available: false } } }),
      }),
    );
    assert.equal(result.error, 'cross_tenant_denied');
  });
});

test('sandbox webhook verifies signature, ignores payload tenant, and is idempotent', async () => {
  await withEnv({
    AWS_PROVIDER_EXECUTION_ENABLED: 'false',
  }, async () => {
    const secret = 'sandbox-webhook-secret';
    const webhookId = 'wh_sandbox_1';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({
      type: 'transfer.completed',
      accountID: 'acct_sbox',
      tenant_id: C1C_TENANT,
      user_id: SPOOF_ID,
    });
    const signature = hmacBase64(secret, `${webhookId}.${timestamp}.${body}`, 'sha256');
    const client = mockClient({
      objects: [{ tenant_id: FREEDOM_TENANT, provider: 'moov', object_type: 'account', sandbox_provider_id: 'acct_sbox' }],
    });
    const event = jwtEvent('/sandbox/webhooks/moov', 'POST', body, {
      auth: null,
      headers: {
        'x-webhook-id': webhookId,
        'x-timestamp': timestamp,
        'x-signature': signature,
      },
    });
    event.body = body;
    const creds = async () => ({
      moov: { webhookSecret: secret },
      checkalt: null,
      plaid: null,
      snapshot: {},
    });
    const first = await handleSandboxRequest(event, '/sandbox/webhooks/moov', 'POST', depsFor(client, {
      loadSandboxCredentials: creds,
    }));
    assert.equal(first.ok, true);
    assert.equal(first.signature_ok, true);
    assert.equal(first.mapped_tenant_id, FREEDOM_TENANT);
    assert.equal(first.tenantFromPayloadIgnored, true);
    assert.equal(first.productionRecordsMutated, false);
    assert.equal(first.applied, false);
    const second = await handleSandboxRequest(event, '/sandbox/webhooks/moov', 'POST', depsFor(client, {
      loadSandboxCredentials: creds,
    }));
    assert.equal(second.duplicate, true);
    assert.equal(second.applied, false);
    assert.equal(client.hooks.length, 1);
  });
});
