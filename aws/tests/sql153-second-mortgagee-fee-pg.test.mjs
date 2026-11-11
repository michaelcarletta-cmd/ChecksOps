/**
 * SQL 153 against PostgreSQL 16: the flat $5 for a check's 2nd mortgage company.
 *  - the event_type CHECK: none in the repository (nothing changes); a live single-column
 *    IN-list CHECK keeps every value it has and gains mortgage_ops_second_mortgagee (validity
 *    kept); any other shape is refused with nothing changed;
 *  - the unique index (one non-voided 2nd-company event per check), re-runnable, refusing on
 *    duplicates or a different index of its name;
 *  - the API accrual (mortgage-ops-usage.mjs and tenant-billing-engine.mjs) on the accepted
 *    request rows, before and after the file; the month-end read, the booked row (with and
 *    without SQL 149's columns) and the fee invoice email lines.
 * Every object is owned by a non-superuser checksops_admin LOGIN, which applies the file and,
 * as the table owner, runs the accrual.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { AWS_ROOT, pgSkipReason, startPg } from './helpers/stakeholder-policies-pg.mjs';
import * as usage from '../functions/api/mortgage-ops-usage.mjs';
import * as engine from '../functions/api/tenant-billing-engine.mjs';
import { occurrenceInvoiceLines } from '../functions/api/tenant-fee-invoice-email.mjs';

const SQL_153 = fs.readFileSync(path.join(AWS_ROOT, 'workflows/sql/153_second_mortgagee_fee.sql'), 'utf8');

const T = '11111111-1111-4111-8111-111111111111';
const CLAIM = '66666666-6666-4666-8666-666666666666';
const CHECK = 'c0000000-0000-4000-8000-000000000001';
const CHECK_2 = 'c0000000-0000-4000-8000-000000000002';
const REQ_1 = 'd0000000-0000-4000-8000-000000000001';
const REQ_2 = 'd0000000-0000-4000-8000-000000000002';
const REQ_3 = 'd0000000-0000-4000-8000-000000000003';
const ACCEPTED_AT = '2026-11-11T15:00:00.000Z';
const SECOND = 'mortgage_ops_second_mortgagee';
const INDEX = 'check_billing_events_one_second_mortgagee_per_check';

const OCCURRENCE_COLUMNS = `
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, amount_cents integer NOT NULL,
  monthly_rate_cents integer, discount_cents integer, period_start date, period_end date, billing_period text,
  method text, status text, idempotence_key text, recorded_by uuid, notes text, funding_source_method_id text,
  destination_account_id text, destination_payment_method_id text, provider_environment text,
  maintenance_net_cents integer, check_usage_cents integer, next_day_usage_cents integer, same_day_usage_cents integer,
  usage_total_cents integer, check_count integer, next_day_count integer, same_day_count integer,
  mortgage_ops_initial_count integer, mortgage_ops_initial_amount_cents integer,
  mortgage_ops_additional_count integer, mortgage_ops_additional_amount_cents integer, occurrence_kind text,
  submitted_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()`;

/**
 * The tables SQL 153 and the accrual touch. `productionUniques` adds the Supabase-era unique rules
 * production carries on check_billing_events ((check, event_type) and (tenant, check, event_type));
 * without them only SQL 84's per-check Mortgage Ops index constrains the table, so SQL 153's own
 * index is what is tested. `extra` runs last (event_type CHECKs, a prepared index, ...).
 */
