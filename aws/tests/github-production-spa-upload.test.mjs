import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  APPROVAL_PHRASE,
  PRODUCTION_BUILD_ENV,
  loadProductionSpaLock,
  run,
  runContractTests,
  validateApplyInputs,
  validateExpectedIndexHash,
  validateLiveMatchesLock,
  validateProductionBuildEnv,
  validateSourceComposition,
  verifyStagingAcceptance,
  workflowIdentity,
} from '../../scripts/deployment-guard/github-production-spa-upload.mjs';
import { loadContractRegistry } from '../../scripts/deployment-guard/lib/contracts.mjs';
import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import { applyProductionSpaUpload } from '../../scripts/deployment-guard/lib/production-spa-upload.mjs';
import { validateReceipt } from '../../scripts/deployment-guard/lib/receipt.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHA = 'a'.repeat(40);
const LOCK = loadProductionSpaLock(REPO_ROOT);
const LIVE = {
  index_html_sha256: LOCK.index_html_sha256,
  entry_bundle: LOCK.spa_bundle,
  etag: 'etag-live',
  last_modified: '2026-10-06T20:27:22.000Z',
  s3_version_id: '8dyFUjR.duH54SLT6Ch7u.2ufIb54in_',
};
const ACCEPTANCE = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/38255758030';
const BASE_ENV = { GITHUB_SHA: SHA, GITHUB_REF_NAME: 'main', GITHUB_ACTOR: 'operator', GITHUB_RUN_ID: '9876' };
const ACCEPTED_SHA = 'b'.repeat(40);
const githubRun = (body, status = 200) => async () => ({ ok: status === 200, status, json: async () => body });
const SUCCESS_RUN = githubRun({ status: 'completed', conclusion: 'success', head_sha: ACCEPTED_SHA });
const APPLY_ENV = {
  ...BASE_ENV,
  GITHUB_TOKEN: 'test-token',
  CHECKSOPS_PRODUCTION_DEPLOY_MODE: 'apply',
  CHECKSOPS_EXPECTED_LIVE_INDEX_SHA256: LIVE.index_html_sha256,
  CHECKSOPS_STAGING_ACCEPTANCE_REFERENCE: ACCEPTANCE,
  CHECKSOPS_PRODUCTION_APPROVAL: APPROVAL_PHRASE,
};
const registry = loadContractRegistry(REPO_ROOT);
const workflow = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/guarded-production-spa-upload.yml'), 'utf8');

// The default candidate hash contains an 's', which a mis-escaped regex once rejected.
const tempRoot = (t, entry = '/assets/index-NewBuilds1.js') => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-production-spa-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'ops/deployment-guard'), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, 'ops/deployment-guard/accepted-contracts.json'), path.join(root, 'ops/deployment-guard/accepted-contracts.json'));
  if (entry) {
    fs.mkdirSync(path.join(root, 'dist/assets'), { recursive: true });
    fs.writeFileSync(path.join(root, 'dist/index.html'), `<script type="module" src="${entry}"></script>`);
    fs.writeFileSync(path.join(root, 'dist', entry), 'console.log("app")');
  }
  return root;
};
const applyDeps = (root, extra = {}) => ({
  root,
  readLive: async () => LIVE,
  buildEnv: PRODUCTION_BUILD_ENV,
  registry,
  contractRunner: () => true,
  isAncestor: () => true,
  fetchImpl: SUCCESS_RUN,
  ...extra,
});
const guardFiles = (root) => fs.existsSync(path.join(root, '.deployment-guard'));

test('workflow identity is pinned to main with a production SPA workstream id', () => {
  assert.equal(workflowIdentity(BASE_ENV).workstreamId, 'github-production-spa-9876');
  assert.throws(() => workflowIdentity({ ...BASE_ENV, GITHUB_REF_NAME: 'feature' }), /only run from main/);
  assert.throws(() => workflowIdentity({ ...BASE_ENV, GITHUB_SHA: 'short' }), /identity is incomplete/);
});

test('the release lock pins the live production baseline and its source', () => {
  assert.equal(LOCK.spa_bundle, '/assets/index-BOrdvozX.js');
  assert.match(LOCK.index_html_sha256, /^[0-9a-f]{64}$/);
  assert.match(LOCK.source_git_sha, /^[0-9a-f]{40}$/);
  assert.equal(validateLiveMatchesLock(LIVE, LOCK).ok, true);
  const drift = validateLiveMatchesLock({ ...LIVE, entry_bundle: '/assets/index-Other.js' }, LOCK);
  assert.equal(drift.code, CODES.DEPLOYMENT_COLLISION);
});

