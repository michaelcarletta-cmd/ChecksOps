import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  classificationErrors,
  computeOwnershipHashes,
  ledgerErrors,
  loadJson,
  matchProtectedPath,
  sha256Buffer,
  treeHashForFiles,
  validateReleaseLocks,
} from '../../../scripts/lib/release-locks.mjs';
import { overlapHits } from '../../../scripts/check-pr-path-overlap.mjs';
import { compareCandidate, liveCompareErrors, productionIntentErrors } from '../../../scripts/production-deploy-guard.mjs';
import { main as validateMain, loadReleaseLockInputs } from '../../../scripts/validate-release-locks.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function writeTree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-locks-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return dir;
}

test('origin/main-based manifest validates fail-closed with no PRODUCTION_LOCKED component', () => {
  const inputs = loadReleaseLockInputs(ROOT);
  const { errors } = validateReleaseLocks(inputs);
  assert.deepEqual(errors, []);
  const locked = Object.values(inputs.manifest.components).filter((c) => c.classification === 'PRODUCTION_LOCKED');
  assert.equal(locked.length, 0);
  assert.equal(inputs.manifest.fail_closed, true);
  assert.equal(validateMain([], ROOT), 0);
});

test('PRODUCTION_LOCKED without complete evidence fails', () => {
  const errors = classificationErrors({
    classification: 'PRODUCTION_LOCKED',
    production_active: true,
    source: { git_sha: 'a'.repeat(40), tree_hash: 'b'.repeat(64) },
    required_sql: [],
    artifact: { type: 'spa', hash: null },
    production_validation: { completed: false },
    deployment_fingerprint: null,
    rollback: { git_sha: null, artifact: null, notes: 'none' },
    missing_evidence: ['artifact'],
  }, 'identity-cognito');
  assert.ok(errors.some((row) => /required_sql/.test(row)));
  assert.ok(errors.some((row) => /artifact.hash/.test(row)));
  assert.ok(errors.some((row) => /production_validation/.test(row)));
  assert.ok(errors.some((row) => /deployment_fingerprint/.test(row)));
});

test('UNVERIFIED cannot be production_active', () => {
  const errors = classificationErrors({
    classification: 'UNVERIFIED',
    production_active: true,
    source: { git_sha: 'a'.repeat(40), tree_hash: 'b'.repeat(64) },
    required_sql: [],
    artifact: { type: 'none' },
    production_validation: { completed: false },
    deployment_fingerprint: null,
    rollback: { git_sha: null, notes: 'n' },
    missing_evidence: ['x'],
  }, 'auto-deposit');
  assert.ok(errors.some((row) => /production_active=true is forbidden/.test(row)));
});

test('SOURCE_LOCKED_NOT_ACTIVE cannot claim production-applied SQL', () => {
  const errors = classificationErrors({
    classification: 'SOURCE_LOCKED_NOT_ACTIVE',
    production_active: false,
    source: { git_sha: 'a'.repeat(40), tree_hash: 'b'.repeat(64) },
    required_sql: [{
      path: 'aws/rls/sql/32_partner_share_lifecycle.sql',
      source_sha256: 'c'.repeat(64),
      applied: true,
      applied_environment: 'production',
    }],
    artifact: { type: 'sql' },
    production_validation: { completed: false },
    deployment_fingerprint: null,
    rollback: { git_sha: 'a'.repeat(40), notes: 'n' },
    missing_evidence: ['deploy'],
  }, 'partner-sharing');
  assert.ok(errors.some((row) => /cannot claim production-applied SQL/.test(row)));
});

test('STAGING_LOCKED_NOT_PRODUCTION cannot represent production-active SQL', () => {
  const errors = classificationErrors({
    classification: 'STAGING_LOCKED_NOT_PRODUCTION',
    production_active: false,
    source: { git_sha: 'a'.repeat(40), tree_hash: 'b'.repeat(64) },
    required_sql: [{
      path: 'aws/rls/sql/26_enable_rls.sql',
      source_sha256: 'c'.repeat(64),
      applied: true,
      applied_environment: 'production',
    }],
    artifact: { type: 'sql' },
    production_validation: { completed: false, evidence_refs: ['staging-pass'] },
    deployment_fingerprint: null,
    rollback: { git_sha: null, notes: 'n' },
    missing_evidence: [],
  }, 'database-rls');
  assert.ok(errors.some((row) => /staging-only component claims production SQL/.test(row)));
});

test('changing a protected file without updating tree_hash fails', () => {
  const dir = writeTree({
    'aws/template.yaml': 'AWS_MOOV_ENABLED: "false"\n',
    'ops/release-locks/schema/locked-components.schema.json': fs.readFileSync(path.join(ROOT, 'ops/release-locks/schema/locked-components.schema.json')),
    'ops/release-locks/protected-paths.json': JSON.stringify({
      version: 1,
      fail_closed: true,
      ownership_groups: {
        'production-release': { owners: ['x'], paths: ['aws/template.yaml'] },
      },
    }),
    'ops/release-locks/applied-migrations.ledger.json': JSON.stringify({
      version: 1, append_only: true, fail_closed: true, entries: [],
    }),
    'ops/release-locks/locked-components.json': '{}',
  });
  const protectedPaths = loadJson(path.join(dir, 'ops/release-locks/protected-paths.json'));
  const hashes = computeOwnershipHashes(dir, protectedPaths);
  const recorded = hashes.groups['production-release'].tree_hash;
  fs.writeFileSync(path.join(dir, 'aws/template.yaml'), 'AWS_MOOV_ENABLED: "true"\n');
  const later = computeOwnershipHashes(dir, protectedPaths);
  assert.notEqual(later.groups['production-release'].tree_hash, recorded);
});

