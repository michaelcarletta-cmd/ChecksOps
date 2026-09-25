/**
 * Monthly ChecksOps tenant subscription billing engine.
 * One occurrence per (tenant_id, billing_period). Same path for scheduler and Pull Now.
 */
import {
  billingEnvironment,
  billingShouldSimulate,
  monthlyBillingEnabled,
  monthlyBillingProductionPostEnabled,
  resolveBillingDestination,
} from './tenant-billing-destination.mjs';

export const BILLING_STATUSES = ['due', 'submitted', 'settled', 'failed', 'returned'];
const TERMINAL_SUCCESS = new Set(['settled']);
const IN_FLIGHT = new Set(['submitted']);

export const periodKey = (date = new Date()) => {
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
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

const fail = (error, extra = {}) => ({ ok: false, error, ...extra });

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
            is_founding_partner
     FROM public.tenants WHERE id = $1::uuid`,
    [tenantId],
  )).rows[0];
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
    period: period || periodKey(),
    destination,
    environment: env,
    account,
  };
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

  const inserted = (await client.query(
    `INSERT INTO public.tenant_maintenance_payments (
       tenant_id, amount_cents, monthly_rate_cents, discount_cents,
       period_start, period_end, billing_period, method, status,
       idempotence_key, recorded_by, notes,
       funding_source_method_id, destination_account_id, destination_payment_method_id,
       provider_environment
     ) VALUES (
       $1::uuid, $2, $3, $4, $5::date, $6::date, $7, 'moov_ach', 'due',
       $8, $9::uuid, $10, $11, $12, $13, $14
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
      `Monthly subscription ${period}`,
      readiness.authorization?.provider_payment_method_id || null,
      destination.accountId,
      destination.paymentMethodId,
      readiness.environment,
    ],
  )).rows[0];
  return { ok: true, occurrence: inserted, created: true, idempotency_key: key };
}

const postTransfer = async ({
  sourceMethodId, destMethodId, amount, description, metadata, idempotencyKey, fetchImpl,
  facilitatorAccountId,
}) => {
  const { moovFetch, scopes } = await import('./providers/parity/moov-client.mjs');
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
};

export async function submitOccurrence(client, {
  occurrence, readiness, destination, fetchImpl, deps = {},
}) {
  if (TERMINAL_SUCCESS.has(occurrence.status)) {
    return { ok: true, duplicate: true, occurrence, reason: 'already_settled' };
  }
  if (IN_FLIGHT.has(occurrence.status) && occurrence.provider_transfer_id) {
    return { ok: true, duplicate: true, occurrence, reason: 'already_submitted' };
  }

  const simulate = billingShouldSimulate(deps);
  const env = readiness.environment;
  if (env === 'production' && !monthlyBillingProductionPostEnabled() && !simulate) {
    return fail('production_billing_post_disabled', {
      statusCode: 403,
      message: 'Production monthly billing posts are not authorized.',
    });
  }

  let providerTransferId = occurrence.provider_transfer_id;
  let providerStatus = occurrence.status;
  let failure = null;
  if (simulate) {
    if (deps.simulateResult === 'failed') {
      failure = deps.simulateFailure || 'simulated_provider_rejection';
      providerStatus = 'failed';
    } else {
      providerTransferId = providerTransferId || `sim:${occurrence.id}`;
      providerStatus = 'submitted';
    }
  } else {
    try {
      const created = await postTransfer({
        sourceMethodId: readiness.authorization.provider_payment_method_id,
        destMethodId: destination.paymentMethodId,
        amount: occurrence.amount_cents,
        description: `ChecksOps subscription ${occurrence.billing_period}`,
        metadata: {
          checksops_kind: 'monthly_subscription',
          checksops_tenant_id: occurrence.tenant_id,
          checksops_payment_id: occurrence.id,
          checksops_period: occurrence.billing_period,
        },
        idempotencyKey: occurrence.idempotence_key,
        fetchImpl,
        facilitatorAccountId: destination.accountId,
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

  if (providerStatus === 'submitted' && readiness.settings) {
    await client.query(
      `UPDATE public.tenant_billing_settings
       SET next_period_start = $2::date, updated_at = now()
       WHERE tenant_id = $1::uuid`,
      [occurrence.tenant_id, periodBounds(nextPeriodAfter(occurrence.billing_period)).period_start],
    ).catch(() => {});
  }

  return {
    ok: !failure,
    simulated: simulate,
    occurrence: saved,
    liveProviderCalled: !simulate && !failure,
    error: failure,
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

  const readiness = await evaluateBillingReadiness(client, {
    tenantId, period, destination, environment,
  });
  if (!readiness.ready) {
    return fail('billing_not_ready', {
      statusCode: 409,
      reasons: readiness.reasons,
      amount_cents: readiness.amountCents,
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

  return submitOccurrence(client, {
    occurrence: booked.occurrence,
    readiness,
    destination,
    fetchImpl,
    deps,
  });
}

export async function runMonthlyBillingScheduler(client, { now = new Date(), fetchImpl, deps = {} } = {}) {
  if (!monthlyBillingEnabled() && deps.ignoreEnabledFlag !== true) {
    return fail('monthly_billing_disabled', { statusCode: 403 });
  }
  const today = (now instanceof Date ? now : new Date(now)).toISOString().slice(0, 10);
  const period = periodKey(now);
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

  const existing = (await client.query(
    `SELECT * FROM public.tenant_maintenance_payments
     WHERE provider_transfer_id = $1
     LIMIT 1`,
    [providerTransferId],
  )).rows[0];
  if (!existing) return { applied: false, skipped: 'no_billing_occurrence' };

  if (existing.status === 'returned' && mapped !== 'returned') {
    return { applied: false, skipped: 'already_returned', occurrence: existing };
  }
  if (existing.status === mapped) {
    return { applied: true, duplicate: true, occurrence: existing };
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
    [existing.id, mapped, reason],
  )).rows[0];
  return { applied: true, occurrence: saved, previous: existing.status };
}

export async function saveBillingSettings(client, {
  tenantId, monthlyRateCents, referralDiscountCents, billingEnabled, billingDay, userId,
}) {
  const sets = [];
  const params = [];
  let i = 1;
  if (monthlyRateCents !== undefined) {
    const cents = Math.round(Number(monthlyRateCents));
    if (!Number.isFinite(cents) || cents < 0) return fail('invalid_monthly_rate');
    sets.push(`monthly_rate_cents = $${i++}`);
    params.push(cents);
  }
  if (referralDiscountCents !== undefined) {
    const cents = Math.round(Number(referralDiscountCents));
    if (!Number.isFinite(cents) || cents < 0) return fail('invalid_referral_discount');
    sets.push(`referral_discount_cents = $${i++}`);
    params.push(cents);
  }
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
            holder_name, last_four, verification_status, connection_status, environment, nickname
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
    method.holder_name || method.nickname || 'Billing account',
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
            idempotence_key, created_at
     FROM public.tenant_maintenance_payments
     WHERE tenant_id = $1::uuid
     ORDER BY period_start DESC NULLS LAST, created_at DESC
     LIMIT $2`,
    [tenantId, limit],
  )).rows;
  return rows;
}
