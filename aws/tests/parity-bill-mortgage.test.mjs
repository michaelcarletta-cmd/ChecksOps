import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handler } from '../functions/api/index.mjs';
import { CLASS_A_FUNCTIONS, handleAppServiceRequest } from '../functions/api/app-services.mjs';
import {
  denyBillMortgageExecution,
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

test('authorized mortgage billing never writes fees or calls Stripe/Moov', async () => {
  const prevFin = process.env.AWS_FINANCIAL_PERMISSIONS_ACTIVATED;
  const prevProv = process.env.AWS_PROVIDER_EXECUTION_ENABLED;
  process.env.AWS_FINANCIAL_PERMISSIONS_ACTIVATED = 'true';
  process.env.AWS_PROVIDER_EXECUTION_ENABLED = 'true';
  try {
    const denied = denyBillMortgageExecution({ ignored: true }, REQUEST_ID);
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.error, 'production_execution_blocked');
    assert.equal(denied.liveStripeCalled, false);
    assert.equal(denied.liveMoovCalled, false);
    assert.equal(denied.billed, false);
    assert.equal(denied.platformFeeLineItemsWritten, false);

    const unauthorized = await runBillMortgageHandling({
      mapping: { application_user_id: '55555555-5555-4555-8555-555555555555' },
      body: { request_id: REQUEST_ID },
      spoof: { ignored: true },
      client: sqlClient([{
        match: (sql) => sql.includes('user_roles'),
        result: () => ({ rows: [{ role: 'staff' }] }),
      }]),
    });
    assert.equal(unauthorized.statusCode, 403);
    assert.equal(unauthorized.error, 'not_authorized');

    const crossTenant = await runBillMortgageHandling({
      mapping: { application_user_id: '55555555-5555-4555-8555-555555555555' },
      body: { request_id: REQUEST_ID },
      spoof: { ignored: true, headerTenantId: TENANT_A },
      client: sqlClient([
        {
          match: (sql) => sql.includes('user_roles'),
          result: () => ({ rows: [{ role: 'mortgage_agent' }] }),
        },
        {
          match: (sql) => sql.includes('mortgage_handling_requests'),
          result: () => ({ rows: [{ id: REQUEST_ID, tenant_id: TENANT_A, billing_status: 'unbilled' }] }),
        },
        {
          match: (sql) => sql.includes('aws_can_write_tenant'),
          result: () => ({ rows: [{ ok: false }] }),
        },
      ]),
    });
    assert.equal(crossTenant.statusCode, 403);
    assert.equal(crossTenant.liveStripeCalled, false);

    const blocked = await runBillMortgageHandling({
      mapping: { application_user_id: '55555555-5555-4555-8555-555555555555' },
      body: { request_id: REQUEST_ID },
      spoof: { ignored: true },
      client: sqlClient([
        {
          match: (sql) => sql.includes('user_roles'),
          result: () => ({ rows: [{ role: 'admin' }] }),
        },
        {
          match: (sql) => sql.includes('mortgage_handling_requests'),
          result: () => ({ rows: [{ id: REQUEST_ID, tenant_id: TENANT_A, billing_status: 'unbilled' }] }),
        },
        {
          match: (sql) => sql.includes('aws_can_write_tenant'),
          result: () => ({ rows: [{ ok: true }] }),
        },
      ]),
    });
    assert.equal(blocked.statusCode, 403);
    assert.equal(blocked.error, 'production_execution_blocked');
    assert.equal(blocked.liveStripeCalled, false);
    assert.equal(blocked.liveMoovCalled, false);
    assert.equal(blocked.platformFeeLineItemsWritten, false);
  } finally {
    process.env.AWS_FINANCIAL_PERMISSIONS_ACTIVATED = prevFin;
    process.env.AWS_PROVIDER_EXECUTION_ENABLED = prevProv;
  }
});
