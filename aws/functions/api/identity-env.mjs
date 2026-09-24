export const STAGING_COGNITO_USER_POOL_ID = 'us-east-1_vPmQ7cL1F';
export const PRODUCTION_COGNITO_USER_POOL_ID = 'us-east-1_h00WorYMT';

export const IDENTITY_ENV_STAGING = 'staging';
export const IDENTITY_ENV_PRODUCTION = 'production';

export const STAGING_IDENTITY_SOURCE = 'identity_accounts';
export const PRODUCTION_IDENTITY_SOURCE = 'identity_production_cognito_locks';

export const LOOKUP_MAPPING_SQL = `SELECT application_user_id::text AS application_user_id,
       cognito_sub,
       email,
       status
FROM public.identity_accounts
WHERE cognito_sub = $1
  AND status IN ('active', 'isolated_test')`;

export const LOOKUP_PRODUCTION_IDENTITY_SQL = `SELECT lock.application_user_id::text AS application_user_id,
       lock.cognito_sub,
       account.email,
       COALESCE(account.status, 'active') AS status
FROM public.identity_production_cognito_locks lock
LEFT JOIN public.identity_accounts account
  ON account.application_user_id = lock.application_user_id
WHERE lock.cognito_sub = $1`;

const cognitoIssuer = (poolId) => `https://cognito-idp.us-east-1.amazonaws.com/${poolId}`;

export const expectedPoolIdForIdentityEnv = (identityEnv) => (
  identityEnv === IDENTITY_ENV_STAGING
    ? STAGING_COGNITO_USER_POOL_ID
    : identityEnv === IDENTITY_ENV_PRODUCTION
      ? PRODUCTION_COGNITO_USER_POOL_ID
      : null
);

export const identityLookupSql = (identityEnv) => {
  if (identityEnv === IDENTITY_ENV_STAGING) return LOOKUP_MAPPING_SQL;
  if (identityEnv === IDENTITY_ENV_PRODUCTION) return LOOKUP_PRODUCTION_IDENTITY_SQL;
  return null;
};

const normalizeEnvName = (value) => String(value || '').trim().toLowerCase();

export const identityEnvFromChecksopsEnv = (checksopsEnv) => {
  const raw = normalizeEnvName(checksopsEnv);
  if (raw === 'staging') return IDENTITY_ENV_STAGING;
  if (raw === 'production' || raw === 'production-prep') return IDENTITY_ENV_PRODUCTION;
  return null;
};

export const resolveTrustedIdentityScope = ({
  checksopsEnv = process.env.CHECKSOPS_ENV,
  userPoolId = process.env.COGNITO_USER_POOL_ID,
} = {}) => {
  const rawEnv = normalizeEnvName(checksopsEnv);
  const poolId = String(userPoolId || '').trim();

  let identityEnv = identityEnvFromChecksopsEnv(rawEnv);
  if (!identityEnv) {
    if (rawEnv) {
      return { ok: false, error: 'identity_env_unknown' };
    }
    if (!poolId || poolId === STAGING_COGNITO_USER_POOL_ID) {
      identityEnv = IDENTITY_ENV_STAGING;
    } else if (poolId === PRODUCTION_COGNITO_USER_POOL_ID) {
      identityEnv = IDENTITY_ENV_PRODUCTION;
    } else {
      return { ok: false, error: 'identity_env_unconfigured' };
    }
  }

  const expectedPoolId = expectedPoolIdForIdentityEnv(identityEnv);
  if (poolId && poolId !== expectedPoolId) {
    return { ok: false, error: 'identity_pool_mismatch' };
  }

  const resolvedPoolId = poolId || expectedPoolId;
  return {
    ok: true,
    identityEnv,
    checksopsEnv: rawEnv || identityEnv,
    userPoolId: resolvedPoolId,
    issuer: cognitoIssuer(resolvedPoolId),
    mappingSource: identityEnv === IDENTITY_ENV_STAGING
      ? STAGING_IDENTITY_SOURCE
      : PRODUCTION_IDENTITY_SOURCE,
  };
};

export const rejectUntrustedIdentityHints = (event) => {
  const headers = event?.headers || {};
  const lower = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [String(key).toLowerCase(), value]),
  );
  const query = event?.queryStringParameters || {};
  const hinted = lower['x-checksops-env']
    || lower['x-cognito-user-pool-id']
    || query.checksopsEnv
    || query.environment
    || query.userPoolId
    || query.poolId
    || null;
  return hinted ? { ignored: true, hint: String(hinted).slice(0, 80) } : { ignored: true, hint: null };
};

export const assertTrustedIssuer = (claims, scope) => {
  if (!scope?.ok) return { ok: false, error: scope?.error || 'identity_env_unconfigured' };
  const issuer = claims?.iss ? String(claims.iss) : null;
  if (!issuer) return { ok: true };
  if (issuer !== scope.issuer) {
    return { ok: false, error: 'identity_issuer_mismatch' };
  }
  return { ok: true };
};

