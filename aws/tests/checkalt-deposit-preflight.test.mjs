import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLASS_A_FUNCTIONS } from '../functions/api/app-services.mjs';
import {
  endorsementStateFingerprint,
  ERROR_ENDORSEMENTS_INCOMPLETE,
  ERROR_PROVIDER_FRONT_IMAGE_MISSING,
  ERROR_PROVIDER_REAR_IMAGE_STALE,
} from '../functions/api/providers/production/checkalt-eligibility.mjs';
import { evaluateCheckAltDepositPreflight } from '../functions/api/providers/production/checkalt-preflight.mjs';
import { syntheticCompliantCheckAltJpeg } from '../functions/api/providers/production/checkalt-image-compliance.mjs';
import { LOOKUP_MAPPING_SQL, TENANT_MEMBERSHIP_SQL } from '../functions/api/identity.mjs';

const CHECK_ID = '44444444-4444-4444-8444-444444444444';
const TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const USER = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const PAYEE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const ENDO = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';

const mapping = { application_user_id: USER, cognito_sub: 'sub', email: 'o@freedomadj.com', status: 'active' };

const payee = (o = {}) => ({
  id: PAYEE, check_id: CHECK_ID, tenant_id: TENANT, payee_type: 'insured',
  endorsement_status: 'signed', endorsed_at: '2026-01-01T00:00:00.000Z', ...o,
});
const endorsement = (o = {}) => ({
  id: ENDO, check_id: CHECK_ID, tenant_id: TENANT, payee_id: PAYEE, payee_type: 'insured',
  status: 'signed', signed_at: '2026-01-01T00:00:00.000Z', ...o,
});

const mockClient = ({ check, payees, endorsements, deposits = [] }) => ({
  query: async (sql) => {
    const text = String(sql);
    if (text === LOOKUP_MAPPING_SQL) return { rows: [mapping] };
    if (text === TENANT_MEMBERSHIP_SQL || text.includes('FROM public.tenant_users tu')) {
      return { rows: [{ tenant_id: TENANT, role: 'admin' }] };
    }
    if (text.includes('FROM public.check_payees')) return { rows: payees };
    if (text.includes('FROM public.check_endorsements')) return { rows: endorsements };
    if (text.includes('FROM public.check_intake_items')) return { rows: [check] };
    if (text.includes('FROM public.checkalt_deposits')) return { rows: deposits };
    return { rows: [] };
  },
});

const jpeg = () => syntheticCompliantCheckAltJpeg();

test('class A registry includes checkalt-deposit-preflight and it is not a money path', () => {
  assert.equal(CLASS_A_FUNCTIONS.has('checkalt-deposit-preflight'), true);
  assert.equal(CLASS_A_FUNCTIONS.has('checkalt-submit-deposit'), false);
});

