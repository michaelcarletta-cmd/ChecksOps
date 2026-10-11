/**
 * Monthly ChecksOps tenant subscription billing engine.
 * One occurrence per (tenant_id, billing_period). Same path for scheduler and Pull Now.
 *
 * Consolidated invoice:
 *   maintenance - discount + check_processing + moov_next_day + moov_same_day
 *   + mortgage_ops_initial + mortgage_ops_additional_check
 * Instant is schema-compatible but never generated or billed.
 * Mortgage Ops accrues on Accept (status in_progress + accepted_at), not on submit.
 */
import {
  billingEnvironment,
  billingShouldSimulate,
  billingVerificationPostEnabled,
  billingVerificationShouldSimulate,
  monthlyBillingEnabled,
  monthlyBillingProductionPostEnabled,
  resolveBillingDestination,
  resolveBillingMoovContext,
} from './tenant-billing-destination.mjs';
import {
  collectTenantObligation,
  classifyCollectionStatus,
  receivedCentsFromLegs,
} from './tenant-collection-v2.mjs';

export const BILLING_STATUSES = ['due', 'submitted', 'settled', 'failed', 'returned'];
const TERMINAL_SUCCESS = new Set(['settled']);
const IN_FLIGHT = new Set(['submitted']);

export const OCCURRENCE_KIND_MONTHLY = 'monthly_subscription';
export const OCCURRENCE_KIND_VERIFICATION = 'billing_verification';
export const OCCURRENCE_KIND_LEGACY = 'legacy';
export const BILLING_VERIFICATION_AMOUNT_CENTS = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const DEFAULT_CHECK_RATE_CENTS = 400;
export const DEFAULT_NEXT_DAY_RATE_CENTS = 75;
export const DEFAULT_SAME_DAY_RATE_CENTS = 100;
export const DEFAULT_MORTGAGE_INITIAL_RATE_CENTS = 1000;
export const DEFAULT_MORTGAGE_ADDITIONAL_RATE_CENTS = 500;
export const MAX_RATE_CENTS = 1_000_000;

/** Safest existing billable point: transfer actually completed (webhook sets completed_at). */
export const BILLABLE_TRANSFER_STATUSES = new Set(['completed', 'settled', 'succeeded']);
export const VOIDED_CHECK_STATUSES = new Set(['voided', 'void']);

export const FEE_CHECK = 'check_processing';
export const FEE_NEXT_DAY = 'moov_next_day';
export const FEE_SAME_DAY = 'moov_same_day';
export const FEE_INSTANT = 'moov_instant';
export const FEE_MORTGAGE_INITIAL = 'mortgage_ops_initial';
export const FEE_MORTGAGE_ADDITIONAL = 'mortgage_ops_additional_check';
export const MORTGAGE_EVENT_TYPES = [FEE_MORTGAGE_INITIAL, FEE_MORTGAGE_ADDITIONAL];

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

/** Current accruing UTC calendar month. Preview / current amount due. */
export const accrualPeriodKey = (date = new Date()) => periodKey(date);

/**
 * Collection on billing-day of month M closes the previous UTC calendar month.
 * October 1 → 2026-09. UTC boundaries only; UI local time is ignored.
 */
export const collectionPeriodKey = (date = new Date()) => {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) throw new Error('invalid_billing_date');
  return periodKey(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)));
};

/**
 * Pull Now default period:
 *   on the tenant billing day → closed previous month (Oct 1 + day 1 → September)
 *   otherwise → current accruing month (in-month early collection)
 */
export const defaultPullPeriodKey = (date = new Date(), billingDay = 1) => {
  const d = date instanceof Date ? date : new Date(date);
  const day = Math.min(28, Math.max(1, Number(billingDay) || 1));
  if (d.getUTCDate() === day) return collectionPeriodKey(d);
  return accrualPeriodKey(d);
};

export const periodBounds = (period) => {
  const [ys, ms] = String(period).split('-');
  const y = Number(ys);
  const m = Number(ms);
  if (!y || !m || m < 1 || m > 12) throw new Error('invalid_billing_period');
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 1));
  return {
    period,
    period_start: start.toISOString().slice(0, 10),
    period_end: end.toISOString().slice(0, 10),
  };
};

export const billingIdempotencyKey = (tenantId, period) => `billing:${tenantId}:${period}`;

export const billingVerificationIdempotencyKey = (tenantId, verificationId) => (
  `billing_verification:${tenantId}:${verificationId}`
);

export const nextPeriodAfter = (period) => {
  const [ys, ms] = String(period).split('-');
  const start = new Date(Date.UTC(Number(ys), Number(ms) - 1, 1));
  start.setUTCMonth(start.getUTCMonth() + 1);
  return periodKey(start);
};

export const nextBillingDate = (billingDay, from = new Date()) => {
  const day = Math.min(28, Math.max(1, Number(billingDay) || 1));
  const y = from.getUTCFullYear();
  const m = from.getUTCMonth();
  const candidate = new Date(Date.UTC(y, m, day));
  if (candidate <= from) {
    return new Date(Date.UTC(y, m + 1, day)).toISOString().slice(0, 10);
  }
  return candidate.toISOString().slice(0, 10);
};

export const netFeeCents = (rateCents, discountCents) => (
  Math.max(0, Number(rateCents || 0) - Number(discountCents || 0))
);

const fail = (error, extra = {}) => ({ ok: false, error, ...extra });

export const parseRateCents = (value, field) => {
  if (value === undefined || value === null || value === '') {
    return { ok: true, cents: undefined };
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || !Number.isInteger(numeric)) return fail(`invalid_${field}`);
  if (numeric < 0 || numeric > MAX_RATE_CENTS) return fail(`invalid_${field}`);
  return { ok: true, cents: numeric };
};

export const resolveCheckRateCents = (tenant) => {
  const stored = Number(tenant?.per_check_rate_cents);
  return stored > 0 ? stored : DEFAULT_CHECK_RATE_CENTS;
};

export const resolveNextDayRateCents = (tenant) => {
  if (tenant?.next_day_rate_cents === undefined || tenant?.next_day_rate_cents === null) {
    return DEFAULT_NEXT_DAY_RATE_CENTS;
  }
  return Math.max(0, Number(tenant.next_day_rate_cents) || 0);
};

