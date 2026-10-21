import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CORS_DEPLOYMENT_TYPE,
  CORS_OWNED_COMPONENT,
  CORS_TARGET_COMPONENT,
  EXPECTED,
  TARGET_ORIGINS,
  assertOnlyCorsDelta,
  desiredCors,
  main as writer,
  normalizeSnapshot,
  snapshotFingerprint,
  validatePinnedSnapshot,
  validateTightenedSnapshot,
} from '../../scripts/deployment-guard/production-cors-update.mjs';
import { APPROVAL_PHRASE, classify, run as preflight, validateApplyInputs } from '../../scripts/deployment-guard/github-production-cors.mjs';
import { consumeReceiptOnce } from '../../scripts/deployment-guard/lib/consumed-receipts.mjs';
import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import { DEPLOYMENT_TYPES } from '../../scripts/deployment-guard/lib/identity.mjs';
import { acquireLease } from '../../scripts/deployment-guard/lib/lease.mjs';
import { issueReceipt } from '../../scripts/deployment-guard/lib/receipt.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHA = 'c'.repeat(40);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/123';

function live({ origins = ['*'], etag = 'E1VC38T7YXB528', revision = '58733b08-ef0a-4ab9-a47a-30fc15ebeafb' } = {}) {
  return normalizeSnapshot({
    api: { ApiId: 'kiqojucc02', DisableExecuteApiEndpoint: false, CorsConfiguration: { ...structuredClone(EXPECTED.cors), AllowOrigins: [...origins] } },
    routes: { Items: [
      { RouteKey: 'OPTIONS /{proxy+}', AuthorizationType: 'NONE' },
      { RouteKey: '$default', AuthorizationType: 'CUSTOM', AuthorizerId: '0dwrwx' },
    ] },
    authorizers: { Items: [{ AuthorizerId: '0dwrwx', Name: 'checksops-production-origin-verify' }] },
    cloudfront: { ETag: etag, Distribution: { Status: 'Deployed', DistributionConfig: { WebACLId: EXPECTED.cloudfront.WebACLId } } },
    lambda: { CodeSha256: 'sxodWyRpUr0LbETU0YhBayaqYe1VsfNBQi1OoMZpd4U=', RevisionId: revision },
  });
}

test('the CORS deployment type is registered, so its receipts can validate', () => {
  assert.ok(DEPLOYMENT_TYPES.includes(CORS_DEPLOYMENT_TYPE));
});

test('the pinned live shape passes whatever the current Lambda and CloudFront fingerprints are', () => {
  assert.equal(validatePinnedSnapshot(live()).ok, true);
  // Deploys move these every time; they are pinned through the signed snapshot instead.
  assert.equal(validatePinnedSnapshot(live({ etag: 'OTHER', revision: 'rev-9' })).ok, true);
});

test('drift in the pinned shape fails closed', () => {
  for (const mutate of [
    s => { s.api.CorsConfiguration.MaxAge = 1; },
    s => { s.api.CorsConfiguration.AllowHeaders = ['authorization']; },
    s => { s.authorizer.Name = 'moved'; },
    s => { s.routes = s.routes.slice(1); },
    s => { s.cloudfront.WebACLId = 'none'; },
    s => { s.cloudfront.Status = 'InProgress'; },
    s => { s.cloudfront.ETag = null; },
    s => { s.lambda.RevisionId = null; },
    s => { s.api.DisableExecuteApiEndpoint = true; },
  ]) {
    const s = live();
    mutate(s);
    assert.equal(validatePinnedSnapshot(s).ok, false);
  }
});

test('desired CORS changes only AllowOrigins', () => {
  assert.deepEqual(desiredCors(structuredClone(EXPECTED.cors)), { ...EXPECTED.cors, AllowOrigins: [...TARGET_ORIGINS] });
});

test('unexpected CORS shape is refused', () => {
  assert.throws(() => desiredCors({ ...EXPECTED.cors, AllowCredentials: true }), /cors_shape_drift/);
});

test('post-write verifier accepts only exact CORS delta', () => {
  const before = live();
  const after = structuredClone(before);
  after.api.CorsConfiguration = desiredCors(before.api.CorsConfiguration);
  assert.doesNotThrow(() => assertOnlyCorsDelta(before, after));
  after.lambda.RevisionId = 'changed';
  assert.throws(() => assertOnlyCorsDelta(before, after), /post_write_non_cors_drift/);
});

test('classify: READY on the baseline, ALREADY_ACCEPTED once tightened, BLOCKED on drift', () => {
  assert.equal(classify(live()).state, 'READY');
  assert.equal(classify(live({ origins: TARGET_ORIGINS })).state, 'ALREADY_ACCEPTED');
  assert.equal(validateTightenedSnapshot(live({ origins: TARGET_ORIGINS })).ok, true);
  assert.equal(classify(live({ origins: ['https://evil.example'] })).state, 'BLOCKED');
});

