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
  RECEIPT_REUSED: 'RECEIPT_REUSED',
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

/**
 * SQL 84, SQL 86, SQL 87 and SQL 88 guard RAISE texts name check ids, role names and objects. Recorded
 * results (production apply, staging executor) carry these fixed messages
 * instead; the operator's --inspect / read-live is where to look for details.
 */
export const FIXED_SQL_GUARD_MESSAGES = Object.freeze([
  Object.freeze(['duplicate_mortgage_ops_billing_events', 'duplicate_mortgage_ops_billing_events: resolve duplicate Mortgage Ops billing events before SQL 84; run --inspect for details']),
  Object.freeze(['earn_owner_unsafe', 'earn_owner_unsafe: the earn function and trigger owners are not safe for SQL 86; run --inspect for details']),
  Object.freeze(['case_owner_unsafe', 'case_owner_unsafe: the case helper and trigger function owners are not safe for SQL 87; run --inspect for details']),
  Object.freeze(['case_callers_unsafe', 'case_callers_unsafe: other objects call resolve_check_case; run --inspect for details']),
  Object.freeze(['claim_case_owner_unsafe', 'claim_case_owner_unsafe: the case trigger and helper function owners are not safe for SQL 88; run --inspect for details']),
  Object.freeze(['claim_case_callers_unsafe', 'claim_case_callers_unsafe: other objects use tg_claim_id_assign_case; run --inspect for details']),
]);

/** The fixed message for a SQL 84/86/87/88 guard error, else the message truncated to `limit`. */
export function sqlGuardErrorMessage(error, limit = 300) {
  const message = String(error?.message || error);
  const fixed = FIXED_SQL_GUARD_MESSAGES.find(([prefix]) => message.startsWith(prefix));
  return fixed ? fixed[1] : message.slice(0, limit);
}
