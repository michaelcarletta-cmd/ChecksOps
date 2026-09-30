/**
 * Trusted collector for official mutating evaluates.
 *
 * Candidate hashes come from artifact bytes on disk. Ancestry comes from
 * git rev-parse / merge-base / merge-base --is-ancestor. Caller JSON is
 * never treated as an observation.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CODES, errorEntry, failMany, ok } from './errors.mjs';
import { requiredPreservedPaths } from './source-composition.mjs';

const GIT_SHA_RE = /^[0-9a-f]{40}$/;

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

export function hashFileBytes(root, rel) {
  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, rel);
  const relative = path.relative(rootAbs, abs);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`path escapes repository root: ${rel}`);
  }
  return hashBytes(fs.readFileSync(abs));
}

export function observeCandidateMembers(root, files = []) {
  const members = {};
  const missing = [];
  for (const file of files) {
    try {
      members[file] = hashFileBytes(root, file);
    } catch {
      missing.push(file);
    }
  }
  if (missing.length) {
    return failMany([errorEntry(
      CODES.SOURCE_COMPOSITION_REQUIRED,
      'trusted collector could not read candidate artifact bytes',
      { missing_artifacts: missing, source: 'artifact-bytes' },
    )], CODES.SOURCE_COMPOSITION_REQUIRED);
  }
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

export function observePreserveEvidence({
  root,
  registry,
  deployment_type,
  commit,
  run,
} = {}) {
  if (!root) {
    return failMany([errorEntry(
      CODES.SOURCE_COMPOSITION_REQUIRED,
      'trusted collector requires a repository root to observe artifact bytes and git ancestry',
    )], CODES.SOURCE_COMPOSITION_REQUIRED);
  }
  const files = requiredPreservedPaths(registry || { manifests: [] }, { deployment_type });
  const artifacts = observeCandidateMembers(root, files);
  if (!artifacts.ok) return artifacts;
  const ancestry = observeGitAncestry(root, { commit, run });
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
    live_members: { ...artifacts.details.candidate_members },
    accepted_paths_vs_main,
    git_ancestry: ancestry.details.git_ancestry,
    current_main_sha: ancestry.details.current_main_sha,
    merge_base_sha: ancestry.details.merge_base_sha,
    worktree_head: ancestry.details.worktree_head,
    observed: true,
    candidate_source: 'artifact-bytes',
    ancestry_source: 'git-merge-base',
    collector: 'scripts/deployment-guard/lib/observe.mjs',
  });
}

export function bindObservedInput(input, observed) {
  const liveProvided = input.live_members && typeof input.live_members === 'object'
    && Object.keys(input.live_members).length > 0;
  return {
    ...input,
    candidate_members: observed.candidate_members,
    live_members: liveProvided ? input.live_members : observed.live_members,
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
  if (!observation || observation.ok !== true || observation.details?.candidate_source !== 'artifact-bytes'
    || observation.details?.ancestry_source !== 'git-merge-base') {
    return failMany([errorEntry(
      CODES.SOURCE_COMPOSITION_REQUIRED,
      'official mutating evaluate requires trusted collector observation of artifact bytes and git-merge-base',
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
      'caller-supplied candidate hashes do not match observed artifact bytes; JSON cannot substitute for the trusted collector',
      { fabricated_member_hashes: fabricatedHashes, source: 'artifact-bytes' },
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
    });
  if (!observed.ok) return observed;
  return evaluateObservationBinding(input, observed);
}
