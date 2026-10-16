import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

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

const API = path.join(ROOT, 'aws/functions/api');
function repoModules(dir = API, prefix = '') {
  const out = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const rel = prefix + entry.name;
    if (entry.isDirectory()) Object.assign(out, repoModules(path.join(dir, entry.name), `${rel}/`));
    else if (entry.name.endsWith('.mjs')) out[rel] = fs.readFileSync(path.join(dir, entry.name), 'utf8');
  }
  return out;
}
// Production also carries modules main does not (checked live on 2026-10-12).
const REPO_MODULES = {
  ...repoModules(),
  'mortgage-ops-usage.mjs': 'export async function accrueMortgageOpsAcceptedRequest() {}\n',
};

// Live ZIP stand-in: main's modules, with planned members before `member` already on the
// accepted bytes, later ones still on the reconciled pre-deploy bytes, and ADD members absent.
function liveFor(member, { sha256 = undefined, present = undefined, extra = [], pending = [], sources = {} } = {}) {
  const row = PLAN.members[member];
  const memberSha = sha256 !== undefined ? sha256 : row.expected_live_sha256;
  const isPresent = present !== undefined ? present : memberSha !== null;
  const index = PLAN.order.indexOf(member);
  const liveSources = { ...REPO_MODULES, ...sources };
  const memberHashes = {};
  for (const name of Object.keys(liveSources)) {
    const planned = PLAN.members[name];
    if (!planned) { memberHashes[name] = createHash('sha256').update(liveSources[name]).digest('hex'); continue; }
    const position = PLAN.order.indexOf(name);
    if (name === member) {
      if (isPresent) memberHashes[name] = memberSha;
    } else if (position < index && !pending.includes(name)) {
      memberHashes[name] = planned.accepted_sha256;
    } else if (planned.operation === 'replace') {
      memberHashes[name] = planned.expected_live_sha256;
    } else if (extra.includes(name)) {
      memberHashes[name] = planned.accepted_sha256;
    }
  }
  for (const name of Object.keys(liveSources)) if (!Object.hasOwn(memberHashes, name)) delete liveSources[name];
  return async () => ({
    functionName: FUNCTION_NAME,
    codeSha256: 'oQDCIRFyreTPe781aeSFLdXNfU3M2ZUQo5Wcgi0EqWI=',
    revisionId: 'f4904e55-61b3-46c4-bf1f-da178e84911b',
    member,
    memberState: isPresent ? 'PRESENT' : 'ABSENT',
    memberSha256: isPresent ? memberSha : null,
    members: Object.keys(memberHashes),
    memberHashes,
    sources: liveSources,
  });
}

