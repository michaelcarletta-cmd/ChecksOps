/**
 * Platform-owner tenant fee billing administration and tenant funding-source authorization.
 *
 * Owner decision (2026-10-17): the platform owner (is_platform_owner(), by
 * email) collects tenant fees MANUALLY from Tenant Management:
 *   1. `preview` returns the server invoice (Billing tab rates + recorded
 *      usage) for a period and a preview_hash, without charging;
 *   2. the SPA shows the total in a confirm dialog;
 *   3. `pull` with confirm:true, the period and the preview_hash charges only
 *      if the server-rebuilt invoice still hashes the same.
 * A browser-supplied amount is refused. Fees land only in the ChecksOps
 * platform account (platform_billing_destination or env config, set with
 * `destination-set`). There is no scheduled billing (manual_billing_only).
 */
import { ignoredSpoof, parseBody, withIdentityWrite } from './data.mjs';
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
  MANUAL_BILLING_ONLY,
  previewTenantPeriodCharge,
  recordBillingAudit,
  resendTenantFeeInvoice,
  saveBillingAuthorization,
  saveBillingSettings,
  verifyTenantBillingDebit,
} from './tenant-billing-engine.mjs';
import {
  billingDestinationStatus,
  billingEnvironment,
  resolveBillingDestination,
  setBillingDestination,
} from './tenant-billing-destination.mjs';
import { deliverFeeInvoiceEmail } from './tenant-fee-invoice-email.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isUuid = (value) => UUID_RE.test(String(value || ''));

/** Body fields that would carry a browser amount. A pull never takes one. */
export const CLIENT_AMOUNT_FIELDS = Object.freeze([
  'amount', 'amount_cents', 'amountCents', 'total', 'total_cents', 'line_items', 'lineItems',
]);
const clientAmountFields = (body) => CLIENT_AMOUNT_FIELDS.filter((key) => body?.[key] !== undefined);

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

/**
 * Once a charge has been booked (a period row exists and the audit row was
 * written) the response is ok:true so withIdentityWrite commits the ledger
 * row, the collection legs and the audit, whatever the provider said;
 * `charged` reports whether money was submitted. Refusals before booking
 * (not ready, preview mismatch, destination unset, ...) roll back.
 */
const chargeResponse = (spoof, result, key, extra = {}) => {
  if (result.booked === true) {
    return {
      ok: true,
      statusCode: 200,
      spoofFieldsIgnored: spoof,
      charged: result.ok === true && result.duplicate !== true,
      duplicate: result.duplicate === true,
      [key]: result,
      amount_cents_posted: result.ok === true && result.duplicate !== true ? (result.amount_cents ?? null) : 0,
      provider_transfer_ids: result.provider_transfer_ids || [],
      ...extra,
    };
  }
  return {
    ok: false,
    statusCode: result.statusCode || 409,
    spoofFieldsIgnored: spoof,
    error: result.error || 'charge_refused',
    message: result.message,
    charged: false,
    [key]: result,
    amount_cents_posted: 0,
    ...extra,
  };
};

/**
 * Runs fn({ client }) in its own committed transaction with the caller's
 * identity: withIdentityWrite in the Lambda; on an injected client (tests)
 * BEGIN / COMMIT on that client with request.app_user_id bound.
 */
const postCommitTxnRunner = (event, deps) => {
  if (deps.client) {
    const c = deps.client;
    return async (fn) => {
      await c.query('BEGIN');
      try {
        if (deps.mapping?.application_user_id) {
          await c.query("SELECT set_config('request.app_user_id', $1, true)", [deps.mapping.application_user_id]);
        }
        const result = await fn({ client: c });
        await c.query(result?.ok === false ? 'ROLLBACK' : 'COMMIT');
        return result;
      } catch (error) {
        await c.query('ROLLBACK').catch(() => {});
        throw error;
      }
    };
  }
  return (fn) => withIdentityWrite(event, ({ client }) => fn({ client }), deps);
};

