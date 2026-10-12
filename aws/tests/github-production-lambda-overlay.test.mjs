import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import {
  FUNCTION_NAME,
  approvalPhrase,
  loadPlan,
  localImports,
  resolvePlannedMember,
  run,
} from '../../scripts/deployment-guard/github-production-lambda-overlay.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLAN = loadPlan(ROOT);
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, PLAN.source), 'utf8'));
const WORKFLOW = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-production-lambda-overlay.yml'), 'utf8');
const sha = (rel) => createHash('sha256').update(fs.readFileSync(path.join(ROOT, rel))).digest('hex');
const ACCEPTANCE = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/37973071977';

const ENV = {
  GITHUB_SHA: 'a'.repeat(40),
  GITHUB_REF_NAME: 'main',
  GITHUB_ACTOR: 'owner',
  GITHUB_RUN_ID: '12345',
};

function liveFor(member, { sha256 = undefined, present = undefined, extra = [] } = {}) {
  const row = PLAN.members[member];
  const memberSha = sha256 !== undefined ? sha256 : row.expected_live_sha256;
  const isPresent = present !== undefined ? present : memberSha !== null;
  // Every module the planned members import is live except members the plan still has to ADD.
  const imported = PLAN.order.flatMap((name) => localImports(fs.readFileSync(path.join(ROOT, 'aws/functions/api', name), 'utf8')));
  const members = [...new Set(['index.mjs', ...PLAN.order, ...imported])]
    .filter((name) => PLAN.members[name]?.operation !== 'add')
    .concat(extra);
  if (isPresent && !members.includes(member)) members.push(member);
  return async () => ({
    functionName: FUNCTION_NAME,
    codeSha256: 'oQDCIRFyreTPe781aeSFLdXNfU3M2ZUQo5Wcgi0EqWI=',
    revisionId: 'f4904e55-61b3-46c4-bf1f-da178e84911b',
    member,
    memberState: isPresent ? 'PRESENT' : 'ABSENT',
    memberSha256: isPresent ? memberSha : null,
    members: isPresent ? members : members.filter((name) => name !== member),
  });
}

function applyDeps(member, liveOpts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-overlay-'));
  fs.mkdirSync(path.join(root, 'ops/deployment-guard'), { recursive: true });
  fs.mkdirSync(path.join(root, 'aws/functions/api'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'ops/deployment-guard/production-api-overlay-plan.json'), path.join(root, 'ops/deployment-guard/production-api-overlay-plan.json'));
  for (const name of PLAN.order) {
    fs.copyFileSync(path.join(ROOT, 'aws/functions/api', name), path.join(root, 'aws/functions/api', name));
  }
  const calls = {};
  return {
    calls,
    deps: {
      root,
      inspectLive: liveFor(member, liveOpts),
      acquireLease: (_root, input) => { calls.lease = input; return { ok: true, details: { lease: { id: 'lease-1', ...input } } }; },
      issueReceipt: (_root, input) => { calls.receipt = input; return { ok: true, details: { file: path.join(root, 'receipt.json') } }; },
    },
  };
}

const applyEnv = (member, extra = {}) => ({
  ...ENV,
  CHECKSOPS_PRODUCTION_DEPLOY_MODE: 'apply',
  CHECKSOPS_PRODUCTION_OVERLAY_MEMBER: member,
  CHECKSOPS_EXPECTED_LIVE_MEMBER_SHA256: PLAN.members[member].expected_live_sha256 || '',
  CHECKSOPS_STAGING_ACCEPTANCE_REFERENCE: ACCEPTANCE,
  CHECKSOPS_PRODUCTION_APPROVAL: approvalPhrase(member),
  ...extra,
});

