import { CODES, errorEntry, failMany, ok } from './errors.mjs';
import { evaluateFingerprintCas, evaluatePostOverlay } from './lambda-overlay.mjs';
import { evaluateIndexToctou } from './spa-promote.mjs';
import { evaluateSqlCollision } from './sql-apply.mjs';

export function verifyLiveState(input = {}) {
  const errors = [];
  const kind = input.kind || input.deployment_type;

  if (kind === 'lambda-overlay') {
    const cas = evaluateFingerprintCas({
      preflight: input.preflight,
      immediatelyBefore: input.live || input.immediately_before,
    });
    if (!cas.ok) return cas;
    if (input.post_members && input.live_members) {
      const post = evaluatePostOverlay({
        liveMembersBefore: input.live_members,
        liveMembersAfter: input.post_members,
        ownedMembers: input.owned_members,
      });
      if (!post.ok) return post;
      return ok({ kind, ...cas.details, ...post.details });
    }
    return ok({ kind, ...cas.details });
  }

  if (kind === 'spa-promote') {
    const toctou = evaluateIndexToctou({
      preflight: input.preflight,
      immediatelyBefore: input.live || input.immediately_before,
    });
    if (!toctou.ok) return toctou;
    return ok({ kind, ...toctou.details });
  }

  if (kind === 'sql-apply') {
    const sql = evaluateSqlCollision(input);
    if (!sql.ok) return sql;
    return ok({ kind, ...sql.details });
  }

  errors.push(errorEntry(CODES.INVALID_MANIFEST, `verify-live does not recognize kind ${kind || '(missing)'}`));
  return failMany(errors);
}

export function evaluateInterruptedApply(input = {}) {
  if (input.rollback_to_previous === true || input.reclaim === true) {
    return failMany([errorEntry(
      CODES.STALE_PACKAGE,
      'interrupted apply must not automatically roll back to an older package or reclaim the environment',
    )], CODES.STALE_PACKAGE);
  }
  if (input.mutated === true && input.verified !== true) {
    return ok({
      status: 'UNKNOWN',
      reconciliation_required: true,
      reclaim_forbidden: true,
      rollback: false,
    });
  }
  if (input.lease_acquired === true && input.mutated !== true) {
    return ok({
      status: 'LEASE_HELD_OR_EXPIRED',
      reclaim_forbidden: true,
      rollback: false,
    });
  }
  return ok({
    status: input.verified === true ? 'VERIFIED' : 'NOT_STARTED',
    reclaim_forbidden: true,
    rollback: false,
  });
}
