/**
 * Explicit Cognito sub → application_user_id linking.
 * Never matches by email as the identity key. Never stores sub as the UUID.
 */
import { refuseSubAsApplicationId } from './cognito.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const LINK_BY_SUB_SQL = `SELECT application_user_id::text AS application_user_id,
       cognito_sub, email, status
FROM public.identity_accounts
WHERE cognito_sub = $1`;

export const LINK_BY_APP_SQL = `SELECT application_user_id::text AS application_user_id,
       cognito_sub, email, status
FROM public.identity_accounts
WHERE application_user_id = $1::uuid`;

export const UPSERT_BY_APP_SQL = `INSERT INTO public.identity_accounts (
  application_user_id, cognito_sub, email, status, linked_at, created_at
) VALUES ($1::uuid, $2, $3, 'active', now(), now())
ON CONFLICT (application_user_id) DO UPDATE
  SET cognito_sub = EXCLUDED.cognito_sub,
      email = COALESCE(EXCLUDED.email, public.identity_accounts.email),
      status = 'active',
      linked_at = now()`;

const isUuid = (value) => UUID_RE.test(String(value || ''));

export const validateExplicitLink = ({
  applicationUserId,
  cognitoSub,
  email = null,
} = {}) => {
  if (!isUuid(applicationUserId)) {
    return { ok: false, error: 'invalid_application_user_id' };
  }
  if (!cognitoSub || typeof cognitoSub !== 'string' || cognitoSub.length < 8) {
    return { ok: false, error: 'invalid_cognito_sub' };
  }
  try {
    refuseSubAsApplicationId(applicationUserId, cognitoSub);
  } catch {
    return { ok: false, error: 'cognito_sub_must_not_equal_application_user_id' };
  }
  return {
    ok: true,
    applicationUserId: String(applicationUserId),
    cognitoSub: String(cognitoSub),
    email: email ? String(email).trim().toLowerCase() : null,
  };
};

/**
 * Durable link. application_user_id is required (existing ChecksOps UUID).
 * cognito_sub is the live Cognito identifier. Email is stored for display only.
 */
export const linkIdentityAccount = async (client, input = {}) => {
  const parsed = validateExplicitLink(input);
  if (!parsed.ok) return parsed;

  const bySub = (await client.query(LINK_BY_SUB_SQL, [parsed.cognitoSub])).rows[0] || null;
  if (bySub && bySub.application_user_id !== parsed.applicationUserId) {
    if (bySub.status === 'isolated_test') {
      await client.query(
        `UPDATE public.identity_accounts
         SET cognito_sub = NULL, status = 'pending', linked_at = NULL
         WHERE application_user_id = $1::uuid`,
        [bySub.application_user_id],
      );
    } else {
      return {
        ok: false,
        error: 'cognito_sub_already_linked',
        existingApplicationUserId: bySub.application_user_id,
      };
    }
  }

  const exists = (await client.query(
    `SELECT 1 FROM public.profiles WHERE id = $1::uuid
     UNION ALL
     SELECT 1 FROM public.user_roles WHERE user_id = $1::uuid
     UNION ALL
     SELECT 1 FROM public.tenant_users WHERE user_id = $1::uuid
     LIMIT 1`,
    [parsed.applicationUserId],
  )).rows[0];
  if (!exists && input.allowCreate !== true) {
    return { ok: false, error: 'application_user_not_found' };
  }

  await client.query(UPSERT_BY_APP_SQL, [
    parsed.applicationUserId,
    parsed.cognitoSub,
    parsed.email,
  ]);

  const linked = (await client.query(LINK_BY_APP_SQL, [parsed.applicationUserId])).rows[0];
  return {
    ok: true,
    applicationUserId: linked.application_user_id,
    cognitoSub: linked.cognito_sub,
    email: linked.email,
    status: linked.status,
  };
};