test('plan pins main bytes to the accepted reconciliation and excludes ocr/index/delete-check', () => {
  assert.equal(PLAN.function_name, 'checksops-production-prep-api');
  for (const name of PLAN.order) {
    const row = PLAN.members[name];
    assert.equal(sha(`aws/functions/api/${name}`), row.accepted_sha256, name);
    assert.equal(row.accepted_sha256, MANIFEST.members[name].accepted_sha256, name);
    assert.equal(row.expected_live_sha256, MANIFEST.members[name].live_sha256, name);
    assert.equal(row.operation, MANIFEST.members[name].live_sha256 === null ? 'add' : 'replace', name);
  }
  for (const name of ['ocr.mjs', 'index.mjs', 'workflow-delete-check.mjs']) {
    assert.ok(!PLAN.order.includes(name), name);
    assert.equal(resolvePlannedMember(name, { root: ROOT, plan: PLAN }).code, CODES.UNRELATED_MUTATION, name);
  }
  // Added members land before any planned member that imports them.
  for (const [index, name] of PLAN.order.entries()) {
    const imports = localImports(fs.readFileSync(path.join(ROOT, 'aws/functions/api', name), 'utf8'));
    for (const dep of imports.filter((dep) => PLAN.members[dep]?.operation === 'add')) {
      assert.ok(PLAN.order.indexOf(dep) < index, `${dep} before ${name}`);
    }
  }
});

test('workflow is main-only, production-environment gated and offers exactly the planned members', () => {
  assert.match(WORKFLOW, /environment: production\n/);
  assert.match(WORKFLOW, /refs\/heads\/main/);
  assert.match(WORKFLOW, /DEPLOY \$INPUT_MEMBER TO PRODUCTION/);
  assert.match(WORKFLOW, /ChecksOpsGitHubProductionLambdaOverlay/);
  const options = WORKFLOW.split('member:')[1].split('approved_commit:')[0]
    .split('\n').map((line) => line.trim()).filter((line) => line.startsWith('- ')).map((line) => line.slice(2));
  assert.deepEqual(options, PLAN.order);
  for (const line of WORKFLOW.split('\n').filter((row) => row.includes('${{ inputs.'))) {
    assert.match(line, /^\s+([A-Z0-9_]+: \$\{\{ inputs\.[a-z0-9_]+ \}\}|if: \$\{\{ inputs\.mode == 'apply' \}\})$/, `inputs reach scripts through env only: ${line.trim()}`);
  }
});

test('inspect reports READY for reconciled live bytes and ALREADY_ACCEPTED when nothing is left to do', async () => {
  const ready = await run({ ...ENV, CHECKSOPS_PRODUCTION_DEPLOY_MODE: 'inspect', CHECKSOPS_PRODUCTION_OVERLAY_MEMBER: 'workflow.mjs' }, { root: ROOT, inspectLive: liveFor('workflow.mjs') });
  assert.equal(ready.state, 'READY');
  assert.equal(ready.mutation, false);
  const done = await run({ ...ENV, CHECKSOPS_PRODUCTION_DEPLOY_MODE: 'inspect', CHECKSOPS_PRODUCTION_OVERLAY_MEMBER: 'check-deposited.mjs' }, { root: ROOT, inspectLive: liveFor('check-deposited.mjs') });
  assert.equal(done.state, 'ALREADY_ACCEPTED');
  await assert.rejects(
    run(applyEnv('check-deposited.mjs'), applyDeps('check-deposited.mjs').deps),
    (error) => error.code === CODES.UNRELATED_MUTATION,
  );
});

test('replace refuses a live member that drifted from the reconciled bytes', async () => {
  await assert.rejects(
    run({ ...ENV, CHECKSOPS_PRODUCTION_DEPLOY_MODE: 'inspect', CHECKSOPS_PRODUCTION_OVERLAY_MEMBER: 'workflow.mjs' }, { root: ROOT, inspectLive: liveFor('workflow.mjs', { sha256: 'c'.repeat(64) }) }),
    (error) => error.code === CODES.SOURCE_RECONCILIATION_REQUIRED,
  );
  await assert.rejects(
    run(applyEnv('workflow.mjs', { CHECKSOPS_EXPECTED_LIVE_MEMBER_SHA256: 'd'.repeat(64) }), applyDeps('workflow.mjs').deps),
    (error) => error.code === CODES.SOURCE_RECONCILIATION_REQUIRED,
  );
});

test('add refuses when the member already exists live', async () => {
  await assert.rejects(
    run(applyEnv('claim-settlement-rpc.mjs'), applyDeps('claim-settlement-rpc.mjs', { sha256: 'e'.repeat(64), present: true }).deps),
    (error) => error.code === CODES.DEPLOYMENT_COLLISION,
  );
});

