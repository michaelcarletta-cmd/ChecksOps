import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { handleCheckTransition, matchWorkflowRoute } from '../functions/api/workflow.mjs';
import { handleReviewCorrection, REVIEW_CORRECTION_ALLOWED_FIELDS, canCorrectAmount, isFinanciallyLocked } from '../functions/api/workflow-review-correction.mjs';
import { handleWrite } from '../functions/api/write.mjs';
import { handleDataRpc } from '../functions/api/data.mjs';
import { LOOKUP_MAPPING_SQL, TENANT_MEMBERSHIP_SQL, USER_ROLES_SQL } from '../functions/api/identity.mjs';
import { IS_PLATFORM_OWNER_SQL } from '../functions/api/data.mjs';
import { SAFE_WRITE_RPCS, SAFE_WRITE_RPC_CLASSIFICATION } from '../functions/api/workflow-rpc.mjs';
import { WRITE_ALLOWLIST, INTAKE_PROHIBITED_COLUMNS } from '../functions/api/write-allowlist.mjs';
import { evaluateTransition, mapReviewPath, TRANSITIONS } from '../functions/api/workflow-transitions.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const APP_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const OTHER_APP = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const FREEDOM_TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const C1C_TENANT = '4f172140-f57a-4744-8050-95f4f07b13b4';
const CHECK_ID = 'a4188a08-4583-419a-9b58-b96d8ff1fcb5';

const jwtEvent = (path, method, body, extra = {}) => ({
  rawPath: path,
  headers: {
    authorization: extra.auth === null ? undefined : 'Bearer test-id-token',
    'x-user-id': OTHER_APP,
    'x-tenant-id': C1C_TENANT,
    'x-role': extra.headerRole || 'admin',
  },
  body: body ? JSON.stringify(body) : undefined,
  requestContext: {
    stage: 'staging',
    http: { method, path },
    authorizer: extra.auth === null ? undefined : {
      jwt: { claims: { sub: extra.sub || COGNITO_SUB, email: 'checksops-tester@freedomadj.com', token_use: 'id' } },
    },
  },
});

const mappingFor = (applicationUserId = APP_ID) => ({
  application_user_id: applicationUserId,
  cognito_sub: COGNITO_SUB,
  email: 'checksops-tester@freedomadj.com',
  status: 'active',
});

const checkRow = {
  id: CHECK_ID,
  tenant_id: FREEDOM_TENANT,
  uploaded_by: APP_ID,
  status: 'needs_review',
  check_stage: 'review',
  claim_id: null,
  deposited_at: null,
  carrier_name: 'PHASE1-SAFE-FIXTURE',
  check_number: null,
  amount: null,
  payee_line: null,
  issue_date: null,
  property_address: null,
  funds_type: null,
  detected_claim_number: null,
  is_multi_payee: false,
  expiration_days: null,
  review_notes: null,
  payee_address: null,
  routing_number: '021000021',
  account_number: '111122223333',
  raw_ocr_front: { amount: null, carrier_name: 'OCR-ORIGINAL' },
  raw_ocr_back: { memo: 'OCR-BACK' },
  ocr_status: 'complete',
  ocr_needs_verification: true,
};

