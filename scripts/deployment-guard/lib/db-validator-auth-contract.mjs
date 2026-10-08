/**
 * Source contract for GET /db-readonly-validate details.
 * Matches aws/functions/api/index.mjs. Does not deploy or connect to AWS/DB.
 *
 * UI admin (`user_roles.admin`) is enforced in the staging page only.
 * The API authorizes detailed results with Cognito claims (`resolveClaims`).
 * An application-role check is intentionally not required here: the existing
 * staging DB diagnostic workflow authenticates with a Cognito ID token and
 * changing that contract needs a reviewed Lambda overlay, not this SPA plan.
 */

export const DB_VALIDATOR_ROUTE = '/db-readonly-validate';
export const DB_VALIDATOR_UI_PATH = '/admin/db-validator';
export const DB_VALIDATOR_STAGING_HOSTNAME = 'staging.checksops.com';
export const DB_VALIDATOR_STAGING_ORIGIN = 'https://staging.checksops.com';
export const DB_VALIDATOR_STAGING_API = 'https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging';
export const PUBLIC_DB_VALIDATOR_FIELDS = Object.freeze(['service', 'status', 'readOnly']);

const HANDLER_BLOCK_RE = /if \(method === 'GET' && path === '\/db-readonly-validate'\) \{[\s\S]*?\n  \}/;

export function detailedDbValidationAuthorized(auth) {
  return Boolean(auth && auth.ok === true);
}

export function selectDbValidationResponse(validation, auth, publicDbValidationResponse) {
  if (!detailedDbValidationAuthorized(auth)) {
    return publicDbValidationResponse(validation);
  }
  return {
    statusCode: validation?.ok ? 200 : 503,
    body: {
      service: 'checksops-api',
      environment: validation?.environment || 'unknown',
      productionSupabaseChanged: false,
      ...validation,
    },
  };
}

export function publicBodyIsRedacted(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const keys = Object.keys(body);
  if (keys.some((key) => !PUBLIC_DB_VALIDATOR_FIELDS.includes(key))) return false;
  return body.service === 'checksops-api'
    && (body.status === 'ok' || body.status === 'unhealthy')
    && body.readOnly === true;
}

export function extractDbValidatorHandler(source) {
  const match = String(source || '').match(HANDLER_BLOCK_RE);
  return match ? match[0] : '';
}

export function handlerEnforcesCognitoDetailsGate(source) {
  const block = extractDbValidatorHandler(source);
  return Boolean(block)
    && block.includes('const auth = await resolveClaims(event)')
    && block.includes('if (!auth.ok)')
    && block.includes('publicDbValidationResponse(validation)')
    && /return json\(validation\.ok \? 200 : 503/.test(block);
}

export function handlerUsesAppAdminRole(source) {
  const block = extractDbValidatorHandler(source);
  return /has_role|isAdmin|user_roles|HAS_ADMIN|app_role/.test(block);
}
