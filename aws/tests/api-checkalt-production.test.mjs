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
import { evaluateCheckAltProductionAuthorization } from '../functions/api/providers/production/checkalt-authz.mjs';
import {
  isLegacyDepositRow,
  pickBlockingDeposit,
  shouldBlockNewProcessPost,
} from '../functions/api/providers/production/checkalt-idempotency.mjs';
import { handleProductionCheckAltSubmit } from '../functions/api/providers/production/checkalt-submit.mjs';
import { handleProductionCheckAltApprove } from '../functions/api/providers/production/checkalt-approve.mjs';
import {
  buildHistoryRequestBody,
  handleProductionCheckAltPoll,
  historyListOf,
  historyWindow,
  matchHistoryByReference,
  reconcileProductionCheckAltDeposit,
  resolveSsoKey,
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
// The Cognito login every request below belongs to, unless a test says otherwise.
const ORIGIN_JTI = 'origin-jti-login-1';
const LOGIN_SESSION = `${COGNITO_SUB}:jti:${ORIGIN_JTI}`;
const LOGIN_CLAIMS = { sub: COGNITO_SUB, origin_jti: ORIGIN_JTI };

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
      jwt: {
        claims: extra.claims || {
          sub: extra.sub || COGNITO_SUB,
          email: 'owner@freedomadj.com',
          token_use: 'id',
          origin_jti: ORIGIN_JTI,
        },
      },
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
  checkId = CHECK_ID,
  checkOverrides = {},
  memberships = null,
  payees,
  endorsements,
} = {}) => {
  const deposits = [];
  const stepups = [];
  const eligible = buildCompletedEndorsementState({ checkId, tenantId });
  const check = {
    id: checkId,
    tenant_id: tenantId,
    amount: 12.34,
    check_number: '1001',
    front_image_path: `checks/${checkId}/front.jpg`,
    back_image_path: `checks/${checkId}/back.svg`,
    back_image_deposit_path: `checks/${checkId}/back.jpg`,
    status: 'approved_for_deposit',
    check_stage: 'ready_for_deposit',
    endorsement_render_meta: { checkalt_rear_fingerprint: eligible.fingerprint },
    ...checkOverrides,
  };
  const files = {
    [`checks/${checkId}/front.checkalt.jpg`]: readyJpeg(),
    [`checks/${checkId}/back.checkalt.jpg`]: readyJpeg(),
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
    platformRoles: [],
    platformRolesByUser: {},
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
      if (text === 'COMMIT' || text === 'ROLLBACK') (store.txLog = store.txLog || []).push(text);
      return { rows: [] };
    }
    if (text.startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
    if (text === LOOKUP_MAPPING_SQL) return { rows: params[0] === mapping.cognito_sub ? [mapping] : [] };
    if (text === TENANT_MEMBERSHIP_SQL || text.includes('FROM public.tenant_users tu')) {
      return { rows: store.memberships };
    }
    if (text.includes('FROM public.user_roles')) {
      // Platform user_roles are separate from tenant roles: none unless a test sets them.
      const userId = params[0];
      const platform = store.platformRolesByUser?.[userId] || store.platformRoles || [];
      return { rows: platform.map((role) => ({ role })) };
    }
    if (text.includes('FROM public.tenant_users WHERE user_id') && text.includes('AND tenant_id')) {
      const userId = params[0];
      const tenantId = params[1];
      if (store.rolesByUser && Object.hasOwn(store.rolesByUser, userId)) {
        // null: this user has no tenant_users row for the tenant.
        return { rows: store.rolesByUser[userId] ? [{ role: store.rolesByUser[userId] }] : [] };
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
          last_register_payload: store.tenantRegisterPayload === undefined
            ? { sso_key: 'sso-prod' }
            : store.tenantRegisterPayload,
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
      // Once-per-login lookup: user, tenant, Check Alt action, app TOTP, login session.
      const [userId, tenantId, actionKeys, loginSession] = params;
      if (!Array.isArray(actionKeys) || !loginSession) return { rows: [] };
      return {
        rows: store.stepups.filter((row) => (
          row.user_id === userId
          && row.tenant_id === tenantId
          && actionKeys.includes(row.action_key)
          && row.succeeded === true
          && row.factor_type === 'totp'
          && row.metadata?.source === 'app_financial_totp'
          && row.metadata?.login_session === loginSession
        )).slice(-1),
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
      store.autoApprovePersists = (store.autoApprovePersists || 0) + 1;
      const extra = typeof params[2] === 'string' ? JSON.parse(params[2]) : params[2];
      const phase = extra?._auto_approve?.phase;
      (store.txLog = store.txLog || []).push(`AUTO_APPROVE_PERSIST:${phase}`);
      store.autoApproveSql = text;
      if (store.autoApprovePersistFails > 0 || store.autoApprovePersistFailPhase === phase) {
        if (store.autoApprovePersistFails > 0) store.autoApprovePersistFails -= 1;
        throw new Error('simulated_rds_failure');
      }
      const row = store.deposits.find((item) => item.id === params[0] && item.tenant_id === params[3]);
      if (!row) return { rows: [] };
      if (params[1] === true && row.status === 'pending_approval') {
        row.status = 'submitted';
        row.approved_at = row.approved_at || new Date().toISOString();
      }
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
    if (text.includes('UPDATE public.checkalt_deposits') && text.includes('last_status_payload = COALESCE(last_status_payload, \'{}\'::jsonb) || $1::jsonb')) {
      // Reconcile diagnostics: merges last_status_payload only, never status.
      (store.diagnosticWrites = store.diagnosticWrites || []).push({ sql: text, params });
      const row = store.deposits.find((item) => item.id === params[1]);
      if (!row) return { rows: [] };
      row.last_status_payload = { ...(row.last_status_payload || {}), ...JSON.parse(params[0]) };
      return { rows: [] };
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
    try { (store.processBodies = store.processBodies || []).push(JSON.parse(options.body || '{}')); } catch { /* ignore */ }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(store.processPayload || { referenceNumber: 9001, status: 127 }),
    };
  }
  if (target.includes('/fincapture/deposit/approve')) {
    store.approvePosts += 1;
    (store.txLog = store.txLog || []).push('APPROVE_POST');
    store.approveSignals = [...(store.approveSignals || []), options.signal || null];
    if (store.approveHang) {
      return new Promise((resolve, reject) => {
        if (!options.signal) return;
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    }
    store.approveBodies = store.approveBodies || [];
    try { store.approveBodies.push(JSON.parse(options.body || '{}')); } catch { store.approveBodies.push(options.body); }
    if (store.approveThrow) throw store.approveThrow;
    const queued = Array.isArray(store.approveSequence) && store.approveSequence.length
      ? store.approveSequence.shift()
      : null;
    const http = queued?.http || store.approveHttp || { ok: true, status: 200 };
    const approveJson = queued?.json || store.approvePayload;
    return {
      ok: http.ok !== false,
      status: http.status || 200,
      text: async () => JSON.stringify(approveJson || {
        success: true, status: 'Approved', statusDescription: 'OK',
      }),
    };
  }
  if (target.includes('/fincapture/deposit/item')) {
    store.itemPosts += 1;
    (store.itemBodies = store.itemBodies || []).push(JSON.parse(options.body || '{}'));
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
    (store.historyBodies = store.historyBodies || []).push(JSON.parse(options.body || '{}'));
    return {
      ok: true,
      status: store.historyHttpStatus || 200,
      text: async () => JSON.stringify(store.historyPayload || {
        depositHistoryList: [{ referenceNumber: 9001, status: 127, userAmount: 1234 }],
      }),
    };
  }
  if (target.includes('/fincapture/useraccount/getUserAccountInformation')) {
    (store.userInfoBodies = store.userInfoBodies || []).push(JSON.parse(options.body || '{}'));
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
  sleepFn: extra.sleepFn || (async (ms) => {
    (store.sleeps = store.sleeps || []).push(ms);
    if (store.clock) store.clock.t += ms;
  }),
  ...(extra.deps || {}),
});

const grantStepUp = (store, {
  userId = FREEDOM_APP,
  action = 'deposit.submit',
  checkId = CHECK_ID,
  tenantId = FREEDOM_TENANT,
  amountCents = 1234,
  loginSession = LOGIN_SESSION,
  createdAt = new Date().toISOString(),
} = {}) => {
  store.stepups.push({
    id: crypto.randomUUID(),
    user_id: userId,
    tenant_id: tenantId,
    action_key: action,
    factor_type: action === 'checkalt.dual_control' ? 'dual_control' : 'totp',
    succeeded: true,
    metadata: {
      check_id: checkId,
      amount_cents: amountCents,
      login_session: loginSession,
      operation: action,
      source: 'app_financial_totp',
    },
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

const partnerMemberships = [{ tenant_id: C1C_TENANT, role: 'admin', tenant_name: 'C1C', tenant_slug: 'c1c' }];

test('a tenant operator can submit with its own TOTP; without it, step-up is still required', async () => {
  const noTotp = createStore({ role: 'operator' });
  const refused = await submitOnce(noTotp);
  assert.equal(refused.statusCode, 403);
  assert.equal(refused.error, 'step_up_required');
  assert.equal(noTotp.processPosts, 0);

  const store = createStore({ role: 'operator' });
  grantStepUp(store);
  const result = await submitOnce(store);
  assert.equal(result.statusCode, 200, JSON.stringify(result));
  assert.equal(result.checkalt_reference, '9001');
  assert.equal(store.processPosts, 1);
});

test('owner policy: a member whose stored role is viewer can submit with its own TOTP (the role is ignored)', async () => {
  const store = createStore({ role: 'viewer' });
  grantStepUp(store);
  const result = await submitOnce(store);
  assert.equal(result.statusCode, 200, JSON.stringify(result));
  assert.equal(result.checkalt_reference, '9001');
  assert.equal(store.processPosts, 1);
});

test('a partner (member of another tenant the check is shared with) cannot submit', async () => {
  const store = createStore({ memberships: partnerMemberships });
  grantStepUp(store, { tenantId: C1C_TENANT });
  const result = await submitOnce(store);
  assert.equal(result.statusCode, 403);
  // Refused by the ownership chain (user -> tenant membership -> check) before the role check.
  assert.equal(result.error, 'tenant_membership_required');
  assert.equal(store.processPosts, 0);
});

test('Check Alt authorization is tenant membership of the check tenant; the role value is ignored', () => {
  for (const roles of [['operator'], ['admin'], ['owner'], ['manager'], ['viewer'], ['member'], [''], ['viewer', 'admin']]) {
    const member = evaluateCheckAltProductionAuthorization({ identityOk: true, membershipOk: true, roles, totpOk: true });
    assert.equal(member.roleOk, true, JSON.stringify(roles));
    assert.equal(member.stepUpOk, true);
  }
  // No tenant_users row for the check's tenant: refused.
  const none = evaluateCheckAltProductionAuthorization({ identityOk: true, membershipOk: true, roles: [], totpOk: true });
  assert.equal(none.roleOk, false);
  assert.equal(none.canExecuteProductionCheckAlt, false);
  const outsider = evaluateCheckAltProductionAuthorization({ identityOk: true, membershipOk: false, roles: ['admin'], totpOk: true });
  assert.equal(outsider.roleOk, false);
  assert.equal(outsider.canExecuteProductionCheckAlt, false);
  const noStepUp = evaluateCheckAltProductionAuthorization({ identityOk: true, membershipOk: true, roles: ['operator'] });
  assert.equal(noStepUp.stepUpOk, false);
  assert.equal(noStepUp.canExecuteProductionCheckAlt, false);
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

const dualControlOnce = (store, body = {}) => {
  let clientsCreated = 0;
  return handleFinancialRequest(
    jwtEvent('/financial/checkalt-dual-control', 'POST', { check_intake_item_id: CHECK_ID, ...body }),
    '/financial/checkalt-dual-control',
    'POST',
    {
      createClient: () => {
        clientsCreated += 1;
        store.dualControlClients = clientsCreated;
        return identityClient(store);
      },
      loadDatabaseCredentials: async () => ({
        host: 'localhost', username: 'checksops', password: 'x', database: 'checksops',
      }),
    },
  );
};

test('dual-control route is removed: every caller gets 410 and nothing is written', async () => {
  const cases = [
    { label: 'tenant admin', store: createStore() },
    { label: 'tenant operator', store: createStore({ role: 'operator' }) },
    { label: 'tenant viewer', store: createStore({ role: 'viewer' }) },
    { label: 'non-member', store: createStore({ memberships: [] }) },
    { label: 'partner', store: createStore({ memberships: partnerMemberships }) },
  ];
  for (const { label, store } of cases) {
    for (const body of [{}, { tenant_id: C1C_TENANT, amount: 0.01, amount_cents: 1 }]) {
      const result = await dualControlOnce(store, body);
      assert.equal(result.statusCode, 410, label);
      assert.equal(result.ok, false, label);
      assert.equal(result.error, 'dual_control_removed', label);
      assert.equal(result.liveProviderCalled, false, label);
      assert.equal(result.productionExecution, false, label);
      assert.equal(result.approval_id, undefined, label);
      assert.equal(store.stepups.length, 0, label);
      assert.equal(store.dualControlClients || 0, 0, `${label}: no database connection`);
      assert.equal(store.processPosts, 0, label);
      assert.equal(store.approvePosts || 0, 0, label);
    }
  }
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
      claims: LOGIN_CLAIMS,
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

test('a Check Alt step-up row without this login session does not authorize', async () => {
  const leftover = createStore();
  leftover.stepups.push({
    id: crypto.randomUUID(),
    user_id: FREEDOM_APP,
    tenant_id: FREEDOM_TENANT,
    action_key: 'deposit.submit',
    factor_type: 'totp',
    succeeded: true,
    metadata: { check_id: CHECK_ID, amount_cents: 1234, operation: 'deposit.submit', source: 'app_financial_totp' },
    created_at: new Date().toISOString(),
  });
  const leftoverResult = await submitOnce(leftover);
  assert.equal(leftoverResult.error, 'step_up_required');
  assert.equal(leftover.processPosts, 0);

  // Same login string, but not recorded by the app TOTP step-up.
  const foreignSource = createStore();
  grantStepUp(foreignSource);
  foreignSource.stepups[0].metadata.source = 'browser';
  assert.equal((await submitOnce(foreignSource)).error, 'step_up_required');
  const failedRow = createStore();
  grantStepUp(failedRow);
  failedRow.stepups[0].succeeded = false;
  assert.equal((await submitOnce(failedRow)).error, 'step_up_required');
  assert.equal(foreignSource.processPosts + failedRow.processPosts, 0);
});

test('one verification authorizes two different checks and amounts in the same login session', async () => {
  // One step-up, entered hours ago for the first check: no check, amount or 30-minute binding.
  const first = createStore();
  grantStepUp(first, { createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() });
  const stepups = first.stepups;
  assert.equal(stepups.length, 1);

  const one = await submitOnce(first);
  assert.equal(one.statusCode, 200, JSON.stringify(one));
  assert.equal(one.userAmount, 1234);
  assert.equal(first.processPosts, 1);

  const second = createStore({ checkId: OTHER_CHECK_ID, checkOverrides: { amount: 56.78 } });
  second.stepups = stepups;
  const two = await submitOnce(second, { check_intake_item_id: OTHER_CHECK_ID });
  assert.equal(two.statusCode, 200, JSON.stringify(two));
  assert.equal(two.userAmount, 5678);
  assert.equal(second.processPosts, 1);
  assert.equal(second.deposits[0].check_intake_item_id, OTHER_CHECK_ID);
  assert.equal(second.deposits[0].amount_cents, 5678);

  // The same login's verification also approves a third deposit with another amount.
  const third = createStore({ checkOverrides: { amount: 1546.72 } });
  third.stepups = stepups;
  pendingApprovalDeposit(third, { amount: 1546.72, amount_cents: 154672 });
  const approved = await approveOnce(third);
  assert.equal(approved.ok, true, JSON.stringify(approved));
  assert.equal(approved.approvePosted, true);
  assert.equal(third.approvePosts, 1);

  // Still exactly one verification; nothing minted another.
  assert.equal(stepups.length, 1);
});

test('a new login session (different origin_jti or auth_time) requires verification again', async () => {
  const newLogins = [
    { sub: COGNITO_SUB, email: 'owner@freedomadj.com', token_use: 'id', origin_jti: 'origin-jti-login-2' },
    { sub: COGNITO_SUB, email: 'owner@freedomadj.com', token_use: 'id', auth_time: 1791000000 },
    // No origin_jti and no auth_time: the login cannot be identified, so it fails closed.
    { sub: COGNITO_SUB, email: 'owner@freedomadj.com', token_use: 'id' },
  ];
  for (const claims of newLogins) {
    const submit = createStore();
    grantStepUp(submit);
    const refused = await submitOnce(submit, {}, { claims });
    assert.equal(refused.statusCode, 403, JSON.stringify(claims));
    assert.equal(refused.error, 'step_up_required');
    assert.equal(submit.processPosts, 0);
    assert.equal(submit.deposits.length, 0);

    const approve = createStore();
    pendingApprovalDeposit(approve);
    grantStepUp(approve, { action: 'deposit.approve' });
    const event = jwtEvent('/functions/v1/checkalt-approve-deposit', 'POST', {
      deposit_id: DEPOSIT_ID,
      action: 'approve',
    }, { claims });
    const result = await withEnv(productionFlags, () => handleProviderRequest(
      event,
      '/functions/v1/checkalt-approve-deposit',
      'POST',
      submitDeps(approve),
    ));
    assertApproveRefused(approve, result);
  }

  // auth_time logins: a different sign-in time is a new login; the same one reuses the code.
  const authTimeSession = `${COGNITO_SUB}:auth:1791000000`;
  const later = createStore();
  grantStepUp(later, { loginSession: authTimeSession });
  const laterLogin = await submitOnce(later, {}, { claims: { sub: COGNITO_SUB, token_use: 'id', auth_time: 1791000500 } });
  assert.equal(laterLogin.error, 'step_up_required');
  assert.equal(later.processPosts, 0);
  const sameLogin = await submitOnce(later, {}, { claims: { sub: COGNITO_SUB, token_use: 'id', auth_time: 1791000000 } });
  assert.equal(sameLogin.statusCode, 200, JSON.stringify(sameLogin));
  assert.equal(later.processPosts, 1);
});

test('another user\'s login session cannot use its verification', async () => {
  const OTHER_SUB = 'd5497519-71f2-81f3-bcc7-f7205f9f7f60';
  for (const proof of [
    // The other user's own verification in the same tenant.
    { userId: APPROVER_APP, loginSession: `${OTHER_SUB}:jti:${ORIGIN_JTI}` },
    // The other user's row carrying this caller's login string.
    { userId: APPROVER_APP, loginSession: LOGIN_SESSION },
    // A row for this user but recorded for the other user's login.
    { userId: FREEDOM_APP, loginSession: `${OTHER_SUB}:jti:${ORIGIN_JTI}` },
    // This user's own verification for a different tenant.
    { tenantId: C1C_TENANT },
  ]) {
    const store = createStore();
    store.rolesByUser = { [APPROVER_APP]: 'admin', [FREEDOM_APP]: 'admin' };
    grantStepUp(store, proof);
    const refused = await submitOnce(store);
    assert.equal(refused.error, 'step_up_required', JSON.stringify(proof));
    assert.equal(store.processPosts, 0);

    const approve = createStore();
    approve.rolesByUser = { [APPROVER_APP]: 'admin', [FREEDOM_APP]: 'admin' };
    pendingApprovalDeposit(approve);
    grantStepUp(approve, { action: 'deposit.approve', ...proof });
    assertApproveRefused(approve, await approveOnce(approve));
  }
});

test('a viewer-role member is allowed; partners and platform roles are refused with a verified login session', async () => {
  // Owner policy: every member of the tenant is an equal user; tenant_users.role is ignored.
  const viewer = createStore({ role: 'viewer' });
  grantStepUp(viewer);
  const submitted = await submitOnce(viewer);
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  assert.equal(viewer.processPosts, 1);

  const viewerApprove = createStore({ role: 'viewer' });
  grantStepUp(viewerApprove, { action: 'deposit.approve' });
  pendingApprovalDeposit(viewerApprove);
  const approved = await approveOnce(viewerApprove);
  assert.equal(approved.ok, true, JSON.stringify(approved));
  assert.equal(approved.approvePosted, true);
  assert.equal(viewerApprove.approvePosts, 1);

  // A partner holds a verified session for its own tenant and even a row for the owner tenant.
  const partner = createStore({ memberships: partnerMemberships });
  grantStepUp(partner, { tenantId: C1C_TENANT });
  grantStepUp(partner, { tenantId: FREEDOM_TENANT });
  const partnerSubmit = await submitOnce(partner);
  assert.equal(partnerSubmit.statusCode, 403);
  assert.equal(partnerSubmit.error, 'tenant_membership_required');
  assert.equal(partner.processPosts, 0);
  pendingApprovalDeposit(partner);
  assertApproveRefused(partner, await approveOnce(partner), 'cross_tenant_denied');

  // A platform user_roles admin/staff with a verified session but no membership of the check tenant.
  for (const platformRoles of [['admin'], ['staff']]) {
    const platform = createStore({ memberships: [] });
    platform.platformRoles = platformRoles;
    grantStepUp(platform);
    grantStepUp(platform, { action: 'deposit.approve' });
    const platformSubmit = await submitOnce(platform);
    assert.equal(platformSubmit.statusCode, 403, JSON.stringify(platformRoles));
    assert.equal(platform.processPosts, 0);
    pendingApprovalDeposit(platform);
    const platformApprove = await approveOnce(platform);
    assert.equal(platformApprove.approvePosted, false);
    assert.equal(platform.approvePosts, 0);
  }
});

test('a login session with no verification is refused for submit and approve', async () => {
  const store = createStore({ role: 'owner' });
  const refused = await submitOnce(store);
  assert.equal(refused.statusCode, 403);
  assert.equal(refused.error, 'step_up_required');
  assert.equal(refused.evaluation?.stepUpOk, false);
  assert.equal(store.processPosts, 0);
  assert.equal(store.deposits.length, 0);

  const approve = createStore({ role: 'owner' });
  pendingApprovalDeposit(approve);
  assertApproveRefused(approve, await approveOnce(approve));
});

test('a valid recent dual-control row from another tenant member never substitutes for the submitter step-up', async () => {
  for (const approverRole of ['owner', 'admin', 'manager', 'operator']) {
    for (const submitterRole of ['admin', 'operator']) {
      const store = createStore({ role: submitterRole });
      // A row the removed route used to write: distinct approver, same tenant,
      // this check, this server-derived amount, recent.
      grantStepUp(store, { userId: APPROVER_APP, action: 'checkalt.dual_control', amountCents: 1234 });
      store.rolesByUser = { [APPROVER_APP]: approverRole, [FREEDOM_APP]: submitterRole };
      const refused = await submitOnce(store);
      assert.equal(refused.statusCode, 403, `${approverRole}/${submitterRole}`);
      assert.equal(refused.error, 'step_up_required');
      assert.equal(refused.evaluation?.stepUpOk, false);
      assert.equal('dualControlOk' in (refused.evaluation || {}), false);
      assert.equal(store.processPosts, 0);
      assert.equal(store.deposits.length, 0);
    }
  }

  // The submitter's own dual-control-shaped row does not count either.
  const self = createStore();
  grantStepUp(self, { userId: FREEDOM_APP, action: 'checkalt.dual_control' });
  const selfDenied = await submitOnce(self);
  assert.equal(selfDenied.error, 'step_up_required');
  assert.equal(self.processPosts, 0);

  // The submitter's own deposit.submit proof still works, and a dual-control
  // row alongside it changes nothing.
  const own = createStore({ role: 'operator' });
  grantStepUp(own, { userId: APPROVER_APP, action: 'checkalt.dual_control' });
  own.rolesByUser = { [APPROVER_APP]: 'admin', [FREEDOM_APP]: 'operator' };
  grantStepUp(own);
  const accepted = await submitOnce(own);
  assert.equal(accepted.statusCode, 200, JSON.stringify(accepted));
  assert.equal(accepted.checkalt_reference, '9001');
  assert.equal(own.processPosts, 1);
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

// Production 2026-10-22 10:08:33Z: approve on a pending deposit (check #00001831,
// ref 127491751, $5.00) answered reconciliation_required. The item endpoint can
// answer ruleDetails with no status; the history fallback then sent only
// { fiKey, ssoKey } with an unresolved ssoKey and matched nothing.
const PROD_CFG = { fi_key: 'prod-fi-key', merchant: 'prod-merchant', base_url: 'https://api2.checkalt.com' };
const PROD_REF = '127491751';
const SECRET_VALUES = ['prod-fi-key', 'sso-prod', 'depositor-prod', '1234567890', 'prod-user', 'prod-pass', '.sig'];

const pushPendingApproval = (store, extra = {}) => {
  const row = {
    id: DEPOSIT_ID,
    tenant_id: FREEDOM_TENANT,
    check_intake_item_id: CHECK_ID,
    checkalt_reference: PROD_REF,
    status: 'pending_approval',
    amount: 12.34,
    amount_cents: 1234,
    submitted_at: '2026-10-22T01:53:56.000Z',
    last_status_payload: {},
    cleared_at: null,
    ...extra,
  };
  store.deposits.push(row);
  return row;
};

const approvePendingOnce = (store) => withEnv(productionFlags, () => handleProviderRequest(
  jwtEvent('/functions/v1/checkalt-approve-deposit', 'POST', { deposit_id: DEPOSIT_ID, action: 'approve' }),
  '/functions/v1/checkalt-approve-deposit',
  'POST',
  submitDeps(store),
));

test('history fallback sends the last working Supabase fields with the resolved ssoKey and a dated window', async () => {
  const store = createStore();
  store.itemPayload = { ruleDetails: [] };
  store.historyPayload = { depositHistoryList: [{ referenceNumber: Number(PROD_REF), status: 40 }] };
  const row = pushPendingApproval(store);
  // Stored sso_key equal to sso_user_id: resolve through getUserAccountInformation, as submit does.
  const acct = { sso_user_id: 'depositor-prod', sso_key: 'depositor-prod', deposit_account_number: '1234567890' };
  const result = await reconcileProductionCheckAltDeposit({
    client: identityClient(store),
    mapping,
    row,
    cfg: PROD_CFG,
    credentials: productionSecrets().credentials,
    acct,
    fetchImpl: fetchImpl(store),
    now: Date.parse('2026-10-22T10:08:33.000Z'),
  });
  assert.equal(result.reconciled, true, JSON.stringify(result));
  assert.equal(result.status, 'pending_approval');
  assert.deepEqual(store.userInfoBodies, [{ fiKey: 'prod-fi-key', userId: 'depositor-prod' }]);
  assert.equal(store.itemBodies[0].ssoKey, 'sso-prod');
  assert.deepEqual(store.historyBodies, [{
    fiKey: 'prod-fi-key',
    userId: 'depositor-prod',
    ssoKey: 'sso-prod',
    accountNumber: '1234567890',
    startDate: '2026-10-19',
    endDate: '2026-10-22',
  }]);
  assert.equal(store.processPosts, 0);
  assert.equal(store.approvePosts, 0);

  // Unknown submitted_at: the last 30 days, like the Supabase poll.
  assert.deepEqual(historyWindow(null, Date.parse('2026-10-22T10:08:33.000Z')), {
    startDate: '2026-09-22',
    endDate: '2026-10-22',
  });
  // A stored CheckAlt-issued sso_key is used as is, with no lookup.
  assert.deepEqual(buildHistoryRequestBody({
    cfg: PROD_CFG,
    acct: { sso_user_id: 'depositor-prod', deposit_account_number: '1234567890' },
    ssoKey: 'sso-stored',
    submittedAt: '2026-10-01T12:00:00.000Z',
    now: Date.parse('2026-10-22T10:08:33.000Z'),
  }), {
    fiKey: 'prod-fi-key',
    userId: 'depositor-prod',
    ssoKey: 'sso-stored',
    accountNumber: '1234567890',
    startDate: '2026-09-28',
    endDate: '2026-10-22',
  });
});

test('approve: item ruleDetails only + history status 40 for the reference sends approve once', async () => {
  const store = createStore();
  grantStepUp(store, { action: 'deposit.approve' });
  store.tenantRegisterPayload = {};
  store.itemPayload = { ruleDetails: [] };
  store.historyPayload = { depositHistoryList: [{ referenceNumber: Number(PROD_REF), status: 40 }] };
  pushPendingApproval(store);
  const result = await approvePendingOnce(store);
  assert.equal(result.statusCode, 200, JSON.stringify(result));
  assert.equal(result.approvePosted, true);
  assert.equal(result.action_taken, true);
  assert.equal(store.approvePosts, 1);
  assert.deepEqual(store.approveBodies, [{ fiKey: 'prod-fi-key', referenceNumber: Number(PROD_REF), action: 1 }]);
  assert.equal(store.processPosts, 0);
  assert.equal(store.historyBodies[0].ssoKey, 'sso-prod');
  assert.equal(store.historyBodies[0].accountNumber, '1234567890');
  assert.equal(store.deposits[0].status, 'submitted');
});

test('approve: empty history answers reconciliation_required with non-secret diagnostics and sends nothing', async () => {
  const store = createStore();
  grantStepUp(store, { action: 'deposit.approve' });
  store.tenantRegisterPayload = {};
  // A provider string that echoes the ssoKey is redacted.
  store.itemPayload = { ruleDetails: [], statusDescription: 'No item for sso-prod' };
  store.historyPayload = { depositHistoryList: [] };
  pushPendingApproval(store);
  const logged = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { logged.push(args.join(' ')); };
  let result;
  try {
    result = await approvePendingOnce(store);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(result.error, 'reconciliation_required');
  assert.equal(result.ok, false);
  // Approve rolls back its transaction, so the evidence is also logged once (no secrets).
  const line = logged.find((entry) => entry.includes('checkalt_reconcile_unresolved'));
  assert.ok(line, logged.join('\n'));
  assert.equal(JSON.parse(line).history_list_length, 0);
  for (const secret of SECRET_VALUES) assert.equal(logged.join('\n').includes(secret), false, secret);
  assert.equal(result.approvePosted, false);
  assert.equal(store.approvePosts, 0);
  assert.equal(store.processPosts, 0);
  assert.equal(store.deposits[0].status, 'pending_approval');
  assert.deepEqual(result.diagnostics, {
    item_http_status: 200,
    item_keys: ['ruleDetails', 'statusDescription'],
    item_status_fields: { statusDescription: 'No item for [redacted]' },
    history_http_status: 200,
    history_keys: ['depositHistoryList'],
    history_status_fields: {},
    history_envelope: 'depositHistoryList',
    history_list_length: 0,
    history_reference_matches: 0,
    history_matched: false,
    history_window: result.diagnostics.history_window,
    sso_key_source: 'lookup',
  });
  assert.match(result.diagnostics.history_window.startDate, /^\d{4}-\d{2}-\d{2}$/);
  const text = JSON.stringify(result);
  for (const secret of SECRET_VALUES) assert.equal(text.includes(secret), false, secret);
});

test('poll: unresolved status keeps the row status and persists the diagnostics only', async () => {
  const store = createStore();
  store.itemPayload = { ruleDetails: [] };
  store.historyPayload = { message: 'no records' };
  store.historyHttpStatus = 200;
  pushPendingApproval(store);
  const result = await withEnv(productionPollFlags, () => handleProviderRequest(
    jwtEvent('/functions/v1/checkalt-poll-status', 'POST', { deposit_id: DEPOSIT_ID }),
    '/functions/v1/checkalt-poll-status',
    'POST',
    submitDeps(store),
  ));
  assert.equal(result.error, 'reconciliation_required');
  assert.equal(result.diagnosticsPersisted, true);
  assert.equal(result.diagnostics.history_envelope, null);
  assert.deepEqual(result.diagnostics.history_keys, ['message']);
  assert.equal(store.deposits[0].status, 'pending_approval');
  assert.equal(store.diagnosticWrites.length, 1);
  assert.doesNotMatch(store.diagnosticWrites[0].sql, /SET status|checkalt_reference =/);
  const saved = store.deposits[0].last_status_payload.last_reconcile_unresolved;
  assert.equal(saved.history_list_length, 0);
  assert.ok(saved.at);
  const text = JSON.stringify(saved);
  for (const secret of SECRET_VALUES) assert.equal(text.includes(secret), false, secret);
  assert.equal(store.processPosts, 0);
  assert.equal(store.approvePosts, 0);
});

test('poll resolves the ssoKey with the same function and answer as submit', async () => {
  const submitSrc = fs.readFileSync(path.join(ROOT, 'aws/functions/api/providers/production/checkalt-submit.mjs'), 'utf8');
  assert.match(submitSrc, /import \{ reconcileProductionCheckAltDeposit, resolveSsoKey \} from '\.\/checkalt-poll\.mjs';/);
  assert.equal(/function resolveSsoKey/.test(submitSrc), false);

  // Submit with a register payload that has no CheckAlt sso_key: process uses the looked-up key.
  const submitted = createStore();
  submitted.tenantRegisterPayload = {};
  grantStepUp(submitted);
  const accepted = await submitOnce(submitted);
  assert.equal(accepted.statusCode, 200, JSON.stringify(accepted));
  assert.equal(submitted.processBodies[0].ssoKey, 'sso-prod');

  // Poll on the same tenant account sends that key to item and history.
  const polled = createStore();
  polled.tenantRegisterPayload = {};
  polled.itemPayload = { ruleDetails: [] };
  polled.historyPayload = { depositHistoryList: [{ referenceNumber: Number(PROD_REF), status: 40 }] };
  pushPendingApproval(polled);
  const result = await withEnv(productionPollFlags, () => handleProviderRequest(
    jwtEvent('/functions/v1/checkalt-poll-status', 'POST', { deposit_id: DEPOSIT_ID }),
    '/functions/v1/checkalt-poll-status',
    'POST',
    submitDeps(polled),
  ));
  assert.equal(result.reconciled, true, JSON.stringify(result));
  assert.equal(polled.itemBodies[0].ssoKey, submitted.processBodies[0].ssoKey);
  assert.equal(polled.historyBodies[0].ssoKey, submitted.processBodies[0].ssoKey);

  // The shared resolver: stored key wins; lookup otherwise; sso_user_id when the lookup fails.
  const lookupFetch = fetchImpl(createStore());
  const credentials = productionSecrets().credentials;
  assert.equal(await resolveSsoKey({ cfg: PROD_CFG, credentials, acct: { sso_user_id: 'u', sso_key: 'k' }, fetchImpl: lookupFetch }), 'k');
  assert.equal(await resolveSsoKey({
    cfg: PROD_CFG, credentials, acct: { sso_user_id: 'u', sso_key: 'u', deposit_account_number: '1234567890' }, fetchImpl: lookupFetch,
  }), 'sso-prod');
  const failing = async (url) => (String(url).includes('getUserAccountInformation')
    ? { ok: false, status: 500, text: async () => 'down' }
    : lookupFetch(url));
  assert.equal(await resolveSsoKey({
    cfg: PROD_CFG, credentials, acct: { sso_user_id: 'u', sso_key: 'u', deposit_account_number: '1234567890' }, fetchImpl: failing,
  }), 'u');
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
  grantStepUp(store, { action: 'deposit.approve' });
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
  grantStepUp(store, { action: 'deposit.approve' });
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

const pendingApprovalDeposit = (store, extra = {}) => {
  store.itemPayload = { statusCode: 40, statusDescription: 'Pending' };
  store.deposits.push({
    id: DEPOSIT_ID,
    tenant_id: FREEDOM_TENANT,
    check_intake_item_id: CHECK_ID,
    checkalt_reference: '123733567',
    status: 'pending_approval',
    amount: 12.34,
    amount_cents: 1234,
    ...extra,
  });
};

const approveOnce = (store, body = {}) => withEnv(productionFlags, () => handleProviderRequest(
  jwtEvent('/functions/v1/checkalt-approve-deposit', 'POST', {
    deposit_id: DEPOSIT_ID,
    action: 'approve',
    ...body,
  }),
  '/functions/v1/checkalt-approve-deposit',
  'POST',
  submitDeps(store),
));

const assertApproveRefused = (store, result, error = 'step_up_required') => {
  assert.equal(result.error, error);
  assert.equal(result.approvePosted, false);
  assert.equal(store.approvePosts, 0);
  assert.equal(store.processPosts, 0);
  assert.equal(store.itemPosts, 0);
  assert.equal(store.deposits.length, 1);
  assert.equal(store.deposits[0].status, 'pending_approval');
};

test('approve without a deposit.approve step-up is refused before CheckAlt is called', async () => {
  const store = createStore();
  pendingApprovalDeposit(store);
  assertApproveRefused(store, await approveOnce(store));
});

test('approve accepts this login\'s deposit.submit step-up; a dual-control record never counts', async () => {
  const submitOnly = createStore();
  pendingApprovalDeposit(submitOnly);
  grantStepUp(submitOnly, { action: 'deposit.submit' });
  const approved = await approveOnce(submitOnly);
  assert.equal(approved.ok, true, JSON.stringify(approved));
  assert.equal(approved.approvePosted, true);
  assert.equal(submitOnly.approvePosts, 1);

  const dualOnly = createStore();
  pendingApprovalDeposit(dualOnly);
  grantStepUp(dualOnly, { action: 'checkalt.dual_control', userId: APPROVER_APP });
  assertApproveRefused(dualOnly, await approveOnce(dualOnly));
});

test('approve refuses a deposit.approve step-up for another tenant, user, or login', async () => {
  for (const proof of [
    { tenantId: C1C_TENANT },
    { userId: APPROVER_APP },
    { loginSession: `${COGNITO_SUB}:jti:origin-jti-login-0` },
  ]) {
    const store = createStore();
    pendingApprovalDeposit(store);
    grantStepUp(store, { action: 'deposit.approve', ...proof });
    assertApproveRefused(store, await approveOnce(store));
  }
});

test('approve refuses a deposit row whose amount or tenant differs from its check', async () => {
  const amountDrift = createStore();
  pendingApprovalDeposit(amountDrift, { amount: 1546.72, amount_cents: 154672 });
  grantStepUp(amountDrift, { action: 'deposit.approve' });
  grantStepUp(amountDrift, { action: 'deposit.approve', amountCents: 154672 });
  assertApproveRefused(amountDrift, await approveOnce(amountDrift), 'deposit_binding_mismatch');

  const tenantDrift = createStore({
    memberships: [
      { tenant_id: FREEDOM_TENANT, role: 'admin', tenant_name: 'Freedom', tenant_slug: 'freedom' },
      { tenant_id: C1C_TENANT, role: 'admin', tenant_name: 'C1C', tenant_slug: 'c1c' },
    ],
  });
  pendingApprovalDeposit(tenantDrift, { tenant_id: C1C_TENANT });
  grantStepUp(tenantDrift, { action: 'deposit.approve' });
  grantStepUp(tenantDrift, { action: 'deposit.approve', tenantId: C1C_TENANT });
  assertApproveRefused(tenantDrift, await approveOnce(tenantDrift), 'deposit_binding_mismatch');
});

test('approve refuses when the deposit check row is missing (no self-comparison)', async () => {
  const store = createStore();
  pendingApprovalDeposit(store);
  grantStepUp(store, { action: 'deposit.approve' });
  store.check = { ...store.check, id: OTHER_CHECK_ID };
  assertApproveRefused(store, await approveOnce(store), 'deposit_binding_mismatch');
});

test('a deposit.approve step-up for another check and amount, earlier in this login, still approves', async () => {
  const store = createStore();
  pendingApprovalDeposit(store);
  grantStepUp(store, {
    action: 'deposit.approve',
    checkId: OTHER_CHECK_ID,
    amountCents: 1235,
    createdAt: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
  });
  const result = await approveOnce(store);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.approvePosted, true);
  assert.equal(store.approvePosts, 1);
});

test('a valid deposit.approve step-up approves once; replaying it never POSTs approve again', async () => {
  const store = createStore();
  pendingApprovalDeposit(store);
  grantStepUp(store, { action: 'deposit.approve' });
  const first = await approveOnce(store);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.approvePosted, true);
  assert.equal(first.createdDeposit, false);
  assert.equal(first.checkalt_reference, '123733567');
  assert.equal(first.status, 'submitted');
  assert.equal(store.approvePosts, 1);
  assert.equal(store.processPosts, 0);
  assert.equal(store.deposits.length, 1);

  store.itemPayload = { statusCode: 127, statusDescription: 'Approved' };
  const replay = await approveOnce(store);
  assert.equal(replay.approvePosted, false);
  assert.equal(replay.action_taken, false);
  assert.equal(replay.already_resolved, true);
  assert.equal(store.approvePosts, 1);
  assert.equal(store.processPosts, 0);
});

test('a tenant operator can approve with its own deposit.approve step-up', async () => {
  const refused = createStore({ role: 'operator' });
  pendingApprovalDeposit(refused);
  assertApproveRefused(refused, await approveOnce(refused));

  const store = createStore({ role: 'operator' });
  pendingApprovalDeposit(store);
  grantStepUp(store, { action: 'deposit.approve' });
  const result = await approveOnce(store);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.approvePosted, true);
  assert.equal(store.approvePosts, 1);
});

test('owner policy: a member whose stored role is viewer can approve with its own step-up and can reject', async () => {
  const store = createStore({ role: 'viewer' });
  pendingApprovalDeposit(store);
  grantStepUp(store, { action: 'deposit.approve' });
  const approved = await approveOnce(store);
  assert.equal(approved.ok, true, JSON.stringify(approved));
  assert.equal(approved.approvePosted, true);
  assert.equal(store.approvePosts, 1);

  const rejectStore = createStore({ role: 'viewer' });
  pendingApprovalDeposit(rejectStore);
  const rejected = await approveOnce(rejectStore, { action: 'reject', reject_notes: 'bad image' });
  assert.equal(rejected.ok, true, JSON.stringify(rejected));
  assert.equal(rejected.status, 'rejected');
});

test('a platform admin/staff with no membership of the check tenant cannot submit, approve, reject or refresh', async () => {
  for (const platformRoles of [['admin'], ['staff'], ['admin', 'staff']]) {
    const submit = createStore({ memberships: [] });
    submit.platformRoles = platformRoles;
    grantStepUp(submit);
    const submitted = await submitOnce(submit);
    assert.equal(submitted.statusCode, 403, JSON.stringify(platformRoles));
    assert.equal(submit.processPosts, 0);

    const approve = createStore({ memberships: [] });
    approve.platformRoles = platformRoles;
    pendingApprovalDeposit(approve);
    grantStepUp(approve, { action: 'deposit.approve' });
    const approved = await approveOnce(approve);
    assert.equal(approved.approvePosted, false);
    assert.equal(approve.approvePosts, 0);
    const rejected = await approveOnce(approve, { action: 'reject' });
    assert.equal(rejected.approvePosted, false);
    assert.equal(approve.approvePosts, 0);
    assert.equal(approve.deposits[0].status, 'pending_approval');

    const poll = createStore({ memberships: [] });
    poll.platformRoles = platformRoles;
    poll.itemPayload = { statusCode: 127, status: 127, statusDescription: 'Approved' };
    poll.deposits.push({
      id: DEPOSIT_ID,
      tenant_id: FREEDOM_TENANT,
      check_intake_item_id: CHECK_ID,
      checkalt_reference: '9001',
      status: 'pending_approval',
      amount: 12.34,
      amount_cents: 1234,
      cleared_at: null,
    });
    const polled = await withEnv(productionPollFlags, () => handleProviderRequest(
      jwtEvent('/functions/v1/checkalt-poll-status', 'POST', { deposit_id: DEPOSIT_ID }),
      '/functions/v1/checkalt-poll-status',
      'POST',
      submitDeps(poll),
    ));
    assert.equal(polled.statusCode, 403);
    assert.equal(poll.itemPosts, 0);
    assert.equal(poll.deposits[0].status, 'pending_approval');
  }
});

test('a partner (member of another tenant) cannot approve the owner tenant deposit', async () => {
  const store = createStore({ memberships: partnerMemberships });
  pendingApprovalDeposit(store);
  grantStepUp(store, { action: 'deposit.approve', tenantId: C1C_TENANT });
  assertApproveRefused(store, await approveOnce(store), 'cross_tenant_denied');
});

const pollFor = (store, body = {}) => withEnv(productionPollFlags, () => handleProviderRequest(
  jwtEvent('/functions/v1/checkalt-poll-status', 'POST', body),
  '/functions/v1/checkalt-poll-status',
  'POST',
  submitDeps(store),
));

const refreshableDeposit = (store) => {
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
};

test('a tenant operator can refresh Check Alt status without a step-up', async () => {
  const store = createStore({ role: 'operator' });
  refreshableDeposit(store);
  const result = await pollFor(store);
  assert.equal(result.statusCode, 200, JSON.stringify(result));
  assert.equal(result.polled, 1);
  assert.equal(result.updated, 1);
  assert.equal(store.itemPosts, 1);
  assert.equal(store.processPosts, 0);
  assert.equal(store.approvePosts, 0);
});

test('owner policy: a member whose stored role is viewer can refresh Check Alt status', async () => {
  const one = createStore({ role: 'viewer' });
  refreshableDeposit(one);
  const result = await pollFor(one, { deposit_id: DEPOSIT_ID });
  assert.equal(result.statusCode, 200, JSON.stringify(result));
  assert.equal(one.itemPosts, 1);
  assert.equal(one.processPosts, 0);
  assert.equal(one.approvePosts, 0);
});

test('a partner (member of another tenant) cannot refresh the owner tenant deposit', async () => {
  const store = createStore({ memberships: partnerMemberships });
  refreshableDeposit(store);
  const denied = await pollFor(store, { deposit_id: DEPOSIT_ID });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.error, 'cross_tenant_denied');
  assert.equal(store.itemPosts, 0);
  const sweep = await pollFor(store);
  assert.equal(sweep.polled || 0, 0);
  assert.equal(store.itemPosts, 0);
  assert.equal(store.deposits[0].status, 'pending_approval');
});

test('reject does not require a deposit.approve step-up', async () => {
  const store = createStore();
  pendingApprovalDeposit(store);
  const result = await approveOnce(store, { action: 'reject', reject_notes: 'bad image' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, 'rejected');
  assert.equal(store.approvePosts, 1);
  assert.equal(store.processPosts, 0);
});

test('valid deposit.approve step-up plus CheckAlt approve failure stays approval-specific', async () => {
  const store = createStore();
  pendingApprovalDeposit(store);
  store.approvePayload = { success: false, statusDescription: 'Unable to approve' };
  grantStepUp(store, { action: 'deposit.approve' });
  const result = await approveOnce(store);
  assert.equal(result.error, 'checkalt_approve_failed');
  assert.equal(result.approvePosted, false);
  assert.doesNotMatch(String(result.message || ''), /authenticator|verification code/i);
  assert.equal(store.processPosts, 0);
  assert.equal(store.deposits[0].status, 'pending_approval');
});

test('submit accepts this login\'s deposit.approve step-up; other step-up actions never count', async () => {
  const approveOnly = createStore();
  grantStepUp(approveOnly, { action: 'deposit.approve' });
  const accepted = await submitOnce(approveOnly);
  assert.equal(accepted.statusCode, 200, JSON.stringify(accepted));
  assert.equal(approveOnly.processPosts, 1);

  for (const action of ['wallet.fund', 'checkalt.dual_control']) {
    const other = createStore();
    grantStepUp(other, { action });
    const denied = await submitOnce(other);
    assert.equal(denied.error, 'step_up_required', action);
    assert.equal(other.processPosts, 0);
  }
});

const PROCESS_40 = (reference = 9001, extra = {}) => ({
  success: true,
  referenceNumber: reference,
  status: 40,
  statusDescription: 'Pending Approval',
  riskRating: 2,
  riskRatingDescription: 'Low Risk',
  amountDiscrepancyDetected: false,
  errors: [],
  ...extra,
});

const autoApproveStore = ({ enabled = true, maxCents = 200000, amount, payload } = {}) => {
  const store = createStore(amount === undefined ? {} : { checkOverrides: { amount } });
  store.processPayload = payload || PROCESS_40();
  store.autoApproveEnabled = enabled;
  store.autoApproveMaxCents = maxCents;
  grantStepUp(store, amount === undefined ? {} : { amountCents: Math.round(amount * 100) });
  return store;
};

test('auto-approve: status 40 under the ceiling posts one approve and persists submitted + approved_at', async () => {
  const store = autoApproveStore();
  store.approvePayload = { success: true, status: 127, statusDescription: 'Approved' };
  const result = await submitOnce(store);
  assert.equal(result.statusCode, 200);
  assert.equal(result.status, 'submitted');
  assert.equal(result.checkalt_reference, '9001');
  assert.ok(result.approved_at);
  assert.deepEqual(
    { ...result.auto_approve },
    { attempted: true, approved: true, approvePosted: true, skipReason: null, maxCents: 200000, persistFailed: false },
  );
  assert.equal(store.processPosts, 1);
  assert.equal(store.approvePosts, 1);
  assert.equal(store.deposits.length, 1);
  const row = store.deposits[0];
  assert.equal(row.status, 'submitted');
  assert.ok(row.approved_at);
  assert.equal(row.cleared_at, undefined);
  assert.equal(row.last_status_payload._auto_approve.phase, 'outcome');
  assert.equal(row.last_status_payload._auto_approve.approved, true);
  assert.deepEqual(store.approveBodies[0], { fiKey: 'prod-fi-key', referenceNumber: 9001, action: 1 });
});

test('auto-approve: exact ceiling approves; one cent over stays pending_approval', async () => {
  const exact = autoApproveStore({ amount: 2000 });
  const exactResult = await submitOnce(exact);
  assert.equal(exactResult.status, 'submitted');
  assert.equal(exactResult.auto_approve.approved, true);
  assert.equal(exact.approvePosts, 1);

  const over = autoApproveStore({ amount: 2000.01 });
  const overResult = await submitOnce(over);
  assert.equal(overResult.status, 'pending_approval');
  assert.equal(overResult.auto_approve.skipReason, 'over_max_amount');
  assert.equal(overResult.auto_approve.approvePosted, false);
  assert.equal(over.processPosts, 1);
  assert.equal(over.approvePosts, 0);
  assert.equal(over.deposits[0].approved_at, undefined);
  assert.equal(over.deposits[0].last_status_payload._auto_approve.skip_reason, 'over_max_amount');
});

test('auto-approve: blank ceiling, disabled, flagged and missing reference skip and stay pending_approval', async () => {
  const cases = [
    { name: 'blank ceiling', store: autoApproveStore({ maxCents: null }), reason: 'missing_auto_approve_ceiling' },
    { name: 'empty-string ceiling', store: autoApproveStore({ maxCents: '' }), reason: 'missing_auto_approve_ceiling' },
    { name: 'disabled', store: autoApproveStore({ enabled: false }), reason: 'auto_approve_disabled' },
    { name: 'exceptions', store: autoApproveStore({ payload: PROCESS_40(9001, { exceptions: ['possible duplicate'] }) }), reason: 'flagged_by_checkalt' },
    { name: 'warnings', store: autoApproveStore({ payload: PROCESS_40(9001, { warnings: ['x'] }) }), reason: 'flagged_by_checkalt' },
    { name: 'riskFactors', store: autoApproveStore({ payload: PROCESS_40(9001, { riskFactors: ['velocity'] }) }), reason: 'flagged_by_checkalt' },
    { name: 'errors', store: autoApproveStore({ payload: PROCESS_40(9001, { errors: ['e'] }) }), reason: 'flagged_by_checkalt' },
    { name: 'amountDiscrepancyDetected', store: autoApproveStore({ payload: PROCESS_40(9001, { amountDiscrepancyDetected: true }) }), reason: 'flagged_by_checkalt' },
    { name: 'statusDescription text', store: autoApproveStore({ payload: PROCESS_40(9001, { statusDescription: 'Pending Approval - Suspect Item' }) }), reason: 'flagged_by_checkalt' },
    { name: 'missing reference', store: autoApproveStore({ payload: { status: 40, statusDescription: 'Pending Approval' } }), reason: 'missing_reference' },
  ];
  for (const { name, store, reason } of cases) {
    const result = await submitOnce(store);
    assert.equal(result.status, 'pending_approval', name);
    assert.equal(result.auto_approve.attempted, false, name);
    assert.equal(result.auto_approve.approvePosted, false, name);
    assert.equal(result.auto_approve.skipReason, reason, name);
    assert.equal(store.processPosts, 1, name);
    assert.equal(store.approvePosts, 0, name);
    assert.equal(store.deposits[0].status, 'pending_approval', name);
    assert.equal(store.deposits[0].approved_at, undefined, name);
    assert.equal(store.deposits[0].last_status_payload._auto_approve.skip_reason, reason, name);
  }
});

test('auto-approve: process status other than 40 never calls approve', async () => {
  const store = autoApproveStore({ payload: { referenceNumber: 9008, status: 127, statusDescription: 'Approved' } });
  const result = await submitOnce(store);
  assert.equal(result.status, 'submitted');
  assert.equal(result.auto_approve, null);
  assert.equal(store.approvePosts, 0);
  assert.equal(store.autoApprovePersists || 0, 0);
});

test('auto-approve: replayed submit neither re-processes nor approves a second time', async () => {
  const store = autoApproveStore();
  const first = await submitOnce(store);
  assert.equal(first.status, 'submitted');
  assert.equal(store.approvePosts, 1);
  const replay = await submitOnce(store);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.replayed, true);
  assert.equal(store.processPosts, 1);
  assert.equal(store.approvePosts, 1);
  assert.equal(store.deposits.length, 1);

  // A row parked pending_approval (skipped or failed auto-approve) replays without an approve.
  const parked = autoApproveStore({ maxCents: null });
  await submitOnce(parked);
  parked.autoApproveMaxCents = 200000;
  const parkedReplay = await submitOnce(parked);
  assert.equal(parkedReplay.status, 'pending_approval');
  assert.equal(parked.processPosts, 1);
  assert.equal(parked.approvePosts, 0);
});

test('auto-approve: provider decline, HTTP error, network error and persist failure leave pending_approval', async () => {
  const declined = autoApproveStore();
  declined.approvePayload = { success: false, status: 40, statusDescription: 'Declined' };
  const declinedResult = await submitOnce(declined);
  assert.equal(declinedResult.status, 'pending_approval');
  assert.equal(declinedResult.auto_approve.approved, false);
  assert.equal(declinedResult.auto_approve.approvePosted, true);
  assert.equal(declinedResult.auto_approve.skipReason, 'provider_declined');
  assert.equal(declined.deposits[0].last_status_payload._auto_approve.skip_reason, 'provider_declined');
  assert.doesNotMatch(JSON.stringify(declined.deposits[0].last_status_payload), /Declined/);
  assert.equal(declined.approvePosts, 1);
  assert.equal(declined.deposits[0].approved_at, undefined);

  const http500 = autoApproveStore();
  http500.approveHttp = { ok: false, status: 500 };
  http500.approvePayload = { message: 'upstream' };
  const httpResult = await submitOnce(http500);
  assert.equal(httpResult.status, 'pending_approval');
  assert.equal(http500.approvePosts, 1);

  const network = autoApproveStore();
  network.approveThrow = Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' });
  const networkResult = await submitOnce(network);
  assert.equal(networkResult.statusCode, 200);
  assert.equal(networkResult.status, 'pending_approval');
  assert.equal(networkResult.checkalt_reference, '9001');
  assert.equal(networkResult.auto_approve.skipReason, 'auto_approve_error');
  assert.doesNotMatch(JSON.stringify(network.deposits[0].last_status_payload), /ECONNRESET/);
  assert.equal(network.approvePosts, 1);
  assert.equal(network.processPosts, 1);
  assert.equal(network.deposits[0].status, 'pending_approval');

  const markerFails = autoApproveStore();
  markerFails.autoApprovePersistFails = 1;
  const markerResult = await submitOnce(markerFails);
  assert.equal(markerResult.status, 'pending_approval');
  assert.equal(markerResult.auto_approve.skipReason, 'auto_approve_persist_failed');
  assert.equal(markerFails.approvePosts, 0);
});

test('auto-approve: lock 404 retries with backoff, then succeeds; exhausted lock stays pending', async () => {
  const lock = { http: { ok: false, status: 404 }, json: { message: 'Unable to locate transaction' } };
  const retried = autoApproveStore();
  retried.approveSequence = [lock, lock, { http: { ok: true, status: 200 }, json: { success: true, status: 127 } }];
  const retriedResult = await submitOnce(retried);
  assert.equal(retriedResult.status, 'submitted');
  assert.equal(retried.approvePosts, 3);
  assert.deepEqual(retried.sleeps, [1000, 2000]);
  assert.equal(retried.processPosts, 1);

  const exhausted = autoApproveStore();
  exhausted.approveSequence = [lock, lock, lock, lock, lock, lock];
  const exhaustedResult = await submitOnce(exhausted);
  assert.equal(exhaustedResult.status, 'pending_approval');
  assert.equal(exhaustedResult.auto_approve.skipReason, 'locked_exhausted');
  assert.equal(exhausted.approvePosts, 4);
  assert.deepEqual(exhausted.sleeps, [1000, 2000, 3000]);
  assert.equal(exhausted.processPosts, 1);
});

test('auto-approve never consults or mints the deposit.approve step-up', async () => {
  const store = autoApproveStore();
  await submitOnce(store);
  assert.equal(store.approvePosts, 1);
  assert.equal(store.stepups.some((row) => row.action_key === 'deposit.approve'), false);
  const src = fs.readFileSync(path.join(ROOT, 'aws/functions/api/providers/production/checkalt-submit.mjs'), 'utf8');
  assert.doesNotMatch(src, /CHECKALT_APPROVE_ACTION|deposit\.approve/);
});

test('auto-approve: risk description must be exactly Low Risk', async () => {
  const cases = [
    ['High Risk', PROCESS_40(9001, { riskRatingDescription: 'High Risk', riskRating: 9 })],
    ['Medium Risk', PROCESS_40(9001, { riskRatingDescription: 'Medium Risk', riskRating: 5 })],
    ['missing', (() => { const p = PROCESS_40(); delete p.riskRatingDescription; return p; })()],
    ['unknown', PROCESS_40(9001, { riskRatingDescription: 'Low Risk?' })],
    ['non-string', PROCESS_40(9001, { riskRatingDescription: 1 })],
  ];
  for (const [name, payload] of cases) {
    const store = autoApproveStore({ payload });
    const result = await submitOnce(store);
    assert.equal(result.status, 'pending_approval', name);
    assert.equal(result.auto_approve.skipReason, 'risk_not_low', name);
    assert.equal(store.approvePosts, 0, name);
    assert.equal(store.deposits[0].last_status_payload._auto_approve.skip_reason, 'risk_not_low', name);
  }
  const padded = autoApproveStore({ payload: PROCESS_40(9001, { riskRatingDescription: '  low risk ' }) });
  assert.equal((await submitOnce(padded)).status, 'submitted');
  assert.equal(padded.approvePosts, 1);
});

test('auto-approve: unsafe reference skips with invalid_reference and never posts approve', async () => {
  for (const reference of ['abc', '0', '-5', '12.5', '99999999999999999999']) {
    const store = autoApproveStore({ payload: PROCESS_40(reference) });
    const result = await submitOnce(store);
    assert.equal(result.status, 'pending_approval', reference);
    assert.equal(result.auto_approve.skipReason, 'invalid_reference', reference);
    assert.equal(store.approvePosts, 0, reference);
    assert.equal(store.processPosts, 1, reference);
  }
});

test('auto-approve: attempting marker is committed before the approve POST', async () => {
  const store = autoApproveStore();
  const result = await submitOnce(store);
  assert.equal(result.status, 'submitted');
  const log = store.txLog;
  const marker = log.indexOf('AUTO_APPROVE_PERSIST:attempting');
  const post = log.indexOf('APPROVE_POST');
  const outcome = log.indexOf('AUTO_APPROVE_PERSIST:outcome');
  assert.ok(marker >= 0 && post > marker && outcome > post, JSON.stringify(log));
  assert.ok(log.slice(marker + 1, post).includes('COMMIT'), JSON.stringify(log));
  assert.ok(log.slice(outcome + 1).includes('COMMIT'), JSON.stringify(log));
  assert.ok(store.approveSignals[0] instanceof AbortSignal);
  assert.match(store.autoApproveSql, /tenant_id = \$4::uuid/);
  assert.match(store.autoApproveSql, /\$2::boolean AND status = 'pending_approval'/);
});

test('auto-approve: approve succeeds but the outcome persist fails -> deposit pending with persistFailed', async () => {
  const store = autoApproveStore();
  store.autoApprovePersistFailPhase = 'outcome';
  const result = await submitOnce(store);
  assert.equal(result.statusCode, 200);
  assert.equal(store.approvePosts, 1);
  assert.equal(result.auto_approve.approved, true);
  assert.equal(result.auto_approve.persistFailed, true);
  assert.equal(result.status, 'pending_approval');
  assert.equal(result.deposit_id, DEPOSIT_ID);
  assert.equal(result.checkalt_reference, '9001');
  assert.equal(store.deposits[0].status, 'pending_approval');
  assert.equal(store.deposits[0].approved_at, undefined);
});

test('auto-approve: persist never approves a row that left pending_approval or another tenant row', async () => {
  const store = autoApproveStore();
  const otherId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  store.deposits.push({ id: otherId, tenant_id: C1C_TENANT, status: 'pending_approval' });
  const { persistAutoApproveOutcome } = await import('../functions/api/providers/production/checkalt-idempotency.mjs');
  const client = identityClient(store);
  const crossTenant = await persistAutoApproveOutcome(client, { rowId: otherId, tenantId: FREEDOM_TENANT, approved: true });
  assert.equal(crossTenant, null);
  assert.equal(store.deposits[0].status, 'pending_approval');
  assert.equal(store.deposits[0].approved_at, undefined);
  assert.equal(await persistAutoApproveOutcome(client, { rowId: otherId, tenantId: null, approved: true }), null);
  const row = store.deposits[0];
  row.tenant_id = FREEDOM_TENANT;
  row.status = 'rejected';
  const stale = await persistAutoApproveOutcome(client, { rowId: otherId, tenantId: FREEDOM_TENANT, approved: true });
  assert.equal(stale.status, 'rejected');
  assert.equal(stale.approved_at, undefined);
  const raw = await persistAutoApproveOutcome(client, {
    rowId: otherId, tenantId: FREEDOM_TENANT, skipReason: 'auto_approve_failed:Some Provider Text',
  });
  assert.equal(raw.last_status_payload._auto_approve.skip_reason, 'auto_approve_error');
});

test('auto-approve: hung approve request times out, stays pending and returns normally', async () => {
  const store = autoApproveStore();
  store.approveHang = true;
  const started = Date.now();
  const result = await submitOnce(store, {}, { deps: { autoApproveRequestTimeoutMs: 50 } });
  assert.ok(Date.now() - started < 3000);
  assert.equal(result.statusCode, 200);
  assert.equal(result.deposit_id, DEPOSIT_ID);
  assert.equal(result.checkalt_reference, '9001');
  assert.equal(result.status, 'pending_approval');
  assert.equal(result.auto_approve.skipReason, 'auto_approve_timeout');
  assert.equal(store.approvePosts, 1);
  assert.equal(store.processPosts, 1);
  assert.equal(store.deposits[0].last_status_payload._auto_approve.skip_reason, 'auto_approve_timeout');
});

test('auto-approve: deadline stops lock retries before the budget is spent', async () => {
  const lock = { http: { ok: false, status: 404 }, json: { message: 'Item locked' } };
  const store = autoApproveStore();
  store.clock = { t: 1_000_000 };
  store.approveSequence = [lock, lock, lock, lock];
  const result = await submitOnce(store, {}, {
    deps: { now: () => store.clock.t, autoApproveDeadlineMs: 3500 },
  });
  // POST at t0, sleep 1000, POST; next wait 2000 + 1000 minimum exceeds the remaining 2500 -> stop.
  assert.equal(store.approvePosts, 2);
  assert.deepEqual(store.sleeps, [1000]);
  assert.equal(result.statusCode, 200);
  assert.equal(result.status, 'pending_approval');
  assert.equal(result.auto_approve.skipReason, 'auto_approve_timeout');
});

test('auto-approve: deadline already spent skips without posting approve', async () => {
  const store = autoApproveStore();
  const result = await submitOnce(store, {}, { deps: { autoApproveDeadlineMs: 0 } });
  assert.equal(store.approvePosts, 0);
  assert.equal(result.status, 'pending_approval');
  assert.equal(result.auto_approve.skipReason, 'auto_approve_timeout');
});

test('auto-approve: injected Lambda remaining time tightens the deadline', async () => {
  const { autoApproveDeadline } = await import('../functions/api/providers/production/checkalt-submit.mjs');
  assert.equal(autoApproveDeadline({ startedAt: 0, now: () => 0 }), 20000);
  assert.equal(autoApproveDeadline({ startedAt: 0, now: () => 1000, deps: { getRemainingTimeInMillis: () => 10000 } }), 6000);
  assert.equal(autoApproveDeadline({ startedAt: 0, now: () => 0, deps: { getRemainingTimeInMillis: () => 60000 } }), 20000);
});

test('auto-approve: 401 from approve is auth_failed without retry', async () => {
  const store = autoApproveStore();
  store.approveHttp = { ok: false, status: 401 };
  store.approvePayload = { message: 'Unauthorized token xyz' };
  const result = await submitOnce(store);
  assert.equal(result.auto_approve.skipReason, 'auth_failed');
  assert.equal(store.approvePosts, 1);
  assert.equal(result.status, 'pending_approval');
});
