import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  inspectCandidateDist,
  run,
  runContractTests,
  STAGING_APP_URL,
  validateExpectedIndexHash,
  validateStagingBuildEnv,
  workflowIdentity,
} from '../../scripts/deployment-guard/github-staging-spa-upload.mjs';
import { loadContractRegistry } from '../../scripts/deployment-guard/lib/contracts.mjs';
import { validateReceipt } from '../../scripts/deployment-guard/lib/receipt.mjs';

const SHA = 'a'.repeat(40);
const LIVE = {
  index_html_sha256: 'b'.repeat(64),
  entry_bundle: '/assets/index-Dq1xEBa5.js',
  etag: 'etag',
  last_modified: '2026-10-06T01:15:47+00:00',
};
const BUILD_ENV = {
  VITE_APP_URL: STAGING_APP_URL,
  VITE_AUTH_PROVIDER: 'cognito',
  VITE_CHECKSOPS_API_URL: 'https://api.example.invalid/staging',
  VITE_AWS_REGION: 'us-east-1',
  VITE_COGNITO_USER_POOL_ID: 'us-east-1_example',
  VITE_COGNITO_USER_POOL_CLIENT_ID: 'exampleclient',
};
const BASE_ENV = {
  GITHUB_SHA: SHA,
  GITHUB_REF_NAME: 'main',
  GITHUB_ACTOR: 'operator',
  GITHUB_RUN_ID: '4321',
};
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const workflow = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/guarded-staging-spa-upload.yml'), 'utf8');
const registry = loadContractRegistry(REPO_ROOT);

const tempRoot = (t, entry = '/assets/index-NewBuild1.js') => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-staging-spa-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  if (entry) {
    fs.mkdirSync(path.join(root, 'dist/assets'), { recursive: true });
    fs.writeFileSync(path.join(root, 'dist/index.html'), `<script type="module" src="${entry}"></script>`);
    fs.writeFileSync(path.join(root, 'dist', entry), 'console.log("app")');
  }
  return root;
};

test('workflow identity is pinned to main with a staging SPA workstream id', () => {
  assert.equal(workflowIdentity(BASE_ENV).workstreamId, 'github-staging-spa-4321');
  assert.throws(() => workflowIdentity({ ...BASE_ENV, GITHUB_REF_NAME: 'feature' }), /only run from main/);
  assert.throws(() => workflowIdentity({ ...BASE_ENV, GITHUB_SHA: 'short' }), /identity is incomplete/);
});

test('apply requires the exact reviewed live index.html hash', () => {
  assert.equal(validateExpectedIndexHash(LIVE.index_html_sha256, '').ok, false);
  const moved = validateExpectedIndexHash(LIVE.index_html_sha256, 'c'.repeat(64));
  assert.equal(moved.ok, false);
  assert.equal(moved.code, 'DEPLOYMENT_COLLISION');
  assert.equal(validateExpectedIndexHash(LIVE.index_html_sha256, LIVE.index_html_sha256.toUpperCase()).ok, true);
});

test('build environment must target staging.checksops.com with Cognito and no Supabase', () => {
  assert.equal(validateStagingBuildEnv(BUILD_ENV).ok, true);
  assert.equal(validateStagingBuildEnv({ ...BUILD_ENV, VITE_APP_URL: 'https://checksops.com' }).ok, false);
  assert.equal(validateStagingBuildEnv({ ...BUILD_ENV, VITE_AUTH_PROVIDER: 'supabase' }).ok, false);
  assert.equal(validateStagingBuildEnv({ ...BUILD_ENV, VITE_SUPABASE_URL: 'https://x.supabase.co' }).ok, false);
  const missing = validateStagingBuildEnv({ ...BUILD_ENV, VITE_COGNITO_USER_POOL_ID: '' });
  assert.equal(missing.ok, false);
  assert.match(missing.details.errors.join(' '), /VITE_COGNITO_USER_POOL_ID/);
});