test('apply inputs need the exact phrase, a ChecksOps staging reference and the inspected hash', () => {
  assert.throws(() => validateApplyInputs({ approval: 'yes', stagingAcceptance: ACCEPTANCE }), /approval phrase/);
  assert.throws(() => validateApplyInputs({ approval: APPROVAL_PHRASE, stagingAcceptance: 'trust me' }), /staging acceptance/);
  assert.throws(() => validateApplyInputs({ approval: APPROVAL_PHRASE, stagingAcceptance: 'https://github.com/someone/else/pull/1' }), /staging acceptance/);
  assert.doesNotThrow(() => validateApplyInputs({ approval: APPROVAL_PHRASE, stagingAcceptance: ACCEPTANCE }));
  assert.equal(validateExpectedIndexHash(LIVE.index_html_sha256, '').ok, false);
  assert.equal(validateExpectedIndexHash(LIVE.index_html_sha256, 'c'.repeat(64)).code, CODES.DEPLOYMENT_COLLISION);
});

test('build environment must be the production Cognito pool on checksops.com with no Supabase', () => {
  assert.equal(validateProductionBuildEnv(PRODUCTION_BUILD_ENV).ok, true);
  assert.equal(validateProductionBuildEnv({ ...PRODUCTION_BUILD_ENV, VITE_COGNITO_USER_POOL_ID: 'us-east-1_vPmQ7cL1F' }).ok, false);
  assert.equal(validateProductionBuildEnv({ ...PRODUCTION_BUILD_ENV, VITE_APP_URL: 'https://staging.checksops.com' }).ok, false);
  assert.equal(validateProductionBuildEnv({ ...PRODUCTION_BUILD_ENV, VITE_CHECKSOPS_API_URL: 'https://kiqojucc02.execute-api.us-east-1.amazonaws.com/prep' }).ok, false);
  assert.equal(validateProductionBuildEnv({ ...PRODUCTION_BUILD_ENV, VITE_SUPABASE_URL: 'https://x.supabase.co' }).ok, false);
  for (const [key, value] of Object.entries(PRODUCTION_BUILD_ENV)) {
    assert.match(workflow, new RegExp(`${key}: ${value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\n`), key);
  }
});

test('staging acceptance is verified on GitHub: successful run or merged PR, on this commit or an ancestor', async () => {
  const ancestorOf = (a) => a === ACCEPTED_SHA;
  const ok = await verifyStagingAcceptance(ACCEPTANCE, SHA, { fetchImpl: SUCCESS_RUN, token: 't', isAncestor: ancestorOf });
  assert.equal(ok.accepted_sha, ACCEPTED_SHA);
  const pr = 'https://github.com/michaelcarletta-cmd/ChecksOps/pull/904';
  assert.equal((await verifyStagingAcceptance(pr, SHA, { fetchImpl: githubRun({ merged: true, merge_commit_sha: ACCEPTED_SHA }), token: 't', isAncestor: ancestorOf })).kind, 'pull');
  const refusals = [
    [ACCEPTANCE, { fetchImpl: SUCCESS_RUN, token: '' }, /GITHUB_TOKEN/],
    [ACCEPTANCE, { fetchImpl: githubRun({}, 404), token: 't' }, /could not be read/],
    [ACCEPTANCE, { fetchImpl: githubRun({ status: 'completed', conclusion: 'failure', head_sha: ACCEPTED_SHA }), token: 't' }, /did not succeed/],
    [ACCEPTANCE, { fetchImpl: githubRun({ status: 'in_progress', conclusion: null, head_sha: ACCEPTED_SHA }), token: 't' }, /did not succeed/],
    [ACCEPTANCE, { fetchImpl: SUCCESS_RUN, token: 't', isAncestor: () => false }, /not for this commit/],
    [pr, { fetchImpl: githubRun({ merged: false, merge_commit_sha: ACCEPTED_SHA }), token: 't' }, /not merged/],
    ['https://example.com/run/1', { fetchImpl: SUCCESS_RUN, token: 't' }, /ChecksOps GitHub run or PR/],
  ];
  for (const [reference, opts, pattern] of refusals) {
    await assert.rejects(verifyStagingAcceptance(reference, SHA, { isAncestor: ancestorOf, ...opts }), pattern);
  }
  let calledUrl;
  await verifyStagingAcceptance(ACCEPTANCE, SHA, { fetchImpl: async (url, init) => { calledUrl = [url, init.headers.authorization]; return SUCCESS_RUN(); }, token: 'tok', isAncestor: ancestorOf });
  assert.deepEqual(calledUrl, ['https://api.github.com/repos/michaelcarletta-cmd/ChecksOps/actions/runs/38255758030', 'Bearer tok']);
});