const schema = ({ productionUniques = false, usageFeeColumns = false, extra = '' } = {}) => `
CREATE ROLE checksops_admin LOGIN NOSUPERUSER NOBYPASSRLS;
GRANT CREATE, USAGE ON SCHEMA public TO checksops_admin;
SET ROLE checksops_admin;
CREATE TABLE public.tenants (
  id uuid PRIMARY KEY, name text, slug text, mortgage_ops_initial_rate_cents integer, mortgage_ops_additional_rate_cents integer,
  subscription_status text, monthly_rate_cents integer, referral_discount_cents integer, is_founding_partner boolean,
  per_check_rate_cents integer, per_check_billing_enabled boolean, next_day_rate_cents integer, same_day_rate_cents integer,
  deposits_enabled boolean NOT NULL DEFAULT true);
CREATE TABLE public.check_intake_items (id uuid PRIMARY KEY, tenant_id uuid, claim_id uuid);
CREATE TABLE public.check_billing_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), price_per_check_cents integer NOT NULL,
  currency text NOT NULL DEFAULT 'usd', active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.mortgage_handling_requests (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, check_intake_item_id uuid, claim_id uuid,
  status text NOT NULL DEFAULT 'requested', accepted_at timestamptz, assigned_employee_id uuid,
  endorsement_order integer, total_mortgagees integer, predecessor_request_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.mortgage_ops_billing_launch (
  singleton boolean PRIMARY KEY DEFAULT true, launched_at timestamptz NOT NULL, environment text, note text,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.check_billing_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, check_intake_item_id uuid,
  payment_transfer_id uuid, event_type text DEFAULT 'check_processing',
  unit_price_cents integer NOT NULL, currency text NOT NULL DEFAULT 'usd', status text NOT NULL DEFAULT 'recorded'
    CHECK (status IN ('recorded','reported','invoiced','failed','voided')),
  billed_at timestamptz NOT NULL DEFAULT now(), billing_period text, invoice_id uuid, source_kind text,
  source_id uuid, claim_id uuid, mortgage_request_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX check_billing_events_one_mortgage_ops_per_check
  ON public.check_billing_events (check_intake_item_id)
  WHERE event_type IN ('mortgage_ops_initial', 'mortgage_ops_additional_check')
    AND status IS DISTINCT FROM 'voided' AND check_intake_item_id IS NOT NULL;
${productionUniques ? `
ALTER TABLE public.check_billing_events
  ADD CONSTRAINT check_billing_events_check_event_unique UNIQUE (check_intake_item_id, event_type);
CREATE UNIQUE INDEX check_billing_events_tenant_check_event_uniq
  ON public.check_billing_events (tenant_id, check_intake_item_id, event_type);` : ''}
CREATE TABLE public.tenant_maintenance_payments (${OCCURRENCE_COLUMNS}${usageFeeColumns ? `,
  invoice_fee_count integer NOT NULL DEFAULT 0, invoice_fee_amount_cents integer NOT NULL DEFAULT 0,
  failed_deposit_count integer NOT NULL DEFAULT 0, failed_deposit_amount_cents integer NOT NULL DEFAULT 0` : ''});
CREATE UNIQUE INDEX tenant_maintenance_payments_tenant_period_uidx
  ON public.tenant_maintenance_payments (tenant_id, billing_period) WHERE billing_period IS NOT NULL;
INSERT INTO public.tenants (id, name, slug, mortgage_ops_initial_rate_cents, mortgage_ops_additional_rate_cents)
  VALUES ('${T}', 'Tenant', 'tenant', 1200, 700);
INSERT INTO public.check_intake_items VALUES ('${CHECK}', '${T}', '${CLAIM}'), ('${CHECK_2}', '${T}', '${CLAIM}');
INSERT INTO public.mortgage_ops_billing_launch (launched_at) VALUES ('2026-01-01T00:00:00Z');
INSERT INTO public.mortgage_handling_requests (id, tenant_id, check_intake_item_id, claim_id, endorsement_order, total_mortgagees, predecessor_request_id) VALUES
  ('${REQ_1}', '${T}', '${CHECK}', '${CLAIM}', 1, 2, NULL),
  ('${REQ_2}', '${T}', '${CHECK}', '${CLAIM}', 2, 2, '${REQ_1}'),
  ('${REQ_3}', '${T}', '${CHECK_2}', '${CLAIM}', NULL, NULL, NULL);
${extra}
RESET ROLE;
`;