const mockClient = ({
  mapping = mappingFor(),
  memberships = [{ tenant_id: FREEDOM_TENANT, role: 'admin', tenant_name: 'Freedom', tenant_slug: 'freedom' }],
  roles = [{ role: 'admin' }],
  platformOwner = false,
  masterOwner = false,
  check = checkRow,
  payees = [],
  claimChecksError = null,
} = {}) => {
  const queries = [];
  const store = {
    check: { ...check },
    payees: [...payees],
    audits: [],
  };
  return {
    queries,
    store,
    connect: async () => {},
    end: async () => {},
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (
        sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT' || sql === 'SET TRANSACTION READ WRITE'
        || sql === 'SAVEPOINT review_correction_claim_mirror'
        || sql === 'RELEASE SAVEPOINT review_correction_claim_mirror'
        || sql === 'ROLLBACK TO SAVEPOINT review_correction_claim_mirror'
      ) {
        return { rows: [] };
      }
      if (sql.startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
      if (sql === LOOKUP_MAPPING_SQL) {
        return { rows: params[0] === mapping.cognito_sub ? [mapping] : [] };
      }
      if (sql === TENANT_MEMBERSHIP_SQL) return { rows: memberships };
      if (sql === USER_ROLES_SQL) return { rows: roles };
      if (sql === IS_PLATFORM_OWNER_SQL) return { rows: [{ is_owner: platformOwner }] };
      if (/SELECT public.is_master_owner\(\) AS is_master/.test(sql)) return { rows: [{ is_master: masterOwner }] };
      if (/SELECT role FROM public.tenant_users/.test(sql)) {
        const tenantId = params?.[1];
        return { rows: memberships.filter((row) => !tenantId || row.tenant_id === tenantId) };
      }
      if (/FROM public.check_intake_items/.test(sql) && /raw_ocr_front, raw_ocr_back/.test(sql) && /SELECT/.test(sql)) {
        return { rows: store.check ? [{ ...store.check }] : [] };
      }
      if (/UPDATE public.check_intake_items/.test(sql)) {
        const assignments = [...sql.matchAll(/(\w+) = \$(\d+)/g)];
        for (const [, column, index] of assignments) {
          if (column === 'id') continue;
          store.check[column] = params[Number(index) - 1];
        }
        store.check.updated_at = '2026-09-23T21:00:00.000Z';
        return { rows: [{ ...store.check }] };
      }
      if (/FROM public.check_payees/.test(sql) && /SELECT id, payee_name/.test(sql)) {
        return { rows: store.payees };
      }
      if (/INSERT INTO public.check_payees/.test(sql)) {
        const row = {
          id: 'payee-1',
          payee_name: params[2],
          payee_type: 'insured',
        };
        store.payees.push(row);
        return { rows: [row] };
      }
      if (/UPDATE public.check_payees/.test(sql)) {
        const current = store.payees.find((row) => row.id === params[0]);
        if (current) current.payee_name = params[1];
        return { rows: current ? [current] : [] };
      }
      if (/UPDATE public.claim_checks/.test(sql)) {
        if (claimChecksError) {
          const error = new Error(claimChecksError.message);
          error.code = claimChecksError.code;
          throw error;
        }
        return { rows: [] };
      }
      if (/INSERT INTO public.check_audit_log/.test(sql)) {
        const audit = {
          check_id: params[0],
          tenant_id: params[1],
          actor_id: params[2],
          event_type: 'review_correction',
          event_description: params[3],
          event_data: JSON.parse(params[4]),
        };
        store.audits.push(audit);
        return { rows: [{ id: 'audit' }] };
      }
      return { rows: [] };
    },
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
  createClient: () => client,
});

const correct = (fields, extra = {}) => handleReviewCorrection(
  jwtEvent(`/workflow/checks/${CHECK_ID}/review-correction`, 'POST', {
    p_check_id: CHECK_ID,
    p_fields: fields,
    p_actor_id: OTHER_APP,
  }),
  depsFor(mockClient(extra)),
);

test('1) authorized reviewer can edit allowed Review fields', async () => {
  const client = mockClient();
  const result = await handleReviewCorrection(jwtEvent(`/workflow/checks/${CHECK_ID}/review-correction`, 'POST', {
    check_id: CHECK_ID,
    fields: {
      carrier_name: 'State Farm',
      check_number: '1001',
      amount: 1250.5,
      payee_line: 'Jane Homeowner',
      issue_date: '2026-09-01',
      detected_claim_number: 'CLM-99',
      property_address: '1 Main St',
      funds_type: 'acv',
    },
    p_actor_id: OTHER_APP,
  }), depsFor(client));
  assert.equal(result.ok, true);
  assert.equal(result.data.status, 'needs_review');
  assert.equal(result.data.intake.amount, 1250.5);
  assert.equal(result.data.intake.carrier_name, 'State Farm');
  assert.equal(result.data.intake.payee_line, 'Jane Homeowner');
  assert.equal(result.data.actor_id, APP_ID);
  assert.equal(result.applicationUserId, APP_ID);
  assert.deepEqual(result.data.field_changes.map((row) => row.field).sort(), [
    'amount', 'carrier_name', 'check_number', 'detected_claim_number', 'funds_type', 'issue_date', 'payee_line', 'property_address',
  ].sort());
});

