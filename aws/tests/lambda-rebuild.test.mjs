import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { run as preflight, validateApplyInputs, approvalPhrase } from '../../scripts/deployment-guard/github-lambda-rebuild.mjs';
import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import { DEPLOYMENT_TYPES } from '../../scripts/deployment-guard/lib/identity.mjs';
import { applyLambdaRebuild, resolveCandidateZip } from '../../scripts/deployment-guard/lib/lambda-rebuild-apply.mjs';
import {
  REBUILD_DEPLOYMENT_TYPE,
  REBUILD_PLAN_REL,
  buildCandidatePackage,
  diffDependencies,
  diffMembers,
  evaluateRebuild,
  fullPackageComponent,
  loadRebuildPlan,
  packageInventory,
  parseFullPackageComponent,
  readPackage,
} from '../../scripts/deployment-guard/lib/lambda-rebuild.mjs';
import { acquireLease } from '../../scripts/deployment-guard/lib/lease.mjs';
import { issueReceipt } from '../../scripts/deployment-guard/lib/receipt.mjs';
import { writeZipMembers } from '../../scripts/deployment-guard/lib/zip-members.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHA = 'a'.repeat(40);
const NOW = Date.parse('2026-10-21T12:00:00.000Z');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const LIVE_FILES = {
  'index.mjs': 'export const handler = "live";\n',
  'package.json': '{"name":"api","version":"0.1.0"}\n',
  'package-lock.json': '{"name":"api","lockfileVersion":3}\n',
  'ocr.mjs': 'export const ocr = "same";\n',
  'write.mjs': 'export const write = "live";\n',
  'live-only.mjs': 'export const liveOnly = true;\n',
  'node_modules/pg/package.json': '{"name":"pg","version":"8.23.0"}\n',
  'node_modules/pg/index.js': 'module.exports = {};\n',
  'node_modules/@aws-sdk/client-s3/package.json': '{"name":"@aws-sdk/client-s3","version":"3.1124.0"}\n',
};
const CANDIDATE_FILES = {
  ...LIVE_FILES,
  'write.mjs': 'export const write = "main";\n',
  'new-on-main.mjs': 'export const added = true;\n',
  'node_modules/@aws-sdk/client-kms/package.json': '{"name":"@aws-sdk/client-kms","version":"3.1124.0"}\n',
  'node_modules/@aws-sdk/client-kms/index.js': 'module.exports = {};\n',
};
delete CANDIDATE_FILES['live-only.mjs'];

const hashes = (files) => Object.fromEntries(Object.entries(files).map(([name, text]) => [name, sha256(text)]));
const inventoryOf = (files) => packageInventory(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, Buffer.from(text)])));

const FULL_PLAN = {
  function_name: 'checksops-staging-api',
  members: { 'write.mjs': { live_sha256: sha256(LIVE_FILES['write.mjs']), accepted_sha256: sha256(CANDIDATE_FILES['write.mjs']) } },
  added: { 'new-on-main.mjs': sha256(CANDIDATE_FILES['new-on-main.mjs']) },
  removed: { 'live-only.mjs': sha256(LIVE_FILES['live-only.mjs']) },
  dependencies: { added: { 'node_modules/@aws-sdk/client-kms': '3.1124.0' }, removed: {}, changed: {} },
};
const planFor = (section) => ({ environments: { staging: section } });

function writeTree(root, files) {
  for (const [name, text] of Object.entries(files)) {
    const abs = path.join(root, name);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
}

function tmpRepo({ candidate = CANDIDATE_FILES, plan = FULL_PLAN } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-rebuild-'));
  fs.mkdirSync(path.join(root, 'ops/deployment-guard'), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, 'ops/deployment-guard/accepted-contracts.json'), path.join(root, 'ops/deployment-guard/accepted-contracts.json'));
  fs.writeFileSync(path.join(root, REBUILD_PLAN_REL), JSON.stringify({ environments: { staging: plan, production: { ...plan, function_name: 'checksops-production-prep-api' } } }));
  writeTree(path.join(root, 'aws/functions/api'), candidate);
  return root;
}

