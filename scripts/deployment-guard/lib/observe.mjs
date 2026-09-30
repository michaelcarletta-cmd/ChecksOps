/**
 * Trusted collector for official mutating evaluates.
 *
 * Candidate hashes come from the exact deployment artifact (Lambda ZIP or
 * SPA) bound to the declared commit. Live hashes come from a freshly
 * captured deployment baseline whose fingerprint is verified. Ancestry
 * comes from git rev-parse / merge-base / merge-base --is-ancestor.
 * Caller JSON is never treated as an observation. Repository source
 * hashes are not proof that the ZIP or SPA being deployed contains
 * those bytes. Missing live evidence fails closed.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { CODES, errorEntry, failMany, ok } from './errors.mjs';
import { requiredPreservedPaths } from './source-composition.mjs';

const GIT_SHA_RE = /^[0-9a-f]{40}$/;
const FINGERPRINT_ID_FIELDS = Object.freeze([
  'codeSha256',
  'revisionId',
  'index_html_sha256',
  'entry_bundle',
  'sql',
]);

export function defaultGitRunner(root) {
  return (args, encoding = 'utf8') => execFileSync('git', args, {
    cwd: root,
    encoding: encoding === 'buffer' ? undefined : encoding,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function asBytes(value) {
  if (Buffer.isBuffer(value)) return value;
  return Buffer.from(value == null ? '' : String(value));
}

function gitText(run, args) {
  return String(run(args, 'utf8') ?? '').trim();
}

export function hashBytes(bytes) {
  return createHash('sha256').update(asBytes(bytes)).digest('hex');
}

function resolveInside(root, rel) {
  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, rel);
  const relative = path.relative(rootAbs, abs);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`path escapes repository root: ${rel}`);
  }
  return abs;
}

export function hashFileBytes(root, rel) {
  return hashBytes(fs.readFileSync(resolveInside(root, rel)));
}

export function isZipFile(abs) {
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile()) return false;
    const fd = fs.openSync(abs, 'r');
    const magic = Buffer.alloc(4);
    fs.readSync(fd, magic, 0, 4, 0);
    fs.closeSync(fd);
    return magic[0] === 0x50 && magic[1] === 0x4b;
  } catch {
    return false;
  }
}

export function readZipMemberBytes(zipPath, member) {
  const buf = fs.readFileSync(zipPath);
  const wanted = String(member).replace(/\\/g, '/').replace(/^\.\//, '');
  let eocd = -1;
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error(`not a zip archive: ${zipPath}`);
  const cdCount = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < cdCount; i += 1) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`invalid zip central directory: ${zipPath}`);
    }
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localHeader = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8').replace(/\\/g, '/');
    const normalized = name.replace(/^\.\//, '');
    if (normalized === wanted) {
      const localNameLen = buf.readUInt16LE(localHeader + 26);
      const localExtraLen = buf.readUInt16LE(localHeader + 28);
      const dataStart = localHeader + 30 + localNameLen + localExtraLen;
      const compressed = buf.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) return Buffer.from(compressed);
      if (method === 8) return inflateRawSync(compressed);
      throw new Error(`unsupported zip compression method ${method} for ${member}`);
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`zip member missing: ${member}`);
}

export function hashArtifactMember(artifactPath, rel) {
  const abs = path.resolve(artifactPath);
  if (isZipFile(abs)) return hashBytes(readZipMemberBytes(abs, rel));
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) return hashFileBytes(abs, rel);
  throw new Error(`deployment artifact must be a Lambda ZIP or SPA directory: ${artifactPath}`);
}

function hashMemberList(artifactPath, files, missingLabel, source) {
  const members = {};
  const missing = [];
  for (const file of files) {
    try {
      members[file] = hashArtifactMember(artifactPath, file);
    } catch {
      missing.push(file);
    }
  }
  if (missing.length) {
    return failMany([errorEntry(
      CODES.SOURCE_COMPOSITION_REQUIRED,
      missingLabel,
      { missing_artifacts: missing, source },
    )], CODES.SOURCE_COMPOSITION_REQUIRED);
  }
  return ok({ members });
}

export function observeCandidateMembers(root, files = []) {
  const hashed = hashMemberList(root, files, 'trusted collector could not read candidate artifact bytes', 'artifact-bytes');
  if (!hashed.ok) return hashed;
  const members = hashed.details.members;
  return ok({
    files: [...files],
    candidate_members: members,
    members,
    accepted_paths_vs_main: files.map((file) => ({
      path: file,
      main: members[file],
      candidate: members[file],
    })),
    observed: true,
    source: 'artifact-bytes',
  });
}

function resolveOriginMainSha(git) {
  for (const ref of ['refs/remotes/origin/main', 'origin/main']) {
    try {
      const sha = gitText(git, ['rev-parse', '--verify', ref]);
      if (GIT_SHA_RE.test(sha)) return sha;
    } catch {
      /* try the next observed ref */
    }
  }
  const envSha = String(process.env.GITHUB_BASE_SHA || '').trim();
  if (GIT_SHA_RE.test(envSha)) {
    try {
      gitText(git, ['cat-file', '-e', `${envSha}^{commit}`]);
      return envSha;
    } catch {
      /* object is not in this repository */
    }
  }
  return null;
}

