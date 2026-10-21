import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LOOKUP_MAPPING_SQL, TENANT_MEMBERSHIP_SQL } from '../functions/api/identity.mjs';
import {
  endorsementStateFingerprint,
  ERROR_PROVIDER_REAR_IMAGE_STALE,
  evaluateExistingOfficialRearCorrespondence,
} from '../functions/api/providers/production/checkalt-eligibility.mjs';
import {
  evaluateCheckAltDepositPreflight,
  handleCheckAltDepositPreflight,
} from '../functions/api/providers/production/checkalt-preflight.mjs';
import { syntheticCompliantCheckAltJpeg } from '../functions/api/providers/production/checkalt-image-compliance.mjs';

const CHECK_ID = '623442f0-a408-4db5-85be-14bae231a722';
const OTHER_CHECK = '55555555-5555-4555-8555-555555555555';
const TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const OTHER_TENANT = '4f172140-f57a-4744-8050-95f4f07b13b4';
const USER = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const OUTSIDER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const OUTSIDER_SUB = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CLAIM_FOLDER = '7dbb3009-f059-4767-b5dc-1c5c72379330';
const PAYEE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const ENDO = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
const SIGNED_AT = '2026-01-01T00:00:00.000Z';
const RENDER_MS = Date.parse('2026-01-15T12:00:00.000Z');

const jpeg = () => syntheticCompliantCheckAltJpeg();
const mapping = {
  application_user_id: USER,
  cognito_sub: COGNITO_SUB,
  email: 'admin@freedomadj.com',
  status: 'active',
};
const outsiderMapping = {
  application_user_id: OUTSIDER,
  cognito_sub: OUTSIDER_SUB,
  email: 'c1c@example.com',
  status: 'active',
};

const payee = (o = {}) => ({
  id: PAYEE,
  check_id: CHECK_ID,
  tenant_id: TENANT,
  payee_type: 'insured',
  endorsement_status: 'signed',
  endorsed_at: SIGNED_AT,
  ...o,
});
const endorsement = (o = {}) => ({
  id: ENDO,
  check_id: CHECK_ID,
  tenant_id: TENANT,
  payee_id: PAYEE,
  payee_type: 'insured',
  status: 'signed',
  signed_at: SIGNED_AT,
  ...o,
});

const migratedPaths = () => ({
  front_image_path: `checks/${CLAIM_FOLDER}/unclaimed/1788459141955_front_IMG_1183_cropped.jpg`,
  back_image_path: `checks/${CLAIM_FOLDER}/unclaimed/endorsed_deposit_18vd.checkalt.jpg`,
  back_image_deposit_path: `checks/${CLAIM_FOLDER}/unclaimed/endorsed_deposit_18vd.checkalt.jpg`,
});

const canvasMeta = (bytes, extra = {}) => ({
  bytes,
  width: 1920,
  height: 1080,
  mime_type: 'image/jpeg',
  renderer_version: 'canvas-v2',
  request_id: `${CHECK_ID}-${RENDER_MS}`,
  ...extra,
});

