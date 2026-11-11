/**
 * Isolated Mortgage Ops usage accrual.
 *
 * Extracted from live tenant-billing-engine.mjs
 * SHA-256 65b75735825f9a06955d5daba603f74835d106cabf52eb449153c856a59dae2f
 * (staging + production-prep, 2026-10-02). Accept-time behavior is preserved:
 * one check_billing_events row per accepted check, $10 first / $5 additional
 * by claim, idempotent on check_intake_item_id.
 *
 * SQL 153 (owner 2026-11-10/11, "Flat $5"): the accept of a check's 2nd mortgage
 * company (endorsement_order 2, SQL 148) records one mortgage_ops_second_mortgagee
 * event at a flat SECOND_MORTGAGEE_FEE_CENTS instead; the 1st company's $10 / $5 is
 * unchanged. tenant-billing-engine.mjs carries the same code.
 *
 * This module does not import destination/collection engines or
 * provider posting paths.
 */

// Server-only money-write flag (finding 14): the same statement as
// money-write-flag.mjs SET_MONEY_WRITE_SQL, inlined because this module stays
// import-free (mortgage-ops-usage.test.mjs asserts both).
export const MORTGAGE_USAGE_MONEY_WRITE_SQL = "SELECT set_config('request.money_write', '1', true)";

export const DEFAULT_MORTGAGE_INITIAL_RATE_CENTS = 1000;
export const DEFAULT_MORTGAGE_ADDITIONAL_RATE_CENTS = 500;
export const FEE_MORTGAGE_INITIAL = 'mortgage_ops_initial';
export const FEE_MORTGAGE_ADDITIONAL = 'mortgage_ops_additional_check';
export const MORTGAGE_EVENT_TYPES = [FEE_MORTGAGE_INITIAL, FEE_MORTGAGE_ADDITIONAL];
// SQL 153: the 2nd mortgage company on a check, a flat fee (not a per-tenant rate).
export const FEE_MORTGAGE_SECOND_MORTGAGEE = 'mortgage_ops_second_mortgagee';
export const SECOND_MORTGAGEE_FEE_CENTS = 500;
// SQL 153's unique index; until it exists the API records no 2nd-company fee.
export const SECOND_MORTGAGEE_READY_SQL =
  "SELECT to_regclass('public.check_billing_events_one_second_mortgagee_per_check') IS NOT NULL AS ready";
export const LIVE_TENANT_BILLING_ENGINE_SHA256 =
  '65b75735825f9a06955d5daba603f74835d106cabf52eb449153c856a59dae2f';

export const mortgageOpsAcceptedBeforeLaunch = (acceptedAt, launchedAt) => {
  if (!acceptedAt || !launchedAt) return false;
  return new Date(acceptedAt).getTime() < new Date(launchedAt).getTime();
};

export async function loadMortgageOpsBillingLaunch(client) {
  try {
    const row = (await client.query(
      `SELECT launched_at, environment, note, created_at
       FROM public.mortgage_ops_billing_launch
       WHERE singleton IS TRUE
       LIMIT 1`,
    )).rows[0] || null;
    return { present: true, launch: row };
  } catch {
    return { present: false, launch: null };
  }
}

export const periodKey = (date = new Date()) => {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) throw new Error('invalid_billing_date');
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
};

/** Explicit 0 is a free promotion and must not fall back to $10. */
export const resolveMortgageInitialRateCents = (tenant) => {
  if (tenant?.mortgage_ops_initial_rate_cents === undefined || tenant?.mortgage_ops_initial_rate_cents === null) {
    return DEFAULT_MORTGAGE_INITIAL_RATE_CENTS;
  }
  const stored = Number(tenant.mortgage_ops_initial_rate_cents);
  return Number.isFinite(stored) ? Math.max(0, stored) : DEFAULT_MORTGAGE_INITIAL_RATE_CENTS;
};

/** Explicit 0 is a free promotion and must not fall back to $5. */
export const resolveMortgageAdditionalRateCents = (tenant) => {
  if (tenant?.mortgage_ops_additional_rate_cents === undefined || tenant?.mortgage_ops_additional_rate_cents === null) {
    return DEFAULT_MORTGAGE_ADDITIONAL_RATE_CENTS;
  }
  const stored = Number(tenant.mortgage_ops_additional_rate_cents);
  return Number.isFinite(stored) ? Math.max(0, stored) : DEFAULT_MORTGAGE_ADDITIONAL_RATE_CENTS;
};

/** The 2nd mortgage company's request on a check (SQL 148: endorsement_order 2). */
export const mortgageRequestIsSecondMortgagee = (request) => Number(request?.endorsement_order) === 2;

export const mortgageRequestIsAccepted = (request) => {
  if (!request) return false;
  if (!request.accepted_at) return false;
  return ['in_progress', 'completed'].includes(String(request.status || ''));
};

