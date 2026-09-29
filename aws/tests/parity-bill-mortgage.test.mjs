import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handler } from '../functions/api/index.mjs';
import { CLASS_A_FUNCTIONS, handleAppServiceRequest } from '../functions/api/app-services.mjs';
import {
  runBillMortgageHandling,
} from '../functions/api/bill-mortgage-handling.mjs';

const REQUEST_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TENANT_A = '11111111-1111-4111-8111-111111111111';

const sqlClient = (handlers) => ({
  query: async (sql, params = []) => {
    const compact = String(sql).replace(/\s+/g, ' ');
    for (const handler of handlers) {
      if (handler.match(compact, params)) return handler.result(params, compact);
    }
    return { rows: [], rowCount: 0 };
  },
});

test('bill-mortgage-handling is a named Class A handler and stay fail-closed', async () => {
  assert.ok(CLASS_A_FUNCTIONS.has('bill-mortgage-handling'));
  const result = await handleAppServiceRequest({
    body: '{}',
    requestContext: { http: { method: 'POST', path: '/functions/v1/bill-mortgage-handling' } },
  }, '/functions/v1/bill-mortgage-handling', 'POST');
  assert.equal(result.statusCode, 401);
  assert.notEqual(result.error, 'provider_disabled');
  assert.notEqual(result.error, 'unknown_function');

  const http = await handler({
    requestContext: { http: { method: 'POST', path: '/functions/v1/bill-mortgage-handling' } },
    body: JSON.stringify({ request_id: REQUEST_ID }),
  });
  assert.equal(http.statusCode, 401);
});

test('authorized mortgage billing records completed usage once and never calls Stripe/Moov', async () => {
  const queries = [];
  const client = sqlClient([
    { match: (sql) => sql.includes('user_roles'), result: () => ({ rows: [{ role: 'mortgage_agent' }] }) },
    { match: (sql) => sql.includes('is_master_owner') || sql.includes('is_platform_owner'), result: () => ({ rows: [{ is_master: false, is_platform: false }] }) },
    {
      match: (sql) => sql.includes('FROM public.mortgage_handling_requests') && sql.includes('FOR UPDATE'),
      result: () => ({ rows: [{
        id: REQUEST_ID, tenant_id: TENANT_A, claim_id: null, status: 'completed',
        assigned_employee_id: '55555555-5555-4555-8555-555555555555',
        billing_status: 'unbilled', billed_at: null, flat_fee_cents: null,
        mortgage_company: 'Test Mortgage', mortgage_servicer: null,
      }] }),
    },
    {
      match: (sql) => sql.includes('INSERT INTO public.platform_fee_line_items'),
      result: (params, sql) => { queries.push({ sql, params }); return { rows: [{ id: 'fee-1' }], rowCount: 1 }; },
    },
    {
      match: (sql) => sql.includes('SELECT id FROM public.platform_fee_line_items'),
      result: () => ({ rows: [{ id: 'fee-1' }], rowCount: 1 }),
    },
    {
      match: (sql) => sql.includes('UPDATE public.mortgage_handling_requests'),
      result: (params, sql) => { queries.push({ sql, params }); return { rows: [], rowCount: 1 }; },
    },
  ]);
  const result = await runBillMortgageHandling({
    mapping: { application_user_id: '55555555-5555-4555-8555-555555555555' },
    body: { request_id: REQUEST_ID, flat_fee_cents: 999999, charge_immediately: true },
    spoof: { ignored: true },
    client,
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.billed, true);
  assert.equal(result.flat_fee_cents, 1000);
  assert.equal(result.platformFeeLineItemsWritten, true);
  assert.equal(result.liveStripeCalled, false);
  assert.equal(result.liveMoovCalled, false);
  assert.equal(result.source_reference, `mortgage_handling:${REQUEST_ID}`);
  assert.equal(queries.filter((q) => q.sql.includes('INSERT INTO public.platform_fee_line_items')).length, 1);
  assert.equal(queries[0].params[2], 1000);

  const incomplete = await runBillMortgageHandling({
    mapping: { application_user_id: '55555555-5555-4555-8555-555555555555' },
    body: { request_id: REQUEST_ID },
    spoof: {},
    client: sqlClient([
      { match: (sql) => sql.includes('user_roles'), result: () => ({ rows: [{ role: 'mortgage_agent' }] }) },
      { match: (sql) => sql.includes('is_master_owner') || sql.includes('is_platform_owner'), result: () => ({ rows: [{ is_master: false, is_platform: false }] }) },
      { match: (sql) => sql.includes('mortgage_handling_requests'), result: () => ({ rows: [{ id: REQUEST_ID, tenant_id: TENANT_A, status: 'in_progress', assigned_employee_id: '55555555-5555-4555-8555-555555555555' }] }) },
    ]),
  });
  assert.equal(incomplete.statusCode, 409);
  assert.equal(incomplete.error, 'request_not_completed');

  const already = await runBillMortgageHandling({
    mapping: { application_user_id: '55555555-5555-4555-8555-555555555555' },
    body: { request_id: REQUEST_ID },
    spoof: {},
    client: sqlClient([
      { match: (sql) => sql.includes('user_roles'), result: () => ({ rows: [{ role: 'mortgage_agent' }] }) },
      { match: (sql) => sql.includes('is_master_owner') || sql.includes('is_platform_owner'), result: () => ({ rows: [{ is_master: false, is_platform: false }] }) },
      { match: (sql) => sql.includes('mortgage_handling_requests'), result: () => ({ rows: [{ id: REQUEST_ID, tenant_id: TENANT_A, status: 'completed', assigned_employee_id: '55555555-5555-4555-8555-555555555555', billing_status: 'billed', billed_at: '2026-09-29T00:00:00Z', flat_fee_cents: 1000 }] }) },
    ]),
  });
  assert.equal(already.statusCode, 200);
  assert.equal(already.already_billed, true);
  assert.equal(already.platformFeeLineItemsWritten, false);
});