test('2) edits persist on the returned intake row and do not change status', async () => {
  const client = mockClient();
  const result = await handleReviewCorrection(jwtEvent('/workflow/review-correction', 'POST', {
    check_id: CHECK_ID,
    fields: { carrier_name: 'Allstate', amount: 99.01 },
  }), depsFor(client));
  assert.equal(result.ok, true);
  assert.equal(client.store.check.carrier_name, 'Allstate');
  assert.equal(client.store.check.amount, 99.01);
  assert.equal(client.store.check.status, 'needs_review');
  assert.equal(client.store.check.check_stage, 'review');
  assert.equal(result.data.status_unchanged ?? result.data.status === 'needs_review', true);
});

test('3) amount can be corrected while the check is safely in Review', async () => {
  const result = await correct({ amount: 500 });
  assert.equal(result.ok, true);
  assert.equal(result.data.intake.amount, 500);
  assert.equal(canCorrectAmount(checkRow), true);
});

test('4) amount cannot be changed after financial/deposit lock', async () => {
  const deposited = await correct({ amount: 10 }, {
    check: { ...checkRow, deposited_at: '2026-09-01T00:00:00.000Z', status: 'deposited', check_stage: 'deposited' },
  });
  assert.equal(deposited.ok, false);
  assert.equal(deposited.error, 'financial_lock');

  const endorsing = await correct({ amount: 10 }, {
    check: { ...checkRow, status: 'endorsements_in_progress', check_stage: 'endorsing' },
  });
  assert.equal(endorsing.ok, false);
  assert.equal(endorsing.error, 'amount_locked');
  assert.equal(isFinanciallyLocked({ deposited_at: '2026-09-01T00:00:00.000Z' }), true);
});