test('unsigned payee fails before verification and never sets provider HTTP', async () => {
  const payees = [payee({ endorsement_status: 'pending' })];
  const ends = [endorsement({ status: 'pending' })];
  const fingerprint = endorsementStateFingerprint(CHECK_ID, payees, ends);
  const result = await evaluateCheckAltDepositPreflight({
    client: mockClient({
      check: {
        id: CHECK_ID,
        tenant_id: TENANT,
        amount: 12.34,
        front_image_path: `checks/${CHECK_ID}/front.jpg`,
        back_image_deposit_path: `checks/${CHECK_ID}/back.jpg`,
        endorsement_render_meta: { checkalt_rear_fingerprint: fingerprint },
      },
      payees,
      endorsements: ends,
    }),
    mapping,
    checkId: CHECK_ID,
    spoof: {},
    deps: { downloadClaimFile: async () => jpeg() },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, ERROR_ENDORSEMENTS_INCOMPLETE);
  assert.equal(result.readyForVerification, false);
  assert.equal(result.liveProviderCalled, false);
  assert.equal(result.providerHttpAttempted, false);
  assert.equal(result.attention, 'endorsement');
});

test('missing official front asks for automatic prep without provider HTTP', async () => {
  const payees = [payee()];
  const ends = [endorsement()];
  const result = await evaluateCheckAltDepositPreflight({
    client: mockClient({
      check: {
        id: CHECK_ID,
        tenant_id: TENANT,
        amount: 12.34,
        front_image_path: null,
        back_image_deposit_path: `checks/${CHECK_ID}/back.jpg`,
        endorsement_render_meta: { checkalt_rear_fingerprint: endorsementStateFingerprint(CHECK_ID, payees, ends) },
      },
      payees,
      endorsements: ends,
    }),
    mapping,
    checkId: CHECK_ID,
    spoof: {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, ERROR_PROVIDER_FRONT_IMAGE_MISSING);
  assert.equal(result.needFrontPrep, true);
  assert.equal(result.liveProviderCalled, false);
});

test('stale rear fingerprint requests rear rebind without provider HTTP', async () => {
  const payees = [payee()];
  const ends = [endorsement()];
  const result = await evaluateCheckAltDepositPreflight({
    client: mockClient({
      check: {
        id: CHECK_ID,
        tenant_id: TENANT,
        amount: 12.34,
        front_image_path: `checks/${CHECK_ID}/front.jpg`,
        back_image_deposit_path: `checks/${CHECK_ID}/back.jpg`,
        endorsement_render_meta: { checkalt_rear_fingerprint: 'deadbeef' },
      },
      payees,
      endorsements: ends,
    }),
    mapping,
    checkId: CHECK_ID,
    spoof: {},
    deps: { downloadClaimFile: async () => jpeg() },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, ERROR_PROVIDER_REAR_IMAGE_STALE);
  assert.equal(result.needFrontPrep, false);
  assert.equal(result.needRearPrep, true);
  assert.equal(result.liveProviderCalled, false);
});

test('missing official S3 artifacts request both-side prep without provider HTTP', async () => {
  const payees = [payee()];
  const ends = [endorsement()];
  const result = await evaluateCheckAltDepositPreflight({
    client: mockClient({
      check: {
        id: CHECK_ID,
        tenant_id: TENANT,
        amount: 12.34,
        front_image_path: `checks/${CHECK_ID}/front.jpg`,
        back_image_deposit_path: `checks/${CHECK_ID}/back.jpg`,
        endorsement_render_meta: {},
      },
      payees,
      endorsements: ends,
    }),
    mapping,
    checkId: CHECK_ID,
    spoof: {},
    deps: { downloadClaimFile: async () => null },
  });
  assert.equal(result.ok, false);
  assert.equal(result.readyForVerification, false);
  assert.equal(result.needFrontPrep, true);
  assert.equal(result.needRearPrep, true);
  assert.equal(result.liveProviderCalled, false);
  assert.equal(result.providerHttpAttempted, false);
});

test('historical CheckAlt reference is ready for verification without a second process POST', async () => {
  const result = await evaluateCheckAltDepositPreflight({
    client: mockClient({
      check: { id: CHECK_ID, tenant_id: TENANT, amount: 12.34 },
      payees: [payee()],
      endorsements: [endorsement()],
      deposits: [{
        id: 'dep',
        status: 'submitted',
        checkalt_reference: 'HIST-1',
        provider_http_attempted_at: '2026-01-01T00:00:00.000Z',
      }],
    }),
    mapping,
    checkId: CHECK_ID,
    spoof: {},
  });
  assert.equal(result.ok, true);
  assert.equal(result.historicalReference, true);
  assert.equal(result.readyForVerification, false);
  assert.equal(result.liveProviderCalled, false);
});

test('compliant current images are ready for verification', async () => {
  const payees = [payee()];
  const ends = [endorsement()];
  const fingerprint = endorsementStateFingerprint(CHECK_ID, payees, ends);
  const result = await evaluateCheckAltDepositPreflight({
    client: mockClient({
      check: {
        id: CHECK_ID,
        tenant_id: TENANT,
        amount: 12.34,
        front_image_path: `checks/${CHECK_ID}/front.jpg`,
        back_image_deposit_path: `checks/${CHECK_ID}/back.jpg`,
        endorsement_render_meta: { checkalt_rear_fingerprint: fingerprint },
      },
      payees,
      endorsements: ends,
    }),
    mapping,
    checkId: CHECK_ID,
    spoof: {},
    deps: { downloadClaimFile: async () => jpeg() },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.readyForVerification, true);
  assert.equal(result.needFrontPrep, false);
  assert.equal(result.needRearPrep, false);
  assert.equal(result.liveProviderCalled, false);
});
