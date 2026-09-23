import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handler } from '../functions/api/index.mjs';
import { LOOKUP_MAPPING_SQL, TENANT_MEMBERSHIP_SQL, USER_ROLES_SQL } from '../functions/api/identity.mjs';
import { handleReviewCorrection } from '../functions/api/workflow.mjs';
import { handleWrite } from '../functions/api/write.mjs';
import { INTAKE_PROHIBITED_COLUMNS, WRITE_ALLOWLIST } from '../functions/api/write-allowlist.mjs';
import {
  canCorrectAmount,
  isAmountFinanciallyLocked,
  parseReviewCorrectionBody,
} from '../functions/api/review-correction.mjs';
import { evaluateTransition } from '../functions/api/workflow-transitions.mjs';

const APP_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const SPOOF_ID = '00000000-0000-0000-0000-000000000099';
const FREEDOM_TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const C1C_TENANT = '4f172140-f57a-4744-8050-95f4f07b13b4';
const CHECK_ID = 'a4188a08-4583-419a-9b58-b96d8ff1fcb5';
const PAYEE_ID = '11111111-2222-4333-8444-555555555555';

const correctionBody = (updates) => ({ check_id: CHECK_ID, ...updates });

const reviewCheck = {
  id: CHECK_ID,
  tenant_id: FREEDOM_TENANT,
  uploaded_by: APP_ID,
  status: 'needs_review',
  check_stage: 'review',
  claim_id: null,
  deposited_at: null,
  external_origin: null,
  partner_status: null,
  carrier_name: null,
  check_number: null,
  payee_line: null,
  issue_date: null,
  amount: null,
  funds_type: null,
  property_address: null,
  payee_address: null,
  review_notes: null,
  expiration_days: null,
  is_multi_payee: false,
  has_raw_ocr_front: true,
  has_raw_ocr_back: true,
  ocr_status: 'completed',
  routing_number: '021000021',
  account_number: '123456789',
};

const jwtEvent = (path, method, body, extra = {}) => ({
  rawPath: path,
  headers: {
    authorization: extra.auth === null ? undefined : 'Bearer test-id-token',
    'x-user-id': SPOOF_ID,
    'x-tenant-id': C1C_TENANT,
    'x-role': 'admin',
    ...(extra.headers || {}),
  },
  queryStringParameters: { user_id: SPOOF_ID, tenant_id: C1C_TENANT },
  body: body ? JSON.stringify(body) : undefined,
  requestContext: {
    stage: 'staging',
    http: { method, path },
    authorizer: extra.auth === null ? undefined : {
      jwt: { claims: { sub: extra.sub || COGNITO_SUB, email: 'checksops-tester@freedomadj.com', token_use: 'id' } },
    },
  },
});

const mappingFor = (sub = COGNITO_SUB) => ({
  application_user_id: APP_ID,
  cognito_sub: sub,
  email: 'checksops-tester@freedomadj.com',
  status: 'active',
});