export function observeGitAncestry(root, { commit, run } = {}) {
  const git = run || defaultGitRunner(root);
  const currentMain = resolveOriginMainSha(git);
  if (!currentMain) {
    return failMany([errorEntry(
      CODES.MAIN_RECONCILIATION_REQUIRED,
      'trusted collector could not resolve origin/main via git rev-parse',
      { source: 'git-merge-base' },
    )], CODES.MAIN_RECONCILIATION_REQUIRED);
  }
  let head;
  try {
    head = gitText(git, ['rev-parse', 'HEAD']);
  } catch {
    return failMany([errorEntry(
      CODES.MAIN_RECONCILIATION_REQUIRED,
      'trusted collector could not resolve HEAD via git rev-parse',
      { source: 'git-merge-base' },
    )], CODES.MAIN_RECONCILIATION_REQUIRED);
  }
  const tip = GIT_SHA_RE.test(String(commit || '')) ? String(commit) : head;
  let mergeBase;
  try {
    mergeBase = gitText(git, ['merge-base', head, currentMain]);
  } catch {
    return failMany([errorEntry(
      CODES.MAIN_RECONCILIATION_REQUIRED,
      'trusted collector could not compute git merge-base against origin/main',
      { source: 'git-merge-base', current_main_sha: currentMain, worktree_head: head },
    )], CODES.MAIN_RECONCILIATION_REQUIRED);
  }
  let isAncestor = false;
  try {
    gitText(git, ['merge-base', '--is-ancestor', currentMain, head]);
    isAncestor = true;
  } catch {
    isAncestor = false;
  }
  if (!GIT_SHA_RE.test(currentMain) || !GIT_SHA_RE.test(mergeBase) || !GIT_SHA_RE.test(head)) {
    return failMany([errorEntry(
      CODES.MAIN_RECONCILIATION_REQUIRED,
      'trusted collector git SHAs must be 40-character hex',
      { current_main_sha: currentMain, merge_base_sha: mergeBase, worktree_head: head },
    )], CODES.MAIN_RECONCILIATION_REQUIRED);
  }
  return ok({
    git_ancestry: {
      method: 'git-merge-base',
      is_ancestor: isAncestor,
      current_main_sha: currentMain,
      merge_base_sha: mergeBase,
      worktree_head: head,
      source: 'git-merge-base',
      observed: true,
    },
    current_main_sha: currentMain,
    merge_base_sha: mergeBase,
    worktree_head: head,
    commit: tip,
    observed: true,
    source: 'git-merge-base',
  });
}

function hashGitPath(run, rev, file) {
  try {
    return hashBytes(run(['show', `${rev}:${file}`], 'buffer'));
  } catch {
    return null;
  }
}

function artifactRecord(input = {}) {
  const direct = input.deployment_artifact || input.candidate_artifact;
  if (direct && typeof direct === 'object') return direct;
  return null;
}

function baselineRecord(input = {}) {
  const direct = input.live_baseline;
  if (direct && typeof direct === 'object') return direct;
  return null;
}

function capturedFingerprint(input = {}, explicit) {
  if (explicit && typeof explicit === 'object') return explicit;
  return input.immediately_before
    || input.immediately_before_fingerprint
    || input.preflight
    || input.preflight_live_fingerprint
    || null;
}

function artifactCommitOf(artifact) {
  return String(artifact.commit || artifact.source_commit || artifact.built_from_commit || '').trim();
}

function artifactPathOf(artifact) {
  return String(artifact.path || artifact.file || artifact.zip || '').trim();
}

