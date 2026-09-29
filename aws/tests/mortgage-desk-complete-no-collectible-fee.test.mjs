/**
 * Negative Complete-time contract.
 *
 * Accept is the AWS billing milestone (check_billing_events
 * mortgage_ops_initial / mortgage_ops_additional_check). This file does not
 * reimplement that #490 engine. It proves Complete and retry Complete cannot
 * open a second collectible rail through bill-mortgage-handling.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBillMortgageHandling } from '../functions/api/bill-mortgage-handling.mjs';

const AGENT = '55555555-5555-4555-8555-555555555555';
const REQUEST_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const trackingClient = () => {
  const queries = [];
  return {
    queries,
    query: async (sql, params = []) => {
      const compact = String(sql).replace(/\s+/g, ' ');
      queries.push({ sql: compact, params });
      if (compact.includes('user_roles')) return { rows: [{ role: 'mortgage_agent' }] };
      if (/is_master_owner|is_platform_owner/.test(compact)) {
        return { rows: [{ is_master: false, is_platform: false }] };
      }
      if (compact.includes('mortgage_handling_requests')) {
        return {
          rows: [{
            id: REQUEST_ID,
            tenant_id: '11111111-1111-4111-8111-111111111111',
            assigned_employee_id: AGENT,
            billing_status: 'unbilled',
          }],
        };
      }
      return { rows: [], rowCount: 0 };
    },
  };
};

const assertZeroCollectible = (result, queries) => {
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 403);
  assert.equal(result.error, 'production_execution_blocked');
  assert.equal(result.billed, false);
  assert.equal(result.platformFeeLineItemsWritten, false);
  assert.equal(result.checkBillingEventsWritten, false);
  assert.equal(result.liveStripeCalled, false);
  assert.equal(result.liveMoovCalled, false);
  assert.equal(result.providerExecution, false);
  const sql = queries.map((q) => q.sql).join('\n');
  assert.doesNotMatch(sql, /INSERT INTO public\.platform_fee_line_items/i);
  assert.doesNotMatch(sql, /INSERT INTO public\.check_billing_events/i);
  assert.doesNotMatch(sql, /mortgage_ops_initial/);
  assert.doesNotMatch(sql, /mortgage_ops_additional_check/);
  assert.doesNotMatch(sql, /stripe|moov/i);
};

test('Complete and retry Complete create no collectible Mortgage Desk fee', async () => {
  const client = trackingClient();
  const complete = await runBillMortgageHandling({
    mapping: { application_user_id: AGENT },
    body: { request_id: REQUEST_ID },
    spoof: {},
    client,
  });
  const retry = await runBillMortgageHandling({
    mapping: { application_user_id: AGENT },
    body: { request_id: REQUEST_ID },
    spoof: {},
    client,
  });
  assertZeroCollectible(complete, client.queries);
  assertZeroCollectible(retry, client.queries);
  assert.equal(client.queries.filter((q) => /INSERT INTO/i.test(q.sql)).length, 0);
});
