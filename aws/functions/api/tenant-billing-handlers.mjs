/**
 * Platform-owner monthly billing administration and tenant funding-source authorization.
 */
import pg from 'pg';
import { ignoredSpoof, parseBody, withIdentityWrite } from './data.mjs';
import { loadDatabaseCredentials } from './secrets.mjs';
import { buildWriteClientConfig, sanitizePublicError } from './db-health.mjs';
import {
  actorIsPlatformOwner,
  applyBillingProviderEvent,
  billingIdempotencyKey,
  buildTenantBillingSnapshot,
  canAuthorizeTenantBilling,
  canViewTenantBilling,
  chargeTenantPeriod,
  defaultPullPeriodKey,
  loadTenantBillingContext,
  runMonthlyBillingScheduler,
  saveBillingAuthorization,
  saveBillingSettings,
} from './tenant-billing-engine.mjs';
import {
  billingEnvironment,
  monthlyBillingEnabled,
  resolveBillingDestination,
} from './tenant-billing-destination.mjs';

const { Client } = pg;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isUuid = (value) => UUID_RE.test(String(value || ''));

const denied = (spoof, extra) => ({
  ok: false,
  statusCode: extra.statusCode || 403,
  spoofFieldsIgnored: spoof,
  ...extra,
});

const snapshot = (client, tenantId, dest, extras = {}) => (
  buildTenantBillingSnapshot(client, tenantId, dest, extras)
);

const runWithIdentity = (event, fn, deps) => {
  if (deps.client && deps.mapping) {
    return fn({ client: deps.client, mapping: deps.mapping, body: parseBody(event), spoof: ignoredSpoof(event, parseBody(event)) });
  }
  return withIdentityWrite(event, fn, deps);
};

export const handleTenantBillingAdmin = async (event, deps = {}) => {
  const body = parseBody(event);
  const spoof = ignoredSpoof(event, body);
  return runWithIdentity(event, async ({ client, mapping }) => {
    if (!(await actorIsPlatformOwner(client))) {
      return denied(spoof, {
        error: 'platform_owner_required',
        message: 'Monthly billing administration is limited to the ChecksOps platform owner.',
      });
    }
    const action = String(body.action || 'get');
    const tenantId = body.tenant_id || body.tenantId;
    if (!isUuid(tenantId)) {
      return denied(spoof, { statusCode: 400, error: 'invalid_uuid', field: 'tenant_id' });
    }

    const dest = await resolveBillingDestination(client, {
      environment: billingEnvironment(),
      deps,
    });

    if (action === 'get') {
      const data = await snapshot(client, tenantId, dest);
      if (!data.ok) return denied(spoof, { statusCode: data.statusCode || 404, ...data });
      return { ok: true, statusCode: 200, spoofFieldsIgnored: spoof, ...data };
    }

    if (action === 'update') {
      const saved = await saveBillingSettings(client, {
        tenantId,
        monthlyRateCents: body.monthly_rate_cents,
        referralDiscountCents: body.referral_discount_cents,
        perCheckRateCents: body.per_check_rate_cents,
        nextDayRateCents: body.next_day_rate_cents,
        sameDayRateCents: body.same_day_rate_cents,
        billingEnabled: body.billing_enabled,
        billingDay: body.billing_day_of_month,
        userId: mapping.application_user_id,
      });
      if (!saved.ok) return denied(spoof, { statusCode: 400, ...saved });
      const data = await snapshot(client, tenantId, dest);
      return { ok: true, statusCode: 200, spoofFieldsIgnored: spoof, saved: true, ...data };
    }

    if (action === 'apply-event') {
      const applied = await applyBillingProviderEvent(client, {
        providerTransferId: body.provider_transfer_id || body.providerTransferId,
        status: body.status,
        reason: body.reason || 'simulated_webhook',
      });
      const data = await snapshot(client, tenantId, dest);
      return {
        ok: applied.applied === true,
        statusCode: applied.applied ? 200 : 409,
        spoofFieldsIgnored: spoof,
        event: applied,
        ...data,
      };
    }

    if (action === 'preview') {
      const data = await snapshot(client, tenantId, dest);
      if (!data.ok) return denied(spoof, { statusCode: data.statusCode || 404, ...data });
      return { ok: true, statusCode: 200, spoofFieldsIgnored: spoof, preview: true, ...data };
    }

    if (action === 'pull') {
      if (body.confirm !== true) {
        const data = await snapshot(client, tenantId, dest);
        return {
          ok: false,
          statusCode: 409,
          error: 'confirmation_required',
          message: 'Pull Now requires explicit operator confirmation of the server invoice preview.',
          spoofFieldsIgnored: spoof,
          ...data,
        };
      }
      const ctx = await loadTenantBillingContext(client, tenantId);
      const period = body.period || defaultPullPeriodKey(new Date(), ctx.settings?.billing_day_of_month || 1);
      const charged = await chargeTenantPeriod(client, {
        tenantId,
        period,
        recordedBy: mapping.application_user_id,
        fetchImpl: deps.fetchImpl,
        deps: {
          ...deps,
          // Never trust a client-supplied amount. Persisted invoice total wins.
          amountCents: undefined,
        },
      });
      const data = await snapshot(client, tenantId, dest);
      return {
        ok: charged.ok === true,
        statusCode: charged.ok ? 200 : (charged.statusCode || 409),
        spoofFieldsIgnored: spoof,
        pull: charged,
        amount_cents_posted: charged.amount_cents ?? charged.occurrence?.amount_cents ?? null,
        client_amount_ignored: body.amount_cents != null || body.amount != null,
        idempotency_key: billingIdempotencyKey(tenantId, period),
        ...data,
      };
    }

    return denied(spoof, { statusCode: 400, error: 'unknown_action', action });
  }, deps);
};

