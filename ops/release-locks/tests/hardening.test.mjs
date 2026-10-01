import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  appendOnlyLedgerErrors,
  allowlistErrors,
  classificationSetErrors,
  collectPaginated,
  deletionAgainstBaseErrors,
  findDuplicateJsonKeys,
  loadJson,
  matchProtectedPath,
  productionLockedEvidenceErrors,
  unownedWatchErrors,
  computeOwnershipHashes,
  validateReleaseLocks,
  workflowInvocationErrors,
} from '../../../scripts/lib/release-locks.mjs';
import {
  listOpenPrsPaginated,
  main as overlapMain,
  overlapHits,
} from '../../../scripts/check-pr-path-overlap.mjs';
import { main as guardMain } from '../../../scripts/production-deploy-guard.mjs';
import { loadReleaseLockInputs, main as validateMain } from '../../../scripts/validate-release-locks.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sourceLedger() {
  return loadJson(path.join(ROOT, 'ops/release-locks/applied-migrations.ledger.json'));
}

test('ledger deletion against trusted base fails', () => {
  const base = sourceLedger();
  const candidate = clone(base);
  candidate.entries = candidate.entries.slice(0, -1);
  const errors = appendOnlyLedgerErrors(ROOT, candidate, base, { genesis: false });
  assert.ok(errors.some((row) => /deleted/.test(row)));
});

test('ledger mutation against trusted base fails', () => {
  const base = sourceLedger();
  const candidate = clone(base);
  candidate.entries[0] = { ...candidate.entries[0], source_sha256: 'a'.repeat(64) };
  const errors = appendOnlyLedgerErrors(ROOT, candidate, base, { genesis: false });
  assert.ok(errors.some((row) => /mutated or replaced/.test(row)));
});

test('false in-place applied-status promotion fails', () => {
  const base = sourceLedger();
  const candidate = clone(base);
  candidate.entries[0] = {
    ...candidate.entries[0],
    applied: true,
    applied_environment: 'production',
    applied_sha256: candidate.entries[0].source_sha256,
  };
  const errors = appendOnlyLedgerErrors(ROOT, candidate, base, { genesis: false });
  assert.ok(errors.some((row) => /in-place applied=false to applied=true/.test(row)));
});

test('partner-share apply_evidence is append-only against origin/main ledger', () => {
  let base;
  try {
    base = JSON.parse(execFileSync('git', ['show', 'origin/main:ops/release-locks/applied-migrations.ledger.json'], {
      cwd: ROOT,
      encoding: 'utf8',
    }));
  } catch {
    base = null;
  }
  if (!base) return;
  const candidate = sourceLedger();
  const errors = appendOnlyLedgerErrors(ROOT, candidate, base, { genesis: false });
  assert.deepEqual(errors, []);
  const evidence = candidate.entries.filter((row) => row.record_kind === 'apply_evidence');
  assert.equal(evidence.length >= 4, true);
  assert.equal(evidence.every((row) => row.applied === true && row.applied_environment === 'production'), true);
});

test('fake production evidence (recorded=true or arbitrary hash) fails', () => {
  const errors = productionLockedEvidenceErrors({
    classification: 'PRODUCTION_LOCKED',
    production_active: true,
    source: { git_sha: 'a'.repeat(40), tree_hash: 'b'.repeat(64) },
    required_sql: [{
      path: 'aws/financial/sql/65_checkalt_production_writer.sql',
      source_sha256: 'c'.repeat(64),
      applied: true,
      applied_environment: 'production',
      applied_sha256: 'c'.repeat(64),
    }],
    artifact: { type: 'lambda', hash: 'd'.repeat(64) },
    production_validation: {
      completed: true,
      evidence_refs: ['recorded-true'],
    },
    deployment_fingerprint: { recorded: true },
    rollback: { git_sha: 'a'.repeat(40), artifact: 'bundle' },
    missing_evidence: [],
  }, 'checkalt-submission', ROOT);
  assert.ok(errors.some((row) => /NOT_APPLIED|unapplied/.test(row)));
  assert.ok(errors.some((row) => /recorded=true or an arbitrary hash/.test(row)));
  assert.ok(errors.some((row) => /evidence producer\/type|validation timestamp|artifact identity/.test(row)));
});

