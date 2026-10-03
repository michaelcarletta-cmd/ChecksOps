/**
 * Complete-time Mortgage Desk contract: zero collectible fees.
 * Accept-time $10/$5 check_billing_events tests belong to #490 and are
 * not reimplemented here.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  authorizedForMortgageBilling,
  runBillMortgageHandling,
} from '../functions/api/bill-mortgage-handling.mjs';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const AGENT = 'a1000000-0000-4000-8000-000000000004';
const OTHER_AGENT = 'a1000000-0000-4000-8000-000000000005';
const ADMIN_A = 'a1000000-0000-4000-8000-000000000009';
const OWNER_A = 'a1000000-0000-4000-8000-000000000001';
const FIRST_REQUEST = 'c1000000-0000-4000-8000-000000000001';

const requestRow = (overrides = {}) => ({
  id: FIRST_REQUEST,
  tenant_id: TENANT_A,
  assigned_employee_id: AGENT,
  billing_status: 'unbilled',
  ...overrides,
});

const createClient = ({
  roles = {},
  owner = { is_master: false, is_platform: false },
  requests = {},
} = {}) => {
  const queries = [];
  const client = {
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
      if (compact.includes('FROM public.mortgage_handling_requests')) {
        const row = requests[params[0]];
        return { rows: row ? [{ ...row }] : [] };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return client;
};

const invoke = (client, { userId, requestId = FIRST_REQUEST }) => runBillMortgageHandling({
  mapping: { application_user_id: userId },
  body: { request_id: requestId, charge_immediately: true, flat_fee_cents: 999999 },
  spoof: {},
  client,
});

const assertNoCollectibleFee = (result, queries) => {
  assert.equal(result.billed, false);
  assert.equal(result.platformFeeLineItemsWritten, false);
  assert.equal(result.checkBillingEventsWritten, false);
  assert.equal(result.liveStripeCalled, false);
  assert.equal(result.liveMoovCalled, false);
  assert.equal(result.providerExecution, false);
  assert.equal(queries.some((q) => /INSERT INTO public\.platform_fee_line_items/i.test(q.sql)), false);
  assert.equal(queries.some((q) => /INSERT INTO public\.check_billing_events/i.test(q.sql)), false);
  assert.doesNotMatch(queries.map((q) => q.sql).join('\n'), /mortgage_ops_initial|mortgage_ops_additional_check/);
};

test('tenant admin alone cannot bill; assigned agent and owner stay fail-closed', async () => {
  assert.equal(authorizedForMortgageBilling(['admin']), false);
  assert.equal(authorizedForMortgageBilling(['mortgage_agent']), true);
  assert.equal(authorizedForMortgageBilling([], { is_master: true }), true);
  assert.equal(authorizedForMortgageBilling(['admin'], { is_platform: true }), true);

  const adminClient = createClient({
    roles: { [ADMIN_A]: ['admin'] },
    requests: { [FIRST_REQUEST]: requestRow() },
  });
  const admin = await invoke(adminClient, { userId: ADMIN_A });
  assert.equal(admin.statusCode, 403);
  assert.equal(admin.error, 'not_authorized');
  assertNoCollectibleFee(admin, adminClient.queries);

  const agentClient = createClient({
    roles: { [AGENT]: ['mortgage_agent'] },
    requests: { [FIRST_REQUEST]: requestRow() },
  });
  const assigned = await invoke(agentClient, { userId: AGENT });
  assert.equal(assigned.statusCode, 403);
  assert.equal(assigned.error, 'production_execution_blocked');
  assert.equal(assigned.ok, false);
  assertNoCollectibleFee(assigned, agentClient.queries);

  const ownerClient = createClient({
    roles: { [OWNER_A]: [] },
    owner: { is_master: true, is_platform: true },
    requests: { [FIRST_REQUEST]: requestRow({ assigned_employee_id: AGENT }) },
  });
  const owner = await invoke(ownerClient, { userId: OWNER_A });
  assert.equal(owner.statusCode, 403);
  assert.equal(owner.error, 'production_execution_blocked');
  assertNoCollectibleFee(owner, ownerClient.queries);
});

test('unrelated mortgage agent cannot create a Complete-time collectible fee', async () => {
  const client = createClient({
    roles: { [OTHER_AGENT]: ['mortgage_agent'] },
    requests: { [FIRST_REQUEST]: requestRow({ assigned_employee_id: AGENT }) },
  });
  const result = await invoke(client, { userId: OTHER_AGENT });
  assert.equal(result.statusCode, 403);
  assert.equal(result.error, 'not_assigned_to_you');
  assertNoCollectibleFee(result, client.queries);
});

test('retrying Complete cannot create a second collectible fee', async () => {
  const client = createClient({
    roles: { [AGENT]: ['mortgage_agent'] },
    requests: { [FIRST_REQUEST]: requestRow() },
  });
  const first = await invoke(client, { userId: AGENT });
  const retry = await invoke(client, { userId: AGENT });
  assert.equal(first.error, 'production_execution_blocked');
  assert.equal(retry.error, 'production_execution_blocked');
  assertNoCollectibleFee(first, client.queries);
  assertNoCollectibleFee(retry, client.queries);
  assert.equal(client.queries.filter((q) => /INSERT INTO/i.test(q.sql)).length, 0);
});
