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

/** Live trigger identity_protect_production_cognito_locks requires this GUC. */
export const PRODUCTION_IDENTITY_WRITE_GUC = 'request.production_identity_write';

export const SELECT_PRODUCTION_LOCK_BY_SUB_SQL = `SELECT application_user_id::text AS application_user_id,
       cognito_sub
FROM public.identity_production_cognito_locks
WHERE cognito_sub = $1
LIMIT 1`;

export const SELECT_PRODUCTION_LOCK_BY_USER_SQL = `SELECT application_user_id::text AS application_user_id,
       cognito_sub
FROM public.identity_production_cognito_locks
WHERE application_user_id = $1::uuid
LIMIT 1`;

export const INSERT_PRODUCTION_LOCK_SQL = `INSERT INTO public.identity_production_cognito_locks (application_user_id, cognito_sub)
VALUES ($1::uuid, $2)`;

/**
 * Provision the production Cognito lock using the existing write contract
 * (SET LOCAL request.production_identity_write=1, then INSERT).
 *
 * Login /identity/me must not call this. Staging identityEnv is a no-op.
 * Bind only the server-resolved Cognito sub + application user.
 */
export const bindProductionCognitoLock = async (client, {
  cognitoSub,
  applicationUserId,
  identityScope = resolveTrustedIdentityScope(),
} = {}) => {
  if (!identityScope?.ok) {
    return { ok: false, error: identityScope?.error || 'identity_env_unconfigured', writesAttempted: false };
  }
  if (identityScope.identityEnv !== IDENTITY_ENV_PRODUCTION) {
    return {
      ok: true,
      bound: false,
      skipped: true,
      reason: 'staging_identity_env',
      writesAttempted: false,
    };
  }

  const sub = String(cognitoSub || '').trim();
  const userId = String(applicationUserId || '').trim();
  if (!sub || !userId) {
    return { ok: false, error: 'identity_lock_missing_binding', writesAttempted: false };
  }
  if (sub === userId) {
    return { ok: false, error: 'unsafe_or_missing_cognito_sub', writesAttempted: false };
  }

  const bySub = (await client.query(SELECT_PRODUCTION_LOCK_BY_SUB_SQL, [sub])).rows[0] || null;
  const byUser = (await client.query(SELECT_PRODUCTION_LOCK_BY_USER_SQL, [userId])).rows[0] || null;

  if (bySub && String(bySub.application_user_id) !== userId) {
    return { ok: false, error: 'identity_lock_conflict', writesAttempted: false };
  }
  if (byUser && String(byUser.cognito_sub) !== sub) {
    return { ok: false, error: 'identity_lock_conflict', writesAttempted: false };
  }
  if (bySub && byUser) {
    return {
      ok: true,
      bound: true,
      idempotent: true,
      applicationUserId: userId,
      cognitoSub: sub,
      writesAttempted: false,
    };
  }

  await client.query('SELECT set_config($1, $2, true)', [PRODUCTION_IDENTITY_WRITE_GUC, '1']);
  try {
    await client.query(INSERT_PRODUCTION_LOCK_SQL, [userId, sub]);
  } catch (error) {
    return {
      ok: false,
      error: 'identity_lock_failed',
      message: String(error.message || error).slice(0, 240),
      writesAttempted: true,
    };
  }
  return {
    ok: true,
    bound: true,
    idempotent: false,
    applicationUserId: userId,
    cognitoSub: sub,
    writesAttempted: true,
  };
};
