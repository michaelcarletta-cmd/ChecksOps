import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LOOKUP_MAPPING_SQL, TENANT_MEMBERSHIP_SQL } from '../functions/api/identity.mjs';
import { handler } from '../functions/api/index.mjs';
import { handleFinancialRequest } from '../functions/api/financial.mjs';
import { evaluateFinancialAuthorization } from '../functions/api/financial-authz.mjs';
import { handleProviderRequest } from '../functions/api/providers.mjs';
import { productionCheckAltExecutionAllowed } from '../functions/api/providers/production/checkalt-holds.mjs';
import {
  classifyProductionCheckAltSecrets,
  loadProductionCheckAltSecrets,
  PRODUCTION_CHECKALT_SECRET_NAMES,
} from '../functions/api/providers/production/checkalt-secrets.mjs';
import { evaluateCheckAltProductionAuthorization } from '../functions/api/providers/production/checkalt-authz.mjs';
import { handleProductionCheckAltSubmit } from '../functions/api/providers/production/checkalt-submit.mjs';
import { handleProductionCheckAltPoll } from '../functions/api/providers/production/checkalt-poll.mjs';
import { syntheticCheckRaster } from '../functions/api/providers/parity/checkalt-image.mjs';
import { resetProviderSecretsCache } from '../functions/api/provider-secrets.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const FREEDOM_APP = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const FREEDOM_TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const C1C_TENANT = '4f172140-f57a-4744-8050-95f4f07b13b4';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const CHECK_ID = '44444444-4444-4444-8444-444444444444';
const APPROVER_APP = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DEPOSIT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

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

const readyJpeg = () => syntheticCheckRaster({ width: 1400, height: 1000, flat: true });

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
  AWS_CHECKALT_ENABLED: 'true',
  AWS_FINANCIAL_PERMISSIONS_ACTIVATED: 'true',
  AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: undefined,
  AWS_MOOV_ENABLED: 'false',
  PROVIDER_SECRETS_ARN: 'arn:aws:secretsmanager:us-east-1:806168576068:secret:checksops/production/providers',
};

const productionSecrets = () => ({
  ok: true,
  credentials: {
    environment: 'production',
    username: 'prod-user',
    password: 'prod-pass',
    fiKey: 'prod-fi-key',
    baseUrl: 'https://api2.checkalt.com',
    webhookSecretConfigured: true,
  },
});

const createStore = ({
  role = 'admin',
  tenantId = FREEDOM_TENANT,
  checkOverrides = {},
  memberships = null,
} = {}) => {
  const deposits = [];
  const stepups = [];
  const check = {
    id: CHECK_ID,
    tenant_id: tenantId,
    amount: 12.34,
    check_number: '1001',
    front_image_path: `checks/${CHECK_ID}/front.deposit2.jpg`,
    back_image_path: `checks/${CHECK_ID}/back.svg`,
    back_image_deposit_path: `checks/${CHECK_ID}/back.deposit2.jpg`,
    status: 'approved_for_deposit',
    check_stage: 'ready_for_deposit',
    ...checkOverrides,
  };
  const files = {
    [check.front_image_path]: readyJpeg(),
    [check.back_image_deposit_path]: readyJpeg(),
  };
  return {
    deposits,
    stepups,
    check,
    files,
    processPosts: 0,
    persistOutcomeFails: 0,
    role,
    memberships: memberships || [{ tenant_id: tenantId, role, tenant_name: 'Freedom', tenant_slug: 'freedom' }],
  };
};