test('5) ordinary user cannot edit another tenant\'s check', async () => {
  const result = await correct({ carrier_name: 'Other' }, {
    mapping: mappingFor(OTHER_APP),
    memberships: [{ tenant_id: C1C_TENANT, role: 'staff', tenant_name: 'C1C', tenant_slug: 'c1c' }],
    roles: [{ role: 'staff' }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'cross_tenant');
});

test('6) status cannot be changed through review-correction', async () => {
  const result = await correct({ status: 'voided', check_stage: 'deposited' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'column_not_allowed');
  assert.ok(result.columns.includes('status'));
});

test('7) arbitrary columns cannot be supplied', async () => {
  const result = await correct({ moov_account_id: 'acct', cash_job_id: 'job' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'column_not_allowed');
  const micr = await correct({ routing_number: '021000021', account_number: '999' });
  assert.equal(micr.ok, false);
  assert.equal(micr.error, 'micr_not_enabled');
});

test('8) generic /data/write remains unable to change protected amount/MICR', async () => {
  assert.equal(INTAKE_PROHIBITED_COLUMNS.has('amount'), true);
  assert.equal(INTAKE_PROHIBITED_COLUMNS.has('routing_number'), true);
  assert.equal(INTAKE_PROHIBITED_COLUMNS.has('account_number'), true);
  assert.equal(WRITE_ALLOWLIST.check_intake_items.columns.has('amount'), false);
  const client = mockClient();
  const amount = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'check_intake_items',
    op: 'update',
    values: { amount: 12.34, routing_number: '021000021', account_number: '999' },
    filters: [{ column: 'id', op: 'eq', value: CHECK_ID }],
  }), depsFor(client));
  assert.equal(amount.error, 'column_not_allowlisted');
});

test('9) audit records actor and changed fields', async () => {
  const client = mockClient();
  const result = await handleReviewCorrection(jwtEvent('/workflow/review-correction', 'POST', {
    check_id: CHECK_ID,
    fields: { carrier_name: 'Travelers', amount: 42 },
    p_actor_id: OTHER_APP,
  }), depsFor(client));
  assert.equal(result.ok, true);
  assert.equal(client.store.audits.length, 1);
  assert.equal(client.store.audits[0].actor_id, APP_ID);
  assert.equal(client.store.audits[0].event_type, 'review_correction');
  assert.deepEqual(client.store.audits[0].event_data.field_changes.map((row) => row.field).sort(), ['amount', 'carrier_name']);
  assert.equal(client.store.audits[0].event_data.status_unchanged, true);
});

test('10) original OCR/extraction evidence is not overwritten', async () => {
  const client = mockClient();
  const originalFront = checkRow.raw_ocr_front;
  const originalBack = checkRow.raw_ocr_back;
  const result = await handleReviewCorrection(jwtEvent('/workflow/review-correction', 'POST', {
    check_id: CHECK_ID,
    fields: { amount: 77, carrier_name: 'Corrected Carrier', raw_ocr_front: { wiped: true } },
  }), depsFor(client));
  assert.equal(result.ok, false);
  assert.equal(result.error, 'column_not_allowed');

  const ok = await handleReviewCorrection(jwtEvent('/workflow/review-correction', 'POST', {
    check_id: CHECK_ID,
    fields: { amount: 77, carrier_name: 'Corrected Carrier' },
  }), depsFor(client));
  assert.equal(ok.ok, true);
  assert.deepEqual(client.store.check.raw_ocr_front, originalFront);
  assert.deepEqual(client.store.check.raw_ocr_back, originalBack);
  assert.equal(client.store.check.ocr_status, 'complete');
  const updateSql = client.queries.find((row) => /UPDATE public.check_intake_items/.test(row.sql))?.sql || '';
  const setSql = updateSql.split('RETURNING')[0];
  assert.equal(setSql.includes('raw_ocr_front'), false);
  assert.equal(setSql.includes('ocr_status'), false);
  assert.equal(ok.data.ocr_preserved, true);
});

test('11) payee edits remain consistent with canonical payee records', async () => {
  const inserted = mockClient();
  const create = await handleReviewCorrection(jwtEvent('/workflow/review-correction', 'POST', {
    check_id: CHECK_ID,
    fields: { payee_line: 'Jane Homeowner' },
  }), depsFor(inserted));
  assert.equal(create.ok, true);
  assert.equal(create.data.payee_sync.action, 'insert');
  assert.equal(inserted.store.payees[0].payee_name, 'Jane Homeowner');
  assert.equal(inserted.store.payees[0].payee_type, 'insured');

  const updated = mockClient({
    check: { ...checkRow, payee_line: 'Jane Homeowner' },
    payees: [{ id: 'payee-1', payee_name: 'Jane Homeowner', payee_type: 'insured' }],
  });
  const rename = await handleReviewCorrection(jwtEvent('/workflow/review-correction', 'POST', {
    check_id: CHECK_ID,
    fields: { payee_line: 'Jane Homeowner & Bank' },
  }), depsFor(updated));
  assert.equal(rename.ok, true);
  assert.equal(rename.data.payee_sync.action, 'update');
  assert.equal(updated.store.payees[0].payee_name, 'Jane Homeowner & Bank');

  const multi = mockClient({
    check: { ...checkRow, payee_line: 'A and B' },
    payees: [
      { id: 'p1', payee_name: 'A', payee_type: 'insured' },
      { id: 'p2', payee_name: 'B', payee_type: 'mortgage_company' },
    ],
  });
  const skip = await handleReviewCorrection(jwtEvent('/workflow/review-correction', 'POST', {
    check_id: CHECK_ID,
    fields: { payee_line: 'Something Else' },
  }), depsFor(multi));
  assert.equal(skip.data.payee_sync.action, 'skipped_multi');
  assert.equal(multi.store.payees[0].payee_name, 'A');
});

test('12) existing review decision/state-machine behavior is unchanged', async () => {
  const uploaded = { id: CHECK_ID, status: 'uploaded', claim_id: null };
  assert.equal(evaluateTransition('start_review', uploaded).ok, true);
  assert.equal(evaluateTransition('mark_ready_for_deposit', uploaded).error, 'invalid_transition');
  assert.equal(evaluateTransition('mark_deposited', uploaded).error, 'financial_or_provider');
  assert.equal(TRANSITIONS.return_to_review.toStatus, 'needs_review');
  assert.equal(mapReviewPath('approved_for_deposit').action, 'mark_ready_for_deposit');
  assert.equal(matchWorkflowRoute('POST', '/workflow/transition'), 'transition');
  assert.equal(matchWorkflowRoute('POST', '/workflow/review-correction'), 'review-correction');
  assert.deepEqual(matchWorkflowRoute('POST', `/workflow/checks/${CHECK_ID}/review-correction`), {
    kind: 'review-correction',
    checkId: CHECK_ID,
  });
  assert.notEqual(matchWorkflowRoute('POST', '/workflow/review-correction'), 'transition');
  assert.notEqual(matchWorkflowRoute('POST', '/workflow/admin-status-correction'), 'review-correction');

  const transition = await handleCheckTransition(jwtEvent('/workflow/transition', 'POST', {
    check_id: CHECK_ID,
    p_deposit_path: 'voided',
  }), depsFor(mockClient()));
  assert.equal(transition.error, 'not_in_tranche_5_machine');
});

test('review-correction is bridged, not on SAFE_WRITE_RPCS or generic /data/write', async () => {
  assert.equal(SAFE_WRITE_RPC_CLASSIFICATION.apply_check_review_correction, 'already_bridged');
  assert.equal(SAFE_WRITE_RPCS.has('apply_check_review_correction'), false);
  assert.equal(REVIEW_CORRECTION_ALLOWED_FIELDS.has('amount'), true);
  assert.equal(REVIEW_CORRECTION_ALLOWED_FIELDS.has('routing_number'), false);
  const rpc = await handleDataRpc(jwtEvent('/data/rpc', 'POST', {
    name: 'apply_check_review_correction',
    args: { p_check_id: CHECK_ID, p_fields: { amount: 1 } },
  }), depsFor(mockClient()));
  assert.equal(rpc.ok, false);
  assert.equal(rpc.error, 'rpc_disabled');
});

test('narrow review-correction grant covers amount and claim number only', () => {
  const sql = readFileSync(join(ROOT, 'aws/workflows/sql/71_review_correction_grants.sql'), 'utf8');
  const grantLine = sql.split('\n').find((line) => line.startsWith('GRANT UPDATE'));
  assert.match(grantLine, /GRANT UPDATE \(amount, detected_claim_number\)/);
  assert.equal(grantLine.includes('routing'), false);
  assert.equal(grantLine.includes('account'), false);
  assert.equal(grantLine.includes('deposited'), false);
  assert.equal(WRITE_ALLOWLIST.check_intake_items.columns.has('amount'), false);
});

test('Review UI exposes Edit Check and uses the dedicated correction helper', () => {
  const consoleSrc = readFileSync(join(ROOT, 'src/components/check-review/CheckReviewConsole.tsx'), 'utf8');
  const edit = readFileSync(join(ROOT, 'src/components/check-review/CheckAdminEditDialog.tsx'), 'utf8');
  const client = readFileSync(join(ROOT, 'src/integrations/aws/client.ts'), 'utf8');
  const helper = readFileSync(join(ROOT, 'src/lib/reviewCheckCorrection.ts'), 'utf8');
  assert.match(consoleSrc, /Edit Check/);
  assert.match(consoleSrc, /applyCheckReviewCorrection/);
  assert.match(edit, /applyCheckReviewCorrection/);
  assert.match(helper, /APPLY_CHECK_REVIEW_CORRECTION_RPC = "apply_check_review_correction"/);
  assert.match(client, /if \(name === "apply_check_review_correction"\)/);
  assert.match(client, /\/review-correction/);
  assert.equal(consoleSrc.includes('AWS staging cannot save amount'), false);
  assert.equal(WRITE_ALLOWLIST.check_intake_items.columns.has('amount'), false);
});