/** executeAcceptMortgage's UPDATE: the accepted row the API hands to the accrual. */
const accept = async (client, id) => (await client.query(
  `UPDATE public.mortgage_handling_requests
      SET status = 'in_progress', accepted_at = COALESCE(accepted_at, $2::timestamptz), updated_at = now()
    WHERE id = $1::uuid RETURNING *`, [id, ACCEPTED_AT])).rows[0];

const withServer = async (prefix, port, opts, body) => {
  const { default: pg } = await import('pg');
  const server = startPg(prefix, port);
  const superuser = new pg.Client({ host: server.host, port: server.port, user: 'ubuntu', database: 'postgres' });
  const owner = new pg.Client({ host: server.host, port: server.port, user: 'checksops_admin', database: 'postgres' });
  try {
    await superuser.connect();
    await superuser.query(schema(opts));
    await owner.connect();
    await body({ superuser, owner });
  } finally {
    await owner.end().catch(() => {});
    await superuser.end().catch(() => {});
    server.stop();
  }
};

const events = async (client, where = 'true') => (await client.query(
  `SELECT event_type, check_intake_item_id, claim_id, mortgage_request_id, unit_price_cents, status, billed_at,
          billing_period, source_kind, source_id
     FROM public.check_billing_events WHERE ${where} ORDER BY created_at`)).rows;
const constraintDefs = async (client) => (await client.query(
  `SELECT conname, pg_get_constraintdef(oid) AS def, convalidated FROM pg_constraint
    WHERE conrelid = 'public.check_billing_events'::regclass AND contype = 'c' ORDER BY conname`)).rows;
const indexDef = async (client) => (await client.query(
  `SELECT pg_get_indexdef(to_regclass('public.${INDEX}')) AS def`)).rows[0].def;

