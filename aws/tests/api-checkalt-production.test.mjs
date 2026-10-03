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
  PRODUCTION_CHECKALT_HTTP_SECRET_NAMES,
  PRODUCTION_CHECKALT_SECRET_NAMES,
} from '../functions/api/providers/production/checkalt-secrets.mjs';
import {
  evaluateCheckAltProductionAuthorization,
  stepUpMatchesCheck,
} from '../functions/api/providers/production/checkalt-authz.mjs';
import {
  isLegacyDepositRow,
  pickBlockingDeposit,
  shouldBlockNewProcessPost,
} from '../functions/api/providers/production/checkalt-idempotency.mjs';
import { handleProductionCheckAltSubmit } from '../functions/api/providers/production/checkalt-submit.mjs';
import { handleProductionCheckAltApprove } from '../functions/api/providers/production/checkalt-approve.mjs';
import {
  handleProductionCheckAltPoll,
  historyListOf,
  matchHistoryByReference,
  reconcileProductionCheckAltDeposit,
} from '../functions/api/providers/production/checkalt-poll.mjs';
import { runCheckAltStatusReconcile } from '../functions/api/providers/production/checkalt-status-reconcile.mjs';
import { syntheticCheckRaster } from '../functions/api/providers/parity/checkalt-image.mjs';
import { syntheticCompliantCheckAltJpeg } from '../functions/api/providers/production/checkalt-image-compliance.mjs';
import { buildCompletedEndorsementState } from '../functions/api/providers/production/checkalt-eligibility.mjs';
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
const OTHER_CHECK_ID = '55555555-5555-4555-8555-555555555555';
const OTHER_DEPOSIT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

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

const readyJpeg = () => syntheticCompliantCheckAltJpeg();

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