test('lambda-rebuild is a registered deployment type and the component carries the candidate hash', () => {
  assert.ok(DEPLOYMENT_TYPES.includes(REBUILD_DEPLOYMENT_TYPE));
  const component = fullPackageComponent('b'.repeat(64));
  assert.equal(parseFullPackageComponent(component), 'b'.repeat(64));
  assert.equal(parseFullPackageComponent('write.mjs'), null);
  assert.throws(() => fullPackageComponent('short'), /candidate ZIP SHA-256/);
});

test('the committed plan loads for both environments and starts pending', () => {
  for (const environment of ['staging', 'production']) {
    const section = loadRebuildPlan(REPO_ROOT, environment);
    assert.ok(section.function_name.startsWith('checksops-'));
    assert.deepEqual(Object.keys(section.members), []);
  }
});

test('member and dependency diffs classify every live-vs-candidate difference', () => {
  const members = diffMembers(hashes(LIVE_FILES), hashes(CANDIDATE_FILES));
  assert.deepEqual(members.changed.map((row) => row.name), ['write.mjs']);
  assert.deepEqual(members.added.map((row) => row.name), ['new-on-main.mjs']);
  assert.deepEqual(members.removed.map((row) => row.name), ['live-only.mjs']);
  assert.ok(members.same.includes('ocr.mjs'));
  assert.ok(!members.same.some((name) => name.startsWith('node_modules/')));
  const deps = diffDependencies(inventoryOf(LIVE_FILES), inventoryOf(CANDIDATE_FILES));
  assert.deepEqual(deps, { added: { 'node_modules/@aws-sdk/client-kms': '3.1124.0' }, removed: {}, changed: {} });
});

test('an empty plan blocks with every difference listed as a problem; a full plan is READY; identical packages are ALREADY_ACCEPTED', () => {
  const base = { liveMemberHashes: hashes(LIVE_FILES), candidateMemberHashes: hashes(CANDIDATE_FILES), liveInventory: inventoryOf(LIVE_FILES), candidateInventory: inventoryOf(CANDIDATE_FILES), environment: 'staging' };
  const empty = evaluateRebuild({ ...base, plan: planFor({ function_name: 'checksops-staging-api', members: {}, added: {}, removed: {}, dependencies: {} }) });
  assert.equal(empty.ok, false);
  assert.equal(empty.code, CODES.SOURCE_RECONCILIATION_REQUIRED);
  assert.deepEqual(empty.details.problems.map((row) => row.reason).sort(), ['unlisted_add', 'unlisted_change', 'unlisted_dependency_add', 'unlisted_removal']);
  const ready = evaluateRebuild({ ...base, plan: planFor(FULL_PLAN) });
  assert.equal(ready.ok, true, ready.message);
  assert.equal(ready.details.state, 'READY');
  const same = evaluateRebuild({ ...base, candidateMemberHashes: hashes(LIVE_FILES), candidateInventory: inventoryOf(LIVE_FILES), plan: planFor({ ...FULL_PLAN, members: {}, added: {}, removed: {}, dependencies: {} }) });
  assert.equal(same.details.state, 'ALREADY_ACCEPTED');
});

