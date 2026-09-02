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
import { LOOKUP_MAPPING_SQL, USER_ROLES_SQL } from './identity.mjs';

const { Client } = pg;

export const FREEDOM_TENANT_ID = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
export const C1C_TENANT_ID = '4f172140-f57a-4744-8050-95f4f07b13b4';

export const PROBE_ITEMS_SQL = `SELECT label, tenant_id::text AS tenant_id
FROM public._aws_rls_probe_items
ORDER BY label`;

export const AUTH_UID_SQL = 'SELECT auth.uid()::text AS auth_uid';
export const TENANT_IDS_SQL = 'SELECT public.aws_user_tenant_ids()::text AS tenant_id';
export const HAS_STAFF_SQL = `SELECT public.has_role(auth.uid(), 'staff'::public.app_role) AS has_staff,
       public.has_role(auth.uid(), 'admin'::public.app_role) AS has_admin`;

export const ignoredSpoofFields = (event) => {
  const headers = event?.headers || {};
  const lower = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [String(key).toLowerCase(), value]),
  );
  let body = null;
  if (event?.body) {
    try {
      body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    } catch {
      body = null;
    }
  }
  const bodyObj = body && typeof body === 'object' ? body : {};
  return {
    ignored: true,
    queryUserId: event?.queryStringParameters?.user_id
      || event?.queryStringParameters?.applicationUserId
      || event?.queryStringParameters?.sub
      || null,
    queryTenantId: event?.queryStringParameters?.tenant_id
      || event?.queryStringParameters?.tenantId
      || null,
    headerUserId: lower['x-user-id'] || lower['x-application-user-id'] || null,
    headerTenantId: lower['x-tenant-id'] || null,
    headerCognitoSub: lower['x-cognito-sub'] || null,
    bodyUserId: bodyObj.user_id || bodyObj.applicationUserId || bodyObj.sub || null,
    bodyTenantId: bodyObj.tenant_id || bodyObj.tenantId || null,
  };
};

export const resolveCognitoClaims = async (event) => {
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
  return { ok: true, claims };
};

export const runAuthorizationProbe = async ({
  cognitoSub,
  cognitoEmail = null,
  spoof = null,
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

    const appEmail = mapping.email || cognitoEmail || '';
    await client.query('SELECT set_config($1, $2, true)', [APP_USER_ID_GUC, mapping.application_user_id]);
    await client.query('SELECT set_config($1, $2, true)', [APP_USER_EMAIL_GUC, appEmail]);

    const uid = (await client.query(AUTH_UID_SQL)).rows[0]?.auth_uid;
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

    const visible = (await client.query(PROBE_ITEMS_SQL)).rows;
    const tenantIds = (await client.query(TENANT_IDS_SQL)).rows.map((row) => row.tenant_id);
    const roles = (await client.query(USER_ROLES_SQL, [mapping.application_user_id])).rows.map((row) => row.role);
    const roleFlags = (await client.query(HAS_STAFF_SQL)).rows[0] || {};

    await client.query('ROLLBACK');

    const labels = visible.map((row) => row.label);
    return {
      ok: true,
      statusCode: 200,
      cognitoSub,
      applicationUserId: mapping.application_user_id,
      authUid: uid,
      mappingStatus: mapping.status,
      roles,
      roleFlags: {
        hasStaff: Boolean(roleFlags.has_staff),
        hasAdmin: Boolean(roleFlags.has_admin),
      },
      tenantIds,
      visibleProbeLabels: labels,
      visibleProbeItems: visible,
      isolation: {
        canReadFreedomProbe: labels.includes('freedom-probe-visible'),
        canReadC1cProbe: labels.includes('c1c-probe-hidden'),
        canReadBarzziniProbe: labels.includes('barzzini-probe-hidden'),
      },
      authorizationSource: 'user_roles_and_tenant_users',
      cognitoGroupsUsed: false,
      sessionIdentitySource: 'identity_accounts.application_user_id',
      spoofFieldsIgnored: spoof,
      writes: 'disabled',
    };
  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    }
    return {
      ok: false,
      statusCode: 503,
      error: 'authorization_probe_failed',
      message: sanitizePublicError(error),
    };
  } finally {
    if (client) {
      try { await client.end(); } catch { /* ignore */ }
    }
  }
};

export const handleAuthorizationProbe = async (event) => {
  const claimsResult = await resolveCognitoClaims(event);
  if (!claimsResult.ok) return claimsResult;
  return runAuthorizationProbe({
    cognitoSub: claimsResult.claims.sub,
    cognitoEmail: claimsResult.claims.email,
    spoof: ignoredSpoofFields(event),
  });
};
