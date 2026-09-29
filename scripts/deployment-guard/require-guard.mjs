/**
 * Hook that legacy deployment scripts must call before any live write.
 *
 * Design (legacy scripts are not rewritten in this workstream):
 *   import { assertGuardCleared } from '../../scripts/deployment-guard/require-guard.mjs';
 *   assertGuardCleared({ receipt });
 *
 * A missing or stale preflight receipt fails closed. This module never
 * calls AWS.
 */
import { CODES, fail, ok, parseIso } from './lib.mjs';

export const RECEIPT_MAX_AGE_MS = 20 * 60 * 1000;

export function assertGuardCleared({ receipt, nowMs = Date.now(), operation = 'deploy' } = {}) {
  if (!receipt || typeof receipt !== 'object') {
    return fail(CODES.GUARD_NOT_CLEARED, `${operation} refused: no deployment-guard preflight receipt`);
  }
  if (receipt.ok === false || receipt.stop === true) {
    return fail(CODES.GUARD_NOT_CLEARED, `${operation} refused: preflight did not pass`, { receipt });
  }
  if (!receipt.manifest?.workstream_id || !receipt.manifest?.commit) {
    return fail(CODES.ANONYMOUS_DEPLOYMENT, `${operation} refused: receipt is missing workstream identity`);
  }
  const generated = parseIso(receipt.generated_at || receipt.manifest?.build_timestamp);
  if (generated == null || (nowMs - generated) > RECEIPT_MAX_AGE_MS) {
    return fail(CODES.GUARD_NOT_CLEARED, `${operation} refused: preflight receipt is missing or expired`);
  }
  if (receipt.dry_run === false) {
    return fail(CODES.AWS_WRITE_FORBIDDEN, `${operation} refused: this safeguard workstream does not authorize live writes`);
  }
  return ok({ receipt, operation });
}

export function mustClearGuard(args) {
  const result = assertGuardCleared(args);
  if (!result.ok) {
    const error = new Error(`${result.code}: ${result.message}`);
    error.result = result;
    throw error;
  }
  return result;
}
