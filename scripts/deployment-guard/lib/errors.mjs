export const CODES = Object.freeze({
  ANONYMOUS_DEPLOYMENT: 'ANONYMOUS_DEPLOYMENT',
  DEPLOYMENT_COLLISION: 'DEPLOYMENT_COLLISION',
  SOURCE_RECONCILIATION_REQUIRED: 'SOURCE_RECONCILIATION_REQUIRED',
  SOURCE_COMPOSITION_REQUIRED: 'SOURCE_COMPOSITION_REQUIRED',
  STALE_PACKAGE: 'STALE_PACKAGE',
  SQL_COLLISION: 'SQL_COLLISION',
  REGRESSION_DETECTED: 'REGRESSION_DETECTED',
  LEASE_HELD: 'LEASE_HELD',
  LEASE_EXPIRED: 'LEASE_EXPIRED',
  PRODUCTION_APPROVAL_REQUIRED: 'PRODUCTION_APPROVAL_REQUIRED',
  GUARD_NO_AWS: 'GUARD_NO_AWS',
  GUARD_APPLY_FORBIDDEN: 'GUARD_APPLY_FORBIDDEN',
  INVALID_MANIFEST: 'INVALID_MANIFEST',
  UNRELATED_MUTATION: 'UNRELATED_MUTATION',
  DEPLOYMENT_GUARD_REQUIRED: 'DEPLOYMENT_GUARD_REQUIRED',
  RECEIPT_MISMATCH: 'RECEIPT_MISMATCH',
  RECEIPT_EXPIRED: 'RECEIPT_EXPIRED',
  RECEIPT_FORGED: 'RECEIPT_FORGED',
  PRODUCTION_DRIFT_RECOMPOSITION_REQUIRED: 'PRODUCTION_DRIFT_RECOMPOSITION_REQUIRED',
  PROTECTED_COMPOSITION_REQUIRED: 'PROTECTED_COMPOSITION_REQUIRED',
});

export class GuardError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'GuardError';
    this.code = code;
    this.details = details;
  }
}

export function fail(code, message, details = {}) {
  return {
    ok: false,
    code,
    message,
    details,
    errors: [{ code, message, details }],
  };
}

export function failMany(errors, fallbackCode = CODES.INVALID_MANIFEST) {
  if (!errors.length) {
    return { ok: true, code: null, message: null, details: {}, errors: [] };
  }
  return {
    ok: false,
    code: errors[0].code || fallbackCode,
    message: errors[0].message,
    details: errors[0].details || {},
    errors,
  };
}

export function ok(details = {}) {
  return {
    ok: true,
    code: null,
    message: null,
    details,
    errors: [],
  };
}

export function errorEntry(code, message, details = {}) {
  return { code, message, details };
}