function applyDeps(member, liveOpts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-overlay-'));
  fs.mkdirSync(path.join(root, 'ops/deployment-guard'), { recursive: true });
  fs.mkdirSync(path.join(root, 'aws/functions/api'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'ops/deployment-guard/production-api-overlay-plan.json'), path.join(root, 'ops/deployment-guard/production-api-overlay-plan.json'));
  for (const name of PLAN.order) {
    fs.mkdirSync(path.dirname(path.join(root, 'aws/functions/api', name)), { recursive: true });
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
    // Members from a later reconciliation name their own manifest; the rest come from the 2026-10-08 one.
    if (row.manifest) assert.match(row.manifest, /^aws\/tests\/fixtures\/production-[a-z0-9-]+-manifest-\d{4}-\d{2}-\d{2}\.json$/, name);
    const manifest = row.manifest ? JSON.parse(fs.readFileSync(path.join(ROOT, row.manifest), 'utf8')) : MANIFEST;
    assert.ok(manifest.members[name], name);
    assert.equal(sha(`aws/functions/api/${name}`), row.accepted_sha256, name);
    assert.equal(row.accepted_sha256, manifest.members[name].accepted_sha256, name);
    assert.equal(row.expected_live_sha256, manifest.members[name].live_sha256, name);
    assert.equal(row.operation, manifest.members[name].live_sha256 === null ? 'add' : 'replace', name);
  }
  for (const name of ['ocr.mjs', 'index.mjs', 'workflow-delete-check.mjs']) {
    assert.ok(!PLAN.order.includes(name), name);
    assert.equal(resolvePlannedMember(name, { root: ROOT, plan: PLAN }).code, CODES.UNRELATED_MUTATION, name);
  }
  // Added members land before any planned member that imports them.
  for (const [index, name] of PLAN.order.entries()) {
    const imports = localImports(fs.readFileSync(path.join(ROOT, 'aws/functions/api', name), 'utf8'), name);
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
  const LEDGER = 'supabase/migrations/20261007193200_skip_claim_ledger_event_for_endorsement_stage.sql';
  const unverified = structuredClone(PLAN);
  unverified.sql_prerequisites[LEDGER] = { verified_live: false, evidence: null };
  await assert.rejects(
    run(applyEnv('workflow-transitions.mjs'), { ...applyDeps('workflow-transitions.mjs').deps, plan: unverified }),
    (error) => error.code === CODES.PRODUCTION_APPROVAL_REQUIRED,
  );
  assert.equal(PLAN.sql_prerequisites[LEDGER].verified_live, true);
  const transitions = await run(applyEnv('workflow-transitions.mjs'), applyDeps('workflow-transitions.mjs').deps);
  assert.equal(transitions.state, 'READY');
  await assert.rejects(
    run(applyEnv('data.mjs'), applyDeps('data.mjs', { pending: ['claim-settlement-rpc.mjs'] }).deps),
    (error) => error.code === CODES.DEPLOYMENT_COLLISION && error.details.missing.includes('claim-settlement-rpc.mjs'),
  );
  const result = await run(applyEnv('data.mjs'), applyDeps('data.mjs').deps);
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

test('apply refuses out of plan order and when imported names would not link', async () => {
  await assert.rejects(
    run(applyEnv('workflow-rpc.mjs'), applyDeps('workflow-rpc.mjs', { pending: ['workflow.mjs'] }).deps),
    (error) => error.code === CODES.DEPLOYMENT_COLLISION && error.details.pending.includes('workflow.mjs'),
  );
  // workflow.mjs imports withIdentity from data.mjs; a live data.mjs without it must block the write.
  await assert.rejects(
    run(applyEnv('workflow.mjs'), applyDeps('workflow.mjs', { sources: { 'data.mjs': 'export const parseBody = () => ({});\n' } }).deps),
    (error) => error.code === CODES.DEPLOYMENT_COLLISION && error.details.problems.some((row) => /data\.mjs does not export/.test(row)),
  );
});

test('staging acceptance must be a bare ChecksOps run or PR URL', async () => {
  for (const bad of ['https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/1garbage', 'https://github.com/other/repo/pull/1', 'https://github.com/michaelcarletta-cmd/ChecksOps/pull/1 extra']) {
    await assert.rejects(
      run(applyEnv('workflow.mjs', { CHECKSOPS_STAGING_ACCEPTANCE_REFERENCE: bad }), applyDeps('workflow.mjs').deps),
      (error) => error.code === CODES.PRODUCTION_APPROVAL_REQUIRED,
      bad,
    );
  }
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

const SMOKE = WORKFLOW.match(/- name: Public production smoke[\s\S]*?node --input-type=module <<'NODE'\n([\s\S]*?)\n          NODE/)[1];

async function runProductionSmoke(responses) {
  const logs = [];
  const context = vm.createContext({
    AbortSignal,
    console: { log: (line) => logs.push(JSON.parse(line)) },
    fetch: async (url, options) => {
      assert.equal(options.method, 'GET');
      assert.equal(new URL(url).origin, 'https://checksops.com');
      const route = new URL(url).pathname.replace('/prep', '');
      const response = responses[route];
      return new Response(response.raw ?? JSON.stringify(response.body), { status: response.status || 200 });
    },
  });
  try {
    await new vm.Script(`(async () => {${SMOKE}\n})()`).runInContext(context);
    return { logs };
  } catch (error) {
    return { logs, error };
  }
}

test('production smoke accepts both the current probe body and the redacted status body', async () => {
  const health = { body: { status: 'ok' } };
  const probe = { body: { service: 'checksops-api', secretsManager: 'ok', networkTls: 'ok', authentication: 'ok', select1: 'ok' } };
  const redacted = { body: { service: 'checksops-api', status: 'ok' } };
  for (const dbHealth of [probe, redacted]) {
    const result = await runProductionSmoke({ '/health': health, '/db-health': dbHealth });
    assert.equal(result.error, undefined, JSON.stringify(result.logs));
    assert.deepEqual(result.logs.map((row) => row.healthy), [true, true]);
  }
});

test('production smoke fails on unhealthy, partial or malformed /db-health and logs no bodies', async () => {
  const health = { body: { status: 'ok' } };
  for (const dbHealth of [
    { status: 503, body: { service: 'checksops-api', status: 'unhealthy' } },
    { status: 200, body: { select1: 'ok', authentication: 'failed' } },
    { status: 200, body: { select1: 'failed', authentication: 'ok', currentUser: 'checksops' } },
    { status: 200, raw: 'not json' },
  ]) {
    const result = await runProductionSmoke({ '/health': health, '/db-health': dbHealth });
    assert.match(String(result.error?.message), /\/db-health is not healthy/, JSON.stringify(dbHealth));
    const row = result.logs.at(-1);
    assert.deepEqual(Object.keys(row).sort(), ['authentication', 'healthy', 'httpStatus', 'path', 'select1', 'status']);
    assert.equal(row.currentUser, undefined);
  }
});

test('read-only Moov wallet sync members apply in order with nested ZIP paths', async () => {
  const MOOV = ['providers/parity/moov-wallet.mjs', 'providers/production/moov-wallet-sync.mjs', 'providers.mjs'];
  const positions = MOOV.map((member) => PLAN.order.indexOf(member));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
  assert.ok(!positions.includes(-1));
  for (const member of MOOV) {
    const { deps, calls } = applyDeps(member);
    const result = await run(applyEnv(member), deps);
    assert.equal(result.mutation, false, member);
    const op = PLAN.members[member].operation;
    assert.deepEqual(calls.receipt.owned_member_ops, { replace: op === 'replace' ? [member] : [], add: op === 'add' ? [member] : [] }, member);
    const input = JSON.parse(fs.readFileSync(result.authorization.overlayInput, 'utf8'));
    assert.deepEqual(input.member_sources, { [member]: `aws/functions/api/${member}` }, member);
  }
  // Imports resolve against the member's directory, including ../ and dynamic imports.
  const syncImports = localImports(fs.readFileSync(path.join(ROOT, 'aws/functions/api/providers/production/moov-wallet-sync.mjs'), 'utf8'), 'providers/production/moov-wallet-sync.mjs');
  for (const dep of ['data.mjs', 'sandbox-credentials.mjs', 'providers/parity/caller.mjs', 'providers/parity/moov-wallet.mjs']) {
    assert.ok(syncImports.includes(dep), dep);
  }
  assert.ok(localImports(fs.readFileSync(path.join(ROOT, 'aws/functions/api/providers.mjs'), 'utf8'), 'providers.mjs')
    .includes('providers/production/moov-wallet-sync.mjs'));
});

test('read-only Moov wallet sync members refuse to apply out of order', async () => {
  await assert.rejects(
    run(applyEnv('providers/production/moov-wallet-sync.mjs'), applyDeps('providers/production/moov-wallet-sync.mjs', { pending: ['providers/parity/moov-wallet.mjs'] }).deps),
    (error) => error.code === CODES.DEPLOYMENT_COLLISION,
  );
  // providers.mjs before the added module: its import is not in the live ZIP yet.
  await assert.rejects(
    run(applyEnv('providers.mjs'), applyDeps('providers.mjs', { pending: ['providers/production/moov-wallet-sync.mjs'] }).deps),
    (error) => error.code === CODES.DEPLOYMENT_COLLISION,
  );
});

test('Moov send members apply in order: the send module, then providers.mjs last', async () => {
  const SEND = ['providers/production/moov-send.mjs', 'providers.mjs'];
  assert.deepEqual(PLAN.order.slice(-2), SEND);
  // Live since overlay run 31; later send fixes replace it.
  assert.equal(PLAN.members['providers/production/moov-send.mjs'].operation, 'replace');
  for (const member of SEND) {
    const { deps, calls } = applyDeps(member);
    const result = await run(applyEnv(member), deps);
    assert.equal(result.mutation, false, member);
    const op = PLAN.members[member].operation;
    assert.deepEqual(calls.receipt.owned_member_ops, { replace: op === 'replace' ? [member] : [], add: op === 'add' ? [member] : [] }, member);
  }
  // The send module imports only members that are already live.
  const sendImports = localImports(fs.readFileSync(path.join(ROOT, 'aws/functions/api/providers/production/moov-send.mjs'), 'utf8'), 'providers/production/moov-send.mjs');
  const sendAt = PLAN.order.indexOf('providers/production/moov-send.mjs');
  for (const dep of sendImports.filter((dep) => PLAN.members[dep]?.operation === 'add')) {
    assert.ok(PLAN.order.indexOf(dep) < sendAt, dep);
  }
  assert.ok(sendImports.includes('providers/production/moov-wallet-fund.mjs'));
  await assert.rejects(
    run(applyEnv('providers.mjs'), applyDeps('providers.mjs', { pending: ['providers/production/moov-send.mjs'] }).deps),
    (error) => error.code === CODES.DEPLOYMENT_COLLISION,
  );
});

test('Moov wallet funding members apply in order: wallet sync, added modules, providers.mjs last', async () => {
  const FUND = [
    'providers/production/moov-wallet-sync.mjs',
    'providers/production/moov-fund-authz.mjs',
    'cognito.mjs',
    'auth-financial-totp.mjs',
    'providers/production/moov-wallet-fund.mjs',
    'providers.mjs',
  ];
  const positions = FUND.map((member) => PLAN.order.indexOf(member));
  assert.ok(positions.every((pos, i) => pos >= 0 && (i === 0 || pos > positions[i - 1])), JSON.stringify(positions));
  for (const member of FUND) {
    const { deps, calls } = applyDeps(member);
    const result = await run(applyEnv(member), deps);
    assert.equal(result.mutation, false, member);
    const op = PLAN.members[member].operation;
    assert.deepEqual(calls.receipt.owned_member_ops, { replace: op === 'replace' ? [member] : [], add: op === 'add' ? [member] : [] }, member);
  }
  const fundImports = localImports(fs.readFileSync(path.join(ROOT, 'aws/functions/api/providers/production/moov-wallet-fund.mjs'), 'utf8'), 'providers/production/moov-wallet-fund.mjs');
  for (const dep of ['providers/production/moov-fund-authz.mjs', 'cognito.mjs', 'data.mjs', 'providers/parity/moov-wallet.mjs']) {
    assert.ok(fundImports.includes(dep), dep);
  }
  assert.ok(localImports(fs.readFileSync(path.join(ROOT, 'aws/functions/api/auth-financial-totp.mjs'), 'utf8'), 'auth-financial-totp.mjs')
    .includes('providers/production/moov-fund-authz.mjs'));
  await assert.rejects(
    run(applyEnv('providers.mjs'), applyDeps('providers.mjs', { pending: ['providers/production/moov-wallet-fund.mjs'] }).deps),
    (error) => error.code === CODES.DEPLOYMENT_COLLISION,
  );
  await assert.rejects(
    run(applyEnv('auth-financial-totp.mjs'), applyDeps('auth-financial-totp.mjs', { pending: ['providers/production/moov-fund-authz.mjs'] }).deps),
    (error) => error.code === CODES.DEPLOYMENT_COLLISION,
  );
});

test('the SQL 85 hold on mortgage-agent-compensation.mjs does not block homeowner.mjs', async () => {
  const MORTGAGE = 'mortgage-agent-compensation.mjs';
  const SQL85 = 'aws/workflows/sql/85_mortgage_compensation_adjust.sql';
  assert.equal(PLAN.members[MORTGAGE].sql_before, SQL85);
  assert.equal(PLAN.sql_prerequisites[SQL85]?.verified_live, true, 'SQL 85 is recorded live in production (2026-10-16 one-shot)');
  const unverified = structuredClone(PLAN);
  unverified.sql_prerequisites[SQL85] = { verified_live: false, evidence: null };
  // Held members sit after every member they must not block; providers.mjs stays last.
  assert.ok(PLAN.order.indexOf(MORTGAGE) > PLAN.order.indexOf('app-services.mjs'));
  assert.ok(PLAN.order.indexOf(MORTGAGE) > PLAN.order.indexOf('homeowner.mjs'));
  assert.equal(PLAN.order.at(-1), 'providers.mjs');

  // The mortgage member is still on its live (pre-SQL 85) bytes: homeowner.mjs applies anyway.
  const { deps, calls } = applyDeps('homeowner.mjs', { pending: [MORTGAGE] });
  const live = await deps.inspectLive();
  assert.equal(live.memberHashes[MORTGAGE], PLAN.members[MORTGAGE].expected_live_sha256);
  const result = await run(applyEnv('homeowner.mjs'), deps);
  assert.equal(result.mutation, false);
  assert.deepEqual(calls.receipt.owned_member_ops, { replace: ['homeowner.mjs'], add: [] });

  // The mortgage member is refused while SQL 85 is not recorded verified live ...
  await assert.rejects(
    run(applyEnv(MORTGAGE), { ...applyDeps(MORTGAGE).deps, plan: unverified }),
    (error) => error.code === CODES.PRODUCTION_APPROVAL_REQUIRED && error.details.sql_before === SQL85,
  );
  // ... and allowed with the committed plan, where SQL 85 is verified live.
  const mortgage = await run(applyEnv(MORTGAGE), applyDeps(MORTGAGE).deps);
  assert.equal(mortgage.mutation, false);
});

test('#901 Review financial edits: write-allowlist.mjs, then write-check-workflow.mjs, held for SQL 71', async () => {
  const ALLOWLIST = 'write-allowlist.mjs';
  const WORKFLOW_WRITES = 'write-check-workflow.mjs';
  const SQL71 = 'aws/workflows/sql/71_review_amount_column_grant.sql';
  const SQL52 = 'aws/workflows/sql/52_verified_ocr_micr_column_grant.sql';
  const MANIFEST_901 = 'aws/tests/fixtures/production-review-financial-edits-manifest-2026-10-16.json';

  // Planned as REPLACE of the 2026-10-11 production bytes, at main's bytes.
  for (const [member, accepted, live] of [
    [ALLOWLIST, '9fdce9c64e5750de88a0dc2360a1383168c3f79fe20c90312689d9f74ed655b7', '0fdc95bd7be8137d87f581ba3468d04c9581edf20933fec39dc4872076d4fea0'],
    [WORKFLOW_WRITES, '1f5e9444afc2bf193110e48c05447af4a26346d69445abc8f96e8e1e29be787d', 'd9a9ce68d10691fdb21e5050de532d918017497d69e5c4278d6ecd3b06634c76'],
  ]) {
    const row = PLAN.members[member];
    assert.equal(row.operation, 'replace', member);
    assert.equal(row.accepted_sha256, accepted, member);
    assert.equal(sha(`aws/functions/api/${member}`), accepted, member);
    assert.equal(row.expected_live_sha256, live, member);
    assert.equal(row.manifest, MANIFEST_901, member);
    assert.equal(resolvePlannedMember(member, { root: ROOT, plan: PLAN }).ok, true, member);
  }
  assert.equal(PLAN.members[ALLOWLIST].sql_before, null);
  assert.equal(PLAN.members[WORKFLOW_WRITES].sql_before, SQL71);

  // The allowlist goes first (the new workflow writer imports REVIEW_* from it);
  // the Moov send module and providers.mjs stay last.
  assert.ok(localImports(fs.readFileSync(path.join(API, WORKFLOW_WRITES), 'utf8'), WORKFLOW_WRITES).includes(ALLOWLIST));
  assert.equal(PLAN.order.indexOf(WORKFLOW_WRITES), PLAN.order.indexOf(ALLOWLIST) + 1);
  assert.deepEqual(PLAN.order.slice(-4), [ALLOWLIST, WORKFLOW_WRITES, 'providers/production/moov-send.mjs', 'providers.mjs']);

  // SQL prerequisites: SQL 71 and SQL 52 not yet recorded live; SQL 77-79 recorded applied.
  assert.equal(PLAN.sql_prerequisites[SQL71]?.verified_live, false);
  assert.equal(PLAN.sql_prerequisites[SQL52]?.verified_live, false);
  for (const sql of [
    'aws/workflows/sql/77_check_stakeholders_write_grant.sql',
    'aws/workflows/sql/78_check_partner_stakeholder_removals.sql',
    'aws/workflows/sql/79_member_stakeholder_writes.sql',
  ]) {
    assert.equal(PLAN.sql_prerequisites[sql]?.verified_live, true, sql);
    const record = PLAN.sql_prerequisites[sql].evidence.match(/ops\/deployment-guard\/(sql\d+-[a-z0-9-]+-production-apply\.json)/)[1];
    const applied = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard', record), 'utf8'));
    assert.equal(applied.filename, sql, record);
    assert.equal(applied.applied?.result, 'applied', record);
  }

  // write-allowlist.mjs applies while write-check-workflow.mjs is still on its live bytes.
  const { deps, calls } = applyDeps(ALLOWLIST);
  const live = await deps.inspectLive();
  assert.equal(live.memberHashes[WORKFLOW_WRITES], PLAN.members[WORKFLOW_WRITES].expected_live_sha256);
  const allowlist = await run(applyEnv(ALLOWLIST), deps);
  assert.equal(allowlist.mutation, false);
  assert.deepEqual(calls.receipt.owned_member_ops, { replace: [ALLOWLIST], add: [] });

  // write-check-workflow.mjs is refused while SQL 71 is not recorded verified live ...
  await assert.rejects(
    run(applyEnv(WORKFLOW_WRITES), applyDeps(WORKFLOW_WRITES).deps),
    (error) => error.code === CODES.PRODUCTION_APPROVAL_REQUIRED && error.details.sql_before === SQL71,
  );
  const verified = structuredClone(PLAN);
  verified.sql_prerequisites[SQL71] = { verified_live: true, evidence: 'test' };
  // ... and, once it is, still refused before write-allowlist.mjs is live ...
  await assert.rejects(
    run(applyEnv(WORKFLOW_WRITES), { ...applyDeps(WORKFLOW_WRITES, { pending: [ALLOWLIST] }).deps, plan: verified }),
    (error) => error.code === CODES.DEPLOYMENT_COLLISION && error.details.pending.includes(ALLOWLIST),
  );
  // ... or against an allowlist that does not export the REVIEW_* names ...
  await assert.rejects(
    run(applyEnv(WORKFLOW_WRITES), { ...applyDeps(WORKFLOW_WRITES, { sources: { [ALLOWLIST]: 'export const WRITE_ALLOWLIST = {};\n' } }).deps, plan: verified }),
    (error) => error.code === CODES.DEPLOYMENT_COLLISION
      && error.details.problems.some((row) => row === `${ALLOWLIST} does not export REVIEW_CHECK_STAGE`),
  );
  // ... and allowed after both.
  const writes = applyDeps(WORKFLOW_WRITES);
  const result = await run(applyEnv(WORKFLOW_WRITES), { ...writes.deps, plan: verified });
  assert.equal(result.mutation, false);
  assert.deepEqual(writes.calls.receipt.owned_member_ops, { replace: [WORKFLOW_WRITES], add: [] });

  // The SQL 71 hold does not block members before it (homeowner.mjs, mortgage-agent-compensation.mjs).
  for (const member of ['homeowner.mjs', 'mortgage-agent-compensation.mjs']) {
    assert.ok(PLAN.order.indexOf(member) < PLAN.order.indexOf(WORKFLOW_WRITES), member);
    const ahead = await run(applyEnv(member), applyDeps(member, { pending: [WORKFLOW_WRITES] }).deps);
    assert.equal(ahead.mutation, false, member);
  }
});
