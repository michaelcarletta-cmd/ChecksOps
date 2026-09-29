/**
 * Cognito-mapped caller for ported Moov/CheckAlt Edge Functions.
 * Intentional AWS improvements: Cognito sub → application UUID, membership RLS,
 * spoofed tenant headers ignored, production credentials refused on staging.
 */
import { TENANT_MEMBERSHIP_SQL } from '../../identity.mjs';
import { executionAllowed } from '../../provider-flags.mjs';
import { providerSandboxExecutionEnabled } from '../../sandbox-flags.mjs';
import { loadSandboxCredentials } from '../../sandbox-credentials.mjs';
import { evaluateReadiness } from '../readiness.mjs';
import { bindMoovEnvironment } from './moov-client.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const jsonResult = (body, status = 200) => ({
  ok: status < 400 && body?.error == null,
  statusCode: status,
  success: status < 400 && body?.error == null,
  liveProviderCalled: Boolean(body?.liveProviderCalled),
  productionExecution: false,
  ...body,
});

export const fail = (error, status = 400, extra = {}) => jsonResult({ error, success: false, ok: false, ...extra }, status);

export async function membershipsOf(client, userId) {
  const rows = (await client.query(TENANT_MEMBERSHIP_SQL, [userId])).rows;
  return rows.map((row) => ({
    tenant_id: row.tenant_id,
    role: row.role,
    tenant_name: row.tenant_name,
    tenant_slug: row.tenant_slug,
  }));
}

export async function isPlatformAdmin(client, userId) {
  const row = (await client.query(
    `SELECT 1 FROM public.user_roles WHERE user_id = $1::uuid AND role = 'admin' LIMIT 1`,
    [userId],
  )).rows[0];
  return Boolean(row);
}

/** Established ChecksOps master-admin contract. Tenant user_roles.admin never qualifies. */
export async function isChecksOpsPlatformOwner(client) {
  const row = (await client.query('SELECT public.is_platform_owner() AS is_owner')).rows[0];
  return row?.is_owner === true;
}

export async function resolveTenant(client, { userId, body, memberships, requireAdmin = false }) {
  const claimed = body?.tenant_id || body?.tenantId || null;
  if (claimed && !UUID_RE.test(String(claimed))) return fail('invalid_uuid', 400, { field: 'tenant_id' });
  const admin = await isPlatformAdmin(client, userId);
  if (requireAdmin && !admin) {
    const role = claimed ? memberships.find((m) => m.tenant_id === claimed)?.role : memberships[0]?.role;
    if (!['owner', 'admin'].includes(String(role || ''))) {
      return fail('Administrator access required', 403);
    }
  }
  if (claimed) {
    if (!admin && !memberships.some((m) => m.tenant_id === claimed)) {
      return fail('Forbidden', 403, { error: 'cross_tenant_denied' });
    }
    return { tenantId: claimed, isAdmin: admin };
  }
  if (!memberships.length && !admin) return fail('Forbidden', 403);
  return { tenantId: memberships[0]?.tenant_id || null, isAdmin: admin };
}

export async function loadTenantMoovEnv(client, tenantId) {
  if (!tenantId) return 'sandbox';
  const row = (await client.query(
    'SELECT moov_allowlisted, moov_environment FROM public.tenants WHERE id = $1::uuid',
    [tenantId],
  )).rows[0];
  if (!row) return { error: 'Organization not found', statusCode: 404 };
  if (row.moov_allowlisted === false) {
    return { error: 'This organization is not enabled for this payment provider.', statusCode: 403 };
  }
  const tenantEnv = String(row.moov_environment || '').toLowerCase();
  return tenantEnv === 'production' || tenantEnv === 'sandbox' ? tenantEnv : 'sandbox';
}

/**
 * Staging never binds production Moov credentials. If the tenant is flagged
 * production, sandbox execution still uses MOOV_SANDBOX_* against environment
 * = 'sandbox' rows so restored production payment_provider_accounts are not
 * overwritten (unique tenant_id+provider+environment).
 */