test('candidate dist must contain index.html and its referenced entry bundle', (t) => {
  assert.equal(inspectCandidateDist(path.join(tempRoot(t, null), 'dist')).ok, false);
  const root = tempRoot(t);
  fs.rmSync(path.join(root, 'dist/assets'), { recursive: true });
  assert.equal(inspectCandidateDist(path.join(root, 'dist')).ok, false);
  const good = inspectCandidateDist(path.join(tempRoot(t), 'dist'));
  assert.equal(good.ok, true);
  assert.equal(good.details.entry_bundle, '/assets/index-NewBuild1.js');
});

test('every accepted staging SPA contract is executed, never assumed', () => {
  const executed = [];
  const results = runContractTests(registry, { runner: (file) => { executed.push(file); return true; } });
  assert.ok(Object.keys(results).length >= 9);
  assert.ok(Object.values(results).every((row) => row.ok === true));
  assert.ok(executed.includes('aws/tests/aws-production-spa-bootstrap.test.mjs'));
  const failing = runContractTests(registry, { runner: (file) => !file.includes('tenant-security') });
  assert.equal(failing['tenant-isolation'].ok, false);
  const missing = runContractTests({ contracts: [{
    id: 'ghost', accepted: true, environments: ['staging'], components: ['staging-frontend'],
    deployment_types: ['spa-promote'], test: 'aws/tests/does-not-exist.test.mjs',
  }] }, { runner: () => true });
  assert.equal(missing.ghost.ok, false);
});

test('inspect reports the live index fingerprint without lease, receipt, or contract runs', async (t) => {
  const root = tempRoot(t);
  const result = await run({ ...BASE_ENV, CHECKSOPS_STAGING_DEPLOY_MODE: 'inspect' }, {
    root,
    readLive: () => LIVE,
    contractRunner: () => { throw new Error('inspect must not run contracts'); },
    signer: () => { throw new Error('inspect must not sign'); },
  });
  assert.equal(result.mutation, false);
  assert.equal(result.live.index_html_sha256, LIVE.index_html_sha256);
  assert.equal(fs.existsSync(path.join(root, '.deployment-guard')), false);
});

test('apply refuses a moved live index before building a receipt', async (t) => {
  const root = tempRoot(t);
  await assert.rejects(run({
    ...BASE_ENV,
    CHECKSOPS_STAGING_DEPLOY_MODE: 'apply',
    CHECKSOPS_EXPECTED_LIVE_INDEX_SHA256: 'c'.repeat(64),
  }, { root, readLive: () => LIVE, buildEnv: BUILD_ENV, registry, contractRunner: () => true, signer: (u) => u }), /changed since the reviewed inspect/);
  assert.equal(fs.existsSync(path.join(root, '.deployment-guard')), false);
});

test('apply refuses redeploying the live entry bundle and a failing contract', async (t) => {
  const applyEnv = {
    ...BASE_ENV,
    CHECKSOPS_STAGING_DEPLOY_MODE: 'apply',
    CHECKSOPS_EXPECTED_LIVE_INDEX_SHA256: LIVE.index_html_sha256,
  };
  await assert.rejects(run(applyEnv, {
    root: tempRoot(t, LIVE.entry_bundle), readLive: () => LIVE, buildEnv: BUILD_ENV, registry, contractRunner: () => true, signer: (u) => u,
  }), /same build/);
  const root = tempRoot(t);
  await assert.rejects(run(applyEnv, {
    root, readLive: () => LIVE, buildEnv: BUILD_ENV, registry, contractRunner: (file) => !file.includes('claim-ledger'), signer: (u) => u,
  }), (error) => error.code === 'REGRESSION_DETECTED');
  assert.equal(fs.existsSync(path.join(root, '.deployment-guard/receipts')), false);
});

