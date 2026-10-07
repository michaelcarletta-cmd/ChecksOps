import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { mock, test } from 'node:test';

import {
  buildOverlayReceiptInput,
  run,
  validateExpectedMemberHash,
  validateRequestedMember,
  workflowIdentity,
} from '../../scripts/deployment-guard/github-staging-lambda-overlay.mjs';
import { acquireLease } from '../../scripts/deployment-guard/lib/lease.mjs';
import { issueReceipt, validateReceipt } from '../../scripts/deployment-guard/lib/receipt.mjs';
import { hashZipMembers, writeZipMembers } from '../../scripts/deployment-guard/lib/zip-members.mjs';

const SHA='a'.repeat(40);

const workflow = fs.readFileSync(new URL('../../.github/workflows/guarded-staging-lambda-overlay.yml', import.meta.url), 'utf8');
const smoke = workflow.match(/node --input-type=module <<'NODE'\n([\s\S]*?)\n          NODE/)[1];

async function runPublicSmoke(overrides = {}) {
  const logs = [];
  const calls = [];
  const bodies = {
    '/health': { status: 'ok' },
    '/db-health': { service: 'checksops-api', status: 'ok' },
    '/db-readonly-validate': { service: 'checksops-api', status: 'ok', readOnly: true },
  };
  const context = vm.createContext({
    AbortSignal,
    console: { log: (line) => logs.push(JSON.parse(line)) },
    fetch: async (url, options) => {
      assert.equal(options.method, 'GET');
      assert.equal(options.headers.accept, 'application/json');
      assert.equal(new URL(url).origin, 'https://psr19uhop4.execute-api.us-east-1.amazonaws.com');
      const route = new URL(url).pathname.replace('/staging', '');
      calls.push(route);
      const response = overrides[route] || { body: bodies[route] };
      return new Response(response.raw ?? JSON.stringify(response.body), { status: response.status || 200 });
    },
  });
  try {
    await new vm.Script(`(async () => {${smoke}\n})()`).runInContext(context);
    return { logs, calls };
  } catch (error) {
    return { logs, calls, error };
  }
}

test('public smoke runs in inspect mode and still requires all three healthy endpoints', async () => {
  const step = workflow.split('- name: Public staging smoke (inspect or post-deploy)')[1].split('- name: Cleanup')[0];
  assert.doesNotMatch(step, /if:/);
  const result = await runPublicSmoke();
  assert.equal(result.error, undefined);
  assert.deepEqual(result.calls, ['/health', '/db-health', '/db-readonly-validate']);
  assert.deepEqual(result.logs.at(-1), { health: 'ok', dbHealth: 'redacted-ok', dbReadonlyValidate: 'redacted-ok' });
});

test('public smoke rejects unhealthy, legacy, malformed, and leaking responses without logging bodies', async () => {
  for (const route of ['/db-health', '/db-readonly-validate']) {
    for (const response of [
      { status: 503, body: { status: 'unhealthy', error: 'private-diagnostic-marker' } },
      { body: { status: 'unhealthy' } },
      { body: { ok: true, currentUser: 'private-diagnostic-marker' } },
      { body: { service: 'checksops-api' } },
      { body: { status: 'private-diagnostic-marker' } },
      { body: { status: 'ok', readOnly: true, error: 'private-diagnostic-marker' } },
      { raw: 'private-diagnostic-marker' },
      { body: null },
      { body: [] },
    ]) {
      const result = await runPublicSmoke({ [route]: response });
      assert.ok(result.error, `${route} must reject ${JSON.stringify(response)}`);
      assert.doesNotMatch(JSON.stringify(result.logs) + result.error.message, /private-diagnostic-marker|currentUser/);
      const diagnostic = result.logs.at(-1);
      assert.equal(diagnostic.path, route);
      assert.equal(diagnostic.httpStatus, response.status || 200);
      assert.deepEqual(Object.keys(diagnostic), ['path', 'httpStatus', 'jsonObject', 'status', 'redacted']);
      assert.ok(['ok', 'unhealthy', 'missing', 'unexpected'].includes(diagnostic.status));
    }
  }
});

test('public validation smoke rejects absent or false readOnly even with status ok', async () => {
  for (const readOnly of [undefined, false, 'true']) {
    const result = await runPublicSmoke({
      '/db-readonly-validate': { body: { status: 'ok', readOnly } },
    });
    assert.match(result.error.message, /not healthy\/read-only/);
  }
});