test('apply inputs need the exact phrase, a staging acceptance URL and the inspect snapshot hash', () => {
  const fp = snapshotFingerprint(live());
  assert.equal(APPROVAL_PHRASE, 'TIGHTEN PRODUCTION CORS');
  assert.throws(() => validateApplyInputs({ approval: 'tighten cors', stagingAcceptance: STAGING_REF, expectedFingerprint: fp, liveFingerprint: fp }), (e) => e.code === CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.throws(() => validateApplyInputs({ approval: APPROVAL_PHRASE, stagingAcceptance: 'staging ok', expectedFingerprint: fp, liveFingerprint: fp }), (e) => e.code === CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.throws(() => validateApplyInputs({ approval: APPROVAL_PHRASE, stagingAcceptance: STAGING_REF, expectedFingerprint: 'a'.repeat(64), liveFingerprint: fp }), (e) => e.code === CODES.DEPLOYMENT_COLLISION);
  assert.doesNotThrow(() => validateApplyInputs({ approval: APPROVAL_PHRASE, stagingAcceptance: STAGING_REF, expectedFingerprint: fp, liveFingerprint: fp }));
});

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-cors-'));
  fs.mkdirSync(path.join(root, 'ops/deployment-guard'), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, 'ops/deployment-guard/accepted-contracts.json'), path.join(root, 'ops/deployment-guard/accepted-contracts.json'));
  return root;
}

// A fake AWS: readSnapshot returns the current state, updateApiCors swaps the origins.
function fakeAws(initial, { afterUpdate = null } = {}) {
  const state = { snapshot: initial, updates: [] };
  return {
    state,
    readSnapshot: () => structuredClone(state.snapshot),
    updateApiCors: (cors) => {
      state.updates.push(cors);
      state.snapshot = structuredClone(state.snapshot);
      state.snapshot.api.CorsConfiguration = cors;
      if (afterUpdate) afterUpdate(state.snapshot);
    },
  };
}

const ENV = { GITHUB_SHA: SHA, GITHUB_REF_NAME: 'main', GITHUB_ACTOR: 'owner', GITHUB_RUN_ID: '4242' };

async function preflightApply(root, aws, extra = {}) {
  const fp = snapshotFingerprint(aws.readSnapshot());
  return preflight({
    ...ENV,
    CHECKSOPS_CORS_MODE: 'apply',
    CHECKSOPS_EXPECTED_SNAPSHOT_SHA256: fp,
    CHECKSOPS_STAGING_ACCEPTANCE_REFERENCE: STAGING_REF,
    CHECKSOPS_CORS_APPROVAL: APPROVAL_PHRASE,
    ...extra,
  }, { root, readSnapshot: aws.readSnapshot, signer: (unsigned) => unsigned });
}

function writerEnv(result) {
  return {
    CHECKSOPS_PRODUCTION_CORS_EXECUTE: '1',
    CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1',
    CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT: result.authorization.receiptFile,
    CHECKSOPS_CORS_INPUT: result.authorization.corsInput,
    CHECKSOPS_WORKSTREAM_ID: result.identity.workstreamId,
    CHECKSOPS_COMMIT: SHA,
  };
}

test('inspect never writes and reports the live state', async () => {
  const root = tmpRoot();
  const aws = fakeAws(live());
  const result = await preflight({ ...ENV, CHECKSOPS_CORS_MODE: 'inspect' }, { root, readSnapshot: aws.readSnapshot });
  assert.equal(result.state, 'READY');
  assert.equal(result.mutation, false);
  assert.equal(result.snapshot_sha256, snapshotFingerprint(live()));
  assert.equal(aws.state.updates.length, 0);
});

test('preflight apply issues a receipt the writer accepts; only AllowOrigins changes; the receipt is single-use', async () => {
  const root = tmpRoot();
  const aws = fakeAws(live());
  const result = await preflightApply(root, aws);
  const receipt = JSON.parse(fs.readFileSync(result.authorization.receiptFile, 'utf8'));
  assert.equal(receipt.deployment_type, CORS_DEPLOYMENT_TYPE);
  assert.equal(receipt.target_component, CORS_TARGET_COMPONENT);
  assert.deepEqual(receipt.owned_components, [CORS_OWNED_COMPONENT]);
  assert.deepEqual(receipt.preflight_live_fingerprint, live());
  const code = writer(writerEnv(result), { readSnapshot: aws.readSnapshot, updateApiCors: aws.updateApiCors, guardRoot: root });
  assert.equal(code, 0);
  assert.deepEqual(aws.state.updates, [{ ...EXPECTED.cors, AllowOrigins: [...TARGET_ORIGINS] }]);
  assert.equal(classify(aws.readSnapshot()).state, 'ALREADY_ACCEPTED');
  // Replaying the same receipt is refused before any write.
  aws.state.snapshot = live();
  assert.throws(() => writer(writerEnv(result), { readSnapshot: aws.readSnapshot, updateApiCors: aws.updateApiCors, guardRoot: root }), /receipt_consumption_failed|guard_refused/);
  assert.equal(aws.state.updates.length, 1);
});

