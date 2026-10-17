/**
 * Single request context for Moov onboarding handlers.
 *
 * Owner policy: tenants have no role tiers. Every tenant_users member of THAT
 * tenant is a user with equal rights (the tenant_users.role column is ignored).
 * - tenant_id is required and must be a tenant_users membership of the caller,
 *   unless the caller is the platform owner (public.is_platform_owner(), decided
 *   by the resolved identity email). Global user_roles admin grants nothing.
 * - Submit (anything that changes ChecksOps or Moov state, EIN reveal included):
 *   any member of THAT tenant, or the platform owner for any tenant.
 *   Partners, other tenants and non-member global admins get nothing.
 * - Environment comes from the tenant's moov_environment plus server config,
 *   never from the request body.
 */
import { loadSandboxCredentials } from '../../sandbox-credentials.mjs';
import { fail, membershipsOf } from '../parity/caller.mjs';
import { MOOV_PINNED_VERSION } from '../parity/moov-client.mjs';
import { onboardingDeployment } from './flags.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const PLATFORM_OWNER_SQL = 'SELECT COALESCE(public.is_platform_owner(), false) AS is_platform_owner';
export const TENANT_MOOV_ENV_SQL = 'SELECT moov_allowlisted, moov_environment FROM public.tenants WHERE id = $1::uuid';

export const isUuid = (value) => UUID_RE.test(String(value || ''));

export async function resolveOnboardingAccess(client, { userId, body, access = 'read' }) {
  const claimed = body?.tenant_id ?? null;
  if (claimed === null || claimed === undefined || claimed === '') {
    return fail('tenant_id_required', 400, { field: 'tenant_id', message: 'tenant_id is required.' });
  }
  if (!isUuid(claimed)) return fail('invalid_uuid', 400, { field: 'tenant_id' });
  const tenantId = String(claimed).toLowerCase();
  const memberships = await membershipsOf(client, userId);
  // Membership only; the stored role is intentionally not read.
  const member = memberships.some((m) => String(m.tenant_id).toLowerCase() === tenantId);
  const platformOwner = (await client.query(PLATFORM_OWNER_SQL)).rows[0]?.is_platform_owner === true;
  if (!member && !platformOwner) {
    return fail('cross_tenant_denied', 403, {
      message: 'Requested tenant_id is not a membership of the authenticated user.',
    });
  }
  const canSubmit = member || platformOwner;
  if (access === 'submit' && !canSubmit) {
    return fail('onboarding_submit_forbidden', 403, {
      message: 'Only a member of this organization can change Compliance & Docs or bank setup.',
    });
  }
  return { tenantId, member, platformOwner, canSubmit, memberships };
}

export async function resolveOnboardingEnvironment(client, tenantId, deployment = onboardingDeployment()) {
  if (!deployment) return fail('provider_disabled', 403, { provider: 'moov' });
  const row = (await client.query(TENANT_MOOV_ENV_SQL, [tenantId])).rows[0];
  if (!row) return fail('tenant_not_found', 404, { message: 'Organization not found' });
  if (row.moov_allowlisted === false) {
    return fail('provider_not_allowlisted', 403, {
      message: 'This organization is not enabled for this payment provider.',
    });
  }
  const tenantEnv = String(row.moov_environment || '').toLowerCase() === 'production' ? 'production' : 'sandbox';
  if (deployment === 'production') {
    // Production execution binds production Moov only, and only for tenants
    // flagged production. There is never a production -> sandbox fallback.
    if (tenantEnv !== 'production') {
      return fail('production_provider_context_unresolved', 503, {
        message: 'Production payment provider environment could not be resolved.',
      });
    }
    return { environment: 'production' };
  }
  // Staging: always Moov sandbox and environment='sandbox' rows, even for a
  // restored tenant flagged production.
  return { environment: 'sandbox' };
}

export async function loadOnboardingMoovContext(environment, deps = {}) {
  if (environment === 'production') {
    const loader = typeof deps.loadProviderSecrets === 'function'
      ? deps.loadProviderSecrets
      : (await import('../../provider-secrets.mjs')).loadProviderSecrets;
    const secrets = await loader();
    const productionPublicKey = secrets?.MOOV_PUBLIC_KEY ?? null;
    const productionSecretKey = secrets?.MOOV_SECRET_KEY ?? null;
    if (!productionPublicKey || !productionSecretKey) {
      return fail('production_credentials_unavailable', 503, {
        message: 'Production Moov credentials are not configured.',
      });
    }
    return {
      environment: 'production',
      sandboxPublicKey: null,
      sandboxSecretKey: null,
      sandboxPlatformAccountId: null,
      sandboxOrigin: null,
      apiVersion: MOOV_PINNED_VERSION,
      productionPublicKey,
      productionSecretKey,
      productionPlatformAccountId: secrets?.MOOV_ACCOUNT_ID ?? null,
      allowedOrigin: 'https://checksops.com',
      appUrl: 'https://checksops.com',
    };
  }
  const loader = typeof deps.loadSandboxCredentials === 'function' ? deps.loadSandboxCredentials : loadSandboxCredentials;
  const loaded = await loader();
  if (!loaded?.moov?.publicKey || !loaded?.moov?.secretKey) {
    return fail('sandbox_credentials_unavailable', 503, {
      message: 'Sandbox payment credentials are not configured for this test organization.',
    });
  }
  return {
    environment: 'sandbox',
    sandboxPublicKey: loaded.moov.publicKey,
    sandboxSecretKey: loaded.moov.secretKey,
    sandboxPlatformAccountId: loaded.moov.platformAccountId || null,
    sandboxOrigin: loaded.moov.origin || 'https://checksops.com',
    apiVersion: loaded.moov.apiVersion || MOOV_PINNED_VERSION,
    productionPublicKey: null,
    productionSecretKey: null,
    productionPlatformAccountId: null,
  };
}
