import { CODES, fail, ok } from './errors.mjs';

export const SQL53_INSPECT_FUNCTION = 'checksops-production-prep-api';
export const SQL53_INSPECT_FUNCTION_ARN = 'arn:aws:lambda:us-east-1:806168576068:function:checksops-production-prep-api';
export const SQL53_INSPECT_AUTH_ENV = 'CHECKSOPS_SQL53_READONLY_INSPECT_AUTHORIZATION';
export const SQL53_INSPECT_EXPIRES_ENV = 'CHECKSOPS_SQL53_READONLY_INSPECT_EXPIRES_AT';
export const SQL53_INSPECT_DIAGNOSTIC = 'sql53-production-readonly-inspect';
export const SQL53_INSPECT_PUBLISHED_MARKER = 'OWNER_AUTHORIZED_PRODUCTION_SQL53_READONLY_INSPECT';
export const SQL53_INSPECT_MIN_TOKEN_LENGTH = 32;
export const SQL53_INSPECT_MAX_WINDOW_MS = 2 * 60 * 60 * 1000;
export const SQL53_INSPECT_TEMP_ENV_KEYS = Object.freeze([
  SQL53_INSPECT_AUTH_ENV,
  SQL53_INSPECT_EXPIRES_ENV,
]);
export const SQL53_INSPECT_IAM_ACTIONS = Object.freeze([
  'lambda:GetFunction',
  'lambda:GetFunctionConfiguration',
  'lambda:UpdateFunctionConfiguration',
  'lambda:InvokeFunction',
]);

export const SQL53_INSPECT_LIVE_PIN = Object.freeze({
  codeSha256: 'oQDCIRFyreTPe781aeSFLdXNfU3M2ZUQo5Wcgi0EqWI=',
  revisionId: '534d4e36-0e62-461e-948e-e2bf00d3920e',
  inspectSha256: '4e356350e4abdf58fdb6ba3ab4e62efbe1aa21f7720a49f1f0128860870edb68',
  patchedIndexSha256: '77836ef63e6fbca6fb3e49f5970e705cf38b2af653c1be2c4a728be04caf3a9f',
  secretsSha256: 'f8fa9ee63cb56bd0de49a746afbb18322c9376b0277aaf057a748f0c1ba0dba3',
});

function uniqueStrings(values, label) {
  if (!Array.isArray(values) || values.length === 0) {
    return fail(CODES.INVALID_MANIFEST, `${label} must be a non-empty array of environment variable names`);
  }
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const name = String(value || '').trim();
    if (!name) return fail(CODES.INVALID_MANIFEST, `${label} contains an empty name`);
    if (seen.has(name)) return fail(CODES.INVALID_MANIFEST, `${label} contains a duplicate name`, { name });
    seen.add(name);
    out.push(name);
  }
  return ok({ names: out });
}

export function validateInspectToken(token) {
  if (typeof token !== 'string' || token.length < SQL53_INSPECT_MIN_TOKEN_LENGTH) {
    return fail(CODES.INVALID_MANIFEST, 'authorization token must be a string of at least 32 characters');
  }
  if (token === SQL53_INSPECT_PUBLISHED_MARKER) {
    return fail(CODES.INVALID_MANIFEST, 'published diagnostic marker cannot be used as the authorization token');
  }
  return ok({ length: token.length });
}

export function validateInspectExpiry(expiresAt, now = Date.now()) {
  const expires = Date.parse(expiresAt);
  if (!Number.isFinite(expires)) {
    return fail(CODES.INVALID_MANIFEST, 'CHECKSOPS_SQL53_READONLY_INSPECT_EXPIRES_AT must be RFC 3339');
  }
  if (expires <= now) {
    return fail(CODES.INVALID_MANIFEST, 'inspect expiry is already in the past; recompute immediately before the later config write');
  }
  if (expires - now > SQL53_INSPECT_MAX_WINDOW_MS) {
    return fail(CODES.INVALID_MANIFEST, 'inspect expiry must be within two hours');
  }
  return ok({ expires_at: new Date(expires).toISOString(), window_ms: expires - now });
}

