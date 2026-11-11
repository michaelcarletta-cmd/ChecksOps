/**
 * SQL 153 (owner 2026-11-10/11): "For 2 mortgage companies in check charge $5 for the additional
 * mortgage company." / "Flat $5". The accept of a check's 2nd mortgage company request
 * (endorsement_order 2, SQL 148) records one mortgage_ops_second_mortgagee event at a flat 500
 * cents in addition to the check's normal $10 / $5 charge ("it should be an additional $5 if 2
 * mortgage companies are on check"), which either request's accept records once; the 1st
 * company's accept is unchanged; the monthly invoice and its email carry the fee as its own line. Fixtures only (sql153-second-mortgagee-fee-pg.test.mjs runs the same accrual
 * against PostgreSQL 16).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import * as usage from '../functions/api/mortgage-ops-usage.mjs';
import * as engine from '../functions/api/tenant-billing-engine.mjs';
import { occurrenceInvoiceLines } from '../functions/api/tenant-fee-invoice-email.mjs';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CHECK = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CLAIM = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const REQUEST_1 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const REQUEST_2 = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const ACCEPTED_AT = '2026-11-11T15:00:00.000Z';
const SECOND = 'mortgage_ops_second_mortgagee';

const request = (overrides = {}) => ({
  id: REQUEST_1,
  tenant_id: TENANT,
  check_intake_item_id: CHECK,
  claim_id: CLAIM,
  status: 'in_progress',
  accepted_at: ACCEPTED_AT,
  endorsement_order: null,
  total_mortgagees: null,
  ...overrides,
});
const secondRequest = (overrides = {}) => request({
  id: REQUEST_2, endorsement_order: 2, total_mortgagees: 2, predecessor_request_id: REQUEST_1, ...overrides,
});

/** check_billing_events by check, typed: a lookup only sees the event types its query names. */
function usageClient({ ready = true, events = [], tenant = null } = {}) {
  const queries = [];
  const inserts = [];
  const rows = [...events];
  return {
    queries,
    inserts,
    rows,
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (/to_regclass\('public\.check_billing_events_one_second_mortgagee_per_check'\)/.test(sql)) {
        return { rows: [{ ready }] };
      }
      if (/FROM public\.mortgage_ops_billing_launch/.test(sql)) {
        return { rows: [{ launched_at: '2026-01-01T00:00:00.000Z' }] };
      }
      if (/FROM public\.check_billing_events/.test(sql) && /check_intake_item_id = \$1/.test(sql)) {
        const types = /event_type = 'mortgage_ops_second_mortgagee'/.test(sql)
          ? [SECOND]
          : ['mortgage_ops_initial', 'mortgage_ops_additional_check'];
        const hit = rows.filter((r) => r.check_intake_item_id === params[0] && types.includes(r.event_type));
        hit.sort((a, b) => Number(a.status === 'voided') - Number(b.status === 'voided'));
        return { rows: hit.slice(0, 1) };
      }
      if (/FROM public\.check_intake_items/.test(sql)) return { rows: [{ claim_id: CLAIM }] };
      if (/FROM public\.tenants/.test(sql)) {
        return { rows: [tenant || { id: TENANT, mortgage_ops_initial_rate_cents: 1200, mortgage_ops_additional_rate_cents: 700 }] };
      }
      if (/FROM public\.check_billing_events/.test(sql) && /claim_id = \$2/.test(sql)) {
        return {
          rows: rows.filter((r) => r.claim_id === params[1] && r.status !== 'voided'
            && ['mortgage_ops_initial', 'mortgage_ops_additional_check'].includes(r.event_type)),
        };
      }
      if (/INSERT INTO public\.check_billing_events/.test(sql)) {
        const row = {
          id: `evt-${rows.length + 1}`,
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
        inserts.push({ sql, params, row });
        rows.push(row);
        return { rows: [row] };
      }
      return { rows: [] };
    },
  };
}

const firstEvent = {
  id: 'evt-first', tenant_id: TENANT, check_intake_item_id: CHECK, event_type: 'mortgage_ops_initial',
  unit_price_cents: 1200, billed_at: '2026-11-10T15:00:00.000Z', status: 'recorded', claim_id: CLAIM,
  mortgage_request_id: REQUEST_1,
};

