/**
 * Production Invoices (moov-invoice): create, send, resend, cancel, delete,
 * sync and recover a tenant's invoices against the production payment account.
 *
 * The lifecycle itself is invoice-provider.mjs (the same code staging runs on
 * sandbox credentials); this module only binds the production context:
 * production credentials, the tenant's environment='production' account, and
 * environment='production' rows in moov_invoices / moov_invoice_customers.
 *
 * - Any member of the tenant may act (as on staging); the tenant comes from the
 *   caller's memberships, never from a spoofed header.
 * - The tenant must be a production payment tenant (tenants.moov_environment)
 *   with a production account row; otherwise it fails closed, no provider call.
 * - No money moves: an invoice asks the customer to pay through the hosted link.
 * - User-facing text never names the payment provider.
 */
import { withMoovContext } from '../parity/moov-client.mjs';
import { fail, moovProductionReadContext } from '../parity/caller.mjs';

const ENVIRONMENT = 'production';

const VENDOR_RE = /\bmoov\b/gi;

/** Error and message text shown to the user never names the payment provider. */
export function scrubVendorText(value) {
  if (typeof value !== 'string') return value;
  return value.replace(VENDOR_RE, 'payment provider');
}

export function scrubInvoiceResult(result) {
  if (!result || typeof result !== 'object') return result;
  const out = { ...result };
  for (const key of ['error', 'message']) {
    if (typeof out[key] === 'string') out[key] = scrubVendorText(out[key]);
  }
  return out;
}

export async function handleProductionMoovInvoice(event, deps = {}) {
  const { withIdentityWrite } = await import('../../data.mjs');
  return withIdentityWrite(event, async ({ client, mapping, claims, body, spoof }) => {
    const ctx = await moovProductionReadContext({
      client,
      mapping,
      body,
      requireAdmin: false,
      loadProviderSecrets: deps.loadProviderSecrets,
    });
    const caller = { spoofFieldsIgnored: spoof, applicationUserId: mapping.application_user_id };
    if (ctx.error) return { ...scrubInvoiceResult(ctx), ...caller };

    let invoiceActions;
    try {
      // Whole-module import: a bundle without the invoice lifecycle refuses instead of failing to load.
      invoiceActions = await import('../../invoice-actions.mjs');
    } catch (error) {
      if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
      return {
        ...fail('invoice_lifecycle_unavailable', 503, {
          message: 'Invoices are not available yet.',
          liveProviderCalled: false,
          emailed: false,
        }),
        ...caller,
      };
    }

    const fetchImpl = deps.fetchImpl || fetch;
    const result = await withMoovContext({ ...ctx.moovContext, fetchImpl }, () => invoiceActions.runInvoiceAction({
      client,
      body,
      fetchImpl,
      ctx: { tenantId: ctx.tenantId, userId: ctx.userId, environment: ENVIRONMENT },
    }));
    return {
      ...scrubInvoiceResult(result),
      ...caller,
      authUid: mapping.application_user_id,
      cognitoSub: claims.sub,
      productionExecution: false,
      environment: ENVIRONMENT,
    };
  }, deps);
}
