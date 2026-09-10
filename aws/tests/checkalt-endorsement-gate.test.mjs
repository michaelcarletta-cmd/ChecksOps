import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LOOKUP_MAPPING_SQL, TENANT_MEMBERSHIP_SQL } from '../functions/api/identity.mjs';
import { handleProviderRequest } from '../functions/api/providers.mjs';
import { pickBlockingDeposit } from '../functions/api/providers/production/checkalt-idempotency.mjs';
import {
  ERROR_CHECKALT_IMAGE_NONCOMPLIANT,
  ERROR_ENDORSEMENT_MISSING,
  ERROR_ENDORSEMENT_RELATIONSHIP_INVALID,
  ERROR_ENDORSEMENT_STATE_AMBIGUOUS,
  ERROR_ENDORSEMENTS_INCOMPLETE,
  ERROR_PROVIDER_FRONT_IMAGE_MISSING,
  ERROR_PROVIDER_REAR_IMAGE_MISSING,
  ERROR_PROVIDER_REAR_IMAGE_STALE,
  buildCompletedEndorsementState,
  endorsementStateFingerprint,
  evaluateEndorsementEligibility,
  evaluateOfficialImagePaths,
  evaluateProductionDepositEligibility,
} from '../functions/api/providers/production/checkalt-eligibility.mjs';
import { syntheticCompliantCheckAltJpeg } from '../functions/api/providers/production/checkalt-image-compliance.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(HERE, 'fixtures/pre-migration-endorsement-gate.json');
const FREEDOM_APP = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const FREEDOM_TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const C1C_TENANT = '4f172140-f57a-4744-8050-95f4f07b13b4';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const CHECK_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_CHECK_ID = '55555555-5555-4555-8555-555555555555';
const PAYEE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const PAYEE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const ENDO_A = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
const ENDO_B = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1';