test('SQL 153: the 2nd mortgage company is charged a flat $5 once per check (PostgreSQL 16)', { timeout: 240000, skip: pgSkipReason() || false }, async () => {
  await withServer('pg-sql153-fee-', 60150, {}, async ({ superuser, owner }) => {
    // Before SQL 153 the 2nd company's accept records nothing (the API waits for the index).
    const first = await accept(owner, REQ_1);
    assert.equal((await usage.accrueMortgageOpsAcceptedRequest(owner, { request: first })).event.event_type, 'mortgage_ops_initial');
    const second = await accept(owner, REQ_2);
    for (const mod of [usage, engine]) {
      const before = await mod.accrueMortgageOpsAcceptedRequest(owner, { request: second });
      assert.equal(before.duplicate, true); // the check's normal charge is the 1st request's
      assert.deepEqual(before.second_mortgagee, { skipped: 'second_mortgagee_fee_not_ready' });
    }
    assert.deepEqual((await events(superuser)).map((e) => e.event_type), ['mortgage_ops_initial']);

    // The repository's table has no event_type CHECK: SQL 153 adds none.
    const checksBefore = await constraintDefs(superuser);
    await owner.query(SQL_153);
    assert.deepEqual(await constraintDefs(superuser), checksBefore);
    assert.equal(await indexDef(superuser),
      `CREATE UNIQUE INDEX ${INDEX} ON public.check_billing_events USING btree (check_intake_item_id) WHERE ((event_type = '${SECOND}'::text) AND (status IS DISTINCT FROM 'voided'::text) AND (check_intake_item_id IS NOT NULL))`);

    // The 2nd company's accept (the API's retry path: the request is already accepted) records
    // one $5 for the check, its claim and the 2nd request, billed when it was accepted.
    const created = await usage.accrueMortgageOpsAcceptedRequest(owner, { request: second });
    assert.equal(created.duplicate, true);
    assert.equal(created.second_mortgagee.created, true);
    const rows = await events(superuser, `event_type = '${SECOND}'`);
    assert.equal(rows.length, 1);
    assert.deepEqual(
      [rows[0].check_intake_item_id, rows[0].claim_id, rows[0].mortgage_request_id, rows[0].unit_price_cents, rows[0].status,
        rows[0].billed_at.toISOString(), rows[0].billing_period, rows[0].source_kind, rows[0].source_id],
      [CHECK, CLAIM, REQ_2, 500, 'recorded', ACCEPTED_AT, '2026-11', SECOND, CHECK],
    );
    // The 1st company's $12 (the tenant's rate) is untouched; nothing else was added.
    assert.deepEqual((await events(superuser)).map((e) => [e.event_type, e.unit_price_cents, e.mortgage_request_id]),
      [['mortgage_ops_initial', 1200, REQ_1], [SECOND, 500, REQ_2]]);

    // Repeated accepts (either copy of the code) add nothing.
    for (const mod of [usage, engine]) {
      const again = await mod.accrueMortgageOpsAcceptedRequest(owner, { request: second });
      assert.equal(again.duplicate, true);
      assert.equal(again.second_mortgagee.duplicate, true);
    }
    assert.equal((await usage.accrueMortgageOpsAcceptedRequest(owner, { request: first })).duplicate, true);
    assert.equal((await events(superuser, `event_type = '${SECOND}'`)).length, 1);

    // Whoever writes it: a second live 2nd-company event for the check is refused by the index.
    await assert.rejects(superuser.query(
      `INSERT INTO public.check_billing_events (tenant_id, check_intake_item_id, event_type, unit_price_cents)
       VALUES ($1, $2, '${SECOND}', 500)`, [T, CHECK]), (err) => err.code === '23505' && err.constraint === INDEX);
    // The API's ON CONFLICT DO NOTHING insert of a duplicate writes nothing and does not fail.
    await owner.query(
      `INSERT INTO public.check_billing_events (tenant_id, check_intake_item_id, event_type, unit_price_cents, status)
       VALUES ($1, $2, '${SECOND}', 500, 'recorded') ON CONFLICT DO NOTHING`, [T, CHECK]);
    assert.equal((await events(superuser, `event_type = '${SECOND}'`)).length, 1);

    // A request that is not the 2nd company's (no order) on another check: the $10 / $5 rule as before.
    const other = await accept(owner, REQ_3);
    assert.equal((await usage.accrueMortgageOpsAcceptedRequest(owner, { request: other })).event.event_type, 'mortgage_ops_additional_check');

    // Month-end: the period's events, the 2nd company's on its own line; a voided one is skipped.
    let mortgage = await engine.loadMortgageOpsUsageForPeriod(owner, { tenantId: T, period: '2026-11' });
    assert.deepEqual([mortgage.initial.length, mortgage.additional.length, mortgage.secondMortgagee.length], [1, 1, 1]);
    assert.equal(mortgage.secondMortgagee[0].unit_price_cents, 500);
    await superuser.query(`UPDATE public.check_billing_events SET status = 'voided' WHERE event_type = '${SECOND}'`);
    mortgage = await engine.loadMortgageOpsUsageForPeriod(owner, { tenantId: T, period: '2026-11' });
    assert.equal(mortgage.secondMortgagee.length, 0);
    // A voided 2nd-company event stops a re-charge by the API (as for the $10 / $5 events) but no
    // longer holds the index: only live events count.
    assert.equal((await usage.accrueMortgageOpsAcceptedRequest(owner, { request: second })).second_mortgagee.duplicate, true);
    await superuser.query(
      `INSERT INTO public.check_billing_events (tenant_id, check_intake_item_id, event_type, unit_price_cents)
       VALUES ($1, $2, '${SECOND}', 500)`, [T, CHECK]);
    await superuser.query(`DELETE FROM public.check_billing_events WHERE event_type = '${SECOND}' AND status = 'recorded'`);
    await superuser.query(`UPDATE public.check_billing_events SET status = 'recorded' WHERE event_type = '${SECOND}'`);

    // Re-running changes nothing.
    await owner.query(SQL_153);
    assert.deepEqual(await constraintDefs(superuser), checksBefore);
    assert.match(await indexDef(superuser), new RegExp(INDEX));
    assert.equal((await events(superuser, `event_type = '${SECOND}'`)).length, 1);

    // The booked row (SQL 149's columns absent here, so the SQL 153-only insert): the breakdown
    // columns, and the email line read from the row.
    mortgage = await engine.loadMortgageOpsUsageForPeriod(owner, { tenantId: T, period: '2026-11' });
    const totals = engine.assembleInvoiceTotals({
      tenant: { monthly_rate_cents: 10000 }, period: '2026-11', checks: [], nextDay: [], sameDay: [],
      mortgageInitial: mortgage.initial, mortgageAdditional: mortgage.additional, mortgageSecondMortgagee: mortgage.secondMortgagee,
    });
    assert.equal(totals.mortgage_ops_second_mortgagee_amount_cents, 500);
    await owner.query('BEGIN');
    const booked = await engine.createOrGetOccurrence(owner, {
      tenantId: T, period: '2026-11',
      readiness: { amountCents: totals.amount_cents, rateCents: 10000, discountCents: 0, environment: 'sandbox', invoice: totals },
      destination: { accountId: 'acct', paymentMethodId: 'pm' },
    });
    await owner.query('COMMIT');
    const row = (await owner.query('SELECT * FROM public.tenant_maintenance_payments WHERE id = $1', [booked.occurrence.id])).rows[0];
    assert.deepEqual([row.mortgage_ops_second_mortgagee_count, row.mortgage_ops_second_mortgagee_amount_cents], [1, 500]);
    assert.equal(row.amount_cents, 10000 + 1200 + 700 + 500);
    assert.deepEqual(occurrenceInvoiceLines(row).find((l) => /2nd mortgage/.test(l.label)),
      { label: 'Mortgage Ops: 2nd mortgage company', count: 1, amount_cents: 500 });
  });
});

