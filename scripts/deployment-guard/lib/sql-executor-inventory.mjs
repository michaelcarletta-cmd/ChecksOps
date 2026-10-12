/**
 * Live-versus-candidate inventory for checksops-staging-guarded-sql-executor.
 *
 * Deploying the executor replaces its whole package, so every live source
 * member must either equal the candidate or be a version that main already
 * superseded. A live member main never had belongs to another workstream
 * (DEPLOYMENT_COLLISION); a live member the candidate would drop needs
 * reconciliation first (SOURCE_RECONCILIATION_REQUIRED).
 */
import { createHash } from 'node:crypto';
import { CODES, fail, ok } from './errors.mjs';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** npm installs node_modules and package-lock.json at pack time; they are not reviewed source. */
export function isInstalledMember(name) {
  return name.startsWith('node_modules/') || name === 'package-lock.json';
}

export function sourceMemberHashes(members = {}) {
  const out = {};
  for (const [name, data] of Object.entries(members)) {
    if (isInstalledMember(name)) continue;
    out[name] = sha256(data);
  }
  return out;
}

/** Lambda reports CodeSha256 as the base64 SHA-256 of the deployment zip. */
export function lambdaCodeSha256(zipBuffer) {
  return createHash('sha256').update(zipBuffer).digest('base64');
}

export function reconcileExecutorMembers({ live = {}, candidate = {}, historyOf = () => new Set(), sourceOf = {} } = {}) {
  const same = [];
  const superseded = [];
  const collisions = [];
  const dropped = [];
  for (const [name, liveSha] of Object.entries(live)) {
    if (!Object.prototype.hasOwnProperty.call(candidate, name)) {
      dropped.push(name);
    } else if (candidate[name] === liveSha) {
      same.push(name);
    } else if (sourceOf[name] && historyOf(sourceOf[name]).has(liveSha)) {
      superseded.push(name);
    } else {
      collisions.push({ member: name, live_sha256: liveSha, candidate_sha256: candidate[name] });
    }
  }
  const added = Object.keys(candidate).filter((name) => !Object.prototype.hasOwnProperty.call(live, name));
  const summary = {
    same: same.sort(),
    superseded: superseded.sort(),
    added: added.sort(),
    dropped: dropped.sort(),
    collisions,
    current: superseded.length === 0 && added.length === 0 && dropped.length === 0 && collisions.length === 0,
  };
  if (collisions.length) {
    return fail(CODES.DEPLOYMENT_COLLISION, 'live executor carries source main never had; another workstream owns it', summary);
  }
  if (dropped.length) {
    return fail(CODES.SOURCE_RECONCILIATION_REQUIRED, 'candidate executor would drop live members', summary);
  }
  return ok(summary);
}

export function environmentMatches(liveEnvironment = {}, intendedEnvironment = {}) {
  const live = liveEnvironment.Variables || {};
  const intended = intendedEnvironment.Variables || {};
  const keys = [...new Set([...Object.keys(live), ...Object.keys(intended)])].sort();
  const differing = keys.filter((key) => live[key] !== intended[key]);
  return differing.length
    ? fail(CODES.DEPLOYMENT_COLLISION, 'executor environment would change on deploy', { differing_keys: differing })
    : ok({ keys });
}
