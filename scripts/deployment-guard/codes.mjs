/**
 * Fail-closed deployment-guard result codes.
 * These strings are part of the operator contract. Do not rename lightly.
 */
export const CODES = Object.freeze({
  OK: 'OK',
  ANONYMOUS_DEPLOYMENT: 'ANONYMOUS_DEPLOYMENT',
  DEPLOYMENT_COLLISION: 'DEPLOYMENT_COLLISION',
  SOURCE_RECONCILIATION_REQUIRED: 'SOURCE_RECONCILIATION_REQUIRED',
  SOURCE_COMPOSITION_REQUIRED: 'SOURCE_COMPOSITION_REQUIRED',
  SQL_COLLISION: 'SQL_COLLISION',
  REGRESSION_DETECTED: 'REGRESSION_DETECTED',
  STALE_PACKAGE_REJECTED: 'STALE_PACKAGE_REJECTED',
  LEASE_HELD: 'LEASE_HELD',
  LEASE_EXPIRED: 'LEASE_EXPIRED',
  PRODUCTION_APPROVAL_REQUIRED: 'PRODUCTION_APPROVAL_REQUIRED',
  AWS_DISABLED: 'AWS_DISABLED',
  AWS_WRITE_FORBIDDEN: 'AWS_WRITE_FORBIDDEN',
  GUARD_NOT_CLEARED: 'GUARD_NOT_CLEARED',
  INVALID_MANIFEST: 'INVALID_MANIFEST',
  INVALID_TARGET: 'INVALID_TARGET',
  UNDECLARED_MEMBER: 'UNDECLARED_MEMBER',
});

export const STOP_CODES = Object.freeze(Object.values(CODES).filter((code) => code !== CODES.OK));

export function fail(code, message, extra = {}) {
  return {
    ok: false,
    code,
    message,
    stop: true,
    ...extra,
  };
}

export function ok(extra = {}) {
  return {
    ok: true,
    code: CODES.OK,
    stop: false,
    ...extra,
  };
}
