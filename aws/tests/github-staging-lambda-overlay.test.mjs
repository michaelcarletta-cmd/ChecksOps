import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { mock, test } from 'node:test';

import {
  buildOverlayReceiptInput,
  DIAGNOSTIC_VALIDATOR_MEMBER,
  exportLiveMember,
  isAcceptedPublicValidatorUnhealthy,
  run,
  validateAcceptPublicValidatorUnhealthy,
  validateExpectedMemberHash,
  validateRequestedMember,
  workflowIdentity,
} from '../../scripts/deployment-guard/github-staging-lambda-overlay.mjs';
import { acquireLease } from '../../scripts/deployment-guard/lib/lease.mjs';
import { issueReceipt, validateReceipt } from '../../scripts/deployment-guard/lib/receipt.mjs';
import { hashZipMembers, writeZipMembers } from '../../scripts/deployment-guard/lib/zip-members.mjs';

const SHA='a'.repeat(40);

const workflow = fs.readFileSync(new URL('../../.github/workflows/guarded-staging-lambda-overlay.yml', import.meta.url), 'utf8');
const smoke = workflow.match(/- name: Public staging smoke[\s\S]*?node --input-type=module <<'NODE'\n([\s\S]*?)\n          NODE/)[1];

async function runPublicSmoke(overrides = {}, env = {}) {
  const logs = [];
  const calls = [];
  const bodies = {
    '/health': { status: 'ok' },
    '/db-health': { service: 'checksops-api', status: 'ok' },
    '/db-readonly-validate': { service: 'checksops-api', status: 'ok', readOnly: true },
  };
  const context = vm.createContext({
    AbortSignal,
    process: { env: { ...env } },
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

const acceptedUnhealthy = {
  status: 503,
  body: { service: 'checksops-api', status: 'unhealthy', readOnly: true },
};

const diagnosticAcceptEnv = {
  CHECKSOPS_ACCEPT_PUBLIC_VALIDATOR_UNHEALTHY: 'true',
  CHECKSOPS_STAGING_OVERLAY_MEMBER: DIAGNOSTIC_VALIDATOR_MEMBER,
  CHECKSOPS_STAGING_OVERLAY_OPERATION: 'replace',
};

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

test('accept_public_validator_unhealthy defaults false and is never inferred by the workflow', () => {
  assert.match(workflow, /accept_public_validator_unhealthy:\n        description:.*\n        required: true\n        default: false\n        type: boolean/);
  assert.match(workflow, /Refuse unscoped validator-unhealthy exception/);
  assert.match(workflow, /accept_public_validator_unhealthy is limited to replace db-readonly-validate\.mjs on checksops-staging-api/);
  assert.doesNotMatch(workflow, /CHECKSOPS_ACCEPT_PUBLIC_VALIDATOR_UNHEALTHY: ['"]true['"]/);
});

test('default smoke still rejects the known redacted validator 503', async () => {
  const result = await runPublicSmoke({ '/db-readonly-validate': acceptedUnhealthy });
  assert.match(result.error.message, /expected 200, got 503/);
  assert.notEqual(result.logs.at(-1)?.dbReadonlyValidate, 'known-unhealthy-diagnostic');
  assert.notEqual(result.logs.at(-1)?.dbReadonlyValidate, 'redacted-ok');
});

test('owner-selected exception accepts only the exact redacted validator 503 as a known diagnostic', async () => {
  const result = await runPublicSmoke({ '/db-readonly-validate': acceptedUnhealthy }, diagnosticAcceptEnv);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.calls, ['/health', '/db-health', '/db-readonly-validate']);
  assert.deepEqual(result.logs.at(-1), {
    health: 'ok',
    dbHealth: 'redacted-ok',
    dbReadonlyValidate: 'known-unhealthy-diagnostic',
  });
  assert.notEqual(result.logs.at(-1).dbReadonlyValidate, 'redacted-ok');
});

test('owner-selected exception still requires healthy /health and /db-health', async () => {
  for (const [route, response] of [
    ['/health', { status: 503, body: { status: 'unhealthy' } }],
    ['/db-health', { status: 503, body: { service: 'checksops-api', status: 'unhealthy' } }],
  ]) {
    const result = await runPublicSmoke({
      [route]: response,
      '/db-readonly-validate': acceptedUnhealthy,
    }, diagnosticAcceptEnv);
    assert.ok(result.error, `${route} must still fail closed`);
    assert.match(result.error.message, /expected 200, got 503|not ok/);
  }
});

test('owner-selected exception rejects leaking, healthy-looking, and inexact validator failures', async () => {
  for (const response of [
    { status: 503, body: { service: 'checksops-api', status: 'unhealthy', readOnly: true, error: 'private-diagnostic-marker' } },
    { status: 503, body: { service: 'checksops-api', status: 'unhealthy' } },
    { status: 503, body: { service: 'other', status: 'unhealthy', readOnly: true } },
    { status: 503, body: { service: 'checksops-api', status: 'ok', readOnly: true } },
    { status: 200, body: { service: 'checksops-api', status: 'unhealthy', readOnly: true } },
    { status: 500, body: { service: 'checksops-api', status: 'unhealthy', readOnly: true } },
    { status: 503, body: { service: 'checksops-api', status: 'unhealthy', readOnly: 'true' } },
  ]) {
    const result = await runPublicSmoke({ '/db-readonly-validate': response }, diagnosticAcceptEnv);
    assert.ok(result.error, `must reject ${JSON.stringify(response)}`);
    assert.doesNotMatch(JSON.stringify(result.logs) + result.error.message, /private-diagnostic-marker/);
    assert.notEqual(result.logs.at(-1)?.dbReadonlyValidate, 'known-unhealthy-diagnostic');
    assert.notEqual(result.logs.at(-1)?.dbReadonlyValidate, 'redacted-ok');
  }
});

test('owner-selected exception still reports a later healthy validator as redacted-ok, not diagnostic', async () => {
  const result = await runPublicSmoke({}, diagnosticAcceptEnv);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.logs.at(-1), { health: 'ok', dbHealth: 'redacted-ok', dbReadonlyValidate: 'redacted-ok' });
});

test('exception env is ignored unless replacing db-readonly-validate.mjs', async () => {
  for (const env of [
    { ...diagnosticAcceptEnv, CHECKSOPS_STAGING_OVERLAY_MEMBER: 'index.mjs' },
    { ...diagnosticAcceptEnv, CHECKSOPS_STAGING_OVERLAY_OPERATION: 'add' },
    { CHECKSOPS_ACCEPT_PUBLIC_VALIDATOR_UNHEALTHY: 'true' },
  ]) {
    const result = await runPublicSmoke({ '/db-readonly-validate': acceptedUnhealthy }, env);
    assert.ok(result.error);
    assert.match(result.error.message, /limited to replace db-readonly-validate\.mjs|expected 200, got 503/);
  }
});

test('validateAcceptPublicValidatorUnhealthy never auto-enables and is member-scoped', () => {
  assert.equal(validateAcceptPublicValidatorUnhealthy().ok, true);
  assert.equal(validateAcceptPublicValidatorUnhealthy({ accept: false }).details.accept, false);
  assert.equal(validateAcceptPublicValidatorUnhealthy({ accept: 'false' }).details.accept, false);
  assert.equal(validateAcceptPublicValidatorUnhealthy({ accept: '1' }).ok, false);
  assert.equal(validateAcceptPublicValidatorUnhealthy({
    accept: true,
    member: 'index.mjs',
    operation: 'replace',
  }).code, 'UNRELATED_MUTATION');
  assert.equal(validateAcceptPublicValidatorUnhealthy({
    accept: true,
    member: DIAGNOSTIC_VALIDATOR_MEMBER,
    operation: 'add',
  }).code, 'UNRELATED_MUTATION');
  assert.equal(validateAcceptPublicValidatorUnhealthy({
    accept: true,
    member: DIAGNOSTIC_VALIDATOR_MEMBER,
    operation: 'replace',
    functionName: 'checksops-production-prep-api',
  }).code, 'UNRELATED_MUTATION');
  const allowed = validateAcceptPublicValidatorUnhealthy({
    accept: 'true',
    member: DIAGNOSTIC_VALIDATOR_MEMBER,
    operation: 'replace',
    functionName: 'checksops-staging-api',
  });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.details.accept, true);
});

test('accepted public validator unhealthy contract is exact and redacted', () => {
  assert.equal(isAcceptedPublicValidatorUnhealthy(503, acceptedUnhealthy.body), true);
  assert.equal(isAcceptedPublicValidatorUnhealthy(200, acceptedUnhealthy.body), false);
  assert.equal(isAcceptedPublicValidatorUnhealthy(503, { ...acceptedUnhealthy.body, extra: true }), false);
  assert.equal(isAcceptedPublicValidatorUnhealthy(503, { service: 'checksops-api', status: 'unhealthy' }), false);
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

test('export_live_member writes only the exact live bytes, inspect-only, never to AWS', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-export-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const deps = inspectionDeps(true);
  const result = await run({ ...env, CHECKSOPS_STAGING_EXPORT_LIVE_MEMBER_DIR: dir }, deps);
  assert.equal(result.mutation, false);
  assert.equal(result.authorization, undefined);
  assert.equal(result.live.memberBytes, undefined);
  assert.equal(deps.calls.length, 1);
  assert.equal(fs.readFileSync(result.exported.file, 'utf8'), 'reviewed live member');
  assert.equal(result.exported.sha256, result.live.memberSha256);
  assert.equal(path.dirname(result.exported.file), dir);

  // A nested member is flattened into the export directory.
  const nested = await run({ ...env, CHECKSOPS_STAGING_OVERLAY_MEMBER: 'index.mjs', CHECKSOPS_STAGING_EXPORT_LIVE_MEMBER_DIR: dir }, inspectionDeps(true));
  assert.equal(path.dirname(nested.exported.file), dir);

  // Absent members and apply mode refuse; apply refuses before any lease or receipt.
  await assert.rejects(run({ ...env, CHECKSOPS_STAGING_EXPORT_LIVE_MEMBER_DIR: dir }, inspectionDeps(false)), { code: 'INVALID_MANIFEST' });
  const applyDeps = inspectionDeps(true);
  await assert.rejects(run({
    ...env,
    CHECKSOPS_STAGING_DEPLOY_MODE: 'apply',
    CHECKSOPS_STAGING_OVERLAY_OPERATION: 'replace',
    CHECKSOPS_EXPECTED_LIVE_MEMBER_SHA256: hashZipMembers(deps.zip)[env.CHECKSOPS_STAGING_OVERLAY_MEMBER],
    CHECKSOPS_STAGING_EXPORT_LIVE_MEMBER_DIR: dir,
  }, applyDeps), { code: 'INVALID_MANIFEST' });
  // Refused before any AWS read.
  assert.equal(applyDeps.calls.length, 0);
  assert.ok(!fs.existsSync(path.join(process.cwd(), '.deployment-guard', 'github-staging-overlay-input.json')));
});

test('exportLiveMember refuses non-source members and bytes that do not match the inspected hash', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-export-'));
  try {
    const bytes = Buffer.from('x');
    const live = { member: 'a.mjs', memberState: 'PRESENT', memberBytes: bytes, memberSha256: hashZipMembers(writeZipMembers({ 'a.mjs': 'x' }))['a.mjs'] };
    assert.equal(fs.readFileSync(exportLiveMember(live, dir).file, 'utf8'), 'x');
    assert.throws(() => exportLiveMember({ ...live, member: 'bin/tool' }, dir), { code: 'INVALID_MANIFEST' });
    assert.throws(() => exportLiveMember({ ...live, memberSha256: 'f'.repeat(64) }, dir), { code: 'DEPLOYMENT_COLLISION' });
    assert.throws(() => exportLiveMember({ ...live, member: 'config.json' }, dir), { code: 'INVALID_MANIFEST' });
    for (const secret of ['-----BEGIN PRIVATE KEY-----', 'const k = "AKIAABCDEFGHIJKLMNOP";']) {
      const leaked = Buffer.from(secret);
      const leakedSha = hashZipMembers(writeZipMembers({ 'a.mjs': secret }))['a.mjs'];
      assert.throws(() => exportLiveMember({ ...live, memberBytes: leaked, memberSha256: leakedSha }, dir), { code: 'DEPLOYMENT_COLLISION' });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('workflow export_live_member defaults false, is inspect-only and uploads a 1-day artifact', () => {
  assert.match(workflow, /export_live_member:\n        description:.*\n        required: true\n        default: false\n        type: boolean/);
  assert.match(workflow, /export_live_member is inspect-only/);
  assert.match(workflow, /if: \$\{\{ inputs\.mode == 'inspect' && inputs\.export_live_member \}\}\n        uses: actions\/upload-artifact@[0-9a-f]{40}\n[\s\S]*?retention-days: 1/);
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
});

// --- sql_before (the staging mirror of the production overlay's guard) -----------------------

const PLAN = JSON.parse(fs.readFileSync(new URL('../../ops/deployment-guard/production-api-overlay-plan.json', import.meta.url), 'utf8'));
const STAGING_SQL = JSON.parse(fs.readFileSync(new URL('../../ops/deployment-guard/staging-sql-live.json', import.meta.url), 'utf8'));
const SQL98 = 'aws/workflows/sql/98_tenant_fee_collection.sql';
const SQL102 = 'aws/workflows/sql/102_platform_owner_tenant_profile.sql';

function memberDeps(member, { calls = [] } = {}) {
  const zip = writeZipMembers({ 'index.mjs': 'unrelated live handler', [member]: 'reviewed live member' });
  return {
    calls,
    zip,
    lambda: {
      async send(command) {
        calls.push(command);
        return { Configuration: { CodeSha256: 'live-code-sha', RevisionId: 'live-revision' }, Code: { Location: 'https://example.invalid/mock-lambda.zip' } };
      },
    },
    async fetchImpl() { return new Response(zip); },
    loadSdk() { throw new Error('must not load any writer or signer SDK'); },
  };
}

test('staging SQL record: every sql_before of the plan has an entry; the pending SQL is not live in staging', async () => {
  const { STAGING_SQL_LIVE_REL, OVERLAY_PLAN_REL } = await import('../../scripts/deployment-guard/github-staging-lambda-overlay.mjs');
  assert.equal(STAGING_SQL_LIVE_REL, 'ops/deployment-guard/staging-sql-live.json');
  assert.equal(OVERLAY_PLAN_REL, 'ops/deployment-guard/production-api-overlay-plan.json');
  assert.equal(STAGING_SQL.target_environment, 'staging');
  const required = [...new Set(Object.values(PLAN.members).map((m) => m.sql_before).filter(Boolean))].sort();
  assert.deepEqual(Object.keys(STAGING_SQL.sql).sort(), required, `${STAGING_SQL_LIVE_REL} must cover every sql_before of ${OVERLAY_PLAN_REL}`);
  for (const [file, record] of Object.entries(STAGING_SQL.sql)) {
    assert.equal(typeof record.verified_live, 'boolean', file);
    // A recorded staging run id (a GitHub Actions run) is the evidence.
    if (record.verified_live) assert.match(record.evidence, /\b[0-9]{11}\b/, file);
    else assert.equal(record.evidence, null, file);
    assert.ok(fs.existsSync(new URL(`../../${file}`, import.meta.url)), file);
  }
  // Release 2026-10-17 waves 1-3 are applied in staging: every sql_before of the plan is live there.
  for (const [file, record] of Object.entries(STAGING_SQL.sql)) assert.equal(record.verified_live, true, file);
  // A SQL recorded true here is either recorded live in production (with its staging acceptance)
  // or, staging first (release 2026-10-17), names its guarded staging SQL executor apply run and
  // a receipt that ended on the pin's intended fingerprint. It is never production's record.
  // The evidence is checked against the repository: the migration's executor choice, its staging
  // pin (executable, the recorded pre-state, the intended post-state) and the recorded apply run.
  const { RELEASE_2026_10_17_PENDING_SQL_PINS: STAGING_PINS } = await import('../../scripts/deployment-guard/lib/sql-executor-auth.mjs');
  const { RELEASE_SQL_SPECS } = await import('../../scripts/deployment-guard/lib/release-sql-specs.mjs');
  const { STAGING_WAVE1 } = await import('./helpers/staging-sql-wave1.mjs');
  for (const [file, record] of Object.entries(STAGING_SQL.sql)) {
    if (!record.verified_live || PLAN.sql_prerequisites[file]?.verified_live === true) continue;
    const m = /^Guarded staging SQL executor apply of ([a-z0-9-]+) on \d{4}-\d{2}-\d{2} \(run ([0-9]{11}),[^)]*\): receipt before ([0-9a-f]{8})…, after ([0-9a-f]{8})… = the pin's intended_replacement_sha256; precondition_failures \[\], prerequisites_missing \[\]\.$/.exec(record.evidence);
    assert.ok(m, `${file}: ${record.evidence}`);
    const [, choice, applyRun, before, after] = m;
    const key = Object.keys(STAGING_PINS).find((k) => STAGING_PINS[k].filename === file);
    assert.ok(key, file);
    const pin = STAGING_PINS[key];
    assert.equal(choice, RELEASE_SQL_SPECS[key].choice, file);
    assert.equal(pin.execute, true, file);
    assert.equal(before, pin.expected_live_definition_sha256.slice(0, 8), file);
    assert.equal(after, pin.intended_replacement_sha256.slice(0, 8), file);
    assert.equal(STAGING_WAVE1[key]?.apply_run, applyRun, file);
    assert.ok(Number(applyRun) > Number(STAGING_WAVE1[key].run), `${file}: applied after its read-live`);
  }
  // Staging first: a file in both records that production records live is live in staging too
  // (the staging record lists only sql_before files).
  for (const [file, record] of Object.entries(PLAN.sql_prerequisites)) {
    if (record.verified_live === true && Object.hasOwn(STAGING_SQL.sql, file)) assert.equal(STAGING_SQL.sql[file].verified_live, true, file);
  }
  // Production records SQL 90, 91, 93, 94, 96 and 104 live from their guarded production applies
  // (2026-10-19, each citing its production pin's applied record); SQL 98 and SQL 102 stay not live there.
  for (const n of ['90_users_only_tenant_roles', '91_moov_onboarding', '93_tenant_company_info', '94_document_library_restore', '96_platform_owner_tenant_pricing', '104_payment_idempotency_keys_grant']) {
    const record = PLAN.sql_prerequisites[`aws/workflows/sql/${n}.sql`];
    assert.equal(record?.verified_live, true, n);
    const pin = record.evidence.match(/ops\/deployment-guard\/(sql\d+-[a-z0-9-]+-production-apply\.json)/)[1];
    const applied = JSON.parse(fs.readFileSync(new URL(`../../ops/deployment-guard/${pin}`, import.meta.url), 'utf8'));
    assert.equal(applied.filename, `aws/workflows/sql/${n}.sql`, n);
    assert.equal(applied.applied?.result, 'applied', n);
    assert.ok(record.evidence.includes(applied.applied.apply_ssm_command_id), n);
  }
  for (const n of ['98_tenant_fee_collection', '102_platform_owner_tenant_profile']) {
    assert.notEqual(PLAN.sql_prerequisites[`aws/workflows/sql/${n}.sql`]?.verified_live, true, n);
  }
});

test('staging apply of a member held by sql_before is refused before any AWS call, lease or receipt', async (t) => {
  const { stagingSqlBefore } = await import('../../scripts/deployment-guard/github-staging-lambda-overlay.mjs');
  t.after(() => mock.restoreAll());
  for (const method of ['writeFileSync', 'mkdirSync', 'renameSync']) {
    mock.method(fs, method, () => assert.fail(`a held member must not reach ${method}`));
  }
  // providers.mjs and workflow-rpc.mjs are held behind SQL 98 (ops/fee-collection-deltas.md), the billing members too.
  // SQL 98 is live in staging (run 39085677318), so the hold is shown on a record where it is not.
  const stagingSqlLive = structuredClone(STAGING_SQL);
  stagingSqlLive.sql[SQL98] = { verified_live: false, evidence: null };
  // tenant-billing-handlers.mjs waits on SQL 102 (live in staging, run 39162625974), shown the same way.
  stagingSqlLive.sql[SQL102] = { verified_live: false, evidence: null };
  for (const [member, sqlBefore] of [['providers.mjs', SQL98], ['workflow-rpc.mjs', SQL98], ['tenant-billing-engine.mjs', SQL98], ['tenant-billing-handlers.mjs', SQL102]]) {
    assert.equal(PLAN.members[member].sql_before, sqlBefore, member);
    assert.equal(stagingSqlBefore(member).verified_live_in_staging, true, `${member}: released by the committed record`);
    assert.deepEqual(stagingSqlBefore(member, { stagingSqlLive }), { sql_before: sqlBefore, verified_live_in_staging: false, evidence: null }, member);
    const deps = { ...memberDeps(member), stagingSqlLive };
    for (const operation of ['replace', 'add']) {
      await assert.rejects(run({
        ...env,
        CHECKSOPS_STAGING_OVERLAY_MEMBER: member,
        CHECKSOPS_STAGING_DEPLOY_MODE: 'apply',
        CHECKSOPS_STAGING_OVERLAY_OPERATION: operation,
        CHECKSOPS_EXPECTED_LIVE_MEMBER_SHA256: hashZipMembers(deps.zip)[member],
      }, deps), (error) => error.code === 'DEPLOYMENT_COLLISION' && error.details.sql_before === sqlBefore && error.details.member === member, `${member} ${operation}`);
    }
    assert.equal(deps.calls.length, 0, `${member}: no AWS call`);
  }
  // A sql_before with no staging record is not live either (fail closed).
  const plan = { members: { 'providers.mjs': { sql_before: 'aws/workflows/sql/999_unrecorded.sql' } } };
  await assert.rejects(run({ ...env, CHECKSOPS_STAGING_OVERLAY_MEMBER: 'providers.mjs', CHECKSOPS_STAGING_DEPLOY_MODE: 'apply' }, { ...memberDeps('providers.mjs'), plan }),
    (error) => error.code === 'DEPLOYMENT_COLLISION' && error.details.sql_before === 'aws/workflows/sql/999_unrecorded.sql');
});

test('staging sql_before: inspect reports the hold without refusing; a recorded staging SQL lifts it; a member with no sql_before has none', async () => {
  const held = structuredClone(STAGING_SQL);
  held.sql[SQL98] = { verified_live: false, evidence: null };
  const deps = { ...memberDeps('providers.mjs'), stagingSqlLive: held };
  const inspected = await run({ ...env, CHECKSOPS_STAGING_OVERLAY_MEMBER: 'providers.mjs' }, deps);
  assert.equal(inspected.mode, 'inspect');
  assert.deepEqual(inspected.sql_before, { sql_before: SQL98, verified_live_in_staging: false, evidence: null });
  assert.equal(deps.calls.length, 1);
  // Recorded live in staging (the committed record): the hold lifts and the run goes on to the
  // reviewed-hash check (refused here on a wrong hash).
  const stagingSqlLive = STAGING_SQL;
  assert.equal(stagingSqlLive.sql[SQL98].verified_live, true);
  const lifted = memberDeps('providers.mjs');
  await assert.rejects(run({
    ...env,
    CHECKSOPS_STAGING_OVERLAY_MEMBER: 'providers.mjs',
    CHECKSOPS_STAGING_DEPLOY_MODE: 'apply',
    CHECKSOPS_EXPECTED_LIVE_MEMBER_SHA256: 'b'.repeat(64),
  }, { ...lifted, stagingSqlLive }), { code: 'SOURCE_RECONCILIATION_REQUIRED' });
  assert.equal(lifted.calls.length, 1);
  // tenant-management-v2.mjs is not in the plan: no hold.
  const plain = await run(env, inspectionDeps());
  assert.deepEqual(plain.sql_before, { sql_before: null, verified_live_in_staging: null, evidence: null });
});