function fixtureClient({
  check,
  payees,
  endorsements,
  memberships = [{ tenant_id: TENANT, role: 'admin' }],
  mappingRow = mapping,
  deposits = [],
} = {}) {
  const state = {
    check: { ...check },
    updates: [],
    commits: 0,
    rollbacks: 0,
    providerHttp: [],
  };
  const client = {
    state,
    connect: async () => {},
    end: async () => {},
    query: async (sql, params = []) => {
      const text = String(sql);
      if (text === 'BEGIN' || text === 'SET TRANSACTION READ WRITE') return { rows: [] };
      if (text === 'COMMIT') {
        state.commits += 1;
        return { rows: [] };
      }
      if (text === 'ROLLBACK') {
        state.rollbacks += 1;
        return { rows: [] };
      }
      if (text.startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
      if (text === LOOKUP_MAPPING_SQL) {
        return { rows: params[0] === mappingRow.cognito_sub ? [mappingRow] : [] };
      }
      if (text === TENANT_MEMBERSHIP_SQL || text.includes('FROM public.tenant_users tu')) {
        return { rows: memberships };
      }
      if (text.includes('FROM public.tenant_users') && text.includes('SELECT 1')) {
        return { rows: memberships.some((row) => row.tenant_id === params[1]) ? [{ '?column?': 1 }] : [] };
      }
      if (text.includes('FROM public.check_payees')) return { rows: payees };
      if (text.includes('FROM public.check_endorsements')) return { rows: endorsements };
      if (text.includes('FROM public.checkalt_deposits')) return { rows: deposits };
      if (text.includes('UPDATE') && text.includes('endorsement_render_meta')) {
        const next = {
          ...(typeof state.check.endorsement_render_meta === 'object'
            ? state.check.endorsement_render_meta
            : {}),
          checkalt_rear_fingerprint: params[2],
        };
        state.check = { ...state.check, endorsement_render_meta: next };
        state.updates.push({ checkId: params[0], tenantId: params[3], fingerprint: params[2] });
        return { rows: [] };
      }
      if (text.includes('FROM public.check_intake_items')) {
        if (params[0] && params[0] !== state.check.id) return { rows: [] };
        return { rows: [{ ...state.check }] };
      }
      return { rows: [] };
    },
  };
  return client;
}

const jwtEvent = (checkId, sub = COGNITO_SUB) => ({
  rawPath: '/functions/v1/checkalt-deposit-preflight',
  headers: { authorization: 'Bearer test-id-token' },
  body: JSON.stringify({ check_intake_item_id: checkId }),
  requestContext: {
    stage: 'production-prep',
    http: { method: 'POST', path: '/functions/v1/checkalt-deposit-preflight' },
    authorizer: { jwt: { claims: { sub, email: 'admin@freedomadj.com', token_use: 'id' } } },
  },
});

const handlerDeps = (client, bytes) => ({
  loadDatabaseCredentials: async () => ({
    username: 'checksops',
    password: 'unit-test-only-not-a-real-secret',
    host: 'db.example.internal',
    database: 'checksops',
  }),
  createClient: () => client,
  downloadClaimFile: async () => bytes,
  s3: {
    send: async (command) => {
      client.state.providerHttp.push(command.constructor?.name || 's3');
      throw new Error('S3 mutation is not allowed in rear-rebind fixture');
    },
  },
});

test('captured #9562 canvas-v2 meta is bindable when signatures predate the 2026-09-10 render', () => {
  const check = {
    id: CHECK_ID,
    tenant_id: TENANT,
    ...migratedPaths(),
    endorsement_render_meta: {
      bytes: 247060,
      width: 1920,
      height: 1080,
      mime_type: 'image/jpeg',
      renderer_version: 'canvas-v2',
      request_id: '623442f0-a408-4db5-85be-14bae231a722-1789064056063',
    },
  };
  const result = evaluateExistingOfficialRearCorrespondence(
    check,
    [payee()],
    [endorsement()],
    { rearPath: check.back_image_deposit_path, rearBytes: 247060 },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.renderedAt, 1789064056063);
});

test('migrated claim-folder official rear with canvas provenance is eligible to bind', () => {
  const bytes = jpeg();
  const check = {
    id: CHECK_ID,
    tenant_id: TENANT,
    ...migratedPaths(),
    endorsement_render_meta: canvasMeta(bytes.length),
  };
  const result = evaluateExistingOfficialRearCorrespondence(
    check,
    [payee()],
    [endorsement()],
    { rearPath: check.back_image_deposit_path, rearBytes: bytes.length },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
});

test('stale endorsement signed after render is not falsely stamped', () => {
  const bytes = jpeg();
  const check = {
    id: CHECK_ID,
    tenant_id: TENANT,
    ...migratedPaths(),
    endorsement_render_meta: canvasMeta(bytes.length),
  };
  const result = evaluateExistingOfficialRearCorrespondence(
    check,
    [payee({ endorsed_at: '2026-02-01T00:00:00.000Z' })],
    [endorsement({ signed_at: '2026-02-01T00:00:00.000Z' })],
    { rearPath: check.back_image_deposit_path, rearBytes: bytes.length },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'rear_fingerprint_mismatch');
});

test('preflight binds a compliant migrated rear without rewriting S3 or calling CheckAlt', async () => {
  const bytes = jpeg();
  const payees = [payee()];
  const endorsements = [endorsement()];
  const expected = endorsementStateFingerprint(CHECK_ID, payees, endorsements);
  const client = fixtureClient({
    check: {
      id: CHECK_ID,
      tenant_id: TENANT,
      amount: 9984.11,
      check_number: '9562-fixture',
      ...migratedPaths(),
      endorsement_render_meta: canvasMeta(bytes.length),
    },
    payees,
    endorsements,
  });
  const first = await evaluateCheckAltDepositPreflight({
    client,
    mapping,
    checkId: CHECK_ID,
    spoof: {},
    deps: { downloadClaimFile: async () => bytes },
  });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.readyForVerification, true);
  assert.equal(first.needRearPrep, false);
  assert.equal(first.rearRebound, true);
  assert.equal(first.liveProviderCalled, false);
  assert.equal(first.providerHttpAttempted, false);
  assert.equal(client.state.updates.length, 1);
  assert.equal(client.state.updates[0].checkId, CHECK_ID);
  assert.equal(client.state.updates[0].fingerprint, expected);
  assert.equal(client.state.check.endorsement_render_meta.checkalt_rear_fingerprint, expected);

  const second = await evaluateCheckAltDepositPreflight({
    client,
    mapping,
    checkId: CHECK_ID,
    spoof: {},
    deps: { downloadClaimFile: async () => bytes },
  });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.rearRebound, false);
  assert.equal(second.needRearPrep, false);
  assert.equal(client.state.updates.length, 1);
});