const productionPollFlags = {
  ...productionFlags,
  AWS_CHECKALT_STATUS_RECONCILE_ENABLED: 'true',
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
  payees,
  endorsements,
} = {}) => {
  const deposits = [];
  const stepups = [];
  const eligible = buildCompletedEndorsementState({ checkId: CHECK_ID, tenantId });
  const check = {
    id: CHECK_ID,
    tenant_id: tenantId,
    amount: 12.34,
    check_number: '1001',
    front_image_path: `checks/${CHECK_ID}/front.jpg`,
    back_image_path: `checks/${CHECK_ID}/back.svg`,
    back_image_deposit_path: `checks/${CHECK_ID}/back.jpg`,
    status: 'approved_for_deposit',
    check_stage: 'ready_for_deposit',
    endorsement_render_meta: { checkalt_rear_fingerprint: eligible.fingerprint },
    ...checkOverrides,
  };
  const files = {
    [`checks/${CHECK_ID}/front.checkalt.jpg`]: readyJpeg(),
    [`checks/${CHECK_ID}/back.checkalt.jpg`]: readyJpeg(),
  };
  return {
    deposits,
    stepups,
    check,
    files,
    payees: payees || eligible.payees,
    endorsements: endorsements || eligible.endorsements,
    processPosts: 0,
    approvePosts: 0,
    historyPosts: 0,
    itemPosts: 0,
    itemPayload: null,
    historyPayload: null,
    persistOutcomeFails: 0,
    role,
    rolesByUser: {},
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
      const userId = params[0];
      const role = store.rolesByUser?.[userId] || store.role;
      return { rows: role === 'operator' ? [{ role: 'staff' }] : [{ role: 'admin' }] };
    }
    if (text.includes('FROM public.tenant_users WHERE user_id') && text.includes('AND tenant_id')) {
      const userId = params[0];
      const tenantId = params[1];
      if (store.rolesByUser?.[userId]) {
        return { rows: [{ role: store.rolesByUser[userId] }] };
      }
      const match = store.memberships.find((row) => row.tenant_id === tenantId);
      return { rows: match ? [{ role: match.role }] : [] };
    }
    if (text.includes('FROM public.check_payees')) {
      return { rows: store.payees || [] };
    }
    if (text.includes('FROM public.check_endorsements')) {
      return { rows: store.endorsements || [] };
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
          auto_approve_enabled: store.autoApproveEnabled !== false,
          auto_approve_max_cents: store.autoApproveMaxCents ?? null,
        }],
      };
    }
    if (text.includes('FROM public.financial_stepup_log')) {
      const dual = text.includes('action_key = $2') && params[1] === 'checkalt.dual_control';
      if (dual) {
        const [tenantId, , since, checkId, amountCents] = params;
        return {
          rows: store.stepups.filter((row) => (
            row.action_key === 'checkalt.dual_control'
            && row.tenant_id === tenantId
            && row.succeeded === true
            && row.metadata?.check_id === checkId
            && Number(row.metadata?.amount_cents) === Number(amountCents)
            && new Date(row.created_at) >= new Date(since)
          )),
        };
      }
      const [userId, tenantId, actionKey, since, checkId, amountCents] = params;
      return {
        rows: store.stepups.filter((row) => (
          row.user_id === userId
          && row.tenant_id === tenantId
          && row.action_key === actionKey
          && row.succeeded === true
          && row.metadata?.check_id === checkId
          && Number(row.metadata?.amount_cents) === Number(amountCents)
          && new Date(row.created_at) >= new Date(since)
        )),
      };
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
    if (text.includes('status_refresh_tenants')) {
      return {
        rows: [...new Set(store.deposits
          .filter((row) => row.checkalt_reference && ['pending_approval', 'submitted'].includes(row.status))
          .map((row) => row.tenant_id))].map((tenant_id) => ({ tenant_id })),
      };
    }
    if (text.includes('FROM public.checkalt_deposits') && text.includes('status = ANY(')) {
      const tenantIds = params[0] || [];
      const statuses = params[1] || [];
      return {
        rows: store.deposits.filter((row) => (
          tenantIds.includes(row.tenant_id)
          && statuses.includes(row.status)
          && row.checkalt_reference
        )),
      };
    }
    if (text.includes('FROM public.checkalt_deposits') && text.includes('check_intake_item_id')
      && text.includes('tenant_id') && text.includes('ORDER BY')) {
      return {
        rows: store.deposits.filter((row) => (
          row.tenant_id === params[0] && row.check_intake_item_id === params[1]
        )),
      };
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
    if (text.includes('UPDATE public.checkalt_deposits') && text.includes('approved_at')) {
      const row = store.deposits.find((item) => item.id === params[0]);
      if (!row) return { rows: [] };
      if (params[1] === true) {
        row.status = 'submitted';
        row.approved_at = new Date().toISOString();
      }
      const extra = typeof params[2] === 'string' ? JSON.parse(params[2]) : params[2];
      row.last_status_payload = { ...(row.last_status_payload || {}), ...(extra || {}) };
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
      if (params[1] === 'cleared' && params[4]) row.cleared_at = params[4];
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
      text: async () => JSON.stringify(store.processPayload || { referenceNumber: 9001, status: 127 }),
    };
  }
  if (target.includes('/fincapture/deposit/approve')) {
    store.approvePosts += 1;
    store.approveBodies = store.approveBodies || [];
    try { store.approveBodies.push(JSON.parse(options.body || '{}')); } catch { store.approveBodies.push(options.body); }
    if (store.approveThrow) throw store.approveThrow;
    const http = store.approveHttp || { ok: true, status: 200 };
    return {
      ok: http.ok !== false,
      status: http.status || 200,
      text: async () => JSON.stringify(store.approvePayload || {
        success: true, status: 127, statusDescription: 'Approved',
      }),
    };
  }
  if (target.includes('/fincapture/deposit/item')) {
    store.itemPosts += 1;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(store.itemPayload || {
        referenceNumber: 9001, status: 127, statusCode: 127,
      }),
    };
  }
  if (target.includes('/fincapture/deposit/history')) {
    store.historyPosts += 1;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(store.historyPayload || {
        depositHistoryList: [{ referenceNumber: 9001, status: 127, userAmount: 1234 }],
      }),
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

const grantStepUp = (store, {
  userId = FREEDOM_APP,
  action = 'deposit.submit',
  checkId = CHECK_ID,
  tenantId = FREEDOM_TENANT,
  amountCents = 1234,
  createdAt = new Date().toISOString(),
} = {}) => {
  store.stepups.push({
    id: crypto.randomUUID(),
    user_id: userId,
    tenant_id: tenantId,
    action_key: action,
    factor_type: action === 'checkalt.dual_control' ? 'dual_control' : 'totp',
    succeeded: true,
    metadata: { check_id: checkId, amount_cents: amountCents, operation: 'deposit.submit' },
    created_at: createdAt,
  });
};

const pushLegacyDeposit = (store, extra = {}) => {
  const row = {
    id: extra.id || DEPOSIT_ID,
    tenant_id: extra.tenant_id || FREEDOM_TENANT,
    check_intake_item_id: extra.check_intake_item_id || CHECK_ID,
    amount: extra.amount ?? 12.34,
    amount_cents: extra.amount_cents ?? null,
    status: extra.status || 'submitted',
    submitted_by: FREEDOM_APP,
    idempotency_key: extra.idempotency_key === undefined ? null : extra.idempotency_key,
    checkalt_reference: extra.checkalt_reference === undefined ? null : extra.checkalt_reference,
    provider_http_attempted_at: extra.provider_http_attempted_at || null,
    last_status_payload: extra.last_status_payload || {},
    created_at: extra.created_at || '2024-01-01T00:00:00.000Z',
  };
  store.deposits.push(row);
  return row;
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
  assert.match(sql65, /COALESCE\(\s*public\.aws_financial_execution_active\(\),\s*false\s*\)/);
  assert.match(sql65, /COALESCE\(\s*current_setting\('request\.financial_execution',\s*true\) = '1'/);
  assert.doesNotMatch(sql65, /IF NOT public\.aws_financial_execution_active\(\)/);
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

test('webhook secret is optional for authenticate, process, and poll', async () => {
  const httpOnly = {
    CHECKALT_USERNAME: 'prod-user',
    CHECKALT_PASSWORD: 'prod-pass',
    CHECKALT_FI_KEY: 'prod-fi-key',
    CHECKALT_BASE_URL: 'https://api2.checkalt.com',
  };
  const classified = classifyProductionCheckAltSecrets(httpOnly);
  assert.equal(classified.productionKeysComplete, true);
  assert.equal(classified.productionWebhookConfigured, false);
  assert.deepEqual(classified.requiredNames, [...PRODUCTION_CHECKALT_HTTP_SECRET_NAMES]);
  assert.equal(classified.missingNames.includes('CHECKALT_WEBHOOK_SECRET'), false);

  resetProviderSecretsCache();
  const loaded = await withEnv(productionFlags, () => loadProductionCheckAltSecrets(async () => httpOnly));
  assert.equal(loaded.ok, true);
  assert.equal(loaded.credentials.webhookSecretConfigured, false);
  assert.equal(loaded.credentials.baseUrl, 'https://api2.checkalt.com');
});

test('missing front or rear deposit JPEG fails closed before provider HTTP', async () => {
  const missingFront = createStore({
    checkOverrides: { front_image_path: `checks/${CHECK_ID}/front.svg` },
  });
  delete missingFront.files['checks/' + CHECK_ID + '/front.checkalt.jpg'];
  grantStepUp(missingFront);
  const front = await submitOnce(missingFront);
  assert.equal(front.ok, false);
  assert.equal(front.error, 'provider_front_image_missing');
  assert.equal(front.reason, 'front_missing');
  assert.equal(missingFront.processPosts, 0);

  const missingRear = createStore({
    checkOverrides: { back_image_deposit_path: null, back_image_path: `checks/${CHECK_ID}/back.svg` },
  });
  grantStepUp(missingRear);
  const rear = await submitOnce(missingRear);
  assert.equal(rear.ok, false);
  assert.equal(rear.error, 'provider_rear_image_missing');
  assert.equal(rear.reason, 'rear_missing');
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
  const empty = await withEnv(productionPollFlags, () => handleProviderRequest(
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
  const cross = await withEnv(productionPollFlags, () => handleProviderRequest(
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
    assert.equal(ok.imagePipeline, 'checkalt_official_canvas_base64');
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

test('legacy CheckAlt row with reference blocks a second process POST', async () => {
  const store = createStore();
  grantStepUp(store);
  const legacy = pushLegacyDeposit(store, { checkalt_reference: 'LEGACY-REF', status: 'submitted' });
  assert.equal(isLegacyDepositRow(legacy), true);
  const result = await submitOnce(store);
  assert.equal(result.duplicate, true);
  assert.equal(result.liveProviderCalled, false);
  assert.equal(result.checkalt_reference, 'LEGACY-REF');
  assert.equal(store.processPosts, 0);
  assert.equal(store.deposits.length, 1);
});

test('legacy CheckAlt row with attempted_at blocks a second process POST', async () => {
  const store = createStore();
  grantStepUp(store);
  pushLegacyDeposit(store, {
    checkalt_reference: null,
    status: 'submitting',
    provider_http_attempted_at: '2024-06-01T00:00:00.000Z',
  });
  const result = await submitOnce(store);
  assert.equal(result.error, 'reconciliation_required');
  assert.equal(result.liveProviderCalled, false);
  assert.equal(store.processPosts, 0);
  assert.equal(store.deposits[0].idempotency_key, null);
});

test('legacy submitted or pending state without a new key blocks process POST', async () => {
  for (const status of ['submitted', 'pending_approval', 'pending']) {
    const store = createStore();
    grantStepUp(store);
    pushLegacyDeposit(store, { status, checkalt_reference: status === 'pending' ? null : 'REF-' + status });
    const result = await submitOnce(store);
    assert.equal(store.processPosts, 0, status);
    assert.equal(result.liveProviderCalled, false, status);
    if (status === 'pending') {
      assert.equal(result.error, 'reconciliation_required');
    } else {
      assert.equal(result.duplicate, true);
    }
  }
});

test('existing CheckAlt row for another tenant cannot be used or cross-read', async () => {
  const store = createStore();
  grantStepUp(store);
  pushLegacyDeposit(store, {
    id: OTHER_DEPOSIT_ID,
    tenant_id: C1C_TENANT,
    check_intake_item_id: CHECK_ID,
    checkalt_reference: 'OTHER-TENANT',
    status: 'submitted',
  });
  const accepted = await submitOnce(store);
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.checkalt_reference, '9001');
  assert.equal(store.processPosts, 1);
  assert.equal(store.deposits.length, 2);
  assert.equal(pickBlockingDeposit(store.deposits.filter((row) => row.tenant_id === FREEDOM_TENANT))?.checkalt_reference, '9001');

  const cross = await withEnv(productionPollFlags, () => handleProviderRequest(
    jwtEvent('/functions/v1/checkalt-poll-status', 'POST', { deposit_id: OTHER_DEPOSIT_ID, tenant_id: FREEDOM_TENANT }),
    '/functions/v1/checkalt-poll-status',
    'POST',
    submitDeps(store),
  ));
  assert.equal(cross.statusCode, 403);
  assert.equal(cross.error, 'cross_tenant_denied');
  assert.equal(cross.createdDeposit, false);
});

test('TOTP is bound to check and amount; tenant-wide leftover does not authorize', async () => {
  const leftover = createStore();
  leftover.stepups.push({
    id: crypto.randomUUID(),
    user_id: FREEDOM_APP,
    tenant_id: FREEDOM_TENANT,
    action_key: 'deposit.submit',
    factor_type: 'totp',
    succeeded: true,
    metadata: {},
    created_at: new Date().toISOString(),
  });
  const leftoverResult = await submitOnce(leftover);
  assert.equal(leftoverResult.error, 'step_up_required');
  assert.equal(leftover.processPosts, 0);

  const otherCheck = createStore();
  grantStepUp(otherCheck, { checkId: OTHER_CHECK_ID, amountCents: 1234 });
  const other = await submitOnce(otherCheck);
  assert.equal(other.error, 'step_up_required');
  assert.equal(otherCheck.processPosts, 0);

  const amountChanged = createStore();
  grantStepUp(amountChanged, { amountCents: 1234 });
  amountChanged.check.amount = 56.78;
  const changed = await submitOnce(amountChanged);
  assert.equal(changed.error, 'step_up_required');
  assert.equal(amountChanged.processPosts, 0);

  const expired = createStore();
  grantStepUp(expired, { createdAt: new Date(Date.now() - 31 * 60 * 1000).toISOString() });
  const stale = await submitOnce(expired);
  assert.equal(stale.error, 'step_up_required');
  assert.equal(expired.processPosts, 0);

  assert.equal(stepUpMatchesCheck({
    tenant_id: FREEDOM_TENANT,
    action_key: 'deposit.submit',
    succeeded: true,
    metadata: { check_id: CHECK_ID, amount_cents: 1234 },
  }, { tenantId: FREEDOM_TENANT, checkId: CHECK_ID, amountCents: 1234, actionKey: 'deposit.submit' }), true);
  assert.equal(stepUpMatchesCheck({
    tenant_id: FREEDOM_TENANT,
    action_key: 'deposit.submit',
    succeeded: true,
    metadata: { check_id: CHECK_ID, amount_cents: 1234 },
  }, { tenantId: FREEDOM_TENANT, checkId: CHECK_ID, amountCents: 5678, actionKey: 'deposit.submit' }), false);
});

test('dual-control requires a distinct owner/admin/manager bound to check and amount', async () => {
  const self = createStore();
  grantStepUp(self, { userId: FREEDOM_APP, action: 'checkalt.dual_control' });
  const selfDenied = await submitOnce(self);
  assert.equal(selfDenied.error, 'step_up_required');
  assert.equal(self.processPosts, 0);

  const ok = createStore();
  grantStepUp(ok, { userId: APPROVER_APP, action: 'checkalt.dual_control', amountCents: 1234 });
  ok.rolesByUser = { [APPROVER_APP]: 'admin', [FREEDOM_APP]: 'admin' };
  const accepted = await submitOnce(ok);
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.checkalt_reference, '9001');
  assert.equal(ok.processPosts, 1);

  const amountMismatch = createStore();
  grantStepUp(amountMismatch, { userId: APPROVER_APP, action: 'checkalt.dual_control', amountCents: 1234 });
  amountMismatch.check.amount = 99.01;
  const amountDenied = await submitOnce(amountMismatch);
  assert.equal(amountDenied.error, 'step_up_required');
  assert.equal(amountMismatch.processPosts, 0);

  const checkMismatch = createStore();
  grantStepUp(checkMismatch, { userId: APPROVER_APP, action: 'checkalt.dual_control', checkId: OTHER_CHECK_ID });
  const checkDenied = await submitOnce(checkMismatch);
  assert.equal(checkDenied.error, 'step_up_required');
  assert.equal(checkMismatch.processPosts, 0);

  const crossTenant = createStore();
  grantStepUp(crossTenant, {
    userId: APPROVER_APP,
    action: 'checkalt.dual_control',
    tenantId: C1C_TENANT,
  });
  const tenantDenied = await submitOnce(crossTenant);
  assert.equal(tenantDenied.error, 'step_up_required');
  assert.equal(crossTenant.processPosts, 0);

  const operatorApprover = createStore();
  grantStepUp(operatorApprover, { userId: APPROVER_APP, action: 'checkalt.dual_control' });
  operatorApprover.rolesByUser = { [APPROVER_APP]: 'operator', [FREEDOM_APP]: 'admin' };
  const operatorDenied = await submitOnce(operatorApprover);
  assert.equal(operatorDenied.error, 'step_up_required');
  assert.equal(operatorApprover.processPosts, 0);
});

test('dual-control record ignores browser tenant and amount', async () => {
  const store = createStore();
  const ok = await handleFinancialRequest(
    jwtEvent('/financial/checkalt-dual-control', 'POST', {
      check_intake_item_id: CHECK_ID,
      tenant_id: C1C_TENANT,
      amount: 0.01,
      amount_cents: 1,
    }),
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
  assert.equal(ok.tenant_id, FREEDOM_TENANT);
  assert.equal(ok.amount_cents, 1234);
  assert.equal(ok.check_id, CHECK_ID);
  assert.equal(store.stepups[0].tenant_id, FREEDOM_TENANT);
  assert.equal(store.stepups[0].metadata.amount_cents, 1234);
  assert.equal(store.stepups[0].metadata.check_id, CHECK_ID);
});

test('history matching is reference-only; amount cannot cross-match two deposits', async () => {
  const items = [
    { referenceNumber: 'A', userAmount: 1234, status: 127 },
    { referenceNumber: 'B', userAmount: 1234, status: 200 },
  ];
  assert.deepEqual(historyListOf({ depositHistoryList: items }), items);
  assert.equal(matchHistoryByReference(items, 'A')?.referenceNumber, 'A');
  assert.equal(matchHistoryByReference(items, 'B')?.referenceNumber, 'B');
  assert.equal(matchHistoryByReference(items, 'missing'), null);
  assert.equal(matchHistoryByReference([
    { referenceNumber: 'A', userAmount: 1234 },
    { referenceNumber: 'A', userAmount: 1234 },
  ], 'A'), null);

  const store = createStore();
  store.itemPayload = { ruleDetails: [] };
  store.historyPayload = { depositHistoryList: items };
  const rowA = pushLegacyDeposit(store, {
    checkalt_reference: 'A',
    status: 'submitted',
    idempotency_key: 'key-a',
  });
  const client = identityClient(store);
  const matched = await reconcileProductionCheckAltDeposit({
    client,
    mapping,
    row: rowA,
    cfg: { fi_key: 'prod-fi-key', merchant: 'prod-merchant', base_url: 'https://api2.checkalt.com' },
    credentials: productionSecrets().credentials,
    acct: { sso_user_id: 'depositor-prod' },
    fetchImpl: fetchImpl(store),
  });
  assert.equal(matched.reconciled, true);
  assert.equal(matched.checkalt_reference, 'A');
  assert.equal(store.deposits[0].status, 'submitted');
  assert.equal(store.processPosts, 0);

  const ambiguous = createStore();
  ambiguous.itemPayload = { ruleDetails: [] };
  ambiguous.historyPayload = {
    depositHistoryList: [
      { referenceNumber: 'X', userAmount: 1234, status: 127 },
      { referenceNumber: 'Y', userAmount: 1234, status: 200 },
    ],
  };
  const row = pushLegacyDeposit(ambiguous, {
    checkalt_reference: 'Z',
    status: 'submitting',
    provider_http_attempted_at: '2024-06-01T00:00:00.000Z',
    idempotency_key: 'key-z',
  });
  const required = await reconcileProductionCheckAltDeposit({
    client: identityClient(ambiguous),
    mapping,
    row,
    cfg: { fi_key: 'prod-fi-key', merchant: 'prod-merchant', base_url: 'https://api2.checkalt.com' },
    credentials: productionSecrets().credentials,
    acct: { sso_user_id: 'depositor-prod' },
    fetchImpl: fetchImpl(ambiguous),
  });
  assert.equal(required.error, 'reconciliation_required');
  assert.equal(required.reconciled, false);
  assert.equal(required.liveProviderCalled, true);
  assert.equal(ambiguous.processPosts, 0);
  assert.equal(ambiguous.deposits[0].checkalt_reference, 'Z');
  assert.equal(ambiguous.deposits[0].status, 'submitting');
});

test('ambiguous or reference-less history never issues a second process POST', async () => {
  const store = createStore();
  grantStepUp(store);
  pushLegacyDeposit(store, {
    checkalt_reference: null,
    status: 'submitting',
    provider_http_attempted_at: '2024-06-01T00:00:00.000Z',
  });
  const result = await submitOnce(store);
  assert.equal(result.error, 'reconciliation_required');
  assert.equal(result.liveProviderCalled, false);
  assert.equal(store.processPosts, 0);
  assert.equal(store.historyPosts, 0);

  const noRef = await reconcileProductionCheckAltDeposit({
    client: identityClient(store),
    mapping,
    row: store.deposits[0],
    cfg: { fi_key: 'prod-fi-key' },
    credentials: productionSecrets().credentials,
    acct: { sso_user_id: 'depositor-prod' },
    fetchImpl: fetchImpl(store),
  });
  assert.equal(noRef.error, 'reconciliation_required');
  assert.equal(noRef.liveProviderCalled, false);
  assert.equal(store.processPosts, 0);
  assert.equal(store.historyPosts, 0);
});

test('legacy NULL key and provider-may-have-occurred states block new process posts', () => {
  assert.equal(shouldBlockNewProcessPost({
    idempotency_key: null,
    status: 'queued',
  }), true);
  assert.equal(shouldBlockNewProcessPost({
    idempotency_key: 'new-key',
    status: 'queued',
    provider_http_attempted_at: null,
    checkalt_reference: null,
  }), false);
  assert.equal(shouldBlockNewProcessPost({
    idempotency_key: 'new-key',
    status: 'submitted',
    checkalt_reference: 'R1',
  }), true);
});

test('empty Poll Now refreshes tenant pending_approval using stored reference', async () => {
  const store = createStore();
  store.itemPayload = { statusCode: 127, status: 127, statusDescription: 'Approved' };
  store.deposits.push({
    id: DEPOSIT_ID,
    tenant_id: FREEDOM_TENANT,
    check_intake_item_id: CHECK_ID,
    checkalt_reference: '9001',
    status: 'pending_approval',
    amount: 12.34,
    amount_cents: 1234,
    cleared_at: null,
  });
  const result = await withEnv(productionPollFlags, () => handleProviderRequest(
    jwtEvent('/functions/v1/checkalt-poll-status', 'POST', {}),
    '/functions/v1/checkalt-poll-status',
    'POST',
    submitDeps(store),
  ));
  assert.equal(result.statusCode, 200);
  assert.equal(result.polled, 1);
  assert.equal(result.updated, 1);
  assert.equal(result.createdDeposit, false);
  assert.equal(store.processPosts, 0);
  assert.equal(store.approvePosts, 0);
  assert.equal(store.itemPosts, 1);
  assert.equal(store.deposits[0].status, 'submitted');
  assert.ok(!store.deposits[0].cleared_at);
});

test('refresh-before-approve blocks stale 127 Approved and does not POST approve', async () => {
  const store = createStore();
  store.itemPayload = { status: 'Approved', statusDescription: 'Approved' };
  store.deposits.push({
    id: DEPOSIT_ID,
    tenant_id: FREEDOM_TENANT,
    check_intake_item_id: CHECK_ID,
    checkalt_reference: '9001',
    status: 'pending_approval',
    amount: 12.34,
    amount_cents: 1234,
    cleared_at: null,
  });
  const result = await withEnv(productionFlags, () => handleProviderRequest(
    jwtEvent('/functions/v1/checkalt-approve-deposit', 'POST', {
      deposit_id: DEPOSIT_ID,
      action: 'approve',
    }),
    '/functions/v1/checkalt-approve-deposit',
    'POST',
    submitDeps(store),
  ));
  assert.equal(result.statusCode, 200);
  assert.equal(result.already_resolved, true);
  assert.equal(result.action_taken, false);
  assert.equal(result.approvePosted, false);
  assert.equal(result.status, 'submitted');
  assert.equal(store.approvePosts, 0);
  assert.equal(store.processPosts, 0);
  assert.equal(store.deposits[0].status, 'submitted');
  assert.ok(!store.deposits[0].cleared_at);
});

test('approve still posts only when CheckAlt remains pending_approval', async () => {
  const store = createStore();
  store.itemPayload = { statusCode: 40, statusDescription: 'Pending' };
  store.deposits.push({
    id: DEPOSIT_ID,
    tenant_id: FREEDOM_TENANT,
    check_intake_item_id: CHECK_ID,
    checkalt_reference: '9001',
    status: 'pending_approval',
    amount: 12.34,
    amount_cents: 1234,
  });
  const result = await withEnv(productionFlags, () => handleProviderRequest(
    jwtEvent('/functions/v1/checkalt-approve-deposit', 'POST', {
      deposit_id: DEPOSIT_ID,
      action: 'approve',
    }),
    '/functions/v1/checkalt-approve-deposit',
    'POST',
    submitDeps(store),
  ));
  assert.equal(result.approvePosted, true);
  assert.equal(result.action_taken, true);
  assert.equal(result.status, 'submitted');
  assert.equal(store.approvePosts, 1);
  assert.equal(store.processPosts, 0);
  assert.equal(store.deposits[0].status, 'submitted');
  assert.ok(!store.deposits[0].cleared_at);
});

test('status reconcile job is read/status only and never submits or approves', async () => {
  const store = createStore();
  store.itemPayload = { statusCode: 127, statusDescription: 'Approved' };
  store.deposits.push({
    id: DEPOSIT_ID,
    tenant_id: FREEDOM_TENANT,
    check_intake_item_id: CHECK_ID,
    checkalt_reference: '9001',
    status: 'pending_approval',
    amount: 12.34,
    cleared_at: null,
  });
  const result = await withEnv(productionFlags, () => runCheckAltStatusReconcile({
    client: identityClient(store),
    fetchImpl: fetchImpl(store),
    deps: submitDeps(store),
  }));
  assert.equal(result.ok, true);
  assert.equal(result.submitPosted, false);
  assert.equal(result.approvePosted, false);
  assert.equal(result.moneyMoved, false);
  assert.equal(store.processPosts, 0);
  assert.equal(store.approvePosts, 0);
  assert.equal(store.itemPosts, 1);
  assert.equal(store.deposits[0].status, 'submitted');
});

test('production approve helper refuses a locator-less body', async () => {
  const store = createStore();
  const result = await handleProductionCheckAltApprove({
    client: identityClient(store),
    mapping,
    claims: { sub: COGNITO_SUB },
    body: { action: 'approve' },
    spoof: {},
    fetchImpl: fetchImpl(store),
    deps: submitDeps(store),
  });
  assert.equal(result.error, 'deposit_locator_required');
  assert.equal(result.approvePosted, false);
});

test('status 40 + enabled + $2000 ceiling auto-approves a clean $12.34 deposit', async () => {
  const store = createStore();
  store.processPayload = {
    success: true,
    referenceNumber: 9001,
    status: 40,
    statusDescription: 'Pending Approval',
    riskRating: 2,
    riskRatingDescription: 'Low Risk',
    amountDiscrepancyDetected: false,
    errors: [],
  };
  store.autoApproveEnabled = true;
  store.autoApproveMaxCents = 200000;
  store.approvePayload = { success: true, status: 127, statusDescription: 'Approved' };
  grantStepUp(store);
  const result = await submitOnce(store);
  assert.equal(result.statusCode, 200);
  assert.equal(result.checkalt_reference, '9001');
  assert.equal(result.status, 'submitted');
  assert.equal(result.auto_approve.approved, true);
  assert.equal(result.auto_approve.approvePosted, true);
  assert.equal(result.auto_approve.maxCents, 200000);
  assert.equal(store.processPosts, 1);
  assert.equal(store.approvePosts, 1);
  assert.equal(store.deposits.length, 1);
  assert.equal(store.deposits[0].status, 'submitted');
  assert.ok(store.deposits[0].approved_at);
  assert.equal(store.deposits[0].cleared_at, undefined);
  assert.equal(store.deposits[0].last_status_payload._auto_approve.approved, true);
  assert.equal(store.approveBodies[0].referenceNumber, 9001);
  assert.equal(store.approveBodies[0].action, 1);
});

test('Freedom $1,546.72 and exact $2,000.00 auto-approve; $2,000.01 stays Manager', async () => {
  const below = createStore({ checkOverrides: { amount: 1546.72 } });
  below.processPayload = { referenceNumber: 9004, status: 40, statusDescription: 'Pending Approval' };
  below.autoApproveEnabled = true;
  below.autoApproveMaxCents = 200000;
  grantStepUp(below, { amountCents: 154672 });
  const belowResult = await submitOnce(below);
  assert.equal(belowResult.status, 'submitted');
  assert.equal(belowResult.auto_approve.approved, true);
  assert.equal(below.processPosts, 1);
  assert.equal(below.approvePosts, 1);

  const exact = createStore({ checkOverrides: { amount: 2000 } });
  exact.processPayload = { referenceNumber: 9005, status: 40, statusDescription: 'Pending Approval' };
  exact.autoApproveEnabled = true;
  exact.autoApproveMaxCents = 200000;
  grantStepUp(exact, { amountCents: 200000 });
  const exactResult = await submitOnce(exact);
  assert.equal(exactResult.status, 'submitted');
  assert.equal(exactResult.auto_approve.approved, true);
  assert.equal(exact.approvePosts, 1);

  const over = createStore({ checkOverrides: { amount: 2000.01 } });
  over.processPayload = { referenceNumber: 9002, status: 40, statusDescription: 'Pending Approval' };
  over.autoApproveEnabled = true;
  over.autoApproveMaxCents = 200000;
  grantStepUp(over, { amountCents: 200001, checkId: CHECK_ID });
  const overResult = await submitOnce(over);
  assert.equal(overResult.status, 'pending_approval');
  assert.equal(overResult.auto_approve.skipReason, 'over_max_amount');
  assert.equal(over.approvePosts, 0);
  assert.equal(over.processPosts, 1);
});

test('NULL ceiling, disabled auto-approve, flagged, missing reference, and non-40 stay pending', async () => {
  const nullCeiling = createStore();
  nullCeiling.processPayload = { referenceNumber: 9001, status: 40, statusDescription: 'Pending Approval' };
  nullCeiling.autoApproveEnabled = true;
  nullCeiling.autoApproveMaxCents = null;
  grantStepUp(nullCeiling);
  const missing = await submitOnce(nullCeiling);
  assert.equal(missing.status, 'pending_approval');
  assert.equal(missing.auto_approve.skipReason, 'missing_auto_approve_ceiling');
  assert.equal(missing.auto_approve.approvePosted, false);
  assert.equal(nullCeiling.processPosts, 1);
  assert.equal(nullCeiling.approvePosts, 0);

  const disabled = createStore();
  disabled.processPayload = { referenceNumber: 9006, status: 40, statusDescription: 'Pending Approval' };
  disabled.autoApproveEnabled = false;
  disabled.autoApproveMaxCents = 200000;
  grantStepUp(disabled);
  const disabledResult = await submitOnce(disabled);
  assert.equal(disabledResult.status, 'pending_approval');
  assert.equal(disabledResult.auto_approve.skipReason, 'auto_approve_disabled');
  assert.equal(disabled.approvePosts, 0);

  const flagged = createStore();
  flagged.processPayload = {
    referenceNumber: 9003,
    status: 40,
    statusDescription: 'Pending Approval',
    exceptions: ['possible fraud'],
  };
  flagged.autoApproveEnabled = true;
  flagged.autoApproveMaxCents = 200000;
  grantStepUp(flagged);
  const flaggedResult = await submitOnce(flagged);
  assert.equal(flaggedResult.status, 'pending_approval');
  assert.equal(flaggedResult.auto_approve.skipReason, 'flagged_by_checkalt');
  assert.equal(flagged.approvePosts, 0);

  const discrepant = createStore();
  discrepant.processPayload = {
    referenceNumber: 9007,
    status: 40,
    statusDescription: 'Pending Approval',
    amountDiscrepancyDetected: true,
  };
  discrepant.autoApproveEnabled = true;
  discrepant.autoApproveMaxCents = 200000;
  grantStepUp(discrepant);
  const discrepantResult = await submitOnce(discrepant);
  assert.equal(discrepantResult.status, 'pending_approval');
  assert.equal(discrepantResult.auto_approve.skipReason, 'flagged_by_checkalt');
  assert.equal(discrepant.approvePosts, 0);

  const noRef = createStore();
  noRef.processPayload = { status: 40, statusDescription: 'Pending Approval' };
  noRef.autoApproveEnabled = true;
  noRef.autoApproveMaxCents = 200000;
  grantStepUp(noRef);
  const noRefResult = await submitOnce(noRef);
  assert.equal(noRefResult.status, 'pending_approval');
  assert.equal(noRefResult.auto_approve, null);
  assert.equal(noRefResult.checkalt_reference, null);
  assert.equal(noRef.processPosts, 1);
  assert.equal(noRef.approvePosts, 0);

  const alreadyApproved = createStore();
  alreadyApproved.processPayload = { referenceNumber: 9008, status: 127, statusDescription: 'Approved' };
  alreadyApproved.autoApproveEnabled = true;
  alreadyApproved.autoApproveMaxCents = 200000;
  grantStepUp(alreadyApproved);
  const submittedProcess = await submitOnce(alreadyApproved);
  assert.equal(submittedProcess.status, 'submitted');
  assert.equal(submittedProcess.auto_approve, null);
  assert.equal(alreadyApproved.processPosts, 1);
  assert.equal(alreadyApproved.approvePosts, 0);
});

test('CheckAlt approval rejection and network/ambiguous results stay pending_approval', async () => {
  const rejected = createStore();
  rejected.processPayload = { referenceNumber: 9009, status: 40, statusDescription: 'Pending Approval' };
  rejected.autoApproveEnabled = true;
  rejected.autoApproveMaxCents = 200000;
  rejected.approvePayload = { success: false, status: 40, statusDescription: 'Declined' };
  grantStepUp(rejected);
  const rejectedResult = await submitOnce(rejected);
  assert.equal(rejectedResult.status, 'pending_approval');
  assert.equal(rejectedResult.auto_approve.approved, false);
  assert.equal(rejectedResult.auto_approve.approvePosted, true);
  assert.equal(rejected.processPosts, 1);
  assert.equal(rejected.approvePosts, 1);

  const ambiguous = createStore();
  ambiguous.processPayload = { referenceNumber: 9010, status: 40, statusDescription: 'Pending Approval' };
  ambiguous.autoApproveEnabled = true;
  ambiguous.autoApproveMaxCents = 200000;
  ambiguous.approveHttp = { ok: false, status: 500 };
  ambiguous.approvePayload = { message: 'upstream' };
  grantStepUp(ambiguous);
  const ambiguousResult = await submitOnce(ambiguous);
  assert.equal(ambiguousResult.status, 'pending_approval');
  assert.equal(ambiguousResult.auto_approve.approved, false);
  assert.equal(ambiguous.approvePosts, 1);

  const network = createStore();
  network.processPayload = { referenceNumber: 9011, status: 40, statusDescription: 'Pending Approval' };
  network.autoApproveEnabled = true;
  network.autoApproveMaxCents = 200000;
  network.approveThrow = new Error('ECONNRESET');
  grantStepUp(network);
  const networkResult = await submitOnce(network);
  assert.equal(networkResult.status, 'pending_approval');
  assert.equal(networkResult.auto_approve.approved, false);
  assert.match(networkResult.auto_approve.skipReason, /auto_approve_error/);
  assert.equal(network.approvePosts, 1);
  assert.equal(network.processPosts, 1);
});

test('existing CheckAlt reference is never reprocessed and auto-approve does not run on replay', async () => {
  const store = createStore();
  store.processPayload = { referenceNumber: 9001555, status: 40, statusDescription: 'Pending Approval' };
  store.autoApproveEnabled = true;
  store.autoApproveMaxCents = 200000;
  grantStepUp(store);
  store.deposits.push({
    id: DEPOSIT_ID,
    tenant_id: FREEDOM_TENANT,
    check_intake_item_id: CHECK_ID,
    checkalt_reference: '9001555',
    status: 'pending_approval',
    amount: 1546.72,
    amount_cents: 154672,
    last_status_payload: {},
  });
  const replay = await submitOnce(store);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.checkalt_reference, '9001555');
  assert.equal(replay.status, 'pending_approval');
  assert.equal(store.processPosts, 0);
  assert.equal(store.approvePosts, 0);
  assert.equal(store.deposits.length, 1);
});
