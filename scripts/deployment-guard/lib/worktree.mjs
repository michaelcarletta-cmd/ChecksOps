import { CODES, errorEntry, failMany, ok } from './errors.mjs';

const MAIN_BRANCHES = new Set(['main', 'master']);

export function normalizeWorktreePath(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.replace(/\/+$/, '');
}

export function isCursorIndependentWorkstream(input = {}) {
  const workstream = String(input.workstream_id || '').toLowerCase();
  const branch = String(input.branch || '').toLowerCase();
  const operator = String(input.operator || '').toLowerCase();
  if (input.independent_task === true || input.cursor_chat === true) return true;
  if (workstream.startsWith('cursor/') || workstream.startsWith('cursor-')) return true;
  if (branch.startsWith('cursor/')) return true;
  if (operator.includes('cursor') || operator.includes('agent')) return true;
  return false;
}

export function evaluateWorktreeIsolation(input = {}) {
  const errors = [];
  const workstreamId = String(input.workstream_id || '').trim();
  const branch = String(input.branch || '').trim();
  const worktree = normalizeWorktreePath(input.worktree || input.worktree_path);
  const peers = Array.isArray(input.peer_workstreams) ? input.peer_workstreams : [];

  if (!workstreamId) {
    errors.push(errorEntry(CODES.ANONYMOUS_DEPLOYMENT, 'worktree isolation requires workstream_id'));
  }
  if (!branch) {
    errors.push(errorEntry(CODES.WORKTREE_ISOLATION_REQUIRED, 'independent tasks require a dedicated git branch'));
  }
  if (input.shared_worktree === true || input.shared_dirty_tree === true) {
    errors.push(errorEntry(
      CODES.WORKTREE_ISOLATION_REQUIRED,
      'independent tasks may not share a dirty worktree; use a separate worktree',
      { workstream_id: workstreamId, worktree: worktree || null },
    ));
  }

  const mutating = input.deployment_type && input.deployment_type !== 'verify-only';
  if (mutating && isCursorIndependentWorkstream(input) && MAIN_BRANCHES.has(branch)) {
    errors.push(errorEntry(
      CODES.WORKTREE_ISOLATION_REQUIRED,
      'independent Cursor chats must not deploy from main; use a separate branch and worktree',
      { branch, workstream_id: workstreamId },
    ));
  }

  const dirty = Array.isArray(input.dirty_unrelated_paths) ? input.dirty_unrelated_paths.filter(Boolean) : [];
  if (dirty.length) {
    errors.push(errorEntry(
      CODES.UNRELATED_MUTATION,
      'worktree contains dirty unrelated paths from another change; do not commit or deploy them',
      { dirty_unrelated_paths: dirty },
    ));
  }

  for (const peer of peers) {
    if (!peer || peer.workstream_id === workstreamId) continue;
    const peerBranch = String(peer.branch || '').trim();
    const peerWorktree = normalizeWorktreePath(peer.worktree || peer.worktree_path);
    if (peerBranch && branch && peerBranch === branch) {
      errors.push(errorEntry(
        CODES.WORKTREE_ISOLATION_REQUIRED,
        `independent workstreams ${workstreamId} and ${peer.workstream_id} share branch ${branch}`,
        { branch, workstreams: [workstreamId, peer.workstream_id] },
      ));
    }
    if (peerWorktree && worktree && peerWorktree === worktree) {
      errors.push(errorEntry(
        CODES.WORKTREE_ISOLATION_REQUIRED,
        `independent workstreams ${workstreamId} and ${peer.workstream_id} share worktree ${worktree}`,
        { worktree, workstreams: [workstreamId, peer.workstream_id] },
      ));
    }
  }

  if (errors.length) return failMany(errors, errors[0].code);
  return ok({
    workstream_id: workstreamId,
    branch,
    worktree: worktree || null,
    isolated: true,
  });
}
