import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as usage from '../functions/api/mortgage-ops-usage.mjs';
import * as engine from '../functions/api/tenant-billing-engine.mjs';

const {
  DEFAULT_MORTGAGE_INITIAL_RATE_CENTS,
  FEE_MORTGAGE_ADDITIONAL,
  FEE_MORTGAGE_INITIAL,
  LIVE_TENANT_BILLING_ENGINE_SHA256,
  MORTGAGE_ADDITIONAL_CHECK_NOT_CHARGED,
  MORTGAGE_EVENT_TYPES,
  accrueMortgageOpsAcceptedRequest,
  mortgageRequestIsAccepted,
  periodKey,
  resolveMortgageInitialRateCents,
} = usage;

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

test('the first-check rate preserves explicit zero and defaults to $10; no additional-check rate (SQL 160)', () => {
  assert.equal(resolveMortgageInitialRateCents({}), DEFAULT_MORTGAGE_INITIAL_RATE_CENTS);
  assert.equal(DEFAULT_MORTGAGE_INITIAL_RATE_CENTS, 1000);
  assert.equal(resolveMortgageInitialRateCents({ mortgage_ops_initial_rate_cents: 0 }), 0);
  // The usage module no longer prices an additional check at all.
  assert.equal('resolveMortgageAdditionalRateCents' in usage, false);
  assert.equal('DEFAULT_MORTGAGE_ADDITIONAL_RATE_CENTS' in usage, false);
  // Events recorded before SQL 160 stay readable: the type is still known.
  assert.deepEqual(MORTGAGE_EVENT_TYPES, ['mortgage_ops_initial', 'mortgage_ops_additional_check']);
  assert.equal(MORTGAGE_ADDITIONAL_CHECK_NOT_CHARGED, 'additional_check_not_charged');
  assert.equal(engine.MORTGAGE_ADDITIONAL_CHECK_NOT_CHARGED, MORTGAGE_ADDITIONAL_CHECK_NOT_CHARGED);
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

for (const [name, mod] of [['mortgage-ops-usage.mjs', usage], ['tenant-billing-engine.mjs', engine]]) {
  // SQL 160 (owner 2026-11-12: "There will be no more $5 charge ... do not allow that charge to occur"). Before it
  // this case recorded mortgage_ops_additional_check at $5 (the tenant's additional rate).
  test(`${name}: an additional check on the same claim is not charged (it used to be $5)`, async () => {
    for (const priorType of [FEE_MORTGAGE_INITIAL, FEE_MORTGAGE_ADDITIONAL]) {
      const client = usageClient({
        priorByClaim: [{ id: 'prior', event_type: priorType }],
      });
      const result = await mod.accrueMortgageOpsAcceptedRequest(client, {
        request: accepted({ id: REQUEST_2, check_intake_item_id: CHECK_2 }),
      });
      assert.deepEqual(result, { skipped: 'additional_check_not_charged', claim_id: CLAIM }, priorType);
      assert.equal(client.inserts.length, 0, priorType);
      assert.equal(client.queries.some((q) => /INSERT INTO public\.check_billing_events/.test(q.sql)), false, priorType);
      assert.equal(client.queries.some((q) => /set_config\('request\.money_write'/.test(q.sql)), false, priorType);
    }
  });

  test(`${name}: an additional check is not charged whatever the tenant's additional rate, nor in a preview`, async () => {
    for (const persist of [true, false]) {
      const client = usageClient({
        priorByClaim: [{ id: 'prior', event_type: FEE_MORTGAGE_INITIAL }],
        tenant: { id: TENANT, mortgage_ops_initial_rate_cents: 1000, mortgage_ops_additional_rate_cents: 700 },
      });
      const result = await mod.accrueMortgageOpsAcceptedRequest(client, {
        request: accepted({ id: REQUEST_2, check_intake_item_id: CHECK_2 }), persist,
      });
      assert.equal(result.skipped, 'additional_check_not_charged', String(persist));
      assert.equal(result.event, undefined, String(persist));
      assert.equal(client.inserts.length, 0, String(persist));
    }
  });

  test(`${name}: a lost race for the first charge records nothing in its place`, async () => {
    // The first-charge insert writes nothing (another check of the claim took it meanwhile): before SQL 160 the API
    // then recorded an additional-check charge; now it re-reads the claim and reports the check as not charged.
    const queries = [];
    let claimReads = 0;
    const client = {
      query: async (sql, params = []) => {
        queries.push({ sql, params });
        if (/FROM public\.mortgage_ops_billing_launch/.test(sql)) return { rows: [{ launched_at: '2026-01-01T00:00:00.000Z' }] };
        if (/FROM public\.tenants/.test(sql)) {
          return { rows: [{ id: TENANT, mortgage_ops_initial_rate_cents: 1000, mortgage_ops_additional_rate_cents: 500 }] };
        }
        if (/FROM public\.check_billing_events/.test(sql) && /claim_id = \$2/.test(sql)) {
          claimReads += 1;
          return { rows: claimReads === 2 ? [{ id: 'other-check', event_type: FEE_MORTGAGE_INITIAL }] : [] };
        }
        return { rows: [] };
      },
    };
    const result = await mod.accrueMortgageOpsAcceptedRequest(client, { request: accepted() });
    assert.deepEqual(result, { skipped: 'additional_check_not_charged', claim_id: CLAIM });
    const inserts = queries.filter((q) => /INSERT INTO public\.check_billing_events/.test(q.sql));
    assert.deepEqual(inserts.map((q) => [q.params[2], q.params[3]]), [[FEE_MORTGAGE_INITIAL, 1000]]);
    // With no charge on the claim either, it is still not_inserted.
    queries.length = 0;
    const alone = await mod.accrueMortgageOpsAcceptedRequest(client, { request: accepted() });
    assert.deepEqual(alone, { skipped: 'not_inserted' });
    assert.deepEqual(queries.filter((q) => /INSERT INTO/.test(q.sql)).map((q) => q.params[2]), [FEE_MORTGAGE_INITIAL]);
  });

  test(`${name}: a check charged before SQL 160 (mortgage_ops_additional_check) is a duplicate, not charged again`, async () => {
    const existing = {
      id: 'evt-old', tenant_id: TENANT, event_type: FEE_MORTGAGE_ADDITIONAL, unit_price_cents: 500,
      billed_at: ACCEPTED_AT, billing_period: '2026-10', status: 'recorded', check_intake_item_id: CHECK_2,
      claim_id: CLAIM, mortgage_request_id: REQUEST_2,
    };
    const client = usageClient({ existingByCheck: { [CHECK_2]: existing } });
    const result = await mod.accrueMortgageOpsAcceptedRequest(client, {
      request: accepted({ id: REQUEST_2, check_intake_item_id: CHECK_2 }),
    });
    assert.equal(result.duplicate, true);
    assert.equal(result.event.event_type, FEE_MORTGAGE_ADDITIONAL);
    assert.equal(result.event.unit_price_cents, 500);
    assert.equal(client.inserts.length, 0);
  });

  test(`${name}: the first check of a claim is still $10 mortgage_ops_initial`, async () => {
    const client = usageClient();
    const result = await mod.accrueMortgageOpsAcceptedRequest(client, { request: accepted() });
    assert.deepEqual([result.ok, result.created, result.duplicate, result.event.event_type, result.event.unit_price_cents],
      [true, true, false, FEE_MORTGAGE_INITIAL, 1000]);
    assert.equal(client.inserts.length, 1);
  });
}

test('neither copy of the accrual records or prices an additional check (SQL 160)', () => {
  const sources = {
    'mortgage-ops-usage.mjs': SRC,
    'tenant-billing-engine.mjs': readFileSync(path.join(ROOT, 'aws/functions/api/tenant-billing-engine.mjs'), 'utf8'),
  };
  for (const [name, src] of Object.entries(sources)) {
    const from = src.indexOf('async function accrueCheckMortgageOpsEvent');
    assert.ok(from > 0, name);
    const body = src.slice(from, src.indexOf('\n}\n', from));
    assert.doesNotMatch(body, /FEE_MORTGAGE_ADDITIONAL|resolveMortgageAdditionalRateCents/, name);
    assert.match(body, /MORTGAGE_ADDITIONAL_CHECK_NOT_CHARGED/, name);
  }
  assert.doesNotMatch(SRC, /resolveMortgageAdditionalRateCents|DEFAULT_MORTGAGE_ADDITIONAL_RATE_CENTS/);
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
