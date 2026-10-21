/**
 * Guarded full-package rebuild of a shared API Lambda.
 *
 * The overlay path replaces one reviewed member inside the CURRENT live ZIP. A
 * rebuild replaces the whole package with a fresh build of main
 * (aws/functions/api plus a lockfile-pinned node_modules). It is allowed only
 * when every difference between the live package and the candidate is listed
 * in ops/deployment-guard/lambda-rebuild-plan.json for that environment: each
 * changed, added or removed source member with its exact live and accepted
 * SHA-256, and each dependency package added, removed or re-versioned. Anything
 * unlisted fails closed, so a rebuild can never silently drop a live-only file
 * or ship an unreviewed dependency.
 *
 * Pure functions only: no AWS, no network. The preflight and the writer call
 * these with bytes they fetched themselves.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CODES, GuardError, fail, ok } from './errors.mjs';
import { validateZipMemberName } from './lambda-owned-members.mjs';
import { readZipMembers, writeZipMembers } from './zip-members.mjs';

export const REBUILD_DEPLOYMENT_TYPE = 'lambda-rebuild';
export const REBUILD_PLAN_REL = 'ops/deployment-guard/lambda-rebuild-plan.json';
export const API_PACKAGE_REL = 'aws/functions/api';
export const REBUILD_FUNCTIONS = Object.freeze({
  staging: 'checksops-staging-api',
  production: 'checksops-production-prep-api',
});
export const FULL_PACKAGE_COMPONENT_PREFIX = 'full-package@sha256:';

const HEX64 = /^[0-9a-f]{64}$/;
const MAX_FILES = 25000;
const MAX_UNZIPPED_BYTES = 250 * 1024 * 1024; // the Lambda deployment limit
const SKIP_NAMES = new Set(['.DS_Store', 'Thumbs.db']);
const PACKAGE_JSON_RE = /^(node_modules\/(?:@[^/]+\/)?[^/@][^/]*(?:\/node_modules\/(?:@[^/]+\/)?[^/@][^/]*)*)\/package\.json$/;
// Package members may carry npm scope directories (@aws-sdk) and the characters npm
// package names allow; traversal, absolute paths and backslashes stay refused.
const PACKAGE_SEGMENT_RE = /^[A-Za-z0-9._@+~-][A-Za-z0-9._@+~-]*$/;

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export function validatePackageMemberName(name) {
  if (typeof name !== 'string' || !name || name.includes('\0') || name.includes('\\')) {
    return fail(CODES.UNRELATED_MUTATION, 'package member name is malformed', { member: name });
  }
  if (name.startsWith('/') || /^[A-Za-z]:[\\/]/.test(name) || name.endsWith('/')) {
    return fail(CODES.UNRELATED_MUTATION, 'package member must be a relative file path', { member: name });
  }
  const segments = name.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || !PACKAGE_SEGMENT_RE.test(segment))) {
    return fail(CODES.UNRELATED_MUTATION, 'package member is not a normal Lambda ZIP member name', { member: name });
  }
  if (isSourceMember(name)) {
    const named = validateZipMemberName(name, 'package member');
    if (!named.ok) return named;
  }
  return ok({ member: name });
}

export function isSourceMember(name) {
  return !String(name).startsWith('node_modules/');
}

/** Full-package receipt component: the candidate ZIP's SHA-256 is the only thing the receipt owns. */
export function fullPackageComponent(zipSha256) {
  if (!HEX64.test(String(zipSha256 || ''))) {
    throw new GuardError(CODES.INVALID_MANIFEST, 'full-package component requires the candidate ZIP SHA-256');
  }
  return `${FULL_PACKAGE_COMPONENT_PREFIX}${zipSha256}`;
}

export function parseFullPackageComponent(component) {
  const text = String(component || '');
  if (!text.startsWith(FULL_PACKAGE_COMPONENT_PREFIX)) return null;
  const hash = text.slice(FULL_PACKAGE_COMPONENT_PREFIX.length);
  return HEX64.test(hash) ? hash : null;
}

/**
 * Every regular file under the package root, as sorted POSIX ZIP member names.
 * Symlinks, devices and odd names fail closed: a rebuild ships exactly what the
 * checkout plus the lockfile install contain, nothing resolved from elsewhere.
 */
