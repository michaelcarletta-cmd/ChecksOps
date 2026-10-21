#!/usr/bin/env node
// Claude Code SessionStart hook for ChecksOps (wired in .claude/settings.json).
//
// Prints a short briefing that becomes session context, so a desktop session starts
// from the same facts a cloud session is handed: which branch and commit, whether the
// branch is behind origin/main, whether the checkout is LF, whether the test
// dependencies are installed, and which checks CI will run. It writes nothing, and
// everything in it is read-only. Anything unexpected (no git, no network) prints what it
// could learn and exits 0: this is a briefing, not a gate.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();

function run(cmd, args, { timeout = 8000 } = {}) {
  try {
    return execFileSync(cmd, args, { cwd: root, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

const lines = [];
const warn = (text) => lines.push(`  ! ${text}`);

const branch = run('git', ['branch', '--show-current']) || '(detached)';
const head = run('git', ['rev-parse', '--short=12', 'HEAD']) || '?';
lines.push(`ChecksOps session brief: branch ${branch} @ ${head}`);

// Freshness against origin/main (a fetch is read-only; skipped silently when offline).
run('git', ['fetch', '--quiet', 'origin', 'main'], { timeout: 15000 });
const counts = run('git', ['rev-list', '--left-right', '--count', 'origin/main...HEAD']);
if (counts) {
  const [behind, ahead] = counts.split(/\s+/).map(Number);
  lines.push(`  origin/main: ${behind} commit(s) ahead of this branch, this branch ${ahead} ahead of it`);
  if (branch === 'main') warn('you are on main. Work on a new branch from origin/main; never commit on main.');
  if (behind > 0 && branch !== 'main') warn(`this branch is ${behind} behind origin/main. Merge origin/main in (never rebase a pushed branch) before changing pins, locks or hashes.`);
} else {
  warn('origin/main could not be fetched; comparisons against main are unavailable this session.');
}

// Line endings: every pinned hash is sha256 of LF bytes.
const autocrlf = run('git', ['config', '--get', 'core.autocrlf']);
if (autocrlf === 'true') warn('core.autocrlf=true: pinned hashes will not match locally. Run `git config core.autocrlf false` and re-checkout.');
const eol = run('git', ['ls-files', '--eol', '--', 'aws', 'ops', 'scripts', 'supabase']) || '';
const crlf = eol.split('\n').filter((l) => /\sw\/crlf\s/.test(l)).length;
if (crlf) warn(`${crlf} tracked file(s) under aws/, ops/, scripts/ or supabase/ have CRLF in the working tree; hashes computed from them are wrong.`);

// Working tree state: changes to tracked files are work in progress; untracked files are
// leftovers or new files that git does not know about yet. Ignored files are not counted.
const changed = (run('git', ['status', '--porcelain', '--untracked-files=no']) || '').split('\n').filter(Boolean);
const untracked = (run('git', ['ls-files', '--others', '--exclude-standard', '--directory']) || '').split('\n').filter(Boolean);
if (changed.length) lines.push(`  working tree: ${changed.length} tracked file(s) with uncommitted changes`);
if (untracked.length) {
  const shown = untracked.slice(0, 3).join(', ');
  lines.push(`  untracked, not in git (leftovers or new files, never committed unless added): ${shown}${untracked.length > 3 ? `, and ${untracked.length - 3} more` : ''}`);
}

// Open PR for this branch (best effort; gh may be absent or signed out).
if (branch !== 'main' && branch !== '(detached)') {
  const pr = run('gh', ['pr', 'view', '--json', 'number,state,isDraft,mergeable,url', '--jq', '"#\\(.number) \\(.state)\\(if .isDraft then " draft" else "" end) mergeable=\\(.mergeable) \\(.url)"'], { timeout: 10000 });
  if (pr) lines.push(`  open PR: ${pr}`);
}

// Test dependencies: CI installs these before `bun run test:aws-api`.
const missing = [];
if (!fs.existsSync(path.join(root, 'node_modules'))) missing.push('`bun install --frozen-lockfile` (root)');
if (!fs.existsSync(path.join(root, 'aws/functions/api/node_modules'))) missing.push('`npm ci --prefix aws/functions/api`');
if (missing.length) lines.push(`  test deps not installed: ${missing.join(', ')}`);
const node = process.version;
if (!/^v2[0-9]\./.test(node)) warn(`node ${node}: CI runs Node 20+; --experimental-strip-types needs 22.6+.`);

lines.push('  before pushing: node scripts/validate-release-locks.mjs; node --experimental-strip-types --test aws/tests/*.test.mjs');
lines.push('  hashes: node scripts/hash-report.mjs [key|--file p|--hash h]; skills: /verify /hashes /ci-triage /guarded-step /merge-pr /steward');
lines.push('  rules: CLAUDE.md and AGENTS.md (append-only migrations and pins; no direct deploys; approval per run, verbatim).');

process.stdout.write(`${lines.join('\n')}\n`);
process.exit(0);