test('component deletion with replacement tree hash fails', () => {
  const errors = deletionAgainstBaseErrors({
    baseManifest: {
      components: {
        'auto-deposit': { classification: 'UNVERIFIED' },
        'checkalt-submission': { classification: 'UNVERIFIED' },
      },
    },
    candidateManifest: {
      components: {
        'checkalt-submission': { classification: 'UNVERIFIED', source: { tree_hash: 'a'.repeat(64) } },
      },
    },
    baseProtected: { ownership_groups: { 'auto-deposit': {}, 'checkalt-submission': {} } },
    candidateProtected: { ownership_groups: { 'checkalt-submission': {} } },
  });
  assert.ok(errors.some((row) => /component auto-deposit was deleted/.test(row)));
  assert.ok(errors.some((row) => /protected-path group auto-deposit was deleted/.test(row)));
});

test('protected-group deletion with replacement tree hash fails', () => {
  const inputs = loadReleaseLockInputs(ROOT);
  const protectedPaths = clone(inputs.protectedPaths);
  delete protectedPaths.ownership_groups['provider-secrets'];
  const manifest = clone(inputs.manifest);
  delete manifest.components['provider-secrets'];
  manifest.components['production-release'].source.tree_hash = 'a'.repeat(64);
  const { errors } = validateReleaseLocks({
    ...inputs,
    manifest,
    protectedPaths,
    genesis: true,
    base: {},
  });
  assert.ok(errors.some((row) => /provider-secrets/.test(row)));
});

test('empty allowlist path is rejected', () => {
  const protectedPaths = loadJson(path.join(ROOT, 'ops/release-locks/protected-paths.json'));
  const errors = allowlistErrors({
    fail_closed: true,
    allow: [{
      other_pr: 314,
      path: '',
      reason: 'please allow everything across the repository now',
      expires: '2099-01-01',
    }],
  }, protectedPaths);
  assert.ok(errors.some((row) => /empty or repository-wide/.test(row)));
});

test('more than 200 open PRs paginate to completion', () => {
  const fetchPrPage = (page) => {
    if (page === 1) {
      return {
        ok: true,
        hasNext: true,
        items: Array.from({ length: 100 }, (_, i) => ({ number: i + 1, title: 'p', head: { ref: 'b' }, draft: true })),
      };
    }
    if (page === 2) {
      return {
        ok: true,
        hasNext: true,
        items: Array.from({ length: 100 }, (_, i) => ({ number: i + 101, title: 'p', head: { ref: 'b' }, draft: true })),
      };
    }
    return {
      ok: true,
      hasNext: false,
      items: Array.from({ length: 25 }, (_, i) => ({ number: i + 201, title: 'p', head: { ref: 'b' }, draft: true })),
    };
  };
  const fetchPrFilesPage = () => ({ ok: true, items: [{ filename: 'README.md' }], hasNext: false });
  const prs = listOpenPrsPaginated({ fetchPrPage, fetchPrFilesPage, pageSize: 100 });
  assert.equal(prs.length, 225);
});

test('incomplete pagination fails closed', () => {
  assert.throws(
    () => collectPaginated({
      pageSize: 100,
      maxPages: 2,
      fetchPage: () => ({
        ok: true,
        hasNext: true,
        items: Array.from({ length: 100 }, (_, i) => ({ number: i + 1 })),
      }),
    }),
    /pagination not proven complete/,
  );
});

test('GitHub API failure fails closed', () => {
  const file = path.join(os.tmpdir(), 'release-locks-changed-files.txt');
  fs.writeFileSync(file, 'scripts/validate-release-locks.mjs\n');
  const code = overlapMain(['--require', '--changed-files', file], ROOT, {
    env: { GITHUB_PR_NUMBER: '343', GITHUB_ACTIONS: 'true' },
    fetchPrPage: () => ({ ok: false, error: 'GitHub API 500' }),
    execFile: () => {},
  });
  assert.equal(code, 2);
});