export function collectPackageFiles(apiRoot) {
  const out = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_NAMES.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        throw new GuardError(CODES.UNRELATED_MUTATION, 'package contains a symlink; refuse to resolve it into the ZIP', { member: rel });
      }
      if (entry.isDirectory()) {
        walk(abs, rel);
        continue;
      }
      if (!entry.isFile()) {
        throw new GuardError(CODES.UNRELATED_MUTATION, 'package contains a non-regular file', { member: rel });
      }
      const named = validatePackageMemberName(rel);
      if (!named.ok) throw new GuardError(named.code, named.message, named.details || {});
      out.push(rel);
      if (out.length > MAX_FILES) {
        throw new GuardError(CODES.STALE_PACKAGE, 'package has more files than a Lambda ZIP may carry', { limit: MAX_FILES });
      }
    }
  };
  walk(apiRoot, '');
  return out.sort();
}

/**
 * Deterministic candidate ZIP from the package root: sorted members, no
 * timestamps or permissions (zip-members.mjs writes none), so the same tree
 * always produces the same bytes and the same SHA-256.
 */
export function buildCandidatePackage(apiRoot, { requireNodeModules = true } = {}) {
  if (!fs.existsSync(apiRoot) || !fs.statSync(apiRoot).isDirectory()) {
    throw new GuardError(CODES.INVALID_MANIFEST, 'package root is not a directory', { apiRoot });
  }
  const files = collectPackageFiles(apiRoot);
  if (!files.includes('index.mjs') || !files.includes('package.json') || !files.includes('package-lock.json')) {
    throw new GuardError(CODES.STALE_PACKAGE, 'package root is missing index.mjs, package.json or package-lock.json', { apiRoot });
  }
  if (requireNodeModules && !files.some((name) => name.startsWith('node_modules/'))) {
    throw new GuardError(CODES.STALE_PACKAGE, 'candidate has no node_modules; install the lockfile (npm ci --omit=dev) before building', { apiRoot });
  }
  const members = {};
  const memberHashes = {};
  let bytes = 0;
  for (const name of files) {
    const data = fs.readFileSync(path.join(apiRoot, name));
    bytes += data.length;
    if (bytes > MAX_UNZIPPED_BYTES) {
      throw new GuardError(CODES.STALE_PACKAGE, 'candidate exceeds the Lambda unzipped size limit', { limit: MAX_UNZIPPED_BYTES });
    }
    members[name] = data;
    memberHashes[name] = sha256(data);
  }
  const zip = writeZipMembers(members);
  return {
    zip,
    zipSha256: sha256(zip),
    memberHashes,
    inventory: packageInventory(members),
    fileCount: files.length,
    unzippedBytes: bytes,
  };
}

/** Read a ZIP into member hashes plus the dependency inventory, without keeping source bytes. */
export function readPackage(zipBuffer) {
  const members = readZipMembers(zipBuffer);
  const memberHashes = {};
  for (const [name, data] of Object.entries(members)) memberHashes[name] = sha256(data);
  return { memberHashes, inventory: packageInventory(members), memberCount: Object.keys(members).length };
}

/**
 * node_modules packages by path (nested packages keep their full path), each
 * with the version its package.json declares. Unparsable manifests are kept as
 * 'unparsable' so they still count as a difference.
 */
export function packageInventory(members) {
  const out = {};
  for (const [name, data] of Object.entries(members)) {
    const match = PACKAGE_JSON_RE.exec(name);
    if (!match) continue;
    let version = 'unparsable';
    try {
      const parsed = JSON.parse(Buffer.from(data).toString('utf8'));
      if (parsed && typeof parsed.version === 'string' && parsed.version) version = parsed.version;
    } catch {
      /* keep 'unparsable' */
    }
    out[match[1]] = version;
  }
  return out;
}

export function diffMembers(liveHashes = {}, candidateHashes = {}) {
  const same = [];
  const changed = [];
  const added = [];
  const removed = [];
  const names = new Set([...Object.keys(liveHashes), ...Object.keys(candidateHashes)].filter(isSourceMember));
  for (const name of [...names].sort()) {
    const live = liveHashes[name];
    const candidate = candidateHashes[name];
    if (live && candidate) {
      if (live === candidate) same.push(name);
      else changed.push({ name, live_sha256: live, candidate_sha256: candidate });
    } else if (candidate) {
      added.push({ name, candidate_sha256: candidate });
    } else {
      removed.push({ name, live_sha256: live });
    }
  }
  return { same, changed, added, removed };
}