const identityClient = (store) => ({
  connect: async () => {},
  end: async () => {},
  query: async (sql, params = []) => {
    const text = String(sql);
    if (text === 'BEGIN' || text === 'ROLLBACK' || text === 'COMMIT' || text === 'SET TRANSACTION READ WRITE'
      || text.startsWith('SAVEPOINT') || text.startsWith('RELEASE SAVEPOINT') || text.startsWith('ROLLBACK TO SAVEPOINT')) {
      return { rows: [] };
    }
    if (text.startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
    if (text === LOOKUP_MAPPING_SQL) return { rows: params[0] === mapping.cognito_sub ? [mapping] : [] };
    if (text === TENANT_MEMBERSHIP_SQL || text.includes('FROM public.tenant_users tu')) {
      return { rows: store.memberships };
    }
    if (text.includes('FROM public.user_roles')) {
      return { rows: store.role === 'operator' ? [{ role: 'staff' }] : [{ role: 'admin' }] };
    }
    if (text.includes('FROM public.tenant_users WHERE user_id') && text.includes('AND tenant_id')) {
      const tenantId = params[1];
      const match = store.memberships.find((row) => row.tenant_id === tenantId);
      return { rows: match ? [{ role: match.role }] : [] };
    }
    if (text.includes('FROM public.check_intake_items')) {
      return { rows: params[0] === store.check.id ? [store.check] : [] };
    }
    if (text.includes('aws_checkalt_production_config') || (text.includes('FROM public.checkalt_config') && text.includes('singleton'))) {
      return {
        rows: [{
          merchant: 'prod-merchant',
          fi_key: 'ignored-db-fi',
          base_url: 'https://api2.checkalt.com',
          default_enabled: true,
          depositor_account_id: 'acct-1',
          business_unit: null,
        }],
      };
    }
    if (text.includes('FROM public.checkalt_tenant_accounts')) {
      return {
        rows: [{
          tenant_id: store.check.tenant_id,
          enabled: true,
          sso_user_id: 'depositor-prod',
          deposit_account_number: '1234567890',
          last_register_payload: { sso_key: 'sso-prod' },
          auto_approve_enabled: true,
        }],
      };
    }
    if (text.includes('FROM public.financial_stepup_log')) {
      const userId = params[0];
      const action = params[2] || params[1];
      const rows = store.stepups.filter((row) => {
        if (text.includes('exclude') ) return true;
        if (text.includes("action_key = $2") && params[1] === 'checkalt.dual_control') {
          return row.action_key === 'checkalt.dual_control'
            && row.tenant_id === params[0]
            && row.metadata?.check_id === params[3];
        }
        if (row.user_id !== userId) return false;
        if (action && row.action_key !== action && row.action_key !== params[2]) return false;
        return true;
      });
      return { rows };
    }
    if (text.includes('INSERT INTO public.financial_stepup_log')) {
      const row = {
        id: crypto.randomUUID(),
        user_id: params[0],
        tenant_id: params[1],
        action_key: params[2],
        factor_type: text.includes('dual_control') ? 'dual_control' : 'totp',
        succeeded: true,
        metadata: typeof params[3] === 'string' ? JSON.parse(params[3]) : params[3],
        created_at: new Date().toISOString(),
      };
      store.stepups.push(row);
      return { rows: [row] };
    }
    if (text.includes('INSERT INTO public.checkalt_deposits')) {
      if (store.deposits.some((row) => row.idempotency_key === params[5] && row.tenant_id === params[1])) {
        const error = new Error('duplicate key');
        error.code = '23505';
        throw error;
      }
      const row = {
        id: DEPOSIT_ID,
        check_intake_item_id: params[0],
        tenant_id: params[1],
        amount: params[2],
        amount_cents: params[3],
        status: 'queued',
        submitted_by: params[4],
        idempotency_key: params[5],
        checkalt_reference: null,
        provider_http_attempted_at: null,
        last_status_payload: { provider_http_attempted: false },
        created_at: new Date().toISOString(),
      };
      store.deposits.push(row);
      return { rows: [row] };
    }
    if (text.includes('FROM public.checkalt_deposits') && text.includes('idempotency_key =')) {
      const found = store.deposits.find((row) => row.tenant_id === params[0] && row.idempotency_key === params[1]);
      return { rows: found ? [found] : [] };
    }
    if (text.includes('FROM public.checkalt_deposits')) {
      const found = store.deposits.find((row) => row.id === params[0] || row.checkalt_reference === params[0]
        || (params[1] && row.checkalt_reference === params[1]));
      return { rows: found ? [found] : [] };
    }
    if (text.includes('UPDATE public.checkalt_deposits') && text.includes('provider_http_attempted_at = now()')) {
      const row = store.deposits.find((item) => item.id === params[0]);
      if (!row || row.provider_http_attempted_at || row.checkalt_reference) return { rows: [] };
      row.status = 'submitting';
      row.provider_http_attempted_at = new Date().toISOString();
      row.last_status_payload = { provider_http_attempted: true };
      return { rows: [row] };
    }
    if (text.includes('UPDATE public.checkalt_deposits') && text.includes('failure_class')) {
      if (store.persistOutcomeFails > 0) {
        store.persistOutcomeFails -= 1;
        throw new Error('simulated_rds_failure');
      }
      const row = store.deposits.find((item) => item.id === params[0]);
      if (!row) return { rows: [] };
      row.status = params[1];
      if (params[2]) row.checkalt_reference = params[2];
      row.failure_class = params[3];
      row.last_error = params[4];
      return { rows: [row] };
    }
    if (text.includes('UPDATE public.checkalt_deposits')) {
      const row = store.deposits.find((item) => item.id === params[0]);
      if (!row) return { rows: [] };
      if (params[1]) row.status = params[1];
      if (params[2]) row.checkalt_reference = params[2];
      row.last_polled_at = new Date().toISOString();
      return { rows: [row] };
    }
    return { rows: [] };
  },
});

const fetchImpl = (store) => async (url, options = {}) => {
  const target = String(url);
  if (target.includes('/public/fincapture/authenticate')) {
    const token = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')
      + '.'
      + Buffer.from(JSON.stringify({ exp: 9999999999 })).toString('base64url')
      + '.sig';
    return {
      ok: true,
      status: 200,
      text: async () => token,
    };
  }
  if (target.includes('/fincapture/deposit/process')) {
    store.processPosts += 1;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ referenceNumber: 9001, status: 127 }),
    };
  }
  if (target.includes('/fincapture/deposit/item')) {
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ referenceNumber: 9001, status: 127, statusCode: 127 }),
    };
  }
  if (target.includes('/fincapture/deposit/history')) {
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ items: [{ referenceNumber: 9001, status: 127, userAmount: 1234 }] }),
    };
  }
  if (target.includes('/fincapture/useraccount/getUserAccountInformation')) {
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        accountDataList: [{ accountNumber: '1234567890', ssoKey: 'sso-prod' }],
      }),
    };
  }
  return { ok: false, status: 404, text: async () => 'not found' };
};

