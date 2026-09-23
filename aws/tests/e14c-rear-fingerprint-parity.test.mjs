import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LOOKUP_MAPPING_SQL } from '../functions/api/identity.mjs';
import { handleWrite } from '../functions/api/write.mjs';
import { intakeWriteShouldStampOfficialRear } from '../functions/api/write-check-workflow.mjs';
import {
  ERROR_PROVIDER_REAR_IMAGE_STALE,
  buildCompletedEndorsementState,
  endorsementStateFingerprint,
  evaluateProductionDepositEligibility,
} from '../functions/api/providers/production/checkalt-eligibility.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const CHECK_ID = 'a3a4a153-46e1-4c28-a273-79a9bd04f3a6';
const TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const APP_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const PAYEE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const PAYEE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const ENDO_A = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
const ENDO_B = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1';
const DEPOSIT = `checks/reupload/${CHECK_ID}/endorsed_deposit_9ffq.checkalt.jpg`;
const FRONT = `checks/reupload/${CHECK_ID}/front-1790116385272.jpg`;
const BACK = `checks/reupload/${CHECK_ID}/back-1790117338289.jpg`;

const jwtEvent = (values) => ({
  rawPath: '/data/write',
  headers: { authorization: 'Bearer test-id-token' },
  body: JSON.stringify({
    table: 'check_intake_items',
    op: 'update',
    values,
    filters: [{ column: 'id', op: 'eq', value: CHECK_ID }],
    single: true,
  }),
  requestContext: {
    stage: 'staging',
    http: { method: 'POST', path: '/data/write' },
    authorizer: { jwt: { claims: { sub: COGNITO_SUB, email: 'mcarletta@freedomadj.com', token_use: 'id' } } },
  },
});

const completed = () => buildCompletedEndorsementState({
  checkId: CHECK_ID,
  tenantId: TENANT,
  payees: [
    {
      id: PAYEE_A,
      payee_type: 'public_adjuster',
      endorsement_status: 'signed',
      endorsed_at: '2026-09-22T22:00:00.000Z',
    },
    {
      id: PAYEE_B,
      payee_type: 'insured',
      endorsement_status: 'signed',
      endorsed_at: '2026-09-22T22:00:00.000Z',
    },
  ],
  endorsements: [
    {
      id: ENDO_A,
      payee_id: PAYEE_A,
      payee_type: 'public_adjuster',
      status: 'signed',
      signed_at: '2026-09-22T22:00:00.000Z',
    },
    {
      id: ENDO_B,
      payee_id: PAYEE_B,
      payee_type: 'insured',
      status: 'signed',
      signed_at: '2026-09-22T22:00:00.000Z',
    },
  ],
});

