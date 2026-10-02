import { CLAIM_MARKER_PREFIX } from './constants.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const isUuid = (value) => UUID_RE.test(String(value || ''));

export const validateExactIdAllowlist = (allowlist = {}) => {
  const errors = [];
  const normalized = {};
  for (const [table, ids] of Object.entries(allowlist)) {
    if (!Array.isArray(ids)) {
      errors.push(`${table}: ids must be an array`);
      continue;
    }
    const exact = [];
    for (const id of ids) {
      if (!isUuid(id)) errors.push(`${table}: not an exact uuid: ${id}`);
      else exact.push(id);
    }
    normalized[table] = exact;
  }
  return { ok: errors.length === 0, errors, allowlist: normalized };
};

export const refuseBroadCleanup = (spec = {}) => {
  const errors = [];
  const blob = JSON.stringify(spec);
  if (/%/.test(blob) || /like/i.test(blob) || /\*/.test(blob)) {
    errors.push('wildcard_or_like_cleanup_forbidden');
  }
  if (spec.dateRange || spec.since || spec.before) {
    errors.push('date_range_cleanup_forbidden');
  }
  if (spec.tenantWide === true) {
    errors.push('tenant_wide_cleanup_forbidden');
  }
  if (spec.claimNumberPrefix && spec.claimNumberPrefix !== CLAIM_MARKER_PREFIX) {
    errors.push('prefix_cleanup_forbidden');
  }
  if (spec.deleteByPrefix || spec.deleteByMarker) {
    errors.push('prefix_cleanup_forbidden');
  }
  return { ok: errors.length === 0, errors };
};

export const cleanupPlan = (allowlist = {}) => ({
  order: [
    'check_billing_events',
    'check_messages',
    'check_audit_log',
    'mortgage_handling_requests',
    'check_intake_items',
    'claims',
  ],
  predicate: 'DELETE FROM <table> WHERE id = ANY($1::uuid[]) using only this run allowlist',
  allowlist,
  forbidden: [
    'LIKE / prefix / SYNTHETIC-MDE2E-%',
    'date-range deletes',
    'tenant-wide deletes',
    'table-wide deletes',
    'CASCADE targeting pre-existing parents',
  ],
});
