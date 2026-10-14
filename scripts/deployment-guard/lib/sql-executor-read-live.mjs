/**
 * Read-live: one receipt-gated executor invoke with action 'inspect' that reads
 * the staging database state of a pinned migration and never writes.
 *
 * This module is not packed into the executor; the executor's own inspect path
 * (SELECT only, no BEGIN, no migration file, no one_use_id consumption) is
 * unchanged. Two independent bindings keep a read-live receipt from ever
 * authorizing an apply:
 *   1. the signed receipt fingerprint carries action 'inspect', and the official
 *      invoke script refuses any payload action other than the bound one;
 *   2. the authorization package carries READ_LIVE_EXPECTED_SENTINEL as its
 *      expected live definition, which no reviewed pin can equal, so the
 *      read-live-selectable pins (ledger, 71, 72, 76, 77, 78) refuse apply with it
 *      before connecting.
 *
 * Failures print only an error code and a fixed message: executor and driver
 * error text can carry hostnames, roles or database names.
 */
import { createHash } from 'node:crypto';
import { CODES, fail, ok } from './errors.mjs';

export const READ_LIVE_ACTION = 'inspect';
export const READ_LIVE_SENTINEL_TEXT = 'checksops staging sql executor read-live: inspect only, never an apply authorization';
export const READ_LIVE_EXPECTED_SENTINEL = createHash('sha256').update(READ_LIVE_SENTINEL_TEXT).digest('hex');

/**
 * Invoke-side binding. `receipt` is the validated, signed receipt; `payload` is
 * what would be sent to the executor.
 */
export function checkReceiptActionBinding(receipt = {}, payload = {}) {
  const bound = receipt?.preflight_live_fingerprint?.action;
  const action = String(payload.action || '');
  if (bound != null && bound !== action) {
    return fail(CODES.RECEIPT_MISMATCH, `receipt is bound to executor action ${bound}; refusing action ${action || '(none)'}`, {
      receipt_action: bound,
      requested_action: action || null,
    });
  }
  if (payload.expected_live_definition_sha256 === READ_LIVE_EXPECTED_SENTINEL && action !== READ_LIVE_ACTION) {
    return fail(CODES.RECEIPT_MISMATCH, 'a read-live authorization package may only invoke action inspect', {
      requested_action: action || null,
    });
  }
  return ok({ action, bound_action: bound ?? null });
}

const LABEL_RE = /^[a-z_]{1,32}$/;
const CODE_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const BOOLEAN_KEYS = Object.freeze([
  'table_present',
  'connect_function_present',
  'required_functions_present',
  'exists',
  'amount_update_granted',
  'table_level_update',
  'update_granted',
  'rls_enabled',
  'write_policy_present',
  'write_policy_as_expected',
  'grantee_bypasses_rls',
  'tenant_guard_ok',
  'rls_forced',
  'owner_is_executor',
  'select_policy_as_expected',
  'required_tables_present',
  'required_roles_present',
  'references_granted',
  'schema_create_granted',
  'prerequisites_ok',
  'share_key_present',
  'default_acl_as_expected',
]);
const COUNT_KEYS = Object.freeze(['other_policy_count', 'other_trigger_count', 'other_write_policy_count', 'default_acl_entry_count']);
// Hashes of pinned-object state (not secrets); shown so a reviewer can compare runs.
const SHA256_KEYS = Object.freeze(['default_acl_sha256']);
// Label maps: values must be short lowercase labels; keys are pinned object names.
const LABEL_MAP_KEYS = Object.freeze(['consent_state', 'member_policy_states', 'privilege_state']);

function labelsOnly(value) {
  if (typeof value === 'string') return LABEL_RE.test(value) ? value : 'unrecognized';
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'unrecognized';
  const out = {};
  for (const [key, inner] of Object.entries(value)) out[String(key).slice(0, 64)] = labelsOnly(inner);
  return out;
}