const createStore = () => {
  const state = completed();
  const check = {
    id: CHECK_ID,
    tenant_id: TENANT,
    amount: 1546.72,
    check_number: '0121319295',
    front_image_path: FRONT,
    back_image_path: BACK,
    back_image_original_path: BACK,
    back_image_deposit_path: null,
    status: 'approved_for_deposit',
    check_stage: 'ready_for_deposit',
    endorsement_render_status: 'idle',
    endorsement_render_meta: null,
  };
  const queries = [];
  const client = {
    queries,
    connect: async () => {},
    end: async () => {},
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      const compact = String(sql).replace(/\s+/g, ' ');
      if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT' || sql === 'SET TRANSACTION READ WRITE') {
        return { rows: [] };
      }
      if (String(sql).startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
      if (sql === LOOKUP_MAPPING_SQL) {
        return {
          rows: [{
            application_user_id: APP_ID,
            cognito_sub: COGNITO_SUB,
            email: 'mcarletta@freedomadj.com',
            status: 'active',
          }],
        };
      }
      if (/SELECT id, tenant_id FROM public.check_intake_items/.test(sql)) {
        return { rows: [{ id: check.id, tenant_id: check.tenant_id }] };
      }
      if (compact.includes('FROM public.check_payees') && compact.includes('endorsement_status')) {
        return { rows: state.payees };
      }
      if (compact.includes('FROM public.check_endorsements') && compact.includes('payee_id')) {
        return { rows: state.endorsements };
      }
      if (compact.includes('UPDATE public.check_intake_items') && compact.includes('jsonb_build_object')) {
        check.endorsement_render_meta = {
          ...(check.endorsement_render_meta && typeof check.endorsement_render_meta === 'object'
            ? check.endorsement_render_meta
            : {}),
          [params[1]]: params[2],
        };
        return { rows: [check] };
      }
      if (compact.includes('UPDATE public.check_intake_items')) {
        if (compact.includes('back_image_deposit_path')) {
          const deposit = params.find((p) => typeof p === 'string' && String(p).includes('.checkalt.jpg'));
          if (deposit) check.back_image_deposit_path = deposit;
          else if (params.includes(null) && compact.includes('back_image_deposit_path')) {
            check.back_image_deposit_path = null;
          }
        }
        if (params.includes('completed')) check.endorsement_render_status = 'completed';
        if (params.includes('idle')) check.endorsement_render_status = 'idle';
        const meta = params.find((p) => p && typeof p === 'object' && !Array.isArray(p));
        if (meta) check.endorsement_render_meta = meta;
        if (params.includes(null) && compact.includes('endorsement_render_meta')) {
          check.endorsement_render_meta = null;
        }
        return { rows: [check] };
      }
      if (compact.includes('SELECT * FROM public.check_intake_items')) {
        return { rows: [check] };
      }
      if (compact.includes('UPDATE public.check_payees')) {
        const payee = state.payees.find((row) => row.id === params[0]);
        if (payee && compact.includes('endorsement_status')) {
          payee.endorsement_status = params[1];
          payee.endorsed_at = params[2] || payee.endorsed_at;
        }
        return { rows: payee ? [payee] : [{ id: params[0], endorsement_status: params[1] }], rowCount: 1 };
      }
      if (compact.includes('FROM public.check_endorsements') && compact.includes('payee_name')) {
        return { rows: state.endorsements };
      }
      if (compact.includes('SELECT status, payee_type FROM public.check_endorsements')) {
        return { rows: state.endorsements.map((row) => ({ status: row.status, payee_type: row.payee_type })) };
      }
      if (compact.includes('FROM public.check_intake_items') && compact.includes('deposit_recommendation')) {
        return { rows: [check] };
      }
      return { rows: [] };
    },
  };
  return { check, state, client };
};

const depsFor = (client) => ({
  forceEnabled: true,
  loadDatabaseCredentials: async () => ({
    username: 'checksops',
    password: 'unit-test-only-not-a-real-secret',
    host: 'db.example.internal',
    database: 'checksops',
  }),
  createClient: () => client,
});

test('browser Adjust Received Endorsement persist stamps official rear fingerprint', async () => {
  const store = createStore();
  const result = await handleWrite(jwtEvent({
    back_image_deposit_path: DEPOSIT,
    endorsement_render_status: 'completed',
    endorsement_render_meta: {
      request_id: 'browser-req',
      renderer_version: 'canvas-v2',
      mime_type: 'image/jpeg',
      width: 1920,
      height: 1080,
      bytes: 268289,
      checkalt_rear_fingerprint: 'client-spoofed-fingerprint',
    },
  }), depsFor(store.client));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(store.check.back_image_deposit_path, DEPOSIT);
  assert.equal(store.check.endorsement_render_meta.checkalt_rear_fingerprint, store.state.fingerprint);
  assert.notEqual(store.check.endorsement_render_meta.checkalt_rear_fingerprint, 'client-spoofed-fingerprint');
  const eligible = evaluateProductionDepositEligibility({
    check: {
      ...store.check,
      front_image_path: FRONT,
    },
    payees: store.state.payees,
    endorsements: store.state.endorsements,
  });
  assert.equal(eligible.ok, true, JSON.stringify(eligible));
  assert.equal(eligible.fingerprint, store.state.fingerprint);
  assert.equal(eligible.rearPath, DEPOSIT);
});