test('write-capable preflight handler COMMITs the fingerprint and never PUTs S3 or process', async () => {
  const bytes = jpeg();
  const payees = [payee()];
  const endorsements = [endorsement()];
  const expected = endorsementStateFingerprint(CHECK_ID, payees, endorsements);
  const client = fixtureClient({
    check: {
      id: CHECK_ID,
      tenant_id: TENANT,
      amount: 9984.11,
      ...migratedPaths(),
      endorsement_render_meta: canvasMeta(bytes.length),
    },
    payees,
    endorsements,
  });
  const result = await handleCheckAltDepositPreflight(jwtEvent(CHECK_ID), handlerDeps(client, bytes));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.rearRebound, true);
  assert.equal(client.state.commits, 1);
  assert.equal(client.state.updates[0].fingerprint, expected);
  assert.equal(client.state.providerHttp.length, 0);
  assert.equal(JSON.stringify(result).includes('/fincapture/deposit/process'), false);
});

test('mismatched stored fingerprint is not overwritten on existing-image bind', async () => {
  const bytes = jpeg();
  const client = fixtureClient({
    check: {
      id: CHECK_ID,
      tenant_id: TENANT,
      ...migratedPaths(),
      endorsement_render_meta: canvasMeta(bytes.length, {
        checkalt_rear_fingerprint: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      }),
    },
    payees: [payee()],
    endorsements: [endorsement()],
  });
  const result = await evaluateCheckAltDepositPreflight({
    client,
    mapping,
    checkId: CHECK_ID,
    spoof: {},
    deps: { downloadClaimFile: async () => bytes },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, ERROR_PROVIDER_REAR_IMAGE_STALE);
  assert.equal(result.needRearPrep, true);
  assert.equal(client.state.updates.length, 0);
});

test('arbitrary JPEG without canvas provenance is not blindly stamped', async () => {
  const bytes = jpeg();
  const client = fixtureClient({
    check: {
      id: CHECK_ID,
      tenant_id: TENANT,
      ...migratedPaths(),
      endorsement_render_meta: { bytes: bytes.length },
    },
    payees: [payee()],
    endorsements: [endorsement()],
  });
  const result = await evaluateCheckAltDepositPreflight({
    client,
    mapping,
    checkId: CHECK_ID,
    spoof: {},
    deps: { downloadClaimFile: async () => bytes },
  });
  assert.equal(result.ok, false);
  assert.equal(result.needRearPrep, true);
  assert.equal(client.state.updates.length, 0);
});

test('cross-tenant caller cannot rebind another tenant check', async () => {
  const bytes = jpeg();
  const client = fixtureClient({
    check: {
      id: CHECK_ID,
      tenant_id: TENANT,
      ...migratedPaths(),
      endorsement_render_meta: canvasMeta(bytes.length),
    },
    payees: [payee()],
    endorsements: [endorsement()],
    mappingRow: outsiderMapping,
    memberships: [{ tenant_id: OTHER_TENANT, role: 'admin' }],
  });
  const result = await handleCheckAltDepositPreflight(
    jwtEvent(CHECK_ID, OUTSIDER_SUB),
    handlerDeps(client, bytes),
  );
  assert.equal(result.statusCode, 403);
  assert.equal(result.error, 'cross_tenant_denied');
  assert.equal(client.state.updates.length, 0);
  assert.equal(client.state.commits, 0);
});

test('preflight for check A cannot stamp using check B image columns', async () => {
  const bytes = jpeg();
  const client = fixtureClient({
    check: {
      id: OTHER_CHECK,
      tenant_id: TENANT,
      front_image_path: `checks/${OTHER_CHECK}/front.jpg`,
      back_image_deposit_path: `checks/${OTHER_CHECK}/back.jpg`,
      endorsement_render_meta: canvasMeta(bytes.length, {
        request_id: `${OTHER_CHECK}-${RENDER_MS}`,
      }),
    },
    payees: [payee({ check_id: OTHER_CHECK })],
    endorsements: [endorsement({ check_id: OTHER_CHECK })],
  });
  const result = await evaluateCheckAltDepositPreflight({
    client,
    mapping,
    checkId: CHECK_ID,
    spoof: {},
    deps: { downloadClaimFile: async () => bytes },
  });
  assert.equal(result.statusCode, 404);
  assert.equal(client.state.updates.length, 0);
});
