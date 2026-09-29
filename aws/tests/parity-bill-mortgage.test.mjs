/**
 * Class A reachability and fail-closed Complete-time contract.
 * Imports only bill-mortgage-handling.mjs so OCR parser failures cannot
 * hide the Mortgage Desk billing safeguard.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  denyBillMortgageExecution,
  handleBillMortgageHandling,
  runBillMortgageHandling,
} from '../functions/api/bill-mortgage-handling.mjs';

const REQUEST_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const AGENT = '55555555-5555-4555-8555-555555555555';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const sqlClient = (handlers, queries = []) => ({
  query: async (sql, params = []) => {
    const compact = String(sql).replace(/\s+/g, ' ');
    queries.push({ sql: compact, params });
    for (const handler of handlers) {
      if (handler.match(compact, params)) return handler.result(params, compact);
    }
    return { rows: [], rowCount: 0 };
  },
});

const requestHandlers = ({
  role = 'mortgage_agent',
  owner = { is_master: false, is_platform: false },
  request = {
    id: REQUEST_ID,
    tenant_id: TENANT_A,
    assigned_employee_id: AGENT,
    billing_status: 'unbilled',
  },
} = {}) => ([
  { match: (sql) => sql.includes('user_roles'), result: () => ({ rows: role ? [{ role }] : [] }) },
  { match: (sql) => sql.includes('is_master_owner') || sql.includes('is_platform_owner'), result: () => ({ rows: [owner] }) },
  { match: (sql) => sql.includes('mortgage_handling_requests'), result: () => ({ rows: request ? [request] : [] }) },
]);

const assertNoCollectibleWrites = (queries, result) => {
  assert.equal(result.liveStripeCalled, false);
  assert.equal(result.liveMoovCalled, false);
  assert.equal(result.providerExecution, false);
  assert.equal(result.billed, false);
  assert.equal(result.platformFeeLineItemsWritten, false);
  assert.equal(result.checkBillingEventsWritten, false);
  assert.equal(queries.some((q) => /INSERT INTO public\.platform_fee_line_items/i.test(q.sql)), false);
  assert.equal(queries.some((q) => /INSERT INTO public\.check_billing_events/i.test(q.sql)), false);
  assert.equal(queries.some((q) => /UPDATE public\.mortgage_handling_requests/i.test(q.sql)), false);
};

test('bill-mortgage-handling is a named Class A handler and unauthenticated calls 401', async () => {
  const appServices = readFileSync(path.join(ROOT, 'functions/api/app-services.mjs'), 'utf8');
  assert.match(appServices, /['"]bill-mortgage-handling['"]/);
  assert.match(appServices, /CLASS_A_FUNCTIONS/);
  assert.match(appServices, /case 'bill-mortgage-handling'/);

  const result = await handleBillMortgageHandling({
    body: JSON.stringify({ request_id: REQUEST_ID }),
    requestContext: { http: { method: 'POST', path: '/functions/v1/bill-mortgage-handling' } },
  });
  assert.equal(result.statusCode, 401);
  assert.notEqual(result.error, 'unknown_function');
});

test('authorized Mortgage Desk Complete is fail-closed and never writes a collectible fee', async () => {
  const prevFin = process.env.AWS_FINANCIAL_PERMISSIONS_ACTIVATED;
  const prevProv = process.env.AWS_PROVIDER_EXECUTION_ENABLED;
  process.env.AWS_FINANCIAL_PERMISSIONS_ACTIVATED = 'true';
  process.env.AWS_PROVIDER_EXECUTION_ENABLED = 'true';
  try {
    const denied = denyBillMortgageExecution({ ignored: true }, REQUEST_ID);
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.error, 'production_execution_blocked');
    assertNoCollectibleWrites([], denied);

    const adminQueries = [];
    const unauthorized = await runBillMortgageHandling({
      mapping: { application_user_id: AGENT },
      body: { request_id: REQUEST_ID },
      spoof: {},
      client: sqlClient(requestHandlers({ role: 'admin' }), adminQueries),
    });
    assert.equal(unauthorized.statusCode, 403);
    assert.equal(unauthorized.error, 'not_authorized');
    assertNoCollectibleWrites(adminQueries, unauthorized);

    const agentQueries = [];
    const blocked = await runBillMortgageHandling({
      mapping: { application_user_id: AGENT },
      body: { request_id: REQUEST_ID, flat_fee_cents: 999999, charge_immediately: true },
      spoof: { ignored: true },
      client: sqlClient(requestHandlers(), agentQueries),
    });
    assert.equal(blocked.statusCode, 403);
    assert.equal(blocked.error, 'production_execution_blocked');
    assert.equal(blocked.ok, false);
    assertNoCollectibleWrites(agentQueries, blocked);

    const ownerQueries = [];
    const owner = await runBillMortgageHandling({
      mapping: { application_user_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      body: { request_id: REQUEST_ID },
      spoof: {},
      client: sqlClient(requestHandlers({
        role: null,
        owner: { is_master: true, is_platform: true },
        request: { id: REQUEST_ID, tenant_id: TENANT_A, assigned_employee_id: AGENT, billing_status: 'unbilled' },
      }), ownerQueries),
    });
    assert.equal(owner.statusCode, 403);
    assert.equal(owner.error, 'production_execution_blocked');
    assertNoCollectibleWrites(ownerQueries, owner);
  } finally {
    process.env.AWS_FINANCIAL_PERMISSIONS_ACTIVATED = prevFin;
    process.env.AWS_PROVIDER_EXECUTION_ENABLED = prevProv;
  }
});
