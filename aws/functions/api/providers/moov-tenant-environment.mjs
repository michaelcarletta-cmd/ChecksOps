/**
 * Dedicated tenant Moov environment switch.
 * Browser confirm/expected_current are hints. Server reads current from DB.
 * Does not migrate provider objects. Does not write via tenants write-allowlist.
 */
import { TENANT_MEMBERSHIP_SQL } from '../identity.mjs';
import {
  credentialSnapshot,
  ignoreClientEnvironment,
  loadTenantMoovEnvironment,
  MOOV_ENVIRONMENT_CHANGE_WARNING,
  normalizeMoovEnvironment,
} from './moov-environment.mjs';
import { PRODUCTION_MOOV_SECRET_NAMES, SANDBOX_MOOV_SECRET_NAMES } from './production/moov-secrets.mjs';
import { loadProviderSecrets } from '../provider-secrets.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const fail = (error, statusCode, extra = {}) => ({
  ok: false,
  statusCode,
  error,
  success: false,
  objects_migrated: false,
  liveProviderPosted: false,
  createdPaymentTransfer: false,
  productionExecution: false,
  ...extra,
});

const membershipsOf = async (client, userId) => {
  const rows = (await client.query(TENANT_MEMBERSHIP_SQL, [userId])).rows;
  return rows.map((row) => ({
    tenant_id: row.tenant_id,
    role: row.role,
    tenant_name: row.tenant_name,
    tenant_slug: row.tenant_slug,
  }));
};

const isPlatformAdmin = async (client, userId) => {
  const row = (await client.query(
    `SELECT 1 FROM public.user_roles WHERE user_id = $1::uuid AND role = 'admin' LIMIT 1`,
    [userId],
  )).rows[0];
  return Boolean(row);
};

const present = (secrets, key) => typeof secrets?.[key] === 'string' && secrets[key].trim().length > 0;

export const tenantEnvironmentChangeAuthorized = ({ isAdmin, role } = {}) => {
  if (isAdmin === true) return true;
  return ['owner', 'admin'].includes(String(role || '').toLowerCase());
};

export async function handleMoovTenantEnvironment({
  client,
  mapping,
  body = {},
  loadSecrets = loadProviderSecrets,
} = {}) {
  const claimed = body.tenant_id || body.tenantId || null;
  if (!claimed || !UUID_RE.test(String(claimed))) {
    return fail('invalid_uuid', 400, { field: 'tenant_id' });
  }
  const ignored = ignoreClientEnvironment(body);
  const memberships = await membershipsOf(client, mapping.application_user_id);
  const admin = await isPlatformAdmin(client, mapping.application_user_id);
  const membership = memberships.find((row) => row.tenant_id === claimed) || null;
  if (!tenantEnvironmentChangeAuthorized({ isAdmin: admin, role: membership?.role })) {
    return fail('Administrator access required', 403, {
      authorized_roles: ['platform_admin', 'tenant_owner', 'tenant_admin'],
    });
  }
  if (!admin && !membership) {
    return fail('cross_tenant_denied', 403);
  }

  const current = await loadTenantMoovEnvironment(client, claimed);
  if (!current.ok) return fail(current.error, current.statusCode);

  const secrets = await loadSecrets();
  const credentials = credentialSnapshot({
    sandboxConfigured: SANDBOX_MOOV_SECRET_NAMES
      .filter((name) => name.endsWith('_KEY') || name.endsWith('PUBLIC_KEY') || name.endsWith('SECRET_KEY'))
      .every((name) => present(secrets, name) || name === 'MOOV_SANDBOX_PLATFORM_ACCOUNT_ID'
        || name === 'MOOV_SANDBOX_ALLOWED_ORIGIN'
        || name === 'MOOV_SANDBOX_WEBHOOK_SECRET'
        || name === 'MOOV_SANDBOX_API_VERSION')
      && present(secrets, 'MOOV_SANDBOX_PUBLIC_KEY')
      && present(secrets, 'MOOV_SANDBOX_SECRET_KEY'),
    productionConfigured: present(secrets, 'MOOV_PUBLIC_KEY') && present(secrets, 'MOOV_SECRET_KEY'),
  });

  const requested = normalizeMoovEnvironment(body.next_environment || body.next || body.moov_environment_next);
  const readOnly = body.confirm !== true && body.confirm !== 'true';
  if (readOnly || !requested) {
    return {
      ok: true,
      statusCode: 200,
      success: true,
      tenant_id: current.tenantId,
      environment: current.environment,
      objects_migrated: false,
      warning: MOOV_ENVIRONMENT_CHANGE_WARNING,
      authorized_roles: ['platform_admin', 'tenant_owner', 'tenant_admin'],
      credentials,
      client_environment_ignored: ignored,
      liveProviderPosted: false,
      createdPaymentTransfer: false,
      productionExecution: false,
    };
  }

  if (requested === current.environment) {
    return {
      ok: true,
      statusCode: 200,
      success: true,
      tenant_id: current.tenantId,
      before: current.environment,
      after: current.environment,
      environment: current.environment,
      changed: false,
      objects_migrated: false,
      warning: MOOV_ENVIRONMENT_CHANGE_WARNING,
      credentials,
      client_environment_ignored: ignored,
      liveProviderPosted: false,
      createdPaymentTransfer: false,
      productionExecution: false,
    };
  }

  const expected = normalizeMoovEnvironment(body.expected_current || body.expectedCurrent);
  if (!expected) {
    return fail('expected_current_required', 400, {
      message: 'Confirm the current environment before switching. No objects are migrated.',
      warning: MOOV_ENVIRONMENT_CHANGE_WARNING,
    });
  }
  if (expected !== current.environment) {
    return fail('moov_environment_stale', 409, {
      before: current.environment,
      expected,
      message: 'Current environment changed. Refresh and confirm again.',
    });
  }

  let row;
  try {
    row = (await client.query(
      `SELECT * FROM public.aws_moov_set_tenant_environment($1::uuid, $2, $3, $4::uuid)`,
      [current.tenantId, expected, requested, mapping.application_user_id],
    )).rows[0];
  } catch (error) {
    const message = String(error?.message || error);
    if (message.includes('moov_environment_stale')) {
      return fail('moov_environment_stale', 409, { before: current.environment, expected });
    }
    return fail('moov_environment_update_failed', 500, { message: message.slice(0, 180) });
  }

  return {
    ok: true,
    statusCode: 200,
    success: true,
    tenant_id: row.tenant_id,
    actor_user_id: mapping.application_user_id,
    before: row.before_environment,
    after: row.after_environment,
    environment: row.after_environment,
    changed: row.before_environment !== row.after_environment,
    objects_migrated: false,
    timestamp: row.changed_at,
    warning: MOOV_ENVIRONMENT_CHANGE_WARNING,
    credentials,
    client_environment_ignored: ignored,
    liveProviderPosted: false,
    createdPaymentTransfer: false,
    productionExecution: false,
    productionMoneyMoved: false,
  };
}

export { PRODUCTION_MOOV_SECRET_NAMES, SANDBOX_MOOV_SECRET_NAMES };
