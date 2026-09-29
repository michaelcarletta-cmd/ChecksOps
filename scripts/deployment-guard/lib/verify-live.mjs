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
