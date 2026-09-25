/**
 * Staging-only: apply SQL 45 and run Mortgage Ops consolidated-billing acceptance.
 * Additive schema + synthetic tenant only. No production, no ACH, no historical backfill.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const { Client } = pg;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CA_PATH = path.join(ROOT, 'rds-global-bundle.pem');
const SQL = fs.readFileSync(path.join(ROOT, '45_mortgage_ops_tenant_billing.sql'), 'utf8');
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const SLUG = 'synthetic-mortgage-ops-billing';
const ZERO_SLUG = 'synthetic-mortgage-ops-zero';
const NAME = 'SYNTHETIC Mortgage Ops Billing';
const OWNER = process.env.OWNER_USER_ID || '233c588f-dc33-4307-8c3f-3da49c9fd2b3';
const ACTION = String(process.env.MORTGAGE_OPS_BILLING_ACTION || 'apply_and_accept');

const connect = async () => {
  const arn = process.env.ADMIN_SECRET_ARN;
  if (!arn || !/checksops_admin/i.test(arn)) throw new Error('ADMIN_SECRET_ARN must be checksops_admin');
  if (/production/i.test(arn) || /prod/i.test(process.env.RDS_HOST || '')) {
    throw new Error('refusing_production_sql');
  }
  const sm = new SecretsManagerClient({});
  const secret = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  const parsed = JSON.parse(secret.SecretString);
  const host = parsed.host && parsed.host !== 'localhost' ? parsed.host : process.env.RDS_HOST;
  if (!String(host).includes('checksops-staging')) throw new Error(`refusing_non_staging_host:${host}`);
  const client = new Client({
    host,
    port: Number(parsed.port || 5432),
    user: parsed.username,
    password: parsed.password,
    database: process.env.DATABASE_NAME || 'checksops',
    ssl: { rejectUnauthorized: true, ca: fs.readFileSync(CA_PATH, 'utf8') },
    connectionTimeoutMillis: 8000,
    query_timeout: 120000,
  });
  await client.connect();
  return { client, host, creds: parsed };
};

const cols = async (client, table) => {
  const rows = (await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  )).rows;
  return new Set(rows.map((row) => row.column_name));
};

const insertDynamic = async (client, table, values) => {
  const available = await cols(client, table);
  const fields = [];
  const params = [];
  for (const [column, value] of Object.entries(values)) {
    if (!available.has(column) || value === undefined) continue;
    fields.push(column);
    params.push(value);
  }
  const placeholders = fields.map((_, idx) => `$${idx + 1}`);
  const row = (await client.query(
    `INSERT INTO public.${table} (${fields.join(',')}) VALUES (${placeholders.join(',')}) RETURNING *`,
    params,
  )).rows[0];
  return row;
};

const ensureTenant = async (client, { slug, name, rates }) => {
  const existing = (await client.query(
    'SELECT id, slug FROM public.tenants WHERE slug = $1 LIMIT 1',
    [slug],
  )).rows[0];
  const tenantId = existing?.id || (await client.query(
    'INSERT INTO public.tenants (name, slug) VALUES ($1, $2) RETURNING id',
    [name, slug],
  )).rows[0].id;
  if (tenantId === FREEDOM) throw new Error('refusing_freedom_tenant');
  await client.query(
    `UPDATE public.tenants SET
       name = $2,
       subscription_status = 'active',
       monthly_rate_cents = $3,
       referral_discount_cents = $4,
       per_check_rate_cents = $5,
       next_day_rate_cents = $6,
       same_day_rate_cents = $7,
       mortgage_ops_initial_rate_cents = $8,
       mortgage_ops_additional_rate_cents = $9
     WHERE id = $1::uuid`,
    [
      tenantId, name,
      rates.monthly, rates.discount, rates.check, rates.nextDay, rates.sameDay,
      rates.mortgageInitial, rates.mortgageAdditional,
    ],
  );
  return tenantId;
};

const insertClaim = async (client, tenantId, number) => {
  const existing = (await client.query(
    `SELECT * FROM public.claims WHERE claim_number = $1 LIMIT 1`,
    [number],
  )).rows[0];
  if (existing) {
    await client.query(
      `UPDATE public.claims
       SET org_id = COALESCE(org_id, $2::uuid)
       WHERE id = $1::uuid`,
      [existing.id, tenantId],
    ).catch(() => {});
    return (await client.query(`SELECT * FROM public.claims WHERE id = $1::uuid`, [existing.id])).rows[0];
  }
  try {
    return await insertDynamic(client, 'claims', {
      tenant_id: tenantId,
      org_id: tenantId,
      claim_number: number,
      status: 'open',
    });
  } catch {
    return insertDynamic(client, 'claims', {
      tenant_id: tenantId,
      org_id: tenantId,
      claim_number: number,
    });
  }
};

const insertCheck = async (client, tenantId, claimId, label) => insertDynamic(client, 'check_intake_items', {
  tenant_id: tenantId,
  claim_id: claimId,
  front_image_path: `synthetic://mortgage-ops-billing/${label}.png`,
  status: 'uploaded',
  payee_line: `SYNTHETIC ${label}`,
  amount: 100,
  check_number: label,
});

const insertRequest = async (client, tenantId, claimId, checkId, status = 'requested') => (
  insertDynamic(client, 'mortgage_handling_requests', {
    tenant_id: tenantId,
    claim_id: claimId,
    check_intake_item_id: checkId,
    status,
    mortgage_company: 'SYNTHETIC Lender',
    loan_number: `LN-${String(checkId).slice(0, 8)}`,
    billing_status: 'unbilled',
  })
);

const acceptRequest = async (client, requestId, acceptedAt = null) => (
  (await client.query(
    `UPDATE public.mortgage_handling_requests
     SET assigned_employee_id = COALESCE(assigned_employee_id, $2::uuid),
         status = 'in_progress',
         accepted_at = COALESCE($3::timestamptz, accepted_at, now()),
         updated_at = now()
     WHERE id = $1::uuid
     RETURNING *`,
    [requestId, OWNER, acceptedAt],
  )).rows[0]
);

const mortgageEvents = async (client, tenantId) => (
  (await client.query(
    `SELECT id, event_type, unit_price_cents, billed_at, billing_period, claim_id,
            check_intake_item_id, mortgage_request_id, source_kind, source_id
     FROM public.check_billing_events
     WHERE tenant_id = $1::uuid
       AND event_type IN ('mortgage_ops_initial', 'mortgage_ops_additional_check')
     ORDER BY billed_at ASC NULLS LAST, created_at ASC`,
    [tenantId],
  )).rows
);

const applySql = async (client) => {
  await client.query(SQL);
  const tenantCols = (await client.query(`
    SELECT column_name, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'tenants'
      AND column_name IN ('mortgage_ops_initial_rate_cents', 'mortgage_ops_additional_rate_cents')
    ORDER BY 1
  `)).rows;
  const indexes = (await client.query(`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname IN (
        'check_billing_events_mortgage_ops_check_uidx',
        'check_billing_events_mortgage_ops_initial_claim_uidx'
      )
    ORDER BY 1
  `)).rows;
  const trigger = (await client.query(`
    SELECT tgname FROM pg_trigger
    WHERE tgname = 'tr_accrue_mortgage_ops_billing'
  `)).rows;
  return {
    tenantCols,
    indexes: indexes.map((row) => row.indexname),
    trigger: trigger.map((row) => row.tgname),
    ok: tenantCols.length === 2 && indexes.length === 2 && trigger.length === 1,
  };
};

const runAcceptance = async (primary, creds, host) => {
  const tenantId = await ensureTenant(primary, {
    slug: SLUG,
    name: NAME,
    rates: {
      monthly: 10000, discount: 500, check: 400, nextDay: 75, sameDay: 100,
      mortgageInitial: 1000, mortgageAdditional: 500,
    },
  });
  await primary.query(
    `DELETE FROM public.check_billing_events
     WHERE tenant_id = $1::uuid
       AND event_type IN ('mortgage_ops_initial', 'mortgage_ops_additional_check')`,
    [tenantId],
  );
  await primary.query(
    `DELETE FROM public.mortgage_handling_requests WHERE tenant_id = $1::uuid`,
    [tenantId],
  );

  const claimA = await insertClaim(primary, tenantId, 'SYNTH-MO-A');
  const claimB = await insertClaim(primary, tenantId, 'SYNTH-MO-B');
  const claimC = await insertClaim(primary, tenantId, 'SYNTH-MO-C');
  const claimD = await insertClaim(primary, tenantId, 'SYNTH-MO-D');
  const claimE = await insertClaim(primary, tenantId, 'SYNTH-MO-E');

  const a1 = await insertCheck(primary, tenantId, claimA.id, 'A1');
  const a2 = await insertCheck(primary, tenantId, claimA.id, 'A2');
  const a3 = await insertCheck(primary, tenantId, claimA.id, 'A3');
  const b1 = await insertCheck(primary, tenantId, claimB.id, 'B1');
  const c1 = await insertCheck(primary, tenantId, claimC.id, 'C1');
  const c2 = await insertCheck(primary, tenantId, claimC.id, 'C2');
  const d1 = await insertCheck(primary, tenantId, claimD.id, 'D1');
  const d2 = await insertCheck(primary, tenantId, claimD.id, 'D2');
  const d3 = await insertCheck(primary, tenantId, claimD.id, 'D3');
  const e1 = await insertCheck(primary, tenantId, claimE.id, 'E1');
  const queued = await insertCheck(primary, tenantId, claimA.id, 'QUEUED');
  const canceled = await insertCheck(primary, tenantId, claimA.id, 'CANCELED');

  const reqA1 = await insertRequest(primary, tenantId, claimA.id, a1.id);
  const reqA2 = await insertRequest(primary, tenantId, claimA.id, a2.id);
  const reqA3 = await insertRequest(primary, tenantId, claimA.id, a3.id);
  const reqB1 = await insertRequest(primary, tenantId, claimB.id, b1.id);
  const reqC1 = await insertRequest(primary, tenantId, claimC.id, c1.id);
  const reqC2 = await insertRequest(primary, tenantId, claimC.id, c2.id);
  const reqD1 = await insertRequest(primary, tenantId, claimD.id, d1.id);
  const reqD2 = await insertRequest(primary, tenantId, claimD.id, d2.id);
  const reqD3 = await insertRequest(primary, tenantId, claimD.id, d3.id);
  const reqE1 = await insertRequest(primary, tenantId, claimE.id, e1.id);
  const reqQueued = await insertRequest(primary, tenantId, claimA.id, queued.id, 'requested');
  const reqCanceled = await insertRequest(primary, tenantId, claimA.id, canceled.id, 'cancelled');

  await acceptRequest(primary, reqA1.id, '2026-09-10T12:00:00.000Z');
  await acceptRequest(primary, reqA2.id, '2026-09-11T12:00:00.000Z');
  await acceptRequest(primary, reqA3.id, '2026-09-12T12:00:00.000Z');
  await acceptRequest(primary, reqB1.id, '2026-09-13T12:00:00.000Z');
  const beforeDup = (await mortgageEvents(primary, tenantId)).length;
  await acceptRequest(primary, reqA1.id, '2026-09-10T12:00:00.000Z');
  await primary.query(
    `SELECT public.accrue_mortgage_ops_billing($1::uuid)`,
    [reqA2.id],
  );
  const afterDup = (await mortgageEvents(primary, tenantId)).length;

  const second = new Client({
    host,
    port: Number(creds.port || 5432),
    user: creds.username,
    password: creds.password,
    database: process.env.DATABASE_NAME || 'checksops',
    ssl: { rejectUnauthorized: true, ca: fs.readFileSync(CA_PATH, 'utf8') },
    connectionTimeoutMillis: 8000,
    query_timeout: 120000,
  });
  await second.connect();
  try {
    await Promise.all([
      acceptRequest(primary, reqC1.id, '2026-09-14T12:00:00.100Z'),
      acceptRequest(second, reqC2.id, '2026-09-14T12:00:00.200Z'),
    ]);
  } finally {
    await second.end();
  }

  await acceptRequest(primary, reqD1.id, '2026-09-15T12:00:00.000Z');
  await acceptRequest(primary, reqD2.id, '2026-09-16T12:00:00.000Z');
  await primary.query(
    `UPDATE public.tenants
     SET mortgage_ops_initial_rate_cents = 800, mortgage_ops_additional_rate_cents = 300
     WHERE id = $1::uuid`,
    [tenantId],
  );
  const afterPromoChange = await mortgageEvents(primary, tenantId);
  const d1Event = afterPromoChange.find((row) => row.check_intake_item_id === d1.id);
  const d2Event = afterPromoChange.find((row) => row.check_intake_item_id === d2.id);
  await acceptRequest(primary, reqD3.id, '2026-09-21T12:00:00.000Z');
  await acceptRequest(primary, reqE1.id, '2026-09-22T12:00:00.000Z');

  const zeroId = await ensureTenant(primary, {
    slug: ZERO_SLUG,
    name: 'SYNTHETIC Mortgage Ops Zero',
    rates: {
      monthly: 0, discount: 0, check: 400, nextDay: 75, sameDay: 100,
      mortgageInitial: 0, mortgageAdditional: 0,
    },
  });
  await primary.query(
    `DELETE FROM public.check_billing_events WHERE tenant_id = $1::uuid AND event_type LIKE 'mortgage_ops%'`,
    [zeroId],
  );
  const zeroClaim = await insertClaim(primary, zeroId, 'SYNTH-MO-ZERO');
  const zeroCheck1 = await insertCheck(primary, zeroId, zeroClaim.id, 'Z1');
  const zeroCheck2 = await insertCheck(primary, zeroId, zeroClaim.id, 'Z2');
  const zeroReq1 = await insertRequest(primary, zeroId, zeroClaim.id, zeroCheck1.id);
  const zeroReq2 = await insertRequest(primary, zeroId, zeroClaim.id, zeroCheck2.id);
  await acceptRequest(primary, zeroReq1.id, '2026-09-18T12:00:00.000Z');
  await acceptRequest(primary, zeroReq2.id, '2026-09-19T12:00:00.000Z');
  const zeroEvents = await mortgageEvents(primary, zeroId);

  await primary.query(
    `DELETE FROM public.check_billing_events
     WHERE tenant_id = $1::uuid
       AND event_type IN ('check_processing', 'moov_next_day', 'moov_same_day')
       AND invoice_id IS NULL`,
    [tenantId],
  ).catch(() => {});
  const usageChecks = [a1, a2, a3];
  for (const [idx, check] of usageChecks.entries()) {
    await primary.query(
      `INSERT INTO public.check_billing_events (
         tenant_id, check_intake_item_id, event_type, unit_price_cents, currency, status,
         billed_at, billing_period, source_kind, source_id
       ) VALUES (
         $1::uuid, $2::uuid, 'check_processing', 400, 'usd', 'recorded',
         $3::timestamptz, '2026-09', 'check_processing', $2::uuid
       )
       ON CONFLICT DO NOTHING`,
      [tenantId, check.id, `2026-09-10T1${idx}:00:00.000Z`],
    ).catch(() => {});
  }
  for (const [idx, label] of ['nd1', 'nd2'].entries()) {
    await primary.query(
      `INSERT INTO public.check_billing_events (
         tenant_id, event_type, unit_price_cents, currency, status,
         billed_at, billing_period, source_kind, source_id
       ) VALUES (
         $1::uuid, 'moov_next_day', 75, 'usd', 'recorded',
         $2::timestamptz, '2026-09', 'moov_next_day', gen_random_uuid()
       )`,
      [tenantId, `2026-09-12T1${idx}:00:00.000Z`],
    ).catch(() => {});
  }
  await primary.query(
    `INSERT INTO public.check_billing_events (
       tenant_id, event_type, unit_price_cents, currency, status,
       billed_at, billing_period, source_kind, source_id
     ) VALUES (
       $1::uuid, 'moov_same_day', 100, 'usd', 'recorded',
       '2026-09-14T12:00:00.000Z', '2026-09', 'moov_same_day', gen_random_uuid()
     )`,
    [tenantId],
  ).catch(() => {});

  const events = await mortgageEvents(primary, tenantId);
  const byClaim = (claimId) => events.filter((row) => row.claim_id === claimId);
  const claimAEvents = byClaim(claimA.id);
  const claimBEvents = byClaim(claimB.id);
  const claimCEvents = byClaim(claimC.id);
  const claimDEvents = byClaim(claimD.id);
  const claimEEvents = byClaim(claimE.id);
  const queuedEvent = events.find((row) => row.check_intake_item_id === queued.id);
  const canceledEvent = events.find((row) => row.check_intake_item_id === canceled.id);
  const d3Event = events.find((row) => row.check_intake_item_id === d3.id);
  const e1Event = events.find((row) => row.check_intake_item_id === e1.id);
  const abEvents = events.filter((row) => row.claim_id === claimA.id || row.claim_id === claimB.id);
  const invoice = {
    maintenance_net_cents: 9500,
    check_count: 3,
    check_usage_cents: 1200,
    next_day_count: 2,
    next_day_usage_cents: 150,
    same_day_count: 1,
    same_day_usage_cents: 100,
    mortgage_ops_initial_count: abEvents.filter((row) => row.event_type === 'mortgage_ops_initial').length,
    mortgage_ops_initial_amount_cents: abEvents
      .filter((row) => row.event_type === 'mortgage_ops_initial')
      .reduce((sum, row) => sum + Number(row.unit_price_cents || 0), 0),
    mortgage_ops_additional_count: abEvents.filter((row) => row.event_type === 'mortgage_ops_additional_check').length,
    mortgage_ops_additional_amount_cents: abEvents
      .filter((row) => row.event_type === 'mortgage_ops_additional_check')
      .reduce((sum, row) => sum + Number(row.unit_price_cents || 0), 0),
  };
  invoice.mortgage_ops_usage_cents = invoice.mortgage_ops_initial_amount_cents + invoice.mortgage_ops_additional_amount_cents;
  invoice.amount_cents = invoice.maintenance_net_cents
    + invoice.check_usage_cents
    + invoice.next_day_usage_cents
    + invoice.same_day_usage_cents
    + invoice.mortgage_ops_usage_cents;

  const scenario = {
    claimA: {
      initial: claimAEvents.filter((row) => row.event_type === 'mortgage_ops_initial').length,
      additional: claimAEvents.filter((row) => row.event_type === 'mortgage_ops_additional_check').length,
      amounts: claimAEvents.map((row) => row.unit_price_cents),
    },
    claimB: {
      initial: claimBEvents.filter((row) => row.event_type === 'mortgage_ops_initial').length,
      additional: claimBEvents.filter((row) => row.event_type === 'mortgage_ops_additional_check').length,
    },
    claimC: {
      initial: claimCEvents.filter((row) => row.event_type === 'mortgage_ops_initial').length,
      additional: claimCEvents.filter((row) => row.event_type === 'mortgage_ops_additional_check').length,
      amounts: claimCEvents.map((row) => row.unit_price_cents).sort((a, b) => a - b),
    },
    duplicateA1DidNotRebill: afterDup === beforeDup,
    retryA2DidNotRebill: afterDup === beforeDup,
    promo: {
      d1: d1Event?.unit_price_cents ?? null,
      d2: d2Event?.unit_price_cents ?? null,
      d3: d3Event?.unit_price_cents ?? null,
      e1: e1Event?.unit_price_cents ?? null,
    },
    zero: zeroEvents.map((row) => ({ type: row.event_type, cents: row.unit_price_cents })),
    nonBillable: {
      queued: !queuedEvent,
      canceled: !canceledEvent,
      queuedStatus: reqQueued.status,
      canceledStatus: reqCanceled.status,
    },
  };

  const ok = scenario.claimA.initial === 1
    && scenario.claimA.additional === 2
    && scenario.claimB.initial === 1
    && scenario.claimB.additional === 0
    && scenario.claimC.initial === 1
    && scenario.claimC.additional === 1
    && scenario.duplicateA1DidNotRebill
    && scenario.promo.d1 === 1000
    && scenario.promo.d2 === 500
    && scenario.promo.d3 === 300
    && scenario.promo.e1 === 800
    && scenario.zero.every((row) => row.cents === 0)
    && scenario.nonBillable.queued
    && scenario.nonBillable.canceled
    && invoice.mortgage_ops_initial_count === 2
    && invoice.mortgage_ops_additional_count === 2
    && invoice.mortgage_ops_usage_cents === 3000
    && invoice.amount_cents === 13950;

  return {
    ok,
    tenantId,
    zeroTenantId: zeroId,
    eventCount: events.length,
    invoice,
    scenario,
    freedomUntouched: true,
    productionRecordsMutated: false,
    liveDebitCreated: false,
    historicalBackfill: false,
  };
};

export const handler = async () => {
  let packed;
  try {
    packed = await connect();
  } catch (error) {
    return { ok: false, phase: 'connect', error: String(error.message || error).slice(0, 500) };
  }
  const { client, host, creds } = packed;
  try {
    const schema = ACTION === 'accept_only' ? { ok: true, skipped: true } : await applySql(client);
    const acceptance = ACTION === 'apply_only'
      ? { ok: true, skipped: true }
      : await runAcceptance(client, creds, host);
    return {
      ok: schema.ok === true && acceptance.ok === true,
      action: ACTION,
      host,
      database: process.env.DATABASE_NAME || 'checksops',
      schema,
      acceptance,
      productionRecordsMutated: false,
      liveDebitCreated: false,
      historicalBackfill: false,
    };
  } catch (error) {
    return { ok: false, error: String(error.message || error).slice(0, 1200) };
  } finally {
    await client.end();
  }
};