test('GitHub staging overlay accepts a normal Lambda member inside aws/functions/api',()=>{
  const result=validateRequestedMember('index.mjs');
  assert.equal(result.ok,true);
  assert.equal(result.details.member,'index.mjs');
  assert.equal(result.details.sourceRelative,'aws/functions/api/index.mjs');
});

test('GitHub staging overlay refuses traversal and missing members',()=>{
  assert.equal(validateRequestedMember('../index.mjs').ok,false);
  assert.equal(validateRequestedMember('definitely-missing.mjs').ok,false);
});

test('apply requires exact reviewed live member hash',()=>{
  const hash='b'.repeat(64);
  assert.equal(validateExpectedMemberHash(hash,hash).ok,true);
  const moved=validateExpectedMemberHash(hash,'c'.repeat(64));
  assert.equal(moved.ok,false);
  assert.equal(moved.code,'SOURCE_RECONCILIATION_REQUIRED');
  assert.equal(validateExpectedMemberHash(hash,'').ok,false);
});

test('workflow identity is pinned to main with complete GitHub identity',()=>{
  const identity=workflowIdentity({
    GITHUB_SHA:SHA,
    GITHUB_REF_NAME:'main',
    GITHUB_ACTOR:'operator',
    GITHUB_RUN_ID:'1234',
  });
  assert.equal(identity.commit,SHA);
  assert.equal(identity.branch,'main');
  assert.equal(identity.workstreamId,'github-staging-overlay-1234');
  assert.throws(()=>workflowIdentity({
    GITHUB_SHA:SHA,
    GITHUB_REF_NAME:'feature',
    GITHUB_ACTOR:'operator',
    GITHUB_RUN_ID:'1234',
  }),/only run from main/);
});

const env = {
  GITHUB_SHA: SHA,
  GITHUB_REF_NAME: 'main',
  GITHUB_ACTOR: 'operator',
  GITHUB_RUN_ID: '1234',
  CHECKSOPS_STAGING_OVERLAY_MEMBER: 'tenant-management-v2.mjs',
};

function inspectionDeps(present = false, configuration = {}) {
  const zip = writeZipMembers({
    'index.mjs': 'unrelated live handler',
    ...(present ? { 'tenant-management-v2.mjs': 'reviewed live member' } : {}),
  });
  const calls = [];
  return {
    calls,
    zip,
    lambda: {
      async send(command) {
        calls.push(command);
        assert.equal(command.operation, 'GetFunction');
        return {
          Configuration: { CodeSha256: 'live-code-sha', RevisionId: 'live-revision', ...configuration },
          Code: { Location: 'https://example.invalid/mock-lambda.zip' },
        };
      },
    },
    async fetchImpl(location) {
      assert.equal(location, 'https://example.invalid/mock-lambda.zip');
      return new Response(zip);
    },
    loadSdk() { throw new Error('inspect must not load any writer or signer SDK'); },
  };
}

test('inspect reports ABSENT and both live CAS fields without lease, receipt, or apply writes', async (t) => {
  const deps = inspectionDeps();
  const outputs = [];
  t.after(() => mock.restoreAll());
  for (const method of ['writeFileSync', 'mkdirSync', 'renameSync']) {
    mock.method(fs, method, () => assert.fail(`inspect called ${method}`));
  }
  mock.method(fs, 'appendFileSync', (file, data) => {
    assert.equal(file, '/tmp/mock-github-output');
    outputs.push(data);
  });
  const result = await run({ ...env, GITHUB_OUTPUT: '/tmp/mock-github-output' }, deps);
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'inspect');
  assert.equal(result.mutation, false);
  assert.equal(result.authorization, undefined);
  assert.equal(result.live.memberState, 'ABSENT');
  assert.equal(result.live.memberSha256, null);
  assert.equal(result.live.codeSha256, 'live-code-sha');
  assert.equal(result.live.revisionId, 'live-revision');
  assert.equal(deps.calls.length, 1);
  assert.match(outputs.join(''), /live_member_state=ABSENT\nlive_member_sha256=\n/);
  assert.doesNotMatch(outputs.join(''), /receipt_path|overlay_input|workstream_id/);
});

