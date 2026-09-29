/**
 * Shared-Lambda safe overlay.
 *
 * Download CURRENT live membership, overlay ONLY declared owned members,
 * prove non-owned members stay byte-identical, and fail closed if
 * CodeSha256 or RevisionId drifted. Never reclaims. Never reuses old ZIPs.
 *
 * This module plans overlays. It does not call AWS.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CODES,
  assertFreshPackage,
  assertNoReclaim,
  fail,
  fingerprintsEqual,
  lambdaFingerprint,
  memberHash,
  ok,
} from './lib.mjs';

export function membershipHashes(members = {}) {
  const out = {};
  for (const [name, content] of Object.entries(members)) {
    out[name] = typeof content === 'string' && /^[0-9a-f]{64}$/.test(content)
      ? content
      : memberHash(content);
  }
  return out;
}

export function compareZipMembership({ liveMembers, plannedMembers, ownedMembers }) {
  const owned = new Set(ownedMembers || []);
  const live = membershipHashes(liveMembers);
  const planned = membershipHashes(plannedMembers);
  const liveKeys = new Set(Object.keys(live));
  const plannedKeys = new Set(Object.keys(planned));
  const added = [...plannedKeys].filter((key) => !liveKeys.has(key));
  const deleted = [...liveKeys].filter((key) => !plannedKeys.has(key));
  const changed = [...plannedKeys].filter((key) => liveKeys.has(key) && live[key] !== planned[key]);
  const unexpectedAdds = added.filter((key) => !owned.has(key));
  const unexpectedDeletes = deleted.filter((key) => !owned.has(key));
  const unexpectedChanges = changed.filter((key) => !owned.has(key));
  const nonOwnedDrift = [];
  for (const key of liveKeys) {
    if (owned.has(key)) continue;
    if (planned[key] !== live[key]) nonOwnedDrift.push(key);
  }
  if (unexpectedAdds.length || unexpectedDeletes.length || unexpectedChanges.length || nonOwnedDrift.length) {
    return fail(CODES.DEPLOYMENT_COLLISION, 'ZIP membership changed undeclared members', {
      unexpectedAdds,
      unexpectedDeletes,
      unexpectedChanges,
      nonOwnedDrift,
      changed,
      added,
      deleted,
    });
  }
  const changedOwned = changed.filter((key) => owned.has(key));
  const extraOwnedUnchanged = [...owned].filter((key) => !changed.includes(key) && !added.includes(key));
  return ok({
    added,
    deleted,
    changed: changedOwned,
    unchanged_owned: extraOwnedUnchanged,
    live,
    planned,
  });
}

export function detectSameFileConflict({
  member,
  liveHash,
  workstreamAHash,
  currentSourceHash,
  workstreamAId = 'workstream-a',
  workstreamBId = 'current-source',
  liveCommit = null,
  workstreamACommit = null,
  workstreamBCommit = null,
}) {
  if (!member) return ok();
  if (!workstreamAHash || !currentSourceHash) return ok();
  if (workstreamAHash === currentSourceHash) return ok();
  const aChanged = workstreamAHash !== liveHash;
  const bChanged = currentSourceHash !== liveHash;
  if (aChanged && bChanged) {
    return fail(CODES.SOURCE_RECONCILIATION_REQUIRED, `same Lambda member changed by two workstreams: ${member}`, {
      member,
      live: { hash: liveHash, commit: liveCommit },
      workstream_a: { id: workstreamAId, hash: workstreamAHash, commit: workstreamACommit },
      current_source: { id: workstreamBId, hash: currentSourceHash, commit: workstreamBCommit },
    });
  }
  if (liveHash && workstreamAHash !== currentSourceHash && (liveHash === workstreamAHash || liveHash === currentSourceHash)) {
    return fail(CODES.SOURCE_RECONCILIATION_REQUIRED, `live already contains one workstream's version of ${member}; do not overlay the other`, {
      member,
      live: { hash: liveHash, commit: liveCommit },
      workstream_a: { id: workstreamAId, hash: workstreamAHash, commit: workstreamACommit },
      current_source: { id: workstreamBId, hash: currentSourceHash, commit: workstreamBCommit },
    });
  }
  return ok();
}

export function detectOwnedBaselineDrift({
  member,
  liveHash,
  expectedLiveHash,
  overlayHash,
}) {
  if (!expectedLiveHash || !liveHash || expectedLiveHash === liveHash) return ok();
  if (overlayHash && overlayHash !== liveHash) {
    return fail(
      CODES.SOURCE_RECONCILIATION_REQUIRED,
      `owned member ${member} changed on live after this workstream's preflight`,
      { member, liveHash, expectedLiveHash, overlayHash },
    );
  }
  return ok();
}

export function assertLambdaCas({ preflight, immediate }) {
  const left = lambdaFingerprint(preflight);
  const right = lambdaFingerprint(immediate);
  if (!left.codeSha256 || !left.revisionId || !right.codeSha256 || !right.revisionId) {
    return fail(CODES.DEPLOYMENT_COLLISION, 'Lambda CAS requires CodeSha256 and RevisionId on both preflight and immediate reads');
  }
  if (!fingerprintsEqual(left, right, ['codeSha256', 'revisionId'])) {
    return fail(CODES.DEPLOYMENT_COLLISION, 'live Lambda fingerprint changed after preflight; do not reclaim', {
      preflight: left,
      immediate: right,
    });
  }
  return ok({ fingerprint: right });
}

export function planOwnedOverlay({ liveMembers, overlayMembers, ownedMembers }) {
  const owned = [...new Set(ownedMembers || [])];
  const overlayKeys = Object.keys(overlayMembers || {});
  const undeclared = overlayKeys.filter((key) => !owned.includes(key));
  if (undeclared.length) {
    return fail(CODES.UNDECLARED_MEMBER, 'overlay includes members that were not declared as owned', { undeclared });
  }
  const planned = { ...membershipHashes(liveMembers) };
  for (const [name, content] of Object.entries(overlayMembers || {})) {
    planned[name] = memberHash(content);
  }
  return compareZipMembership({
    liveMembers,
    plannedMembers: planned,
    ownedMembers: owned,
  });
}

export function planLambdaOverlay(input = {}) {
  const reclaim = assertNoReclaim(input.intent || {});
  if (!reclaim.ok) return reclaim;
  const fresh = assertFreshPackage(input.provenance || {});
  if (!fresh.ok) return fresh;
  if (input.provenance?.source === 'live_download') {
    const liveSha = input.liveFingerprint?.codeSha256 || input.liveFingerprint?.CodeSha256;
    if (input.provenance.codeSha256 && liveSha && input.provenance.codeSha256 !== liveSha) {
      return fail(CODES.STALE_PACKAGE_REJECTED, 'downloaded package CodeSha256 does not match current live fingerprint', {
        provenance: input.provenance,
        liveFingerprint: input.liveFingerprint,
      });
    }
  }
  if (input.immediateFingerprint) {
    const cas = assertLambdaCas({
      preflight: input.liveFingerprint || input.preflightFingerprint,
      immediate: input.immediateFingerprint,
    });
    if (!cas.ok) return cas;
  }
  const live = membershipHashes(input.liveMembers || {});
  for (const member of input.ownedMembers || []) {
    const expected = input.expectedOwnedBaseline?.[member];
    const overlayHash = input.overlayMembers?.[member] != null
      ? memberHash(input.overlayMembers[member])
      : null;
    const drift = detectOwnedBaselineDrift({
      member,
      liveHash: live[member],
      expectedLiveHash: expected,
      overlayHash,
    });
    if (!drift.ok) return drift;
    const conflict = detectSameFileConflict({
      member,
      liveHash: live[member],
      workstreamAHash: input.otherWorkstreamMembers?.[member] != null
        ? memberHash(input.otherWorkstreamMembers[member])
        : input.otherWorkstreamHashes?.[member],
      currentSourceHash: overlayHash,
      workstreamAId: input.otherWorkstreamId,
      workstreamBId: input.workstreamId,
      liveCommit: input.liveCommit,
      workstreamACommit: input.otherWorkstreamCommit,
      workstreamBCommit: input.commit,
    });
    if (!conflict.ok) return conflict;
  }
  const overlay = planOwnedOverlay({
    liveMembers: input.liveMembers,
    overlayMembers: input.overlayMembers,
    ownedMembers: input.ownedMembers,
  });
  if (!overlay.ok) return overlay;
  return ok({
    ...overlay,
    updateFunctionCodeArgs: input.liveFingerprint?.revisionId || input.liveFingerprint?.RevisionId
      ? {
        FunctionName: input.functionName,
        RevisionId: input.liveFingerprint.revisionId || input.liveFingerprint.RevisionId,
        note: 'AWS RevisionId compare-and-swap; this guard does not invoke UpdateFunctionCode',
      }
      : null,
    liveFingerprint: lambdaFingerprint(input.liveFingerprint || {}),
  });
}

export function verifyNonOwnedIntact({ liveMembersBefore, liveMembersAfter, ownedMembers }) {
  const before = membershipHashes(liveMembersBefore);
  const after = membershipHashes(liveMembersAfter);
  const owned = new Set(ownedMembers || []);
  const drifted = Object.keys(before).filter((name) => !owned.has(name) && before[name] !== after[name]);
  const deleted = Object.keys(before).filter((name) => !owned.has(name) && after[name] == null);
  if (drifted.length || deleted.length) {
    return fail(CODES.DEPLOYMENT_COLLISION, 'post-deploy verification: non-owned Lambda members were mutated', {
      drifted,
      deleted,
    });
  }
  return ok({ preserved: Object.keys(before).filter((name) => !owned.has(name)) });
}

export function commitLambdaOverlay(_plan, aws) {
  if (!aws || typeof aws.updateFunctionCode !== 'function') {
    return fail(CODES.AWS_WRITE_FORBIDDEN, 'no AWS adapter supplied; refusing write');
  }
  try {
    aws.updateFunctionCode();
  } catch (error) {
    return fail(error.code || CODES.AWS_WRITE_FORBIDDEN, error.message);
  }
  return fail(CODES.AWS_WRITE_FORBIDDEN, 'Lambda write is not implemented in this safeguard workstream');
}

export function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help')) {
    console.log('lambda-overlay plans a safe overlay. It never calls UpdateFunctionCode.');
    return 0;
  }
  console.log(JSON.stringify({
    ok: true,
    code: CODES.OK,
    message: 'lambda-overlay is plan-only; invoke planLambdaOverlay() from preflight with a workstream manifest',
  }, null, 2));
  return 0;
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  process.exitCode = main();
}