for (const [name, mod] of [['mortgage-ops-usage.mjs', usage], ['tenant-billing-engine.mjs', engine]]) {
  test(`${name}: the same flat fee and event type in both copies`, () => {
    assert.equal(mod.FEE_MORTGAGE_SECOND_MORTGAGEE, SECOND);
    assert.equal(mod.SECOND_MORTGAGEE_FEE_CENTS, 500);
    assert.equal(mod.mortgageRequestIsSecondMortgagee(secondRequest()), true);
    assert.equal(mod.mortgageRequestIsSecondMortgagee(secondRequest({ endorsement_order: '2' })), true);
    assert.equal(mod.mortgageRequestIsSecondMortgagee(request()), false);
    assert.equal(mod.mortgageRequestIsSecondMortgagee(request({ endorsement_order: 1 })), false);
    // The 2nd company's type is not one of the $10 / $5 types.
    assert.equal(mod.MORTGAGE_EVENT_TYPES.includes(SECOND), false);
  });

  test(`${name}: 1st then 2nd company accepted: the normal charge plus one flat $5`, async () => {
    const client = usageClient({ events: [] });
    const first = await mod.accrueMortgageOpsAcceptedRequest(client, { request: request({ endorsement_order: 1, total_mortgagees: 2 }) });
    assert.equal(first.event.event_type, 'mortgage_ops_initial');
    assert.equal(first.second_mortgagee, undefined);
    const result = await mod.accrueMortgageOpsAcceptedRequest(client, { request: secondRequest() });
    // The check already has its normal charge (the 1st request's): not charged again.
    assert.equal(result.duplicate, true);
    assert.equal(result.event.event_type, 'mortgage_ops_initial');
    assert.equal(result.second_mortgagee.ok, true);
    assert.equal(result.second_mortgagee.created, true);
    assert.equal(client.inserts.length, 2);
    const { row, sql } = client.inserts[1];
    assert.deepEqual(
      [row.event_type, row.unit_price_cents, row.status, row.billed_at, row.billing_period, row.check_intake_item_id,
        row.claim_id, row.mortgage_request_id, row.source_kind, row.source_id],
      [SECOND, 500, 'recorded', ACCEPTED_AT, '2026-11', CHECK, CLAIM, REQUEST_2, SECOND, CHECK],
    );
    assert.match(sql, /ON CONFLICT DO NOTHING/);
    // The money-write flag is set before each insert.
    const inserts = client.queries.map((q, i) => (/INSERT INTO public\.check_billing_events/.test(q.sql) ? i : -1)).filter((i) => i >= 0);
    for (const at of inserts) {
      assert.match(client.queries[at - 1].sql, /set_config\('request\.money_write', '1', true\)/);
    }
  });

  test(`${name}: the $5 is flat, whatever the tenant's Mortgage Ops rates`, async () => {
    const client = usageClient({ events: [firstEvent], tenant: { id: TENANT, mortgage_ops_initial_rate_cents: 0, mortgage_ops_additional_rate_cents: 0 } });
    const result = await mod.accrueMortgageOpsAcceptedRequest(client, { request: secondRequest() });
    assert.equal(result.second_mortgagee.event.unit_price_cents, 500);
    assert.deepEqual(client.inserts.map((i) => [i.row.event_type, i.row.unit_price_cents]), [[SECOND, 500]]);
  });

  test(`${name}: 2nd company accepted first, then the 1st: one normal charge plus one $5`, async () => {
    const client = usageClient({ events: [] });
    const result = await mod.accrueMortgageOpsAcceptedRequest(client, { request: secondRequest() });
    // The check had no charge: the normal one, by the same rule and the tenant's rate ($12 here).
    assert.equal(result.created, true);
    assert.equal(result.event.event_type, 'mortgage_ops_initial');
    assert.equal(result.event.unit_price_cents, 1200);
    assert.equal(result.second_mortgagee.created, true);
    const first = await mod.accrueMortgageOpsAcceptedRequest(client, { request: request({ endorsement_order: 1, total_mortgagees: 2 }) });
    assert.equal(first.duplicate, true);
    assert.deepEqual(client.inserts.map((i) => [i.row.event_type, i.row.unit_price_cents, i.row.mortgage_request_id]),
      [['mortgage_ops_initial', 1200, REQUEST_2], [SECOND, 500, REQUEST_2]]);
  });

  test(`${name}: 2nd company accepted first on an additional check of the claim: $5 additional plus $5`, async () => {
    const otherCheck = { ...firstEvent, id: 'evt-other', check_intake_item_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };
    const client = usageClient({ events: [otherCheck] });
    const result = await mod.accrueMortgageOpsAcceptedRequest(client, { request: secondRequest() });
    assert.deepEqual(client.inserts.map((i) => [i.row.event_type, i.row.unit_price_cents]),
      [['mortgage_ops_additional_check', 700], [SECOND, 500]]);
    assert.equal(result.second_mortgagee.created, true);
  });

  test(`${name}: repeated accepts record nothing new`, async () => {
    const client = usageClient({ events: [] });
    await mod.accrueMortgageOpsAcceptedRequest(client, { request: secondRequest() });
    await mod.accrueMortgageOpsAcceptedRequest(client, { request: request() });
    for (const req of [secondRequest(), request(), secondRequest()]) {
      const again = await mod.accrueMortgageOpsAcceptedRequest(client, { request: req });
      assert.equal(again.duplicate, true);
      assert.equal(again.created, false);
      if (req.endorsement_order === 2) {
        assert.equal(again.second_mortgagee.duplicate, true);
        assert.equal(again.second_mortgagee.event.event_type, SECOND);
      }
    }
    assert.equal(client.inserts.length, 2);
    // A voided 2nd-company event also stops a re-charge (as for the $10 / $5 events).
    const voided = usageClient({ events: [firstEvent, { ...client.rows[1], status: 'voided' }] });
    const afterVoid = await mod.accrueMortgageOpsAcceptedRequest(voided, { request: secondRequest() });
    assert.equal(afterVoid.second_mortgagee.duplicate, true);
    assert.equal(voided.inserts.length, 0);
  });

  test(`${name}: no $5 until SQL 153 is applied; the normal charge as before`, async () => {
    let client = usageClient({ ready: false, events: [firstEvent] });
    let result = await mod.accrueMortgageOpsAcceptedRequest(client, { request: secondRequest() });
    assert.equal(result.duplicate, true);
    assert.deepEqual(result.second_mortgagee, { skipped: 'second_mortgagee_fee_not_ready' });
    assert.equal(client.inserts.length, 0);
    client = usageClient({ ready: false, events: [] });
    result = await mod.accrueMortgageOpsAcceptedRequest(client, { request: secondRequest() });
    assert.deepEqual(client.inserts.map((i) => i.row.event_type), ['mortgage_ops_initial']);
  });

  test(`${name}: a single-mortgagee check and the 1st company's accept are unchanged`, async () => {
    for (const order of [null, undefined, 1]) {
      const client = usageClient({ events: [] });
      const result = await mod.accrueMortgageOpsAcceptedRequest(client, { request: request({ endorsement_order: order }) });
      assert.equal(result.event.event_type, 'mortgage_ops_initial');
      assert.equal(result.event.unit_price_cents, 1200);
      assert.equal(result.second_mortgagee, undefined);
      assert.equal(client.inserts.length, 1);
      assert.equal(client.queries.some((q) => /one_second_mortgagee_per_check|mortgage_ops_second_mortgagee/.test(q.sql)), false, String(order));
    }
    // A 2nd-company event on the check does not stop (or reclassify) the check's normal charge.
    const secondEvent = { ...firstEvent, id: 'evt-2nd', event_type: SECOND, unit_price_cents: 500, mortgage_request_id: REQUEST_2 };
    const client = usageClient({ events: [secondEvent] });
    const result = await mod.accrueMortgageOpsAcceptedRequest(client, { request: request() });
    assert.equal(result.created, true);
    assert.equal(result.event.event_type, 'mortgage_ops_initial');
  });

  test(`${name}: persist=false previews both without writing`, async () => {
    const client = usageClient({ events: [] });
    const result = await mod.accrueMortgageOpsAcceptedRequest(client, { request: secondRequest(), persist: false });
    assert.equal(result.event.event_type, 'mortgage_ops_initial');
    assert.equal(result.second_mortgagee.created, false);
    assert.equal(result.second_mortgagee.event.event_type, SECOND);
    assert.equal(result.second_mortgagee.event.unit_price_cents, 500);
    assert.equal(client.inserts.length, 0);
  });
}