test('inspect still reports PRESENT and the exact reviewed member hash', async () => {
  const deps = inspectionDeps(true);
  const result = await run(env, deps);
  assert.equal(result.live.memberState, 'PRESENT');
  assert.equal(result.live.memberSha256, hashZipMembers(deps.zip)[env.CHECKSOPS_STAGING_OVERLAY_MEMBER]);
  assert.equal(result.authorization, undefined);
});

test('inspect refuses incomplete live fingerprints even for an absent member', async () => {
  for (const field of ['CodeSha256', 'RevisionId']) {
    await assert.rejects(run(env, inspectionDeps(false, { [field]: null })), { code: 'DEPLOYMENT_COLLISION' });
  }
});

test('explicit ADD produces signed single-member add ownership bound to inspected live CAS', async (t) => {
  const { identity, live } = await run(env, inspectionDeps());
  const input = buildOverlayReceiptInput(identity, live, 'add');
  assert.deepEqual(input.owned_components, ['tenant-management-v2.mjs']);
  assert.deepEqual(input.owned_member_ops, { replace: [], add: ['tenant-management-v2.mjs'] });
  assert.deepEqual(input.preflight_live_fingerprint, { codeSha256: live.codeSha256, revisionId: live.revisionId });

  // Offline test receipt only; the production wrapper still uses the KMS signer.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-staging-overlay-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lease = acquireLease(root, {
    workstream_id: identity.workstreamId,
    component: input.target_component,
    environment: input.target_environment,
    commit: identity.commit,
    operator: identity.operator,
  });
  assert.equal(lease.ok, true, lease.message);
  const issued = issueReceipt(root, { ...input, lease: lease.details.lease });
  assert.equal(issued.ok, true, issued.message);
  assert.deepEqual(issued.details.receipt.owned_member_ops, { replace: [], add: ['tenant-management-v2.mjs'] });
  assert.equal(validateReceipt(issued.details.receipt, {}, { root }).ok, true);
});

test('ADD refuses an already-present member before acquiring a lease or signing', async (t) => {
  t.after(() => mock.restoreAll());
  mock.method(fs, 'mkdirSync', () => assert.fail('rejected ADD must not acquire a lease'));
  await assert.rejects(run({
    ...env,
    CHECKSOPS_STAGING_DEPLOY_MODE: 'apply',
    CHECKSOPS_STAGING_OVERLAY_OPERATION: 'add',
  }, inspectionDeps(true)), { code: 'DEPLOYMENT_COLLISION' });
});

test('absence never silently authorizes ADD; REPLACE and invalid operations fail before lease', async (t) => {
  t.after(() => mock.restoreAll());
  mock.method(fs, 'mkdirSync', () => assert.fail('rejected operation must not acquire a lease'));
  const applyEnv = { ...env, CHECKSOPS_STAGING_DEPLOY_MODE: 'apply' };
  await assert.rejects(run(applyEnv, inspectionDeps()), { code: 'INVALID_MANIFEST' });
  await assert.rejects(run({
    ...applyEnv,
    CHECKSOPS_EXPECTED_LIVE_MEMBER_SHA256: 'b'.repeat(64),
  }, inspectionDeps()), { code: 'SOURCE_RECONCILIATION_REQUIRED' });
  await assert.rejects(run({
    ...applyEnv,
    CHECKSOPS_STAGING_OVERLAY_OPERATION: 'auto',
  }, inspectionDeps()), { code: 'INVALID_MANIFEST' });
});

test('REPLACE receipt ownership and reviewed-hash requirement are unchanged', async () => {
  const { identity, live } = await run(env, inspectionDeps(true));
  assert.throws(() => buildOverlayReceiptInput(identity, live, 'replace'), { code: 'INVALID_MANIFEST' });
  assert.throws(() => buildOverlayReceiptInput(identity, live, 'replace', 'b'.repeat(64)), { code: 'SOURCE_RECONCILIATION_REQUIRED' });
  const input = buildOverlayReceiptInput(identity, live, 'replace', live.memberSha256);
  assert.deepEqual(input.owned_member_ops, { replace: ['tenant-management-v2.mjs'], add: [] });
  assert.deepEqual(input.preflight_live_fingerprint, { codeSha256: live.codeSha256, revisionId: live.revisionId });
});