const productionFlags = {
  AWS_PROVIDER_EXECUTION_ENABLED: 'true',
  AWS_CHECKALT_ENABLED: 'true',
  AWS_FINANCIAL_PERMISSIONS_ACTIVATED: 'true',
  AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: undefined,
  PROVIDER_SECRETS_ARN: 'arn:aws:secretsmanager:us-east-1:806168576068:secret:checksops/production/providers',
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

const jwtEvent = (body) => ({
  rawPath: '/functions/v1/checkalt-submit-deposit',
  headers: { authorization: 'Bearer test-id-token' },
  body: JSON.stringify(body),
  requestContext: {
    stage: 'staging',
    http: { method: 'POST', path: '/functions/v1/checkalt-submit-deposit' },
    authorizer: {
      jwt: { claims: { sub: COGNITO_SUB, email: 'owner@freedomadj.com', token_use: 'id' } },
    },
  },
});

const mapping = {
  application_user_id: FREEDOM_APP,
  cognito_sub: COGNITO_SUB,
  email: 'owner@freedomadj.com',
  status: 'active',
};

const jpeg = () => syntheticCompliantCheckAltJpeg();

const payee = (overrides = {}) => ({
  id: PAYEE_A,
  check_id: CHECK_ID,
  tenant_id: FREEDOM_TENANT,
  payee_type: 'insured',
  endorsement_status: 'signed',
  endorsed_at: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const endorsement = (overrides = {}) => ({
  id: ENDO_A,
  check_id: CHECK_ID,
  tenant_id: FREEDOM_TENANT,
  payee_id: PAYEE_A,
  payee_type: 'insured',
  status: 'signed',
  signed_at: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const createStore = ({ payees, endorsements, checkOverrides = {}, deposits = [] } = {}) => {
  const eligible = buildCompletedEndorsementState({
    checkId: CHECK_ID,
    tenantId: FREEDOM_TENANT,
    payees: [{ id: PAYEE_A, payee_type: 'insured' }],
    endorsements: [{ id: ENDO_A, payee_id: PAYEE_A }],
  });
  const resolvedPayees = payees === undefined ? eligible.payees : payees;
  const resolvedEnds = endorsements === undefined ? eligible.endorsements : endorsements;
  const fingerprint = endorsementStateFingerprint(CHECK_ID, resolvedPayees, resolvedEnds);
  return {
    check: {
      id: CHECK_ID,
      tenant_id: FREEDOM_TENANT,
      amount: 12.34,
      check_number: '1001',
      front_image_path: `checks/${CHECK_ID}/front.jpg`,
      back_image_path: `checks/${CHECK_ID}/back.jpg`,
      back_image_deposit_path: `checks/${CHECK_ID}/back.jpg`,
      status: 'endorsements_in_progress',
      check_stage: 'endorsing',
      endorsement_render_meta: { checkalt_rear_fingerprint: fingerprint },
      ...checkOverrides,
    },
    payees: resolvedPayees,
    endorsements: resolvedEnds,
    deposits: [...deposits],
    files: {
      [`checks/${CHECK_ID}/front.checkalt.jpg`]: jpeg(),
      [`checks/${CHECK_ID}/back.checkalt.jpg`]: jpeg(),
    },
    processPosts: 0,
    authenticatePosts: 0,
    stepups: [{
      id: 'step',
      user_id: FREEDOM_APP,
      tenant_id: FREEDOM_TENANT,
      action_key: 'deposit.submit',
      factor_type: 'totp',
      succeeded: true,
      metadata: { check_id: CHECK_ID, amount_cents: 1234 },
      created_at: new Date().toISOString(),
    }],
    memberships: [{ tenant_id: FREEDOM_TENANT, role: 'admin', tenant_name: 'Freedom', tenant_slug: 'freedom' }],
  };
};

const identityClient = (store) => ({
  connect: async () => {},
  end: async () => {},
  query: async (sql, params = []) => {
    const text = String(sql);
    if (text === 'BEGIN' || text === 'ROLLBACK' || text === 'COMMIT' || text === 'SET TRANSACTION READ WRITE'
      || text.startsWith('SAVEPOINT') || text.startsWith('RELEASE') || text.startsWith('ROLLBACK TO')) {
      return { rows: [] };
    }
    if (text.startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
    if (text === LOOKUP_MAPPING_SQL) return { rows: [mapping] };
    if (text === TENANT_MEMBERSHIP_SQL || text.includes('FROM public.tenant_users tu')) {
      return { rows: store.memberships };
    }
    if (text.includes('FROM public.user_roles') || (text.includes('FROM public.tenant_users WHERE user_id') && text.includes('AND tenant_id'))) {
      return { rows: [{ role: 'admin' }] };
    }
    if (text.includes('FROM public.check_payees')) return { rows: store.payees };
    if (text.includes('FROM public.check_endorsements')) return { rows: store.endorsements };
    if (text.includes('FROM public.check_intake_items')) return { rows: [store.check] };
    if (text.includes('aws_checkalt_production_config') || text.includes('FROM public.checkalt_config')) {
      return { rows: [{ merchant: 'prod-merchant', fi_key: 'fi', base_url: 'https://api2.checkalt.com', default_enabled: true }] };
    }
    if (text.includes('FROM public.checkalt_tenant_accounts')) {
      return { rows: [{ tenant_id: FREEDOM_TENANT, enabled: true, sso_user_id: 'dep', deposit_account_number: '1234567890', last_register_payload: { sso_key: 'sso' } }] };
    }
    if (text.includes('FROM public.financial_stepup_log')) return { rows: store.stepups };
    if (text.includes('INSERT INTO public.checkalt_deposits')) {
      const row = {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        check_intake_item_id: params[0],
        tenant_id: params[1],
        amount: params[2],
        amount_cents: params[3],
        status: 'queued',
        idempotency_key: params[5],
        checkalt_reference: null,
        provider_http_attempted_at: null,
      };
      store.deposits.push(row);
      return { rows: [row] };
    }
    if (text.includes('FROM public.checkalt_deposits')) {
      return {
        rows: store.deposits.filter((row) => (
          row.tenant_id === params[0] || row.id === params[0] || row.check_intake_item_id === params[1]
        )),
      };
    }
    if (text.includes('UPDATE public.checkalt_deposits') && text.includes('provider_http_attempted_at')) {
      const row = store.deposits[0];
      if (!row) return { rows: [] };
      row.provider_http_attempted_at = new Date().toISOString();
      row.status = 'submitting';
      return { rows: [row] };
    }
    if (text.includes('UPDATE public.checkalt_deposits')) {
      if (!store.deposits[0]) return { rows: [] };
      store.deposits[0].status = params[1];
      store.deposits[0].checkalt_reference = params[2];
      return { rows: [store.deposits[0]] };
    }
    return { rows: [] };
  },
});

const submit = (store, body = {}) => withEnv(productionFlags, () => handleProviderRequest(
  jwtEvent({ check_intake_item_id: CHECK_ID, ...body }),
  '/functions/v1/checkalt-submit-deposit',
  'POST',
  {
    createClient: () => identityClient(store),
    loadDatabaseCredentials: async () => ({ host: 'localhost', username: 'checksops', password: 'x', database: 'checksops' }),
    fetchImpl: async (url) => {
      const target = String(url);
      if (target.includes('/authenticate')) {
        store.authenticatePosts += 1;
        const token = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"exp":9999999999}').toString('base64url')}.sig`;
        return { ok: true, status: 200, text: async () => token };
      }
      if (target.includes('/deposit/process')) {
        store.processPosts += 1;
        return { ok: true, status: 200, text: async () => JSON.stringify({ referenceNumber: 1, status: 127 }) };
      }
      if (target.includes('/deposit/history') || target.includes('/deposit/item') || target.includes('getUserAccountInformation')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ depositHistoryList: [], accountDataList: [{ accountNumber: '1234567890', ssoKey: 'sso' }] }) };
      }
      return { ok: false, status: 404, text: async () => 'no' };
    },
    loadProductionSecrets: async () => ({
      ok: true,
      credentials: {
        environment: 'production',
        username: 'u',
        password: 'p',
        fiKey: 'fi',
        baseUrl: 'https://api2.checkalt.com',
        webhookSecretConfigured: true,
      },
    }),
    downloadClaimFile: async (filePath) => store.files[filePath] || null,
  },
));

const assertNoProvider = (store, result, error) => {
  assert.equal(result.error, error);
  assert.equal(result.liveProviderCalled, false);
  assert.equal(store.processPosts, 0);
  assert.equal(store.authenticatePosts, 0);
  assert.equal(store.deposits.length, 0);
  assert.equal(store.deposits.some((row) => row.provider_http_attempted_at), false);
};

test('A. zero payee records where payees are required never calls provider HTTP', async () => {
  const store = createStore({ payees: [], endorsements: [] });
  const result = await submit(store);
  assertNoProvider(store, result, ERROR_ENDORSEMENTS_INCOMPLETE);
});

test('B. one required payee unsigned never calls provider HTTP', async () => {
  const store = createStore({
    payees: [payee({ endorsement_status: 'pending', endorsed_at: null })],
    endorsements: [endorsement({ status: 'pending', signed_at: null })],
  });
  const result = await submit(store);
  assertNoProvider(store, result, ERROR_ENDORSEMENTS_INCOMPLETE);
});

test('C. multiple payees with one unsigned never calls provider HTTP', async () => {
  const store = createStore({
    payees: [
      payee(),
      payee({ id: PAYEE_B, endorsement_status: 'pending', endorsed_at: null }),
    ],
    endorsements: [
      endorsement(),
      endorsement({ id: ENDO_B, payee_id: PAYEE_B, status: 'pending', signed_at: null }),
    ],
  });
  const result = await submit(store);
  assertNoProvider(store, result, ERROR_ENDORSEMENTS_INCOMPLETE);
});

test('D. missing endorsement record never calls provider HTTP', async () => {
  const store = createStore({
    payees: [payee()],
    endorsements: [],
  });
  const result = await submit(store);
  assertNoProvider(store, result, ERROR_ENDORSEMENT_MISSING);
});

test('E. endorsement belongs to wrong payee never calls provider HTTP', async () => {
  const store = createStore({
    payees: [payee()],
    endorsements: [endorsement({ payee_id: PAYEE_B })],
  });
  const result = await submit(store);
  assertNoProvider(store, result, ERROR_ENDORSEMENT_RELATIONSHIP_INVALID);
});

test('F. endorsement belongs to wrong check never calls provider HTTP', async () => {
  const store = createStore({
    payees: [payee()],
    endorsements: [endorsement({ check_id: OTHER_CHECK_ID })],
  });
  const result = await submit(store);
  assertNoProvider(store, result, ERROR_ENDORSEMENT_RELATIONSHIP_INVALID);
});

test('G. cross-tenant payee/endorsement relationship never calls provider HTTP', async () => {
  const store = createStore({
    payees: [payee({ tenant_id: C1C_TENANT })],
    endorsements: [endorsement({ tenant_id: C1C_TENANT })],
  });
  const result = await submit(store);
  assertNoProvider(store, result, ERROR_ENDORSEMENT_RELATIONSHIP_INVALID);
});

test('H. ambiguous duplicate endorsement state never calls provider HTTP', async () => {
  const store = createStore({
    payees: [payee()],
    endorsements: [
      endorsement(),
      endorsement({ id: ENDO_B, status: 'pending', signed_at: null }),
    ],
  });
  const result = await submit(store);
  assertNoProvider(store, result, ERROR_ENDORSEMENT_STATE_AMBIGUOUS);
});

test('I. front official artifact missing never calls provider HTTP', async () => {
  const store = createStore({ checkOverrides: { front_image_path: null } });
  const result = await submit(store);
  assertNoProvider(store, result, ERROR_PROVIDER_FRONT_IMAGE_MISSING);
});

test('J. rear official artifact missing never calls provider HTTP', async () => {
  const store = createStore({ checkOverrides: { back_image_deposit_path: null } });
  const result = await submit(store);
  assertNoProvider(store, result, ERROR_PROVIDER_REAR_IMAGE_MISSING);
});

test('K. rear official artifact stale after signature/payee change never calls provider HTTP', async () => {
  const before = createStore();
  const afterPayees = [payee({ endorsed_at: '2026-06-01T00:00:00.000Z' })];
  const afterEnds = [endorsement({ signed_at: '2026-06-01T00:00:00.000Z' })];
  const store = createStore({
    payees: afterPayees,
    endorsements: afterEnds,
    checkOverrides: {
      endorsement_render_meta: before.check.endorsement_render_meta,
    },
  });
  assert.notEqual(
    endorsementStateFingerprint(CHECK_ID, afterPayees, afterEnds),
    before.check.endorsement_render_meta.checkalt_rear_fingerprint,
  );
  const result = await submit(store);
  assertNoProvider(store, result, ERROR_PROVIDER_REAR_IMAGE_STALE);
});

test('L. noncompliant official image never calls provider HTTP', async () => {
  const store = createStore();
  store.files[`checks/${CHECK_ID}/front.checkalt.jpg`] = Buffer.from('not-a-jpeg');
  const result = await submit(store);
  assert.equal(result.error, ERROR_CHECKALT_IMAGE_NONCOMPLIANT);
  assert.equal(store.processPosts, 0);
  assert.equal(store.authenticatePosts, 0);
  assert.equal(store.deposits.length, 0);
});

test('M. existing CheckAlt reference refuses a new process POST', async () => {
  const store = createStore({
    payees: [],
    deposits: [{
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      tenant_id: FREEDOM_TENANT,
      check_intake_item_id: CHECK_ID,
      status: 'submitted',
      checkalt_reference: 'existing-reference',
      provider_http_attempted_at: '2026-01-01T00:00:00.000Z',
      last_status_payload: {},
    }],
  });
  const result = await submit(store);
  assert.equal(result.duplicate, true);
  assert.equal(result.replayed, true);
  assert.equal(result.error, undefined);
  assert.notEqual(result.error, ERROR_ENDORSEMENTS_INCOMPLETE);
  assert.equal(store.processPosts, 0);
  assert.equal(store.authenticatePosts, 0);
});

test('N. previous/uncertain provider attempt refuses a new process POST', async () => {
  const store = createStore({
    deposits: [{
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      tenant_id: FREEDOM_TENANT,
      check_intake_item_id: CHECK_ID,
      status: 'submitting',
      checkalt_reference: null,
      provider_http_attempted_at: '2026-01-01T00:00:00.000Z',
      last_status_payload: { provider_http_attempted: true },
    }],
  });
  const result = await submit(store);
  assert.equal(result.error, 'reconciliation_required');
  assert.equal(store.processPosts, 0);
  assert.equal(store.authenticatePosts, 0);
});

test('O. valid single-payee signed check passes eligibility', async () => {
  const store = createStore();
  const result = await submit(store, { signed: false, payee_count: 0, check_stage: 'review' });
  assert.equal(result.liveProviderCalled, true);
  assert.equal(store.processPosts, 1);
  assert.ok(store.deposits[0].provider_http_attempted_at);
});

test('P. valid multi-payee all-signed check passes eligibility', async () => {
  const payees = [payee(), payee({ id: PAYEE_B, payee_type: 'public_adjuster' })];
  const endorsements = [
    endorsement(),
    endorsement({ id: ENDO_B, payee_id: PAYEE_B, payee_type: 'public_adjuster' }),
  ];
  const store = createStore({ payees, endorsements });
  const result = await submit(store);
  assert.equal(result.liveProviderCalled, true, JSON.stringify(result));
  assert.equal(store.processPosts, 1);
});

test('Q/R. eligibility uses server-derived tenant/check/amount/images and ignores browser overrides', async () => {
  const store = createStore();
  const result = await submit(store, {
    tenant_id: FREEDOM_TENANT,
    amount: 0.01,
    signed: true,
    endorsement_status: 'signed',
    deposit_front_path: 'secrets/other.checkalt.jpg',
    deposit_back_path: `checks/${OTHER_CHECK_ID}/back.checkalt.jpg`,
    front_image_path: 'ignored.jpg',
  });
  assert.equal(result.statusCode, 400);
  assert.equal(result.error, 'untrusted_amount');
  assert.equal(store.processPosts, 0);

  const accepted = await submit(store, {
    tenant_id: FREEDOM_TENANT,
    signed: false,
    payees_signed: 0,
    deposit_front_path: 'secrets/other.checkalt.jpg',
    deposit_back_path: `checks/${OTHER_CHECK_ID}/back.checkalt.jpg`,
  });
  assert.equal(accepted.liveProviderCalled, true);
  assert.equal(accepted.userAmount, 1234);
  assert.equal(store.processPosts, 1);
});

test('S. eligibility failure occurs before provider_http_attempted_at', async () => {
  const store = createStore({ payees: [], endorsements: [] });
  const result = await submit(store);
  assert.equal(result.error, ERROR_ENDORSEMENTS_INCOMPLETE);
  assert.equal(store.deposits.length, 0);
  assert.equal(store.processPosts, 0);
});

test('Ready stage and approved_for_deposit do not satisfy the signature gate', () => {
  const check = {
    id: CHECK_ID,
    tenant_id: FREEDOM_TENANT,
    status: 'approved_for_deposit',
    check_stage: 'ready_for_deposit',
  };
  const result = evaluateEndorsementEligibility(check, [payee({ endorsement_status: 'pending' })], [
    endorsement({ status: 'pending', signed_at: null }),
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.error, ERROR_ENDORSEMENTS_INCOMPLETE);
});

test('endorsement row is the signature source of truth when payee status lags', () => {
  const check = { id: CHECK_ID, tenant_id: FREEDOM_TENANT };
  const result = evaluateEndorsementEligibility(
    check,
    [payee({ endorsement_status: 'pending', endorsed_at: null, payee_type: 'mortgage_company' })],
    [endorsement({ status: 'waived', signed_at: null, payee_type: 'mortgage_company' })],
  );
  assert.equal(result.ok, true);
});

test('migrated Endorsing checks with unsigned required payees are refused', () => {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  assert.equal(fixture.endorsing_unsigned_required.length, 20);
  const errors = [];
  for (const row of fixture.endorsing_unsigned_required) {
    const result = evaluateEndorsementEligibility(row.check, row.payees, row.endorsements);
    if (result.ok) errors.push(row.check.id);
    assert.equal(result.ok, false);
    assert.ok([
      ERROR_ENDORSEMENTS_INCOMPLETE,
      ERROR_ENDORSEMENT_MISSING,
      ERROR_ENDORSEMENT_STATE_AMBIGUOUS,
      ERROR_ENDORSEMENT_RELATIONSHIP_INVALID,
    ].includes(result.error), result.error);
  }
  assert.equal(errors.length, 0);
});

test('migrated Ready-awaiting checks pass signature gate and fail official image gate', () => {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  assert.equal(fixture.ready_awaiting_signed_no_official_checkalt.length, 2);
  for (const row of fixture.ready_awaiting_signed_no_official_checkalt) {
    const signed = evaluateEndorsementEligibility(row.check, row.payees, row.endorsements);
    assert.equal(signed.ok, true, row.check.id);
    const images = evaluateOfficialImagePaths({
      ...row.check,
      front_image_path: null,
      back_image_deposit_path: null,
    });
    assert.equal(images.ok, false);
    assert.ok([
      ERROR_PROVIDER_FRONT_IMAGE_MISSING,
      ERROR_PROVIDER_REAR_IMAGE_MISSING,
    ].includes(images.error));
    const full = evaluateProductionDepositEligibility({
      check: {
        ...row.check,
        front_image_path: null,
        back_image_deposit_path: null,
      },
      payees: row.payees,
      endorsements: row.endorsements,
    });
    assert.equal(full.ok, false);
    assert.notEqual(full.error, ERROR_ENDORSEMENTS_INCOMPLETE);
  }
});

test('migrated deposited CheckAlt controls are not eligible for a second process POST', () => {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  assert.equal(fixture.deposited_checkalt_controls.length, 52);
  for (const row of fixture.deposited_checkalt_controls) {
    assert.equal(row.check.has_checkalt_reference, true);
    const blocking = pickBlockingDeposit([row.blocking_deposit]);
    assert.ok(blocking);
    assert.equal(blocking.checkalt_reference, 'existing-reference');
  }
});