test('a listed member whose live bytes drifted, or whose candidate is not the accepted bytes, is refused', () => {
  const base = { liveMemberHashes: hashes(LIVE_FILES), candidateMemberHashes: hashes(CANDIDATE_FILES), liveInventory: inventoryOf(LIVE_FILES), candidateInventory: inventoryOf(CANDIDATE_FILES), environment: 'staging' };
  const drifted = evaluateRebuild({ ...base, plan: planFor({ ...FULL_PLAN, members: { 'write.mjs': { ...FULL_PLAN.members['write.mjs'], live_sha256: 'c'.repeat(64) } } }) });
  assert.equal(drifted.ok, false);
  assert.equal(drifted.code, CODES.DEPLOYMENT_COLLISION);
  assert.equal(drifted.details.problems[0].reason, 'live_mismatch');
  const stale = evaluateRebuild({ ...base, plan: planFor({ ...FULL_PLAN, members: { 'write.mjs': { ...FULL_PLAN.members['write.mjs'], accepted_sha256: 'd'.repeat(64) } } }) });
  assert.equal(stale.code, CODES.STALE_PACKAGE);
  const wrongVersion = evaluateRebuild({ ...base, plan: planFor({ ...FULL_PLAN, dependencies: { added: { 'node_modules/@aws-sdk/client-kms': '3.0.0' } } }) });
  assert.equal(wrongVersion.ok, false);
  assert.equal(wrongVersion.details.problems[0].reason, 'unlisted_dependency_add');
  assert.throws(() => evaluateRebuild({ ...base, plan: planFor({ ...FULL_PLAN, members: { 'write.mjs': { live_sha256: 'e'.repeat(64), accepted_sha256: 'e'.repeat(64) } } }) }), /identical live and accepted/);
});

test('the candidate build is deterministic, needs node_modules, and refuses symlinks', () => {
  const root = tmpRepo();
  const api = path.join(root, 'aws/functions/api');
  const first = buildCandidatePackage(api);
  const second = buildCandidatePackage(api);
  assert.equal(first.zipSha256, second.zipSha256);
  assert.equal(first.fileCount, Object.keys(CANDIDATE_FILES).length);
  assert.deepEqual(readPackage(first.zip).memberHashes, first.memberHashes);
  assert.equal(first.inventory['node_modules/@aws-sdk/client-kms'], '3.1124.0');
  fs.rmSync(path.join(api, 'node_modules'), { recursive: true });
  assert.throws(() => buildCandidatePackage(api), /no node_modules/);
  const sourceCount = Object.keys(CANDIDATE_FILES).filter((name) => !name.startsWith('node_modules/')).length;
  assert.equal(buildCandidatePackage(api, { requireNodeModules: false }).fileCount, sourceCount);
  fs.symlinkSync(path.join(api, 'index.mjs'), path.join(api, 'link.mjs'));
  assert.throws(() => buildCandidatePackage(api, { requireNodeModules: false }), /symlink/);
});

function fakeLambda({ zip, codeSha256 = 'live-code', revisionId = 'rev-1', updateStatus = 'Successful' }) {
  const state = { zip, codeSha256, revisionId, calls: [] };
  const configuration = () => ({ Role: 'arn:role', Runtime: 'nodejs22.x', Handler: 'index.handler', MemorySize: 1024, Timeout: 30, Environment: { Variables: { KEEP: '1' } }, VpcConfig: { SubnetIds: ['a'], SecurityGroupIds: ['b'] } });
  const adapter = {
    state,
    authorizeWrites: (details) => { state.calls.push(['authorizeWrites', details]); return { ok: true }; },
    getFunction: async () => ({ ok: true, details: { codeSha256: state.codeSha256, revisionId: state.revisionId, code_location: 'https://example.invalid/zip', configuration: configuration() } }),
    getFunctionConfiguration: async () => ({ ok: true, details: { codeSha256: state.codeSha256, revisionId: state.revisionId, lastUpdateStatus: updateStatus, configuration: configuration() } }),
    downloadFunctionCode: async () => ({ ok: true, details: { zip: state.zip, origin: 'fresh-live-download' } }),
    updateFunctionCode: async ({ zip, revisionId }) => {
      state.calls.push(['updateFunctionCode', revisionId]);
      if (revisionId !== state.revisionId) return { ok: false, code: CODES.DEPLOYMENT_COLLISION, message: 'revision mismatch' };
      state.zip = zip;
      state.codeSha256 = `code-${sha256(zip).slice(0, 8)}`;
      state.revisionId = 'rev-2';
      return { ok: true, details: { codeSha256: state.codeSha256, revisionId: state.revisionId } };
    },
  };
  return adapter;
}