export function evaluateArtifactCommitBinding(artifact, commit) {
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    return failMany([errorEntry(
      CODES.SOURCE_COMPOSITION_REQUIRED,
      'candidate evidence requires the exact deployment artifact (Lambda ZIP or SPA) bound to the declared commit; hashing repository source is not proof',
    )], CODES.SOURCE_COMPOSITION_REQUIRED);
  }
  const declared = String(commit || '').trim();
  const artifactCommit = artifactCommitOf(artifact);
  if (!GIT_SHA_RE.test(declared) || artifactCommit !== declared) {
    return failMany([errorEntry(
      CODES.SOURCE_COMPOSITION_REQUIRED,
      'deployment artifact is not bound to the declared commit',
      { artifact_commit: artifactCommit || null, declared_commit: declared || null },
    )], CODES.SOURCE_COMPOSITION_REQUIRED);
  }
  const artifactPath = artifactPathOf(artifact);
  if (!artifactPath) {
    return failMany([errorEntry(
      CODES.SOURCE_COMPOSITION_REQUIRED,
      'deployment artifact path is required; repository source cannot substitute for the Lambda ZIP or SPA being deployed',
    )], CODES.SOURCE_COMPOSITION_REQUIRED);
  }
  return ok({ artifact, commit: declared, path: artifactPath });
}

export function observeDeploymentArtifactMembers({
  artifact,
  files = [],
  commit,
  root,
} = {}) {
  const binding = evaluateArtifactCommitBinding(artifact, commit);
  if (!binding.ok) return binding;
  const artifactPath = path.resolve(binding.details.path);
  if (!fs.existsSync(artifactPath)) {
    return failMany([errorEntry(
      CODES.SOURCE_COMPOSITION_REQUIRED,
      'deployment artifact path does not exist',
      { path: artifactPath },
    )], CODES.SOURCE_COMPOSITION_REQUIRED);
  }
  if (root && !isZipFile(artifactPath) && path.resolve(root) === artifactPath) {
    return failMany([errorEntry(
      CODES.SOURCE_COMPOSITION_REQUIRED,
      'repository source is not a deployment artifact; hash the Lambda ZIP or SPA being deployed',
      { path: artifactPath },
    )], CODES.SOURCE_COMPOSITION_REQUIRED);
  }
  const hashed = hashMemberList(
    artifactPath,
    files,
    'trusted collector could not read candidate members from the deployment artifact',
    'deployment-artifact',
  );
  if (!hashed.ok) return hashed;
  return ok({
    files: [...files],
    candidate_members: hashed.details.members,
    members: hashed.details.members,
    artifact_path: artifactPath,
    artifact_commit: binding.details.commit,
    observed: true,
    source: 'deployment-artifact',
  });
}

export function verifyLiveBaselineFingerprint(baseline, expected) {
  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) {
    return failMany([errorEntry(
      CODES.SOURCE_COMPOSITION_REQUIRED,
      'live member hashes require a freshly captured deployment baseline; missing live evidence fails closed',
    )], CODES.SOURCE_COMPOSITION_REQUIRED);
  }
  const origin = String(baseline.origin || '').trim();
  if (origin !== 'fresh-live-download') {
    return failMany([errorEntry(
      CODES.SOURCE_COMPOSITION_REQUIRED,
      'live baseline origin must be fresh-live-download; missing live evidence fails closed',
      { origin: origin || null },
    )], CODES.SOURCE_COMPOSITION_REQUIRED);
  }
  const fp = baseline.fingerprint || baseline.live_fingerprint;
  if (!fp || typeof fp !== 'object' || Array.isArray(fp)) {
    return failMany([errorEntry(
      CODES.SOURCE_COMPOSITION_REQUIRED,
      'fresh live baseline requires a fingerprint; missing live evidence fails closed',
    )], CODES.SOURCE_COMPOSITION_REQUIRED);
  }
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
    return failMany([errorEntry(
      CODES.DEPLOYMENT_COLLISION,
      'live baseline fingerprint cannot be verified without the captured live fingerprint',
    )], CODES.DEPLOYMENT_COLLISION);
  }
  const compared = [];
  const mismatched = [];
  for (const key of FINGERPRINT_ID_FIELDS) {
    if (fp[key] == null || fp[key] === '' || expected[key] == null || expected[key] === '') continue;
    compared.push(key);
    if (String(fp[key]) !== String(expected[key])) mismatched.push(key);
  }
  if (!compared.length) {
    return failMany([errorEntry(
      CODES.DEPLOYMENT_COLLISION,
      'live baseline fingerprint has no overlapping identifying fields with the captured live fingerprint',
    )], CODES.DEPLOYMENT_COLLISION);
  }
  if (mismatched.length) {
    return failMany([errorEntry(
      CODES.DEPLOYMENT_COLLISION,
      'live baseline fingerprint does not match the freshly captured live fingerprint',
      { mismatched_fingerprint_fields: mismatched },
    )], CODES.DEPLOYMENT_COLLISION);
  }
  return ok({ fingerprint: fp, verified: true, compared_fields: compared });
}