test('apply issues one staging-frontend spa-promote receipt bound to the inspected index', async (t) => {
  const root = tempRoot(t);
  const result = await run({
    ...BASE_ENV,
    CHECKSOPS_STAGING_DEPLOY_MODE: 'apply',
    CHECKSOPS_EXPECTED_LIVE_INDEX_SHA256: LIVE.index_html_sha256,
  }, {
    root,
    readLive: () => LIVE,
    buildEnv: BUILD_ENV,
    registry,
    contractRunner: () => true,
    // Offline test signer only; the workflow signs with the staging KMS key.
    signer: (unsigned) => unsigned,
  });
  assert.equal(result.mutation, false);
  assert.equal(result.candidate.entry_bundle, '/assets/index-NewBuild1.js');
  const receipt = JSON.parse(fs.readFileSync(result.authorization.receiptFile, 'utf8'));
  assert.equal(receipt.target_environment, 'staging');
  assert.equal(receipt.target_component, 'staging-frontend');
  assert.equal(receipt.deployment_type, 'spa-promote');
  assert.deepEqual(receipt.owned_components, ['index.html']);
  assert.deepEqual(receipt.preflight_live_fingerprint, {
    index_html_sha256: LIVE.index_html_sha256,
    entry_bundle: LIVE.entry_bundle,
  });
  assert.equal(receipt.commit, SHA);
  assert.equal(receipt.workstream_id, 'github-staging-spa-4321');
  assert.equal(validateReceipt(receipt, {
    workstream_id: 'github-staging-spa-4321',
    commit: SHA,
    target_environment: 'staging',
    target_component: 'staging-frontend',
    deployment_type: 'spa-promote',
  }, { root }).ok, true);
});

test('workflow runs only from main in the staging environment and never touches production', () => {
  assert.match(workflow, /environment: staging/);
  assert.match(workflow, /test "\$GITHUB_REF" = "refs\/heads\/main"/);
  assert.match(workflow, /approved commit does not match workflow SHA/);
  assert.match(workflow, /apply requires expected_live_index_sha256 from inspect/);
  assert.match(workflow, /role\/ChecksOpsGitHubStagingSpaUpload/);
  assert.match(workflow, /STAGING_SPA_VITE_APP_URL must be https:\/\/staging\.checksops\.com/);
  assert.match(workflow, /node scripts\/deployment-guard\/staging-spa-upload\.mjs/);
  assert.match(workflow, /--environment staging/);
  assert.doesNotMatch(workflow, /s3 sync|s3 cp|--delete/);
  assert.doesNotMatch(workflow, /checksops-production-frontend|E1B0ZWWO5559U5|production-spa-upload/);
  assert.doesNotMatch(workflow, /CHECKSOPS_DEPLOYMENT_GUARD_BYPASS|CHECKSOPS_SKIP_DEPLOYMENT_GUARD/);
});

test('IAM policy grants only the staging SPA bucket, staging distribution and guard KMS key', () => {
  const policy = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'aws/staging-spa-upload/policies/permissions-policy.json'), 'utf8'));
  const trust = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'aws/staging-spa-upload/policies/trust-policy.json'), 'utf8'));
  const resources = policy.Statement.flatMap((row) => [].concat(row.Resource));
  for (const resource of resources) {
    assert.ok(
      resource.startsWith('arn:aws:s3:::checksops-staging-frontend-c48b/')
        || resource === 'arn:aws:cloudfront::806168576068:distribution/E1CG52WRQZI7X1'
        || resource === 'REPLACE_WITH_CHECKSOPS_STAGING_DEPLOYMENT_GUARD_KMS_KEY_ARN',
      resource,
    );
  }
  const actions = policy.Statement.flatMap((row) => [].concat(row.Action)).sort();
  assert.deepEqual(actions, ['cloudfront:CreateInvalidation', 'kms:GetPublicKey', 'kms:Sign', 's3:GetObject', 's3:PutObject']);
  assert.equal(
    trust.Statement[0].Condition.StringEquals['token.actions.githubusercontent.com:sub'],
    'repo:michaelcarletta-cmd/ChecksOps:environment:staging',
  );
});

