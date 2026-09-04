import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LOOKUP_MAPPING_SQL } from '../functions/api/identity.mjs';
import { handler } from '../functions/api/index.mjs';
import { handleFinancialRequest } from '../functions/api/financial.mjs';
import { evaluateFinancialAuthorization } from '../functions/api/financial-authz.mjs';
import { probeProviderEgress } from '../functions/api/providers/egress.mjs';
import {
  inspectImage,
  normalizeToBudget,
  PER_IMAGE_BYTES_BUDGET,
  syntheticCheckPng,
  syntheticCheckRaster,
  toDepositPath,
} from '../functions/api/providers/parity/checkalt-image.mjs';
import { handleProviderRequest } from '../functions/api/providers.mjs';
import { formatCheckAltUserAmount } from '../functions/api/providers/amounts.mjs';
import { applyCheckAltWebhook, applyMoovWebhook, sandboxWebhookApplyEnabled } from '../functions/api/providers/webhook-apply.mjs';
import { hmacHex } from '../functions/api/providers/hmac.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FREEDOM_APP = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const FREEDOM_TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const CHECK_ID = '44444444-4444-4444-8444-444444444444';
const TRANSFER_ROW = {
  id: '55555555-5555-4555-8555-555555555555',
  tenant_id: FREEDOM_TENANT,
  status: 'submitted',
  destination_recipient_id: null,
  amount_cents: 1,
  wallet_id: null,
  leg_role: null,
  transfer_group_id: null,
  claim_id: null,
  check_id: null,
  description: 'sandbox penny',
};

const jwtEvent = (pathName, method, body, extra = {}) => ({
  rawPath: pathName,
  headers: {
    authorization: extra.auth === null ? undefined : 'Bearer test-id-token',
    ...(extra.headers || {}),
  },
  body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  requestContext: {
    stage: 'staging',
    http: { method, path: pathName },
    authorizer: extra.auth === null ? undefined : {
      jwt: { claims: { sub: extra.sub || COGNITO_SUB, email: 'checksops-tester@freedomadj.com', token_use: 'id' } },
    },
  },
});