export function observeLiveBaselineMembers({
  baseline,
  files = [],
  fingerprint,
} = {}) {
  const verified = verifyLiveBaselineFingerprint(baseline, fingerprint);
  if (!verified.ok) return verified;
  const baselinePath = String(baseline.path || baseline.file || baseline.zip || '').trim();
  if (!baselinePath) {
    return failMany([errorEntry(
      CODES.SOURCE_COMPOSITION_REQUIRED,
      'live baseline path is required; missing live evidence fails closed',
    )], CODES.SOURCE_COMPOSITION_REQUIRED);
  }
  const abs = path.resolve(baselinePath);
  if (!fs.existsSync(abs)) {
    return failMany([errorEntry(
      CODES.SOURCE_COMPOSITION_REQUIRED,
      'live baseline path does not exist; missing live evidence fails closed',
      { path: abs },
    )], CODES.SOURCE_COMPOSITION_REQUIRED);
  }
  const hashed = hashMemberList(
    abs,
    files,
    'trusted collector could not read live members from the freshly captured deployment baseline',
    'fresh-live-baseline',
  );
  if (!hashed.ok) return hashed;
  return ok({
    files: [...files],
    live_members: hashed.details.members,
    members: hashed.details.members,
    baseline_path: abs,
    fingerprint: verified.details.fingerprint,
    fingerprint_verified: true,
    observed: true,
    source: 'fresh-live-baseline',
  });
}

export function observePreserveEvidence({
  root,
  registry,
  deployment_type,
  commit,
  run,
  live_baseline,
  deployment_artifact,
  fingerprint,
  input,
} = {}) {
  if (!root) {
    return failMany([errorEntry(
      CODES.SOURCE_COMPOSITION_REQUIRED,
      'trusted collector requires a repository root to observe artifact bytes and git ancestry',
    )], CODES.SOURCE_COMPOSITION_REQUIRED);
  }
  const files = requiredPreservedPaths(registry || { manifests: [] }, { deployment_type });
  const artifact = deployment_artifact || artifactRecord(input || {});
  const baseline = live_baseline || baselineRecord(input || {});
  const expectedFingerprint = capturedFingerprint(input || {}, fingerprint);
  const declaredCommit = String(commit || input?.commit || '').trim();

  if (files.length) {
    const artifacts = observeDeploymentArtifactMembers({
      artifact,
      files,
      commit: declaredCommit,
      root,
    });
    if (!artifacts.ok) return artifacts;
    const live = observeLiveBaselineMembers({
      baseline,
      files,
      fingerprint: expectedFingerprint,
    });
    if (!live.ok) return live;
    const ancestry = observeGitAncestry(root, { commit: declaredCommit, run });
    if (!ancestry.ok) return ancestry;
    const git = run || defaultGitRunner(root);
    const accepted_paths_vs_main = files.map((file) => ({
      path: file,
      main: hashGitPath(git, ancestry.details.current_main_sha, file),
      candidate: artifacts.details.candidate_members[file],
    }));
    return ok({
      files,
      candidate_members: artifacts.details.candidate_members,
      live_members: live.details.live_members,
      accepted_paths_vs_main,
      git_ancestry: ancestry.details.git_ancestry,
      current_main_sha: ancestry.details.current_main_sha,
      merge_base_sha: ancestry.details.merge_base_sha,
      worktree_head: ancestry.details.worktree_head,
      observed: true,
      candidate_source: 'deployment-artifact',
      live_source: 'fresh-live-baseline',
      ancestry_source: 'git-merge-base',
      artifact_commit: artifacts.details.artifact_commit,
      fingerprint_verified: true,
      collector: 'scripts/deployment-guard/lib/observe.mjs',
    });
  }

  const ancestry = observeGitAncestry(root, { commit: declaredCommit, run });
  if (!ancestry.ok) return ancestry;
  return ok({
    files,
    candidate_members: {},
    live_members: {},
    accepted_paths_vs_main: [],
    git_ancestry: ancestry.details.git_ancestry,
    current_main_sha: ancestry.details.current_main_sha,
    merge_base_sha: ancestry.details.merge_base_sha,
    worktree_head: ancestry.details.worktree_head,
    observed: true,
    candidate_source: 'deployment-artifact',
    live_source: 'fresh-live-baseline',
    ancestry_source: 'git-merge-base',
    collector: 'scripts/deployment-guard/lib/observe.mjs',
  });
}

export function bindObservedInput(input, observed) {
  return {
    ...input,
    candidate_members: observed.candidate_members,
    live_members: observed.live_members,
    git_ancestry: observed.git_ancestry,
    current_main_sha: observed.current_main_sha,
    merge_base_sha: observed.merge_base_sha,
    accepted_paths_vs_main: observed.accepted_paths_vs_main,
    source_composition_manifest: {
      ...(input.source_composition_manifest || {}),
      files: observed.files,
      members: observed.candidate_members,
    },
  };
}