test('source composition requires the locked live source to be an ancestor of the commit', () => {
  assert.equal(validateSourceComposition(LOCK, SHA, { isAncestor: () => false }).code, CODES.SOURCE_COMPOSITION_REQUIRED);
  const okResult = validateSourceComposition(LOCK, SHA, { isAncestor: (a, c) => a === LOCK.source_git_sha && c === SHA });
  assert.equal(okResult.ok, true);
});

test('every accepted production SPA contract is executed, never assumed', () => {
  const executed = [];
  const results = runContractTests(registry, { runner: (file) => { executed.push(file); return true; } });
  assert.ok(Object.keys(results).length >= 9);
  assert.ok(executed.includes('aws/tests/aws-production-spa-bootstrap.test.mjs'));
  assert.equal(runContractTests(registry, { runner: (file) => !file.includes('tenant-security') })['tenant-isolation'].ok, false);
});

test('inspect reads the live index only: no lease, receipt or contract runs', async (t) => {
  const root = tempRoot(t);
  const result = await run({ ...BASE_ENV, CHECKSOPS_PRODUCTION_DEPLOY_MODE: 'inspect' }, {
    root,
    readLive: async () => LIVE,
    contractRunner: () => { throw new Error('inspect must not run contracts'); },
  });
  assert.equal(result.mutation, false);
  assert.equal(result.live_matches_lock, true);
  assert.equal(guardFiles(root), false);
});

test('apply refusals happen before any lease or receipt', async (t) => {
  const cases = [
    [{ CHECKSOPS_EXPECTED_LIVE_INDEX_SHA256: 'c'.repeat(64) }, {}, /changed since the reviewed inspect/],
    [{ CHECKSOPS_PRODUCTION_APPROVAL: 'DEPLOY TO PRODUCTION' }, {}, /approval phrase/],
    [{ CHECKSOPS_STAGING_ACCEPTANCE_REFERENCE: '' }, {}, /staging acceptance/],
    [{}, { readLive: async () => ({ ...LIVE, entry_bundle: '/assets/index-Drift.js' }) }, /not the release-locked baseline/],
    [{}, { isAncestor: (a) => a !== LOCK.source_git_sha }, /combine the frontend sources/],
    [{}, { buildEnv: { ...PRODUCTION_BUILD_ENV, VITE_COGNITO_USER_POOL_ID: 'us-east-1_vPmQ7cL1F' } }, /build environment is invalid/],
    [{}, { contractRunner: (file) => !file.includes('claim-ledger') }, /claim-ledger/],
    [{}, { fetchImpl: githubRun({ status: 'completed', conclusion: 'failure', head_sha: ACCEPTED_SHA }) }, /did not succeed/],
  ];
  for (const [envExtra, depsExtra, pattern] of cases) {
    const root = tempRoot(t);
    await assert.rejects(run({ ...APPLY_ENV, ...envExtra }, applyDeps(root, depsExtra)), (error) => pattern.test(`${error.message} ${JSON.stringify(error.details || {})}`));
    assert.equal(guardFiles(root), false, String(pattern));
  }
  const same = tempRoot(t, LIVE.entry_bundle);
  await assert.rejects(run(APPLY_ENV, applyDeps(same)), /same build/);
  const noDist = tempRoot(t, null);
  await assert.rejects(run(APPLY_ENV, applyDeps(noDist)), (error) => error.code === CODES.STALE_PACKAGE);
});