test('SQL source hash change after recording fails', () => {
  const dir = writeTree({
    'aws/financial/sql/64_financial_activation_grants.sql': "SELECT 'NOT_APPLIED';\n",
  });
  const digest = treeHashForFiles(dir, ['aws/financial/sql/64_financial_activation_grants.sql']);
  const sqlPath = path.join(dir, 'aws/financial/sql/64_financial_activation_grants.sql');
  const { sha256File } = { sha256File: (file) => sha256Buffer(fs.readFileSync(file)) };
  const source = sha256File(sqlPath);
  const ledger = {
    fail_closed: true,
    append_only: true,
    entries: [{
      path: 'aws/financial/sql/64_financial_activation_grants.sql',
      source_sha256: source,
      applied: false,
      applied_environment: null,
      mutation: 'append',
    }],
  };
  assert.deepEqual(ledgerErrors(dir, ledger, new Map()), []);
  fs.writeFileSync(sqlPath, "SELECT 'CHANGED';\n");
  const later = ledgerErrors(dir, ledger, new Map());
  assert.ok(later.some((row) => /source hash changed after recording/.test(row)));
  assert.ok(digest);
});

test('ledger forbids rewrite mutations', () => {
  const errors = ledgerErrors(ROOT, {
    fail_closed: true,
    append_only: true,
    entries: [{
      path: 'aws/financial/sql/64_financial_activation_grants.sql',
      source_sha256: '0f505f405adae1b53b417bd8942eb615700bd3d7e3422e3b41037c7684bda7c7',
      applied: false,
      mutation: 'rewrite',
    }],
  }, new Map());
  assert.ok(errors.some((row) => /non-append mutation/.test(row)));
});

test('candidate fingerprint mismatch fails deploy guard', () => {
  const manifest = {
    components: {
      'identity-cognito': {
        classification: 'PRODUCTION_LOCKED',
        artifact: { hash: 'a'.repeat(64) },
        deployment_fingerprint: { recorded: true, spa_bundle: 'index-locked.js' },
      },
    },
  };
  const errors = compareCandidate(manifest, {
    environment: 'production',
    approved: true,
    components: {
      'identity-cognito': { hash: 'b'.repeat(64), spa_bundle: 'index-other.js', deploy: true },
    },
  });
  assert.ok(errors.some((row) => /artifact hash/.test(row)));
  assert.ok(errors.some((row) => /SPA bundle/.test(row)));
});

test('unverified component cannot be deployed by candidate', () => {
  const manifest = {
    components: {
      'auto-deposit': { classification: 'UNVERIFIED', production_active: false },
    },
  };
  const errors = compareCandidate(manifest, {
    components: { 'auto-deposit': { deploy: true } },
  });
  assert.ok(errors.some((row) => /not PRODUCTION_LOCKED/.test(row)));
});

test('production deploy intent without PRODUCTION_LOCKED fails', () => {
  const inputs = loadReleaseLockInputs(ROOT);
  const errors = productionIntentErrors(inputs.manifest, { CHECKSOPS_PRODUCTION_DEPLOY: '1' });
  assert.ok(errors.some((row) => /no component is PRODUCTION_LOCKED/.test(row)));
  assert.deepEqual(liveCompareErrors(['--live']), [
    'live AWS comparison is disabled; supply a recorded --candidate fingerprint instead',
  ]);
});

test('overlap check fails when another open PR already owns a protected path', () => {
  const protectedPaths = loadJson(path.join(ROOT, 'ops/release-locks/protected-paths.json'));
  const hits = overlapHits({
    changedFiles: ['aws/functions/api/providers/webhooks.mjs'],
    openPrs: [{
      number: 314,
      title: 'webhook cutover',
      headRefName: 'cursor/provider-webhook-cutover-c48b',
      files: ['aws/functions/api/providers/webhooks.mjs'],
    }],
    protectedPaths,
    allowlist: { fail_closed: true, allow: [] },
    currentPr: 999,
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].other_pr, 314);
  const matches = matchProtectedPath('aws/functions/api/providers/webhooks.mjs', protectedPaths);
  assert.ok(matches.some((row) => row.groupId === 'moov-webhooks'));
});

test('schema rejects unknown classification', () => {
  const inputs = loadReleaseLockInputs(ROOT);
  const manifest = clone(inputs.manifest);
  manifest.components['auto-deposit'].classification = 'PRODUCTION_ACTIVE';
  const { errors } = validateReleaseLocks({
    ...inputs,
    manifest,
  });
  assert.ok(errors.some((row) => /enum|unknown classification/.test(row)));
});