test('mortgage-ops-usage.mjs stays import-free', () => {
  const src = readFileSync(new URL('../functions/api/mortgage-ops-usage.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /^import /m);
});

test('month-end: the 2nd company\'s events are read for the period, voided ones skipped', async () => {
  const queries = [];
  const client = {
    query: async (sql, params) => {
      queries.push(sql);
      return {
        rows: [
          { id: 'i1', event_type: 'mortgage_ops_initial', unit_price_cents: 1000, status: 'recorded' },
          { id: 's1', event_type: SECOND, unit_price_cents: 500, status: 'recorded', mortgage_request_id: REQUEST_2 },
        ],
      };
    },
  };
  const result = await engine.loadMortgageOpsUsageForPeriod(client, { tenantId: TENANT, period: '2026-11' });
  assert.deepEqual(result.initial.map((r) => r.id), ['i1']);
  assert.deepEqual(result.additional, []);
  assert.deepEqual(result.secondMortgagee.map((r) => [r.id, r.unit_price_cents, r.mortgage_request_id]), [['s1', 500, REQUEST_2]]);
  assert.match(queries[0], /'mortgage_ops_second_mortgagee'/);
  assert.match(queries[0], /status IS DISTINCT FROM 'voided'/);
});

test('month-end: the 2nd company is its own invoice line, $5 each, in the totals', () => {
  const tenant = { monthly_rate_cents: 10000, referral_discount_cents: 0, mortgage_ops_initial_rate_cents: 1000 };
  const mortgageInitial = [{ id: 'i1', unit_price_cents: 1000 }];
  const mortgageSecondMortgagee = [
    { id: 's1', unit_price_cents: 500, billed_at: '2026-11-11T00:00:00Z' },
    { id: 's2', unit_price_cents: 500, billed_at: '2026-11-12T00:00:00Z' },
  ];
  const totals = engine.assembleInvoiceTotals({
    tenant, period: '2026-11', checks: [], nextDay: [], sameDay: [], mortgageInitial, mortgageSecondMortgagee,
  });
  assert.equal(totals.mortgage_ops_second_mortgagee_count, 2);
  assert.equal(totals.mortgage_ops_second_mortgagee_amount_cents, 1000);
  assert.equal(totals.mortgage_ops_second_mortgagee_rate_cents, 500);
  assert.equal(totals.mortgage_ops_initial_amount_cents, 1000);
  assert.equal(totals.mortgage_ops_usage_cents, 2000);
  assert.equal(totals.usage_total_cents, 2000);
  assert.equal(totals.amount_cents, 12000);
  const summary = engine.invoiceSummaryLines({ ok: true, ...totals });
  assert.deepEqual(summary.find((l) => l.key === SECOND), {
    key: SECOND, label: 'Mortgage Ops: 2nd mortgage company', count: 2, amount_cents: 1000,
  });
  const keys = summary.map((l) => l.key);
  assert.equal(keys.indexOf(SECOND), keys.indexOf('mortgage_ops_initial') + 1);
  const items = engine.invoiceLineItems({ lines: { mortgage_ops_second_mortgagee: mortgageSecondMortgagee } });
  assert.deepEqual(items.map((l) => `${l.fee_type}|${l.source}|${l.unit_price_cents}`), [
    `${SECOND}|event:s1|500`, `${SECOND}|event:s2|500`,
  ]);
  // A period without the fee: no line and the same line items as before SQL 153 (preview hash unchanged).
  const none = engine.assembleInvoiceTotals({ tenant, period: '2026-11', checks: [], nextDay: [], sameDay: [], mortgageInitial });
  assert.equal(none.mortgage_ops_second_mortgagee_count, 0);
  assert.equal(engine.invoiceSummaryLines({ ok: true, ...none }).some((l) => l.key === SECOND), false);
  assert.deepEqual(engine.invoiceLineItems({ lines: { mortgage_ops_initial: mortgageInitial } }).map((l) => l.fee_type), ['mortgage_ops_initial']);
});

test('the booked row writes the SQL 153 columns only when the period has the fee', async () => {
  const run = async (invoice, failColumns = []) => {
    const statements = [];
    const client = {
      query: async (sql, params) => {
        statements.push({ sql, params });
        if (/INSERT INTO public\.tenant_maintenance_payments/.test(sql) && failColumns.some((c) => sql.includes(c))) {
          throw Object.assign(new Error('column does not exist'), { code: '42703' });
        }
        if (/INSERT INTO public\.tenant_maintenance_payments/.test(sql)) return { rows: [{ id: 'occ-1' }] };
        return { rows: [] };
      },
    };
    const result = await engine.createOrGetOccurrence(client, {
      tenantId: TENANT,
      period: '2026-11',
      readiness: { amountCents: 12000, rateCents: 10000, discountCents: 0, environment: 'sandbox', invoice },
      destination: { accountId: 'acct', paymentMethodId: 'pm' },
    });
    assert.equal(result.occurrence.id, 'occ-1');
    return statements.filter((s) => /INSERT INTO public\.tenant_maintenance_payments/.test(s.sql));
  };
  const base = { check_count: 0, usage_total_cents: 2000, mortgage_ops_initial_count: 1, mortgage_ops_initial_amount_cents: 1000 };
  // No 2nd-company fee: exactly the SQL 149 insert as before (27 + 4 parameters).
  let inserts = await run(base);
  assert.equal(inserts.length, 1);
  assert.doesNotMatch(inserts[0].sql, /mortgage_ops_second_mortgagee/);
  assert.match(inserts[0].sql, /invoice_fee_count/);
  assert.equal(inserts[0].params.length, 31);
  // With the fee: the SQL 149 and SQL 153 columns.
  const withFee = { ...base, mortgage_ops_second_mortgagee_count: 2, mortgage_ops_second_mortgagee_amount_cents: 1000 };
  inserts = await run(withFee);
  assert.equal(inserts.length, 1);
  assert.match(inserts[0].sql, /failed_deposit_amount_cents,\s+mortgage_ops_second_mortgagee_count, mortgage_ops_second_mortgagee_amount_cents/);
  assert.deepEqual(inserts[0].params.slice(-6), [0, 0, 0, 0, 2, 1000]);
  // SQL 153 applied before SQL 149: the SQL 153 columns without SQL 149's.
  inserts = await run(withFee, ['invoice_fee_count']);
  assert.equal(inserts.length, 2);
  assert.doesNotMatch(inserts[1].sql, /invoice_fee_count/);
  assert.match(inserts[1].sql, /occurrence_kind,\s+mortgage_ops_second_mortgagee_count, mortgage_ops_second_mortgagee_amount_cents/);
  assert.equal(inserts[1].params.length, 29);
  assert.deepEqual(inserts[1].params.slice(-2), [2, 1000]);
});

test('the fee invoice email lists the 2nd mortgage company as its own line', () => {
  const lines = occurrenceInvoiceLines({
    monthly_rate_cents: 10000,
    mortgage_ops_initial_count: 1, mortgage_ops_initial_amount_cents: 1000,
    mortgage_ops_second_mortgagee_count: 2, mortgage_ops_second_mortgagee_amount_cents: 1000,
  });
  assert.deepEqual(lines.slice(1), [
    { label: 'MortgageOps initial requests', count: 1, amount_cents: 1000 },
    { label: 'Mortgage Ops: 2nd mortgage company', count: 2, amount_cents: 1000 },
  ]);
  // A row booked before SQL 153 (no such columns): no line.
  assert.equal(occurrenceInvoiceLines({ monthly_rate_cents: 10000 }).some((l) => /2nd mortgage/.test(l.label)), false);
});

test('SQL 153 defines the index the API waits for', () => {
  const sql = readFileSync(new URL('../workflows/sql/153_second_mortgagee_fee.sql', import.meta.url), 'utf8');
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS check_billing_events_one_second_mortgagee_per_check/);
  assert.match(usage.SECOND_MORTGAGEE_READY_SQL, /check_billing_events_one_second_mortgagee_per_check/);
  assert.equal(usage.SECOND_MORTGAGEE_READY_SQL, engine.SECOND_MORTGAGEE_READY_SQL);
  assert.doesNotMatch(sql, /^\s*(BEGIN|COMMIT)\s*;/im);
});
