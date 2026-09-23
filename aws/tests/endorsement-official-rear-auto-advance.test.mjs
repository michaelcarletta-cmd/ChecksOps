import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LOOKUP_MAPPING_SQL } from '../functions/api/identity.mjs';
import { handleWrite } from '../functions/api/write.mjs';
import {
  applyAutoAdvanceIfEligible,
  retryAutoAdvanceAfterOfficialRear,
  runAuthenticatedEndorsement,
  runPublicEndorsement,
  updatePayeeSigned,
} from '../functions/api/check-endorsement.mjs';
import {
  PAYEE_IMAGE_MAX_CHARS,
  payeeImageForPersist,
  synchronizePayeeEndorsementStatus,
} from '../functions/api/endorsement-payee-sync.mjs';
import { endorsementStateFingerprint } from '../functions/api/providers/production/checkalt-eligibility.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const CHECK_ID = '33333333-3333-4333-8333-333333333333';
const TENANT = '11111111-1111-4111-8111-111111111111';
const APP_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const PAYEE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const PAYEE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const ENDO_A = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
const ENDO_B = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1';
const USER_ID = '66666666-6666-4666-8666-666666666666';
const DEPOSIT = `checks/${CHECK_ID}/endorsed_deposit_retry.checkalt.jpg`;

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

const mockClient = (impl) => ({
  query: async (sql, params = []) => impl(String(sql), params || []),
  connect: async () => {},
  end: async () => {},
});

const eventOf = (body = {}) => ({
  headers: {},
  body: JSON.stringify(body),
  requestContext: { http: { method: 'POST', path: '/functions/v1/check-endorsement' } },
});