const asEvent = (row) => ({
  id: row.id,
  tenant_id: row.tenant_id,
  event_type: row.event_type,
  unit_price_cents: Number(row.unit_price_cents || 0),
  billed_at: row.billed_at,
  billing_period: row.billing_period,
  invoice_id: row.invoice_id || null,
  status: row.status,
  source_kind: row.source_kind || row.event_type,
  source_id: row.source_id || row.check_intake_item_id || row.payment_transfer_id,
  check_intake_item_id: row.check_intake_item_id || null,
  payment_transfer_id: row.payment_transfer_id || null,
  claim_id: row.claim_id || null,
  mortgage_request_id: row.mortgage_request_id || null,
});

const loadMortgageEventByCheck = async (client, checkId) => (
  (await client.query(
    `SELECT id, tenant_id, event_type, unit_price_cents, billed_at, billing_period,
            invoice_id, status, source_kind, source_id, check_intake_item_id,
            payment_transfer_id, claim_id, mortgage_request_id
     FROM public.check_billing_events
     WHERE check_intake_item_id = $1::uuid
       AND event_type IN ('mortgage_ops_initial', 'mortgage_ops_additional_check')
     LIMIT 1`,
    [checkId],
  ).catch(() => ({ rows: [] }))).rows[0] || null
);

const loadSecondMortgageeEventByCheck = async (client, checkId) => (
  (await client.query(
    `SELECT id, tenant_id, event_type, unit_price_cents, billed_at, billing_period,
            invoice_id, status, source_kind, source_id, check_intake_item_id,
            payment_transfer_id, claim_id, mortgage_request_id
     FROM public.check_billing_events
     WHERE check_intake_item_id = $1::uuid
       AND event_type = 'mortgage_ops_second_mortgagee'
     ORDER BY (status IS DISTINCT FROM 'voided') DESC
     LIMIT 1`,
    [checkId],
  ).catch(() => ({ rows: [] }))).rows[0] || null
);

const resolveClaimId = async (client, request) => {
  if (request.claim_id) return request.claim_id;
  const check = (await client.query(
    `SELECT claim_id FROM public.check_intake_items WHERE id = $1::uuid`,
    [request.check_intake_item_id],
  ).catch(() => ({ rows: [] }))).rows[0];
  return check?.claim_id || null;
};

const lockMortgageOpsClaim = (client, request, claimId) => client.query(
  `SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))`,
  [String(request.tenant_id), `mortgage_ops:${claimId || request.check_intake_item_id}`],
).catch(() => ({ rows: [] }));

/** One Mortgage Ops event for the accepted request (a preview row when persist is false). */
const insertMortgageOpsEvent = async (client, {
  request, claimId, eventType, unit, persist,
}) => {
  const billedAt = request.accepted_at;
  const period = periodKey(new Date(billedAt));
  if (!persist) {
    return {
      id: null,
      tenant_id: request.tenant_id,
      event_type: eventType,
      unit_price_cents: unit,
      billed_at: billedAt,
      billing_period: period,
      invoice_id: null,
      status: 'recorded',
      source_kind: eventType,
      source_id: request.check_intake_item_id,
      check_intake_item_id: request.check_intake_item_id,
      payment_transfer_id: null,
      claim_id: claimId,
      mortgage_request_id: request.id,
      preview: true,
    };
  }
  // Server-only money-write flag for the check_billing_events insert (finding 14).
  await client.query(MORTGAGE_USAGE_MONEY_WRITE_SQL).catch(() => {});
  return (await client.query(
    `INSERT INTO public.check_billing_events (
       tenant_id, check_intake_item_id, payment_transfer_id, event_type,
       unit_price_cents, currency, status, billed_at, billing_period,
       source_kind, source_id, claim_id, mortgage_request_id
     ) VALUES (
       $1::uuid, $2::uuid, NULL, $3, $4, 'usd', 'recorded', $5::timestamptz, $6,
       $3, $2::uuid, $7::uuid, $8::uuid
     )
     ON CONFLICT DO NOTHING
     RETURNING id, tenant_id, event_type, unit_price_cents, billed_at, billing_period,
               invoice_id, status, source_kind, source_id, check_intake_item_id,
               payment_transfer_id, claim_id, mortgage_request_id`,
    [
      request.tenant_id,
      request.check_intake_item_id,
      eventType,
      unit,
      billedAt,
      period,
      claimId,
      request.id,
    ],
  ).catch(() => ({ rows: [] }))).rows[0] || null;
};

/**
 * SQL 153: the accept of the 2nd mortgage company's request records one flat
 * mortgage_ops_second_mortgagee event for the check (never the $10 / $5 types,
 * which stay with the 1st company's request). Nothing before SQL 153 is applied.
 */
