import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { childFk } from '../functions/api/data.mjs';
import { matchWorkflowRoute } from '../functions/api/workflow.mjs';
import {
  computeFundsFromRow,
  handleFundsSummary,
  loadCheckFunds,
  toCents,
} from '../functions/api/workflow-funds-summary.mjs';
import { handleExternalPayment } from '../functions/api/workflow-external-payment.mjs';
import { LOOKUP_MAPPING_SQL, TENANT_MEMBERSHIP_SQL, USER_ROLES_SQL } from '../functions/api/identity.mjs';
import { IS_PLATFORM_OWNER_SQL } from '../functions/api/data.mjs';
import { SAFE_WRITE_RPCS } from '../functions/api/workflow-rpc.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const APP_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const OTHER_APP = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const FREEDOM_TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const C1C_TENANT = '4f172140-f57a-4744-8050-95f4f07b13b4';
const CHECK_ID = '31afc7c3-a9cd-436b-a902-0899dd98caae';
const OTHER_CHECK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BATCH_ID = '37220f8e-3fb5-4cff-bd55-8575d3192518';
const SPLIT_ID = '0ffb22e8-ee3a-489e-8ccf-8fdd4be779eb';

const jwtEvent = (path, method, body, extra = {}) => ({
  rawPath: path,
  headers: {
    authorization: extra.auth === null ? undefined : 'Bearer test-id-token',
    'x-user-id': OTHER_APP,
    'x-tenant-id': C1C_TENANT,
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

const mappingFor = () => ({
  application_user_id: APP_ID,
  cognito_sub: COGNITO_SUB,
  email: 'checksops-tester@freedomadj.com',
  status: 'active',
});

const mockClient = ({
  checkAmount = 2250,
  tenantId = FREEDOM_TENANT,
  checkId = CHECK_ID,
  checkStage = 'funds_released',
  splits = [],
  memberships = [{ tenant_id: FREEDOM_TENANT, role: 'admin' }],
  roles = [{ role: 'admin' }],
} = {}) => {
  const queries = [];
  return {
    queries,
    connect: async () => {},
    end: async () => {},
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (
        sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT' || sql === 'SET TRANSACTION READ WRITE'
        || /SAVEPOINT /.test(sql)
      ) return { rows: [] };
      if (sql.startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
      if (sql === LOOKUP_MAPPING_SQL) return { rows: [mappingFor()] };
      if (sql === TENANT_MEMBERSHIP_SQL) return { rows: memberships };
      if (sql === USER_ROLES_SQL) return { rows: roles };
      if (sql === IS_PLATFORM_OWNER_SQL) return { rows: [{ is_owner: true }] };
      if (/SELECT public.is_master_owner/.test(sql)) return { rows: [{ is_master: false }] };
      if (/SELECT role FROM public.tenant_users/.test(sql)) {
        return { rows: params?.[1] === tenantId ? [{ role: 'admin' }] : [] };
      }
      if (/AS received_amount/.test(sql) || /disbursed_amount/.test(sql)) {
        const id = params?.[0];
        if (id !== checkId) return { rows: [] };
        const disbursed = splits
          .filter((s) => !['failed', 'cancelled', 'returned', 'voided'].includes(s.status))
          .reduce((sum, s) => sum + Number(s.amount || 0), 0);
        const inTransit = splits
          .filter((s) => s.status === 'pending' || s.status === 'submitted')
          .reduce((sum, s) => sum + Number(s.amount || 0), 0);
        return {
          rows: [{
            check_id: checkId,
            tenant_id: tenantId,
            status: 'deposited',
            check_stage: checkStage,
            received_amount: checkAmount,
            pa_fee_pct: null,
            pa_fee_amount: null,
            disbursed_amount: disbursed,
            in_transit_amount: inTransit,
          }],
        };
      }
      if (/FROM public.disbursement_splits s/.test(sql) && /lower\(s.recipient_name\)/.test(sql)) {
        return { rows: [] };
      }
      if (/FROM public.disbursement_splits s/.test(sql) && /JOIN public.disbursement_batches/.test(sql)
        && /SELECT s.id/.test(sql) && /ORDER BY s.created_at/.test(sql)) {
        if (params?.[0] !== checkId || params?.[1] !== tenantId) return { rows: [] };
        return { rows: splits };
      }
      if (/FROM public.check_intake_items/.test(sql) && /FOR UPDATE/.test(sql)) {
        return {
          rows: [{
            id: checkId,
            tenant_id: tenantId,
            status: 'deposited',
            check_stage: checkStage,
            amount: checkAmount,
            deposited_at: '2026-09-23T21:57:15.945Z',
          }],
        };
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

const settledExternal = {
  id: SPLIT_ID,
  batch_id: BATCH_ID,
  amount: 100,
  status: 'settled',
  method: 'external_check',
  rail: 'external',
  external_check_number: 'UI-XCHK-1',
  recipient_name: 'Accept Vendo',
  recipient_type: 'vendor',
  tenant_id: FREEDOM_TENANT,
};

test('childFk uses batch_id for disbursement split embeds', () => {
  assert.equal(childFk('disbursement_batches', 'disbursement_splits'), 'batch_id');
  assert.equal(childFk('disbursement_batches', 'disbursement_splits') === 'disbursement_batche_id', false);
});

test('workflow routes funds-summary', () => {
  assert.deepEqual(matchWorkflowRoute('POST', `/workflow/checks/${CHECK_ID}/funds-summary`), {
    kind: 'funds-summary',
    checkId: CHECK_ID,
  });
  assert.equal(SAFE_WRITE_RPCS.has('get_check_funds_summary'), false);
});

test('$2250 received + $100 settled external = disbursed 100 available 2150', async () => {
  const client = mockClient({ splits: [settledExternal] });
  const result = await handleFundsSummary(jwtEvent(`/workflow/checks/${CHECK_ID}/funds-summary`, 'POST', {
    check_id: CHECK_ID,
  }), depsFor(client));
  assert.equal(result.ok, true);
  assert.equal(result.data.received, 2250);
  assert.equal(result.data.disbursed, 100);
  assert.equal(result.data.available, 2150);
  assert.equal(result.data.payments.length, 1);
  assert.equal(result.data.payments[0].external_check_number, 'UI-XCHK-1');
  assert.equal(result.moovInvoked, false);
});

test('multiple external payments aggregate', () => {
  const totals = computeFundsFromRow({
    check_id: CHECK_ID,
    tenant_id: FREEDOM_TENANT,
    received_amount: 2250,
    disbursed_amount: 100 + 250.5,
    in_transit_amount: 0,
  });
  assert.equal(totals.disbursed, 350.5);
  assert.equal(totals.available, 1899.5);
});

test('provider and external settled payments aggregate together', () => {
  const totals = computeFundsFromRow({
    check_id: CHECK_ID,
    tenant_id: FREEDOM_TENANT,
    received_amount: 2250,
    disbursed_amount: 100 + 400,
    in_transit_amount: 0,
  });
  assert.equal(totals.received, 2250);
  assert.equal(totals.disbursed, 500);
  assert.equal(totals.available, 1750);
});

test('failed cancelled voided payments do not reduce available', () => {
  const clientSplits = [
    { ...settledExternal, amount: 100 },
    { ...settledExternal, id: 'failed-1', amount: 50, status: 'failed', rail: 'moov', method: 'ach' },
    { ...settledExternal, id: 'cancel-1', amount: 75, status: 'cancelled' },
    { ...settledExternal, id: 'void-1', amount: 25, status: 'voided' },
  ];
  const disbursed = clientSplits
    .filter((s) => !['failed', 'cancelled', 'returned', 'voided'].includes(s.status))
    .reduce((sum, s) => sum + s.amount, 0);
  const totals = computeFundsFromRow({
    check_id: CHECK_ID,
    received_amount: 2250,
    disbursed_amount: disbursed,
    in_transit_amount: 0,
  });
  assert.equal(totals.disbursed, 100);
  assert.equal(totals.available, 2150);
});

test('duplicate/idempotent submission cannot double-count', async () => {
  const once = computeFundsFromRow({
    check_id: CHECK_ID,
    received_amount: 2250,
    disbursed_amount: 100,
    in_transit_amount: 0,
  });
  const again = computeFundsFromRow({
    check_id: CHECK_ID,
    received_amount: 2250,
    disbursed_amount: 100,
    in_transit_amount: 0,
  });
  assert.deepEqual(once, again);
  assert.equal(toCents(once.disbursed + once.available), 2250);
});

test('tenant and check isolation', async () => {
  const client = mockClient({ splits: [settledExternal] });
  const other = await loadCheckFunds(client, { checkId: OTHER_CHECK });
  assert.equal(other.error, 'not_found');

  const cross = mockClient({
    splits: [settledExternal],
    memberships: [{ tenant_id: C1C_TENANT, role: 'admin' }],
    roles: [],
  });
  cross.query = async (sql, params) => {
    if (sql === IS_PLATFORM_OWNER_SQL) return { rows: [{ is_owner: false }] };
    if (/SELECT public.is_master_owner/.test(sql)) return { rows: [{ is_master: false }] };
    if (sql === LOOKUP_MAPPING_SQL) return { rows: [mappingFor()] };
    if (sql === USER_ROLES_SQL) return { rows: [] };
    if (/SELECT role FROM public.tenant_users/.test(sql)) return { rows: [] };
    if (sql.startsWith('SELECT set_config') || sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') {
      return { rows: [] };
    }
    if (/AS received_amount/.test(sql)) {
      return {
        rows: [{
          check_id: CHECK_ID,
          tenant_id: FREEDOM_TENANT,
          status: 'deposited',
          check_stage: 'funds_released',
          received_amount: 2250,
          disbursed_amount: 100,
          in_transit_amount: 0,
        }],
      };
    }
    if (/SELECT s.id/.test(sql)) return { rows: [settledExternal] };
    return { rows: [] };
  };
  const denied = await handleFundsSummary(jwtEvent(`/workflow/checks/${CHECK_ID}/funds-summary`, 'POST', {
    check_id: CHECK_ID,
  }), depsFor(cross));
  assert.equal(denied.ok, false);
  assert.equal(denied.error, 'cross_tenant');
});

test('reload returns the same totals', async () => {
  const client = mockClient({ splits: [settledExternal] });
  const first = await handleFundsSummary(jwtEvent(`/workflow/checks/${CHECK_ID}/funds-summary`, 'POST', {
    check_id: CHECK_ID,
  }), depsFor(client));
  const second = await handleFundsSummary(jwtEvent(`/workflow/checks/${CHECK_ID}/funds-summary`, 'POST', {
    check_id: CHECK_ID,
  }), depsFor(client));
  assert.equal(first.data.received, second.data.received);
  assert.equal(first.data.disbursed, second.data.disbursed);
  assert.equal(first.data.available, second.data.available);
});

test('SPA uses the dedicated funds-summary path and does not write disbursement tables', () => {
  const clientSrc = readFileSync(join(ROOT, 'src/integrations/aws/client.ts'), 'utf8');
  assert.match(clientSrc, /get_check_funds_summary/);
  assert.match(clientSrc, /\/funds-summary/);
  const funds = readFileSync(join(ROOT, 'src/components/payments/FundsTab.tsx'), 'utf8');
  assert.match(funds, /get_check_funds_summary/);
  assert.match(funds, /check-funds-summary/);
  assert.doesNotMatch(funds, /disbursement_splits"\)\s*\.insert/);
});

test('external payment remaining uses canonical funds accounting', async () => {
  const client = mockClient({ splits: [settledExternal] });
  const result = await handleExternalPayment(jwtEvent(`/workflow/checks/${CHECK_ID}/external-payment`, 'POST', {
    check_id: CHECK_ID,
    recipient_name: 'Second Vendor',
    recipient_type: 'vendor',
    amount: 2200,
    external_check_number: 'TOO-MUCH',
  }), depsFor(client));
  assert.equal(result.ok, false);
  assert.equal(result.error, 'amount_exceeds_available');
  assert.equal(result.available, 2150);
});

test('pending and submitted payments count as disbursed under existing Funds tab semantics', () => {
  const totals = computeFundsFromRow({
    check_id: CHECK_ID,
    received_amount: 2250,
    disbursed_amount: 100 + 50,
    in_transit_amount: 50,
  });
  assert.equal(totals.disbursed, 150);
  assert.equal(totals.in_transit, 50);
  assert.equal(totals.available, 2100);
});