test('apply requires the exact approval phrase and a staging acceptance URL', async () => {
  await assert.rejects(
    run(applyEnv('workflow.mjs', { CHECKSOPS_PRODUCTION_APPROVAL: 'yes' }), applyDeps('workflow.mjs').deps),
    (error) => error.code === CODES.PRODUCTION_APPROVAL_REQUIRED,
  );
  await assert.rejects(
    run(applyEnv('workflow.mjs', { CHECKSOPS_STAGING_ACCEPTANCE_REFERENCE: 'trust me' }), applyDeps('workflow.mjs').deps),
    (error) => error.code === CODES.PRODUCTION_APPROVAL_REQUIRED,
  );
});

test('workflow-transitions waits for the ledger migration; data waits for claim-settlement-rpc', async () => {
  await assert.rejects(
    run(applyEnv('workflow-transitions.mjs'), applyDeps('workflow-transitions.mjs').deps),
    (error) => error.code === CODES.PRODUCTION_APPROVAL_REQUIRED,
  );
  await assert.rejects(
    run(applyEnv('data.mjs'), applyDeps('data.mjs').deps),
    (error) => error.code === CODES.DEPLOYMENT_COLLISION && error.details.missing.includes('claim-settlement-rpc.mjs'),
  );
  const ready = applyDeps('data.mjs', { extra: ['claim-settlement-rpc.mjs'] });
  const result = await run(applyEnv('data.mjs'), ready.deps);
  assert.equal(result.state, 'READY');
});

test('apply issues a production receipt bound to this run, the live fingerprint and staging acceptance', async () => {
  const { deps, calls } = applyDeps('workflow.mjs');
  const result = await run(applyEnv('workflow.mjs'), deps);
  assert.equal(result.mutation, false);
  assert.equal(calls.lease.environment, 'production');
  assert.equal(calls.lease.component, FUNCTION_NAME);
  assert.equal(calls.receipt.target_environment, 'production');
  assert.deepEqual(calls.receipt.owned_member_ops, { replace: ['workflow.mjs'], add: [] });
  assert.deepEqual(calls.receipt.production_fingerprint, calls.receipt.immediately_before_fingerprint);
  assert.equal(calls.receipt.approval.workstream_id, 'github-production-overlay-12345');
  const input = JSON.parse(fs.readFileSync(result.authorization.overlayInput, 'utf8'));
  assert.equal(input.function_name, FUNCTION_NAME);
  assert.deepEqual(input.member_sources, { 'workflow.mjs': 'aws/functions/api/workflow.mjs' });
  assert.equal(input.staging_acceptance.reference, ACCEPTANCE);
  assert.equal(input.approval.workstream_id, 'github-production-overlay-12345');
});

test('verify fails unless the live member is the accepted bytes', async () => {
  const accepted = PLAN.members['workflow.mjs'].accepted_sha256;
  const ok = await run({ ...ENV, CHECKSOPS_PRODUCTION_DEPLOY_MODE: 'verify', CHECKSOPS_PRODUCTION_OVERLAY_MEMBER: 'workflow.mjs' }, { root: ROOT, inspectLive: liveFor('workflow.mjs', { sha256: accepted }) });
  assert.equal(ok.state, 'VERIFIED');
  await assert.rejects(
    run({ ...ENV, CHECKSOPS_PRODUCTION_DEPLOY_MODE: 'verify', CHECKSOPS_PRODUCTION_OVERLAY_MEMBER: 'workflow.mjs' }, { root: ROOT, inspectLive: liveFor('workflow.mjs') }),
    (error) => error.code === CODES.DEPLOYMENT_COLLISION,
  );
});

test('non-main identity is refused', async () => {
  await assert.rejects(
    run({ ...ENV, GITHUB_REF_NAME: 'feature', CHECKSOPS_PRODUCTION_DEPLOY_MODE: 'inspect', CHECKSOPS_PRODUCTION_OVERLAY_MEMBER: 'workflow.mjs' }, { root: ROOT, inspectLive: liveFor('workflow.mjs') }),
    (error) => error.code === CODES.UNRELATED_MUTATION,
  );
});