const submitDeps = (store, extra = {}) => ({
  createClient: () => identityClient(store),
  loadDatabaseCredentials: async () => ({
    host: 'localhost', username: 'checksops', password: 'x', database: 'checksops',
  }),
  fetchImpl: extra.fetchImpl || fetchImpl(store),
  loadProductionSecrets: extra.loadProductionSecrets || (async () => productionSecrets()),
  downloadClaimFile: extra.downloadClaimFile || (async (filePath) => store.files[filePath] || null),
});

const grantStepUp = (store, { userId = FREEDOM_APP, action = 'deposit.submit', checkId = CHECK_ID } = {}) => {
  store.stepups.push({
    id: crypto.randomUUID(),
    user_id: userId,
    tenant_id: FREEDOM_TENANT,
    action_key: action,
    factor_type: action === 'checkalt.dual_control' ? 'dual_control' : 'totp',
    succeeded: true,
    metadata: { check_id: checkId },
    created_at: new Date().toISOString(),
  });
};

const submitOnce = (store, body = {}, extra = {}) => withEnv(productionFlags, () => handleProviderRequest(
  jwtEvent('/functions/v1/checkalt-submit-deposit', 'POST', {
    check_intake_item_id: CHECK_ID,
    ...body,
  }, extra),
  '/functions/v1/checkalt-submit-deposit',
  'POST',
  submitDeps(store, extra),
));

test('money/provider flags remain OFF and evaluateFinancialAuthorization cannot execute production', () => {
  assert.equal(productionCheckAltExecutionAllowed(), false);
  const gate = evaluateFinancialAuthorization({
    operation: 'checkalt_deposit',
    identityOk: true,
    membershipOk: true,
    roles: ['admin'],
    permissionsActivated: true,
  });
  assert.equal(gate.canExecuteProduction, false);
  const checkAlt = evaluateCheckAltProductionAuthorization({
    identityOk: true,
    membershipOk: true,
    roles: ['admin'],
    totpOk: true,
  });
  assert.equal(checkAlt.canExecuteProduction, false);
  assert.equal(checkAlt.canExecuteProductionCheckAlt, false);
  assert.equal(checkAlt.flagsOk, false);
});