test('SQL 153 with production\'s unique rules and SQL 149\'s columns: 2nd company accepted first', { timeout: 240000, skip: pgSkipReason() || false }, async () => {
  await withServer('pg-sql153-prod-', 60250, { productionUniques: true, usageFeeColumns: true }, async ({ superuser, owner }) => {
    await owner.query(SQL_153);
    await owner.query(SQL_153);
    // The 2nd company's request is accepted first: the check's normal charge plus the $5.
    const second = await accept(owner, REQ_2);
    // As in the API, inside the accept's transaction (the engine copy reads the tenant with savepoints).
    await owner.query('BEGIN');
    const result = await engine.accrueMortgageOpsAcceptedRequest(owner, { request: second });
    await owner.query('COMMIT');
    assert.equal(result.created, true);
    assert.equal(result.second_mortgagee.created, true);
    // Then the 1st company's: no second normal charge; repeats add nothing.
    const first = await accept(owner, REQ_1);
    assert.equal((await usage.accrueMortgageOpsAcceptedRequest(owner, { request: first })).duplicate, true);
    const again = await usage.accrueMortgageOpsAcceptedRequest(owner, { request: second });
    assert.equal(again.duplicate, true);
    assert.equal(again.second_mortgagee.duplicate, true);
    assert.deepEqual((await events(superuser)).map((e) => [e.event_type, e.unit_price_cents, e.mortgage_request_id]),
      [['mortgage_ops_initial', 1200, REQ_2], [SECOND, 500, REQ_2]]);
    const mortgage = await engine.loadMortgageOpsUsageForPeriod(owner, { tenantId: T, period: '2026-11' });
    const totals = engine.assembleInvoiceTotals({
      tenant: { monthly_rate_cents: 0 }, period: '2026-11', checks: [], nextDay: [], sameDay: [],
      mortgageInitial: mortgage.initial, mortgageSecondMortgagee: mortgage.secondMortgagee,
    });
    await owner.query('BEGIN');
    const booked = await engine.createOrGetOccurrence(owner, {
      tenantId: T, period: '2026-11',
      readiness: { amountCents: totals.amount_cents, rateCents: 0, discountCents: 0, environment: 'sandbox', invoice: totals },
      destination: { accountId: 'acct', paymentMethodId: 'pm' },
    });
    await owner.query('COMMIT');
    const row = (await owner.query('SELECT * FROM public.tenant_maintenance_payments WHERE id = $1', [booked.occurrence.id])).rows[0];
    assert.deepEqual([row.mortgage_ops_second_mortgagee_count, row.mortgage_ops_second_mortgagee_amount_cents, row.invoice_fee_count, row.amount_cents],
      [1, 500, 0, 1700]);
  });
});

