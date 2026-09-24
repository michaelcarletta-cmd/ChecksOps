import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { handleCheckTransition, matchWorkflowRoute } from '../functions/api/workflow.mjs';
import { handleExternalDeposit, EXTERNAL_DEPOSIT_PROVIDER } from '../functions/api/workflow-external-deposit.mjs';
import { handleExternalPayment } from '../functions/api/workflow-external-payment.mjs';
import { handleWrite } from '../functions/api/write.mjs';
import { handleDataRpc } from '../functions/api/data.mjs';
import { LOOKUP_MAPPING_SQL, TENANT_MEMBERSHIP_SQL, USER_ROLES_SQL } from '../functions/api/identity.mjs';
import { IS_PLATFORM_OWNER_SQL } from '../functions/api/data.mjs';
import { SAFE_DEPOSIT_ACTIONS, SAFE_WRITE_RPCS, executeSafeWriteRpc } from '../functions/api/workflow-rpc.mjs';
import { FINANCIAL_OR_PROVIDER_TABLES, WRITE_ALLOWLIST } from '../functions/api/write-allowlist.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const APP_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const OTHER_APP = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const FREEDOM_TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const C1C_TENANT = '4f172140-f57a-4744-8050-95f4f07b13b4';
const CHECK_ID = '8d2b1c3e-4f5a-4678-9abc-def012345678';
const ITEM_ID = '9e3c2d4f-5a6b-4789-abcd-ef0123456789';
const BATCH_ID = 'ae4d3e5a-6b7c-4890-bcde-f01234567890';
const SPLIT_ID = 'bf5e4f6b-7c8d-4901-cdef-012345678901';

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
  status: 'approved_for_deposit',
  check_stage: 'ready_for_deposit',
  claim_id: null,
  deposited_at: null,
  amount: 1875.25,
  check_number: '4401',
  carrier_name: 'State Farm',
};

