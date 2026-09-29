import { CODES, errorEntry, failMany, ok } from './errors.mjs';
import { evaluatePackageProvenance } from './packages.mjs';
import { validateWorkstreamIdentity } from './identity.mjs';

export function normalizeMembers(members) {
  if (!members) return {};
  if (members instanceof Map) return Object.fromEntries(members);
  return { ...members };
}

export function memberDiff(liveMembers, candidateMembers) {
  const live = normalizeMembers(liveMembers);
  const candidate = normalizeMembers(candidateMembers);
  const liveKeys = new Set(Object.keys(live));
  const candidateKeys = new Set(Object.keys(candidate));
  const added = [...candidateKeys].filter((key) => !liveKeys.has(key)).sort();
  const deleted = [...liveKeys].filter((key) => !candidateKeys.has(key)).sort();
  const changed = [...liveKeys]
    .filter((key) => candidateKeys.has(key) && live[key] !== candidate[key])
    .sort();
  const identical = [...liveKeys]
    .filter((key) => candidateKeys.has(key) && live[key] === candidate[key])
    .sort();
  return { added, deleted, changed, identical };
}

export function evaluateMembership({ liveMembers, candidateMembers, ownedMembers }) {
  const errors = [];
  const owned = new Set(ownedMembers || []);
  const diff = memberDiff(liveMembers, candidateMembers);
  const unexpectedAdded = diff.added.filter((key) => !owned.has(key));
  const unexpectedDeleted = diff.deleted.filter((key) => !owned.has(key));
  const unexpectedChanged = diff.changed.filter((key) => !owned.has(key));

  if (unexpectedAdded.length) {
    errors.push(errorEntry(CODES.DEPLOYMENT_COLLISION, 'unexpected Lambda ZIP additions outside owned members', {
      unexpected_added: unexpectedAdded,
    }));
  }
  if (unexpectedDeleted.length) {
    errors.push(errorEntry(CODES.DEPLOYMENT_COLLISION, 'unexpected Lambda ZIP deletions outside owned members', {
      unexpected_deleted: unexpectedDeleted,
    }));
  }
  if (unexpectedChanged.length) {
    errors.push(errorEntry(CODES.DEPLOYMENT_COLLISION, 'non-owned Lambda members are not byte-identical to live', {
      unexpected_changed: unexpectedChanged,
    }));
  }

  const ownedChanged = [...diff.added, ...diff.deleted, ...diff.changed].filter((key) => owned.has(key));
  return {
    ...failMany(errors, CODES.DEPLOYMENT_COLLISION),
    details: {
      ...diff,
      owned_changed: ownedChanged.sort(),
      unexpected_added: unexpectedAdded,
      unexpected_deleted: unexpectedDeleted,
      unexpected_changed: unexpectedChanged,
    },
  };
}

export function evaluateSameFileConflict({
  liveMembers,
  candidateMembers,
  ownedMembers,
  peerSources = [],
}) {
  const errors = [];
  const live = normalizeMembers(liveMembers);
  const candidate = normalizeMembers(candidateMembers);
  const owned = new Set(ownedMembers || []);

  for (const path of owned) {
    const liveHash = live[path];
    const candidateHash = candidate[path];
    if (!candidateHash || candidateHash === liveHash) continue;
    for (const peer of peerSources) {
      const peerHash = normalizeMembers(peer.members)[path];
      if (!peerHash) continue;
      if (peerHash !== liveHash && peerHash !== candidateHash) {
        errors.push(errorEntry(
          CODES.SOURCE_RECONCILIATION_REQUIRED,
          `same-file conflict on ${path}; do not overlay one workstream over another`,
          {
            file: path,
            live_version: liveHash || null,
            current_source_version: candidateHash,
            peer_version: peerHash,
            current_workstream: peer.current_workstream_id || null,
            peer_workstream: peer.workstream_id || null,
            current_commit: peer.current_commit || null,
            peer_commit: peer.commit || null,
          },
        ));
      } else if (peerHash !== liveHash && peerHash === candidateHash && peer.workstream_id) {
        /* identical independent edits still require source composition review if declared concurrent */
        if (peer.require_reconciliation_even_if_identical === true) {
          errors.push(errorEntry(
            CODES.SOURCE_RECONCILIATION_REQUIRED,
            `concurrent owned-file edits on ${path} require source reconciliation before overlay`,
            { file: path, live_version: liveHash || null, workstreams: [peer.current_workstream_id, peer.workstream_id] },
          ));
        }
      }
    }
  }

  if (errors.length) return failMany(errors, CODES.SOURCE_RECONCILIATION_REQUIRED);
  return ok({ conflicts: [] });
}