export function diffDependencies(liveInventory = {}, candidateInventory = {}) {
  const added = {};
  const removed = {};
  const changed = {};
  const names = new Set([...Object.keys(liveInventory), ...Object.keys(candidateInventory)]);
  for (const name of [...names].sort()) {
    const live = liveInventory[name];
    const candidate = candidateInventory[name];
    if (live && candidate) {
      if (live !== candidate) changed[name] = { from: live, to: candidate };
    } else if (candidate) {
      added[name] = candidate;
    } else {
      removed[name] = live;
    }
  }
  return { added, removed, changed };
}

const CODE_RANK = {
  [CODES.DEPLOYMENT_COLLISION]: 3,
  [CODES.STALE_PACKAGE]: 2,
  [CODES.SOURCE_RECONCILIATION_REQUIRED]: 1,
};

function section(plan, environment) {
  const row = plan?.environments?.[environment];
  if (!row || typeof row !== 'object') {
    throw new GuardError(CODES.INVALID_MANIFEST, 'rebuild plan has no section for this environment', { environment });
  }
  const strings = (obj, label) => {
    if (obj == null) return {};
    if (typeof obj !== 'object' || Array.isArray(obj)) throw new GuardError(CODES.INVALID_MANIFEST, `rebuild plan ${label} must be an object`, { environment });
    return obj;
  };
  const members = strings(row.members, 'members');
  for (const [name, entry] of Object.entries(members)) {
    const named = validateZipMemberName(name, 'rebuild plan member');
    if (!named.ok || !isSourceMember(name)) throw new GuardError(CODES.INVALID_MANIFEST, 'rebuild plan member name is invalid', { environment, member: name });
    if (!HEX64.test(String(entry?.live_sha256 || '')) || !HEX64.test(String(entry?.accepted_sha256 || ''))) {
      throw new GuardError(CODES.INVALID_MANIFEST, 'rebuild plan member needs live_sha256 and accepted_sha256', { environment, member: name });
    }
    if (entry.live_sha256 === entry.accepted_sha256) {
      throw new GuardError(CODES.INVALID_MANIFEST, 'rebuild plan member lists identical live and accepted bytes; drop the entry', { environment, member: name });
    }
  }
  const added = strings(row.added, 'added');
  const removed = strings(row.removed, 'removed');
  for (const [label, obj] of [['added', added], ['removed', removed]]) {
    for (const [name, hash] of Object.entries(obj)) {
      const named = validateZipMemberName(name, `rebuild plan ${label} member`);
      if (!named.ok || !isSourceMember(name) || !HEX64.test(String(hash || ''))) {
        throw new GuardError(CODES.INVALID_MANIFEST, `rebuild plan ${label} entry is invalid`, { environment, member: name });
      }
      if (members[name]) throw new GuardError(CODES.INVALID_MANIFEST, `rebuild plan lists ${name} both as changed and ${label}`, { environment });
    }
    if (added[Object.keys(removed)[0]]) throw new GuardError(CODES.INVALID_MANIFEST, 'rebuild plan lists a member as both added and removed', { environment });
  }
  const dependencies = strings(row.dependencies, 'dependencies');
  return {
    function_name: row.function_name,
    members,
    added,
    removed,
    dependencies: {
      added: strings(dependencies.added, 'dependencies.added'),
      removed: strings(dependencies.removed, 'dependencies.removed'),
      changed: strings(dependencies.changed, 'dependencies.changed'),
    },
  };
}

export function loadRebuildPlan(root, environment) {
  const plan = JSON.parse(fs.readFileSync(path.join(root, REBUILD_PLAN_REL), 'utf8'));
  const row = section(plan, environment);
  if (row.function_name !== REBUILD_FUNCTIONS[environment]) {
    throw new GuardError(CODES.UNRELATED_MUTATION, 'rebuild plan section targets a different function', { environment, function_name: row.function_name });
  }
  return row;
}

/**
 * Compare the live package with the candidate against the environment's plan
 * section. Returns ok({ state: 'READY' | 'ALREADY_ACCEPTED', diff }) or a
 * failure whose details.problems list every unlisted or mismatched difference,
 * so an inspect run can be used to fill the plan.
 */