const mockClient = ({
  mapping = mappingFor(),
  memberships = [{ tenant_id: FREEDOM_TENANT, role: 'admin', tenant_name: 'Freedom', tenant_slug: 'freedom' }],
  roles = [{ role: 'admin' }],
  platformOwner = false,
  masterOwner = false,
  check = checkRow,
  depositItem = null,
  spent = 0,
  existingSplit = null,
  afterStage = null,
  failBatchInsert = false,
} = {}) => {
  const queries = [];
  let item = depositItem;
  return {
    queries,
    connect: async () => {},
    end: async () => {},
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (
        sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT' || sql === 'SET TRANSACTION READ WRITE'
        || /SAVEPOINT /.test(sql) || /RELEASE SAVEPOINT /.test(sql) || /ROLLBACK TO SAVEPOINT /.test(sql)
      ) {
        return { rows: [] };
      }
      if (/^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)/.test(sql)) return { rows: [] };
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
      if (/FROM public.deposit_items di/.test(sql)) {
        return { rows: item ? [{
          ...item,
          intake_id: check.id,
          tenant_id: check.tenant_id,
          check_status: check.status,
          check_stage: check.check_stage,
          check_amount: check.amount,
          check_number: check.check_number,
          carrier_name: check.carrier_name,
          claim_id: check.claim_id,
          deposited_at: check.deposited_at,
        }] : [] };
      }
      if (/FROM public.deposit_items/.test(sql) && /SELECT id, status/.test(sql)) {
        return { rows: item ? [item] : [] };
      }
      if (/INSERT INTO public.deposit_items/.test(sql)) {
        item = {
          id: ITEM_ID,
          status: 'pending_assignment',
          amount: check.amount,
          check_id: check.id,
          provider: EXTERNAL_DEPOSIT_PROVIDER,
          batch_id: null,
          cleared_at: null,
        };
        return { rows: [item] };
      }
      if (/INSERT INTO public.deposit_batches/.test(sql)) {
        if (failBatchInsert) {
          const error = new Error('new row violates row-level security policy for table "deposit_batches"');
          error.code = '42501';
          throw error;
        }
        return { rows: [{ id: BATCH_ID }] };
      }
      if (/UPDATE public.deposit_items/.test(sql)) {
        item = {
          ...(item || {}),
          id: ITEM_ID,
          status: 'succeeded',
          provider: EXTERNAL_DEPOSIT_PROVIDER,
          batch_id: params[2] || item?.batch_id || BATCH_ID,
          cleared_at: params[3],
          amount: item?.amount ?? check.amount,
        };
        return { rows: [item] };
      }
      if (/UPDATE public.deposit_batches/.test(sql)) return { rows: [] };
      if (/INSERT INTO public.deposit_audit_log/.test(sql)) return { rows: [{ id: 'deposit-audit' }] };
      if (/UPDATE public.check_intake_items/.test(sql) && /status = 'deposited'/.test(sql)) {
        return {
          rows: [{
            ...check,
            status: 'deposited',
            check_stage: 'deposited',
            deposited_at: '2026-09-23T21:00:00.000Z',
          }],
        };
      }
      if (/UPDATE public.check_intake_items/.test(sql)) {
        return {
          rows: [{
            ...check,
            status: params?.[1] || check.status,
            check_stage: params?.[2] || check.check_stage,
          }],
        };
      }
      if (/FROM public.check_intake_items/.test(sql) && /SELECT status, check_stage/.test(sql)) {
        return { rows: [{ status: check.status, check_stage: afterStage || check.check_stage }] };
      }
      if (/FROM public.check_intake_items/.test(sql) && /SELECT id, tenant_id, uploaded_by/.test(sql)) {
        return { rows: check ? [check] : [] };
      }
      if (/AS received_amount/.test(sql) || /disbursed_amount/.test(sql)) {
        return {
          rows: check ? [{
            check_id: check.id,
            tenant_id: check.tenant_id,
            status: check.status,
            check_stage: check.check_stage,
            received_amount: check.amount,
            pa_fee_pct: null,
            pa_fee_amount: null,
            disbursed_amount: spent,
            in_transit_amount: 0,
          }] : [],
        };
      }
      if (/FROM public.check_intake_items/.test(sql)) {
        return { rows: check ? [check] : [] };
      }
      if (/FROM public.disbursement_splits s/.test(sql) && /lower\(s.recipient_name\)/.test(sql)) {
        return { rows: existingSplit ? [existingSplit] : [] };
      }
      if (/FROM public.disbursement_splits s/.test(sql) && /ORDER BY s.created_at/.test(sql)) {
        return { rows: existingSplit ? [existingSplit] : [] };
      }
      if (/FROM public.disbursement_splits s/.test(sql) && /external_check_number/.test(sql)) {
        return { rows: existingSplit ? [existingSplit] : [] };
      }
      if (/FROM public.disbursement_splits s/.test(sql) && /COALESCE\(SUM/.test(sql)) {
        return { rows: [{ spent }] };
      }
      if (/INSERT INTO public.disbursement_batches/.test(sql)) return { rows: [{ id: BATCH_ID }] };
      if (/INSERT INTO public.disbursement_splits/.test(sql)) {
        return {
          rows: [{
            id: SPLIT_ID,
            amount: params[2],
            status: 'settled',
            method: 'external_check',
            recipient_name: params[4],
            external_check_number: params[3],
          }],
        };
      }
      if (/UPDATE public.claim_checks/.test(sql)) return { rows: [] };
      if (/INSERT INTO public.check_audit_log/.test(sql)) return { rows: [{ id: 'audit' }] };
      if (/FROM public.check_payees/.test(sql) || /FROM public.check_endorsements/.test(sql)) return { rows: [] };
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

test('workflow routes dedicated external recording paths', () => {
  assert.equal(matchWorkflowRoute('POST', '/workflow/external-deposit'), 'external-deposit');
  assert.equal(matchWorkflowRoute('POST', '/workflow/external-payment'), 'external-payment');
  assert.deepEqual(matchWorkflowRoute('POST', `/workflow/checks/${CHECK_ID}/external-deposit`), {
    kind: 'external-deposit',
    checkId: CHECK_ID,
  });
  assert.deepEqual(matchWorkflowRoute('POST', `/workflow/checks/${CHECK_ID}/external-payment`), {
    kind: 'external-payment',
    checkId: CHECK_ID,
  });
});

test('Review to Endorse transition returns new_stage on data', async () => {
  const client = mockClient({
    check: { ...checkRow, status: 'needs_review', check_stage: 'review' },
  });
  const result = await handleCheckTransition(jwtEvent('/workflow/transition', 'POST', {
    check_id: CHECK_ID,
    p_deposit_path: 'endorsements_in_progress',
    p_reviewer_id: OTHER_APP,
  }), depsFor(client));
  assert.equal(result.ok, true);
  assert.equal(result.data.new_stage, 'endorsing');
  assert.equal(result.data.new_status, 'endorsements_in_progress');
  assert.equal(result.toStage, 'endorsing');
});

test('return_to_review from endorsing returns new_stage review', async () => {
  const client = mockClient({
    check: { ...checkRow, status: 'endorsements_in_progress', check_stage: 'endorsing' },
  });
  const result = await handleCheckTransition(jwtEvent('/workflow/transition', 'POST', {
    check_id: CHECK_ID,
    action: 'return_to_review',
  }), depsFor(client));
  assert.equal(result.ok, true);
  assert.equal(result.data.new_stage, 'review');
  assert.equal(result.data.new_status, 'needs_review');
});

test('external deposit records manual_branch without CheckAlt', async () => {
  const client = mockClient();
  const result = await handleExternalDeposit(jwtEvent(`/workflow/checks/${CHECK_ID}/external-deposit`, 'POST', {
    check_id: CHECK_ID,
    notes: 'Deposited at branch',
  }), depsFor(client));
  assert.equal(result.ok, true);
  assert.equal(result.data.ok, true);
  assert.equal(result.data.new_status, 'deposited');
  assert.equal(result.data.new_stage, 'deposited');
  assert.equal(result.data.provider, EXTERNAL_DEPOSIT_PROVIDER);
  assert.equal(result.providerExecution, false);
  assert.equal(result.checkAltInvoked, false);
  assert.equal(result.data.actor_id, APP_ID);
  assert.equal(client.queries.some((q) => /checkalt_deposits|checkalt_config|FROM public\.checkalt/i.test(q.sql)), false);
  const itemUpdate = client.queries.find((q) => /UPDATE public.deposit_items/.test(q.sql));
  assert.match(itemUpdate.sql, /status = 'succeeded'/);
  assert.equal(itemUpdate.params.includes(OTHER_APP), false);
});

test('external deposit still records when deposit_batches insert is RLS-denied', async () => {
  const client = mockClient({ failBatchInsert: true });
  const result = await handleExternalDeposit(jwtEvent(`/workflow/checks/${CHECK_ID}/external-deposit`, 'POST', {
    check_id: CHECK_ID,
    notes: 'Deposited at branch without batch',
  }), depsFor(client));
  assert.equal(result.ok, true);
  assert.equal(result.data.new_status, 'deposited');
  assert.equal(result.data.new_stage, 'deposited');
  assert.equal(result.checkAltInvoked, false);
  assert.equal(client.queries.some((q) => /ROLLBACK TO SAVEPOINT external_deposit_batch/.test(q.sql)), true);
});

test('external deposit is idempotent when already deposited', async () => {
  const client = mockClient({
    check: { ...checkRow, status: 'deposited', check_stage: 'deposited', deposited_at: '2026-09-23T12:00:00Z' },
    depositItem: {
      id: ITEM_ID,
      status: 'succeeded',
      amount: 1875.25,
      check_id: CHECK_ID,
      provider: 'manual_branch',
      batch_id: BATCH_ID,
      cleared_at: '2026-09-23T12:00:00Z',
    },
  });
  const result = await handleExternalDeposit(jwtEvent('/workflow/external-deposit', 'POST', {
    check_id: CHECK_ID,
  }), depsFor(client));
  assert.equal(result.ok, true);
  assert.equal(result.data.unchanged, true);
  assert.equal(client.queries.some((q) => /UPDATE public.check_intake_items/.test(q.sql)), false);
});

test('external deposit rejects review-state checks without a deposit item', async () => {
  const result = await handleExternalDeposit(jwtEvent('/workflow/external-deposit', 'POST', {
    check_id: CHECK_ID,
  }), depsFor(mockClient({ check: { ...checkRow, status: 'needs_review', check_stage: 'review' } })));
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid_status');
});

test('external deposit rejects unknown fields and spoofed actor', async () => {
  const deniedFields = await handleExternalDeposit(jwtEvent('/workflow/external-deposit', 'POST', {
    check_id: CHECK_ID,
    status: 'deposited',
  }), depsFor(mockClient()));
  assert.equal(deniedFields.error, 'field_not_allowlisted');

  const client = mockClient();
  const ok = await handleExternalDeposit(jwtEvent('/workflow/external-deposit', 'POST', {
    check_id: CHECK_ID,
    notes: 'ok',
  }), depsFor(client));
  assert.equal(ok.ok, true);
  assert.equal(ok.data.actor_id, APP_ID);
});

test('external payment records settled split without Moov', async () => {
  const client = mockClient({ check: { ...checkRow, status: 'deposited', check_stage: 'deposited' } });
  const unknown = await handleExternalPayment(jwtEvent(`/workflow/checks/${CHECK_ID}/external-payment`, 'POST', {
    check_id: CHECK_ID,
    recipient_name: 'ABC Roofing',
    amount: 500,
    external_check_number: '9911',
    moov_transfer_id: 'should-not-be-accepted',
  }), depsFor(client));
  assert.equal(unknown.error, 'field_not_allowlisted');

  const clean = await handleExternalPayment(jwtEvent(`/workflow/checks/${CHECK_ID}/external-payment`, 'POST', {
    check_id: CHECK_ID,
    recipient_name: 'ABC Roofing',
    recipient_type: 'vendor',
    amount: 500,
    external_check_number: '9911',
    notes: 'Paid at branch',
    created_by: OTHER_APP,
  }), depsFor(client));
  assert.equal(clean.ok, true);
  assert.equal(clean.data.split_id, SPLIT_ID);
  assert.equal(clean.data.remaining, 1375.25);
  assert.equal(clean.data.actor_id, APP_ID);
  assert.equal(clean.moovInvoked, false);
  assert.equal(clean.providerExecution, false);
  const batch = client.queries.find((q) => /INSERT INTO public.disbursement_batches/.test(q.sql));
  assert.equal(batch.params[2], APP_ID);
  assert.match(batch.sql, /rail/);
  const split = client.queries.find((q) => /INSERT INTO public.disbursement_splits/.test(q.sql));
  assert.match(split.sql, /external_check/);
  assert.match(split.sql, /settled/);
  assert.equal(split.sql.includes('moov_transfer_id'), false);
});

test('external payment rejects amount above remaining and is idempotent', async () => {
  const over = await handleExternalPayment(jwtEvent('/workflow/external-payment', 'POST', {
    check_id: CHECK_ID,
    recipient_name: 'ABC Roofing',
    amount: 2000,
    external_check_number: '12',
  }), depsFor(mockClient({ spent: 0 })));
  assert.equal(over.error, 'amount_exceeds_available');

  const existing = await handleExternalPayment(jwtEvent('/workflow/external-payment', 'POST', {
    check_id: CHECK_ID,
    recipient_name: 'ABC Roofing',
    amount: 500,
    external_check_number: '9911',
  }), depsFor(mockClient({
    existingSplit: { id: SPLIT_ID, batch_id: BATCH_ID, amount: 500, status: 'settled', external_check_number: '9911', recipient_name: 'ABC Roofing' },
  })));
  assert.equal(existing.ok, true);
  assert.equal(existing.data.unchanged, true);
});

test('generic write and deposit_action stay closed for money paths', async () => {
  assert.equal(WRITE_ALLOWLIST.disbursement_batches, undefined);
  assert.equal(WRITE_ALLOWLIST.disbursement_splits, undefined);
  assert.equal(FINANCIAL_OR_PROVIDER_TABLES.has('disbursement_batches'), true);
  assert.equal(FINANCIAL_OR_PROVIDER_TABLES.has('disbursement_splits'), true);
  assert.deepEqual([...SAFE_DEPOSIT_ACTIONS].sort(), ['assign_provider', 'prepare_deposit']);
  assert.equal(SAFE_WRITE_RPCS.has('record_external_deposit'), false);
  assert.equal(SAFE_WRITE_RPCS.has('record_external_payment'), false);

  const client = mockClient();
  const write = await handleWrite(jwtEvent('/data/write', 'POST', {
    table: 'disbursement_splits',
    op: 'insert',
    values: { amount: 1, status: 'settled' },
  }), depsFor(client));
  assert.equal(write.ok, false);
  assert.ok(['table_not_allowlisted', 'financial_or_provider'].includes(write.error) || write.error === 'table_not_allowlisted');

  const mark = await executeSafeWriteRpc({
    client,
    mapping: mappingFor(),
    name: 'deposit_action',
    args: { p_action: 'mark_manual_deposit', p_deposit_item_id: ITEM_ID },
  });
  assert.equal(mark.error, 'rpc_financial_disabled');

  const rpc = await handleDataRpc(jwtEvent('/data/rpc', 'POST', {
    name: 'record_external_payment',
    args: { p_check_id: CHECK_ID },
  }), depsFor(client));
  assert.equal(rpc.ok, false);
  assert.equal(rpc.error, 'rpc_disabled');
});

test('SPA bridges recording RPCs and does not allowlist disbursement tables', () => {
  const clientSrc = readFileSync(join(ROOT, 'src/integrations/aws/client.ts'), 'utf8');
  assert.match(clientSrc, /record_external_deposit/);
  assert.match(clientSrc, /record_external_payment/);
  assert.match(clientSrc, /mark_manual_deposit/);
  assert.match(clientSrc, /\/workflow\/checks\/\$\{encodeURIComponent\(checkId\)\}\/external-deposit/);
  assert.match(clientSrc, /\/workflow\/checks\/\$\{encodeURIComponent\(checkId\)\}\/external-payment/);
  assert.doesNotMatch(clientSrc, /"disbursement_batches"/);
  assert.doesNotMatch(clientSrc, /"disbursement_splits"/);
  const ccc = readFileSync(join(ROOT, 'src/pages/CheckCommandCenter.tsx'), 'utf8');
  assert.match(ccc, /endorsements_in_progress/);
  assert.match(ccc, /record_external_deposit/);
  assert.match(ccc, /handleUndoDecision/);
  const funds = readFileSync(join(ROOT, 'src/components/payments/FundsTab.tsx'), 'utf8');
  assert.match(funds, /record_external_payment/);
  assert.doesNotMatch(funds, /disbursement_batches"\)\s*\n\s*\.insert/);
  assert.doesNotMatch(funds, /disbursement_splits"\)\s*\.insert/);
});

test('external recording grants are narrow and do not activate providers', () => {
  const sql = readFileSync(join(ROOT, 'aws/workflows/sql/72_external_recording_grants.sql'), 'utf8');
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE[\s\S]*deposit_items/);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE[\s\S]*disbursement_batches/);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE[\s\S]*disbursement_splits/);
  assert.doesNotMatch(sql, /GRANT EXECUTE/);
  assert.doesNotMatch(sql, /ON TABLE public\.(checkalt_deposits|payment_transfers)/);
  assert.match(sql, /DROP POLICY IF EXISTS aws_write_deposit_batches ON public.deposit_batches/);
  assert.match(sql, /created_by = auth.uid\(\)/);
});
