/**
 * Production Platform Finance reads (Tenant Management > Platform Finance):
 *   moov-platform-bank  action=status    the Banking panel
 *   platform-treasury   action=overview  the Wallet & P&L panel
 *
 * Both read the ChecksOps facilitator's own production payment account, never
 * a tenant's. The read model is parity/platform-finance.mjs (the module these
 * panels were built against); this file only binds the production context:
 * production credentials from loadProviderSecrets and the facilitator id
 * (MOOV_ACCOUNT_ID, never the sandbox facilitator).
 *
 * - Platform owner only (public.is_platform_owner()); checked before any
 *   secret is loaded or any provider call is made.
 * - Read-only: any other action is refused here (providers.mjs refuses it
 *   first, at the production hard block). No money moves, nothing is written.
 * - User-facing text never names the payment provider.
 */
import { fail } from '../parity/caller.mjs';
import { withMoovContext } from '../parity/moov-client.mjs';

const ENVIRONMENT = 'production';

/** The only production Platform Finance reads: function name -> action. */
export const PRODUCTION_PLATFORM_FINANCE_READS = Object.freeze({
  'moov-platform-bank': 'status',
  'platform-treasury': 'overview',
});

export const isProductionPlatformFinanceRead = (name, body) => {
  const allowed = PRODUCTION_PLATFORM_FINANCE_READS[String(name || '')];
  return Boolean(allowed) && String(body?.action ?? '').toLowerCase() === allowed;
};

const VENDOR_RE = /\bmoov\b/gi;

export function scrubVendorText(value) {
  if (typeof value !== 'string') return value;
  return value.replace(VENDOR_RE, 'payment provider');
}

function scrubResult(result) {
  if (!result || typeof result !== 'object') return result;
  const out = { ...result };
  for (const key of ['error', 'message']) {
    if (typeof out[key] === 'string') out[key] = scrubVendorText(out[key]);
  }
  if (Array.isArray(out.warnings)) out.warnings = out.warnings.map(scrubVendorText);
  return out;
}

const readOnlyFlags = { liveProviderCalled: false, tenant_context_used: false, ach_initiated: false, fee_pull: false };

async function loadReadModel(deps) {
  if (deps.platformFinanceModule) return deps.platformFinanceModule;
  try {
    return await import('../parity/platform-finance.mjs');
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') return null;
    throw error;
  }
}

export async function handleProductionPlatformFinance(name, event, deps = {}) {
  const { parseBody, withIdentity } = await import('../../data.mjs');
  const early = parseBody(event);
  const action = String(early?.action ?? '').toLowerCase();
  if (!isProductionPlatformFinanceRead(name, early)) {
    return fail('Platform Finance writes are disabled.', 403, { write_blocked: true, action, ...readOnlyFlags });
  }
  const identity = typeof deps.withIdentity === 'function' ? deps.withIdentity : withIdentity;
  return identity(event, async ({ client, mapping, claims, spoof }) => {
    const caller = { spoofFieldsIgnored: spoof, applicationUserId: mapping.application_user_id };
    const owner = (await client.query('SELECT public.is_platform_owner() AS is_owner')).rows[0];
    if (owner?.is_owner !== true) {
      return { ...fail('Platform owner access required', 403, readOnlyFlags), ...caller };
    }
    const model = await loadReadModel(deps);
    if (!model?.platformFinanceBank?.run || !model?.loadPlatformFinanceCredentials) {
      return { ...fail('platform_finance_unavailable', 503, { message: 'Platform Finance is not available.', ...readOnlyFlags }), ...caller };
    }
    const credentials = await model.loadPlatformFinanceCredentials({
      environment: ENVIRONMENT,
      loadProviderSecrets: deps.loadProviderSecrets,
    });
    if (!credentials?.publicKey || !credentials?.secretKey) {
      return { ...fail('Production payment credentials are not configured.', 503, readOnlyFlags), ...caller };
    }
    const platformAccountId = model.resolvePlatformFacilitatorId({
      environment: ENVIRONMENT,
      productionPlatformAccountId: credentials.platformAccountId,
    });
    if (!platformAccountId) {
      return { ...fail('Production platform account is not configured.', 503, readOnlyFlags), ...caller };
    }
    const fetchImpl = deps.fetchImpl || fetch;
    const moovContext = {
      environment: ENVIRONMENT,
      sandboxPublicKey: null,
      sandboxSecretKey: null,
      sandboxPlatformAccountId: null,
      productionPublicKey: credentials.publicKey,
      productionSecretKey: credentials.secretKey,
      productionPlatformAccountId: platformAccountId,
      apiVersion: credentials.apiVersion || 'v2024.01.00',
      allowedOrigin: 'https://checksops.com',
      appUrl: 'https://checksops.com',
    };
    try {
      const result = await withMoovContext({ ...moovContext, fetchImpl }, () => model.platformFinanceBank.run({
        client,
        body: { action },
        ctx: { name, environment: ENVIRONMENT, platformAccountId, tenantId: null, tenant_context_used: false },
        fetchImpl,
      }));
      return {
        ...scrubResult(result),
        ...caller,
        authUid: mapping.application_user_id,
        cognitoSub: claims.sub,
        productionExecution: false,
        environment: ENVIRONMENT,
        tenant_context_used: false,
      };
    } catch (error) {
      return {
        ...fail(scrubVendorText(error?.message || 'Platform Finance read failed'), error?.status || 500, {
          ...readOnlyFlags,
          liveProviderCalled: true,
        }),
        ...caller,
      };
    }
  }, deps);
}