function issueRebuildReceipt(root, { candidateSha256, environment = 'staging', component = 'checksops-staging-api', fingerprint = { codeSha256: 'live-code', revisionId: 'rev-1' } }) {
  const lease = acquireLease(root, { workstream_id: 'ws-rebuild', component, environment, commit: SHA, operator: 'tester' }, NOW);
  assert.equal(lease.ok, true, lease.message);
  const issued = issueReceipt(root, {
    workstream_id: 'ws-rebuild',
    branch: 'main',
    commit: SHA,
    operator: 'tester',
    target_environment: environment,
    target_component: component,
    deployment_type: REBUILD_DEPLOYMENT_TYPE,
    owned_components: [fullPackageComponent(candidateSha256)],
    preflight_live_fingerprint: fingerprint,
    lease: lease.details.lease,
  }, { now: NOW });
  assert.equal(issued.ok, true, issued.message);
  return issued.details;
}

function stageCandidate(root, zip) {
  const dir = path.join(root, '.deployment-guard');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'rebuild-candidate-staging.zip');
  fs.writeFileSync(file, zip);
  return file;
}

const applyInput = (root, receipt, candidatePath, extra = {}) => ({
  apply: true,
  function_name: 'checksops-staging-api',
  target_environment: 'staging',
  workstream_id: 'ws-rebuild',
  commit: SHA,
  receipt_path: receipt.file,
  candidate_zip_path: candidatePath,
  ...extra,
});
const applyCtx = (root, aws, receiptFile = null) => ({
  env: { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1', ...(receiptFile ? { CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT: receiptFile } : {}) },
  guardRoot: root,
  repoRoot: root,
  aws,
  now: NOW,
});

test('the writer uploads the receipt-owned candidate, verifies every member and keeps configuration', async () => {
  const root = tmpRepo();
  const candidate = buildCandidatePackage(path.join(root, 'aws/functions/api'));
  const liveZip = writeZipMembers(LIVE_FILES);
  const aws = fakeLambda({ zip: liveZip });
  const receipt = issueRebuildReceipt(root, { candidateSha256: candidate.zipSha256 });
  const file = stageCandidate(root, candidate.zip);
  const result = await applyLambdaRebuild(applyInput(root, receipt, file), applyCtx(root, aws, receipt.file));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.details.candidate_zip_sha256, candidate.zipSha256);
  assert.deepEqual(readPackage(aws.state.zip).memberHashes, candidate.memberHashes);
  assert.equal(result.details.rebuild.state, 'READY');
  assert.equal(result.details.after.fingerprint.revisionId, 'rev-2');
  // The receipt is consumed: a second apply with the same receipt is refused.
  const again = await applyLambdaRebuild(applyInput(root, receipt, file), applyCtx(root, fakeLambda({ zip: liveZip }), receipt.file));
  assert.equal(again.ok, false);
});