test('current PR is not treated as a collision with itself', () => {
  const protectedPaths = loadJson(path.join(ROOT, 'ops/release-locks/protected-paths.json'));
  const hits = overlapHits({
    changedFiles: ['scripts/validate-release-locks.mjs'],
    openPrs: [{
      number: 343,
      title: 'release locks',
      headRefName: 'cursor/production-release-locks-bb27',
      files: ['scripts/validate-release-locks.mjs'],
    }],
    protectedPaths,
    allowlist: { fail_closed: true, allow: [] },
    currentPr: 343,
  });
  assert.equal(hits.length, 0);
});

test('workflow no-op retaining the release-locks check name fails', () => {
  const errors = workflowInvocationErrors(`
name: Release locks
on:
  pull_request:
jobs:
  release-locks:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
`);
  assert.ok(errors.some((row) => /no-op bypass/.test(row)));
  assert.ok(errors.some((row) => /40-character commit SHA/.test(row)));
  assert.ok(errors.some((row) => /merge_group/.test(row)));
});

test('duplicate JSON keys are rejected before parse can drop them', () => {
  const errors = findDuplicateJsonKeys('{"fail_closed": true, "fail_closed": false}', 'fixture.json');
  assert.ok(errors.some((row) => /duplicate key fail_closed/.test(row)));
});

test('unrelated Moov sibling is not attributed to CheckAlt and cannot bypass ownership', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkalt-watch-'));
  const checkalt = 'aws/functions/api/providers/production/checkalt-submit.mjs';
  const moovSibling = 'aws/functions/api/providers/production/moov-dispatch.mjs';
  for (const rel of [checkalt, moovSibling]) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, `// ${path.basename(rel)}\n`);
  }
  const protectedPaths = {
    unowned_file_watches: ['aws/functions/api/providers/production/'],
    ownership_groups: {
      'checkalt-submission': {
        owners: ['@x'],
        paths: [checkalt],
      },
    },
  };
  const matches = matchProtectedPath(moovSibling, protectedPaths);
  assert.equal(matches.some((row) => row.groupId === 'checkalt-submission'), false);
  const hashes = computeOwnershipHashes(dir, protectedPaths);
  assert.equal(hashes.groups['checkalt-submission'].files.includes(moovSibling), false);
  const errors = unownedWatchErrors(dir, protectedPaths, hashes);
  assert.ok(errors.some((row) => /moov-dispatch/.test(row)));
});

test('four classification names must be unique and complete', () => {
  const errors = classificationSetErrors({
    classifications: ['UNVERIFIED', 'UNVERIFIED', 'UNVERIFIED', 'UNVERIFIED'],
  });
  assert.ok(errors.some((row) => /unique and complete/.test(row)));
});

test('deploy guard without production intent succeeds', () => {
  assert.equal(guardMain([], ROOT, {}), 0);
});

test('deploy guard with production intent and no valid candidate fails', () => {
  assert.equal(guardMain([], ROOT, { CHECKSOPS_PRODUCTION_DEPLOY: '1' }), 1);
});

test('clean manifest validation succeeds against the trusted base after genesis merge', () => {
  const inputs = loadReleaseLockInputs(ROOT);
  const { errors, genesis } = validateReleaseLocks(inputs);
  assert.deepEqual(errors, []);
  // PR #343 was the genesis snapshot. After it merged, origin/main has the ledger
  // so validation is append-only against the trusted base, not a second genesis.
  assert.equal(genesis, !inputs.base.ledger);
  if (inputs.base.ledger) {
    assert.equal(typeof inputs.base.sha, 'string');
    assert.equal(inputs.base.sha.length, 40);
  }
  assert.equal(validateMain([], ROOT), 0);
});