test('SQL 65 and secret contract stay dark (not applied, names only)', () => {
  const sql65 = fs.readFileSync(path.join(ROOT, 'aws/financial/sql/65_checkalt_production_writer.sql'), 'utf8');
  assert.match(sql65, /DO NOT APPLY/);
  assert.match(sql65, /NOT_APPLIED/);
  assert.match(sql65, /idempotency_key/);
  const contract = fs.readFileSync(path.join(ROOT, 'aws/financial/CHECKALT_PRODUCTION_SECRET_CONTRACT.md'), 'utf8');
  for (const name of PRODUCTION_CHECKALT_SECRET_NAMES) {
    assert.match(contract, new RegExp(name));
  }
  assert.match(contract, /DO NOT CREATE/);
  assert.doesNotMatch(contract, /password\s*[:=]\s*\S+/i);
  const template = fs.readFileSync(path.join(ROOT, 'aws/template.yaml'), 'utf8');
  assert.match(template, /AWS_PROVIDER_EXECUTION_ENABLED: "false"/);
  assert.match(template, /AWS_CHECKALT_ENABLED: "false"/);
  assert.match(template, /AWS_FINANCIAL_PERMISSIONS_ACTIVATED: "false"/);
  assert.match(template, /AWS_MOOV_ENABLED: "false"/);
});

test('unauthenticated CheckAlt production submit is denied', async () => {
  const store = createStore();
  const result = await withEnv(productionFlags, () => handleProviderRequest(
    jwtEvent('/functions/v1/checkalt-submit-deposit', 'POST', { check_intake_item_id: CHECK_ID }, { auth: null }),
    '/functions/v1/checkalt-submit-deposit',
    'POST',
    submitDeps(store),
  ));
  assert.equal(result.statusCode, 401);
  assert.equal(result.liveProviderCalled, undefined);
  assert.equal(store.processPosts, 0);
});

test('wrong tenant is denied and browser tenant/user spoof is ignored', async () => {
  const store = createStore();
  grantStepUp(store);
  const result = await submitOnce(store, {
    tenant_id: C1C_TENANT,
    user_id: APPROVER_APP,
    check_intake_item_id: CHECK_ID,
  });
  assert.equal(result.statusCode, 403);
  assert.equal(result.error, 'cross_tenant_denied');
  assert.equal(store.processPosts, 0);
});

test('browser amount manipulation is denied', async () => {
  const store = createStore();
  grantStepUp(store);
  const result = await submitOnce(store, { amount: 0.01, userAmount: 1 });
  assert.equal(result.statusCode, 400);
  assert.equal(result.error, 'untrusted_amount');
  assert.equal(store.processPosts, 0);
});

test('missing production secret fails closed; UAT names cannot satisfy production', async () => {
  resetProviderSecretsCache();
  const missing = await withEnv({ PROVIDER_SECRETS_ARN: undefined }, () => loadProductionCheckAltSecrets(async () => ({})));
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'production_secret_missing');

  resetProviderSecretsCache();
  const uatOnly = classifyProductionCheckAltSecrets({
    CHECKALT_UAT_USER_ID: 'uat-user',
    CHECKALT_UAT_PASSWORD: 'uat-pass',
    CHECKALT_UAT_FI_KEY: 'uat-fi',
    CHECKALT_UAT_BASE_URL: 'https://uatapi.checkalt.com',
    CHECKALT_UAT_MERCHANT: 'lockbox5',
  });
  assert.equal(uatOnly.productionKeysComplete, false);
  assert.equal(uatOnly.uatCannotSatisfyProduction, true);

  const store = createStore();
  grantStepUp(store);
  const result = await withEnv(productionFlags, () => handleProviderRequest(
    jwtEvent('/functions/v1/checkalt-submit-deposit', 'POST', { check_intake_item_id: CHECK_ID }),
    '/functions/v1/checkalt-submit-deposit',
    'POST',
    submitDeps(store, {
      loadProductionSecrets: async () => loadProductionCheckAltSecrets(async () => ({
        CHECKALT_UAT_USER_ID: 'uat-user',
        CHECKALT_UAT_PASSWORD: 'uat-pass',
        CHECKALT_UAT_BASE_URL: 'https://uatapi.checkalt.com',
      })),
    }),
  ));
  assert.equal(result.error, 'production_secret_missing');
  assert.equal(store.processPosts, 0);
});