test('stale endorsed rear fails after endorsement state changes', async () => {
  const store = createStore();
  await handleWrite(jwtEvent({
    back_image_deposit_path: DEPOSIT,
    endorsement_render_status: 'completed',
    endorsement_render_meta: { request_id: 'browser-req', renderer_version: 'canvas-v2' },
  }), depsFor(store.client));
  const before = evaluateProductionDepositEligibility({
    check: store.check,
    payees: store.state.payees,
    endorsements: store.state.endorsements,
  });
  assert.equal(before.ok, true);

  store.state.endorsements = store.state.endorsements.map((row) => (
    row.id === ENDO_B
      ? { ...row, signed_at: '2026-09-22T23:00:00.000Z' }
      : row
  ));
  const after = evaluateProductionDepositEligibility({
    check: store.check,
    payees: store.state.payees,
    endorsements: store.state.endorsements,
  });
  assert.equal(after.ok, false);
  assert.equal(after.error, ERROR_PROVIDER_REAR_IMAGE_STALE);
  assert.equal(after.reason, 'rear_fingerprint_mismatch');
  assert.notEqual(
    endorsementStateFingerprint(CHECK_ID, store.state.payees, store.state.endorsements),
    store.check.endorsement_render_meta.checkalt_rear_fingerprint,
  );
});

test('rear source replace clears official rear so leftover artifact cannot stay eligible', async () => {
  const store = createStore();
  await handleWrite(jwtEvent({
    back_image_deposit_path: DEPOSIT,
    endorsement_render_status: 'completed',
    endorsement_render_meta: { renderer_version: 'canvas-v2' },
  }), depsFor(store.client));
  assert.equal(evaluateProductionDepositEligibility({
    check: store.check,
    payees: store.state.payees,
    endorsements: store.state.endorsements,
  }).ok, true);

  const cleared = await handleWrite(jwtEvent({
    back_image_path: `checks/reupload/${CHECK_ID}/back-new.jpg`,
    back_image_original_path: `checks/reupload/${CHECK_ID}/back-new.jpg`,
    back_image_deposit_path: null,
    endorsement_render_status: 'idle',
    endorsement_render_meta: null,
  }), depsFor(store.client));
  assert.equal(cleared.ok, true, JSON.stringify(cleared));
  assert.equal(intakeWriteShouldStampOfficialRear({
    back_image_deposit_path: null,
    endorsement_render_meta: null,
    endorsement_render_status: 'idle',
  }), false);
  assert.equal(store.check.back_image_deposit_path, null);
  assert.equal(store.check.endorsement_render_meta, null);
  const after = evaluateProductionDepositEligibility({
    check: store.check,
    payees: store.state.payees,
    endorsements: store.state.endorsements,
  });
  assert.equal(after.ok, false);
  assert.equal(after.reason, 'rear_missing');
});

test('EndorsementAdjuster still does not author the fingerprint; write path does', () => {
  const adjuster = fs.readFileSync(path.join(ROOT, 'src/components/checks/EndorsementAdjuster.tsx'), 'utf8');
  assert.match(adjuster, /endorsed_deposit_\$\{version\}\.checkalt\.jpg/);
  assert.match(adjuster, /renderer_version: ENDORSEMENT_RENDERER_VERSION/);
  assert.match(adjuster, /request_id: requestId/);
  assert.doesNotMatch(adjuster, /checkalt_rear_fingerprint/);
  const write = fs.readFileSync(path.join(ROOT, 'aws/functions/api/write-check-workflow.mjs'), 'utf8');
  assert.match(write, /stampCheckAltRearFingerprint/);
  assert.match(write, /stripClientRearFingerprint/);
  assert.equal(intakeWriteShouldStampOfficialRear({
    back_image_deposit_path: DEPOSIT,
    endorsement_render_status: 'completed',
    endorsement_render_meta: { renderer_version: 'canvas-v2' },
  }), true);
});