test('SQL 153: a live event_type CHECK keeps every value it has and gains the new one', { timeout: 240000, skip: pgSkipReason() || false }, async () => {
  const live = ['check_processing', 'moov_next_day', 'mortgage_ops_initial', 'mortgage_ops_additional_check', 'invoice_sent', 'failed_deposit', "starter's"];
  const literal = (v) => `'${v.replace(/'/g, "''")}'`;
  // A row the NOT VALID CHECK does not admit: SQL 153 must keep that CHECK NOT VALID.
  const extra = `
INSERT INTO public.check_billing_events (tenant_id, event_type, unit_price_cents) VALUES ('${T}', 'check_processing', 1);
ALTER TABLE public.check_billing_events ADD CONSTRAINT check_billing_events_event_type_check
  CHECK (event_type IN (${live.map(literal).join(', ')}));
ALTER TABLE public.check_billing_events ADD CONSTRAINT check_billing_events_event_type_legacy
  CHECK (event_type IN ('legacy_type', 'mortgage_ops_initial')) NOT VALID;`;
  await withServer('pg-sql153-check-', 60350, { extra }, async ({ superuser, owner }) => {
    const before = await constraintDefs(superuser);
    assert.equal(before.length, 3); // the two event_type CHECKs and the status CHECK
    const statusBefore = before.find((c) => /status/.test(c.def));
    await owner.query(SQL_153);
    const after = await constraintDefs(superuser);
    const main = after.find((c) => c.conname === 'check_billing_events_event_type_check');
    assert.equal(main.def,
      `CHECK ((event_type = ANY (ARRAY[${[...live, SECOND].map((v) => `${literal(v)}::text`).join(', ')}])))`);
    assert.equal(main.convalidated, true);
    const legacy = after.find((c) => c.conname === 'check_billing_events_event_type_legacy');
    assert.equal(legacy.def, `CHECK ((event_type = ANY (ARRAY['legacy_type'::text, 'mortgage_ops_initial'::text, '${SECOND}'::text]))) NOT VALID`);
    assert.equal(legacy.convalidated, false);
    assert.deepEqual(after.find((c) => /status/.test(c.def)), statusBefore);
    // The new type is accepted; an unknown type is still refused.
    await superuser.query(`ALTER TABLE public.check_billing_events DROP CONSTRAINT check_billing_events_event_type_legacy`);
    await superuser.query(`INSERT INTO public.check_billing_events (tenant_id, check_intake_item_id, event_type, unit_price_cents) VALUES ($1, $2, '${SECOND}', 500)`, [T, CHECK]);
    await assert.rejects(superuser.query(`INSERT INTO public.check_billing_events (tenant_id, event_type, unit_price_cents) VALUES ($1, 'bogus', 1)`, [T]),
      (err) => err.code === '23514');
    // Re-running is a no-op; a value another file adds later (to the live list) is kept on a re-run.
    await owner.query(SQL_153);
    assert.equal((await constraintDefs(superuser)).find((c) => c.conname === main.conname).def, main.def);
    await superuser.query(`ALTER TABLE public.check_billing_events DROP CONSTRAINT check_billing_events_event_type_check;
      ALTER TABLE public.check_billing_events ADD CONSTRAINT check_billing_events_event_type_check
        CHECK (event_type IN (${[...live, SECOND, 'later_type'].map(literal).join(', ')}))`);
    const withLater = (await constraintDefs(superuser)).find((c) => c.conname === main.conname).def;
    await owner.query(SQL_153);
    assert.equal((await constraintDefs(superuser)).find((c) => c.conname === main.conname).def, withLater);
    // Applied to a list without it again (as if a later file rewrote the list from a stale copy):
    // adds it back, keeping that file's values.
    await superuser.query(`ALTER TABLE public.check_billing_events DROP CONSTRAINT check_billing_events_event_type_check;
      DELETE FROM public.check_billing_events WHERE event_type = '${SECOND}';
      ALTER TABLE public.check_billing_events ADD CONSTRAINT check_billing_events_event_type_check
        CHECK (event_type IN ('check_processing', 'stale_only'))`);
    await owner.query(SQL_153);
    assert.equal((await constraintDefs(superuser)).find((c) => c.conname === main.conname).def,
      `CHECK ((event_type = ANY (ARRAY['check_processing'::text, 'stale_only'::text, '${SECOND}'::text])))`);
  });
});

