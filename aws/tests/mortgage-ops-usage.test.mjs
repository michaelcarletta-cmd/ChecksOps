import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_MORTGAGE_ADDITIONAL_RATE_CENTS,
  DEFAULT_MORTGAGE_INITIAL_RATE_CENTS,
  FEE_MORTGAGE_ADDITIONAL,
  FEE_MORTGAGE_INITIAL,
  LIVE_TENANT_BILLING_ENGINE_SHA256,
  accrueMortgageOpsAcceptedRequest,
  mortgageRequestIsAccepted,
  periodKey,
  resolveMortgageAdditionalRateCents,
  resolveMortgageInitialRateCents,
} from '../functions/api/mortgage-ops-usage.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = readFileSync(path.join(ROOT, 'aws/functions/api/mortgage-ops-usage.mjs'), 'utf8');
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CHECK_1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CHECK_2 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CLAIM = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const REQUEST_1 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const REQUEST_2 = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const ACCEPTED_AT = '2026-10-02T18:00:00.000Z';

const accepted = (overrides = {}) => ({
  id: REQUEST_1,
  tenant_id: TENANT,
  check_intake_item_id: CHECK_1,
  claim_id: CLAIM,
  status: 'in_progress',
  accepted_at: ACCEPTED_AT,
  ...overrides,
});

function usageClient({
  launch = { launched_at: '2026-01-01T00:00:00.000Z' },
  existingByCheck = {},
  priorByClaim = [],
  tenant = { id: TENANT, mortgage_ops_initial_rate_cents: 1000, mortgage_ops_additional_rate_cents: 500 },
  inserts = [],
} = {}) {
  const queries = [];
  return {
    queries,
    inserts,
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (/FROM public\.mortgage_ops_billing_launch/.test(sql)) {
        return { rows: launch ? [launch] : [] };
      }
      if (/FROM public\.check_billing_events/.test(sql) && /check_intake_item_id = \$1/.test(sql)) {
        const row = existingByCheck[params[0]];
        return { rows: row ? [row] : [] };
      }
      if (/FROM public\.check_intake_items/.test(sql)) {
        return { rows: [{ claim_id: CLAIM }] };
      }
      if (/pg_advisory_xact_lock/.test(sql)) return { rows: [{}] };
      if (/FROM public\.tenants/.test(sql)) return { rows: [tenant] };
      if (/FROM public\.check_billing_events/.test(sql) && /claim_id = \$2/.test(sql)) {
        return { rows: priorByClaim };
      }
      if (/INSERT INTO public\.check_billing_events/.test(sql)) {
        const row = {
          id: `evt-${inserts.length + 1}`,
          tenant_id: params[0],
          check_intake_item_id: params[1],
          event_type: params[2],
          unit_price_cents: params[3],
          billed_at: params[4],
          billing_period: params[5],
          invoice_id: null,
          status: 'recorded',
          source_kind: params[2],
          source_id: params[1],
          payment_transfer_id: null,
          claim_id: params[6],
          mortgage_request_id: params[7],
        };
        inserts.push(row);
        existingByCheck[params[1]] = row;
        return { rows: [row] };
      }
      return { rows: [] };
    },
  };
}

test('isolated usage module does not import Moov or invoice execution', () => {
  assert.equal(LIVE_TENANT_BILLING_ENGINE_SHA256.length, 64);
  assert.doesNotMatch(SRC, /^import /m);
  assert.equal(SRC.includes("from './tenant-billing-destination.mjs'"), false);
  assert.equal(SRC.includes("from './tenant-collection-v2.mjs'"), false);
  assert.equal(SRC.includes('postTransfer'), false);
  assert.equal(SRC.includes('chargeTenantPeriod'), false);
  assert.equal(SRC.includes('runMonthlyBillingScheduler'), false);
  assert.equal(SRC.includes('bill-mortgage-handling'), false);
  assert.doesNotMatch(SRC, /\bmoov\b/i);
  assert.doesNotMatch(SRC, /\bstripe\b/i);
});