test('the writer refuses when the Lambda or CloudFront moved after the receipt was issued', async () => {
  for (const moved of [live({ revision: 'rev-moved' }), live({ etag: 'ETAG-MOVED' })]) {
    const root = tmpRoot();
    const aws = fakeAws(live());
    const result = await preflightApply(root, aws);
    aws.state.snapshot = moved;
    assert.throws(() => writer(writerEnv(result), { readSnapshot: aws.readSnapshot, updateApiCors: aws.updateApiCors, guardRoot: root }), /guard_refused/);
    assert.equal(aws.state.updates.length, 0);
  }
});

test('the writer fails closed when the update changed anything besides AllowOrigins', async () => {
  const root = tmpRoot();
  const aws = fakeAws(live(), { afterUpdate: (s) => { s.lambda.RevisionId = 'moved-during-write'; } });
  const result = await preflightApply(root, aws);
  assert.throws(() => writer(writerEnv(result), { readSnapshot: aws.readSnapshot, updateApiCors: aws.updateApiCors, guardRoot: root }), /post_write_non_cors_drift/);
});

test('the writer refuses another deployment type, caller-supplied origins, a missing approval and plan-only runs', async () => {
  const root = tmpRoot();
  const aws = fakeAws(live());
  const lease = acquireLease(root, { workstream_id: 'ws-other', component: CORS_TARGET_COMPONENT, environment: 'production', commit: SHA, operator: 'x' });
  const other = issueReceipt(root, {
    workstream_id: 'ws-other', branch: 'main', commit: SHA, target_environment: 'production', target_component: CORS_TARGET_COMPONENT,
    deployment_type: 'apigateway-update', owned_components: [CORS_OWNED_COMPONENT], preflight_live_fingerprint: live(), lease: lease.details.lease,
  });
  assert.equal(other.ok, true, other.message);
  const input = path.join(root, 'input.json');
  fs.writeFileSync(input, JSON.stringify({ workstream_id: 'ws-other', commit: SHA, approval: { approved: true, workstream_id: 'ws-other' }, staging_acceptance: { ok: true, reference: STAGING_REF } }));
  const env = { CHECKSOPS_PRODUCTION_CORS_EXECUTE: '1', CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1', CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT: other.details.file, CHECKSOPS_CORS_INPUT: input };
  assert.throws(() => writer(env, { readSnapshot: aws.readSnapshot, updateApiCors: aws.updateApiCors, guardRoot: root }), /guard_refused|receipt_type_mismatch/);

  fs.writeFileSync(input, JSON.stringify({ origins: ['*'] }));
  assert.throws(() => writer(env, { readSnapshot: aws.readSnapshot, updateApiCors: aws.updateApiCors, guardRoot: root }), /caller_supplied_cors_forbidden/);

  const root2 = tmpRoot();
  const result = await preflightApply(root2, aws);
  const noApproval = JSON.parse(fs.readFileSync(result.authorization.corsInput, 'utf8'));
  delete noApproval.approval;
  fs.writeFileSync(result.authorization.corsInput, JSON.stringify(noApproval));
  assert.throws(() => writer(writerEnv(result), { readSnapshot: aws.readSnapshot, updateApiCors: aws.updateApiCors, guardRoot: root2 }), /production_gate/);

  assert.equal(writer({}, { readSnapshot: aws.readSnapshot, updateApiCors: aws.updateApiCors }), 2);
  assert.equal(aws.state.updates.length, 0);
});

test('preflight apply refuses an already-tightened API and a stale inspect hash; verify needs the allow-list live', async () => {
  const root = tmpRoot();
  const tightened = fakeAws(live({ origins: TARGET_ORIGINS }));
  await assert.rejects(preflightApply(root, tightened), (e) => e.code === CODES.UNRELATED_MUTATION);
  const aws = fakeAws(live());
  await assert.rejects(preflightApply(root, aws, { CHECKSOPS_EXPECTED_SNAPSHOT_SHA256: 'b'.repeat(64) }), (e) => e.code === CODES.DEPLOYMENT_COLLISION);
  await assert.rejects(preflight({ ...ENV, CHECKSOPS_CORS_MODE: 'verify' }, { root, readSnapshot: aws.readSnapshot }), (e) => e.code === CODES.DEPLOYMENT_COLLISION);
  const verified = await preflight({ ...ENV, CHECKSOPS_CORS_MODE: 'verify' }, { root, readSnapshot: tightened.readSnapshot });
  assert.equal(verified.state, 'VERIFIED');
});

test('receipt consumption is atomic and rejects replay', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-cors-receipt-'));
  const receipt = {
    mac: 'a'.repeat(64),
    workstream_id: 'security-sh2-cors',
    commit: 'b'.repeat(40),
    target_environment: 'production',
    target_component: 'production-http-api',
    deployment_type: 'apigateway-cors-update',
    expiry: '2099-01-01T00:00:00.000Z',
  };
  const first = consumeReceiptOnce(root, receipt, { now: 1, script: 'production-cors-update' });
  assert.equal(first.ok, true);
  const replay = consumeReceiptOnce(root, receipt, { now: 2, script: 'production-cors-update' });
  assert.equal(replay.ok, false);
  assert.equal(replay.code, 'RECEIPT_REUSED');
  fs.rmSync(root, { recursive: true, force: true });
});
