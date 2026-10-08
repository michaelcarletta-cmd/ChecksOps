/**
 * Staging least-privilege gate for GET /db-readonly-validate details.
 * Public redaction is unchanged. Production authenticated behavior is unchanged.
 * Staging details require a Cognito identity whose application user_roles include admin.
 * Identity lookup failures fail closed; no identity errors or validation details leak.
 */

export const isDbValidatorAdmin = (roles = []) => (Array.isArray(roles) ? roles : [])
  .map((role) => String(role || '').toLowerCase())
  .includes('admin');

export const authorizeDbValidatorDetails = async ({
  env = process.env.CHECKSOPS_ENV,
  auth,
  resolveIdentity,
} = {}) => {
  if (!auth?.ok) {
    return { ok: false, reason: 'unauthenticated' };
  }
  if (String(env || '').toLowerCase() === 'production') {
    return { ok: true, reason: 'production_authenticated' };
  }
  const claims = auth.claims || {};
  if (!claims.sub) {
    return { ok: false, reason: 'missing_sub', statusCode: 403 };
  }
  if (typeof resolveIdentity !== 'function') {
    return { ok: false, reason: 'identity_lookup_failed', statusCode: 403 };
  }
  let identity;
  try {
    identity = await resolveIdentity({
      cognitoSub: claims.sub,
      email: claims.email || null,
      claims,
    });
  } catch {
    return { ok: false, reason: 'identity_lookup_failed', statusCode: 403 };
  }
  if (!identity?.ok) {
    return { ok: false, reason: 'identity_unresolved', statusCode: 403 };
  }
  if (!isDbValidatorAdmin(identity.roles)) {
    return { ok: false, reason: 'not_admin', statusCode: 403 };
  }
  return { ok: true, reason: 'staging_admin' };
};

export const dbValidatorHttpResponse = ({ access, validation, publicResponse, details }) => {
  if (!access?.ok) {
    if (access?.statusCode === 403) {
      return { statusCode: 403, body: { error: 'not_authorized' } };
    }
    return publicResponse(validation);
  }
  return details(validation);
};