test('issued receipt satisfies both guard checks staging-spa-upload.mjs performs', async (t) => {
  const { refuseUnguardedDeploy } = await import('../../scripts/deployment-guard/require-guard.mjs');
  const { lookupSharedBucket } = await import('../../scripts/deployment-guard/lib/shared-targets.mjs');
  const root = tempRoot(t);
  const result = await run({
    ...BASE_ENV,
    CHECKSOPS_STAGING_DEPLOY_MODE: 'apply',
    CHECKSOPS_EXPECTED_LIVE_INDEX_SHA256: LIVE.index_html_sha256,
  }, { root, readLive: () => LIVE, buildEnv: BUILD_ENV, registry, contractRunner: () => true, signer: (u) => u });
  const env = { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1', CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT: result.authorization.receiptFile };
  const identity = { workstream_id: 'github-staging-spa-4321', commit: SHA };
  const scriptGuard = refuseUnguardedDeploy({
    target_environment: 'staging', target_component: 'staging-frontend', deployment_type: 'spa-promote', ...identity,
  }, { root, env });
  assert.equal(scriptGuard.ok, true, scriptGuard.message);
  const bucketGuard = refuseUnguardedDeploy({ ...lookupSharedBucket('checksops-staging-frontend-c48b'), ...identity }, { root, env });
  assert.equal(bucketGuard.ok, true, bucketGuard.message);
  const otherWorkstream = refuseUnguardedDeploy({
    target_environment: 'staging', target_component: 'staging-frontend', deployment_type: 'spa-promote',
    workstream_id: 'someone-else', commit: SHA,
  }, { root, env });
  assert.equal(otherWorkstream.ok, false);
  const production = refuseUnguardedDeploy({ ...lookupSharedBucket('checksops-production-frontend-806168576068'), ...identity }, { root, env });
  assert.equal(production.ok, false);
});

test('workflow never interpolates expressions into run scripts', () => {
  const lines = workflow.split('\n');
  const offenders = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^(\s*)run: (\|)?(.*)$/);
    if (!match) continue;
    if (!match[2]) {
      if (match[3].includes('${{')) offenders.push(i + 1);
      continue;
    }
    const indent = match[1].length;
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j];
      if (line.trim() && line.match(/^(\s*)/)[1].length <= indent) break;
      if (line.includes('${{')) offenders.push(j + 1);
    }
  }
  assert.deepEqual(offenders, [], `run scripts must read inputs and outputs through env (lines ${offenders.join(', ')})`);
  assert.match(workflow, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(workflow, /\^\[0-9a-f\]\{64\}\$/);
});

test('inspect assumes only the read-only role; apply alone assumes the narrowed upload role', () => {
  const step = (name) => {
    const start = workflow.indexOf(`      - name: ${name}`);
    assert.notEqual(start, -1, name);
    const next = workflow.indexOf('\n      - name:', start + 1);
    return workflow.slice(start, next === -1 ? undefined : next);
  };
  const inspect = step('Configure read-only staging AWS session (inspect)');
  assert.match(inspect, /if: \$\{\{ inputs\.mode == 'inspect' \}\}/);
  assert.match(inspect, /CHECKSOPS_STAGING_SPA_INSPECT_ROLE_ARN/);
  assert.doesNotMatch(inspect, /CHECKSOPS_STAGING_SPA_DEPLOY_ROLE_ARN|PutObject|kms|cloudfront/);
  assert.match(inspect, /"Action":\["s3:GetObject"\],"Resource":"arn:aws:s3:::checksops-staging-frontend-c48b\/index\.html"/);

  const apply = step('Configure staging SPA upload session (apply)');
  assert.match(apply, /if: \$\{\{ inputs\.mode == 'apply' \}\}/);
  assert.match(apply, /CHECKSOPS_STAGING_SPA_DEPLOY_ROLE_ARN/);
  const session = JSON.parse(apply.match(/inline-session-policy: >-\n\s+(\{.*\})/)[1]);
  const actions = session.Statement.flatMap((row) => row.Action).sort();
  assert.deepEqual(actions, ['cloudfront:CreateInvalidation', 'kms:GetPublicKey', 'kms:Sign', 's3:GetObject', 's3:PutObject']);
  assert.ok(session.Statement.every((row) => row.Resource === '*' ? row.Action.every((a) => a.startsWith('kms:')) : true));

  const identity = step('Verify AWS identity');
  assert.match(identity, /ChecksOpsGitHubStagingSpaInspect\/checksops-staging-spa-inspect-\$GITHUB_RUN_ID/);
  assert.match(identity, /ChecksOpsGitHubStagingSpaUpload\/checksops-staging-spa-\$GITHUB_RUN_ID/);
});