const mockClient = ({
  mapping = mappingFor(),
  memberships = [{ tenant_id: FREEDOM_TENANT, role: 'admin', tenant_name: 'Freedom', tenant_slug: 'freedom' }],
  roles = [{ role: 'admin' }],
  check = reviewCheck,
  payee = {
    id: PAYEE_ID,
    check_id: CHECK_ID,
    payee_name: 'Jane Homeowner',
    payee_type: 'insured',
  },
} = {}) => {
  const queries = [];
  let current = { ...check };
  const payees = new Map([[PAYEE_ID, { ...payee }]]);
  return {
    queries,
    current: () => current,
    payees,
    connect: async () => {},
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT' || sql === 'SET TRANSACTION READ WRITE') {
        return { rows: [] };
      }
      if (sql.startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
      if (sql === LOOKUP_MAPPING_SQL) {
        return { rows: params[0] === mapping.cognito_sub ? [mapping] : [] };
      }
      if (sql === TENANT_MEMBERSHIP_SQL) return { rows: memberships };
      if (sql === USER_ROLES_SQL) return { rows: roles };
      if (/SELECT role FROM public.tenant_users/.test(sql)) return { rows: memberships };
      if (/raw_ocr_front IS NOT NULL AS has_raw_ocr_front/.test(sql) && /FROM public.check_intake_items/.test(sql) && /SELECT id, tenant_id/.test(sql)) {
        return { rows: current ? [current] : [] };
      }
      if (/UPDATE public.check_intake_items/.test(sql) && /carrier_name|check_number|payee_line|issue_date|funds_type|property_address/.test(sql)) {
        const next = { ...current };
        if (sql.includes('carrier_name')) next.carrier_name = params[1];
        if (sql.includes('check_number')) next.check_number = params.find((value, idx) => idx > 0 && typeof value === 'string' && value !== next.carrier_name) ?? next.check_number;
        Object.assign(next, {
          ...(sql.includes('carrier_name = $2') ? { carrier_name: params[1] } : {}),
        });
        // Apply by scanning SET clause order
        const setClause = sql.match(/SET\s+([\s\S]*?), updated_at = now()/);
        if (setClause) {
          const assigns = setClause[1].split(',').map((part) => part.trim());
          assigns.forEach((assign, idx) => {
            const column = assign.split('=')[0].trim();
            next[column] = params[idx + 1];
          });
        }
        current = next;
        return { rows: [current] };
      }
      if (/UPDATE public.claim_checks/.test(sql)) return { rows: [{ id: 'cc-1' }] };
      if (/aws_review_correction_set_amount/.test(sql)) {
        if (!current) return { rows: [] };
        if (current.deposited_at || ['deposited', 'approved_for_deposit'].includes(current.status)) {
          const error = new Error('amount_financially_locked');
          error.code = '42501';
          throw error;
        }
        current = { ...current, amount: params[1] };
        return { rows: [{ result: { ok: true, check_id: params[0], amount: params[1], ocr_preserved: true } }] };
      }
      if (/FROM public.check_payees/.test(sql)) {
        const row = payees.get(params[0]);
        return { rows: row && row.check_id === params[1] ? [row] : [] };
      }
      if (/UPDATE public.check_payees/.test(sql)) {
        const row = payees.get(params[0]);
        if (!row || row.check_id !== params[1]) return { rows: [] };
        const next = { ...row, payee_name: params[2], payee_type: params[3] };
        payees.set(params[0], next);
        return { rows: [next] };
      }
      if (/SELECT raw_ocr_front IS NOT NULL AS has_raw_ocr_front/.test(sql)) {
        return { rows: [{
          has_raw_ocr_front: current.has_raw_ocr_front,
          has_raw_ocr_back: current.has_raw_ocr_back,
          status: current.status,
          check_stage: current.check_stage,
          amount: current.amount,
        }] };
      }
      if (/INSERT INTO public.check_audit_log/.test(sql)) return { rows: [{ id: 'audit-1' }] };
      return { rows: [] };
    },
    end: async () => {},
  };
};

const depsFor = (client) => ({
  forceEnabled: true,
  forceWorkflow: true,
  loadDatabaseCredentials: async () => ({
    username: 'checksops',
    password: 'unit-test-only-not-a-real-secret',
    host: 'db.example.internal',
    database: 'checksops',
  }),
  createClient: (config) => {
    client.lastConfig = config;
    return client;
  },
});

test('parser allowlists Review fields and rejects status / MICR / arbitrary columns', () => {
  const ok = parseReviewCorrectionBody({
    carrier_name: 'State Farm',
    check_number: '1001',
    amount: '250.50',
    payee_line: 'Jane Homeowner',
    issue_date: '2026-09-01',
    funds_type: 'acv',
    property_address: '1 Main St',
  });
  assert.equal(ok.values.amount, 250.5);
  assert.equal(ok.values.carrier_name, 'State Farm');

  const status = parseReviewCorrectionBody({ amount: 10, status: 'deposited' });
  assert.equal(status.error, 'column_not_allowlisted');
  assert.ok(status.columns.includes('status'));

  const micr = parseReviewCorrectionBody({ routing_number: '021000021', account_number: '99' });
  assert.equal(micr.error, 'column_not_allowlisted');
  assert.ok(micr.columns.includes('routing_number'));

  const arbitrary = parseReviewCorrectionBody({ tenant_id: C1C_TENANT, check_source: 'hack' });
  assert.equal(arbitrary.error, 'column_not_allowlisted');
});

test('amount is correctable only in Review and locked after deposit/ready', () => {
  assert.equal(canCorrectAmount(reviewCheck), true);
  assert.equal(isAmountFinanciallyLocked({ ...reviewCheck, deposited_at: '2026-09-01T00:00:00Z' }), true);
  assert.equal(canCorrectAmount({ ...reviewCheck, status: 'approved_for_deposit', check_stage: 'ready_for_deposit' }), false);
  assert.equal(canCorrectAmount({ ...reviewCheck, status: 'deposited', check_stage: 'deposited' }), false);
  assert.equal(canCorrectAmount({ ...reviewCheck, status: 'endorsements_in_progress', check_stage: 'endorsing' }), false);
});