test('rates preserve explicit zero and default to $10 / $5', () => {
  assert.equal(resolveMortgageInitialRateCents({}), DEFAULT_MORTGAGE_INITIAL_RATE_CENTS);
  assert.equal(resolveMortgageAdditionalRateCents({}), DEFAULT_MORTGAGE_ADDITIONAL_RATE_CENTS);
  assert.equal(resolveMortgageInitialRateCents({ mortgage_ops_initial_rate_cents: 0 }), 0);
  assert.equal(resolveMortgageAdditionalRateCents({ mortgage_ops_additional_rate_cents: 0 }), 0);
  assert.equal(mortgageRequestIsAccepted(accepted()), true);
  assert.equal(mortgageRequestIsAccepted(accepted({ accepted_at: null })), false);
  assert.equal(periodKey(new Date(ACCEPTED_AT)), '2026-10');
});

test('first accepted check for a claim is $10 mortgage_ops_initial', async () => {
  const client = usageClient();
  const result = await accrueMortgageOpsAcceptedRequest(client, { request: accepted() });
  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(result.duplicate, false);
  assert.equal(result.event.event_type, FEE_MORTGAGE_INITIAL);
  assert.equal(result.event.unit_price_cents, 1000);
  assert.equal(result.event.claim_id, CLAIM);
  assert.equal(client.inserts.length, 1);
});

test('additional qualifying check for the same claim is $5', async () => {
  const client = usageClient({
    priorByClaim: [{ id: 'prior', event_type: FEE_MORTGAGE_INITIAL }],
  });
  const result = await accrueMortgageOpsAcceptedRequest(client, {
    request: accepted({ id: REQUEST_2, check_intake_item_id: CHECK_2 }),
  });
  assert.equal(result.event.event_type, FEE_MORTGAGE_ADDITIONAL);
  assert.equal(result.event.unit_price_cents, DEFAULT_MORTGAGE_ADDITIONAL_RATE_CENTS);
  assert.equal(client.inserts.length, 1);
});

test('retrying Accept is idempotent and does not insert again', async () => {
  const existing = {
    id: 'evt-1',
    tenant_id: TENANT,
    event_type: FEE_MORTGAGE_INITIAL,
    unit_price_cents: 1000,
    billed_at: ACCEPTED_AT,
    billing_period: '2026-10',
    invoice_id: null,
    status: 'recorded',
    source_kind: FEE_MORTGAGE_INITIAL,
    source_id: CHECK_1,
    check_intake_item_id: CHECK_1,
    payment_transfer_id: null,
    claim_id: CLAIM,
    mortgage_request_id: REQUEST_1,
  };
  const client = usageClient({ existingByCheck: { [CHECK_1]: existing } });
  const result = await accrueMortgageOpsAcceptedRequest(client, { request: accepted() });
  assert.equal(result.ok, true);
  assert.equal(result.duplicate, true);
  assert.equal(result.created, false);
  assert.equal(client.inserts.length, 0);
});

test('derives claim_id from the check when the request omitted it', async () => {
  const client = usageClient();
  const result = await accrueMortgageOpsAcceptedRequest(client, {
    request: accepted({ claim_id: null }),
  });
  assert.equal(result.event.claim_id, CLAIM);
  assert.equal(client.queries.some((q) => /FROM public\.check_intake_items/.test(q.sql)), true);
});

test('does not persist when persist=false', async () => {
  const client = usageClient();
  const result = await accrueMortgageOpsAcceptedRequest(client, {
    request: accepted(),
    persist: false,
  });
  assert.equal(result.created, false);
  assert.equal(result.event.event_type, FEE_MORTGAGE_INITIAL);
  assert.equal(result.event.unit_price_cents, 1000);
  assert.equal(client.inserts.length, 0);
});