export function planPreservingEnvOverlay({
  existingKeys,
  existingValues = null,
  token,
  expiresAt,
  now = Date.now(),
} = {}) {
  const keys = uniqueStrings(existingKeys, 'existing environment keys');
  if (!keys.ok) return keys;
  for (const temp of SQL53_INSPECT_TEMP_ENV_KEYS) {
    if (keys.details.names.includes(temp)) {
      return fail(
        CODES.UNRELATED_MUTATION,
        'temporary SQL53 inspect env vars are already present; refuse a second overlay',
        { key: temp },
      );
    }
  }
  const tokenState = validateInspectToken(token);
  if (!tokenState.ok) return tokenState;
  const expiry = validateInspectExpiry(expiresAt, now);
  if (!expiry.ok) return expiry;
  if (existingValues && typeof existingValues === 'object') {
    const missing = keys.details.names.filter((name) => !Object.prototype.hasOwnProperty.call(existingValues, name));
    if (missing.length) {
      return fail(CODES.UNRELATED_MUTATION, 'existing environment values are incomplete; refuse overlay', {
        missing,
      });
    }
  }

  const added = [...SQL53_INSPECT_TEMP_ENV_KEYS];
  const preserved = [...keys.details.names];
  return ok({
    preserved_key_count: preserved.length,
    preserved_keys: preserved,
    added_keys: added,
    removed_keys: [],
    revision_id_cas_required: true,
    cleanup_restores_exact_existing_keys: true,
    note: 'UpdateFunctionConfiguration must send the full existing map plus the two temporary keys and RevisionId',
  });
}

export function planInspectIam({ functionArn = SQL53_INSPECT_FUNCTION_ARN } = {}) {
  if (functionArn !== SQL53_INSPECT_FUNCTION_ARN) {
    return fail(CODES.UNRELATED_MUTATION, 'inspect IAM may only target checksops-production-prep-api', {
      functionArn,
    });
  }
  return ok({
    resource: functionArn,
    actions: [...SQL53_INSPECT_IAM_ACTIONS],
    denied_broadening: [
      'ChecksOpsCursorCloudStaging must not be broadened',
      'no API Gateway invoke grant',
      'no other Lambda function ARN',
    ],
    policy: {
      Version: '2012-10-17',
      Statement: [{
        Sid: 'Sql53ProductionReadonlyInspectOnce',
        Effect: 'Allow',
        Action: [...SQL53_INSPECT_IAM_ACTIONS],
        Resource: functionArn,
      }],
    },
  });
}

export function planInspectInvoke({ token } = {}) {
  const tokenState = validateInspectToken(token);
  if (!tokenState.ok) return tokenState;
  return ok({
    function_name: SQL53_INSPECT_FUNCTION,
    payload: {
      diagnostic: SQL53_INSPECT_DIAGNOSTIC,
      authorization: token,
    },
    exact_keys: ['diagnostic', 'authorization'],
    http_forbidden: true,
  });
}

export function planInspectCleanup({ existingKeys } = {}) {
  const keys = uniqueStrings(existingKeys, 'existing environment keys');
  if (!keys.ok) return keys;
  return ok({
    unset_keys: [...SQL53_INSPECT_TEMP_ENV_KEYS],
    restore_keys: keys.details.names,
    restore_key_count: keys.details.names.length,
    revision_id_cas_required: true,
    remove_temporary_iam: true,
    note: 'cleanup must omit only the two temporary keys and keep every previously existing variable',
  });
}

export function evaluateSql53InspectPrepare(input = {}) {
  if (input.apply === true) {
    return fail(
      CODES.GUARD_APPLY_FORBIDDEN,
      'SQL53 inspect prepare is evaluate-only; it does not set credentials, change IAM, or invoke production',
    );
  }
  if (input.function_name && input.function_name !== SQL53_INSPECT_FUNCTION) {
    return fail(CODES.UNRELATED_MUTATION, 'inspect prepare may only target checksops-production-prep-api');
  }
  const existingKeys = input.existingKeys || input.live?.environment_keys;
  const envPlan = planPreservingEnvOverlay({
    ...input,
    existingKeys,
  });
  if (!envPlan.ok) return envPlan;
  const iam = planInspectIam({ functionArn: input.function_arn || SQL53_INSPECT_FUNCTION_ARN });
  if (!iam.ok) return iam;
  const invoke = planInspectInvoke({ token: input.token });
  if (!invoke.ok) return invoke;
  const cleanup = planInspectCleanup({ existingKeys });
  if (!cleanup.ok) return cleanup;
  return ok({
    prepare_allowed: true,
    apply: false,
    execute_authorized: false,
    live_pin: SQL53_INSPECT_LIVE_PIN,
    env: envPlan.details,
    iam: iam.details,
    invoke: {
      function_name: invoke.details.function_name,
      exact_keys: invoke.details.exact_keys,
      http_forbidden: true,
    },
    cleanup: cleanup.details,
    blockers: [
      'No official guarded Lambda configuration writer exists; the live AWS adapter refuses configuration mutation',
      'ChecksOpsCursorCloudStaging must not be broadened for invoke or configuration updates',
      'Later owner authorization is required before the temporary configuration, IAM, and one-time invoke',
    ],
  });
}
