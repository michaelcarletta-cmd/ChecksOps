import pg from 'pg';
import { loadDatabaseCredentials } from './secrets.mjs';
import { buildClientConfig, sanitizePublicError } from './db-health.mjs';
import {
  APP_USER_EMAIL_GUC,
  APP_USER_ID_GUC,
  bearerToken,
  cognitoClaimsFromEvent,
  refuseSubAsApplicationId,
  verifyCognitoIdToken,
} from './cognito.mjs';
import { isPrivilegedRoleList, privilegedAuthPolicy } from './privileged-auth.mjs';

const { Client } = pg;

export const LOOKUP_MAPPING_SQL = `SELECT application_user_id::text AS application_user_id,
       cognito_sub,
       email,
       status
FROM public.identity_accounts
WHERE cognito_sub = $1
  AND status IN ('active', 'isolated_test')`;

export const PROFILE_SQL = `SELECT id::text AS id, email, full_name, approval_status
FROM public.profiles
WHERE id = $1::uuid`;

export const TENANT_MEMBERSHIP_SQL = `SELECT tu.tenant_id::text AS tenant_id,
       tu.role,
       t.name AS tenant_name,
       t.slug AS tenant_slug
FROM public.tenant_users tu
LEFT JOIN public.tenants t ON t.id = tu.tenant_id
WHERE tu.user_id = $1::uuid
ORDER BY t.slug`;

export const USER_ROLES_SQL = `SELECT role
FROM public.user_roles
WHERE user_id = $1::uuid
ORDER BY role`;

const jsonSafe = (value) => (value === undefined ? null : value);

export const resolveIdentitySession = async ({
  cognitoSub,
  email = null,
  loadCredentials = loadDatabaseCredentials,
  createClient = (config) => new Client(config),
} = {}) => {
  if (!cognitoSub) {
    return { ok: false, statusCode: 401, error: 'missing_cognito_sub' };
  }

  let client;
  try {
    const credentials = await loadCredentials();
    client = createClient(buildClientConfig(credentials, { queryTimeoutMillis: 10000 }));
    await client.connect();
    await client.query('BEGIN');

    const mapping = (await client.query(LOOKUP_MAPPING_SQL, [cognitoSub])).rows[0];
    if (!mapping) {
      await client.query('ROLLBACK');
      return { ok: false, statusCode: 401, error: 'identity_not_linked' };
    }

    refuseSubAsApplicationId(mapping.application_user_id, cognitoSub);

    await client.query('SELECT set_config($1, $2, true)', [APP_USER_ID_GUC, mapping.application_user_id]);
    // Application email, not Cognito probe email, so JWT-email policies cannot be spoofed.
    await client.query('SELECT set_config($1, $2, true)', [APP_USER_EMAIL_GUC, mapping.email || email || '']);

    const uid = (await client.query('SELECT auth.uid()::text AS auth_uid')).rows[0]?.auth_uid;
    if (uid !== mapping.application_user_id) {
      await client.query('ROLLBACK');
      return {
        ok: false,
        statusCode: 500,
        error: 'auth_uid_mismatch',
        applicationUserId: mapping.application_user_id,
        authUid: uid || null,
      };
    }

    const profile = (await client.query(PROFILE_SQL, [mapping.application_user_id])).rows[0] || null;
    const tenants = (await client.query(TENANT_MEMBERSHIP_SQL, [mapping.application_user_id])).rows;
    const roles = (await client.query(USER_ROLES_SQL, [mapping.application_user_id])).rows.map((row) => row.role);
    const masterOwner = (await client.query('SELECT public.is_master_owner() AS is_master_owner')).rows[0]?.is_master_owner === true;

    await client.query('ROLLBACK');

    return {
      ok: true,
      statusCode: 200,
      cognitoSub,
      applicationUserId: mapping.application_user_id,
      authUid: uid,
      mappingStatus: mapping.status,
      isMasterOwner: masterOwner,
      email: jsonSafe(profile?.email || mapping.email || email),
      profile: profile ? {
        id: profile.id,
        email: jsonSafe(profile.email),
        fullName: jsonSafe(profile.full_name),
        approvalStatus: jsonSafe(profile.approval_status),
      } : null,
      tenants,
      roles,
      privileged: isPrivilegedRoleList(roles) || masterOwner,
      privilegedAuth: privilegedAuthPolicy(),
      authorizationSource: 'user_roles_and_tenant_users',
      cognitoGroupsUsed: false,
    };
  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    }
    return {
      ok: false,
      statusCode: 503,
      error: 'identity_resolve_failed',
      message: sanitizePublicError(error),
    };
  } finally {
    if (client) {
      try { await client.end(); } catch { /* ignore */ }
    }
  }
};

export const handleIdentityMe = async (event) => {
  let claims = cognitoClaimsFromEvent(event);
  if (!claims?.sub) {
    const token = bearerToken(event);
    if (!token) {
      return { ok: false, statusCode: 401, error: 'missing_cognito_token' };
    }
    try {
      claims = await verifyCognitoIdToken(token);
    } catch (error) {
      return {
        ok: false,
        statusCode: 401,
        error: 'invalid_cognito_token',
        message: String(error?.message || error).slice(0, 200),
      };
    }
  }
  return resolveIdentitySession({
    cognitoSub: claims.sub,
    email: claims.email,
  });
};