export function evaluateRebuild({ plan, environment, liveMemberHashes, candidateMemberHashes, liveInventory, candidateInventory }) {
  const accepted = section(plan, environment);
  const problems = [];
  const members = diffMembers(liveMemberHashes, candidateMemberHashes);
  const dependencies = diffDependencies(liveInventory, candidateInventory);

  for (const row of members.changed) {
    const listed = accepted.members[row.name];
    if (!listed) {
      problems.push({ code: CODES.SOURCE_RECONCILIATION_REQUIRED, reason: 'unlisted_change', ...row });
    } else if (listed.live_sha256 !== row.live_sha256) {
      problems.push({ code: CODES.DEPLOYMENT_COLLISION, reason: 'live_mismatch', ...row, expected_live_sha256: listed.live_sha256 });
    } else if (listed.accepted_sha256 !== row.candidate_sha256) {
      problems.push({ code: CODES.STALE_PACKAGE, reason: 'candidate_mismatch', ...row, accepted_sha256: listed.accepted_sha256 });
    }
  }
  for (const row of members.added) {
    const listed = accepted.added[row.name];
    if (!listed) problems.push({ code: CODES.SOURCE_RECONCILIATION_REQUIRED, reason: 'unlisted_add', ...row });
    else if (listed !== row.candidate_sha256) problems.push({ code: CODES.STALE_PACKAGE, reason: 'candidate_mismatch', ...row, accepted_sha256: listed });
  }
  for (const row of members.removed) {
    const listed = accepted.removed[row.name];
    if (!listed) problems.push({ code: CODES.SOURCE_RECONCILIATION_REQUIRED, reason: 'unlisted_removal', ...row });
    else if (listed !== row.live_sha256) problems.push({ code: CODES.DEPLOYMENT_COLLISION, reason: 'live_mismatch', ...row, expected_live_sha256: listed });
  }
  // A listed change whose live side no longer matches the plan (and is not already the
  // accepted bytes) is drift the plan did not foresee.
  for (const [name, listed] of Object.entries(accepted.members)) {
    const live = liveMemberHashes[name];
    const candidate = candidateMemberHashes[name];
    if (!live || !candidate) {
      problems.push({ code: CODES.DEPLOYMENT_COLLISION, reason: 'listed_member_missing', name, live_sha256: live || null, candidate_sha256: candidate || null });
    } else if (live === candidate && live !== listed.accepted_sha256) {
      problems.push({ code: CODES.DEPLOYMENT_COLLISION, reason: 'listed_member_drifted', name, live_sha256: live, accepted_sha256: listed.accepted_sha256 });
    }
  }
  for (const [name, version] of Object.entries(dependencies.added)) {
    if (accepted.dependencies.added[name] !== version) problems.push({ code: CODES.SOURCE_RECONCILIATION_REQUIRED, reason: 'unlisted_dependency_add', name, version, listed: accepted.dependencies.added[name] || null });
  }
  for (const [name, version] of Object.entries(dependencies.removed)) {
    if (accepted.dependencies.removed[name] !== version) problems.push({ code: CODES.SOURCE_RECONCILIATION_REQUIRED, reason: 'unlisted_dependency_removal', name, version, listed: accepted.dependencies.removed[name] || null });
  }
  for (const [name, change] of Object.entries(dependencies.changed)) {
    const listed = accepted.dependencies.changed[name];
    if (!listed || listed.from !== change.from || listed.to !== change.to) {
      problems.push({ code: CODES.SOURCE_RECONCILIATION_REQUIRED, reason: 'unlisted_dependency_change', name, ...change, listed: listed || null });
    }
  }

  const diff = {
    same: members.same.length,
    changed: members.changed,
    added: members.added,
    removed: members.removed,
    dependencies,
    dependency_counts: {
      live: Object.keys(liveInventory || {}).length,
      candidate: Object.keys(candidateInventory || {}).length,
    },
  };
  if (problems.length) {
    const code = problems.reduce((worst, row) => ((CODE_RANK[row.code] || 0) > (CODE_RANK[worst] || 0) ? row.code : worst), problems[0].code);
    return fail(code, 'candidate package differs from the live package in ways the rebuild plan does not accept', { environment, problems, diff });
  }
  const unchanged = !members.changed.length && !members.added.length && !members.removed.length
    && !Object.keys(dependencies.added).length && !Object.keys(dependencies.removed).length && !Object.keys(dependencies.changed).length;
  return ok({ environment, state: unchanged ? 'ALREADY_ACCEPTED' : 'READY', diff });
}