export const resolveSameDayRateCents = (tenant) => {
  if (tenant?.same_day_rate_cents === undefined || tenant?.same_day_rate_cents === null) {
    return DEFAULT_SAME_DAY_RATE_CENTS;
  }
  return Math.max(0, Number(tenant.same_day_rate_cents) || 0);
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

export const feeTypeForTransfer = (transfer) => {
  const speed = String(transfer?.requested_speed || transfer?.speed || 'standard')
    .toLowerCase()
    .replace(/-/g, '_');
  if (['instant', 'rtp', 'instant_ach', 'moov_instant'].includes(speed)) return null;
  if (speed === 'same_day' || speed === 'moov_same_day') return FEE_SAME_DAY;
  if (['standard', 'next_day', 'moov_next_day', 'ach'].includes(speed)) return FEE_NEXT_DAY;
  return null;
};

export const transferIsQualifying = (transfer) => {
  if (!transfer) return false;
  const status = String(transfer.status || '').toLowerCase();
  if (['failed', 'canceled', 'cancelled', 'ready', 'pending', 'created'].includes(status)) {
    return false;
  }
  if (transfer.completed_at) return true;
  return BILLABLE_TRANSFER_STATUSES.has(status);
};

const utcBounds = (period) => {
  const bounds = periodBounds(period);
  return {
    ...bounds,
    startIso: `${bounds.period_start}T00:00:00.000Z`,
    endIso: `${bounds.period_end}T00:00:00.000Z`,
  };
};

export async function actorIsPlatformOwner(client) {
  const row = (await client.query(
    `SELECT COALESCE(public.is_platform_owner(), false) AS ok`,
  )).rows[0];
  return row?.ok === true;
}

export async function canAuthorizeTenantBilling(client, userId, tenantId) {
  if (await actorIsPlatformOwner(client)) return true;
  const row = (await client.query(
    `SELECT role FROM public.tenant_users
     WHERE user_id = $1::uuid AND tenant_id = $2::uuid
     LIMIT 1`,
    [userId, tenantId],
  )).rows[0];
  return String(row?.role || '') === 'admin';
}

export async function canViewTenantBilling(client, userId, tenantId) {
  if (await actorIsPlatformOwner(client)) return true;
  const row = (await client.query(
    `SELECT role FROM public.tenant_users
     WHERE user_id = $1::uuid AND tenant_id = $2::uuid
     LIMIT 1`,
    [userId, tenantId],
  )).rows[0];
  return Boolean(row?.role);
}

const capabilityEntries = (capabilities) => {
  if (Array.isArray(capabilities)) return capabilities;
  if (capabilities && typeof capabilities === 'object') return Object.values(capabilities);
  return [];
};

const sandboxCollectFundsAvailable = (account, env) => {
  if (env !== 'sandbox') return false;
  return capabilityEntries(account?.capabilities).some((entry) => {
    const name = String(entry?.capability || entry || '');
    const status = String(entry?.status || (typeof entry === 'string' ? 'pending' : '')).toLowerCase();
    const collect = name === 'collect-funds' || name === 'collect-funds.ach';
    return collect && !['disabled', 'disconnected', 'errored'].includes(status);
  });
};

export async function loadTenantBillingContext(client, tenantId) {
  const tenant = (await client.query(
    `SELECT id, name, slug, subscription_status, monthly_rate_cents, referral_discount_cents,
            is_founding_partner, per_check_rate_cents, per_check_billing_enabled,
            next_day_rate_cents, same_day_rate_cents,
            mortgage_ops_initial_rate_cents, mortgage_ops_additional_rate_cents
     FROM public.tenants WHERE id = $1::uuid`,
    [tenantId],
  ).catch(() => client.query(
    `SELECT id, name, slug, subscription_status, monthly_rate_cents, referral_discount_cents,
            is_founding_partner, per_check_rate_cents, per_check_billing_enabled,
            next_day_rate_cents, same_day_rate_cents
     FROM public.tenants WHERE id = $1::uuid`,
    [tenantId],
  ))).rows[0];
  if (!tenant) return fail('tenant_not_found', { statusCode: 404 });
  const settings = (await client.query(
    `SELECT tenant_id, billing_enabled, billing_day_of_month, next_period_start, updated_at
     FROM public.tenant_billing_settings WHERE tenant_id = $1::uuid`,
    [tenantId],
  ).catch(() => ({ rows: [] }))).rows[0] || {
    tenant_id: tenantId,
    billing_enabled: false,
    billing_day_of_month: 1,
    next_period_start: null,
  };
  const authorization = (await client.query(
    `SELECT id, tenant_id, stakeholder_account_id, auto_debit_enabled, ach_authorized_at,
            ach_authorized_by, verification_status, provider_payment_method_id,
            provider_bank_account_id, provider_account_id, provider_environment,
            nickname, account_holder_name, account_number_last4
     FROM public.tenant_billing_accounts WHERE tenant_id = $1::uuid`,
    [tenantId],
  ).catch(() => ({ rows: [] }))).rows[0] || null;
  return { ok: true, tenant, settings, authorization };
}

export async function evaluateBillingReadiness(client, {
  tenantId, period, destination, environment,
}) {
  const ctx = await loadTenantBillingContext(client, tenantId);
  if (!ctx.ok) return ctx;
  const { tenant, settings, authorization } = ctx;
  const amountCents = netFeeCents(tenant.monthly_rate_cents, tenant.referral_discount_cents);
  const reasons = [];
  if (String(tenant.subscription_status || '') !== 'active') reasons.push('tenant_inactive');
  if (settings.billing_enabled !== true) reasons.push('billing_paused');
  if (!authorization) reasons.push('missing_authorization');
  else {
    if (authorization.auto_debit_enabled !== true) reasons.push('auto_debit_disabled');
    if (!authorization.ach_authorized_at) reasons.push('missing_ach_authorization');
    if (!authorization.provider_payment_method_id) reasons.push('missing_funding_source');
  }
  if (!(amountCents > 0)) reasons.push('invalid_amount');
  if (!destination?.ok) reasons.push('destination_unresolved');

  const env = environment || billingEnvironment();
  const account = (await client.query(
    `SELECT provider_account_id, onboarding_status, can_ach_debit, can_send_payments,
            verification_status, capabilities
     FROM public.payment_provider_accounts
     WHERE tenant_id = $1::uuid AND provider = 'moov' AND environment = $2
     ORDER BY updated_at DESC NULLS LAST LIMIT 1`,
    [tenantId, env],
  ).catch(() => ({ rows: [] }))).rows[0] || null;
  if (!account?.provider_account_id) reasons.push('moov_account_missing');
  else {
    if (account.onboarding_status && account.onboarding_status !== 'active') {
      const sandboxIncompleteOk = env === 'sandbox'
        && Boolean(account.provider_account_id)
        && !['suspended', 'restricted'].includes(String(account.onboarding_status));
      if (!sandboxIncompleteOk) reasons.push('moov_account_inactive');
    }
    if (account.can_ach_debit === false && !sandboxCollectFundsAvailable(account, env)) {
      reasons.push('ach_capability_unavailable');
    }
    if (
      authorization?.provider_account_id
      && authorization.provider_account_id !== account.provider_account_id
    ) {
      reasons.push('funding_source_account_mismatch');
    }
  }

  if (authorization?.provider_payment_method_id) {
    const method = (await client.query(
      `SELECT id, connection_status, verification_status, can_send, provider_payment_method_id
       FROM public.payment_provider_methods
       WHERE tenant_id = $1::uuid
         AND provider_payment_method_id = $2
         AND environment = $3
       LIMIT 1`,
      [tenantId, authorization.provider_payment_method_id, env],
    ).catch(() => ({ rows: [] }))).rows[0];
    if (!method) reasons.push('funding_source_not_found');
    else if (String(method.connection_status || '') !== 'connected') reasons.push('bank_disconnected');
    else if (method.can_send === false) reasons.push('funding_source_cannot_debit');
  }

  return {
    ok: reasons.length === 0,
    ready: reasons.length === 0,
    reasons,
    tenant,
    settings,
    authorization,
    amountCents,
    rateCents: Number(tenant.monthly_rate_cents || 0),
    discountCents: Number(tenant.referral_discount_cents || 0),
    maintenanceNetCents: amountCents,
    perCheckRateCents: resolveCheckRateCents(tenant),
    nextDayRateCents: resolveNextDayRateCents(tenant),
    sameDayRateCents: resolveSameDayRateCents(tenant),
    mortgageInitialRateCents: resolveMortgageInitialRateCents(tenant),
    mortgageAdditionalRateCents: resolveMortgageAdditionalRateCents(tenant),
    period: period || accrualPeriodKey(),
    destination,
    environment: env,
    account,
  };
}

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

export async function loadCheckUsageForPeriod(client, { tenantId, period }) {
  const bounds = utcBounds(period);
  const rows = (await client.query(
    `SELECT e.id, e.tenant_id, e.event_type, e.unit_price_cents, e.billed_at, e.billing_period,
            e.invoice_id, e.status, e.source_kind, e.source_id, e.check_intake_item_id,
            e.payment_transfer_id, c.status AS check_status
     FROM public.check_billing_events e
     LEFT JOIN public.check_intake_items c ON c.id = e.check_intake_item_id
     WHERE e.tenant_id = $1::uuid
       AND e.event_type = $2
       AND e.billed_at >= $3::timestamptz
       AND e.billed_at < $4::timestamptz
       AND e.status IS DISTINCT FROM 'voided'`,
    [tenantId, FEE_CHECK, bounds.startIso, bounds.endIso],
  ).catch(() => ({ rows: [] }))).rows;

  const included = [];
  const excludedVoided = [];
  for (const row of rows) {
    const voided = VOIDED_CHECK_STATUSES.has(String(row.check_status || '').toLowerCase());
    if (voided && !row.invoice_id) {
      excludedVoided.push(asEvent(row));
      continue;
    }
    included.push(asEvent(row));
  }
  return { included, excludedVoided };
}

export async function persistMoovUsageForPeriod(client, { tenant, period, persist }) {
  const tenantId = tenant.id;
  const bounds = utcBounds(period);
  const transfers = (await client.query(
    `SELECT id, tenant_id, status, speed, requested_speed, completed_at, created_at,
            provider_transfer_id, provider_fee_cents, platform_fee_cents
     FROM public.payment_transfers
     WHERE tenant_id = $1::uuid
       AND provider = 'moov'
       AND COALESCE(completed_at, created_at) >= $2::timestamptz
       AND COALESCE(completed_at, created_at) < $3::timestamptz`,
    [tenantId, bounds.startIso, bounds.endIso],
  ).catch(() => ({ rows: [] }))).rows;

  const existing = (await client.query(
    `SELECT id, payment_transfer_id, event_type, unit_price_cents, billed_at, billing_period,
            invoice_id, status, source_kind, source_id, tenant_id, check_intake_item_id
     FROM public.check_billing_events
     WHERE tenant_id = $1::uuid
       AND event_type IN ('moov_next_day', 'moov_same_day', 'moov_instant')
       AND payment_transfer_id IS NOT NULL`,
    [tenantId],
  ).catch(() => ({ rows: [] }))).rows;
  const existingByTransfer = new Map(
    existing.map((row) => [`${row.payment_transfer_id}:${row.event_type}`, row]),
  );

  const created = [];
  const skipped = [];
  for (const transfer of transfers) {
    const feeType = feeTypeForTransfer(transfer);
    if (!feeType) {
      skipped.push({ id: transfer.id, reason: 'instant_or_unknown_speed', speed: transfer.speed });
      continue;
    }
    if (!transferIsQualifying(transfer)) {
      skipped.push({ id: transfer.id, reason: 'not_qualifying', status: transfer.status });
      continue;
    }
    const key = `${transfer.id}:${feeType}`;
    if (existingByTransfer.has(key)) {
      created.push(asEvent(existingByTransfer.get(key)));
      continue;
    }
    const unit = feeType === FEE_SAME_DAY
      ? resolveSameDayRateCents(tenant)
      : resolveNextDayRateCents(tenant);
    const billedAt = transfer.completed_at || transfer.created_at || bounds.startIso;
    if (!persist) {
      created.push({
        id: null,
        tenant_id: tenantId,
        event_type: feeType,
        unit_price_cents: unit,
        billed_at: billedAt,
        billing_period: period,
        invoice_id: null,
        status: 'recorded',
        source_kind: feeType,
        source_id: transfer.id,
        check_intake_item_id: null,
        payment_transfer_id: transfer.id,
        preview: true,
      });
      continue;
    }
    const inserted = (await client.query(
      `INSERT INTO public.check_billing_events (
         tenant_id, check_intake_item_id, payment_transfer_id, event_type,
         unit_price_cents, currency, status, billed_at, billing_period,
         source_kind, source_id
       ) VALUES (
         $1::uuid, NULL, $2::uuid, $3, $4, 'usd', 'recorded', $5::timestamptz, $6, $7, $2::uuid
       )
       ON CONFLICT DO NOTHING
       RETURNING id, tenant_id, event_type, unit_price_cents, billed_at, billing_period,
                 invoice_id, status, source_kind, source_id, check_intake_item_id,
                 payment_transfer_id`,
      [tenantId, transfer.id, feeType, unit, billedAt, period, feeType],
    ).catch(async () => {
      const again = (await client.query(
        `SELECT id, tenant_id, event_type, unit_price_cents, billed_at, billing_period,
                invoice_id, status, source_kind, source_id, check_intake_item_id,
                payment_transfer_id
         FROM public.check_billing_events
         WHERE payment_transfer_id = $1::uuid AND event_type = $2
         LIMIT 1`,
        [transfer.id, feeType],
      )).rows[0];
      return { rows: again ? [again] : [] };
    })).rows[0];
    if (inserted) {
      existingByTransfer.set(key, inserted);
      created.push(asEvent(inserted));
    }
  }

  const nextDay = created.filter((row) => row.event_type === FEE_NEXT_DAY);
  const sameDay = created.filter((row) => row.event_type === FEE_SAME_DAY);
  const instant = created.filter((row) => row.event_type === FEE_INSTANT);
  return { nextDay, sameDay, instant, skipped };
}

const sumCents = (rows) => rows.reduce((sum, row) => sum + Number(row.unit_price_cents || 0), 0);

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
    const ctx = await loadTenantBillingContext(client, request.tenant_id);
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

export async function loadMortgageOpsUsageForPeriod(client, { tenantId, period }) {
  const bounds = utcBounds(period);
  const rows = (await client.query(
    `SELECT e.id, e.tenant_id, e.event_type, e.unit_price_cents, e.billed_at, e.billing_period,
            e.invoice_id, e.status, e.source_kind, e.source_id, e.check_intake_item_id,
            e.payment_transfer_id, e.claim_id, e.mortgage_request_id
     FROM public.check_billing_events e
     WHERE e.tenant_id = $1::uuid
       AND e.event_type IN ('mortgage_ops_initial', 'mortgage_ops_additional_check')
       AND e.billed_at >= $2::timestamptz
       AND e.billed_at < $3::timestamptz
       AND e.status IS DISTINCT FROM 'voided'`,
    [tenantId, bounds.startIso, bounds.endIso],
  ).catch(() => ({ rows: [] }))).rows;
  return {
    initial: rows.filter((row) => row.event_type === FEE_MORTGAGE_INITIAL).map(asEvent),
    additional: rows.filter((row) => row.event_type === FEE_MORTGAGE_ADDITIONAL).map(asEvent),
  };
}

export function assembleInvoiceTotals({
  tenant, period, checks, nextDay, sameDay, mortgageInitial = [], mortgageAdditional = [],
}) {
  const maintenance_rate_cents = Number(tenant.monthly_rate_cents || 0);
  const discount_cents = Number(tenant.referral_discount_cents || 0);
  const maintenance_net_cents = netFeeCents(maintenance_rate_cents, discount_cents);
  const check_usage_cents = sumCents(checks);
  const next_day_usage_cents = sumCents(nextDay);
  const same_day_usage_cents = sumCents(sameDay);
  const mortgage_ops_initial_amount_cents = sumCents(mortgageInitial);
  const mortgage_ops_additional_amount_cents = sumCents(mortgageAdditional);
  const mortgage_ops_usage_cents = mortgage_ops_initial_amount_cents + mortgage_ops_additional_amount_cents;
  const usage_total_cents = check_usage_cents
    + next_day_usage_cents
    + same_day_usage_cents
    + mortgage_ops_usage_cents;
  const amount_cents = maintenance_net_cents + usage_total_cents;
  return {
    billing_period: period,
    maintenance_rate_cents,
    discount_cents,
    maintenance_net_cents,
    check_count: checks.length,
    check_usage_cents,
    next_day_count: nextDay.length,
    next_day_usage_cents,
    same_day_count: sameDay.length,
    same_day_usage_cents,
    mortgage_ops_initial_count: mortgageInitial.length,
    mortgage_ops_initial_amount_cents,
    mortgage_ops_additional_count: mortgageAdditional.length,
    mortgage_ops_additional_amount_cents,
    mortgage_ops_usage_cents,
    usage_total_cents,
    amount_cents,
    per_check_rate_cents: resolveCheckRateCents(tenant),
    next_day_rate_cents: resolveNextDayRateCents(tenant),
    same_day_rate_cents: resolveSameDayRateCents(tenant),
    mortgage_ops_initial_rate_cents: resolveMortgageInitialRateCents(tenant),
    mortgage_ops_additional_rate_cents: resolveMortgageAdditionalRateCents(tenant),
  };
}

export async function buildConsolidatedInvoice(client, {
  tenantId, period, persist = false,
}) {
  const ctx = await loadTenantBillingContext(client, tenantId);
  if (!ctx.ok) return ctx;
  const checks = await loadCheckUsageForPeriod(client, { tenantId, period });
  const moov = await persistMoovUsageForPeriod(client, {
    tenant: ctx.tenant, period, persist,
  });
  const mortgage = await loadMortgageOpsUsageForPeriod(client, { tenantId, period });
  const totals = assembleInvoiceTotals({
    tenant: ctx.tenant,
    period,
    checks: checks.included,
    nextDay: moov.nextDay,
    sameDay: moov.sameDay,
    mortgageInitial: mortgage.initial,
    mortgageAdditional: mortgage.additional,
  });
  const allocations = [
    ...checks.included.map((row) => ({
      source_kind: FEE_CHECK,
      source_id: row.id,
      fee_type: FEE_CHECK,
      unit_price_cents: row.unit_price_cents,
      amount_cents: row.unit_price_cents,
      billed_at: row.billed_at,
      invoice_id: row.invoice_id,
    })),
    ...moov.nextDay.map((row) => ({
      source_kind: FEE_NEXT_DAY,
      source_id: row.id || row.payment_transfer_id,
      fee_type: FEE_NEXT_DAY,
      unit_price_cents: row.unit_price_cents,
      amount_cents: row.unit_price_cents,
      billed_at: row.billed_at,
      invoice_id: row.invoice_id,
      payment_transfer_id: row.payment_transfer_id,
    })),
    ...moov.sameDay.map((row) => ({
      source_kind: FEE_SAME_DAY,
      source_id: row.id || row.payment_transfer_id,
      fee_type: FEE_SAME_DAY,
      unit_price_cents: row.unit_price_cents,
      amount_cents: row.unit_price_cents,
      billed_at: row.billed_at,
      invoice_id: row.invoice_id,
      payment_transfer_id: row.payment_transfer_id,
    })),
    ...mortgage.initial.map((row) => ({
      source_kind: FEE_MORTGAGE_INITIAL,
      source_id: row.id,
      fee_type: FEE_MORTGAGE_INITIAL,
      unit_price_cents: row.unit_price_cents,
      amount_cents: row.unit_price_cents,
      billed_at: row.billed_at,
      invoice_id: row.invoice_id,
      claim_id: row.claim_id,
      mortgage_request_id: row.mortgage_request_id,
    })),
    ...mortgage.additional.map((row) => ({
      source_kind: FEE_MORTGAGE_ADDITIONAL,
      source_id: row.id,
      fee_type: FEE_MORTGAGE_ADDITIONAL,
      unit_price_cents: row.unit_price_cents,
      amount_cents: row.unit_price_cents,
      billed_at: row.billed_at,
      invoice_id: row.invoice_id,
      claim_id: row.claim_id,
      mortgage_request_id: row.mortgage_request_id,
    })),
  ];
  return {
    ok: true,
    tenant: ctx.tenant,
    settings: ctx.settings,
    authorization: ctx.authorization,
    period,
    period_bounds: utcBounds(period),
    ...totals,
    lines: {
      checks: checks.included,
      next_day: moov.nextDay,
      same_day: moov.sameDay,
      mortgage_ops_initial: mortgage.initial,
      mortgage_ops_additional: mortgage.additional,
    },
    excluded_voided_checks: checks.excludedVoided,
    skipped_transfers: moov.skipped,
    allocations,
    instant_billable: false,
  };
}

export async function allocateInvoiceLines(client, { invoice, invoiceBuild }) {
  if (!invoice?.id || !invoiceBuild?.allocations) return { allocated: 0 };
  let allocated = 0;
  for (const line of invoiceBuild.allocations) {
    if (!line.source_id) continue;
    const existing = (await client.query(
      `SELECT invoice_id FROM public.tenant_invoice_allocations
       WHERE source_kind = $1 AND source_id = $2::uuid AND fee_type = $3
       LIMIT 1`,
      [line.source_kind, line.source_id, line.fee_type],
    ).catch(() => ({ rows: [] }))).rows[0];
    if (existing && existing.invoice_id !== invoice.id) continue;
    if (!existing) {
      await client.query(
        `INSERT INTO public.tenant_invoice_allocations (
           invoice_id, tenant_id, billing_period, source_kind, source_id, fee_type,
           unit_price_cents, amount_cents, billed_at
         ) VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6, $7, $8, $9::timestamptz)
         ON CONFLICT (source_kind, source_id, fee_type) DO NOTHING`,
        [
          invoice.id, invoice.tenant_id, invoice.billing_period,
          line.source_kind, line.source_id, line.fee_type,
          line.unit_price_cents, line.amount_cents, line.billed_at,
        ],
      ).catch(() => {});
      allocated += 1;
    }
    if (line.source_id) {
      await client.query(
        `UPDATE public.check_billing_events
         SET invoice_id = $2::uuid, billing_period = COALESCE(billing_period, $3), status = CASE
           WHEN status = 'recorded' THEN 'invoiced' ELSE status END
         WHERE id = $1::uuid AND invoice_id IS NULL`,
        [line.source_id, invoice.id, invoice.billing_period],
      ).catch(() => {});
    }
  }
  return { allocated };
}

export async function listInvoiceAllocations(client, invoiceId) {
  if (!invoiceId) return [];
  return (await client.query(
    `SELECT id, invoice_id, tenant_id, billing_period, source_kind, source_id, fee_type,
            unit_price_cents, amount_cents, billed_at, created_at
     FROM public.tenant_invoice_allocations
     WHERE invoice_id = $1::uuid
     ORDER BY billed_at ASC NULLS LAST, created_at ASC`,
    [invoiceId],
  ).catch(() => ({ rows: [] }))).rows;
}

export async function createOrGetOccurrence(client, {
  tenantId, period, readiness, destination, recordedBy = null,
}) {
  const bounds = periodBounds(period);
  const key = billingIdempotencyKey(tenantId, period);
  const existing = (await client.query(
    `SELECT * FROM public.tenant_maintenance_payments
     WHERE tenant_id = $1::uuid AND billing_period = $2
     LIMIT 1`,
    [tenantId, period],
  )).rows[0];
  if (existing) return { ok: true, occurrence: existing, created: false, idempotency_key: key };

  const invoice = readiness.invoice || {};
  const inserted = (await client.query(
    `INSERT INTO public.tenant_maintenance_payments (
       tenant_id, amount_cents, monthly_rate_cents, discount_cents,
       period_start, period_end, billing_period, method, status,
       idempotence_key, recorded_by, notes,
       funding_source_method_id, destination_account_id, destination_payment_method_id,
       provider_environment,
       maintenance_net_cents, check_usage_cents, next_day_usage_cents, same_day_usage_cents,
       usage_total_cents, check_count, next_day_count, same_day_count,
       mortgage_ops_initial_count, mortgage_ops_initial_amount_cents,
       mortgage_ops_additional_count, mortgage_ops_additional_amount_cents,
       occurrence_kind
     ) VALUES (
       $1::uuid, $2, $3, $4, $5::date, $6::date, $7, 'moov_ach', 'due',
       $8, $9::uuid, $10, $11, $12, $13, $14,
       $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27
     )
     ON CONFLICT (tenant_id, billing_period) WHERE billing_period IS NOT NULL
     DO UPDATE SET updated_at = public.tenant_maintenance_payments.updated_at
     RETURNING *`,
    [
      tenantId,
      readiness.amountCents,
      readiness.rateCents,
      readiness.discountCents,
      bounds.period_start,
      bounds.period_end,
      period,
      key,
      recordedBy,
      `Monthly consolidated invoice ${period}`,
      readiness.authorization?.provider_payment_method_id || null,
      destination.accountId,
      destination.paymentMethodId,
      readiness.environment,
      invoice.maintenance_net_cents ?? netFeeCents(readiness.rateCents, readiness.discountCents),
      invoice.check_usage_cents ?? 0,
      invoice.next_day_usage_cents ?? 0,
      invoice.same_day_usage_cents ?? 0,
      invoice.usage_total_cents ?? 0,
      invoice.check_count ?? 0,
      invoice.next_day_count ?? 0,
      invoice.same_day_count ?? 0,
      invoice.mortgage_ops_initial_count ?? 0,
      invoice.mortgage_ops_initial_amount_cents ?? 0,
      invoice.mortgage_ops_additional_count ?? 0,
      invoice.mortgage_ops_additional_amount_cents ?? 0,
      OCCURRENCE_KIND_MONTHLY,
    ],
  )).rows[0];
  return { ok: true, occurrence: inserted, created: true, idempotency_key: key };
}

const debitRailFromMap = (rails) => {
  const map = rails && typeof rails === 'object' ? rails : {};
  return map['ach-debit-fund'] || map['ach-debit-collect'] || null;
};

const debitRailTypeForId = (rails, paymentMethodId) => {
  const map = rails && typeof rails === 'object' ? rails : {};
  if (map['ach-debit-fund'] === paymentMethodId) return 'ach-debit-fund';
  if (map['ach-debit-collect'] === paymentMethodId) return 'ach-debit-collect';
  return null;
};

/**
 * Resolve the tenant bank ACH debit source for billing.
 * Reuses resolveDebitSourceMethodId (fund, then collect). Never uses
 * ach-credit-standard or the raw stored authorization payment method as source.
 */
export async function resolveBillingDebitSource(client, {
  authorization,
  fetchImpl,
} = {}) {
  const tenantId = authorization?.tenant_id;
  const storedMethodId = authorization?.provider_payment_method_id;
  const accountId = authorization?.provider_account_id;
  if (!tenantId || !storedMethodId || !accountId) {
    return fail('billing_debit_source_unavailable', {
      statusCode: 409,
      message: 'No ACH debit-fund or debit-collect payment method is available for this billing bank account.',
    });
  }

  const source = (await client.query(
    `SELECT id, tenant_id, provider_account_id, provider_payment_method_id, provider_bank_account_id,
            rail_payment_method_ids, rails_synced_at
     FROM public.payment_provider_methods
     WHERE tenant_id = $1::uuid
       AND provider_payment_method_id = $2
     LIMIT 1`,
    [tenantId, storedMethodId],
  ).catch(() => ({ rows: [] }))).rows[0];
  if (!source) {
    return fail('billing_debit_source_unavailable', {
      statusCode: 409,
      message: 'No ACH debit-fund or debit-collect payment method is available for this billing bank account.',
    });
  }

  const { resolveDebitSourceMethodId } = await import('./providers/parity/moov-rails.mjs');
  const resolved = await resolveDebitSourceMethodId(client, source, accountId, fetchImpl);
  const cachedRails = source.rail_payment_method_ids;
  const cachedDebit = debitRailFromMap(cachedRails);
  if (resolved && (resolved === cachedDebit || debitRailTypeForId(cachedRails, resolved))) {
    return {
      ok: true,
      sourceMethodId: resolved,
      sourceAccountId: accountId,
      sourceRail: debitRailTypeForId(cachedRails, resolved) || (
        cachedRails?.['ach-debit-fund'] === resolved ? 'ach-debit-fund' : 'ach-debit-collect'
      ),
    };
  }

  const refreshed = source.id
    ? (await client.query(
      `SELECT rail_payment_method_ids
       FROM public.payment_provider_methods
       WHERE id = $1::uuid
       LIMIT 1`,
      [source.id],
    ).catch(() => ({ rows: [] }))).rows[0]
    : null;
  const freshRails = refreshed?.rail_payment_method_ids;
  const freshDebit = debitRailFromMap(freshRails);
  if (resolved && freshDebit && (resolved === freshDebit || debitRailTypeForId(freshRails, resolved))) {
    return {
      ok: true,
      sourceMethodId: resolved,
      sourceAccountId: accountId,
      sourceRail: debitRailTypeForId(freshRails, resolved),
    };
  }
  if (freshDebit) {
    return {
      ok: true,
      sourceMethodId: freshDebit,
      sourceAccountId: accountId,
      sourceRail: debitRailTypeForId(freshRails, freshDebit),
    };
  }
  // Resolver only returns a non-stored ID from pick(fund/collect).
  if (resolved && resolved !== storedMethodId) {
    return {
      ok: true,
      sourceMethodId: resolved,
      sourceAccountId: accountId,
      sourceRail: null,
    };
  }
  return fail('billing_debit_source_unavailable', {
    statusCode: 409,
    message: 'No ACH debit-fund or debit-collect payment method is available for this billing bank account.',
  });
}

export const postTransfer = async ({
  sourceMethodId, destMethodId, amount, description, metadata, idempotencyKey, fetchImpl,
  facilitatorAccountId, environment, deps = {},
}) => {
  const env = String(environment || billingEnvironment()).toLowerCase();
  const resolved = deps.moovContext
    ? { ok: true, environment: deps.moovContext.environment, moovContext: deps.moovContext }
    : await resolveBillingMoovContext({ environment: env, deps });
  if (!resolved.ok) {
    throw new Error(resolved.message || resolved.error);
  }
  if (resolved.environment !== env) {
    throw new Error(`billing_moov_environment_mismatch:${resolved.environment}`);
  }
  if (env === 'production' && (!resolved.moovContext?.productionPublicKey || !resolved.moovContext?.productionSecretKey)) {
    throw new Error('Production payment credentials are not configured.');
  }
  if (env === 'sandbox' && (!resolved.moovContext?.sandboxPublicKey || !resolved.moovContext?.sandboxSecretKey)) {
    throw new Error('Sandbox payment credentials are not configured for this test organization.');
  }

  const { moovFetch, scopes, withMoovContext, moovEnvironment } = await import('./providers/parity/moov-client.mjs');
  return withMoovContext({ ...resolved.moovContext, fetchImpl }, async () => {
    const bound = moovEnvironment();
    if (bound !== env) {
      throw new Error(`moov_context_unbound:${bound}`);
    }
    if (env === 'production' && bound === 'sandbox') {
      throw new Error('production_moov_refused_sandbox_fallback');
    }
    return moovFetch(`/accounts/${facilitatorAccountId}/transfers`, {
      method: 'POST',
      scopes: scopes.transfersWrite(facilitatorAccountId),
      idempotencyKey,
      fetchImpl,
      body: {
        source: { paymentMethodID: sourceMethodId },
        destination: { paymentMethodID: destMethodId },
        amount: { currency: 'USD', value: amount },
        description: String(description || 'ChecksOps monthly subscription').slice(0, 128),
        metadata,
      },
    });
  });
};

export async function submitOccurrence(client, {
  occurrence, readiness, destination, fetchImpl, deps = {},
}) {
  if (TERMINAL_SUCCESS.has(occurrence.status)) {
    return { ok: true, duplicate: true, occurrence, reason: 'already_settled' };
  }
  if (occurrence.status === 'returned') {
    return { ok: true, duplicate: true, occurrence, reason: 'already_returned' };
  }
  const simulate = billingShouldSimulate(deps);
  const env = readiness.environment;
  if (env === 'production' && !monthlyBillingProductionPostEnabled() && !simulate) {
    return fail('production_billing_post_disabled', {
      statusCode: 403,
      message: 'Production monthly billing posts are not authorized.',
    });
  }

  const simulatedPost = async ({ amount, idempotencyKey }) => {
    if (deps.simulateResult === 'failed') {
      const error = new Error(deps.simulateFailure || 'simulated_provider_rejection');
      throw error;
    }
    if (deps.simulateWalletFail && String(idempotencyKey).endsWith('-wallet')) {
      throw new Error(deps.simulateWalletFail);
    }
    if (deps.simulateBankFail && String(idempotencyKey).endsWith('-bank')) {
      throw new Error(deps.simulateBankFail);
    }
    return { transferID: `sim:${idempotencyKey}`, status: 'submitted', amount };
  };

  const collected = await collectTenantObligation(client, {
    occurrence,
    readiness,
    destination,
    fetchImpl,
    deps: { ...deps, simulate },
    postTransfer: deps.postTransfer || (simulate ? simulatedPost : postTransfer),
    resolveBillingDebitSource: deps.resolveBillingDebitSource || resolveBillingDebitSource,
  });

  const providerTransferId = collected.legs?.find((leg) => leg.provider_transfer_id)?.provider_transfer_id
    || occurrence.provider_transfer_id
    || null;
  const providerStatus = collected.ok
    ? (collected.collection_status === 'PAID' && collected.amount_received_cents >= occurrence.amount_cents
      ? 'settled'
      : 'submitted')
    : (collected.error === 'RECONCILIATION_REQUIRED' ? 'failed' : 'failed');
  const failure = collected.ok ? null : collected.error;

  const saved = (await client.query(
    `UPDATE public.tenant_maintenance_payments SET
       status = $2,
       provider_transfer_id = COALESCE($3, provider_transfer_id),
       submitted_at = CASE WHEN $2 IN ('submitted', 'failed') THEN COALESCE(submitted_at, now()) ELSE submitted_at END,
       failure_reason = $4,
       notes = COALESCE(notes, '') || $5
     WHERE id = $1::uuid
     RETURNING *`,
    [
      occurrence.id,
      collected.occurrence?.status || providerStatus,
      providerTransferId,
      failure,
      failure
        ? ` · fail:${failure}`
        : (providerTransferId ? ` · moov:${providerTransferId}` : ''),
    ],
  ).catch(() => ({ rows: [occurrence] }))).rows[0];

  if ((saved?.status === 'submitted' || collected.ok) && readiness.settings) {
    const nextStart = nextBillingDate(readiness.settings.billing_day_of_month || 1, new Date());
    await client.query(
      `UPDATE public.tenant_billing_settings
       SET next_period_start = $2::date, updated_at = now()
       WHERE tenant_id = $1::uuid`,
      [occurrence.tenant_id, nextStart],
    ).catch(() => {});
  }

  return {
    ...collected,
    ok: collected.ok,
    simulated: simulate,
    occurrence: saved,
    liveProviderCalled: !simulate && Boolean(collected.liveProviderCalled),
    error: failure,
    resolvedDebitSourceMethodId: collected.resolvedDebitSourceMethodId || null,
    resolvedWalletSourceMethodId: collected.resolvedWalletSourceMethodId || null,
  };
}

export async function createOrGetVerificationOccurrence(client, {
  tenantId, verificationId, readiness, destination, recordedBy = null,
}) {
  const key = billingVerificationIdempotencyKey(tenantId, verificationId);
  const existing = (await client.query(
    `SELECT * FROM public.tenant_maintenance_payments
     WHERE idempotence_key = $1
     LIMIT 1`,
    [key],
  )).rows[0];
  if (existing) {
    return { ok: true, occurrence: existing, created: false, idempotency_key: key };
  }

  const inserted = (await client.query(
    `INSERT INTO public.tenant_maintenance_payments (
       tenant_id, amount_cents, monthly_rate_cents, discount_cents,
       period_start, period_end, billing_period, method, status,
       idempotence_key, recorded_by, notes,
       funding_source_method_id, destination_account_id, destination_payment_method_id,
       provider_environment,
       maintenance_net_cents, check_usage_cents, next_day_usage_cents, same_day_usage_cents,
       usage_total_cents, check_count, next_day_count, same_day_count,
       mortgage_ops_initial_count, mortgage_ops_initial_amount_cents,
       mortgage_ops_additional_count, mortgage_ops_additional_amount_cents,
       occurrence_kind
     ) VALUES (
       $1::uuid, $2, 0, 0, NULL, NULL, NULL, 'moov_ach', 'due',
       $3, $4::uuid, $5, $6, $7, $8, $9,
       0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, $10
     )
     ON CONFLICT (idempotence_key)
     DO UPDATE SET updated_at = public.tenant_maintenance_payments.updated_at
     RETURNING *`,
    [
      tenantId,
      BILLING_VERIFICATION_AMOUNT_CENTS,
      key,
      recordedBy,
      'Billing verification $1.00',
      readiness.authorization?.provider_payment_method_id || null,
      destination.accountId,
      destination.paymentMethodId,
      readiness.environment,
      OCCURRENCE_KIND_VERIFICATION,
    ],
  )).rows[0];
  return { ok: true, occurrence: inserted, created: true, idempotency_key: key };
}

export async function submitVerificationOccurrence(client, {
  occurrence, readiness, destination, fetchImpl, deps = {},
}) {
  if (TERMINAL_SUCCESS.has(occurrence.status)) {
    return { ok: true, duplicate: true, occurrence, reason: 'already_settled' };
  }
  if (occurrence.status === 'returned') {
    return { ok: true, duplicate: true, occurrence, reason: 'already_returned' };
  }
  if (IN_FLIGHT.has(occurrence.status) && occurrence.provider_transfer_id) {
    return { ok: true, duplicate: true, occurrence, reason: 'already_submitted' };
  }

  const simulate = billingVerificationShouldSimulate(deps);
  if (!simulate && !billingVerificationPostEnabled()) {
    return fail('verification_post_disabled', {
      statusCode: 403,
      message: 'Billing verification posts are not authorized.',
    });
  }

  let providerTransferId = occurrence.provider_transfer_id;
  let providerStatus = occurrence.status;
  let failure = null;
  let debitSource = null;
  if (simulate) {
    if (deps.simulateResult === 'failed') {
      failure = deps.simulateFailure || 'simulated_provider_rejection';
      providerStatus = 'failed';
    } else {
      providerTransferId = providerTransferId || `sim:${occurrence.id}`;
      providerStatus = 'submitted';
    }
  } else {
    const debit = await resolveBillingDebitSource(client, {
      authorization: readiness.authorization,
      fetchImpl,
    });
    if (!debit.ok) {
      return debit;
    }
    debitSource = debit;
    try {
      const created = await postTransfer({
        sourceMethodId: debit.sourceMethodId,
        destMethodId: destination.paymentMethodId,
        amount: BILLING_VERIFICATION_AMOUNT_CENTS,
        description: 'ChecksOps billing verification $1.00',
        metadata: {
          checksops_kind: 'billing_verification',
          checksops_tenant_id: occurrence.tenant_id,
          checksops_verification_id: String(deps.verificationId || '').trim()
            || String(occurrence.idempotence_key || '').split(':').pop(),
          checksops_payment_id: occurrence.id,
        },
        idempotencyKey: occurrence.idempotence_key,
        fetchImpl,
        facilitatorAccountId: destination.accountId,
        environment: readiness.environment || destination.environment || billingEnvironment(),
        deps,
      });
      providerTransferId = created?.transferID || created?.transferId || providerTransferId;
      providerStatus = 'submitted';
    } catch (error) {
      failure = error.message || 'moov_request_rejected';
      providerStatus = 'failed';
    }
  }

  const saved = (await client.query(
    `UPDATE public.tenant_maintenance_payments SET
       status = $2,
       provider_transfer_id = COALESCE($3, provider_transfer_id),
       submitted_at = CASE WHEN $2 = 'submitted' THEN COALESCE(submitted_at, now()) ELSE submitted_at END,
       failure_reason = $4,
       notes = COALESCE(notes, '') || $5
     WHERE id = $1::uuid
     RETURNING *`,
    [
      occurrence.id,
      providerStatus,
      providerTransferId,
      failure,
      failure ? ` · fail:${failure}` : (providerTransferId ? ` · moov:${providerTransferId}` : ''),
    ],
  )).rows[0];

  return {
    ok: !failure,
    simulated: simulate,
    occurrence: saved,
    liveProviderCalled: !simulate && !failure,
    error: failure,
    resolvedDebitSourceMethodId: debitSource?.sourceMethodId || null,
    resolvedDebitSourceRail: debitSource?.sourceRail || null,
    resolvedDebitSourceAccountId: debitSource?.sourceAccountId || null,
  };
}

export async function verifyTenantBillingDebit(client, {
  tenantId,
  verificationId,
  recordedBy = null,
  fetchImpl,
  deps = {},
}) {
  if (!UUID_RE.test(String(verificationId || ''))) {
    return fail('invalid_verification_id', { statusCode: 400, field: 'verification_id' });
  }
  const environment = deps.environment || billingEnvironment();
  const destination = await resolveBillingDestination(client, { environment, deps });
  if (!destination.ok) return { ...destination, statusCode: 503 };

  const readiness = await evaluateBillingReadiness(client, {
    tenantId,
    period: null,
    destination,
    environment,
  });
  readiness.reasons = (readiness.reasons || []).filter((reason) => reason !== 'invalid_amount');
  readiness.ready = readiness.reasons.length === 0;
  readiness.ok = readiness.ready;
  readiness.amountCents = BILLING_VERIFICATION_AMOUNT_CENTS;
  if (!readiness.ready) {
    return fail('billing_not_ready', {
      statusCode: 409,
      reasons: readiness.reasons,
      amount_cents: BILLING_VERIFICATION_AMOUNT_CENTS,
    });
  }

  const booked = await createOrGetVerificationOccurrence(client, {
    tenantId, verificationId, readiness, destination, recordedBy,
  });
  if (!booked.ok) return booked;

  const submitted = await submitVerificationOccurrence(client, {
    occurrence: booked.occurrence,
    readiness,
    destination,
    fetchImpl,
    deps: { ...deps, verificationId },
  });
  return {
    ...submitted,
    created: booked.created,
    amount_cents: BILLING_VERIFICATION_AMOUNT_CENTS,
    idempotency_key: booked.idempotency_key,
    client_amount_ignored: true,
  };
}

export async function chargeTenantPeriod(client, {
  tenantId,
  period = periodKey(),
  recordedBy = null,
  fetchImpl,
  deps = {},
}) {
  if (!monthlyBillingEnabled() && deps.ignoreEnabledFlag !== true) {
    return fail('monthly_billing_disabled', {
      statusCode: 403,
      message: 'Monthly tenant billing is not enabled on this runtime.',
    });
  }
  const environment = deps.environment || billingEnvironment();
  const destination = await resolveBillingDestination(client, { environment, deps });
  if (!destination.ok) return { ...destination, statusCode: 503 };

  const invoice = await buildConsolidatedInvoice(client, {
    tenantId, period, persist: true,
  });
  if (!invoice.ok) return invoice;

  const readiness = await evaluateBillingReadiness(client, {
    tenantId, period, destination, environment,
  });
  readiness.amountCents = invoice.amount_cents;
  readiness.invoice = invoice;
  if (invoice.amount_cents > 0) {
    readiness.reasons = (readiness.reasons || []).filter((reason) => reason !== 'invalid_amount');
    readiness.ready = readiness.reasons.length === 0;
    readiness.ok = readiness.ready;
  }
  if (!readiness.ready) {
    return fail('billing_not_ready', {
      statusCode: 409,
      reasons: readiness.reasons,
      amount_cents: readiness.amountCents,
      invoice,
    });
  }

  const booked = await createOrGetOccurrence(client, {
    tenantId, period, readiness, destination, recordedBy,
  });
  if (!booked.ok) return booked;
  if (
    booked.occurrence.amount_cents !== readiness.amountCents
    && ['due'].includes(booked.occurrence.status)
    && booked.created === false
  ) {
    // Historical snapshot wins. Do not rewrite amount on an existing period row.
  }
  if (booked.created) {
    await allocateInvoiceLines(client, { invoice: booked.occurrence, invoiceBuild: invoice });
  }

  const submitted = await submitOccurrence(client, {
    occurrence: booked.occurrence,
    readiness,
    destination,
    fetchImpl,
    deps,
  });
  return {
    ...submitted,
    invoice,
    amount_cents: booked.occurrence.amount_cents,
  };
}

export async function runMonthlyBillingScheduler(client, { now = new Date(), fetchImpl, deps = {} } = {}) {
  if (!monthlyBillingEnabled() && deps.ignoreEnabledFlag !== true) {
    return fail('monthly_billing_disabled', { statusCode: 403 });
  }
  const today = (now instanceof Date ? now : new Date(now)).toISOString().slice(0, 10);
  const period = collectionPeriodKey(now);
  const due = (await client.query(
    `SELECT t.id AS tenant_id
     FROM public.tenants t
     JOIN public.tenant_billing_settings s ON s.tenant_id = t.id
     WHERE t.subscription_status = 'active'
       AND s.billing_enabled = true
       AND (s.next_period_start IS NULL OR s.next_period_start <= $1::date)
       AND s.billing_day_of_month <= EXTRACT(DAY FROM $1::date)`,
    [today],
  )).rows;

  const results = [];
  for (const row of due) {
    results.push({
      tenant_id: row.tenant_id,
      ...(await chargeTenantPeriod(client, {
        tenantId: row.tenant_id,
        period,
        fetchImpl,
        deps,
      })),
    });
  }
  return { ok: true, period, due: due.length, results };
}

export async function applyBillingProviderEvent(client, {
  providerTransferId, status, reason = null,
}) {
  if (!providerTransferId) return { applied: false, skipped: 'no_transfer_id' };
  const normalized = String(status || '').toLowerCase();
  const mapped = normalized.includes('return') || normalized.includes('revers')
    ? 'returned'
    : normalized.includes('fail')
      ? 'failed'
      : normalized.includes('complete') || normalized.includes('settled')
        ? 'settled'
        : null;
  if (!mapped) return { applied: false, skipped: 'unmapped_status', status: normalized };

  const collectionLeg = (await client.query(
    `SELECT * FROM public.payment_transfers
     WHERE provider_transfer_id = $1
     LIMIT 1`,
    [providerTransferId],
  ).catch(() => ({ rows: [] }))).rows[0] || null;
  if (collectionLeg) {
    await client.query(
      `UPDATE public.payment_transfers SET
         status = $2,
         provider_status = $3,
         completed_at = CASE WHEN $2 = 'settled' THEN COALESCE(completed_at, now()) ELSE completed_at END,
         failure_reason = CASE WHEN $2 IN ('failed','returned') THEN COALESCE($4, failure_reason) ELSE failure_reason END,
         updated_at = now()
       WHERE id = $1::uuid`,
      [collectionLeg.id, mapped, normalized, reason],
    ).catch(() => {});
  }

  const existing = (await client.query(
    `SELECT * FROM public.tenant_maintenance_payments
     WHERE provider_transfer_id = $1
        OR id::text = $2
        OR notes LIKE $3
     LIMIT 1`,
    [
      providerTransferId,
      collectionLeg?.provider_metadata?.obligation_id || '',
      `%${providerTransferId}%`,
    ],
  ).catch(() => ({ rows: [] }))).rows[0];
  if (!existing) return { applied: false, skipped: 'no_billing_occurrence' };

  if (existing.status === 'returned' && mapped !== 'returned' && !collectionLeg) {
    return { applied: false, skipped: 'already_returned', occurrence: existing };
  }
  if (existing.status === mapped && !collectionLeg) {
    return { applied: true, duplicate: true, occurrence: existing };
  }

  let nextStatus = mapped;
  if (collectionLeg) {
    const siblingLegs = (await client.query(
      `SELECT * FROM public.payment_transfers
       WHERE provider_metadata->>'obligation_id' = $1`,
      [String(existing.id)],
    ).catch(() => ({ rows: [] }))).rows.map((row) => ({
      ...row,
      leg_type: row.provider_metadata?.leg_type || row.leg_role,
    }));
    const received = receivedCentsFromLegs(siblingLegs);
    const collectionStatus = classifyCollectionStatus({
      amountDueCents: existing.amount_cents,
      legs: siblingLegs,
    });
    nextStatus = received >= Number(existing.amount_cents || 0)
      ? 'settled'
      : collectionStatus === 'RECONCILIATION REQUIRED'
        ? 'failed'
        : siblingLegs.some((row) => ['submitted', 'pending', 'originated'].includes(String(row.status || '').toLowerCase()))
          ? 'submitted'
          : mapped;
  }

  const saved = (await client.query(
    `UPDATE public.tenant_maintenance_payments SET
       status = $2,
       settled_at = CASE WHEN $2 = 'settled' THEN COALESCE(settled_at, now()) ELSE settled_at END,
       returned_at = CASE WHEN $2 = 'returned' THEN COALESCE(returned_at, now()) ELSE returned_at END,
       return_reason = CASE WHEN $2 = 'returned' THEN COALESCE($3, return_reason) ELSE return_reason END,
       failure_reason = CASE WHEN $2 IN ('failed','returned') THEN COALESCE($3, failure_reason) ELSE failure_reason END
     WHERE id = $1::uuid
     RETURNING *`,
    [existing.id, nextStatus, reason],
  )).rows[0];
  return { applied: true, occurrence: saved, previous: existing.status, collection_leg: collectionLeg };
}

export async function saveBillingSettings(client, {
  tenantId, monthlyRateCents, referralDiscountCents, billingEnabled, billingDay, userId,
  perCheckRateCents, nextDayRateCents, sameDayRateCents,
  mortgageOpsInitialRateCents, mortgageOpsAdditionalRateCents,
}) {
  const sets = [];
  const params = [];
  let i = 1;
  const applyRate = (value, field, column) => {
    if (value === undefined) return true;
    const parsed = parseRateCents(value, field);
    if (!parsed.ok) return parsed;
    sets.push(`${column} = $${i++}`);
    params.push(parsed.cents);
    return true;
  };
  const monthly = applyRate(monthlyRateCents, 'monthly_rate', 'monthly_rate_cents');
  if (monthly !== true) return monthly;
  const discount = applyRate(referralDiscountCents, 'referral_discount', 'referral_discount_cents');
  if (discount !== true) return discount;
  const checkRate = applyRate(perCheckRateCents, 'per_check_rate', 'per_check_rate_cents');
  if (checkRate !== true) return checkRate;
  const nextDay = applyRate(nextDayRateCents, 'next_day_rate', 'next_day_rate_cents');
  if (nextDay !== true) return nextDay;
  const sameDay = applyRate(sameDayRateCents, 'same_day_rate', 'same_day_rate_cents');
  if (sameDay !== true) return sameDay;
  const mortgageInitial = applyRate(
    mortgageOpsInitialRateCents, 'mortgage_ops_initial_rate', 'mortgage_ops_initial_rate_cents',
  );
  if (mortgageInitial !== true) return mortgageInitial;
  const mortgageAdditional = applyRate(
    mortgageOpsAdditionalRateCents, 'mortgage_ops_additional_rate', 'mortgage_ops_additional_rate_cents',
  );
  if (mortgageAdditional !== true) return mortgageAdditional;
  if (sets.length) {
    params.push(tenantId);
    await client.query(
      `UPDATE public.tenants SET ${sets.join(', ')} WHERE id = $${i}::uuid`,
      params,
    );
  }

  const day = billingDay === undefined ? null : Math.min(28, Math.max(1, Number(billingDay) || 1));
  await client.query(
    `INSERT INTO public.tenant_billing_settings (
       tenant_id, billing_enabled, billing_day_of_month, updated_by
     ) VALUES ($1::uuid, COALESCE($2, false), COALESCE($3, 1), $4::uuid)
     ON CONFLICT (tenant_id) DO UPDATE SET
       billing_enabled = COALESCE($2, public.tenant_billing_settings.billing_enabled),
       billing_day_of_month = COALESCE($3, public.tenant_billing_settings.billing_day_of_month),
       updated_by = $4::uuid,
       updated_at = now()`,
    [
      tenantId,
      billingEnabled === undefined ? null : billingEnabled === true,
      day,
      userId,
    ],
  );
  return loadTenantBillingContext(client, tenantId);
}

export async function saveBillingAuthorization(client, {
  tenantId, userId, paymentMethodId, autoDebitEnabled = true, authorized = false,
}) {
  const method = (await client.query(
    `SELECT id, tenant_id, provider_account_id, provider_payment_method_id, provider_bank_account_id,
            holder_name, last_four, verification_status, connection_status, environment
     FROM public.payment_provider_methods
     WHERE tenant_id = $1::uuid AND provider_payment_method_id = $2
     LIMIT 1`,
    [tenantId, paymentMethodId],
  )).rows[0];
  if (!method) return fail('funding_source_not_found', { statusCode: 404 });
  if (method.tenant_id !== tenantId) return fail('cross_tenant_denied', { statusCode: 403 });
  if (String(method.connection_status || '') !== 'connected') {
    return fail('bank_disconnected', { statusCode: 409 });
  }

  const existing = (await client.query(
    `SELECT id FROM public.tenant_billing_accounts WHERE tenant_id = $1::uuid`,
    [tenantId],
  )).rows[0];

  const payload = [
    tenantId,
    method.holder_name || 'Authorized billing account',
    method.last_four || '0000',
    autoDebitEnabled === true,
    authorized ? new Date().toISOString() : null,
    authorized ? userId : null,
    method.verification_status || 'verified',
    method.provider_payment_method_id,
    method.provider_bank_account_id,
    method.provider_account_id,
    method.environment,
    method.holder_name || 'Billing account',
  ];

  const saved = existing
    ? (await client.query(
      `UPDATE public.tenant_billing_accounts SET
         account_holder_name = $2,
         account_number_last4 = $3,
         auto_debit_enabled = $4,
         ach_authorized_at = COALESCE($5::timestamptz, ach_authorized_at),
         ach_authorized_by = COALESCE($6::uuid, ach_authorized_by),
         verification_status = $7,
         provider_payment_method_id = $8,
         provider_bank_account_id = $9,
         provider_account_id = $10,
         provider_environment = $11,
         nickname = $12,
         updated_at = now()
       WHERE tenant_id = $1::uuid
       RETURNING *`,
      payload,
    )).rows[0]
    : (await client.query(
      `INSERT INTO public.tenant_billing_accounts (
         tenant_id, account_holder_name, account_number_last4, account_type, entity_type,
         auto_debit_enabled, ach_authorized_at, ach_authorized_by, verification_status,
         provider_payment_method_id, provider_bank_account_id, provider_account_id,
         provider_environment, nickname, routing_number, account_number_encrypted
       ) VALUES (
         $1::uuid, $2, $3, 'checking', 'business',
         $4, $5::timestamptz, $6::uuid, $7,
         $8, $9, $10, $11, $12, NULL, NULL
       ) RETURNING *`,
      payload,
    )).rows[0];

  return { ok: true, authorization: saved };
}

export async function listBillingHistory(client, tenantId, limit = 24) {
  const rows = (await client.query(
    `SELECT id, tenant_id, amount_cents, monthly_rate_cents, discount_cents, billing_period,
            period_start, period_end, status, method, provider_transfer_id,
            funding_source_method_id, destination_account_id, destination_payment_method_id,
            submitted_at, settled_at, returned_at, failure_reason, return_reason,
            idempotence_key, created_at,
            maintenance_net_cents, check_usage_cents, next_day_usage_cents, same_day_usage_cents,
            usage_total_cents, check_count, next_day_count, same_day_count,
            mortgage_ops_initial_count, mortgage_ops_initial_amount_cents,
            mortgage_ops_additional_count, mortgage_ops_additional_amount_cents,
            occurrence_kind
     FROM public.tenant_maintenance_payments
     WHERE tenant_id = $1::uuid
     ORDER BY period_start DESC NULLS LAST, created_at DESC
     LIMIT $2`,
    [tenantId, limit],
  ).catch(() => client.query(
    `SELECT id, tenant_id, amount_cents, monthly_rate_cents, discount_cents, billing_period,
            period_start, period_end, status, method, provider_transfer_id,
            funding_source_method_id, destination_account_id, destination_payment_method_id,
            submitted_at, settled_at, returned_at, failure_reason, return_reason,
            idempotence_key, created_at,
            maintenance_net_cents, check_usage_cents, next_day_usage_cents, same_day_usage_cents,
            usage_total_cents, check_count, next_day_count, same_day_count,
            mortgage_ops_initial_count, mortgage_ops_initial_amount_cents,
            mortgage_ops_additional_count, mortgage_ops_additional_amount_cents
     FROM public.tenant_maintenance_payments
     WHERE tenant_id = $1::uuid
     ORDER BY period_start DESC NULLS LAST, created_at DESC
     LIMIT $2`,
    [tenantId, limit],
  ))).rows;
  return rows;
}

const isMonthlyOccurrence = (row) => {
  const kind = String(row?.occurrence_kind || OCCURRENCE_KIND_MONTHLY);
  if (kind === OCCURRENCE_KIND_VERIFICATION || kind === OCCURRENCE_KIND_LEGACY) return false;
  return Boolean(row?.billing_period) && String(row.billing_period).trim() !== '';
};

const isPeriodKeyedOccurrence = isMonthlyOccurrence;

export async function buildTenantBillingSnapshot(client, tenantId, dest, { now = new Date() } = {}) {
  const ctx = await loadTenantBillingContext(client, tenantId);
  if (!ctx.ok) return ctx;
  const currentPeriod = accrualPeriodKey(now);
  const collectionPeriod = collectionPeriodKey(now);
  const pullPeriod = defaultPullPeriodKey(now, ctx.settings.billing_day_of_month || 1);
  const invoice = await buildConsolidatedInvoice(client, {
    tenantId, period: currentPeriod, persist: false,
  });
  const pullPreview = pullPeriod === currentPeriod
    ? invoice
    : await buildConsolidatedInvoice(client, { tenantId, period: pullPeriod, persist: false });
  const readiness = await evaluateBillingReadiness(client, {
    tenantId,
    period: pullPeriod,
    destination: dest,
    environment: billingEnvironment(),
  });
  readiness.amountCents = pullPreview.ok ? pullPreview.amount_cents : readiness.amountCents;
  if (readiness.amountCents > 0) {
    readiness.reasons = (readiness.reasons || []).filter((reason) => reason !== 'invalid_amount');
    readiness.ready = readiness.reasons.length === 0;
  }
  const history = await listBillingHistory(client, tenantId, 24);
  const last = history.find((row) => isPeriodKeyedOccurrence(row)) || null;
  const pending = history.find((row) => (
    isPeriodKeyedOccurrence(row)
    && (row.status === 'submitted' || row.status === 'due')
  )) || null;
  const settled = history.filter((row) => row.status === 'settled' && isPeriodKeyedOccurrence(row));
  const failed = history.filter((row) => row.status === 'failed' && isPeriodKeyedOccurrence(row));
  const returned = history.filter((row) => row.status === 'returned' && isPeriodKeyedOccurrence(row));
  const methods = (await client.query(
    `SELECT provider_payment_method_id, holder_name, last_four,
            connection_status, can_send, environment, provider_account_id
     FROM public.payment_provider_methods
     WHERE tenant_id = $1::uuid
       AND environment = $2
       AND connection_status = 'connected'
       AND provider_payment_method_id IS NOT NULL
     ORDER BY updated_at DESC NULLS LAST`,
    [tenantId, billingEnvironment()],
  ).catch(() => ({ rows: [] }))).rows;
  const pendingAllocations = pending
    ? await listInvoiceAllocations(client, pending.id)
    : invoice.allocations || [];
  return {
    ok: true,
    tenant_id: tenantId,
    tenant: {
      id: ctx.tenant.id,
      name: ctx.tenant.name,
      slug: ctx.tenant.slug,
      subscription_status: ctx.tenant.subscription_status,
      is_founding_partner: ctx.tenant.is_founding_partner,
    },
    monthly_rate_cents: Number(ctx.tenant.monthly_rate_cents || 0),
    referral_discount_cents: Number(ctx.tenant.referral_discount_cents || 0),
    net_fee_cents: netFeeCents(ctx.tenant.monthly_rate_cents, ctx.tenant.referral_discount_cents),
    per_check_rate_cents: resolveCheckRateCents(ctx.tenant),
    next_day_rate_cents: resolveNextDayRateCents(ctx.tenant),
    same_day_rate_cents: resolveSameDayRateCents(ctx.tenant),
    mortgage_ops_initial_rate_cents: resolveMortgageInitialRateCents(ctx.tenant),
    mortgage_ops_additional_rate_cents: resolveMortgageAdditionalRateCents(ctx.tenant),
    instant_rate_cents: null,
    instant_enabled: false,
    billing_enabled: ctx.settings.billing_enabled === true,
    billing_day_of_month: Number(ctx.settings.billing_day_of_month || 1),
    next_billing_date: nextBillingDate(ctx.settings.billing_day_of_month || 1, now),
    next_period_start: ctx.settings.next_period_start,
    current_period: currentPeriod,
    collection_period: collectionPeriod,
    pull_period: pullPeriod,
    invoice: invoice.ok ? {
      billing_period: invoice.billing_period,
      maintenance_rate_cents: invoice.maintenance_rate_cents,
      discount_cents: invoice.discount_cents,
      maintenance_net_cents: invoice.maintenance_net_cents,
      check_count: invoice.check_count,
      check_usage_cents: invoice.check_usage_cents,
      next_day_count: invoice.next_day_count,
      next_day_usage_cents: invoice.next_day_usage_cents,
      same_day_count: invoice.same_day_count,
      same_day_usage_cents: invoice.same_day_usage_cents,
      mortgage_ops_initial_count: invoice.mortgage_ops_initial_count,
      mortgage_ops_initial_amount_cents: invoice.mortgage_ops_initial_amount_cents,
      mortgage_ops_additional_count: invoice.mortgage_ops_additional_count,
      mortgage_ops_additional_amount_cents: invoice.mortgage_ops_additional_amount_cents,
      mortgage_ops_usage_cents: invoice.mortgage_ops_usage_cents,
      usage_total_cents: invoice.usage_total_cents,
      amount_cents: invoice.amount_cents,
      allocations: pendingAllocations,
      lines: invoice.lines,
      excluded_voided_checks: invoice.excluded_voided_checks,
    } : null,
    current_amount_due_cents: invoice.ok ? invoice.amount_cents : 0,
    pull_preview: pullPreview.ok ? {
      billing_period: pullPreview.billing_period,
      maintenance_rate_cents: pullPreview.maintenance_rate_cents,
      discount_cents: pullPreview.discount_cents,
      maintenance_net_cents: pullPreview.maintenance_net_cents,
      check_count: pullPreview.check_count,
      check_usage_cents: pullPreview.check_usage_cents,
      next_day_count: pullPreview.next_day_count,
      next_day_usage_cents: pullPreview.next_day_usage_cents,
      same_day_count: pullPreview.same_day_count,
      same_day_usage_cents: pullPreview.same_day_usage_cents,
      mortgage_ops_initial_count: pullPreview.mortgage_ops_initial_count,
      mortgage_ops_initial_amount_cents: pullPreview.mortgage_ops_initial_amount_cents,
      mortgage_ops_additional_count: pullPreview.mortgage_ops_additional_count,
      mortgage_ops_additional_amount_cents: pullPreview.mortgage_ops_additional_amount_cents,
      mortgage_ops_usage_cents: pullPreview.mortgage_ops_usage_cents,
      usage_total_cents: pullPreview.usage_total_cents,
      amount_cents: pullPreview.amount_cents,
    } : null,
    authorization: ctx.authorization,
    funding_source_last4: ctx.authorization?.account_number_last4 || null,
    destination: dest.ok ? {
      accountId: dest.accountId,
      paymentMethodId: dest.paymentMethodId,
      label: dest.label,
      environment: dest.environment,
      source: dest.source || 'explicit',
      firstWalletFallback: false,
    } : { error: dest.error, reason: dest.reason, firstWalletFallback: false },
    readiness: {
      ready: readiness.ready,
      reasons: readiness.reasons || [],
    },
    last_charge: last,
    pending_charge: pending,
    settled_charges: settled,
    failed_charges: failed,
    returned_charges: returned,
    verification_charges: history.filter((row) => row.occurrence_kind === OCCURRENCE_KIND_VERIFICATION),
    verification_post_enabled: billingVerificationPostEnabled(),
    history,
    methods,
  };
}