test('1+2+3 authorized reviewer can edit allowed fields including amount; persist payload is returned', async () => {
  const client = mockClient();
  const result = await handleReviewCorrection(jwtEvent(`/workflow/checks/${CHECK_ID}/review-correction`, 'POST', correctionBody({
    carrier_name: 'State Farm',
    check_number: '44188',
    amount: 1875.25,
    payee_line: 'Jane Homeowner',
    issue_date: '2026-09-02',
    property_address: '10 Oak Ave',
    funds_type: 'acv',
  })), depsFor(client));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.carrier_name, 'State Farm');
  assert.equal(result.data.check_number, '44188');
  assert.equal(result.data.amount, 1875.25);
  assert.equal(result.statusUnchanged, 'needs_review');
  assert.equal(result.ocrPreserved, true);
  assert.equal(result.genericDataWrite, false);
  assert.ok(result.fieldChanges.some((row) => row.field === 'amount'));
  assert.ok(client.queries.some((q) => /aws_review_correction_set_amount/.test(q.sql)));
  assert.equal(client.current().status, 'needs_review');
  const audit = client.queries.find((q) => /INSERT INTO public.check_audit_log/.test(q.sql));
  assert.ok(audit);
  assert.equal(audit.params[2], APP_ID);
  const eventData = JSON.parse(audit.params[3]);
  assert.equal(eventData.actor_id, APP_ID);
  assert.ok(eventData.field_changes.some((row) => row.field === 'amount'));
  assert.equal(eventData.ocr_preserved.raw_ocr_front, true);
});

test('4 amount cannot be changed after financial/deposit lock', async () => {
  const locked = await handleReviewCorrection(jwtEvent(`/workflow/checks/${CHECK_ID}/review-correction`, 'POST', correctionBody({
    amount: 99,
  })), depsFor(mockClient({
    check: { ...reviewCheck, status: 'approved_for_deposit', check_stage: 'ready_for_deposit' },
  })));
  assert.equal(locked.ok, false);
  assert.equal(locked.error, 'amount_financially_locked');

  const deposited = await handleReviewCorrection(jwtEvent(`/workflow/checks/${CHECK_ID}/review-correction`, 'POST', correctionBody({
    amount: 99,
  })), depsFor(mockClient({
    check: { ...reviewCheck, status: 'deposited', deposited_at: '2026-09-01T00:00:00Z' },
  })));
  assert.equal(deposited.error, 'amount_financially_locked');
});

test('5 ordinary user cannot edit another tenant check', async () => {
  const client = mockClient({
    memberships: [{ tenant_id: C1C_TENANT, role: 'member', tenant_name: 'C1C', tenant_slug: 'c1c' }],
    roles: [{ role: 'member' }],
  });
  const result = await handleReviewCorrection(jwtEvent(`/workflow/checks/${CHECK_ID}/review-correction`, 'POST', correctionBody({
    carrier_name: 'Other Tenant',
    amount: 10,
  })), depsFor(client));
  assert.equal(result.ok, false);
  assert.equal(result.error, 'not_authorized');
  assert.equal(client.queries.some((q) => /UPDATE public.check_intake_items/.test(q.sql)), false);
});

test('6 status cannot be changed through review-correction', async () => {
  const deniedStatus = await handleReviewCorrection(jwtEvent(`/workflow/checks/${CHECK_ID}/review-correction`, 'POST', correctionBody({
    status: 'approved_for_deposit',
    check_stage: 'ready_for_deposit',
    amount: 10,
  })), depsFor(mockClient()));
  assert.equal(deniedStatus.error, 'column_not_allowlisted');
  assert.ok(deniedStatus.columns.includes('status'));

  const client = mockClient();
  const ok = await handleReviewCorrection(jwtEvent(`/workflow/checks/${CHECK_ID}/review-correction`, 'POST', correctionBody({
    carrier_name: 'Safe',
  })), depsFor(client));
  assert.equal(ok.ok, true);
  assert.equal(ok.statusUnchanged, 'needs_review');
  assert.equal(client.current().status, 'needs_review');
  assert.equal(client.current().check_stage, 'review');
});

test('7 arbitrary columns cannot be supplied', async () => {
  const result = await handleReviewCorrection(jwtEvent(`/workflow/checks/${CHECK_ID}/review-correction`, 'POST', correctionBody({
    deposited_at: '2026-09-01T00:00:00Z',
    raw_ocr_front: { wipe: true },
    claim_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  })), depsFor(mockClient()));
  assert.equal(result.error, 'column_not_allowlisted');
  assert.ok(result.columns.includes('raw_ocr_front'));
  assert.ok(result.columns.includes('claim_id'));
});

