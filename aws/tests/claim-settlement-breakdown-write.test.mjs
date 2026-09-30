/**
 * Adversarial tests for the dedicated Claim Ledger settlement-breakdown writer.
 * Does not mark the capability accepted. Does not deploy.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { handleWrite } from '../functions/api/write.mjs';
import { WRITE_ALLOWLIST, denyTableReason } from '../functions/api/write-allowlist.mjs';
import { financialPermissionsActivated } from '../functions/api/financial-flags.mjs';
import { SAFE_WRITE_RPCS, executeSafeWriteRpc } from '../functions/api/workflow-rpc.mjs';
import {
  SETTLEMENT_BREAKDOWN_COLUMNS,
  computeSettlementAcv,
  executeClaimSettlementBreakdownWrite,
  parseSettlementBreakdownInput,
} from '../functions/api/write-claim-settlement.mjs';
import { LOOKUP_MAPPING_SQL } from '../functions/api/identity.mjs';
import { executeSignatureWrite } from '../functions/api/write-signature.mjs';
import { executeTenantsCreate } from '../functions/api/write-app-metadata.mjs';

const APP_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const CLAIM_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FOREIGN_CLAIM = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const SETTLEMENT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const BASE_AMOUNTS = Object.fromEntries(SETTLEMENT_BREAKDOWN_COLUMNS.map((column) => [column, 0]));
const DWELLING = {
  ...BASE_AMOUNTS,
  replacement_cost_value: 10000,
  recoverable_depreciation: 1000,
  non_recoverable_depreciation: 500,
  deductible: 250,
};

const CLIENT_SRC = readFileSync('src/integrations/aws/client.ts', 'utf8');
const WRITE_SRC = readFileSync('aws/functions/api/write.mjs', 'utf8');
const WORKFLOW_SRC = readFileSync('aws/functions/api/workflow-rpc.mjs', 'utf8');
const ALLOWLIST_SRC = readFileSync('aws/functions/api/write-allowlist.mjs', 'utf8');

const jwtEvent = (path, body) => ({
  rawPath: path,
  headers: { authorization: 'Bearer test-id-token' },
  body: JSON.stringify(body),
  requestContext: {
    stage: 'staging',
    http: { method: 'POST', path },
    authorizer: { jwt: { claims: { sub: COGNITO_SUB, email: 'tester@freedomadj.com', token_use: 'id' } } },
  },
});

const mockWriteClient = () => {
  const queries = [];
  return {
    queries,
    connect: async () => {},
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT' || sql === 'SET TRANSACTION READ WRITE') {
        return { rows: [] };
      }
      if (sql.startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
      if (sql === LOOKUP_MAPPING_SQL) {
        return { rows: [{ application_user_id: APP_ID, cognito_sub: COGNITO_SUB, email: 'tester@freedomadj.com', status: 'active' }] };
      }
      return { rows: [] };
    },
  };
};

const settlementClient = ({
  claim = { id: CLAIM_ID, org_id: TENANT },
  member = true,
  canWrite = true,
  existing = [],
  foreignById = null,
} = {}) => {
  const queries = [];
  return {
    queries,
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/FROM public.claims/.test(sql) && /FOR UPDATE/.test(sql)) {
        return { rows: claim ? [claim] : [] };
      }
      if (/aws_can_write_claim/.test(sql)) return { rows: [{ allowed: canWrite }] };
      if (/FROM public.tenant_users/.test(sql)) return { rows: member ? [{ ok: 1 }] : [] };
      if (/FROM public.claim_settlements/.test(sql) && /ORDER BY/.test(sql)) {
        return { rows: existing };
      }
      if (/FROM public.claim_settlements/.test(sql) && /WHERE id =/.test(sql)) {
        return { rows: foreignById ? [foreignById] : [] };
      }
      if (/INSERT INTO public.claim_settlements/.test(sql)) {
        const row = { id: SETTLEMENT_ID, claim_id: params[0], created_by: params[1] };
        SETTLEMENT_BREAKDOWN_COLUMNS.forEach((column, index) => {
          row[column] = params[index + 2];
        });
        return { rows: [row] };
      }
      if (/UPDATE public.claim_settlements/.test(sql)) {
        const row = { id: params[0], claim_id: params[1] };
        SETTLEMENT_BREAKDOWN_COLUMNS.forEach((column, index) => {
          row[column] = params[index + 2];
        });
        return { rows: [row] };
      }
      if (/UPDATE public.check_intake_items|INSERT INTO public.claim_payments|INSERT INTO public.claim_disbursements|UPDATE public.tenants/.test(sql)) {
        throw new Error('forbidden side-effect SQL');
      }
      return { rows: [] };
    },
  };
};

test('authorized same-tenant INSERT succeeds and server-owns created_by', async () => {
  const client = settlementClient({ existing: [] });
  const result = await executeClaimSettlementBreakdownWrite({
    client,
    mapping: { application_user_id: APP_ID },
    args: { claim_id: CLAIM_ID, created_by: '00000000-0000-4000-8000-000000000099', ...DWELLING },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.data.claim_id, CLAIM_ID);
  assert.equal(result.data.created_by, APP_ID);
  assert.equal(result.data.replacement_cost_value, 10000);
  assert.equal(result.data.derived_acv.dwelling, 8250);
  const insert = client.queries.find((q) => /INSERT INTO public.claim_settlements/.test(q.sql));
  assert.ok(insert);
  assert.equal(insert.params[1], APP_ID);
  assert.equal(client.queries.some((q) => /check_intake_items|claim_payments|claim_disbursements/.test(q.sql)), false);
});

test('authorized same-tenant UPDATE succeeds and does not insert a second row', async () => {
  const client = settlementClient({
    existing: [{ id: SETTLEMENT_ID, claim_id: CLAIM_ID }],
  });
  const result = await executeClaimSettlementBreakdownWrite({
    client,
    mapping: { application_user_id: APP_ID },
    args: { claim_id: CLAIM_ID, id: SETTLEMENT_ID, ...DWELLING, other_structures_rcv: 400 },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.data.id, SETTLEMENT_ID);
  assert.equal(result.data.other_structures_rcv, 400);
  assert.equal(client.queries.some((q) => /INSERT INTO public.claim_settlements/.test(q.sql)), false);
  assert.ok(client.queries.some((q) => /UPDATE public.claim_settlements/.test(q.sql)));
});

test('foreign tenant denied', async () => {
  const client = settlementClient({
    claim: { id: CLAIM_ID, org_id: TENANT },
    member: false,
    canWrite: false,
  });
  const result = await executeClaimSettlementBreakdownWrite({
    client,
    mapping: { application_user_id: APP_ID },
    args: { claim_id: CLAIM_ID, ...DWELLING },
  });
  assert.equal(result.error, 'not_authorized');
  assert.equal(client.queries.some((q) => /INSERT INTO|UPDATE public.claim_settlements/.test(q.sql)), false);
});

test('unauthorized / missing claim denied', async () => {
  const client = settlementClient({ claim: null });
  const result = await executeClaimSettlementBreakdownWrite({
    client,
    mapping: { application_user_id: APP_ID },
    args: { claim_id: FOREIGN_CLAIM, ...DWELLING },
  });
  assert.equal(result.error, 'rls_denied');
});

test('unknown column denied', () => {
  const parsed = parseSettlementBreakdownInput({
    claim_id: CLAIM_ID,
    replacement_cost_value: 1,
    mystery_column: 'nope',
  });
  assert.equal(parsed.error, 'unknown_column');
  assert.deepEqual(parsed.columns, ['mystery_column']);
});

test('negative value denied', () => {
  const parsed = parseSettlementBreakdownInput({
    claim_id: CLAIM_ID,
    replacement_cost_value: -1,
  });
  assert.equal(parsed.error, 'invalid_field');
  assert.equal(parsed.field, 'replacement_cost_value');
});

test('NaN / infinite / non-numeric denied', () => {
  assert.equal(parseSettlementBreakdownInput({
    claim_id: CLAIM_ID,
    replacement_cost_value: Number.NaN,
  }).error, 'invalid_field');
  assert.equal(parseSettlementBreakdownInput({
    claim_id: CLAIM_ID,
    deductible: Number.POSITIVE_INFINITY,
  }).error, 'invalid_field');
  assert.equal(parseSettlementBreakdownInput({
    claim_id: CLAIM_ID,
    ale_rcv: '12abc',
  }).error, 'invalid_field');
});

test('check amount, deposited_at, check_stage, and check claim_id cannot be changed', () => {
  for (const field of ['amount', 'deposited_at', 'check_stage', 'check_id']) {
    const parsed = parseSettlementBreakdownInput({
      claim_id: CLAIM_ID,
      [field]: field === 'amount' ? 99 : 'x',
    });
    assert.equal(parsed.error, 'column_not_allowlisted', field);
    assert.ok(parsed.columns.includes(field), field);
  }
});

test('payments, disbursements, and Moov/provider state cannot be changed', () => {
  for (const field of ['payment_id', 'disbursement_id', 'moov_account_id', 'payment_provider']) {
    const parsed = parseSettlementBreakdownInput({
      claim_id: CLAIM_ID,
      replacement_cost_value: 1,
      [field]: 'bad',
    });
    assert.equal(parsed.error, 'column_not_allowlisted', field);
  }
});

test('generic claim_settlements write remains denied', async () => {
  assert.equal(WRITE_ALLOWLIST.claim_settlements, undefined);
  assert.notEqual(denyTableReason('claim_settlements'), null);
  const client = mockWriteClient();
  const result = await handleWrite(jwtEvent('/data/write', {
    table: 'claim_settlements',
    op: 'insert',
    values: { claim_id: CLAIM_ID, replacement_cost_value: 1 },
  }), {
    loadDatabaseCredentials: async () => ({ host: 'x', username: 'checksops', password: 'x', database: 'checksops' }),
    createClient: () => client,
    forceEnabled: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'table_not_allowlisted');
  assert.match(CLIENT_SRC, /name: "save_claim_settlement_breakdown"/);
  assert.match(CLIENT_SRC, /state.table === "claim_settlements"/);
  assert.doesNotMatch(CLIENT_SRC, /"claim_settlements",/);
});

test('generic financial permissions remain disabled', () => {
  assert.equal(financialPermissionsActivated(), false);
  assert.equal(process.env.AWS_FINANCIAL_PERMISSIONS_ACTIVATED === 'true', false);
  assert.equal(WRITE_ALLOWLIST.claim_settlements, undefined);
  assert.equal(WRITE_ALLOWLIST['claim_payments'], undefined);
  assert.equal(WRITE_ALLOWLIST['claim_disbursements'], undefined);
});

test('SQL43 / SQL44 / Signature / admin-mortgage-tenant-create remain', async () => {
  assert.match(WRITE_SRC, /const peelReviewClaimNumber/);
  assert.match(WRITE_SRC, /review_save_detected_claim_number/);
  assert.equal(SAFE_WRITE_RPCS.has('claim_ledger_link_or_create'), true);
  assert.match(WORKFLOW_SRC, /executeClaimLedgerLinkOrCreate/);
  assert.equal(SAFE_WRITE_RPCS.has('save_claim_settlement_breakdown'), true);
  assert.equal(SAFE_WRITE_RPCS.has('admin_set_check_claim'), true);
  assert.match(WORKFLOW_SRC, /accrueMortgageOpsAcceptedRequest/);
  assert.match(ALLOWLIST_SRC, /signature_requests:/);
  const sig = await executeSignatureWrite({
    client: {
      query: async (sql) => {
        if (/FROM public.claims/.test(sql)) return { rows: [{ id: CLAIM_ID }] };
        if (/INSERT INTO public.signature_requests/.test(sql)) return { rows: [{ id: 'sig-1', status: 'draft' }] };
        return { rows: [] };
      },
    },
    table: 'signature_requests',
    op: 'insert',
    values: {
      claim_id: CLAIM_ID,
      document_name: 'Release',
      document_path: 'claim-files/demo.pdf',
    },
  });
  assert.equal(sig.rows[0].status, 'draft');
  const created = await executeTenantsCreate({
    client: {
      query: async (sql, params) => {
        if (/is_platform_owner/.test(sql)) return { rows: [{ is_owner: true, is_master: false }] };
        if (/INSERT INTO public.tenants/.test(sql)) {
          return { rows: [{ id: TENANT, name: params[0], slug: params[1], payment_provider: params[2] }] };
        }
        return { rows: [] };
      },
    },
    mapping: { application_user_id: APP_ID },
    values: { name: 'New Co', slug: 'New Co!' },
  });
  assert.equal(created.rows[0].payment_provider, 'moov');
});

test('ACV is derived from entered components and is not a writable field', () => {
  const acv = computeSettlementAcv({
    ...BASE_AMOUNTS,
    replacement_cost_value: 10000,
    recoverable_depreciation: 1000,
    non_recoverable_depreciation: 500,
    deductible: 250,
    other_structures_rcv: 2000,
    other_structures_recoverable_depreciation: 200,
    other_structures_non_recoverable_depreciation: 0,
    other_structures_deductible: 100,
    pwi_rcv: 300,
    personal_property_rcv: 50,
    ale_rcv: 25,
  });
  assert.equal(acv.dwelling, 8250);
  assert.equal(acv.other_structures, 1700);
  assert.equal(acv.pwi, 300);
  assert.equal(acv.personal_property, 50);
  assert.equal(acv.ale, 25);
  assert.equal(acv.total, 10325);
  assert.equal(parseSettlementBreakdownInput({
    claim_id: CLAIM_ID,
    replacement_cost_value: 1,
    acv: 999,
  }).error, 'column_not_allowlisted');
});

test('named RPC routing exists and lock-then-update avoids a silent duplicate insert', async () => {
  const client = settlementClient({
    existing: [{ id: SETTLEMENT_ID, claim_id: CLAIM_ID }],
  });
  const routed = await executeSafeWriteRpc({
    client,
    mapping: { application_user_id: APP_ID },
    name: 'save_claim_settlement_breakdown',
    args: { claim_id: CLAIM_ID, ...DWELLING },
  });
  assert.equal(routed.error, undefined);
  assert.equal(routed.data.id, SETTLEMENT_ID);
  assert.ok(client.queries.some((q) => /FROM public.claims/.test(q.sql) && /FOR UPDATE/.test(q.sql)));
  assert.equal(client.queries.some((q) => /INSERT INTO public.claim_settlements/.test(q.sql)), false);
});

test('settlement id from another claim cannot reassign claim_id', async () => {
  const client = settlementClient({
    existing: [],
    foreignById: { id: SETTLEMENT_ID, claim_id: FOREIGN_CLAIM },
  });
  const result = await executeClaimSettlementBreakdownWrite({
    client,
    mapping: { application_user_id: APP_ID },
    args: { claim_id: CLAIM_ID, id: SETTLEMENT_ID, ...DWELLING },
  });
  assert.equal(result.error, 'claim_reassignment_denied');
});