export const handleTenantBillingAuthorize = async (event, deps = {}) => {
  const body = parseBody(event);
  const spoof = ignoredSpoof(event, body);
  return runWithIdentity(event, async ({ client, mapping }) => {
    const tenantId = body.tenant_id || body.tenantId;
    if (!isUuid(tenantId)) {
      return denied(spoof, { statusCode: 400, error: 'invalid_uuid', field: 'tenant_id' });
    }
    if (body.action === 'snapshot' || body.action === 'get') {
      if (!(await canViewTenantBilling(client, mapping.application_user_id, tenantId))) {
        return denied(spoof, {
          error: 'not_authorized',
          message: 'Only tenant members or the ChecksOps platform owner can view billing.',
        });
      }
      const dest = await resolveBillingDestination(client, {
        environment: billingEnvironment(),
        deps,
      });
      const data = await snapshot(client, tenantId, dest);
      if (!data.ok) return denied(spoof, { statusCode: data.statusCode || 404, ...data });
      return { ok: true, statusCode: 200, spoofFieldsIgnored: spoof, ...data };
    }
    if (!(await canAuthorizeTenantBilling(client, mapping.application_user_id, tenantId))) {
      return denied(spoof, {
        error: 'not_authorized',
        message: 'Only the tenant admin or ChecksOps platform owner can authorize billing.',
      });
    }
    if (body.action === 'pause' || body.auto_debit_enabled === false) {
      await client.query(
        `UPDATE public.tenant_billing_accounts
         SET auto_debit_enabled = false, updated_at = now()
         WHERE tenant_id = $1::uuid`,
        [tenantId],
      );
      const ctx = await loadTenantBillingContext(client, tenantId);
      return { ok: true, statusCode: 200, spoofFieldsIgnored: spoof, authorization: ctx.authorization };
    }
    if (!body.provider_payment_method_id && !body.payment_method_id) {
      return denied(spoof, { statusCode: 400, error: 'missing_funding_source' });
    }
    const saved = await saveBillingAuthorization(client, {
      tenantId,
      userId: mapping.application_user_id,
      paymentMethodId: body.provider_payment_method_id || body.payment_method_id,
      autoDebitEnabled: body.auto_debit_enabled !== false,
      authorized: body.authorized !== false,
    });
    if (!saved.ok) return denied(spoof, { statusCode: saved.statusCode || 400, ...saved });
    return { ok: true, statusCode: 200, spoofFieldsIgnored: spoof, ...saved };
  }, deps);
};

export const handleBillingProviderEvent = applyBillingProviderEvent;

export const handleMonthlyBillingScheduled = async (event, deps = {}) => {
  const spoof = ignoredSpoof(event, parseBody(event));
  if (!monthlyBillingEnabled() && deps.ignoreEnabledFlag !== true) {
    return {
      ok: false,
      statusCode: 403,
      error: 'monthly_billing_disabled',
      message: 'Monthly tenant billing is not enabled on this runtime.',
      spoofFieldsIgnored: spoof,
    };
  }
  let client;
  try {
    if (deps.client) {
      client = deps.client;
      await client.query("SELECT set_config('request.monthly_billing_job', '1', true)").catch(() => {});
      const result = await runMonthlyBillingScheduler(client, {
        now: deps.now,
        fetchImpl: deps.fetchImpl,
        deps,
      });
      return { ok: result.ok === true, statusCode: result.ok ? 200 : (result.statusCode || 409), spoofFieldsIgnored: spoof, ...result };
    }
    const credentials = await loadDatabaseCredentials();
    client = new Client(buildWriteClientConfig(credentials, { queryTimeoutMillis: 25000 }));
    await client.connect();
    await client.query('BEGIN');
    await client.query('SET TRANSACTION READ WRITE');
    await client.query("SELECT set_config('request.monthly_billing_job', '1', true)");
    const result = await runMonthlyBillingScheduler(client, {
      now: deps.now,
      fetchImpl: deps.fetchImpl,
      deps,
    });
    await client.query('COMMIT');
    return { ok: result.ok === true, statusCode: result.ok ? 200 : (result.statusCode || 409), spoofFieldsIgnored: spoof, ...result };
  } catch (error) {
    if (client && !deps.client) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    }
    return {
      ok: false,
      statusCode: 503,
      error: 'monthly_billing_scheduler_failed',
      message: sanitizePublicError(error),
      spoofFieldsIgnored: spoof,
    };
  } finally {
    if (client && !deps.client) {
      try { await client.end(); } catch { /* ignore */ }
    }
  }
};