export function evaluateFingerprintCas({ preflight, immediatelyBefore }) {
  const errors = [];
  if (!preflight || !immediatelyBefore) {
    errors.push(errorEntry(CODES.DEPLOYMENT_COLLISION, 'Lambda CAS requires preflight and immediately-before fingerprints'));
    return failMany(errors, CODES.DEPLOYMENT_COLLISION);
  }
  if (preflight.codeSha256 && immediatelyBefore.codeSha256 && preflight.codeSha256 !== immediatelyBefore.codeSha256) {
    errors.push(errorEntry(CODES.DEPLOYMENT_COLLISION, 'CodeSha256 changed after preflight; fail closed and do not reclaim the Lambda', {
      preflight_codeSha256: preflight.codeSha256,
      live_codeSha256: immediatelyBefore.codeSha256,
    }));
  }
  if (preflight.revisionId && immediatelyBefore.revisionId && preflight.revisionId !== immediatelyBefore.revisionId) {
    errors.push(errorEntry(CODES.DEPLOYMENT_COLLISION, 'RevisionId changed after preflight; fail closed and do not reclaim the Lambda', {
      preflight_revisionId: preflight.revisionId,
      live_revisionId: immediatelyBefore.revisionId,
    }));
  }
  if (errors.length) return failMany(errors, CODES.DEPLOYMENT_COLLISION);
  return ok({
    revision_id: immediatelyBefore.revisionId,
    code_sha256: immediatelyBefore.codeSha256,
    compare_and_swap: true,
  });
}

export function evaluatePostOverlay({ liveMembersBefore, liveMembersAfter, ownedMembers }) {
  const owned = new Set(ownedMembers || []);
  const before = normalizeMembers(liveMembersBefore);
  const after = normalizeMembers(liveMembersAfter);
  const errors = [];
  for (const [path, hash] of Object.entries(before)) {
    if (owned.has(path)) continue;
    if (after[path] !== hash) {
      errors.push(errorEntry(CODES.DEPLOYMENT_COLLISION, `non-owned member ${path} was not preserved after overlay`, {
        file: path,
        before: hash,
        after: after[path] || null,
      }));
    }
  }
  if (errors.length) return failMany(errors, CODES.DEPLOYMENT_COLLISION);
  return ok({ preserved: Object.keys(before).filter((path) => !owned.has(path)).sort() });
}

export function evaluateLambdaOverlay(input = {}) {
  const errors = [];
  const identity = validateWorkstreamIdentity({
    workstream_id: input.workstream_id,
    branch: input.branch,
    commit: input.commit,
    operator: input.operator,
    target_environment: input.target_environment,
    deployment_type: input.deployment_type || 'lambda-overlay',
    owned_components: input.owned_members || input.owned_components,
    preflight_live_fingerprint: input.preflight || input.preflight_live_fingerprint,
    build_timestamp: input.build_timestamp,
  });
  if (!identity.ok) return identity;

  const provenance = evaluatePackageProvenance(input.package);
  if (!provenance.ok) return provenance;

  if (!Array.isArray(input.owned_members) || input.owned_members.length === 0) {
    errors.push(errorEntry(CODES.INVALID_MANIFEST, 'Lambda overlay requires an explicit owned_members declaration'));
  }

  const membership = evaluateMembership({
    liveMembers: input.live_members,
    candidateMembers: input.candidate_members,
    ownedMembers: input.owned_members,
  });
  if (!membership.ok) return membership;

  const sameFile = evaluateSameFileConflict({
    liveMembers: input.live_members,
    candidateMembers: input.candidate_members,
    ownedMembers: input.owned_members,
    peerSources: input.peer_sources || [],
  });
  if (!sameFile.ok) return sameFile;

  if (!input.immediately_before) {
    errors.push(errorEntry(
      CODES.DEPLOYMENT_COLLISION,
      'mutation-boundary fingerprint (immediately_before) is required; preflight alone is not sufficient',
    ));
    return failMany(errors, CODES.DEPLOYMENT_COLLISION);
  }
  const cas = evaluateFingerprintCas({
    preflight: input.preflight,
    immediatelyBefore: input.immediately_before,
  });
  if (!cas.ok) return cas;

  if (input.post_members) {
    const post = evaluatePostOverlay({
      liveMembersBefore: input.live_members,
      liveMembersAfter: input.post_members,
      ownedMembers: input.owned_members,
    });
    if (!post.ok) return post;
  }

  if (errors.length) return failMany(errors);

  return ok({
    overlay_allowed: true,
    owned_changed: membership.details.owned_changed,
    revision_id: cas.details.revision_id,
    update_function_code: {
      revisionId: cas.details.revision_id,
      compareAndSwap: true,
    },
    reclaim_forbidden: true,
  });
}

export function planLambdaApply(evaluation, { apply = false, env = process.env } = {}) {
  if (!evaluation?.ok) return evaluation;
  if (!apply) {
    return ok({
      ...evaluation.details,
      apply: false,
      note: 'evaluate-only; no AWS write',
    });
  }
  if (env.CHECKSOPS_DEPLOYMENT_GUARD_APPLY !== '1') {
    return failMany([errorEntry(
      CODES.GUARD_APPLY_FORBIDDEN,
      'Lambda apply is blocked unless CHECKSOPS_DEPLOYMENT_GUARD_APPLY=1. This safeguard workstream never sets that flag.',
    )], CODES.GUARD_APPLY_FORBIDDEN);
  }
  return ok({
    ...evaluation.details,
    apply: true,
    aws_command: {
      service: 'lambda',
      action: 'update-function-code',
      revisionId: evaluation.details.revision_id,
    },
  });
}