const jwtWrite = (values) => ({
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

const createAdvanceStore = ({
  allSigned = true,
  payeePending = false,
  status = 'endorsements_in_progress',
  failStamp = false,
} = {}) => {
  const payees = [
    {
      id: PAYEE_A,
      check_id: CHECK_ID,
      tenant_id: TENANT,
      payee_name: 'Freedom Adjustment',
      payee_type: 'public_adjuster',
      endorsement_status: 'signed',
      endorsed_at: '2026-08-21T15:06:52.000Z',
    },
    {
      id: PAYEE_B,
      check_id: CHECK_ID,
      tenant_id: TENANT,
      payee_name: 'Brenda Wilcox',
      payee_type: 'insured',
      endorsement_status: payeePending ? 'pending' : 'signed',
      endorsed_at: payeePending ? null : '2026-09-22T22:23:04.000Z',
    },
  ];
  const endorsements = [
    {
      id: ENDO_A,
      check_id: CHECK_ID,
      tenant_id: TENANT,
      payee_id: PAYEE_A,
      payee_name: 'Freedom Adjustment',
      payee_type: 'public_adjuster',
      status: 'signed',
      signed_at: '2026-08-21T15:06:52.000Z',
      token: 'tok-a',
    },
    {
      id: ENDO_B,
      check_id: CHECK_ID,
      tenant_id: TENANT,
      payee_id: PAYEE_B,
      payee_name: 'Brenda Wilcox',
      payee_type: 'insured',
      status: allSigned ? 'signed' : 'pending',
      signed_at: allSigned ? '2026-09-22T22:23:04.000Z' : null,
      token: 'tok-b',
    },
  ];
  const check = {
    id: CHECK_ID,
    tenant_id: TENANT,
    status,
    check_stage: status === 'approved_for_deposit' ? 'ready_for_deposit' : 'endorsing',
    deposit_recommendation: status === 'approved_for_deposit' ? 'ready_for_deposit' : null,
    deposited_at: null,
    back_image_deposit_path: null,
    endorsement_render_meta: {},
    endorsement_render_status: 'idle',
  };
  const queries = [];
  const client = mockClient(async (sql, params = []) => {
    queries.push({ sql: String(sql).replace(/\s+/g, ' '), params });
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
    if (compact.includes('aws_can_write_tenant')) return { rows: [{ ok: true }] };
    if (compact.includes('SELECT id, tenant_id FROM public.check_intake_items')) {
      return { rows: [{ id: check.id, tenant_id: check.tenant_id }] };
    }
    if (compact.includes('FROM public.check_intake_items')) {
      return { rows: [check] };
    }
    if (compact.includes('SELECT payee_id, payee_name, status')) {
      return { rows: endorsements };
    }
    if (compact.includes('SELECT status, payee_type FROM public.check_endorsements')) {
      return { rows: endorsements.map((row) => ({ status: row.status, payee_type: row.payee_type })) };
    }
    if (compact.includes('FROM public.check_endorsements')) {
      return { rows: endorsements };
    }
    if (compact.includes('FROM public.check_payees') && compact.includes('SELECT')) {
      return { rows: payees };
    }
    if (compact.includes('UPDATE public.check_payees') && compact.includes('endorsement_status')) {
      const payee = payees.find((row) => row.id === params[0] || row.payee_name === params[1]);
      if (!payee) return { rows: [], rowCount: 0 };
      payee.endorsement_status = params[1] === payee.payee_name ? params[2] : params[1];
      payee.endorsed_at = params[2] === payee.payee_name ? params[3] : params[2];
      return { rows: [payee], rowCount: 1 };
    }
    if (compact.includes('UPDATE public.check_payees') && compact.includes('endorsement_image_path')) {
      const payee = payees.find((row) => row.id === params[0]);
      if (payee) payee.endorsement_image_path = params[1];
      return { rows: payee ? [payee] : [], rowCount: payee ? 1 : 0 };
    }
    if (compact.includes('UPDATE public.check_intake_items') && compact.includes('jsonb_build_object')) {
      if (failStamp) throw new Error('stamp_failed');
      check.endorsement_render_meta = {
        ...(check.endorsement_render_meta || {}),
        [params[1]]: params[2],
      };
      return { rows: [check] };
    }
    if (compact.includes("SET status = 'approved_for_deposit'")) {
      check.status = 'approved_for_deposit';
      check.deposit_recommendation = 'ready_for_deposit';
      check.check_stage = 'ready_for_deposit';
      return { rows: [check], rowCount: 1 };
    }
    if (compact.includes('UPDATE public.check_intake_items')) {
      const deposit = params.find((value) => typeof value === 'string' && String(value).includes('.checkalt.jpg'));
      if (deposit) check.back_image_deposit_path = deposit;
      if (params.includes('completed')) check.endorsement_render_status = 'completed';
      const meta = params.find((value) => value && typeof value === 'object' && !Array.isArray(value));
      if (meta) check.endorsement_render_meta = meta;
      return { rows: [check] };
    }
    if (compact.includes('UPDATE public.claim_checks')) return { rows: [], rowCount: 1 };
    if (compact.includes('INSERT INTO public.check_audit_log')) return { rows: [], rowCount: 1 };
    if (compact.includes('INSERT INTO public.endorsement_audit_log')) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  return { check, payees, endorsements, client, queries };
};

test('payee image persist skips oversized data URLs and keeps storage paths', () => {
  assert.equal(payeeImageForPersist(`checks/${CHECK_ID}/sig.png`), `checks/${CHECK_ID}/sig.png`);
  assert.equal(payeeImageForPersist('data:image/png;base64,aaa'), 'data:image/png;base64,aaa');
  assert.equal(payeeImageForPersist(`data:image/png;base64,${'a'.repeat(PAYEE_IMAGE_MAX_CHARS)}`), null);
});

test('failed payee-status update is not swallowed', async () => {
  const client = mockClient(async () => ({ rows: [], rowCount: 0 }));
  await assert.rejects(
    () => synchronizePayeeEndorsementStatus(client, {
      payee_id: PAYEE_B,
      check_id: CHECK_ID,
      payee_name: 'Brenda Wilcox',
    }, { status: 'signed' }),
    (error) => error.error === 'payee_status_sync_failed' && error.statusCode === 503,
  );
});

test('electronic sign synchronizes check_payees before completion', async () => {
  const store = createAdvanceStore({ payeePending: true, allSigned: false });
  store.endorsements[1].status = 'sent';
  const captured = [];
  const client = mockClient(async (sql, params = []) => {
    const compact = String(sql).replace(/\s+/g, ' ');
    captured.push({ sql: compact, params });
    if (/^BEGIN|COMMIT|ROLLBACK|SET TRANSACTION/i.test(compact)) return { rows: [] };
    if (compact.includes('FROM public.check_endorsements WHERE token')) {
      return { rows: [store.endorsements[1]] };
    }
    if (compact.includes("SET status = 'signed'")) {
      store.endorsements[1].status = 'signed';
      store.endorsements[1].signed_at = new Date().toISOString();
      return { rows: [{ id: ENDO_B, status: 'signed' }], rowCount: 1 };
    }
    if (compact.includes('UPDATE public.check_payees') && compact.includes('endorsement_status')) {
      store.payees[1].endorsement_status = 'signed';
      store.payees[1].endorsed_at = params[2];
      return { rows: [store.payees[1]], rowCount: 1 };
    }
    if (compact.includes('SELECT status, payee_type')) {
      return { rows: store.endorsements.map((row) => ({ status: row.status, payee_type: row.payee_type })) };
    }
    if (compact.includes('FROM public.check_intake_items')) return { rows: [store.check] };
    return { rows: [], rowCount: 0 };
  });
  const result = await runPublicEndorsement(eventOf({
    action: 'submit_endorsement',
    token: 'tok-b',
    eSignConsentAccepted: true,
    signatureData: 'data:image/png;base64,aaa',
  }), { client });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(store.payees[1].endorsement_status, 'signed');
  assert.equal(captured.some((row) => row.sql.includes('UPDATE public.check_payees') && row.sql.includes('endorsement_status')), true);
});

test('in-person sign synchronizes payee status even when ink is too large to copy', async () => {
  const huge = `data:image/png;base64,${'a'.repeat(PAYEE_IMAGE_MAX_CHARS + 10)}`;
  const payee = {
    id: PAYEE_B,
    endorsement_status: 'pending',
    endorsed_at: null,
    endorsement_image_path: null,
  };
  const endorsement = {
    id: ENDO_B,
    check_id: CHECK_ID,
    tenant_id: TENANT,
    payee_id: PAYEE_B,
    payee_name: 'Brenda Wilcox',
  };
  const client = mockClient(async (sql, params = []) => {
    const compact = String(sql).replace(/\s+/g, ' ');
    if (compact.includes('FROM public.check_endorsements WHERE id')) return { rows: [endorsement] };
    if (compact.includes('FROM public.check_intake_items')) {
      return { rows: [{ id: CHECK_ID, tenant_id: TENANT, status: 'endorsements_in_progress' }] };
    }
    if (compact.includes('aws_can_write_tenant')) return { rows: [{ ok: true }] };
    if (compact.includes("SET status = 'signed'")) return { rows: [], rowCount: 1 };
    if (compact.includes('UPDATE public.check_payees') && compact.includes('endorsement_status')) {
      payee.endorsement_status = params[1];
      payee.endorsed_at = params[2];
      return { rows: [payee], rowCount: 1 };
    }
    if (compact.includes('UPDATE public.check_payees') && compact.includes('endorsement_image_path')) {
      payee.endorsement_image_path = params[1];
      return { rows: [payee], rowCount: 1 };
    }
    if (compact.includes('SELECT status, payee_type')) {
      return { rows: [{ status: 'signed', payee_type: 'insured' }] };
    }
    return { rows: [], rowCount: 0 };
  });
  const result = await runAuthenticatedEndorsement({
    client,
    mapping: { application_user_id: USER_ID },
    body: {
      action: 'sign_in_person',
      endorsementId: ENDO_B,
      signatureData: huge,
      eSignConsentAccepted: true,
    },
    spoof: { ignored: true },
    event: eventOf({}),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(payee.endorsement_status, 'signed');
  assert.equal(payee.endorsement_image_path, null);
  assert.equal(payeeImageForPersist(huge), null);
});

test('waive and force-complete synchronize corresponding payee rows', async () => {
  const waived = { id: PAYEE_A, endorsement_status: 'pending' };
  const forced = { id: PAYEE_B, endorsement_status: 'pending' };
  const waiveEndorsement = {
    id: ENDO_A,
    check_id: CHECK_ID,
    tenant_id: TENANT,
    payee_id: PAYEE_A,
    payee_name: 'Freedom Adjustment',
  };
  const waive = await runAuthenticatedEndorsement({
    client: mockClient(async (sql, params = []) => {
      const compact = String(sql).replace(/\s+/g, ' ');
      if (compact.includes('FROM public.check_endorsements WHERE id')) return { rows: [waiveEndorsement] };
      if (compact.includes('FROM public.check_intake_items')) {
        return { rows: [{ id: CHECK_ID, tenant_id: TENANT, status: 'endorsements_in_progress' }] };
      }
      if (compact.includes('aws_can_write_tenant')) return { rows: [{ ok: true }] };
      if (compact.includes("SET status = 'waived'")) return { rows: [], rowCount: 1 };
      if (compact.includes('UPDATE public.check_payees')) {
        waived.endorsement_status = params[1];
        return { rows: [waived], rowCount: 1 };
      }
      if (compact.includes('SELECT status, payee_type')) {
        return { rows: [{ status: 'waived', payee_type: 'public_adjuster' }] };
      }
      return { rows: [], rowCount: 0 };
    }),
    mapping: { application_user_id: USER_ID },
    body: { action: 'waive_endorsement', endorsementId: ENDO_A },
    spoof: { ignored: true },
    event: eventOf({}),
  });
  assert.equal(waive.ok, true, JSON.stringify(waive));
  assert.equal(waived.endorsement_status, 'waived');

  const force = await runAuthenticatedEndorsement({
    client: mockClient(async (sql, params = []) => {
      const compact = String(sql).replace(/\s+/g, ' ');
      if (compact.includes('FROM public.check_intake_items')) {
        return { rows: [{ id: CHECK_ID, tenant_id: TENANT, status: 'endorsements_in_progress' }] };
      }
      if (compact.includes('aws_can_write_tenant')) return { rows: [{ ok: true }] };
      if (compact.includes('FROM public.check_endorsements WHERE check_id') && compact.includes('signature_image_url')) {
        return { rows: [{ id: ENDO_B, status: 'pending', payee_type: 'insured' }] };
      }
      if (compact.includes("SET status = 'signed'")) return { rows: [], rowCount: 1 };
      if (compact.includes('SELECT payee_id, payee_name, status')) {
        return { rows: [{
          payee_id: PAYEE_B,
          payee_name: 'Brenda Wilcox',
          status: 'signed',
          signed_at: new Date().toISOString(),
          check_id: CHECK_ID,
        }] };
      }
      if (compact.includes('UPDATE public.check_payees')) {
        forced.endorsement_status = params[1];
        return { rows: [forced], rowCount: 1 };
      }
      if (compact.includes('SELECT status, payee_type')) {
        return { rows: [{ status: 'signed', payee_type: 'insured' }] };
      }
      return { rows: [], rowCount: 0 };
    }),
    mapping: { application_user_id: USER_ID },
    body: { action: 'force_complete_endorsements', checkId: CHECK_ID },
    spoof: { ignored: true },
    event: eventOf({}),
  });
  assert.equal(force.ok, true, JSON.stringify(force));
  assert.equal(forced.endorsement_status, 'signed');
});

test('flag OFF after official rear stays Endorsing and does not submit CheckAlt', async () => {
  await withEnv({ AWS_ENDORSEMENT_AUTO_ADVANCE: 'false' }, async () => {
    const store = createAdvanceStore({ payeePending: true });
    const result = await handleWrite(jwtWrite({
      back_image_deposit_path: DEPOSIT,
      endorsement_render_status: 'completed',
      endorsement_render_meta: { renderer_version: 'canvas-v2' },
    }), {
      forceEnabled: true,
      loadDatabaseCredentials: async () => ({ username: 'checksops', password: 'x', host: 'db', database: 'checksops' }),
      createClient: () => store.client,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(store.check.back_image_deposit_path, DEPOSIT);
    assert.ok(store.check.endorsement_render_meta.checkalt_rear_fingerprint);
    assert.equal(store.check.status, 'endorsements_in_progress');
    assert.equal(store.queries.some((row) => /checkalt_deposits|processDeposit|fincapture/i.test(row.sql)), false);
    assert.equal(store.payees[1].endorsement_status, 'signed');
  });
});

test('later official-rear persist + stamp + flag ON retries Ready', async () => {
  await withEnv({ AWS_ENDORSEMENT_AUTO_ADVANCE: 'true' }, async () => {
    const store = createAdvanceStore({ payeePending: true });
    const result = await handleWrite(jwtWrite({
      back_image_deposit_path: DEPOSIT,
      endorsement_render_status: 'completed',
      endorsement_render_meta: { renderer_version: 'canvas-v2' },
    }), {
      forceEnabled: true,
      loadDatabaseCredentials: async () => ({ username: 'checksops', password: 'x', host: 'db', database: 'checksops' }),
      createClient: () => store.client,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(store.check.status, 'approved_for_deposit');
    assert.equal(store.check.check_stage, 'ready_for_deposit');
    assert.equal(store.check.deposit_recommendation, 'ready_for_deposit');
    assert.equal(store.payees[1].endorsement_status, 'signed');
    const fingerprint = endorsementStateFingerprint(CHECK_ID, store.payees, store.endorsements);
    assert.equal(store.check.endorsement_render_meta.checkalt_rear_fingerprint, fingerprint);
    assert.equal(store.queries.some((row) => /INSERT INTO public.checkalt_deposits|fincapture|processDeposit/i.test(row.sql)), false);
    const syncIndex = store.queries.findIndex((row) => row.sql.includes('UPDATE public.check_payees') && row.sql.includes('endorsement_status'));
    const stampIndex = store.queries.findIndex((row) => row.sql.includes('jsonb_build_object'));
    assert.ok(syncIndex >= 0 && stampIndex > syncIndex);
  });
});

test('stamp failure fail-closes and does not mark Ready', async () => {
  await withEnv({ AWS_ENDORSEMENT_AUTO_ADVANCE: 'true' }, async () => {
    const store = createAdvanceStore({ failStamp: true });
    const result = await handleWrite(jwtWrite({
      back_image_deposit_path: DEPOSIT,
      endorsement_render_status: 'completed',
      endorsement_render_meta: { renderer_version: 'canvas-v2' },
    }), {
      forceEnabled: true,
      loadDatabaseCredentials: async () => ({ username: 'checksops', password: 'x', host: 'db', database: 'checksops' }),
      createClient: () => store.client,
    });
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 503);
    assert.equal(result.error, 'provider_rear_fingerprint_stamp_failed');
    assert.equal(store.check.status, 'endorsements_in_progress');
    assert.equal(store.queries.some((row) => row.sql.includes("SET status = 'approved_for_deposit'")), false);
  });
});

test('incomplete required endorsements do not mark Ready after official rear', async () => {
  await withEnv({ AWS_ENDORSEMENT_AUTO_ADVANCE: 'true' }, async () => {
    const store = createAdvanceStore({ allSigned: false });
    const result = await handleWrite(jwtWrite({
      back_image_deposit_path: DEPOSIT,
      endorsement_render_status: 'completed',
      endorsement_render_meta: { renderer_version: 'canvas-v2' },
    }), {
      forceEnabled: true,
      loadDatabaseCredentials: async () => ({ username: 'checksops', password: 'x', host: 'db', database: 'checksops' }),
      createClient: () => store.client,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(store.check.status, 'endorsements_in_progress');
    const advanced = await retryAutoAdvanceAfterOfficialRear(store.client, CHECK_ID);
    assert.equal(advanced.allSigned, false);
    assert.equal(store.check.status, 'endorsements_in_progress');
  });
});

test('compositor blocked then later retry becomes Ready; loss draft stays held', async () => {
  await withEnv({ AWS_ENDORSEMENT_AUTO_ADVANCE: 'true' }, async () => {
    const blocked = await applyAutoAdvanceIfEligible(createAdvanceStore().client, CHECK_ID, {
      allSigned: true,
      anyRejected: false,
    }, { officialRearReady: false });
    assert.equal(blocked.advance_check_on_endorsement_complete, 'blocked_official_rear_missing');

    const store = createAdvanceStore();
    const retried = await retryAutoAdvanceAfterOfficialRear(store.client, CHECK_ID);
    assert.equal(retried.advance_check_on_endorsement_complete, 'applied');
    assert.equal(store.check.status, 'approved_for_deposit');

    const loss = createAdvanceStore({ status: 'loss_draft_required' });
    loss.check.check_stage = 'loss_draft';
    const held = await retryAutoAdvanceAfterOfficialRear(loss.client, CHECK_ID);
    assert.equal(held.advance_check_on_endorsement_complete, 'held_loss_draft');
    assert.equal(loss.check.status, 'loss_draft_required');
  });
});

test('Ready transition source does not submit CheckAlt', () => {
  const endorsement = fs.readFileSync(path.join(ROOT, 'aws/functions/api/check-endorsement.mjs'), 'utf8');
  const write = fs.readFileSync(path.join(ROOT, 'aws/functions/api/write-check-workflow.mjs'), 'utf8');
  const documents = fs.readFileSync(path.join(ROOT, 'aws/functions/api/documents.mjs'), 'utf8');
  assert.match(write, /retryAutoAdvanceAfterOfficialRear/);
  assert.match(write, /synchronizePayeesFromEndorsements/);
  assert.match(documents, /retryAutoAdvanceAfterOfficialRear/);
  assert.match(endorsement, /officialRearReady: true/);
  assert.doesNotMatch(endorsement, /checkalt_deposits|processDeposit|submitCheckAlt/);
  assert.doesNotMatch(write, /checkalt_deposits|processDeposit|submitCheckAlt/);
  assert.equal(typeof updatePayeeSigned, 'function');
});