test('apply issues a production-spa receipt and writer input that the official writer accepts', async (t) => {
  const root = tempRoot(t);
  const result = await run(APPLY_ENV, applyDeps(root));
  assert.equal(result.mutation, false);
  const receipt = JSON.parse(fs.readFileSync(result.authorization.receiptFile, 'utf8'));
  assert.equal(receipt.target_environment, 'production');
  assert.equal(receipt.target_component, 'production-spa');
  assert.equal(receipt.deployment_type, 'spa-promote');
  assert.deepEqual(receipt.owned_components, ['index.html']);
  assert.deepEqual(receipt.preflight_live_fingerprint, { index_html_sha256: LIVE.index_html_sha256, entry_bundle: LIVE.entry_bundle });
  assert.equal(validateReceipt(receipt, {
    workstream_id: 'github-production-spa-9876', commit: SHA, target_environment: 'production', target_component: 'production-spa', deployment_type: 'spa-promote',
  }, { root }).ok, true);
  const input = JSON.parse(fs.readFileSync(result.authorization.spaInput, 'utf8'));
  assert.equal(input.approval.workstream_id, 'github-production-spa-9876');
  assert.equal(input.staging_acceptance.reference, ACCEPTANCE);
  assert.equal(input.staging_acceptance.accepted_sha, ACCEPTED_SHA);
  assert.equal(input.source_composition_manifest.live_source, LOCK.source_git_sha);
  assert.equal(input.deploy_mode, 'per_object_put');

  // The official writer re-checks everything and uploads assets first, index.html last.
  const calls = [];
  const html = fs.readFileSync(path.join(root, 'dist/index.html'), 'utf8');
  let indexWritten = false;
  const aws = {
    async readIndexHtml() {
      calls.push('read');
      const fingerprint = indexWritten
        ? { ...LIVE, index_html_sha256: result.candidate.index_html_sha256, entry_bundle: result.candidate.entry_bundle }
        : LIVE;
      return { ok: true, details: { fingerprint } };
    },
    async putObject({ key }) { calls.push(`put:${key}`); if (key === 'index.html') indexWritten = true; return { ok: true, details: { key } }; },
    async createInvalidation({ paths }) { calls.push(`invalidate:${paths.join(',')}`); return { ok: true, details: {} }; },
  };
  const fetchImpl = async (url) => {
    const { pathname } = new URL(url);
    const body = pathname === '/index.html' ? html : fs.readFileSync(path.join(root, 'dist', pathname), 'utf8');
    return { ok: true, status: 200, text: async () => body };
  };
  // Same env the workflow's upload step sets.
  const written = await applyProductionSpaUpload(input, {
    env: { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1', CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT: result.authorization.receiptFile },
    guardRoot: root,
    target: JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'ops/deployment-guard/protected-targets.json'), 'utf8')).targets.find((row) => row.id === 'production-spa'),
    aws,
    receiptRegistry: { consumeOnce: async () => ({ ok: true, details: { consumed: true } }) },
    fetchImpl,
    sleep: async () => {},
  });
  assert.equal(written.ok, true, JSON.stringify(written, null, 2));
  const puts = calls.filter((c) => c.startsWith('put:'));
  assert.equal(puts.at(-1), 'put:index.html');
  assert.ok(calls.indexOf('invalidate:/*') > calls.indexOf('put:index.html'));
});

test('workflow is main-only, production-environment, scoped by session policy, and never syncs or deletes', () => {
  assert.match(workflow, /environment: production/);
  assert.match(workflow, /test "\$GITHUB_REF" = "refs\/heads\/main"/);
  assert.match(workflow, /approved commit does not match workflow SHA/);
  assert.match(workflow, /approval_phrase must be exactly: DEPLOY WEBSITE TO PRODUCTION/);
  assert.match(workflow, /role\/ChecksOpsProductionSpaDeploy/);
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
  // The build runs before any AWS credentials exist in the job.
  assert.ok(workflow.indexOf('bun run build:aws') < workflow.indexOf('configure-aws-credentials@'));
  assert.match(workflow, /node scripts\/deployment-guard\/production-spa-upload\.mjs --input/);
  assert.equal((workflow.match(/inline-session-policy/g) || []).length, 2);
  assert.doesNotMatch(workflow, /s3:DeleteObject|s3:ListBucket|s3 sync|s3 cp|s3 rm|--delete/);
  assert.doesNotMatch(workflow, /checksops-staging-frontend|E1CG52WRQZI7X1|staging-spa-upload/);
  assert.doesNotMatch(workflow, /CHECKSOPS_DEPLOYMENT_GUARD_BYPASS|CHECKSOPS_SKIP_DEPLOYMENT_GUARD/);
  const inspectPolicy = workflow.split('Configure read-only production session (inspect)')[1].split('- name:')[0];
  assert.doesNotMatch(inspectPolicy, /PutObject|CreateInvalidation/);
});