const mapping = {
  application_user_id: FREEDOM_APP,
  cognito_sub: COGNITO_SUB,
  email: 'checksops-tester@freedomadj.com',
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

const identityClient = (extraQuery) => ({
  connect: async () => {},
  end: async () => {},
  query: async (sql, params = []) => {
    if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT' || sql === 'SET TRANSACTION READ WRITE'
      || sql.startsWith('SAVEPOINT') || sql.startsWith('RELEASE SAVEPOINT') || sql.startsWith('ROLLBACK TO SAVEPOINT')) {
      return { rows: [] };
    }
    if (sql.startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
    if (sql === LOOKUP_MAPPING_SQL) return { rows: params[0] === mapping.cognito_sub ? [mapping] : [] };
    if (sql.includes('FROM public.tenant_users')) {
      return { rows: [{ tenant_id: FREEDOM_TENANT, role: 'admin', tenant_name: 'Freedom', tenant_slug: 'freedom' }] };
    }
    if (sql.includes('FROM public.user_roles')) return { rows: [{ role: 'admin' }] };
    if (typeof extraQuery === 'function') return extraQuery(sql, params);
    return { rows: [] };
  },
});

test('CheckAlt UAT amount interpretation stays integer cents for 1, 100, and 12345', () => {
  assert.equal(formatCheckAltUserAmount(0.01).userAmount, 1);
  assert.equal(formatCheckAltUserAmount(1).userAmount, 100);
  assert.equal(formatCheckAltUserAmount(123.45).userAmount, 12345);
});

test('synthetic CheckAlt images re-encode oversized rasters and keep under-limit JPEGs', () => {
  const under = syntheticCheckRaster({ width: 1400, height: 1000, flat: true });
  assert.ok(under.length < PER_IMAGE_BYTES_BUDGET);
  const underOut = normalizeToBudget(under, 'front');
  assert.equal(Buffer.compare(underOut, under), 0);
  assert.ok(inspectImage(underOut).landscape);

  const oversized = syntheticCheckRaster({ width: 2200, height: 1600, seed: 9 });
  assert.ok(oversized.length > PER_IMAGE_BYTES_BUDGET);
  const overOut = normalizeToBudget(oversized, 'front');
  assert.ok(overOut.length <= PER_IMAGE_BYTES_BUDGET);
  assert.equal(overOut[0], 0xff);
  assert.equal(overOut[1], 0xd8);
  const overInfo = inspectImage(overOut);
  assert.equal(overInfo.landscape, true);
  assert.ok(Math.max(overInfo.width, overInfo.height) <= 1600);

  const portrait = syntheticCheckRaster({ width: 900, height: 1400, seed: 3 });
  const rotated = normalizeToBudget(portrait, 'rear');
  const rotatedInfo = inspectImage(rotated);
  assert.equal(rotatedInfo.landscape, true);
  assert.ok(rotated.length <= PER_IMAGE_BYTES_BUDGET);

  const png = syntheticCheckPng({ width: 200, height: 160 });
  const fromPng = normalizeToBudget(png, 'front');
  assert.equal(fromPng[0], 0xff);
  assert.ok(fromPng.length <= PER_IMAGE_BYTES_BUDGET);
  assert.equal(toDepositPath('checks/x/front.png'), 'checks/x/front.deposit2.jpg');
  assert.equal(toDepositPath('checks/x/back.jpeg'), 'checks/x/back.deposit2.jpg');
});

test('UAT synthetic fixture exercises production prepare pipeline (>=1300 landscape JPEG)', async () => {
  const {
    prepareSyntheticUatDepositImages,
    buildSyntheticUatCheckSource,
    TARGET_MAX_DIM,
    MIN_DIM,
  } = await import('../functions/api/providers/parity/checkalt-image.mjs');
  const source = buildSyntheticUatCheckSource({ side: 'front' });
  const sourceInfo = inspectImage(source);
  assert.equal(sourceInfo.landscape, true);
  assert.ok(Math.max(sourceInfo.width, sourceInfo.height) > TARGET_MAX_DIM);
  const prepared = prepareSyntheticUatDepositImages();
  assert.equal(prepared.imageKind, 'synthetic_uat_via_prepare_pipeline');
  assert.ok(Math.max(prepared.frontInfo.width, prepared.frontInfo.height) >= MIN_DIM);
  assert.ok(Math.max(prepared.frontInfo.width, prepared.frontInfo.height) <= TARGET_MAX_DIM);
  assert.equal(prepared.frontInfo.landscape, true);
  assert.equal(prepared.rearInfo.landscape, true);
  assert.ok(prepared.frontInfo.preparedBytes <= PER_IMAGE_BYTES_BUDGET);
  assert.equal(prepared.frontImage.startsWith('data:'), false);
  assert.equal(Buffer.from(prepared.frontImage, 'base64')[0], 0xff);
});

test('checkalt-prepare-image writes .deposit2.jpg for front and rear synthetic checks', async () => {
  const uploaded = [];
  const frontSrc = syntheticCheckRaster({ width: 2200, height: 1400, seed: 11 });
  const rearSrc = syntheticCheckRaster({ width: 800, height: 1500, seed: 12 });
  await withEnv({
    AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'true',
    AWS_PROVIDER_EXECUTION_ENABLED: 'false',
    AWS_CHECKALT_ENABLED: 'false',
  }, async () => {
    const client = identityClient((sql) => {
      if (sql.includes('FROM public.check_intake_items')) {
        return {
          rows: [{
            id: CHECK_ID,
            tenant_id: FREEDOM_TENANT,
            front_image_path: `checks/${CHECK_ID}/front.jpg`,
            back_image_path: `checks/${CHECK_ID}/back.jpg`,
            back_image_deposit_path: null,
          }],
        };
      }
      return { rows: [] };
    });
    const run = async (side, bytes) => handleProviderRequest(
      jwtEvent('/functions/v1/checkalt-prepare-image', 'POST', {
        tenant_id: FREEDOM_TENANT,
        check_intake_item_id: CHECK_ID,
        side,
      }),
      '/functions/v1/checkalt-prepare-image',
      'POST',
      {
        loadDatabaseCredentials: async () => ({ host: 'localhost', username: 'checksops', password: 'x', database: 'checksops' }),
        createClient: () => client,
        loadSandboxCredentials: async () => ({
          checkalt: {
            environment: 'uat',
            baseUrl: 'https://uatapi.checkalt.com',
            username: 'api-login',
            userId: 'api-login',
            password: 'x',
            fiKey: 'fi',
            merchant: 'lockbox5',
          },
        }),
        downloadClaimFile: async () => bytes,
        headClaimFile: async () => null,
        uploadClaimFile: async (p, buf) => {
          uploaded.push({ path: p, bytes: buf.length, jpeg: buf[0] === 0xff });
          return p;
        },
      },
    );
    const front = await run('front', frontSrc);
    const rear = await run('back', rearSrc);
    assert.equal(front.success, true);
    assert.equal(front.prepared_path, `checks/${CHECK_ID}/front.deposit2.jpg`);
    assert.equal(front.cached, false);
    assert.ok(front.bytes <= PER_IMAGE_BYTES_BUDGET);
    assert.ok(front.source_bytes > PER_IMAGE_BYTES_BUDGET);
    assert.equal(rear.success, true);
    assert.equal(rear.prepared_path, `checks/${CHECK_ID}/back.deposit2.jpg`);
    assert.equal(uploaded.length, 2);
    assert.ok(uploaded.every((row) => row.jpeg && row.bytes <= PER_IMAGE_BYTES_BUDGET));
  });
});

test('checkalt-register-account is blocked without an approved UAT deposit account number', async () => {
  await withEnv({
    AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'true',
    AWS_PROVIDER_EXECUTION_ENABLED: 'false',
  }, async () => {
    const result = await handleProviderRequest(
      jwtEvent('/functions/v1/checkalt-register-account', 'POST', {
        tenant_id: FREEDOM_TENANT,
        sso_user_id: 'aws-uat-test-depositor',
      }),
      '/functions/v1/checkalt-register-account',
      'POST',
      {
        loadDatabaseCredentials: async () => ({ host: 'localhost', username: 'checksops', password: 'x', database: 'checksops' }),
        createClient: () => identityClient(),
        loadSandboxCredentials: async () => ({
          checkalt: {
            username: 'api-login',
            userId: 'api-login',
            password: 'x',
            fiKey: 'fi',
            merchant: 'lockbox5',
            depositAccountNumber: null,
          },
        }),
        fetchImpl: async () => {
          throw new Error('must not call CheckAlt without an approved test account number');
        },
      },
    );
    assert.equal(result.statusCode, 409);
    assert.equal(result.error, 'blocked_by_checkalt_test_configuration');
    assert.equal(result.classification, 'BLOCKED BY CHECKALT TEST CONFIGURATION');
    assert.equal(result.liveProviderCalled, false);
  });
});

test('GET /providers/egress reports Moov and CheckAlt UAT reachability from the API', async () => {
  const unreachable = await probeProviderEgress({
    fetchImpl: async () => {
      const err = new Error('fetch failed');
      err.cause = { code: 'ENETUNREACH' };
      throw err;
    },
  });
  assert.equal(unreachable.ok, false);
  assert.equal(unreachable.statusCode, 503);
  assert.equal(unreachable.moovReachable, false);
  assert.equal(unreachable.checkaltUatReachable, false);
  assert.equal(unreachable.secretsUsed, false);
  assert.equal(unreachable.rdsMadePublic, false);

  const reachable = await probeProviderEgress({
    fetchImpl: async () => ({ status: 401 }),
  });
  assert.equal(reachable.ok, true);
  assert.equal(reachable.moovReachable, true);
  assert.equal(reachable.checkaltUatReachable, true);

  const viaHandler = await handler({
    rawPath: '/providers/egress',
    requestContext: { stage: 'staging', http: { method: 'GET', path: '/providers/egress' } },
  });
  assert.ok(viaHandler.statusCode === 200 || viaHandler.statusCode === 503);
  const body = JSON.parse(viaHandler.body);
  assert.equal(body.probe, 'providers-egress');
  assert.equal(body.productionExecution, false);
});

test('sandbox webhook apply updates sandbox transfers and refuses production rows', async () => {
  await withEnv({
    AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'true',
    AWS_FINANCIAL_PERMISSIONS_ACTIVATED: 'false',
    AWS_PROVIDER_EXECUTION_ENABLED: 'false',
  }, async () => {
    assert.equal(sandboxWebhookApplyEnabled(), true);
    const queries = [];
    const sandboxClient = {
      query: async (sql, params = []) => {
        queries.push({ sql, params });
        if (sql.includes('environment = \'production\'')) return { rows: [] };
        if (sql.includes('FROM public.payment_provider_accounts') && sql.includes('environment = \'sandbox\'')) {
          return { rows: [{ id: 'acct-1', tenant_id: FREEDOM_TENANT, environment: 'sandbox', onboarding_status: 'active' }] };
        }
        if (sql.includes('FROM public.payment_transfers')) return { rows: [TRANSFER_ROW] };
        if (sql.includes('UPDATE public.payment_transfers')) return { rows: [{ id: TRANSFER_ROW.id }] };
        return { rows: [] };
      },
    };
    const applied = await applyMoovWebhook(sandboxClient, {
      type: 'transfer.updated',
      accountID: 'sandbox-acct',
      data: { transferID: 'tr_sandbox_1', status: 'completed' },
    }, { mappedTenantId: FREEDOM_TENANT });
    assert.equal(applied.applied, true);
    assert.equal(applied.environment, 'sandbox');
    assert.ok(applied.mutations.includes('payment_transfers'));
    assert.ok(queries.some((q) => q.sql.includes('environment = \'sandbox\'')));

    const productionClient = {
      query: async (sql) => {
        if (sql.includes('environment = \'sandbox\'')) return { rows: [] };
        if (sql.includes('environment = \'production\'')) {
          return { rows: [{ id: 'prod-1', environment: 'production' }] };
        }
        return { rows: [] };
      },
    };
    const refused = await applyMoovWebhook(productionClient, {
      type: 'account.updated',
      accountID: 'prod-acct',
      data: {},
    });
    assert.equal(refused.applied, false);
    assert.equal(refused.skipped, 'production_environment_row');
    assert.equal(refused.financialTablesMutated, false);

    const checkaltClient = {
      query: async (sql, params) => {
        if (sql.includes('UPDATE public.aws_provider_sandbox_operations')) {
          return { rows: [{ id: 'op-1', tenant_id: FREEDOM_TENANT, status: params[1] }] };
        }
        return { rows: [] };
      },
    };
    const ca = await applyCheckAltWebhook(checkaltClient, { referenceNumber: '98765', status: 'cleared' });
    assert.equal(ca.applied, true);
    assert.equal(ca.productionRecordsMutated, false);
  });
});

test('webhook HTTP apply stays off unless sandbox execution is enabled', async () => {
  const secret = 'staging-webhook-secret';
  const webhookId = 'evt_apply';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = 'n-apply';
  const rawBody = JSON.stringify({
    eventID: webhookId,
    type: 'transfer.updated',
    accountID: 'sandbox-acct',
    data: { transferID: 'tr_sandbox_1', status: 'completed' },
  });
  const signature = hmacHex(secret, `${timestamp}|${nonce}|${webhookId}`, 'sha512');
  const receipts = [];
  const client = {
    connect: async () => {},
    end: async () => {},
    queries: [],
    query: async (sql, params = []) => {
      client.queries.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT' || sql === 'SET TRANSACTION READ WRITE') return { rows: [] };
      if (sql.startsWith('SELECT set_config')) return { rows: [] };
      if (sql.includes('aws_lookup_provider_account')) {
        return { rows: [{ id: 'acct-1', tenant_id: FREEDOM_TENANT }] };
      }
      if (sql.includes('INSERT INTO public.aws_provider_webhook_receipts')) {
        const row = { id: 'receipt-1', provider: params[0], external_event_id: params[1] };
        receipts.push(row);
        return { rows: [row] };
      }
      if (sql.includes('FROM public.payment_provider_accounts')) {
        return { rows: [{ id: 'acct-1', tenant_id: FREEDOM_TENANT, environment: 'sandbox' }] };
      }
      if (sql.includes('FROM public.payment_transfers')) return { rows: [TRANSFER_ROW] };
      if (sql.includes('UPDATE public.payment_transfers')) return { rows: [TRANSFER_ROW] };
      return { rows: [] };
    },
  };
  const event = jwtEvent('/webhooks/moov', 'POST', rawBody, {
    auth: null,
    headers: { 'x-webhook-id': webhookId, 'x-timestamp': timestamp, 'x-nonce': nonce, 'x-signature': signature },
  });
  await withEnv({
    AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: undefined,
    AWS_FINANCIAL_PERMISSIONS_ACTIVATED: 'false',
    AWS_PROVIDER_WEBHOOK_DRY_RUN: 'true',
  }, async () => {
    const first = await handleProviderRequest(event, '/webhooks/moov', 'POST', {
      loadProviderSecrets: async () => ({ MOOV_WEBHOOK_SECRET: secret }),
      loadDatabaseCredentials: async () => ({ host: 'localhost', username: 'checksops', password: 'x', database: 'checksops' }),
      createClient: () => client,
    });
    assert.equal(first.applied, false);
    assert.equal(first.financialTablesMutated, false);
  });
  await withEnv({
    AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'true',
    AWS_FINANCIAL_PERMISSIONS_ACTIVATED: 'false',
    AWS_PROVIDER_EXECUTION_ENABLED: 'false',
    AWS_PROVIDER_WEBHOOK_DRY_RUN: 'true',
  }, async () => {
    const applied = await handleProviderRequest(event, '/webhooks/moov', 'POST', {
      loadProviderSecrets: async () => ({ MOOV_WEBHOOK_SECRET: secret }),
      loadDatabaseCredentials: async () => ({ host: 'localhost', username: 'checksops', password: 'x', database: 'checksops' }),
      createClient: () => client,
    });
    assert.equal(applied.applied, true);
    assert.equal(applied.productionRecordsMutated, false);
    assert.ok(applied.apply_mutations.includes('payment_transfers'));
  });
});

test('financial permission architecture fails closed while the activation flag is false or true', async () => {
  const gateOff = evaluateFinancialAuthorization({
    operation: 'checkalt_deposit',
    identityOk: true,
    membershipOk: true,
    roles: ['admin'],
    simulationEnabled: true,
    permissionsActivated: false,
  });
  assert.equal(gateOff.canExecuteProduction, false);
  assert.equal(gateOff.activated, false);

  const gateOn = evaluateFinancialAuthorization({
    operation: 'checkalt_deposit',
    identityOk: true,
    membershipOk: true,
    roles: ['admin'],
    simulationEnabled: true,
    permissionsActivated: true,
  });
  assert.equal(gateOn.canExecuteProduction, false);
  assert.equal(gateOn.financialPermissionActivated, true);

  await withEnv({
    AWS_FINANCIAL_SANDBOX_SIMULATION_ENABLED: 'true',
    AWS_PROVIDER_EXECUTION_ENABLED: 'false',
    AWS_FINANCIAL_PERMISSIONS_ACTIVATED: 'true',
  }, async () => {
    const result = await handleFinancialRequest(
      jwtEvent('/financial/prepare', 'POST', { operation_type: 'checkalt_deposit', check_id: CHECK_ID }),
      '/financial/prepare',
      'POST',
      {
        loadDatabaseCredentials: async () => ({ host: 'localhost', username: 'checksops', password: 'x', database: 'checksops' }),
        createClient: () => identityClient((sql) => {
          if (sql.includes('FROM public.check_intake_items')) {
            return {
              rows: [{
                id: CHECK_ID,
                tenant_id: FREEDOM_TENANT,
                uploaded_by: FREEDOM_APP,
                status: 'approved_for_deposit',
                check_stage: 'ready_for_deposit',
                claim_id: null,
                deposited_at: null,
                amount: 123.45,
                carrier_name: 'AWS',
              }],
            };
          }
          if (sql.includes('INSERT INTO public.aws_financial_audit')) return { rows: [] };
          return { rows: [] };
        }),
      },
    );
    assert.equal(result.statusCode, 403);
    assert.equal(result.error, 'financial_permissions_must_stay_deactivated');
  });

  const grants = fs.readFileSync(path.join(HERE, '../financial/sql/62_sandbox_financial_apply_grants.sql'), 'utf8');
  assert.match(grants, /request\.provider_webhook_apply/);
  assert.match(grants, /environment = 'sandbox'/);
  assert.doesNotMatch(grants, /GRANT UPDATE ON TABLE public\.payment_transfers/);
  assert.doesNotMatch(grants, /GRANT ALL ON TABLE/);
  const activation = fs.readFileSync(path.join(HERE, '../financial/sql/64_financial_activation_grants.sql'), 'utf8');
  assert.match(activation, /DO NOT APPLY THIS FILE/);
  assert.match(activation, /NOT_APPLIED/);
});

test('production provider flags remain false in the staging template', () => {
  const template = fs.readFileSync(path.join(HERE, '../template.yaml'), 'utf8');
  assert.match(template, /AWS_PROVIDER_EXECUTION_ENABLED: "false"/);
  assert.match(template, /AWS_MOOV_ENABLED: "false"/);
  assert.match(template, /AWS_CHECKALT_ENABLED: "false"/);
  assert.match(template, /AWS_FINANCIAL_PERMISSIONS_ACTIVATED: "false"/);
  assert.match(template, /CidrIp: 0\.0\.0\.0\/0/);
  assert.match(template, /CreateStagingNat/);
});
