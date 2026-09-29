/**
 * Mortgage Desk ledger-accrual contract.
 * Imports only bill-mortgage-handling.mjs so this file stays runnable
 * independently of the known ocr-parse.mjs syntax failure.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  authorizedForMortgageBilling,
  runBillMortgageHandling,
} from '../functions/api/bill-mortgage-handling.mjs';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const CLAIM_A = 'e1000000-0000-4000-8000-000000000001';
const AGENT = 'a1000000-0000-4000-8000-000000000004';
const OTHER_AGENT = 'a1000000-0000-4000-8000-000000000005';
const ADMIN_A = 'a1000000-0000-4000-8000-000000000009';
const OWNER_A = 'a1000000-0000-4000-8000-000000000001';
const FIRST_REQUEST = 'c1000000-0000-4000-8000-000000000001';
const ADDITIONAL_REQUEST = 'c1000000-0000-4000-8000-000000000002';

const requestRow = (overrides = {}) => ({
  id: FIRST_REQUEST,
  tenant_id: TENANT_A,
  claim_id: CLAIM_A,
  status: 'completed',
  assigned_employee_id: AGENT,
  billing_status: 'unbilled',
  billed_at: null,
  flat_fee_cents: null,
  mortgage_company: 'Test Mortgage',
  mortgage_servicer: null,
  ...overrides,
});

const createLedger = ({
  roles = {},
  owner = { is_master: false, is_platform: false },
  requests = {},
  lineItems = [],
} = {}) => {
  const inserts = [];
  const updates = [];
  const queries = [];
  const client = {
    inserts,
    updates,
    lineItems,
    queries,
    query: async (sql, params = []) => {
      const compact = String(sql).replace(/\s+/g, ' ');
      queries.push({ sql: compact, params });
      if (compact.includes('user_roles')) {
        return { rows: (roles[params[0]] || []).map((role) => ({ role })) };
      }
      if (/is_master_owner|is_platform_owner/.test(compact)) {
        return { rows: [owner] };
      }
      if (compact.includes('FROM public.mortgage_handling_requests') && compact.includes('FOR UPDATE')) {
        const row = requests[params[0]];
        return { rows: row ? [{ ...row }] : [] };
      }
      if (
        compact.includes('SELECT 1')
        && compact.includes('mortgage_handling_requests')
        && compact.includes("billing_status = 'billed'")
      ) {
        const sibling = Object.values(requests).find((row) => (
          row.claim_id === params[0]
          && row.id !== params[1]
          && row.billing_status === 'billed'
        ));
        return { rows: sibling ? [1] : [] };
      }
      if (compact.includes('INSERT INTO public.platform_fee_line_items')) {
        const item = {
          id: `fee-${lineItems.length + 1}`,
          tenant_id: params[0],
          fee_code: 'mortgage_handling',
          description: params[1],
          quantity: 1,
          unit_cents: params[2],
          amount_cents: params[2],
          claim_id: params[3],
          status: 'unbilled',
          source_reference: params[4],
        };
        inserts.push({ sql: compact, params, item });
        const conflict = lineItems.find((row) => (
          row.tenant_id === item.tenant_id && row.source_reference === item.source_reference
        ));
        if (conflict) return { rows: [], rowCount: 0 };
        lineItems.push(item);
        return { rows: [{ id: item.id }], rowCount: 1 };
      }
      if (compact.includes('SELECT id FROM public.platform_fee_line_items')) {
        const found = lineItems.filter((row) => (
          row.tenant_id === params[0] && row.source_reference === params[1]
        ));
        return { rows: found.map((row) => ({ id: row.id })), rowCount: found.length };
      }
      if (compact.includes('UPDATE public.mortgage_handling_requests')) {
        updates.push({ sql: compact, params });
        const row = requests[params[0]];
        if (row) {
          requests[params[0]] = {
            ...row,
            billing_status: 'billed',
            billed_at: row.billed_at || '2026-09-29T20:00:00Z',
            flat_fee_cents: params[1],
          };
        }
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return client;
};

const billAsAgent = (client, requestId, userId = AGENT) => runBillMortgageHandling({
  mapping: { application_user_id: userId },
  body: { request_id: requestId, charge_immediately: true, flat_fee_cents: 999999 },
  spoof: { ignored: true },
  client,
});

const assertNoProviderExecution = (result) => {
  assert.equal(result.liveStripeCalled, false);
  assert.equal(result.liveMoovCalled, false);
  assert.equal(result.providerExecution, false);
};

const assertUsageFee = (item, { requestId, amountCents, claimId = CLAIM_A }) => {
  assert.equal(item.fee_code, 'mortgage_handling');
  assert.equal(item.status, 'unbilled');
  assert.equal(item.source_reference, `mortgage_handling:${requestId}`);
  assert.equal(item.amount_cents, amountCents);
  assert.equal(item.unit_cents, amountCents);
  assert.equal(item.tenant_id, TENANT_A);
  assert.equal(item.claim_id, claimId);
};

test('tenant admin alone cannot bill; assigned agent and platform owner can', async () => {
  assert.equal(authorizedForMortgageBilling(['admin']), false);
  assert.equal(authorizedForMortgageBilling(['mortgage_agent']), true);
  assert.equal(authorizedForMortgageBilling([], { is_master: true }), true);
  assert.equal(authorizedForMortgageBilling(['admin'], { is_platform: true }), true);

  const admin = await runBillMortgageHandling({
    mapping: { application_user_id: ADMIN_A },
    body: { request_id: FIRST_REQUEST },
    spoof: {},
    client: createLedger({
      roles: { [ADMIN_A]: ['admin'] },
      requests: { [FIRST_REQUEST]: requestRow() },
    }),
  });
  assert.equal(admin.statusCode, 403);
  assert.equal(admin.error, 'not_authorized');
  assert.equal(admin.billed, false);
  assertNoProviderExecution(admin);

  const assigned = await billAsAgent(createLedger({
    roles: { [AGENT]: ['mortgage_agent'] },
    requests: { [FIRST_REQUEST]: requestRow() },
  }), FIRST_REQUEST);
  assert.equal(assigned.statusCode, 200);
  assert.equal(assigned.billed, true);
  assertNoProviderExecution(assigned);

  const ownerClient = createLedger({
    roles: { [OWNER_A]: [] },
    owner: { is_master: true, is_platform: true },
    requests: { [FIRST_REQUEST]: requestRow({ assigned_employee_id: AGENT }) },
  });
  const owner = await runBillMortgageHandling({
    mapping: { application_user_id: OWNER_A },
    body: { request_id: FIRST_REQUEST },
    spoof: {},
    client: ownerClient,
  });
  assert.equal(owner.statusCode, 200);
  assert.equal(owner.billed, true);
  assert.equal(ownerClient.lineItems.length, 1);
  assertNoProviderExecution(owner);
});

test('unrelated mortgage agent cannot bill another agent request', async () => {
  const client = createLedger({
    roles: { [OTHER_AGENT]: ['mortgage_agent'] },
    requests: { [FIRST_REQUEST]: requestRow({ assigned_employee_id: AGENT }) },
  });
  const result = await billAsAgent(client, FIRST_REQUEST, OTHER_AGENT);
  assert.equal(result.statusCode, 403);
  assert.equal(result.error, 'not_assigned_to_you');
  assert.equal(result.billed, false);
  assert.equal(client.lineItems.length, 0);
  assert.equal(client.inserts.length, 0);
  assertNoProviderExecution(result);
});

test('incomplete Mortgage Desk request cannot bill', async () => {
  const client = createLedger({
    roles: { [AGENT]: ['mortgage_agent'] },
    requests: { [FIRST_REQUEST]: requestRow({ status: 'in_progress' }) },
  });
  const result = await billAsAgent(client, FIRST_REQUEST);
  assert.equal(result.statusCode, 409);
  assert.equal(result.error, 'request_not_completed');
  assert.equal(result.billed, false);
  assert.equal(client.lineItems.length, 0);
  assertNoProviderExecution(result);
});

test('first claim check accrues 1000 cents and additional same-claim check accrues 500 cents', async () => {
  const requests = {
    [FIRST_REQUEST]: requestRow({ id: FIRST_REQUEST }),
    [ADDITIONAL_REQUEST]: requestRow({ id: ADDITIONAL_REQUEST, assigned_employee_id: AGENT }),
  };
  const client = createLedger({
    roles: { [AGENT]: ['mortgage_agent'] },
    requests,
  });

  const first = await billAsAgent(client, FIRST_REQUEST);
  assert.equal(first.statusCode, 200);
  assert.equal(first.billed, true);
  assert.equal(first.flat_fee_cents, 1000);
  assert.equal(first.platformFeeLineItemsWritten, true);
  assert.equal(first.source_reference, `mortgage_handling:${FIRST_REQUEST}`);
  assert.equal(client.lineItems.length, 1);
  assertUsageFee(client.lineItems[0], { requestId: FIRST_REQUEST, amountCents: 1000 });
  assert.match(client.inserts[0].sql, /'mortgage_handling'/);
  assert.match(client.inserts[0].sql, /'unbilled'/);
  assert.doesNotMatch(client.inserts[0].sql, /stripe|moov/i);
  assertNoProviderExecution(first);

  const additional = await billAsAgent(client, ADDITIONAL_REQUEST);
  assert.equal(additional.statusCode, 200);
  assert.equal(additional.billed, true);
  assert.equal(additional.flat_fee_cents, 500);
  assert.equal(additional.platformFeeLineItemsWritten, true);
  assert.equal(additional.source_reference, `mortgage_handling:${ADDITIONAL_REQUEST}`);
  assert.equal(client.lineItems.length, 2);
  assertUsageFee(client.lineItems[1], { requestId: ADDITIONAL_REQUEST, amountCents: 500 });
  assert.equal(client.lineItems.filter((row) => row.amount_cents === 1000).length, 1);
  assert.equal(client.lineItems.filter((row) => row.amount_cents === 500).length, 1);
  assert.equal(new Set(client.lineItems.map((row) => row.source_reference)).size, 2);
  assertNoProviderExecution(additional);
});

test('retrying an already-billed request does not create a second fee', async () => {
  const requests = { [FIRST_REQUEST]: requestRow() };
  const client = createLedger({
    roles: { [AGENT]: ['mortgage_agent'] },
    requests,
  });
  const first = await billAsAgent(client, FIRST_REQUEST);
  assert.equal(first.flat_fee_cents, 1000);
  assert.equal(client.lineItems.length, 1);

  const retry = await billAsAgent(client, FIRST_REQUEST);
  assert.equal(retry.statusCode, 200);
  assert.equal(retry.already_billed, true);
  assert.equal(retry.billed, true);
  assert.equal(retry.flat_fee_cents, 1000);
  assert.equal(retry.platformFeeLineItemsWritten, false);
  assert.equal(client.lineItems.length, 1);
  assert.equal(client.inserts.length, 1);
  assert.equal(requests[FIRST_REQUEST].billing_status, 'billed');
  assertUsageFee(client.lineItems[0], { requestId: FIRST_REQUEST, amountCents: 1000 });
  assertNoProviderExecution(retry);
});

test('conflicting platform_fee_line_items source_reference does not create a duplicate fee', async () => {
  const sourceReference = `mortgage_handling:${FIRST_REQUEST}`;
  const existing = {
    id: 'fee-existing',
    tenant_id: TENANT_A,
    fee_code: 'mortgage_handling',
    description: 'Mortgage handling — Test Mortgage',
    quantity: 1,
    unit_cents: 1000,
    amount_cents: 1000,
    claim_id: CLAIM_A,
    status: 'unbilled',
    source_reference: sourceReference,
  };
  const requests = { [FIRST_REQUEST]: requestRow() };
  const client = createLedger({
    roles: { [AGENT]: ['mortgage_agent'] },
    requests,
    lineItems: [existing],
  });

  const result = await billAsAgent(client, FIRST_REQUEST);
  assert.equal(result.statusCode, 200);
  assert.equal(result.already_billed, true);
  assert.equal(result.billed, true);
  assert.equal(result.platformFeeLineItemsWritten, false);
  assert.equal(result.source_reference, sourceReference);
  assert.equal(client.lineItems.length, 1);
  assert.equal(client.lineItems[0].id, 'fee-existing');
  assert.equal(client.inserts.length, 1);
  assert.equal(client.inserts[0].sql.includes('ON CONFLICT (tenant_id, source_reference)'), true);
  assert.equal(requests[FIRST_REQUEST].billing_status, 'billed');
  assertUsageFee(client.lineItems[0], { requestId: FIRST_REQUEST, amountCents: 1000 });
  assertNoProviderExecution(result);
});