test('8 generic /data/write remains unable to change protected amount/MICR', async () => {
  assert.equal(INTAKE_PROHIBITED_COLUMNS.has('amount'), true);
  assert.equal(INTAKE_PROHIBITED_COLUMNS.has('routing_number'), true);
  assert.equal(WRITE_ALLOWLIST.check_intake_items.columns.has('amount'), false);

  const client = mockClient();
  const amount = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'check_intake_items',
    op: 'update',
    values: { amount: 50 },
    filters: [{ column: 'id', op: 'eq', value: CHECK_ID }],
  }), depsFor(client));
  assert.equal(amount.statusCode, 403);
  assert.equal(amount.error, 'column_not_allowlisted');

  const micr = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'check_intake_items',
    op: 'update',
    values: { routing_number: '021000021', account_number: '999' },
    filters: [{ column: 'id', op: 'eq', value: CHECK_ID }],
  }), depsFor(client));
  assert.equal(micr.error, 'column_not_allowlisted');
});

test('9+10 audit records actor/changed fields and OCR evidence is not overwritten', async () => {
  const client = mockClient();
  const result = await handleReviewCorrection(jwtEvent(`/workflow/checks/${CHECK_ID}/review-correction`, 'POST', correctionBody({
    amount: 12.34,
    carrier_name: 'Allstate',
  })), depsFor(client));
  assert.equal(result.ok, true);
  assert.equal(result.ocrPreserved, true);
  const audit = client.queries.find((q) => /INSERT INTO public.check_audit_log/.test(q.sql));
  const eventData = JSON.parse(audit.params[3]);
  assert.equal(audit.params[2], APP_ID);
  assert.equal(eventData.actor_id, APP_ID);
  assert.deepEqual(eventData.field_changes.map((row) => row.field).sort(), ['amount', 'carrier_name']);
  assert.equal(eventData.ocr_preserved.raw_ocr_front, true);
  assert.equal(eventData.ocr_preserved.raw_ocr_back, true);
  assert.equal(client.queries.some((q) => /raw_ocr_front\s*=/.test(q.sql)), false);
});

test('11 payee edits stay on canonical check_payees and do not replace the row id', async () => {
  const client = mockClient();
  const result = await handleReviewCorrection(jwtEvent(`/workflow/checks/${CHECK_ID}/review-correction`, 'POST', correctionBody({
    payee_line: 'Jane Homeowner and Rocket Mortgage',
    payees: [{ id: PAYEE_ID, payee_name: 'Jane Q Homeowner', payee_type: 'insured' }],
  })), depsFor(client));
  assert.equal(result.ok, true);
  const payeeUpdate = client.queries.find((q) => /UPDATE public.check_payees/.test(q.sql));
  assert.equal(payeeUpdate.params[0], PAYEE_ID);
  assert.equal(payeeUpdate.params[1], CHECK_ID);
  assert.equal(client.payees.get(PAYEE_ID).id, PAYEE_ID);
  assert.equal(client.current().payee_line, 'Jane Homeowner and Rocket Mortgage');
});

test('12 existing review decision / state-machine behavior is unchanged', () => {
  const check = { id: CHECK_ID, status: 'needs_review', claim_id: null };
  assert.equal(evaluateTransition('start_endorsing', check).ok, true);
  assert.equal(evaluateTransition('mark_deposited', check).error, 'financial_or_provider');
  assert.equal(evaluateTransition('start_review', { ...check, status: 'uploaded' }).ok, true);
});

test('unauthenticated review-correction is 401; MICR is rejected; workflow flag still gates writes', async () => {
  const unauth = await handler(jwtEvent(`/workflow/checks/${CHECK_ID}/review-correction`, 'POST', {
    amount: 1,
  }, { auth: null }));
  assert.equal(unauth.statusCode, 401);

  const micr = await handleReviewCorrection(jwtEvent(`/workflow/checks/${CHECK_ID}/review-correction`, 'POST', correctionBody({
    routing_number: '021000021',
  })), depsFor(mockClient()));
  assert.equal(micr.error, 'column_not_allowlisted');

  const disabled = await handleReviewCorrection(jwtEvent(`/workflow/checks/${CHECK_ID}/review-correction`, 'POST', correctionBody({
    carrier_name: 'x',
  })), { ...depsFor(mockClient()), forceWorkflow: false });
  assert.equal(disabled.statusCode, 403);
  assert.equal(disabled.error, 'application_workflow_writes_disabled');
});
