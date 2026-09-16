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
  allowlistCovers,
  allowlistErrors,
  collectPaginated,
  loadJson,
  matchProtectedPath,
  parseGhApiIncludeOutput,
  repoRootFrom,
} from './lib/release-locks.mjs';

function gitChangedFiles(root, env = process.env) {
  const base = env.RELEASE_LOCK_BASE_SHA
    || env.GITHUB_BASE_SHA
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

export function resolveCurrentPrNumber(env = process.env, execFile = execFileSync) {
  if (env.GITHUB_PR_NUMBER && /^\d+$/.test(String(env.GITHUB_PR_NUMBER).trim())) {
    return Number(env.GITHUB_PR_NUMBER);
  }
  try {
    const raw = execFile('gh', ['pr', 'view', '--json', 'number'], { encoding: 'utf8' });
    const number = JSON.parse(raw)?.number;
    if (Number.isInteger(number) && number > 0) return number;
  } catch {
    return null;
  }
  return null;
}

export function detectGithubRepo(env = process.env, execFile = execFileSync, root = process.cwd()) {
  if (env.GITHUB_REPOSITORY && env.GITHUB_REPOSITORY.includes('/')) return env.GITHUB_REPOSITORY;
  try {
    const remote = execFile('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8' }).trim();
    const match = remote.match(/github\.com[:/](.+?)(?:\.git)?$/);
    if (match) return match[1];
  } catch {
    return null;
  }
  return null;
}

function ghAvailable(execFile = execFileSync) {
  try {
    execFile('gh', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function createGhFetchPage(execFile = execFileSync, { repo, pathTemplate } = {}) {
  return function fetchPage(page, pageSize) {
    try {
      const endpoint = pathTemplate(page, pageSize);
      const raw = execFile('gh', ['api', '--include', endpoint], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
      const parsed = parseGhApiIncludeOutput(raw);
      if (!parsed.status || parsed.status >= 400) {
        return { ok: false, error: `GitHub API ${parsed.status || 'failure'} for ${endpoint}` };
      }
      const items = JSON.parse(parsed.body);
      if (!Array.isArray(items)) {
        return { ok: false, error: `GitHub API returned a non-array page for ${endpoint}` };
      }
      const link = parsed.headers.link || '';
      const hasNext = /rel="next"/.test(link);
      return { ok: true, items, hasNext };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  };
}

export function listOpenPrsPaginated({
  fetchPrPage,
  fetchPrFilesPage,
  pageSize = 100,
  maxPages = 50,
  repo,
  execFile = execFileSync,
} = {}) {
  const prPage = fetchPrPage || createGhFetchPage(execFile, {
    repo,
    pathTemplate: (page, size) => `repos/${repo}/pulls?state=open&per_page=${size}&page=${page}`,
  });
  const { items: prs, complete } = collectPaginated({ fetchPage: prPage, pageSize, maxPages });
  if (!complete) {
    throw new Error('pagination not proven complete');
  }
  return prs.map((pr) => {
    const number = pr.number;
    const filesPage = fetchPrFilesPage
      ? (page, size) => fetchPrFilesPage(number, page, size)
      : createGhFetchPage(execFile, {
        repo,
        pathTemplate: (page, size) => `repos/${repo}/pulls/${number}/files?per_page=${size}&page=${page}`,
      });
    const { items: files } = collectPaginated({ fetchPage: filesPage, pageSize, maxPages });
    return {
      number,
      title: pr.title,
      headRefName: pr.head?.ref || pr.headRefName,
      isDraft: pr.draft === true || pr.isDraft === true,
      files: files.map((file) => file.path || file.filename || file).filter(Boolean),
    };
  });
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
      const allowed = allow.some((row) => allowlistCovers(row, rel, protectedPaths, pr.number));
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

export function main(argv = process.argv.slice(2), root = repoRootFrom(import.meta.url), deps = {}) {
  const env = deps.env || process.env;
  const execFile = deps.execFile || execFileSync;
  const required = argv.includes('--require')
    || env.GITHUB_ACTIONS === 'true'
    || env.RELEASE_LOCK_REQUIRE_OVERLAP === '1';
  const protectedPaths = loadJson(path.join(root, DEFAULT_PATHS.protectedPaths));
  const allowlist = loadJson(path.join(root, DEFAULT_PATHS.overlapAllowlist));
  const allowErrors = allowlistErrors(allowlist, protectedPaths);
  if (allowErrors.length) {
    console.error('overlap check: allowlist is invalid');
    for (const error of allowErrors) console.error(`  ${error}`);
    return 2;
  }
  let changedFiles;
  try {
    changedFiles = parseChangedFilesArg(argv, root) || gitChangedFiles(root, env);
  } catch (error) {
    console.error(`overlap check failed closed: ${error.message}`);
    return 2;
  }
  const protectedChanged = changedFiles.filter((rel) => matchProtectedPath(rel, protectedPaths).length > 0);
  if (protectedChanged.length === 0) {
    console.log('overlap check: no protected paths changed');
    return 0;
  }
  if (!ghAvailable(execFile) && !deps.fetchPrPage) {
    const message = 'overlap check: gh CLI unavailable; cannot prove other open PRs do not own these protected paths';
    if (required) {
      console.error(message);
      return 2;
    }
    console.error(`${message} (advisory locally; CI is fail-closed)`);
    return 0;
  }
  const currentPr = resolveCurrentPrNumber(env, execFile);
  if (required && currentPr == null) {
    console.error('overlap check failed closed: unable to resolve current PR number via GITHUB_PR_NUMBER or gh pr view --json number');
    return 2;
  }
  let openPrs;
  try {
    const repo = deps.repo || detectGithubRepo(env, execFile, root);
    if (!repo && !deps.fetchPrPage) {
      throw new Error('unable to determine GitHub repository for pagination');
    }
    openPrs = listOpenPrsPaginated({
      fetchPrPage: deps.fetchPrPage,
      fetchPrFilesPage: deps.fetchPrFilesPage,
      pageSize: deps.pageSize || 100,
      maxPages: deps.maxPages || 50,
      repo,
      execFile,
    });
  } catch (error) {
    console.error(`overlap check failed closed: unable to list open PRs (${error.message})`);
    return 2;
  }
  const hits = overlapHits({
    changedFiles: protectedChanged,
    openPrs,
    protectedPaths,
    allowlist,
    currentPr,
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
