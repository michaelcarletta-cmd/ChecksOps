/**
 * Isolated Mortgage Ops usage accrual.
 *
 * Extracted from live tenant-billing-engine.mjs
 * SHA-256 65b75735825f9a06955d5daba603f74835d106cabf52eb449153c856a59dae2f
 * (staging + production-prep, 2026-10-02). Accept-time behavior is preserved:
 * one check_billing_events row per accepted check, $10 first / $5 additional
 * by claim, idempotent on check_intake_item_id.
 *
 * This module does not import destination/collection engines or
 * provider posting paths.
 */
export const DEFAULT_MORTGAGE_INITIAL_RATE_CENTS = 1000;
export const DEFAULT_MORTGAGE_ADDITIONAL_RATE_CENTS = 500;
export const FEE_MORTGAGE_INITIAL = 'mortgage_ops_initial';
export const FEE_MORTGAGE_ADDITIONAL = 'mortgage_ops_additional_check';
export const MORTGAGE_EVENT_TYPES = [FEE_MORTGAGE_INITIAL, FEE_MORTGAGE_ADDITIONAL];
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

  const existing = await loadMortgageEventByCheck(client, request.check_intake_item_id);
  if (existing) return { ok: true, event: asEvent(existing), duplicate: true, created: false };

  let claimId = request.claim_id || null;
  if (!claimId) {
    const check = (await client.query(
      `SELECT claim_id FROM public.check_intake_items WHERE id = $1::uuid`,
      [request.check_intake_item_id],
    ).catch(() => ({ rows: [] }))).rows[0];
    claimId = check?.claim_id || null;
  }

  await client.query(
    `SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))`,
    [String(request.tenant_id), `mortgage_ops:${claimId || request.check_intake_item_id}`],
  ).catch(() => ({ rows: [] }));

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
  const insertEvent = async (eventType, unit) => {
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