export function effectiveMoovEnvironment(tenantEnv) {
  if (executionAllowed('moov')) return tenantEnv === 'production' ? 'production' : 'sandbox';
  return 'sandbox';
}

export async function requireParityEnabled(provider) {
  if (executionAllowed(provider)) {
    return fail('production_execution_blocked', 403, {
      message: 'Production provider flags are reserved for a later cutover. Staging runs sandbox/UAT only.',
    });
  }
  if (!providerSandboxExecutionEnabled()) {
    return fail('provider_disabled', 403, {
      provider,
      message: 'Provider execution is disabled on AWS staging. Enable AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED for sandbox/UAT only.',
    });
  }
  return null;
}

export async function moovParityContext({ client, mapping, body, requireAdmin = false, loadSandbox = loadSandboxCredentials }) {
  const gated = await requireParityEnabled('moov');
  if (gated) return gated;
  const memberships = await membershipsOf(client, mapping.application_user_id);
  const tenant = await resolveTenant(client, {
    userId: mapping.application_user_id,
    body,
    memberships,
    requireAdmin,
  });
  if (tenant.error) return tenant;
  if (!tenant.tenantId) return fail('tenant_id is required', 400);
  const tenantEnv = await loadTenantMoovEnv(client, tenant.tenantId);
  if (tenantEnv?.error) return fail(tenantEnv.error, tenantEnv.statusCode);
  const environment = effectiveMoovEnvironment(tenantEnv);
  bindMoovEnvironment(environment);
  const loader = typeof loadSandbox === 'function' ? loadSandbox : loadSandboxCredentials;
  const loaded = await loader();
  if (environment === 'production') {
    return fail('production_credentials_refused', 403, {
      message: 'Production Moov keys are not used on AWS staging.',
    });
  }
  if (!loaded.moov) {
    return fail('Sandbox payment credentials are not configured for this test organization.', 503, {
      error: 'sandbox_credentials_unavailable',
    });
  }
  const ctx = {
    environment: 'sandbox',
    sandboxPublicKey: loaded.moov.publicKey,
    sandboxSecretKey: loaded.moov.secretKey,
    sandboxPlatformAccountId: loaded.moov.platformAccountId || null,
    sandboxOrigin: loaded.moov.origin || 'https://checksops.com',
    apiVersion: loaded.moov.apiVersion || 'v2024.01.00',
    productionPublicKey: null,
    productionSecretKey: null,
    productionPlatformAccountId: null,
  };
  if (!ctx.sandboxPublicKey || !ctx.sandboxSecretKey) {
    return fail('Sandbox payment credentials are not configured for this test organization.', 503, {
      error: 'sandbox_credentials_unavailable',
    });
  }
  return {
    tenantId: tenant.tenantId,
    isAdmin: tenant.isAdmin,
    environment: 'sandbox',
    userId: mapping.application_user_id,
    memberships,
    moovContext: ctx,
    loaded,
  };
}

export async function checkAltParityContext({ client, mapping, body, requireAdmin = false, loadSandbox = loadSandboxCredentials }) {
  const gated = await requireParityEnabled('checkalt');
  if (gated) return gated;
  const memberships = await membershipsOf(client, mapping.application_user_id);
  const tenant = await resolveTenant(client, {
    userId: mapping.application_user_id,
    body,
    memberships,
    requireAdmin,
  });
  if (tenant.error && body?.tenant_id) return tenant;
  const loader = typeof loadSandbox === 'function' ? loadSandbox : loadSandboxCredentials;
  const loaded = await loader();
  if (!loaded.checkalt) {
    return fail('CheckAlt UAT credentials are not configured.', 503, {
      error: 'sandbox_credentials_unavailable',
    });
  }
  return {
    tenantId: tenant.tenantId || memberships[0]?.tenant_id || null,
    isAdmin: tenant.isAdmin || await isPlatformAdmin(client, mapping.application_user_id),
    userId: mapping.application_user_id,
    memberships,
    uat: loaded.checkalt,
    loaded,
  };
}

export { evaluateReadiness };
