// The Claude Code SessionStart hook (.claude/hooks/session-brief.mjs) prints a read-only
// briefing: it tells tracked work in progress apart from untracked leftovers, leaves ignored
// scratch out, and always exits 0. The repository ignores Claude's scratch and personal files.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BRIEF = path.join(ROOT, '.claude/hooks/session-brief.mjs');
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-brief-'));
  git(dir, 'init', '-q', '-b', 'claude/x');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.claude/tmp/\n');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', '.');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  return dir;
}

function brief(dir) {
  const r = spawnSync(process.execPath, [BRIEF], { cwd: dir, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: dir }, timeout: 60000 });
  return { code: r.status, out: r.stdout };
}

test('tracked changes and untracked leftovers are reported separately; ignored scratch is not', () => {
  const dir = repo();
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
    fs.writeFileSync(path.join(dir, '$SCRIPT_FILE'), 'leftover\n');
    fs.mkdirSync(path.join(dir, '.claude/tmp'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude/tmp/scratch.txt'), 'x\n');
    const { code, out } = brief(dir);
    assert.equal(code, 0, out);
    assert.match(out, /^ChecksOps session brief: branch claude\/x @ /m);
    assert.match(out, /working tree: 1 tracked file\(s\) with uncommitted changes/);
    assert.match(out, /untracked, not in git .*\$SCRIPT_FILE/);
    assert.doesNotMatch(out, /\.claude\/tmp/);
    assert.doesNotMatch(out, /uncommitted path/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a clean checkout reports no working-tree lines, and the brief always exits 0', () => {
  const dir = repo();
  try {
    const { code, out } = brief(dir);
    assert.equal(code, 0, out);
    assert.doesNotMatch(out, /working tree:|untracked, not in git/);
    // origin/main cannot be fetched here: a warning, never a failure.
    assert.match(out, /origin\/main could not be fetched/);
    assert.match(out, /before pushing: node scripts\/validate-release-locks\.mjs/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the repository ignores Claude Code scratch space and personal settings', () => {
  for (const rel of ['.claude/tmp/scratch.txt', '.claude/settings.local.json']) {
    assert.equal(spawnSync('git', ['-C', ROOT, 'check-ignore', '-q', '--no-index', rel]).status, 0, rel);
  }
  // The shared settings, hooks and skills stay tracked.
  for (const rel of ['.claude/settings.json', '.claude/hooks/session-brief.mjs', '.claude/skills/hashes/SKILL.md']) {
    assert.notEqual(spawnSync('git', ['-C', ROOT, 'check-ignore', '-q', '--no-index', rel]).status, 0, rel);
  }
});