export const lookupIdentityMapping = async (client, cognitoSub, scope = resolveTrustedIdentityScope()) => {
  if (!scope?.ok) {
    return { mapping: null, source: null, error: scope?.error || 'identity_env_unconfigured', writesAttempted: false };
  }
  if (!cognitoSub) {
    return { mapping: null, source: scope.mappingSource, error: 'missing_cognito_sub', writesAttempted: false };
  }
  const sql = identityLookupSql(scope.identityEnv);
  if (!sql) {
    return { mapping: null, source: null, error: 'identity_env_unknown', writesAttempted: false };
  }
  const mapping = (await client.query(sql, [cognitoSub])).rows[0] || null;
  return {
    mapping,
    source: scope.mappingSource,
    identityEnv: scope.identityEnv,
    error: mapping ? null : 'identity_not_linked',
    writesAttempted: false,
  };
};

export const PRODUCTION_IDENTITY_WRITE_GUC = 'request.production_identity_write';

export const PRODUCTION_COGNITO_LOCK_INSERT_SQL = `INSERT INTO public.identity_production_cognito_locks (application_user_id, cognito_sub)
VALUES ($1::uuid, $2)
ON CONFLICT DO NOTHING`;

export const PRODUCTION_COGNITO_LOCK_LOOKUP_SQL = `SELECT application_user_id::text AS application_user_id,
       cognito_sub
FROM public.identity_production_cognito_locks
WHERE application_user_id = $1::uuid
   OR cognito_sub = $2`;

/**
 * Bind the authoritative production Cognito sub to an existing application user.
 *
 * - Runs only when resolveTrustedIdentityScope() selects the production identity env.
 * - Uses SET LOCAL request.production_identity_write=1 to satisfy the lock table trigger.
 * - Idempotent for the same application_user_id + cognito_sub pair.
 * - Fails closed on conflicting bindings (either side).
 */
export const bindProductionCognitoLock = async (
  client,
  applicationUserId,
  cognitoSub,
  scope = resolveTrustedIdentityScope(),
) => {
  if (!scope?.ok) {
    const error = new Error(scope?.error || 'identity_env_unconfigured');
    error.name = 'IdentityEnvUnconfigured';
    error.publicError = scope?.error || 'identity_env_unconfigured';
    error.statusCode = 500;
    throw error;
  }

  if (scope.identityEnv !== IDENTITY_ENV_PRODUCTION) {
    return {
      ok: true,
      skipped: true,
      writesAttempted: false,
      identityEnv: scope.identityEnv,
    };
  }

  if (!applicationUserId || !cognitoSub) {
    const error = new Error('missing_application_user_or_cognito_sub');
    error.name = 'ProductionCognitoLockMissingFields';
    error.publicError = 'missing_application_user_or_cognito_sub';
    error.statusCode = 500;
    throw error;
  }

  await client.query(`SET LOCAL ${PRODUCTION_IDENTITY_WRITE_GUC}=1`);
  await client.query(PRODUCTION_COGNITO_LOCK_INSERT_SQL, [applicationUserId, cognitoSub]);
  const rows = (await client.query(PRODUCTION_COGNITO_LOCK_LOOKUP_SQL, [applicationUserId, cognitoSub])).rows || [];

  const byUser = rows.find((row) => String(row.application_user_id) === String(applicationUserId)) || null;
  const bySub = rows.find((row) => String(row.cognito_sub) === String(cognitoSub)) || null;

  const userMatches = byUser && String(byUser.cognito_sub) === String(cognitoSub);
  const subMatches = bySub && String(bySub.application_user_id) === String(applicationUserId);

  if (userMatches && subMatches) {
    return {
      ok: true,
      skipped: false,
      writesAttempted: true,
      identityEnv: scope.identityEnv,
      applicationUserId: String(applicationUserId),
      cognitoSub: String(cognitoSub),
      idempotent: rows.length > 0,
    };
  }

  if (byUser && String(byUser.cognito_sub) !== String(cognitoSub)) {
    const error = new Error('production_identity_lock_conflict_application_user');
    error.name = 'ProductionCognitoLockConflict';
    error.publicError = 'production_identity_lock_conflict';
    error.statusCode = 409;
    error.conflict = {
      kind: 'application_user_id',
      applicationUserId: String(applicationUserId),
      existingCognitoSub: String(byUser.cognito_sub),
      requestedCognitoSub: String(cognitoSub),
    };
    throw error;
  }

  if (bySub && String(bySub.application_user_id) !== String(applicationUserId)) {
    const error = new Error('production_identity_lock_conflict_cognito_sub');
    error.name = 'ProductionCognitoLockConflict';
    error.publicError = 'production_identity_lock_conflict';
    error.statusCode = 409;
    error.conflict = {
      kind: 'cognito_sub',
      cognitoSub: String(cognitoSub),
      existingApplicationUserId: String(bySub.application_user_id),
      requestedApplicationUserId: String(applicationUserId),
    };
    throw error;
  }

  const error = new Error('production_identity_lock_write_failed');
  error.name = 'ProductionCognitoLockWriteFailed';
  error.publicError = 'production_identity_lock_write_failed';
  error.statusCode = 500;
  throw error;
};