test('missing front or rear deposit JPEG fails closed before provider HTTP', async () => {
  const missingFront = createStore({
    checkOverrides: { front_image_path: `checks/${CHECK_ID}/front.svg` },
  });
  delete missingFront.files[missingFront.check.front_image_path];
  grantStepUp(missingFront);
  const front = await submitOnce(missingFront);
  assert.equal(front.ok, false);
  assert.match(String(front.error), /front_image/);
  assert.equal(missingFront.processPosts, 0);

  const missingRear = createStore({
    checkOverrides: { back_image_deposit_path: null, back_image_path: `checks/${CHECK_ID}/back.svg` },
  });
  grantStepUp(missingRear);
  const rear = await submitOnce(missingRear);
  assert.equal(rear.ok, false);
  assert.equal(rear.error, 'rear_image_missing');
  assert.equal(missingRear.processPosts, 0);
});

test('operator without financial authorization cannot execute even with TOTP', async () => {
  const store = createStore({ role: 'operator' });
  grantStepUp(store);
  const result = await submitOnce(store);
  assert.equal(result.statusCode, 403);
  assert.equal(result.error, 'financial_unauthorized');
  assert.equal(store.processPosts, 0);
});

test('happy-path mocked production submit uses server amount, S3 JPEGs, and one FinCapture process POST', async () => {
  const store = createStore();
  grantStepUp(store);
  const result = await submitOnce(store, {
    amount: 9999,
    tenant_id: FREEDOM_TENANT,
    frontImage: 'not-a-real-image',
  });
  assert.equal(result.statusCode, 400);
  assert.equal(result.error, 'untrusted_amount');

  const accepted = await submitOnce(store, { tenant_id: FREEDOM_TENANT });
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.liveProviderCalled, true);
  assert.equal(accepted.userAmount, 1234);
  assert.equal(accepted.checkalt_reference, '9001');
  assert.equal(store.processPosts, 1);
  assert.equal(store.deposits.length, 1);
  assert.equal(store.deposits[0].amount, 12.34);
  assert.equal(store.deposits[0].amount_cents, 1234);
});

test('duplicate submission and simultaneous claim do not create a second provider POST', async () => {
  const store = createStore();
  grantStepUp(store);
  const first = await submitOnce(store);
  assert.equal(first.checkalt_reference, '9001');
  assert.equal(store.processPosts, 1);
  const second = await submitOnce(store);
  assert.equal(second.duplicate, true);
  assert.equal(second.liveProviderCalled, false);
  assert.equal(store.processPosts, 1);

  const race = createStore();
  grantStepUp(race);
  const [a, b] = await Promise.all([submitOnce(race), submitOnce(race)]);
  assert.equal(race.processPosts, 1);
  assert.equal(race.deposits.length, 1);
  assert.ok([a, b].some((row) => row.checkalt_reference === '9001' || row.duplicate === true));
});

test('provider accepted + DB failure does not blind-resubmit; Lambda/browser retry reconciles', async () => {
  const store = createStore();
  store.persistOutcomeFails = 1;
  grantStepUp(store);
  const first = await submitOnce(store);
  assert.equal(first.failure_class, 'db_after_provider');
  assert.equal(first.checkalt_reference, '9001');
  assert.equal(store.processPosts, 1);
  assert.equal(store.deposits[0].status, 'submitting');
  assert.ok(store.deposits[0].provider_http_attempted_at);

  const retry = await submitOnce(store);
  assert.equal(retry.duplicate || retry.replayed || retry.reconciled, true);
  assert.equal(store.processPosts, 1);
});

