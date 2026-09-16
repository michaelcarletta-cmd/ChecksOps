#!/usr/bin/env node
/**
 * Fail-closed overlap check: a workstream cannot silently take ownership of
 * protected files already changed in another open PR.
 *
 * Usage:
 *   node scripts/check-pr-path-overlap.mjs
 *   node scripts/check-pr-path-overlap.mjs --changed-files <list-file>
 *   node scripts/check-pr-path-overlap.mjs --require
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_PATHS,
  loadJson,
  matchProtectedPath,
  repoRootFrom,
} from './lib/release-locks.mjs';

function gitChangedFiles(root) {
  const base = process.env.RELEASE_LOCK_BASE_SHA
    || process.env.GITHUB_BASE_SHA
    || 'origin/main';
  try {
    const out = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], {
      cwd: root,
      encoding: 'utf8',
    });
    return out.split('\n').map((line) => line.trim()).filter(Boolean);
  } catch (error) {
    throw new Error(`unable to list changed files against ${base}: ${error.message}`);
  }
}

function parseChangedFilesArg(argv, root) {
  const idx = argv.indexOf('--changed-files');
  if (idx >= 0 && argv[idx + 1]) {
    const file = path.resolve(root, argv[idx + 1]);
    return fs.readFileSync(file, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean);
  }
  return null;
}

function currentPrNumber() {
  const ref = process.env.GITHUB_REF || '';
  const match = ref.match(/refs\/pull\/(\d+)\//);
  if (match) return Number(match[1]);
  if (process.env.GITHUB_PR_NUMBER) return Number(process.env.GITHUB_PR_NUMBER);
  return null;
}

function ghAvailable() {
  try {
    execFileSync('gh', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function listOpenPrFiles() {
  const raw = execFileSync(
    'gh',
    ['pr', 'list', '--state', 'open', '--limit', '200', '--json', 'number,title,headRefName,files,isDraft'],
    { encoding: 'utf8' },
  );
  const prs = JSON.parse(raw);
  return prs.map((pr) => ({
    number: pr.number,
    title: pr.title,
    headRefName: pr.headRefName,
    isDraft: pr.isDraft,
    files: (pr.files || []).map((file) => file.path || file).filter(Boolean),
  }));
}

export function overlapHits({ changedFiles, openPrs, protectedPaths, allowlist, currentPr }) {
  const hits = [];
  const allow = allowlist.allow || [];
  for (const rel of changedFiles) {
    const matches = matchProtectedPath(rel, protectedPaths);
    if (!matches.length) continue;
    for (const pr of openPrs) {
      if (currentPr && pr.number === currentPr) continue;
      if (!(pr.files || []).includes(rel)) continue;
      const allowed = allow.some((row) => (
        row.other_pr === pr.number
        && typeof row.path === 'string'
        && (rel === row.path || rel.startsWith(row.path))
        && typeof row.reason === 'string'
        && row.reason.trim().length >= 20
      ));
      if (allowed) continue;
      hits.push({
        path: rel,
        groups: matches.map((m) => m.groupId),
        other_pr: pr.number,
        other_title: pr.title,
        other_branch: pr.headRefName,
      });
    }
  }
  return hits;
}

export function main(argv = process.argv.slice(2), root = repoRootFrom(import.meta.url)) {
  const required = argv.includes('--require')
    || process.env.GITHUB_ACTIONS === 'true'
    || process.env.RELEASE_LOCK_REQUIRE_OVERLAP === '1';
  const protectedPaths = loadJson(path.join(root, DEFAULT_PATHS.protectedPaths));
  const allowlist = loadJson(path.join(root, DEFAULT_PATHS.overlapAllowlist));
  if (allowlist.fail_closed !== true) {
    console.error('overlap check: allowlist.fail_closed must be true');
    return 2;
  }
  let changedFiles;
  try {
    changedFiles = parseChangedFilesArg(argv, root) || gitChangedFiles(root);
  } catch (error) {
    console.error(`overlap check failed closed: ${error.message}`);
    return 2;
  }
  const protectedChanged = changedFiles.filter((rel) => matchProtectedPath(rel, protectedPaths).length > 0);
  if (protectedChanged.length === 0) {
    console.log('overlap check: no protected paths changed');
    return 0;
  }
  if (!ghAvailable()) {
    const message = 'overlap check: gh CLI unavailable; cannot prove other open PRs do not own these protected paths';
    if (required) {
      console.error(message);
      return 2;
    }
    console.error(`${message} (advisory locally; CI is fail-closed)`);
    return 0;
  }
  let openPrs;
  try {
    openPrs = listOpenPrFiles();
  } catch (error) {
    console.error(`overlap check failed closed: unable to list open PRs (${error.message})`);
    return 2;
  }
  const hits = overlapHits({
    changedFiles: protectedChanged,
    openPrs,
    protectedPaths,
    allowlist,
    currentPr: currentPrNumber(),
  });
  if (hits.length) {
    console.error('overlap check failed: protected paths are already owned by another open PR');
    for (const hit of hits) {
      console.error(`  ${hit.path} (${hit.groups.join(',')}) also in PR #${hit.other_pr} (${hit.other_branch}) ${hit.other_title}`);
    }
    console.error('Add an explicit reviewed exception to ops/release-locks/overlap-allowlist.json or wait for the other PR.');
    return 1;
  }
  console.log(`overlap check: ok (${protectedChanged.length} protected path(s), ${openPrs.length} open PRs scanned)`);
  return 0;
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  process.exitCode = main();
}