export function evaluateObservationBinding(input = {}, observation) {
  if (!observation || observation.ok !== true
    || observation.details?.candidate_source !== 'deployment-artifact'
    || observation.details?.live_source !== 'fresh-live-baseline'
    || observation.details?.ancestry_source !== 'git-merge-base') {
    return failMany([errorEntry(
      CODES.SOURCE_COMPOSITION_REQUIRED,
      'official mutating evaluate requires trusted collector observation of the deployment artifact, fresh live baseline, and git-merge-base',
    )], CODES.SOURCE_COMPOSITION_REQUIRED);
  }
  const observed = observation.details;
  const errors = [];
  const callerMembers = {
    ...(input.candidate_members || {}),
    ...(input.source_composition_manifest?.members || {}),
    ...(input.source_composition_manifest?.hashes || {}),
  };
  const fabricatedHashes = [];
  for (const [file, digest] of Object.entries(callerMembers)) {
    if (digest == null || digest === '') continue;
    if (observed.candidate_members[file] !== String(digest)) {
      fabricatedHashes.push(file);
    }
  }
  if (fabricatedHashes.length) {
    errors.push(errorEntry(
      CODES.SOURCE_COMPOSITION_REQUIRED,
      'caller-supplied candidate hashes do not match observed deployment-artifact bytes; JSON cannot substitute for the trusted collector',
      { fabricated_member_hashes: fabricatedHashes, source: 'deployment-artifact' },
    ));
  }

  const callerLive = input.live_members && typeof input.live_members === 'object' ? input.live_members : {};
  const fabricatedLive = [];
  for (const [file, digest] of Object.entries(callerLive)) {
    if (digest == null || digest === '') continue;
    if (observed.live_members[file] !== String(digest)) {
      fabricatedLive.push(file);
    }
  }
  if (fabricatedLive.length) {
    errors.push(errorEntry(
      CODES.SOURCE_COMPOSITION_REQUIRED,
      'caller-supplied live hashes do not match the freshly captured deployment baseline; JSON cannot substitute for live evidence',
      { fabricated_live_hashes: fabricatedLive, source: 'fresh-live-baseline' },
    ));
  }

  const callerAncestry = input.git_ancestry || input.ancestry;
  if (callerAncestry && typeof callerAncestry === 'object') {
    const obs = observed.git_ancestry;
    const mismatch = ['method', 'is_ancestor', 'current_main_sha', 'merge_base_sha']
      .some((field) => callerAncestry[field] != null && String(callerAncestry[field]) !== String(obs[field]));
    if (mismatch) {
      errors.push(errorEntry(
        CODES.MAIN_RECONCILIATION_REQUIRED,
        'caller-supplied git ancestry does not match git-merge-base observation; JSON cannot substitute for Git commands',
        { source: 'git-merge-base' },
      ));
    }
  }
  if (input.current_main_sha && String(input.current_main_sha) !== observed.current_main_sha) {
    errors.push(errorEntry(
      CODES.MAIN_RECONCILIATION_REQUIRED,
      'caller-supplied current_main_sha does not match git rev-parse origin/main',
      { caller: input.current_main_sha, observed: observed.current_main_sha },
    ));
  }
  if (input.merge_base_sha && String(input.merge_base_sha) !== observed.merge_base_sha) {
    errors.push(errorEntry(
      CODES.MAIN_RECONCILIATION_REQUIRED,
      'caller-supplied merge_base_sha does not match git merge-base',
      { caller: input.merge_base_sha, observed: observed.merge_base_sha },
    ));
  }
  if (errors.length) return failMany(errors, errors[0].code);
  return ok({
    bound: bindObservedInput(input, observed),
    observation: observed,
  });
}

export function applyOfficialObservation(input = {}, ctx = {}) {
  const observed = ctx.trusted_observation && ctx.trusted_observation.ok === true
    ? ctx.trusted_observation
    : observePreserveEvidence({
      root: ctx.root,
      registry: ctx.compositionRegistry,
      deployment_type: input.deployment_type,
      commit: input.commit,
      run: ctx.git,
      live_baseline: input.live_baseline || ctx.live_baseline,
      deployment_artifact: input.deployment_artifact || input.candidate_artifact || ctx.deployment_artifact,
      fingerprint: capturedFingerprint(input),
      input,
    });
  if (!observed.ok) return observed;
  return evaluateObservationBinding(input, observed);
}
