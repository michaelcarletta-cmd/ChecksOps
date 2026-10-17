/**
 * Source contract for GET /db-readonly-validate details.
 * Matches aws/functions/api/index.mjs and db-validator-access.mjs.
 * Does not deploy or connect to AWS/DB.
 *
 * Staging details require Cognito resolveClaims plus application user_roles
 * admin. Unauthenticated callers stay on the public redaction path.
 * Authenticated non-admins get 403 {error:not_authorized}. Production
 * authenticated callers stay resolveClaims-only. The gate is source-only
 * until a separately approved staging Lambda overlay.
 */

import {
  authorizeDbValidatorDetails,
  dbValidatorHttpResponse,
} from '../../../aws/functions/api/db-validator-access.mjs';

export const DB_VALIDATOR_ROUTE = '/db-readonly-validate';
export const DB_VALIDATOR_UI_PATH = '/admin/db-validator';
export const DB_VALIDATOR_STAGING_HOSTNAME = 'staging.checksops.com';
export const DB_VALIDATOR_STAGING_ORIGIN = 'https://staging.checksops.com';
export const DB_VALIDATOR_STAGING_API = 'https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging';
export const PUBLIC_DB_VALIDATOR_FIELDS = Object.freeze(['service', 'status', 'readOnly']);
export const FORBIDDEN_DETAIL_FIELDS = Object.freeze(['issues', 'tables', 'catalog', 'currentUser', 'message']);

export function detailedDbValidationAuthorized(access) {
  return Boolean(access && access.ok === true);
}

export function selectDbValidationResponse(validation, access, publicDbValidationResponse) {
  return dbValidatorHttpResponse({
    access,
    validation,
    publicResponse: publicDbValidationResponse,
    details: (result) => ({
      statusCode: result?.ok ? 200 : 503,
      body: {
        service: 'checksops-api',
        environment: result?.environment || 'unknown',
        productionSupabaseChanged: false,
        ...result,
      },
    }),
  });
}

export function publicBodyIsRedacted(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const keys = Object.keys(body);
  if (keys.some((key) => !PUBLIC_DB_VALIDATOR_FIELDS.includes(key))) return false;
  return body.service === 'checksops-api'
    && (body.status === 'ok' || body.status === 'unhealthy')
    && body.readOnly === true;
}

export function forbiddenDetailsAbsent(body) {
  if (!body || typeof body !== 'object') return false;
  return FORBIDDEN_DETAIL_FIELDS.every((key) => !Object.hasOwn(body, key));
}

export function extractDbValidatorHandler(source) {
  const text = String(source || '');
  const named = text.match(/export const handleDbReadonlyValidateRequest[\s\S]*?\n\};/);
  if (named) return named[0];
  const route = text.match(/if \(method === 'GET' && path === '\/db-readonly-validate'\) \{[\s\S]*?\n  \}/);
  return route ? route[0] : '';
}

export function handlerEnforcesCognitoDetailsGate(source) {
  const text = String(source || '');
  const block = extractDbValidatorHandler(text);
  return Boolean(block)
    && text.includes('handleDbReadonlyValidateRequest')
    && block.includes('resolveAuth')
    && block.includes('authorizeDetails')
    && block.includes('dbValidatorHttpResponse');
}

export function handlerUsesAppAdminRole(source, accessSource = '') {
  const combined = `${source}\n${accessSource}`;
  return combined.includes('authorizeDbValidatorDetails')
    && /user_roles|isDbValidatorAdmin/.test(combined);
}

export { authorizeDbValidatorDetails, dbValidatorHttpResponse };