/**
 * Invoice email ordering: the pull / resend transaction only queues the
 * invoice (outbox). Once that transaction has committed (result ok), the
 * email is claimed, sent and recorded in separate transactions
 * (deliverFeeInvoiceEmail). A refused or uncommitted request sends nothing.
 * With an injected client the caller owns the commit, so the step is handed
 * back as post_commit() instead of run here.
 */
export const handleTenantBillingAdmin = async (event, deps = {}) => {
  const result = await handleTenantBillingAdminInTransaction(event, deps);
  const marker = result?.post_commit_invoice || null;
  if (result && typeof result === 'object') delete result.post_commit_invoice;
  if (result?.pull && typeof result.pull === 'object') delete result.pull.invoice_email_after_commit;
  if (!marker || result?.ok !== true) return result;
  const deliver = () => deliverFeeInvoiceEmail({
    runTxn: postCommitTxnRunner(event, deps),
    occurrenceId: marker.occurrenceId,
    recordAudit: recordBillingAudit,
    confirmUnsent: marker.confirmUnsent === true,
    resend: marker.resend === true,
    deps,
  });
  const merge = (delivered) => {
    if (marker.resend) return { ...result, invoice_email: delivered };
    return {
      ...result,
      pull: { ...result.pull, invoice_email: delivered, invoice_email_sent: delivered.sent === true },
    };
  };
  if (deps.client) return { ...result, post_commit: async () => merge(await deliver()) };
  return merge(await deliver());
};