test('SQL 153 refuses, changing nothing: an unrecognized CHECK, duplicates, a different index, missing prerequisites', { timeout: 240000, skip: pgSkipReason() || false }, async () => {
  await withServer('pg-sql153-refuse-', 60450, {}, async ({ superuser, owner }) => {
    const objects = async () => (await superuser.query(
      `SELECT (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.check_billing_events'::regclass) AS cons,
              to_regclass('public.${INDEX}') IS NOT NULL AS idx,
              (SELECT count(*) FROM information_schema.columns WHERE table_name = 'tenant_maintenance_payments'
                AND column_name LIKE 'mortgage_ops_second_mortgagee%') AS cols`)).rows[0];
    const untouched = { cons: '2', idx: false, cols: '0' };

    // A CHECK on event_type of another shape.
    for (const check of [
      `CHECK (event_type <> 'bogus')`,
      `CHECK (event_type IN ('check_processing') OR status = 'voided')`,
      `CHECK (event_type IS NULL OR event_type IN ('check_processing'))`,
    ]) {
      await superuser.query(`ALTER TABLE public.check_billing_events ADD CONSTRAINT odd_event_type ${check}`);
      await assert.rejects(owner.query(SQL_153), (err) => err.code === '55000' && /sql153_event_type_check_unrecognized: odd_event_type/.test(err.message), check);
      assert.deepEqual(await objects(), { ...untouched, cons: '3' });
      await superuser.query('ALTER TABLE public.check_billing_events DROP CONSTRAINT odd_event_type');
    }

    // Two live 2nd-company events for one check.
    await superuser.query(`INSERT INTO public.check_billing_events (tenant_id, check_intake_item_id, event_type, unit_price_cents)
      VALUES ('${T}', '${CHECK}', '${SECOND}', 500), ('${T}', '${CHECK}', '${SECOND}', 500)`);
    await assert.rejects(owner.query(SQL_153), (err) => err.code === '23505' && err.message.includes(`sql153_duplicate_second_mortgagee_events: check_intake_item_id (events): ${CHECK} (2)`));
    assert.deepEqual(await objects(), untouched);
    await superuser.query(`DELETE FROM public.check_billing_events`);

    // Another index already holds the name.
    await superuser.query(`SET ROLE checksops_admin; CREATE INDEX ${INDEX} ON public.check_billing_events (check_intake_item_id); RESET ROLE;`);
    await assert.rejects(owner.query(SQL_153), (err) => err.code === '55000' && /sql153_index_invalid/.test(err.message));
    await superuser.query(`DROP INDEX public.${INDEX}`);
    assert.deepEqual(await objects(), untouched);

    // No endorsement_order (SQL 148's shape), no tenant_maintenance_payments.
    await superuser.query('ALTER TABLE public.mortgage_handling_requests DROP COLUMN endorsement_order');
    await assert.rejects(owner.query(SQL_153), (err) => err.code === '55000'
      && /sql153_prerequisite_missing: mortgage_handling_requests\.endorsement_order/.test(err.message));
    await superuser.query('DROP TABLE public.tenant_maintenance_payments');
    await assert.rejects(owner.query(SQL_153), (err) => err.code === '55000'
      && /sql153_prerequisite_missing: public\.tenant_maintenance_payments, mortgage_handling_requests\.endorsement_order/.test(err.message));
    assert.equal((await objects()).idx, false);
  });
});