async function accrueSecondMortgageeAcceptedRequest(client, { request, persist }) {
  const ready = (await client.query(SECOND_MORTGAGEE_READY_SQL).catch(() => ({ rows: [] }))).rows[0];
  if (ready?.ready !== true) return { skipped: 'second_mortgagee_fee_not_ready' };

  const existing = await loadSecondMortgageeEventByCheck(client, request.check_intake_item_id);
  if (existing) return { ok: true, event: asEvent(existing), duplicate: true, created: false };

  const claimId = await resolveClaimId(client, request);
  await lockMortgageOpsClaim(client, request, claimId);

  const locked = await loadSecondMortgageeEventByCheck(client, request.check_intake_item_id);
  if (locked) return { ok: true, event: asEvent(locked), duplicate: true, created: false };

  const inserted = await insertMortgageOpsEvent(client, {
    request, claimId, eventType: FEE_MORTGAGE_SECOND_MORTGAGEE, unit: SECOND_MORTGAGEE_FEE_CENTS, persist,
  });
  if (!inserted) {
    const raced = await loadSecondMortgageeEventByCheck(client, request.check_intake_item_id);
    if (raced) return { ok: true, event: asEvent(raced), duplicate: true, created: false };
    return { skipped: 'not_inserted' };
  }
  return { ok: true, event: asEvent(inserted), created: !inserted.preview, duplicate: false };
}

export async function loadMortgageOpsTenantRates(client, tenantId) {
  const tenant = (await client.query(
    `SELECT id, name, slug, mortgage_ops_initial_rate_cents, mortgage_ops_additional_rate_cents
     FROM public.tenants WHERE id = $1::uuid`,
    [tenantId],
  ).catch(() => ({ rows: [] }))).rows[0];
  if (!tenant) return { ok: false, error: 'tenant_not_found', statusCode: 404 };
  return { ok: true, tenant };
}

export async function accrueMortgageOpsAcceptedRequest(client, {
  request,
  tenant = null,
  persist = true,
}) {
  if (!request?.id || !request?.tenant_id || !request?.check_intake_item_id) {
    return { skipped: 'incomplete_request' };
  }
  if (!mortgageRequestIsAccepted(request)) {
    return { skipped: 'not_accepted' };
  }

  const launchState = await loadMortgageOpsBillingLaunch(client);
  if (launchState.present && !launchState.launch) {
    return { skipped: 'launch_cutoff_unset' };
  }
  if (launchState.launch && mortgageOpsAcceptedBeforeLaunch(request.accepted_at, launchState.launch.launched_at)) {
    return {
      skipped: 'before_launch_cutoff',
      launched_at: launchState.launch.launched_at,
    };
  }

  if (mortgageRequestIsSecondMortgagee(request)) {
    return accrueSecondMortgageeAcceptedRequest(client, { request, persist });
  }

  const existing = await loadMortgageEventByCheck(client, request.check_intake_item_id);
  if (existing) return { ok: true, event: asEvent(existing), duplicate: true, created: false };

  const claimId = await resolveClaimId(client, request);
  await lockMortgageOpsClaim(client, request, claimId);

  const locked = await loadMortgageEventByCheck(client, request.check_intake_item_id);
  if (locked) return { ok: true, event: asEvent(locked), duplicate: true, created: false };

  let billingTenant = tenant;
  if (!billingTenant) {
    const ctx = await loadMortgageOpsTenantRates(client, request.tenant_id);
    if (!ctx.ok) return ctx;
    billingTenant = ctx.tenant;
  }

  const prior = claimId
    ? (await client.query(
      `SELECT id, event_type FROM public.check_billing_events
       WHERE tenant_id = $1::uuid
         AND claim_id = $2::uuid
         AND event_type IN ('mortgage_ops_initial', 'mortgage_ops_additional_check')
         AND status IS DISTINCT FROM 'voided'`,
      [request.tenant_id, claimId],
    ).catch(() => ({ rows: [] }))).rows
    : [];

  const classifyAdditional = prior.length > 0;
  const insertEvent = (eventType, unit) => insertMortgageOpsEvent(client, {
    request, claimId, eventType, unit, persist,
  });

  const preferredType = classifyAdditional ? FEE_MORTGAGE_ADDITIONAL : FEE_MORTGAGE_INITIAL;
  const preferredRate = classifyAdditional
    ? resolveMortgageAdditionalRateCents(billingTenant)
    : resolveMortgageInitialRateCents(billingTenant);
  let inserted = await insertEvent(preferredType, preferredRate);
  if (!inserted && !classifyAdditional && persist) {
    inserted = await insertEvent(
      FEE_MORTGAGE_ADDITIONAL,
      resolveMortgageAdditionalRateCents(billingTenant),
    );
  }
  if (!inserted) {
    const raced = await loadMortgageEventByCheck(client, request.check_intake_item_id);
    if (raced) return { ok: true, event: asEvent(raced), duplicate: true, created: false };
    return { skipped: 'not_inserted' };
  }
  return { ok: true, event: asEvent(inserted), created: !inserted.preview, duplicate: false };
}