/**
 * Project the invoke result (sql-executor-invoke.mjs stdout) onto the
 * non-sensitive read-live fields. Never returns row data, SQL text, policy
 * predicates, or identities (workstream, operator, executor identity).
 */
export function readLiveSummary(invokeResult, { migration, pin } = {}) {
  const outer = invokeResult || {};
  const inner = outer.details || {};
  const receipt = inner.details?.receipt;
  if (outer.ok !== true || inner.ok !== true || !receipt || typeof receipt !== 'object') {
    const code = [inner.code, outer.code].find((value) => typeof value === 'string' && CODE_RE.test(value)) || CODES.DEPLOYMENT_COLLISION;
    return fail(code, `executor read-live invoke failed (${code}); see the executor logs for detail`);
  }
  // The result must be for the selected pin, so its hash cannot be copied into another pin.
  if (receipt.sql_file !== pin?.filename || receipt.commit !== pin?.commit) {
    return fail(CODES.UNRELATED_MUTATION, 'executor read-live result is not for the selected migration pin');
  }
  if (receipt.result !== READ_LIVE_ACTION) {
    return fail(CODES.UNRELATED_MUTATION, 'executor did not report a read-only inspect result', { result: String(receipt.result || '').slice(0, 32) });
  }
  const live = receipt.live_definition_sha256;
  if (live != null && !SHA256_RE.test(String(live))) {
    return fail(CODES.DEPLOYMENT_COLLISION, 'executor reported a malformed live definition hash');
  }
  if (receipt.before_hash !== receipt.after_hash) {
    return fail(CODES.UNRELATED_MUTATION, 'read-live before and after hashes differ');
  }
  const pinnedExpected = pin?.expected_live_definition_sha256 ?? null;
  const summary = {
    migration: migration || null,
    migration_id: pin?.migration_id || null,
    result: READ_LIVE_ACTION,
    pin_executable: typeof receipt.pin_executable === 'boolean' ? receipt.pin_executable : SHA256_RE.test(String(pinnedExpected || '')),
    apply_preconditions_met: receipt.apply_preconditions_met === true,
    live_definition_sha256: live ?? null,
    pinned_expected_live_definition_sha256: pinnedExpected,
    matches_pinned_expected: Boolean(pinnedExpected) && live === pinnedExpected,
    intended_replacement_sha256: pin?.intended_replacement_sha256 || null,
    already_applied: Boolean(live) && live === pin?.intended_replacement_sha256,
  };
  for (const key of BOOLEAN_KEYS) {
    if (typeof receipt[key] === 'boolean') summary[key] = receipt[key];
  }
  for (const key of COUNT_KEYS) {
    if (Number.isInteger(receipt[key]) && receipt[key] >= 0) summary[key] = receipt[key];
  }
  for (const key of SHA256_KEYS) {
    if (SHA256_RE.test(String(receipt[key] || ''))) summary[key] = receipt[key];
  }
  for (const key of LABEL_MAP_KEYS) {
    if (receipt[key] && typeof receipt[key] === 'object') summary[key] = labelsOnly(receipt[key]);
  }
  if (Array.isArray(receipt.drifted_preserved_functions)) {
    summary.drifted_preserved_function_count = receipt.drifted_preserved_functions.length;
  }
  if (Array.isArray(receipt.missing_ledger_triggers)) {
    summary.missing_ledger_trigger_count = receipt.missing_ledger_triggers.length;
  }
  return ok(summary);
}

function flatten(prefix, value, out) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, inner] of Object.entries(value)) flatten(prefix ? `${prefix}.${key}` : key, inner, out);
  } else {
    out.push([prefix, value]);
  }
  return out;
}

export function readLiveSummaryMarkdown(summary) {
  const rows = flatten('', summary, []).map(([key, value]) => `- ${key}: \`${value === null ? 'null' : String(value)}\``);
  return ['### Staging SQL executor read-live (inspect only, no writes)', ...rows, ''].join('\n');
}