test('the writer refuses a candidate the receipt does not own, a candidate outside the guard state, and live drift', async () => {
  const root = tmpRepo();
  const candidate = buildCandidatePackage(path.join(root, 'aws/functions/api'));
  const liveZip = writeZipMembers(LIVE_FILES);
  const receipt = issueRebuildReceipt(root, { candidateSha256: candidate.zipSha256 });
  const file = stageCandidate(root, candidate.zip);

  const tampered = path.join(root, '.deployment-guard', 'other.zip');
  fs.writeFileSync(tampered, writeZipMembers({ ...CANDIDATE_FILES, 'index.mjs': 'export const handler = "tampered";\n' }));
  const notOwned = await applyLambdaRebuild(applyInput(root, receipt, tampered), applyCtx(root, fakeLambda({ zip: liveZip }), receipt.file));
  assert.equal(notOwned.code, CODES.RECEIPT_MISMATCH);

  const outside = path.join(root, 'outside.zip');
  fs.writeFileSync(outside, candidate.zip);
  assert.equal(resolveCandidateZip(root, outside).code, CODES.UNRELATED_MUTATION);
  const outsideResult = await applyLambdaRebuild(applyInput(root, receipt, outside), applyCtx(root, fakeLambda({ zip: liveZip }), receipt.file));
  assert.equal(outsideResult.code, CODES.UNRELATED_MUTATION);

  const drifted = await applyLambdaRebuild(applyInput(root, receipt, file), applyCtx(root, fakeLambda({ zip: liveZip, revisionId: 'rev-9' }), receipt.file));
  assert.equal(drifted.code, CODES.DEPLOYMENT_COLLISION);

  const unlisted = await applyLambdaRebuild(applyInput(root, receipt, file, { plan: { ...FULL_PLAN, removed: {} } }), applyCtx(root, fakeLambda({ zip: liveZip }), receipt.file));
  assert.equal(unlisted.code, CODES.SOURCE_RECONCILIATION_REQUIRED);

  const noFlag = await applyLambdaRebuild(applyInput(root, receipt, file), { ...applyCtx(root, fakeLambda({ zip: liveZip }), receipt.file), env: { CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT: receipt.file } });
  assert.equal(noFlag.code, CODES.GUARD_APPLY_FORBIDDEN);
  const restore = await applyLambdaRebuild(applyInput(root, receipt, file, { restore: true }), applyCtx(root, fakeLambda({ zip: liveZip }), receipt.file));
  assert.equal(restore.code, CODES.STALE_PACKAGE);
});

test('an overlay receipt cannot authorize a rebuild', async () => {
  const root = tmpRepo();
  const candidate = buildCandidatePackage(path.join(root, 'aws/functions/api'));
  const lease = acquireLease(root, { workstream_id: 'ws-rebuild', component: 'checksops-staging-api', environment: 'staging', commit: SHA }, NOW);
  const overlay = issueReceipt(root, {
    workstream_id: 'ws-rebuild', branch: 'main', commit: SHA, target_environment: 'staging', target_component: 'checksops-staging-api',
    deployment_type: 'lambda-overlay', owned_components: ['write.mjs'], preflight_live_fingerprint: { codeSha256: 'live-code', revisionId: 'rev-1' }, lease: lease.details.lease,
  }, { now: NOW });
  const file = stageCandidate(root, candidate.zip);
  const result = await applyLambdaRebuild(applyInput(root, overlay.details, file), applyCtx(root, fakeLambda({ zip: writeZipMembers(LIVE_FILES) }), overlay.details.file));
  assert.equal(result.code, CODES.RECEIPT_MISMATCH);
});

const ENV = { GITHUB_SHA: SHA, GITHUB_REF_NAME: 'main', GITHUB_ACTOR: 'owner', GITHUB_RUN_ID: '777', CHECKSOPS_REBUILD_ENVIRONMENT: 'staging' };
const liveDeps = (zip, extra = {}) => ({
  inspectLive: async () => ({ functionName: 'checksops-staging-api', codeSha256: 'live-code', revisionId: 'rev-1', ...readPackage(zip) }),
  signer: (unsigned) => unsigned,
  ...extra,
});

test('preflight inspect reports BLOCKED with the unlisted differences and writes the diff file', async () => {
  const root = tmpRepo({ plan: { function_name: 'checksops-staging-api', members: {}, added: {}, removed: {}, dependencies: {} } });
  const result = await preflight({ ...ENV, CHECKSOPS_REBUILD_MODE: 'inspect' }, { root, ...liveDeps(writeZipMembers(LIVE_FILES)) });
  assert.equal(result.state, 'BLOCKED');
  assert.equal(result.mutation, false);
  assert.equal(result.problems.length, 4);
  assert.ok(fs.existsSync(path.join(root, '.deployment-guard/rebuild-diff-staging.json')));
  assert.ok(!fs.existsSync(path.join(root, '.deployment-guard/rebuild-candidate-staging.zip')));
});