test('status poll cannot create deposits and is tenant-safe', async () => {
  const store = createStore();
  grantStepUp(store);
  const empty = await withEnv(productionFlags, () => handleProviderRequest(
    jwtEvent('/functions/v1/checkalt-poll-status', 'POST', { deposit_id: DEPOSIT_ID }),
    '/functions/v1/checkalt-poll-status',
    'POST',
    submitDeps(store),
  ));
  assert.equal(empty.statusCode, 404);
  assert.equal(empty.createdDeposit, false);
  assert.equal(store.deposits.length, 0);
  assert.equal(store.processPosts, 0);

  store.deposits.push({
    id: DEPOSIT_ID,
    tenant_id: C1C_TENANT,
    check_intake_item_id: CHECK_ID,
    checkalt_reference: '9001',
    status: 'submitted',
    amount: 12.34,
    amount_cents: 1234,
  });
  const cross = await withEnv(productionFlags, () => handleProviderRequest(
    jwtEvent('/functions/v1/checkalt-poll-status', 'POST', { deposit_id: DEPOSIT_ID, tenant_id: FREEDOM_TENANT }),
    '/functions/v1/checkalt-poll-status',
    'POST',
    submitDeps(store),
  ));
  assert.equal(cross.statusCode, 403);
  assert.equal(cross.error, 'cross_tenant_denied');
  assert.equal(cross.createdDeposit, false);
});

test('default holds keep the production CheckAlt path unreachable through the public handler', async () => {
  const store = createStore();
  grantStepUp(store);
  const result = await handler(jwtEvent('/functions/v1/checkalt-submit-deposit', 'POST', { check_intake_item_id: CHECK_ID }));
  const body = JSON.parse(result.body);
  assert.equal(result.statusCode, 403);
  assert.ok(['provider_disabled', 'production_execution_blocked'].includes(body.error));
  assert.equal(productionCheckAltExecutionAllowed(), false);
});

test('dual-control records approval without calling CheckAlt; operator cannot approve', async () => {
  const store = createStore();
  const ok = await handleFinancialRequest(
    jwtEvent('/financial/checkalt-dual-control', 'POST', { check_intake_item_id: CHECK_ID }),
    '/financial/checkalt-dual-control',
    'POST',
    {
      createClient: () => identityClient(store),
      loadDatabaseCredentials: async () => ({
        host: 'localhost', username: 'checksops', password: 'x', database: 'checksops',
      }),
    },
  );
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.liveProviderCalled, false);
  assert.equal(ok.productionExecution, false);
  assert.equal(store.stepups[0].action_key, 'checkalt.dual_control');

  const operatorStore = createStore({ role: 'operator' });
  const denied = await handleFinancialRequest(
    jwtEvent('/financial/checkalt-dual-control', 'POST', { check_intake_item_id: CHECK_ID }),
    '/financial/checkalt-dual-control',
    'POST',
    {
      createClient: () => identityClient(operatorStore),
      loadDatabaseCredentials: async () => ({
        host: 'localhost', username: 'checksops', password: 'x', database: 'checksops',
      }),
    },
  );
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.error, 'financial_unauthorized');
});

test('direct submit helper uses check amount cents and refuses client image bytes', async () => {
  const store = createStore();
  grantStepUp(store);
  const client = identityClient(store);
  await client.query('BEGIN');
  await withEnv(productionFlags, async () => {
    const denied = await handleProductionCheckAltSubmit({
      client,
      mapping,
      claims: { sub: COGNITO_SUB },
      body: { check_intake_item_id: CHECK_ID, frontImage: 'abc' },
      spoof: {},
      fetchImpl: fetchImpl(store),
      deps: submitDeps(store),
    });
    assert.equal(denied.error, 'untrusted_image_bytes');
    const ok = await handleProductionCheckAltSubmit({
      client,
      mapping,
      claims: { sub: COGNITO_SUB },
      body: { check_intake_item_id: CHECK_ID },
      spoof: {},
      fetchImpl: fetchImpl(store),
      deps: submitDeps(store),
    });
    assert.equal(ok.userAmount, 1234);
    assert.equal(ok.imagePipeline, 'browser_prepare_aws_base64');
  });
});

test('poll helper never inserts even when asked with a fabricated locator', async () => {
  const store = createStore();
  const client = identityClient(store);
  const result = await handleProductionCheckAltPoll({
    client,
    mapping,
    claims: { sub: COGNITO_SUB },
    body: { checkalt_reference: 'does-not-exist' },
    spoof: {},
    fetchImpl: fetchImpl(store),
    deps: submitDeps(store),
  });
  assert.equal(result.error, 'deposit_not_found');
  assert.equal(result.createdDeposit, false);
  assert.equal(store.deposits.length, 0);
});
