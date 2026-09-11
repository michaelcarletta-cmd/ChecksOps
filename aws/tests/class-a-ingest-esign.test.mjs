import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildIngestPlan,
  derivePartnerStatus,
  handleIngestSharedCheck,
  NATIVE_TENANT_MAP,
  normalizePayeeType,
} from '../functions/api/ingest-shared-check.mjs';
import { CLASS_A_FUNCTIONS, handleAppServiceRequest } from '../functions/api/app-services.mjs';
import { hashToken, replaceMergeFields, signBaseUrl } from '../functions/api/esign.mjs';
import { handleMfaSetPreference, MFA_AUTH_ROUTES } from '../functions/api/auth-mfa.mjs';
import { classifyNinthUuid, ninthExcludedFromInvite } from '../identity/ninth-uuid.mjs';

const eventOf = ({ headers = {}, body = {}, method = 'POST' } = {}) => ({
  headers,
  body: JSON.stringify(body),
  requestContext: { http: { method, path: '/functions/v1/ingest-shared-check' } },
});

test('class A registry includes remaining non-financial workflows', () => {
  for (const name of [
    'ingest-shared-check',
    'homeowner-ledger-attach-upload',
    'send-signature-request',
    'check-endorsement',
    'check-reconciliation',
    'send-payment-direction-request',
    'admin-reset-totp',
    'bill-mortgage-handling',
    'checkalt-deposit-preflight',
  ]) {
    assert.ok(CLASS_A_FUNCTIONS.has(name), name);
  }
  assert.ok(CLASS_A_FUNCTIONS.has('tenant-tax-profiles'));
  assert.ok(!CLASS_A_FUNCTIONS.has('moov-disburse'));
});

test('ingest plan uses partner amount and Freedom native pairing', () => {
  const plan = buildIngestPlan({
    source_check_id: '11111111-1111-4111-8111-111111111111',
    target_partner_code: 'abc',
    source_tenant_id: '22222222-2222-4222-8222-222222222222',
    source_partner_code: 'DF9CC985',
    check: { amount: 1250.5, carrier_name: 'ACME' },
    payees: [{ payee_name: 'Jane Doe', payee_type: 'homeowner' }],
  });
  assert.equal(plan.isNativePaired, true);
  assert.equal(plan.nativeTenantId, NATIVE_TENANT_MAP.DF9CC985);
  assert.equal(plan.amount, 1250.5);
  assert.equal(plan.cleanedPayees[0].payee_name, 'Jane Doe');
  assert.equal(normalizePayeeType('homeowner'), 'insured');
});

test('ingest ocr_only is rejected so SPA uses check-ocr-intake', () => {
  const plan = buildIngestPlan({ action: 'ocr_only', check_id: 'x' });
  assert.equal(plan.error, 'use_check_ocr_intake');
  assert.equal(plan.statusCode, 400);
});

test('ingest requires bridge secret', async () => {
  const prev = process.env.CROSS_APP_BRIDGE_SECRET;
  process.env.CROSS_APP_BRIDGE_SECRET = 'test-bridge-secret';
  const denied = await handleIngestSharedCheck(eventOf({ body: { source_check_id: 'x' } }));
  assert.equal(denied.statusCode, 401);
  const allowed = await handleIngestSharedCheck(eventOf({
    headers: { 'x-bridge-secret': 'test-bridge-secret' },
    body: {
      source_check_id: '11111111-1111-4111-8111-111111111111',
      target_partner_code: 'FREEDOM',
      source_tenant_id: '22222222-2222-4222-8222-222222222222',
      check: { amount: 10 },
    },
  }), {
    copyRemoteImageLocally: async () => null,
    persistIngest: async () => ({
      ok: true,
      statusCode: 200,
      check_id: '33333333-3333-4333-8333-333333333333',
      target_tenant_id: 't',
      source_tenant_id: 's',
    }),
    client: { query: async () => ({ rows: [] }), end: async () => {} },
  });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.check_id, '33333333-3333-4333-8333-333333333333');
  process.env.CROSS_APP_BRIDGE_SECRET = prev;
});

test('dispatcher routes ingest-shared-check before provider_disabled', async () => {
  const prev = process.env.CROSS_APP_BRIDGE_SECRET;
  process.env.CROSS_APP_BRIDGE_SECRET = 'secret';
  const result = await handleAppServiceRequest(
    eventOf({ headers: { 'x-bridge-secret': 'wrong' }, body: { source_check_id: 'x' } }),
    '/functions/v1/ingest-shared-check',
    'POST',
  );
  assert.equal(result.statusCode, 401);
  assert.notEqual(result.error, 'provider_disabled');
  process.env.CROSS_APP_BRIDGE_SECRET = prev;
});

test('e-sign adapter hashes tokens and stays on staging sign base', () => {
  const prev = process.env.SIGN_BASE_URL;
  delete process.env.SIGN_BASE_URL;
  assert.equal(signBaseUrl(), 'https://staging.checksops.com');
  const hash = hashToken('abc');
  assert.equal(hash.length, 64);
  const subject = replaceMergeFields('Sign {document.name}', { signer_name: 'A' }, { document_name: 'Release' }, 'https://staging.checksops.com/sign?token=x');
  assert.equal(subject, 'Sign Release');
  process.env.SIGN_BASE_URL = prev;
});

test('preferred MFA set-preference stays refused and money stays locked', async () => {
  const result = await handleMfaSetPreference();
  assert.equal(result.statusCode, 403);
  assert.equal(result.financialPermissionsActivated, false);
  assert.equal(result.moneyMovementUnlocked, false);
  assert.ok(MFA_AUTH_ROUTES['/auth/mfa/associate']);
  assert.ok(MFA_AUTH_ROUTES['/auth/mfa/verify']);
});

test('ninth UUID is not a live production user and is excluded from Cognito invite', () => {
  const ninth = classifyNinthUuid();
  assert.equal(ninth.classification, 'not_found');
  assert.equal(ninth.cognitoInvite, false);
  assert.equal(ninth.inventEmail, false);
  assert.equal(ninth.failClosed, true);
  assert.equal(ninthExcludedFromInvite(), true);
});

test('partner status mapping does not invent deposit execution', () => {
  const status = derivePartnerStatus({ check_stage: 'ready_for_deposit', status: 'approved_for_deposit' });
  assert.equal(status.partner_status, 'approved_for_deposit');
});