test('preflight apply needs the inspect CodeSha256 and the exact phrase, then issues a rebuild receipt and the candidate', async () => {
  const root = tmpRepo();
  const live = writeZipMembers(LIVE_FILES);
  await assert.rejects(
    preflight({ ...ENV, CHECKSOPS_REBUILD_MODE: 'apply', CHECKSOPS_EXPECTED_LIVE_CODE_SHA256: 'live-code', CHECKSOPS_REBUILD_APPROVAL: 'deploy please' }, { root, ...liveDeps(live) }),
    (error) => error.code === CODES.PRODUCTION_APPROVAL_REQUIRED,
  );
  await assert.rejects(
    preflight({ ...ENV, CHECKSOPS_REBUILD_MODE: 'apply', CHECKSOPS_EXPECTED_LIVE_CODE_SHA256: 'stale', CHECKSOPS_REBUILD_APPROVAL: approvalPhrase('staging') }, { root, ...liveDeps(live) }),
    (error) => error.code === CODES.DEPLOYMENT_COLLISION,
  );
  const result = await preflight({ ...ENV, CHECKSOPS_REBUILD_MODE: 'apply', CHECKSOPS_EXPECTED_LIVE_CODE_SHA256: 'live-code', CHECKSOPS_REBUILD_APPROVAL: approvalPhrase('staging') }, { root, ...liveDeps(live) });
  assert.equal(result.state, 'READY');
  const receipt = JSON.parse(fs.readFileSync(result.authorization.receiptFile, 'utf8'));
  assert.equal(receipt.deployment_type, REBUILD_DEPLOYMENT_TYPE);
  assert.deepEqual(receipt.owned_components, [fullPackageComponent(result.candidate_zip_sha256)]);
  assert.equal(sha256(fs.readFileSync(result.authorization.candidateZip)), result.candidate_zip_sha256);
  const input = JSON.parse(fs.readFileSync(result.authorization.rebuildInput, 'utf8'));
  assert.equal(input.candidate_zip_path, result.authorization.candidateZip);
  // The writer accepts exactly what the preflight produced.
  const aws = fakeLambda({ zip: live });
  // The preflight issued the receipt at the real clock; apply at the real clock too.
  const applied = await applyLambdaRebuild({ ...input, apply: true }, { ...applyCtx(root, aws, input.receipt_path), now: Date.now() });
  assert.equal(applied.ok, true, JSON.stringify(applied));
});

test('production apply needs a staging acceptance reference and refuses an unlisted plan', async () => {
  assert.throws(() => validateApplyInputs({ environment: 'production', approval: approvalPhrase('production'), stagingAcceptance: '', expectedLiveCodeSha256: 'x', liveCodeSha256: 'x' }), (error) => error.code === CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.doesNotThrow(() => validateApplyInputs({ environment: 'production', approval: approvalPhrase('production'), stagingAcceptance: 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/1', expectedLiveCodeSha256: 'x', liveCodeSha256: 'x' }));
  const root = tmpRepo({ plan: { function_name: 'checksops-staging-api', members: {}, added: {}, removed: {}, dependencies: {} } });
  await assert.rejects(
    preflight({ ...ENV, CHECKSOPS_REBUILD_MODE: 'apply', CHECKSOPS_EXPECTED_LIVE_CODE_SHA256: 'live-code', CHECKSOPS_REBUILD_APPROVAL: approvalPhrase('staging') }, { root, ...liveDeps(writeZipMembers(LIVE_FILES)) }),
    (error) => error.code === CODES.SOURCE_RECONCILIATION_REQUIRED,
  );
});

test('preflight verify passes only when the live package equals the candidate', async () => {
  const root = tmpRepo();
  const candidateZip = buildCandidatePackage(path.join(root, 'aws/functions/api')).zip;
  const verified = await preflight({ ...ENV, CHECKSOPS_REBUILD_MODE: 'verify' }, { root, ...liveDeps(candidateZip) });
  assert.equal(verified.state, 'VERIFIED');
  await assert.rejects(
    preflight({ ...ENV, CHECKSOPS_REBUILD_MODE: 'verify' }, { root, ...liveDeps(writeZipMembers(LIVE_FILES)) }),
    (error) => error.code === CODES.DEPLOYMENT_COLLISION,
  );
});