const handleTenantBillingAdminInTransaction = async (event, deps = {}) => {
  const body = parseBody(event);
  const spoof = ignoredSpoof(event, body);
  return runWithIdentity(event, async ({ client, mapping }) => {
    if (!(await actorIsPlatformOwner(client))) {
      return denied(spoof, {
        error: 'platform_owner_required',
        message: 'Tenant fee billing is limited to the ChecksOps platform owner.',
      });
    }
    const action = String(body.action || 'get');

    // Platform-level: where fees land. Never a tenant account, never from a
    // request field other than the platform owner's own set action.
    if (action === 'destination-get') {
      const destination = await billingDestinationStatus(client, { environment: billingEnvironment(), deps });
      return { ok: true, statusCode: 200, spoofFieldsIgnored: spoof, destination };
    }
    if (action === 'destination-set') {
      const saved = await setBillingDestination(client, {
        environment: billingEnvironment(),
        accountId: body.moov_account_id,
        paymentMethodId: body.moov_payment_method_id,
        label: body.label,
      });
      if (!saved.ok) return denied(spoof, { ...saved, statusCode: saved.statusCode || 400 });
      const destination = await billingDestinationStatus(client, { environment: billingEnvironment(), deps });
      return { ok: true, statusCode: 200, spoofFieldsIgnored: spoof, saved: true, destination };
    }

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
        mortgageOpsInitialRateCents: body.mortgage_ops_initial_rate_cents,
        mortgageOpsAdditionalRateCents: body.mortgage_ops_additional_rate_cents,
        perCheckBillingEnabled: body.per_check_billing_enabled,
        isFoundingPartner: body.is_founding_partner,
        depositsEnabled: body.deposits_enabled,
        billingEnabled: body.billing_enabled,
        billingDay: body.billing_day_of_month,
        userId: mapping.application_user_id,
      });
      if (!saved.ok) return denied(spoof, { ...saved, statusCode: saved.statusCode || 400 });
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
      let period = body.period;
      if (period === undefined || period === null || period === '') {
        const ctx = await loadTenantBillingContext(client, tenantId);
        if (!ctx.ok) return denied(spoof, { statusCode: ctx.statusCode || 404, ...ctx });
        period = defaultPullPeriodKey(new Date(), ctx.settings?.billing_day_of_month || 1);
      }
      const preview = await previewTenantPeriodCharge(client, { tenantId, period: String(period), deps });
      if (!preview.ok) return denied(spoof, { ...preview, statusCode: preview.statusCode || 400 });
      return { ...preview, ok: true, statusCode: 200, spoofFieldsIgnored: spoof, preview: true };
    }

    if (action === 'verify-debit') {
      if (body.confirm !== true) {
        return denied(spoof, {
          statusCode: 409,
          error: 'confirmation_required',
          message: 'Verify Billing Debit requires explicit operator confirmation.',
        });
      }
      if (body.amount_cents != null || body.amount != null) {
        const raw = Number(body.amount_cents ?? body.amount);
        if (raw !== 100) {
          return denied(spoof, {
            statusCode: 400,
            error: 'verification_amount_locked',
            message: 'Verify Billing Debit is hard-limited to $1.00 (100 cents). Client amounts are rejected.',
          });
        }
      }
      if (!isUuid(body.verification_id || body.verificationId)) {
        return denied(spoof, { statusCode: 400, error: 'invalid_uuid', field: 'verification_id' });
      }
      const verified = await verifyTenantBillingDebit(client, {
        tenantId,
        verificationId: body.verification_id || body.verificationId,
        recordedBy: mapping.application_user_id,
        fetchImpl: deps.fetchImpl,
        deps,
      });
      return chargeResponse(spoof, verified, 'verify', {
        client_amount_ignored: body.amount_cents != null || body.amount != null,
        idempotency_key: verified.idempotency_key || null,
      });
    }

    if (action === 'pull') {
      const supplied = clientAmountFields(body);
      if (supplied.length) {
        return denied(spoof, {
          statusCode: 400,
          error: 'client_amount_refused',
          fields: supplied,
          message: 'The amount is computed by the server from the Billing tab rates. Preview, then pull with the preview hash.',
        });
      }
      if (body.confirm !== true) {
        return denied(spoof, {
          statusCode: 409,
          error: 'confirmation_required',
          message: 'Pull requires explicit operator confirmation of the server invoice preview.',
        });
      }
      const period = String(body.period || '');
      const charged = await chargeTenantPeriod(client, {
        tenantId,
        period,
        previewHash: body.preview_hash || body.previewHash,
        recordedBy: mapping.application_user_id,
        fetchImpl: deps.fetchImpl,
        deps,
      });
      return chargeResponse(spoof, charged, 'pull', {
        period,
        idempotency_key: billingIdempotencyKey(tenantId, period),
        post_commit_invoice: charged.invoice_email_after_commit
          ? { occurrenceId: charged.invoice_email_after_commit, resend: false }
          : null,
      });
    }

    if (action === 'invoice-resend') {
      if (body.confirm !== true) {
        return denied(spoof, {
          statusCode: 409,
          error: 'confirmation_required',
          message: 'Resending the invoice email requires explicit operator confirmation.',
        });
      }
      const resent = await resendTenantFeeInvoice(client, { tenantId, period: String(body.period || ''), deps });
      if (!resent.ok) return denied(spoof, { ...resent, statusCode: resent.statusCode || 409 });
      const { invoice_email_after_commit: occurrenceId, ...rest } = resent;
      // ok:true commits the queued outbox row; the send runs after commit.
      return {
        ...rest,
        ok: true,
        statusCode: 200,
        spoofFieldsIgnored: spoof,
        post_commit_invoice: occurrenceId
          ? { occurrenceId, resend: true, confirmUnsent: body.confirm_unsent === true }
          : null,
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
      // Members see whether fees can be collected, not the platform's account ids.
      const owner = await actorIsPlatformOwner(client);
      const destination = owner ? data.destination : { configured: dest.ok === true };
      return { ok: true, statusCode: 200, spoofFieldsIgnored: spoof, ...data, destination };
    }
    if (!(await canAuthorizeTenantBilling(client, mapping.application_user_id, tenantId))) {
      return denied(spoof, {
        error: 'not_authorized',
        message: 'Only a member of this company can authorize its billing.',
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

/**
 * Retired (owner decision 2026-10-17): there is no scheduled or unattended
 * billing. Refuses before any database connection or provider call; nothing
 * in this codebase sets request.monthly_billing_job any more.
 */
export const handleMonthlyBillingScheduled = async (event) => ({
  ok: false,
  statusCode: 410,
  error: MANUAL_BILLING_ONLY,
  message: 'Tenant fees are collected manually by the platform owner from Tenant Management. There is no scheduled billing.',
  liveProviderCalled: false,
  spoofFieldsIgnored: ignoredSpoof(event, parseBody(event)),
});
