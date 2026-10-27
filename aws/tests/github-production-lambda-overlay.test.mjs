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
// `plan` replays an earlier state of the plan (a member's pre-apply bytes as expected_live).
function liveFor(member, { sha256 = undefined, present = undefined, extra = [], pending = [], sources = {}, plan = PLAN } = {}) {
  const row = plan.members[member];
  const memberSha = sha256 !== undefined ? sha256 : row.expected_live_sha256;
  const isPresent = present !== undefined ? present : memberSha !== null;
  const index = plan.order.indexOf(member);
  const liveSources = { ...REPO_MODULES, ...sources };
  const memberHashes = {};
  for (const name of Object.keys(liveSources)) {
    const planned = plan.members[name];
    if (!planned) { memberHashes[name] = createHash('sha256').update(liveSources[name]).digest('hex'); continue; }
    const position = plan.order.indexOf(name);
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

// providers.mjs records its applied Production Invoices bytes live (production run 39955069311,
// 2026-10-23): every apply replay of it starts from the pre-apply live bytes (51fa3109, the invoice
// manifest's live_sha256), the REPLACE that had to pass the order, link and SQL 98 gates.
const PROVIDERS_PRE = JSON.parse(fs.readFileSync(path.join(ROOT, 'aws/tests/fixtures/production-moov-invoice-manifest-2026-10-22.json'), 'utf8')).members['providers.mjs'].live_sha256;
const providersPre = (plan) => { plan.members['providers.mjs'].expected_live_sha256 = PROVIDERS_PRE; return plan; };
// workflow.mjs records its applied Delete Check bytes live (production run 40530367414, 2026-10-27):
// the generic REPLACE tests replay it from the pre-apply live bytes (753ae14a, the release 2026-10-17
// accepted bytes), a REPLACE that still has to pass the drift, approval, order and link gates.
const WORKFLOW_PRE = '753ae14a0d04ded5782c653bd67c308067311f4fcebf835c0aac4e6659188138';
const WORKFLOW_PRE_PLAN = (() => {
  const plan = structuredClone(PLAN);
  plan.members['workflow.mjs'].expected_live_sha256 = WORKFLOW_PRE;
  return plan;
})();

function applyDeps(member, liveOpts = {}) {
  if (member === 'providers.mjs' && liveOpts.sha256 === undefined) liveOpts = { ...liveOpts, sha256: PROVIDERS_PRE };
  if (member === 'workflow.mjs' && liveOpts.plan === undefined) liveOpts = { ...liveOpts, plan: WORKFLOW_PRE_PLAN };
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
      ...(liveOpts.plan ? { plan: liveOpts.plan } : {}),
      acquireLease: (_root, input) => { calls.lease = input; return { ok: true, details: { lease: { id: 'lease-1', ...input } } }; },
      issueReceipt: (_root, input) => { calls.receipt = input; return { ok: true, details: { file: path.join(root, 'receipt.json') } }; },
    },
  };
}

// providers.mjs (and workflow-rpc.mjs) wait for SQL 98 (the deposits gate fails closed without it; fee
// collection test below). Tests about member order and links run them with SQL 98 recorded live.
const SQL98_FILE = 'aws/workflows/sql/98_tenant_fee_collection.sql';
const PLAN_SQL98_LIVE = (() => {
  const plan = providersPre(structuredClone(PLAN));
  plan.sql_prerequisites[SQL98_FILE] = { verified_live: true, evidence: 'test' };
  return plan;
})();
const withSql98 = (member, deps) => (PLAN.members[member]?.sql_before === SQL98_FILE ? { ...deps, plan: PLAN_SQL98_LIVE } : deps);
// The plan before SQL 98 was recorded verified live (2026-10-19): the held-member refusals start from it.
const PLAN_SQL98_PENDING = (() => {
  const plan = providersPre(structuredClone(PLAN));
  plan.sql_prerequisites[SQL98_FILE] = { ...plan.sql_prerequisites[SQL98_FILE], verified_live: false, evidence: null };
  return plan;
})();

const applyEnv = (member, extra = {}) => ({
  ...ENV,
  CHECKSOPS_PRODUCTION_DEPLOY_MODE: 'apply',
  CHECKSOPS_PRODUCTION_OVERLAY_MEMBER: member,
  CHECKSOPS_EXPECTED_LIVE_MEMBER_SHA256: (member === 'providers.mjs' ? PROVIDERS_PRE : member === 'workflow.mjs' ? WORKFLOW_PRE : PLAN.members[member].expected_live_sha256) || '',
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
  const ready = await run({ ...ENV, CHECKSOPS_PRODUCTION_DEPLOY_MODE: 'inspect', CHECKSOPS_PRODUCTION_OVERLAY_MEMBER: 'workflow.mjs' }, { root: ROOT, plan: WORKFLOW_PRE_PLAN, inspectLive: liveFor('workflow.mjs', { plan: WORKFLOW_PRE_PLAN }) });
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
    run({ ...ENV, CHECKSOPS_PRODUCTION_DEPLOY_MODE: 'inspect', CHECKSOPS_PRODUCTION_OVERLAY_MEMBER: 'workflow.mjs' }, { root: ROOT, plan: WORKFLOW_PRE_PLAN, inspectLive: liveFor('workflow.mjs', { sha256: 'c'.repeat(64), plan: WORKFLOW_PRE_PLAN }) }),
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
  // workflow-transitions.mjs now records its applied Loss Draft bytes live (2026-10-24), so the
  // ledger gate is replayed from the pre-apply live bytes (f11206b4): a REPLACE that still has to pass it.
  const TRANSITIONS_PRE = 'f11206b4ac7239b6d75eb62e739d3c83f3dc8c568aa5c6d2be98f8335166c350';
  const transitionsPre = structuredClone(PLAN);
  transitionsPre.members['workflow-transitions.mjs'].expected_live_sha256 = TRANSITIONS_PRE;
  const transitionsEnv = applyEnv('workflow-transitions.mjs', { CHECKSOPS_EXPECTED_LIVE_MEMBER_SHA256: TRANSITIONS_PRE });
  const transitionsDeps = () => applyDeps('workflow-transitions.mjs', { sha256: TRANSITIONS_PRE }).deps;
  const unverified = structuredClone(transitionsPre);
  unverified.sql_prerequisites[LEDGER] = { verified_live: false, evidence: null };
  await assert.rejects(
    run(transitionsEnv, { ...transitionsDeps(), plan: unverified }),
    (error) => error.code === CODES.PRODUCTION_APPROVAL_REQUIRED,
  );
  assert.equal(PLAN.sql_prerequisites[LEDGER].verified_live, true);
  const transitions = await run(transitionsEnv, { ...transitionsDeps(), plan: transitionsPre });
  assert.equal(transitions.state, 'READY');
  // data.mjs now records its applied Refer & Earn bytes live (2026-10-23), so the ordering gate is
  // replayed from the pre-apply live bytes (75fe96fc): a REPLACE that still has to pass it.
  const DATA_PRE = '75fe96fc3a3f782a0e69e30f7dd4c4f5a1c5f64a93915bd40a0eaf6bd3ddde31';
  const dataPre = structuredClone(PLAN);
  dataPre.members['data.mjs'].expected_live_sha256 = DATA_PRE;
  const dataEnv = applyEnv('data.mjs', { CHECKSOPS_EXPECTED_LIVE_MEMBER_SHA256: DATA_PRE });
  await assert.rejects(
    run(dataEnv, { ...applyDeps('data.mjs', { sha256: DATA_PRE, pending: ['claim-settlement-rpc.mjs'] }).deps, plan: dataPre }),
    (error) => error.code === CODES.DEPLOYMENT_COLLISION && error.details.missing.includes('claim-settlement-rpc.mjs'),
  );
  const result = await run(dataEnv, { ...applyDeps('data.mjs', { sha256: DATA_PRE }).deps, plan: dataPre });
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
    // (A later member without a SQL hold: workflow-rpc.mjs now waits for SQL 90 first.)
    run(applyEnv('providers/parity/checkalt-functions.mjs'), applyDeps('providers/parity/checkalt-functions.mjs', { pending: ['workflow.mjs'], plan: WORKFLOW_PRE_PLAN }).deps),
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
    run({ ...ENV, CHECKSOPS_PRODUCTION_DEPLOY_MODE: 'verify', CHECKSOPS_PRODUCTION_OVERLAY_MEMBER: 'workflow.mjs' }, { root: ROOT, inspectLive: liveFor('workflow.mjs', { sha256: WORKFLOW_PRE }) }),
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
    const result = await run(applyEnv(member), withSql98(member, deps));
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
    run(applyEnv('providers.mjs'), withSql98('providers.mjs', applyDeps('providers.mjs', { pending: ['providers/production/moov-wallet-sync.mjs'] }).deps)),
    (error) => error.code === CODES.DEPLOYMENT_COLLISION,
  );
});

test('Moov send members apply in order: the send module, then providers.mjs last', async () => {
  const SEND = ['providers/production/moov-send.mjs', 'providers.mjs'];
  assert.deepEqual(PLAN.order.slice(-2), SEND);
  // Live since overlay run 31; later send fixes replace it.
  assert.equal(PLAN.members['providers/production/moov-send.mjs'].operation, 'replace');
  // moov-send.mjs records the staging sends bytes production run 40222560555 applied: its apply is
  // replayed on the plan as it stood before that run, expecting the pre-apply bytes (f82c1e08).
  const SEND_PRE = JSON.parse(fs.readFileSync(path.join(ROOT, 'aws/tests/fixtures/production-sandbox-send-manifest-2026-10-25.json'), 'utf8')).members[SEND[0]].live_sha256;
  const SEND_PLAN = structuredClone(PLAN);
  SEND_PLAN.members[SEND[0]].expected_live_sha256 = SEND_PRE;
  for (const member of SEND) {
    const pre = member === SEND[0];
    const { deps, calls } = pre ? applyDeps(member, { sha256: SEND_PRE, plan: SEND_PLAN }) : applyDeps(member);
    const env = pre ? applyEnv(member, { CHECKSOPS_EXPECTED_LIVE_MEMBER_SHA256: SEND_PRE }) : applyEnv(member);
    const result = await run(env, pre ? { ...deps, plan: SEND_PLAN } : withSql98(member, deps));
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
  // providers.mjs before the send module is live (the send module still on its pre-apply bytes).
  const SEND_PLAN_SQL98 = structuredClone(PLAN_SQL98_LIVE);
  SEND_PLAN_SQL98.members[SEND[0]].expected_live_sha256 = SEND_PRE;
  await assert.rejects(
    run(applyEnv('providers.mjs'), { ...applyDeps('providers.mjs', { pending: [SEND[0]], plan: SEND_PLAN_SQL98 }).deps, plan: SEND_PLAN_SQL98 }),
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
    const result = await run(applyEnv(member), withSql98(member, deps));
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
    run(applyEnv('providers.mjs'), withSql98('providers.mjs', applyDeps('providers.mjs', { pending: ['providers/production/moov-wallet-fund.mjs'] }).deps)),
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
  // Simulate the plan as it stood before run 38901611978 applied the member: expected_live on the
  // pre-SQL 85 bytes (c3898615). The committed plan records the applied bytes (see the next test).
  const PRE_SQL85 = 'c38986152765e1d43443c82a779627bd55f96b3c2c246988f4697a3565166512';
  const preApply = structuredClone(PLAN);
  preApply.members[MORTGAGE].expected_live_sha256 = PRE_SQL85;
  const unverified = structuredClone(preApply);
  unverified.sql_prerequisites[SQL85] = { verified_live: false, evidence: null };
  // Held members sit after every member they must not block; providers.mjs stays last.
  assert.ok(PLAN.order.indexOf(MORTGAGE) > PLAN.order.indexOf('app-services.mjs'));
  assert.ok(PLAN.order.indexOf(MORTGAGE) > PLAN.order.indexOf('homeowner.mjs'));
  assert.equal(PLAN.order.at(-1), 'providers.mjs');

  // The mortgage member is still on its pre-SQL 85 bytes: homeowner.mjs applies anyway.
  const { deps, calls } = applyDeps('homeowner.mjs', { pending: [MORTGAGE] });
  const live = await deps.inspectLive();
  live.memberHashes[MORTGAGE] = PRE_SQL85;
  deps.inspectLive = async () => live;
  const result = await run(applyEnv('homeowner.mjs'), { ...deps, plan: preApply });
  assert.equal(result.mutation, false);
  assert.deepEqual(calls.receipt.owned_member_ops, { replace: ['homeowner.mjs'], add: [] });

  // The mortgage member is refused while SQL 85 is not recorded verified live ...
  await assert.rejects(
    run(applyEnv(MORTGAGE, { CHECKSOPS_EXPECTED_LIVE_MEMBER_SHA256: PRE_SQL85 }), { ...applyDeps(MORTGAGE, { sha256: PRE_SQL85 }).deps, plan: unverified }),
    (error) => error.code === CODES.PRODUCTION_APPROVAL_REQUIRED && error.details.sql_before === SQL85,
  );
  // ... and allowed once SQL 85 is verified live (as run 38901611978 did).
  const mortgage = await run(applyEnv(MORTGAGE, { CHECKSOPS_EXPECTED_LIVE_MEMBER_SHA256: PRE_SQL85 }), { ...applyDeps(MORTGAGE, { sha256: PRE_SQL85 }).deps, plan: preApply });
  assert.equal(mortgage.mutation, false);
  // With the committed plan the live member already holds the accepted bytes: nothing to apply.
  await assert.rejects(
    run(applyEnv(MORTGAGE), applyDeps(MORTGAGE).deps),
    (error) => error.code === CODES.UNRELATED_MUTATION,
  );
});

test('mortgage-agent-compensation.mjs expected_live records the bytes production run 38901611978 applied', async () => {
  const MORTGAGE = 'mortgage-agent-compensation.mjs';
  const LIVE = 'efc4ae28488b3c9fccb7d8e76d3becd9789e129a6f6b04c434f9c01c08f873d6';
  const BEFORE = 'c38986152765e1d43443c82a779627bd55f96b3c2c246988f4697a3565166512';
  const APPLIED = 'aws/tests/fixtures/production-review-followups-manifest-2026-10-16.json';
  const PLATFORM_OWNER = 'aws/tests/fixtures/production-mortgage-compensation-platform-owner-manifest-2026-10-15.json';
  const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  // Applied 2026-10-16 (run 38901611978, VERIFIED) and found still live by the read-only inspect
  // run 39488779934 (ALREADY_ACCEPTED), so the ordered rollout skipped it without an apply.
  assert.match(PLAN.notes, /run 38901611978/);
  assert.match(PLAN.notes, /inspect run 39488779934/);
  const row = PLAN.members[MORTGAGE];
  assert.equal(row.operation, 'replace');
  assert.equal(row.manifest, APPLIED);
  assert.equal(row.expected_live_sha256, LIVE);
  assert.equal(row.accepted_sha256, LIVE);
  assert.equal(sha(`aws/functions/api/${MORTGAGE}`), LIVE);
  const applied = readJson(APPLIED).members[MORTGAGE];
  assert.equal(applied.live_sha256, LIVE);
  assert.equal(applied.accepted_sha256, LIVE);
  assert.equal(applied.previous_manifest, PLATFORM_OWNER);
  // The pre-apply bytes stay recorded as the platform-owner manifest's accepted value.
  assert.equal(readJson(PLATFORM_OWNER).members[MORTGAGE].accepted_sha256, BEFORE);
  assert.equal(resolvePlannedMember(MORTGAGE, { root: ROOT, plan: PLAN }).ok, true);
  const done = await run({ ...ENV, CHECKSOPS_PRODUCTION_DEPLOY_MODE: 'inspect', CHECKSOPS_PRODUCTION_OVERLAY_MEMBER: MORTGAGE }, { root: ROOT, inspectLive: liveFor(MORTGAGE) });
  assert.equal(done.state, 'ALREADY_ACCEPTED');
  assert.equal(done.mutation, false);
  // The stale pre-apply bytes are no longer an accepted live state.
  await assert.rejects(
    run({ ...ENV, CHECKSOPS_PRODUCTION_DEPLOY_MODE: 'inspect', CHECKSOPS_PRODUCTION_OVERLAY_MEMBER: MORTGAGE }, { root: ROOT, inspectLive: liveFor(MORTGAGE, { sha256: BEFORE }) }),
    (error) => error.code === CODES.SOURCE_RECONCILIATION_REQUIRED,
  );
});

test('checkalt-eligibility.mjs expected_live records the bytes production run 39663019340 applied', async () => {
  const ELIGIBILITY = 'providers/production/checkalt-eligibility.mjs';
  const LIVE = 'e681b0a02736d45a1984a6c61805e92f5966aae8060079630ef35d5226015329';
  const BEFORE = '7c3a1eb9b75c8dcea1fbad9e2862bda8cb5eb82d42241ab7f89349a450a02e57';
  const MANIFEST_REL = 'aws/tests/fixtures/production-checkalt-eligibility-select-manifest-2026-10-21.json';
  // Staging apply run 39662525342 (the staging acceptance), production inspect run 39662846247
  // (READY on the pre-apply bytes), production apply run 39663019340 (VERIFIED).
  assert.match(PLAN.notes, /staging apply run 39662525342/);
  assert.match(PLAN.notes, /inspect run 39662846247/);
  assert.match(PLAN.notes, /production apply run 39663019340/);
  assert.equal(PLAN.order[0], ELIGIBILITY);
  const row = PLAN.members[ELIGIBILITY];
  assert.equal(row.operation, 'replace');
  assert.equal(row.manifest, MANIFEST_REL);
  assert.equal(row.sql_before, null);
  assert.equal(row.expected_live_sha256, LIVE);
  assert.equal(row.accepted_sha256, LIVE);
  assert.equal(sha(`aws/functions/api/${ELIGIBILITY}`), LIVE);
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, MANIFEST_REL), 'utf8'));
  assert.equal(manifest.members[ELIGIBILITY].live_sha256, LIVE);
  assert.equal(manifest.members[ELIGIBILITY].accepted_sha256, LIVE);
  assert.match(manifest.notes, /run 39663019340/);
  assert.equal(resolvePlannedMember(ELIGIBILITY, { root: ROOT, plan: PLAN }).ok, true);
  const done = await run({ ...ENV, CHECKSOPS_PRODUCTION_DEPLOY_MODE: 'inspect', CHECKSOPS_PRODUCTION_OVERLAY_MEMBER: ELIGIBILITY }, { root: ROOT, inspectLive: liveFor(ELIGIBILITY) });
  assert.equal(done.state, 'ALREADY_ACCEPTED');
  assert.equal(done.mutation, false);
  // The pre-apply bytes are no longer an accepted live state.
  await assert.rejects(
    run({ ...ENV, CHECKSOPS_PRODUCTION_DEPLOY_MODE: 'inspect', CHECKSOPS_PRODUCTION_OVERLAY_MEMBER: ELIGIBILITY }, { root: ROOT, inspectLive: liveFor(ELIGIBILITY, { sha256: BEFORE }) }),
    (error) => error.code === CODES.SOURCE_RECONCILIATION_REQUIRED,
  );
});

test('storage-write.mjs expected_live records the bytes production run 39707778256 applied', async () => {
  const STORAGE_WRITE = 'storage-write.mjs';
  const LIVE = 'ccc72b14288580740bd57602543caaca558ba76d18c26c1bd5565c9841becf9e';
  const BEFORE = 'c397c52202b564917cd9d2b62853566c765b92aa6a8cd2304b6a09e74a3ed73f';
  const MANIFEST_REL = 'aws/tests/fixtures/production-upload-url-rear-stamp-manifest-2026-10-22.json';
  // Staging apply run 39707666098 (the staging acceptance), production inspect run 39707520750
  // (pre-apply bytes live), production apply run 39707778256, post-apply inspect run 39707882981.
  assert.match(PLAN.notes, /staging apply run 39707666098/);
  assert.match(PLAN.notes, /inspect run 39707520750/);
  assert.match(PLAN.notes, /production apply run 39707778256/);
  assert.match(PLAN.notes, /inspect run 39707882981/);
  assert.ok(PLAN.order.includes(STORAGE_WRITE));
  const row = PLAN.members[STORAGE_WRITE];
  assert.equal(row.operation, 'replace');
  assert.equal(row.manifest, MANIFEST_REL);
  assert.equal(row.sql_before, 'aws/workflows/sql/94_document_library_restore.sql');
  assert.equal(row.expected_live_sha256, LIVE);
  assert.equal(row.accepted_sha256, LIVE);
  assert.equal(sha(`aws/functions/api/${STORAGE_WRITE}`), LIVE);
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, MANIFEST_REL), 'utf8'));
  assert.equal(manifest.members[STORAGE_WRITE].live_sha256, LIVE);
  assert.equal(manifest.members[STORAGE_WRITE].accepted_sha256, LIVE);
  assert.match(manifest.notes, /run 39707778256/);
  assert.equal(resolvePlannedMember(STORAGE_WRITE, { root: ROOT, plan: PLAN }).ok, true);
  const done = await run({ ...ENV, CHECKSOPS_PRODUCTION_DEPLOY_MODE: 'inspect', CHECKSOPS_PRODUCTION_OVERLAY_MEMBER: STORAGE_WRITE }, { root: ROOT, inspectLive: liveFor(STORAGE_WRITE) });
  assert.equal(done.state, 'ALREADY_ACCEPTED');
  assert.equal(done.mutation, false);
  // The pre-apply bytes are no longer an accepted live state.
  await assert.rejects(
    run({ ...ENV, CHECKSOPS_PRODUCTION_DEPLOY_MODE: 'inspect', CHECKSOPS_PRODUCTION_OVERLAY_MEMBER: STORAGE_WRITE }, { root: ROOT, inspectLive: liveFor(STORAGE_WRITE, { sha256: BEFORE }) }),
    (error) => error.code === CODES.SOURCE_RECONCILIATION_REQUIRED,
  );
});

test('tenant-management-v2.mjs comes just before app-services.mjs, which imports it statically', async () => {
  const TMV2 = 'tenant-management-v2.mjs';
  const ROUTER = 'app-services.mjs';
  // Planned under the release manifest; its provider-status labels change (2026-10-27) moved the row
  // to its own planning-only manifest, and production run 40576842354 applied it over the release
  // bytes (b4596d10). The row records the applied bytes; the REPLACE is replayed from b4596d10 below.
  const PRE = 'b4596d1078b9acb64d333eb2f241713ec42c5a3a2188eda69c5654fad8485835';
  const MANIFEST = 'aws/tests/fixtures/production-tenant-management-v2-provider-status-applied-manifest-2026-10-27.json';
  const row = PLAN.members[TMV2];
  assert.equal(row.operation, 'replace');
  assert.equal(row.expected_live_sha256, row.accepted_sha256);
  assert.equal(row.sql_before, null);
  assert.equal(row.manifest, MANIFEST);
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, MANIFEST), 'utf8'));
  assert.equal(manifest.deploy_authorized, false);
  assert.equal(manifest.members[TMV2].accepted_sha256, row.accepted_sha256);
  const prePlan = structuredClone(PLAN);
  prePlan.members[TMV2].expected_live_sha256 = PRE;
  const preEnv = (member) => applyEnv(member, member === TMV2 ? { CHECKSOPS_EXPECTED_LIVE_MEMBER_SHA256: PRE } : {});
  assert.equal(row.accepted_sha256, sha(`aws/functions/api/${TMV2}`));
  assert.equal(PLAN.order.indexOf(TMV2) + 1, PLAN.order.indexOf(ROUTER));
  assert.ok(localImports(fs.readFileSync(path.join(ROOT, 'aws/functions/api', ROUTER), 'utf8'), ROUTER).includes(TMV2));
  // Its only import is data.mjs, an earlier member.
  const deps = localImports(fs.readFileSync(path.join(ROOT, 'aws/functions/api', TMV2), 'utf8'), TMV2);
  assert.deepEqual(deps, ['data.mjs']);
  assert.ok(PLAN.order.indexOf('data.mjs') < PLAN.order.indexOf(TMV2));

  // While tenant-management-v2.mjs is not yet the accepted bytes, app-services.mjs is refused.
  await assert.rejects(
    run(applyEnv(ROUTER), applyDeps(ROUTER, { pending: [TMV2], plan: prePlan }).deps),
    (error) => error.code === CODES.DEPLOYMENT_COLLISION,
  );
  // The REPLACE itself applies over the live release bytes ...
  const { deps: replaceDeps, calls } = applyDeps(TMV2, { plan: prePlan });
  const replaced = await run(preEnv(TMV2), replaceDeps);
  assert.equal(replaced.mutation, false);
  assert.deepEqual(calls.receipt.owned_member_ops, { replace: [TMV2], add: [] });
  // ... and app-services.mjs then links.
  const router = await run(applyEnv(ROUTER), applyDeps(ROUTER).deps);
  assert.equal(router.mutation, false);
});

test('#901 Review financial edits: write-allowlist.mjs, then write-check-workflow.mjs, held for SQL 89', async () => {
  const ALLOWLIST = 'write-allowlist.mjs';
  const WORKFLOW_WRITES = 'write-check-workflow.mjs';
  const SQL71 = 'aws/workflows/sql/71_review_amount_column_grant.sql';
  const SQL52 = 'aws/workflows/sql/52_verified_ocr_micr_column_grant.sql';
  const SQL89 = 'aws/workflows/sql/89_check_intake_items_column_update.sql';
  const MANIFEST_901 = 'aws/tests/fixtures/production-review-financial-edits-manifest-2026-10-16.json';

  const MANIFEST_RELEASE = 'aws/tests/fixtures/production-release-lock-pin-manifest-2026-10-17.json';
  const MANIFEST_STAKEHOLDER_SETTINGS_APPLIED = 'aws/tests/fixtures/production-stakeholder-settings-edit-applied-manifest-2026-10-25.json';
  const SQL93 = 'aws/workflows/sql/93_tenant_company_info.sql';

  // #901 planned both as REPLACE of the 2026-10-11 production bytes; that manifest stays as evidence.
  const manifest901 = JSON.parse(fs.readFileSync(path.join(ROOT, MANIFEST_901), 'utf8'));
  const release = JSON.parse(fs.readFileSync(path.join(ROOT, MANIFEST_RELEASE), 'utf8'));
  for (const [member, accepted, live] of [
    [ALLOWLIST, '9fdce9c64e5750de88a0dc2360a1383168c3f79fe20c90312689d9f74ed655b7', '0fdc95bd7be8137d87f581ba3468d04c9581edf20933fec39dc4872076d4fea0'],
    [WORKFLOW_WRITES, '1f5e9444afc2bf193110e48c05447af4a26346d69445abc8f96e8e1e29be787d', 'd9a9ce68d10691fdb21e5050de532d918017497d69e5c4278d6ecd3b06634c76'],
  ]) {
    assert.equal(manifest901.members[member].accepted_sha256, accepted, member);
    assert.equal(manifest901.members[member].live_sha256, live, member);
    // #901 was applied in production (inspect run 39179890402, 2026-10-19): release 2026-10-17 builds on
    // it, so its live bytes are #901's accepted bytes and the branch's bytes are accepted.
    const row = PLAN.members[member];
    assert.equal(row.operation, 'replace', member);
    assert.equal(release.members[member].previous_manifest, MANIFEST_901, member);
    assert.equal(release.members[member].supersedes_unapplied_manifest, undefined, member);
    assert.equal(release.members[member].live_sha256, accepted, member);
    // The release bytes went live with the 2026-10-21 production rebuilds; the stakeholder settings
    // edit replaced them in production (2026-10-25), so the row now expects that edit's applied bytes.
    assert.equal(row.manifest, MANIFEST_STAKEHOLDER_SETTINGS_APPLIED, member);
    assert.equal(row.expected_live_sha256, row.accepted_sha256, member);
    assert.notEqual(row.expected_live_sha256, release.members[member].accepted_sha256, member);
    assert.notEqual(row.expected_live_sha256, live, member);
    assert.equal(sha(`aws/functions/api/${member}`), row.accepted_sha256, member);
    assert.equal(resolvePlannedMember(member, { root: ROOT, plan: PLAN }).ok, true, member);
  }
  assert.equal(PLAN.members[ALLOWLIST].sql_before, SQL93);
  assert.equal(PLAN.members[WORKFLOW_WRITES].sql_before, SQL89);

  // The allowlist goes first (the new workflow writer imports REVIEW_* from it);
  // the Moov send module and providers.mjs stay last.
  assert.ok(localImports(fs.readFileSync(path.join(API, WORKFLOW_WRITES), 'utf8'), WORKFLOW_WRITES).includes(ALLOWLIST));
  assert.ok(PLAN.order.indexOf(WORKFLOW_WRITES) > PLAN.order.indexOf(ALLOWLIST));
  assert.deepEqual(PLAN.order.slice(-2), ['providers/production/moov-send.mjs', 'providers.mjs']);

  // SQL prerequisites: SQL 89, 71 and 52 recorded live from the SQL 89 apply; SQL 77-79 recorded applied.
  // SQL 89 applied in production (2026-10-16 one-shot); it produced SQL 71's and SQL 52's state.
  for (const sql of [SQL89, SQL71, SQL52]) {
    assert.equal(PLAN.sql_prerequisites[sql]?.verified_live, true, sql);
    assert.match(PLAN.sql_prerequisites[sql].evidence, /SSM c6c05ba9-dc58-4ab3-bdca-1b9996a7dc77/, sql);
  }
  assert.match(PLAN.sql_prerequisites[SQL71].evidence, /not by a SQL 71 apply/);
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

  // Both rows record the stakeholder settings edit's applied bytes live (2026-10-25), so the gates below
  // are replayed on the plan as it stood before that apply: each row expecting its pre-apply bytes.
  const STAKEHOLDER_PRE_APPLY = { [ALLOWLIST]: '5f84c5634190ebade1ee6ae10d3420e09548efac78f2a72eb98886d2f0341189', [WORKFLOW_WRITES]: 'fa2c6aef0e4e6c8713f60a24804309b4cf7f9e4b9d69a379498ef9acaf621fc2' };
  const PRE = structuredClone(PLAN);
  for (const [member, before] of Object.entries(STAKEHOLDER_PRE_APPLY)) PRE.members[member].expected_live_sha256 = before;
  const preEnv = (member) => applyEnv(member, { CHECKSOPS_EXPECTED_LIVE_MEMBER_SHA256: STAKEHOLDER_PRE_APPLY[member] });
  const preDeps = (member, opts = {}) => applyDeps(member, { ...opts, plan: PRE });

  // write-allowlist.mjs is held for SQL 93 (release 2026-10-17): SQL 93 is recorded live in
  // production since 2026-10-19 (#1061); its pre-record copy (SQL 93 not live) still refuses ...
  assert.equal(PLAN.sql_prerequisites[SQL93].verified_live, true);
  assert.match(PLAN.sql_prerequisites[SQL93].evidence, /SSM a3696b55-52c2-4674-bd11-35153197191c/);
  const without93 = structuredClone(PRE);
  without93.sql_prerequisites[SQL93] = { verified_live: false, evidence: null };
  await assert.rejects(
    run(preEnv(ALLOWLIST), { ...preDeps(ALLOWLIST).deps, plan: without93 }),
    (error) => error.code === CODES.PRODUCTION_APPROVAL_REQUIRED && error.details.sql_before === SQL93,
  );
  // ... and, once SQL 93 is recorded live, applies while write-check-workflow.mjs is still on its live bytes.
  const with93 = structuredClone(PRE);
  with93.sql_prerequisites[SQL93] = { verified_live: true, evidence: 'test' };
  const { deps, calls } = preDeps(ALLOWLIST);
  const live = await deps.inspectLive();
  assert.equal(live.memberHashes[WORKFLOW_WRITES], STAKEHOLDER_PRE_APPLY[WORKFLOW_WRITES]);
  const allowlist = await run(preEnv(ALLOWLIST), { ...deps, plan: with93 });
  assert.equal(allowlist.mutation, false);
  assert.deepEqual(calls.receipt.owned_member_ops, { replace: [ALLOWLIST], add: [] });

  // write-check-workflow.mjs is refused while SQL 89 is not recorded verified live ...
  const unverified = structuredClone(PRE);
  unverified.sql_prerequisites[SQL89] = { verified_live: false, evidence: null };
  await assert.rejects(
    run(preEnv(WORKFLOW_WRITES), { ...preDeps(WORKFLOW_WRITES).deps, plan: unverified }),
    (error) => error.code === CODES.PRODUCTION_APPROVAL_REQUIRED && error.details.sql_before === SQL89,
  );
  // ... and recording SQL 71 alone does not satisfy it ...
  const only71 = structuredClone(unverified);
  only71.sql_prerequisites[SQL71] = { verified_live: true, evidence: 'test' };
  await assert.rejects(
    run(preEnv(WORKFLOW_WRITES), { ...preDeps(WORKFLOW_WRITES).deps, plan: only71 }),
    (error) => error.code === CODES.PRODUCTION_APPROVAL_REQUIRED && error.details.sql_before === SQL89,
  );
  const verified = PRE;
  // ... and, once it is, still refused before write-allowlist.mjs is live ...
  await assert.rejects(
    run(preEnv(WORKFLOW_WRITES), { ...preDeps(WORKFLOW_WRITES, { pending: [ALLOWLIST] }).deps, plan: verified }),
    (error) => error.code === CODES.DEPLOYMENT_COLLISION && error.details.pending.includes(ALLOWLIST),
  );
  // ... or against an allowlist that does not export the REVIEW_* names ...
  await assert.rejects(
    run(preEnv(WORKFLOW_WRITES), { ...preDeps(WORKFLOW_WRITES, { sources: { [ALLOWLIST]: 'export const WRITE_ALLOWLIST = {};\n' } }).deps, plan: verified }),
    (error) => error.code === CODES.DEPLOYMENT_COLLISION
      && error.details.problems.some((row) => row === `${ALLOWLIST} does not export REVIEW_CHECK_STAGE`),
  );
  // ... and allowed after both.
  const writes = preDeps(WORKFLOW_WRITES);
  const result = await run(preEnv(WORKFLOW_WRITES), { ...writes.deps, plan: verified });
  assert.equal(result.mutation, false);
  assert.deepEqual(writes.calls.receipt.owned_member_ops, { replace: [WORKFLOW_WRITES], add: [] });

  // The SQL 89 hold does not block members before it (homeowner.mjs, mortgage-agent-compensation.mjs;
  // the latter simulated on its pre-apply bytes, since its committed expected_live is already accepted).
  const PRE_APPLY = { 'mortgage-agent-compensation.mjs': 'c38986152765e1d43443c82a779627bd55f96b3c2c246988f4697a3565166512' };
  for (const member of ['homeowner.mjs', 'mortgage-agent-compensation.mjs']) {
    assert.ok(PLAN.order.indexOf(member) < PLAN.order.indexOf(WORKFLOW_WRITES), member);
    const plan = structuredClone(PLAN);
    if (PRE_APPLY[member]) plan.members[member].expected_live_sha256 = PRE_APPLY[member];
    const env = PRE_APPLY[member] ? applyEnv(member, { CHECKSOPS_EXPECTED_LIVE_MEMBER_SHA256: PRE_APPLY[member] }) : applyEnv(member);
    const ahead = await run(env, { ...applyDeps(member, { pending: [WORKFLOW_WRITES], sha256: PRE_APPLY[member] }).deps, plan });
    assert.equal(ahead.mutation, false, member);
  }
});

test('fee collection: eleven members on the fee manifest, collection-v2 then destination then invoice email then billing, held for SQL 98 (handlers: SQL 102)', async () => {
  const MANIFEST_FEES = 'aws/tests/fixtures/production-fee-collection-pin-manifest-2026-10-17.json';
  const MANIFEST_RELEASE = 'aws/tests/fixtures/production-release-lock-pin-manifest-2026-10-17.json';
  const SQL96 = 'aws/workflows/sql/96_platform_owner_tenant_pricing.sql';
  const SQL98 = 'aws/workflows/sql/98_tenant_fee_collection.sql';
  const SQL102 = 'aws/workflows/sql/102_platform_owner_tenant_profile.sql';
  const COLLECTION = 'tenant-collection-v2.mjs';
  const DESTINATION = 'tenant-billing-destination.mjs';
  const ENGINE = 'tenant-billing-engine.mjs';
  const HANDLERS = 'tenant-billing-handlers.mjs';
  const INVOICE_EMAIL = 'tenant-fee-invoice-email.mjs';
  const DEPOSITS_GATE = 'tenant-deposits-gate.mjs';
  const WORKFLOW_RPC = 'workflow-rpc.mjs';
  const PROVIDERS = 'providers.mjs';
  const ADDS = new Set([INVOICE_EMAIL, DEPOSITS_GATE]);
  const fees = JSON.parse(fs.readFileSync(path.join(ROOT, MANIFEST_FEES), 'utf8'));
  const release = JSON.parse(fs.readFileSync(path.join(ROOT, MANIFEST_RELEASE), 'utf8'));
  assert.equal(fees.deploy_authorized, false);

  const superseded = ['providers/parity/moov-functions.mjs', 'providers/parity/moov-money.mjs', 'providers/catalog.mjs', ENGINE, HANDLERS, WORKFLOW_RPC, PROVIDERS];
  assert.deepEqual(Object.keys(fees.members).sort(), [...superseded, COLLECTION, DESTINATION, INVOICE_EMAIL, DEPOSITS_GATE].sort());
  // The engine and workflow-rpc.mjs were re-pinned after the fee work (referral billing credit and
  // Refer & Earn routes, 2026-10-23), and providers/catalog.mjs for the Moov payee names (2026-10-23):
  // this manifest still records their fee-branch bytes; the plan rows moved on (checked in their own
  // tests below).
  // tenant-billing-handlers.mjs was re-pinned for the tenant lifecycle actions (SQL 117, 2026-10-26).
  const REPINNED = new Set([ENGINE, WORKFLOW_RPC, 'providers/catalog.mjs', HANDLERS]);
  for (const member of Object.keys(fees.members)) {
    if (REPINNED.has(member)) continue;
    const row = PLAN.members[member];
    if (member === PROVIDERS) {
      // providers.mjs moved on to the production invoice route (moov-invoice manifest, applied by
      // production run 39955069311): its fee bytes are the live bytes that REPLACE started from, the
      // invoice manifest keeps that record, and the plan row now names the applied manifest.
      const invoice = JSON.parse(fs.readFileSync(path.join(ROOT, 'aws/tests/fixtures/production-moov-invoice-manifest-2026-10-22.json'), 'utf8'));
      // Then on to the production Platform Finance route, which REPLACE took from the invoice bytes
      // production run 39955069311 applied; then on to the Moov payee routes (REPLACE from the bytes
      // production run 39988166380 applied), applied by production run 40140208837: the plan row now
      // names the Moov payees applied manifest and expects its applied bytes; then on to the staging
      // sandbox send route, whose REPLACE started from those applied bytes and was applied by production
      // run 40222801952: the row now names the staging sends applied manifest and expects its bytes.
      const pf = JSON.parse(fs.readFileSync(path.join(ROOT, 'aws/tests/fixtures/production-platform-finance-manifest-2026-10-23.json'), 'utf8'));
      const payees = JSON.parse(fs.readFileSync(path.join(ROOT, 'aws/tests/fixtures/production-moov-payees-manifest-2026-10-23.json'), 'utf8'));
      const sends = JSON.parse(fs.readFileSync(path.join(ROOT, 'aws/tests/fixtures/production-sandbox-send-manifest-2026-10-25.json'), 'utf8'));
      assert.equal(row.manifest, 'aws/tests/fixtures/production-sandbox-send-applied-manifest-2026-10-25.json');
      assert.equal(pf.members[member].live_sha256, invoice.members[member].accepted_sha256);
      assert.equal(payees.members[member].live_sha256, pf.members[member].accepted_sha256);
      assert.equal(sends.members[member].live_sha256, payees.members[member].accepted_sha256);
      assert.equal(row.expected_live_sha256, sends.members[member].accepted_sha256);
      assert.equal(invoice.members[member].live_sha256, fees.members[member].accepted_sha256);
      assert.equal(row.sql_before, SQL98);
      continue;
    }
    assert.equal(row.manifest, MANIFEST_FEES, member);
    assert.equal(row.operation, ADDS.has(member) ? 'add' : 'replace', member);
    assert.equal(sha(`aws/functions/api/${member}`), row.accepted_sha256, member);
    assert.equal(resolvePlannedMember(member, { root: ROOT, plan: PLAN }).ok, true, member);
  }
  // The release's planned bytes were never applied: same live values, the fee branch's accepted bytes.
  for (const member of superseded) {
    assert.equal(fees.members[member].supersedes_unapplied_manifest, MANIFEST_RELEASE, member);
    assert.equal(fees.members[member].live_sha256, release.members[member].live_sha256, member);
  }
  // New to the plan: the 2026-10-11 live snapshot values.
  assert.equal(PLAN.members[COLLECTION].expected_live_sha256, '8a66f54d3c2785162a1643218e18b4d3c251230cf2a7f98a1ecb4ede8939fb66');
  assert.equal(PLAN.members[DESTINATION].expected_live_sha256, '7f9f24569d8d3112bcb829380de17b56ac5076fe8a8b38fd6a7633b44bcdfd80');
  // provider-flags.mjs (locked) is main's bytes and never an overlay member. The 2026-10-21 full-package
  // rebuilds (lambda-rebuild-plan.json) put main's 122b8769... bytes live in both environments; the
  // Plaid/Actum/QuickBooks removal changes it again and ships through the next rebuild, not an overlay.
  // identity-env.mjs is not a member either: the destination imports only names it already exports live
  // and on main.
  assert.equal(sha('aws/functions/api/provider-flags.mjs'), '0c903e5442cc3987e3727d51e4b61bbb4e12bcddbe7e21c2bff6058ea349b1c8');
  assert.ok(!PLAN.order.includes('identity-env.mjs'));
  assert.ok(!PLAN.order.includes('provider-flags.mjs'));
  assert.equal(PLAN.members['provider-flags.mjs'], undefined);

  // Order: collection-v2 (PRODUCTION_FEE_DESTINATION, bankOnly) -> destination -> engine -> handlers.
  const at = (name) => PLAN.order.indexOf(name);
  assert.ok(at(COLLECTION) >= 0 && at(COLLECTION) < at(DESTINATION));
  assert.ok(at(DESTINATION) < at(INVOICE_EMAIL) && at(INVOICE_EMAIL) < at(ENGINE) && at(ENGINE) < at(HANDLERS));
  assert.ok(localImports(fs.readFileSync(path.join(API, DESTINATION), 'utf8'), DESTINATION).includes(COLLECTION));
  // The invoice email module is new (ADD), imports the destination and is imported by the engine.
  assert.equal(PLAN.members[INVOICE_EMAIL].expected_live_sha256, null);
  assert.equal(PLAN.members[INVOICE_EMAIL].sql_before, null);
  assert.ok(localImports(fs.readFileSync(path.join(API, INVOICE_EMAIL), 'utf8'), INVOICE_EMAIL).includes(DESTINATION));
  assert.ok(localImports(fs.readFileSync(path.join(API, ENGINE), 'utf8'), ENGINE).includes(INVOICE_EMAIL));
  // Its email imports are names the live bundle already exports (email.mjs and email-layout.mjs
  // are not members; email-branding.mjs is planned earlier). email-policy.mjs is replaced later
  // (production email to every recipient) and still exports normalizeEmail, which it imports.
  for (const dep of ['email.mjs', 'email-layout.mjs']) assert.ok(!PLAN.order.includes(dep), dep);
  assert.ok(at('email-policy.mjs') > at(INVOICE_EMAIL));
  assert.match(fs.readFileSync(path.join(API, 'email-policy.mjs'), 'utf8'), /^export const normalizeEmail\b/m);
  assert.ok(at('email-branding.mjs') >= 0 && at('email-branding.mjs') < at(INVOICE_EMAIL));
  const invoiceApply = await run(applyEnv(INVOICE_EMAIL), applyDeps(INVOICE_EMAIL).deps);
  assert.equal(invoiceApply.mutation, false);
  await assert.rejects(
    run(applyEnv(INVOICE_EMAIL), applyDeps(INVOICE_EMAIL, { sources: { 'email.mjs': 'export const handleSendEmail = async () => ({});\n' } }).deps),
    (error) => error.code === CODES.DEPLOYMENT_COLLISION
      && error.details.problems.some((row) => row === 'email.mjs does not export sendViaSesOrSink'),
  );
  assert.deepEqual(PLAN.order.slice(-2), ['providers/production/moov-send.mjs', 'providers.mjs']);

  // The deposits gate (ADD, no local imports) lands before both deposit choke points that import it,
  // and both are held for SQL 98: the gate fails closed without SQL 98's reader.
  assert.deepEqual(localImports(fs.readFileSync(path.join(API, DEPOSITS_GATE), 'utf8'), DEPOSITS_GATE), []);
  // workflow-rpc.mjs now records its applied Refer & Earn bytes live (2026-10-23): its hold is replayed
  // from the pre-apply live bytes (79b7e4de, this manifest's accepted bytes).
  const WR_PRE = fees.members[WORKFLOW_RPC].accepted_sha256;
  const wrPre = (plan) => { plan.members[WORKFLOW_RPC].expected_live_sha256 = WR_PRE; return plan; };
  const memberEnv = (member) => (member === WORKFLOW_RPC ? applyEnv(member, { CHECKSOPS_EXPECTED_LIVE_MEMBER_SHA256: WR_PRE }) : applyEnv(member));
  const memberDeps = (member, liveOpts = {}) => (member === WORKFLOW_RPC ? applyDeps(member, { sha256: WR_PRE, ...liveOpts }) : applyDeps(member, liveOpts));
  for (const member of [WORKFLOW_RPC, PROVIDERS]) {
    assert.ok(localImports(fs.readFileSync(path.join(API, member), 'utf8'), member).includes(DEPOSITS_GATE), member);
    assert.ok(at(DEPOSITS_GATE) >= 0 && at(DEPOSITS_GATE) < at(member), member);
    assert.equal(PLAN.members[member].sql_before, SQL98, member);
    await assert.rejects(
      run(memberEnv(member), { ...memberDeps(member).deps, plan: wrPre(structuredClone(PLAN_SQL98_PENDING)) }),
      (error) => error.code === CODES.PRODUCTION_APPROVAL_REQUIRED && error.details.sql_before === SQL98,
      member,
    );
    const held = await run(memberEnv(member), { ...memberDeps(member).deps, plan: wrPre(structuredClone(PLAN_SQL98_LIVE)) });
    assert.equal(held.mutation, false, member);
  }
  assert.equal(PLAN.members[DEPOSITS_GATE].expected_live_sha256, null);
  assert.equal(PLAN.members[DEPOSITS_GATE].sql_before, null);
  assert.equal((await run(applyEnv(DEPOSITS_GATE), applyDeps(DEPOSITS_GATE).deps)).mutation, false);
  // SQL 120 (send-time fees, after SQL 98) now holds the engine; the handlers (profile-update,
  // member-remove) wait on SQL 102, which requires SQL 98 (SQL 98 itself requires SQL 96).
  assert.equal(PLAN.members[ENGINE].sql_before, 'aws/workflows/sql/120_usage_events_at_approval_and_send.sql');
  assert.equal(PLAN.members[HANDLERS].sql_before, SQL102);
  // SQL 102 is recorded live in production since its guarded apply of 2026-10-20 (#1079).
  const pre102 = PLAN.sql_prerequisites[SQL102];
  assert.equal(pre102.verified_live, true);
  assert.match(pre102.evidence, /SSM fdf84b2e-8f53-4e9f-b6a4-37a56054175b/);
  assert.match(pre102.evidence, /#1079/);
  const pin102 = JSON.parse(fs.readFileSync(path.join(ROOT, pre102.pin), 'utf8'));
  assert.equal(pin102.execute, false);
  assert.match(pin102.authorization, /^Applied to production on 2026-10-20; execute is false again/);
  assert.equal(pin102.applied.result, 'applied');
  assert.equal(pin102.applied.apply_ssm_command_id, 'fdf84b2e-8f53-4e9f-b6a4-37a56054175b');
  assert.equal(pin102.filename, SQL102);
  for (const member of [COLLECTION, DESTINATION]) assert.equal(PLAN.members[member].sql_before, null, member);
  const pre = PLAN.sql_prerequisites[SQL98];
  // SQL 98 is recorded live in production since its guarded apply of 2026-10-19 (#1072).
  assert.equal(pre.verified_live, true);
  assert.match(pre.evidence, /SSM 817865e7-2684-4f87-9f56-e57ed5386add/);
  assert.match(pre.evidence, /#1072/);
  // SQL 96 is recorded live in production since 2026-10-19 (#1064).
  assert.equal(PLAN.sql_prerequisites[SQL96].verified_live, true);
  assert.match(PLAN.sql_prerequisites[SQL96].evidence, /SSM df0acdce-9d1f-401c-a0f6-f6232e5d3f74/);
  const pin = JSON.parse(fs.readFileSync(path.join(ROOT, pre.pin), 'utf8'));
  // SQL 98's production pin is applied (2026-10-19, #1071) and retired; the plan records it verified live.
  assert.equal(pin.execute, false);
  assert.match(pin.authorization, /^Applied to production on 2026-10-19; execute is false again/);
  assert.equal(pin.applied.result, 'applied');
  assert.equal(pin.filename, SQL98);
  assert.equal(pin.source_sha256, sha(SQL98));
  assert.deepEqual(pin.predecessors, ['sql96']);
  assert.equal(pin.expected_live_definition_sha256, 'd64218dc145fc7b55632c7d5cfdef3fdbbb02592a79f6ff339c4814fc4ae6dbc');
  assert.equal(pin.staging_acceptance.ok, true);
  assert.equal(pin.staging_acceptance.reference, 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/39085677318');
  const { AUTHORIZED_SQL98_TENANT_FEE_COLLECTION: reg, FEE_COLLECTION_PENDING_SQL_PINS } = await import('../../scripts/deployment-guard/lib/sql-executor-auth.mjs');
  assert.equal(FEE_COLLECTION_PENDING_SQL_PINS.sql98, reg);
  // The staging pin is wave 3 (owner approved); the production pin above is applied and retired.
  const { assertStagingPinState } = await import('./helpers/staging-sql-wave1.mjs');
  assertStagingPinState(assert, 'sql98', reg);
  assert.equal(reg.source_sha256, pin.source_sha256);
  assert.equal(reg.commit, pin.staging_pin_commit);
  assert.deepEqual([...reg.function_identities], pin.function_identities);
  assert.match(fs.readFileSync(path.join(ROOT, SQL98), 'utf8'), /to_regprocedure\('public\.aws_platform_owner_set_tenant_pricing\(uuid, jsonb\)'\) IS NULL/);

  // Held while SQL 98 (the engine) or SQL 102 (the handlers) is not recorded live (the plan before
  // their 2026-10-19 and 2026-10-20 records) ...
  // The engine's plan row now records its applied referral-credit bytes live (2026-10-23), so the holds
  // are replayed from the pre-apply live bytes (338f93e1, the fee branch's accepted bytes): a REPLACE
  // that still has to pass every gate.
  const ENGINE_PRE = fees.members[ENGINE].accepted_sha256;
  // The row has since moved on to SQL 120 (send-fee billing, 2026-10-27); the replay restores the
  // SQL 98 hold it had then.
  const enginePre = (plan) => {
    plan.members[ENGINE].expected_live_sha256 = ENGINE_PRE;
    plan.members[ENGINE].sql_before = SQL98;
    return plan;
  };
  const engineEnv = () => applyEnv(ENGINE, { CHECKSOPS_EXPECTED_LIVE_MEMBER_SHA256: ENGINE_PRE });
  const engineDeps = (liveOpts = {}) => applyDeps(ENGINE, { sha256: ENGINE_PRE, ...liveOpts });
  // The handlers' row likewise records its applied tenant lifecycle bytes live (2026-10-27), so their
  // hold is replayed from the fee branch's accepted bytes (2f8ca3c5) too.
  const HANDLERS_PRE = fees.members[HANDLERS].accepted_sha256;
  const plan102Pending = enginePre(structuredClone(PLAN_SQL98_PENDING));
  plan102Pending.members[HANDLERS].expected_live_sha256 = HANDLERS_PRE;
  plan102Pending.sql_prerequisites[SQL102] = { ...plan102Pending.sql_prerequisites[SQL102], verified_live: false, evidence: null };
  const handlersEnv = () => applyEnv(HANDLERS, { CHECKSOPS_EXPECTED_LIVE_MEMBER_SHA256: HANDLERS_PRE });
  const handlersDeps = () => applyDeps(HANDLERS, { sha256: HANDLERS_PRE });
  for (const [member, sqlBefore] of [[ENGINE, SQL98], [HANDLERS, SQL102]]) {
    await assert.rejects(
      run(member === ENGINE ? engineEnv() : handlersEnv(), { ...(member === ENGINE ? engineDeps() : handlersDeps()).deps, plan: plan102Pending }),
      (error) => error.code === CODES.PRODUCTION_APPROVAL_REQUIRED && error.details.sql_before === sqlBefore,
      member,
    );
  }
  const with98 = enginePre(structuredClone(PLAN));
  with98.sql_prerequisites[SQL98] = { verified_live: true, evidence: 'test' };
  // ... then the engine still waits for collection-v2 and the destination ...
  await assert.rejects(
    run(engineEnv(), { ...engineDeps({ pending: [COLLECTION] }).deps, plan: with98 }),
    (error) => error.code === CODES.DEPLOYMENT_COLLISION && error.details.pending.includes(COLLECTION),
  );
  // ... and applies once they are live.
  const engine = engineDeps();
  const applied = await run(engineEnv(), { ...engine.deps, plan: with98 });
  assert.equal(applied.mutation, false);
  assert.deepEqual(engine.calls.receipt.owned_member_ops, { replace: [ENGINE], add: [] });

  // collection-v2 and the destination need no SQL. The destination links against live identity-env.mjs
  // (identityEnvFromChecksopsEnv, IDENTITY_ENV_PRODUCTION) and no longer imports provider-flags.mjs.
  assert.ok(!localImports(fs.readFileSync(path.join(API, DESTINATION), 'utf8'), DESTINATION).includes('provider-flags.mjs'));
  assert.ok(localImports(fs.readFileSync(path.join(API, DESTINATION), 'utf8'), DESTINATION).includes('identity-env.mjs'));
  const collection = await run(applyEnv(COLLECTION), applyDeps(COLLECTION).deps);
  assert.equal(collection.mutation, false);
  const destination = await run(applyEnv(DESTINATION), applyDeps(DESTINATION).deps);
  assert.equal(destination.mutation, false);
  await assert.rejects(
    run(applyEnv(DESTINATION), applyDeps(DESTINATION, { sources: { 'identity-env.mjs': "export const IDENTITY_ENV_PRODUCTION = 'production';\n" } }).deps),
    (error) => error.code === CODES.DEPLOYMENT_COLLISION
      && error.details.problems.some((row) => row === 'identity-env.mjs does not export identityEnvFromChecksopsEnv'),
  );
});

test('linkProblems refuses a member whose new bytes drop a name a live file imports (static or dynamic)', async () => {
  const { linkProblems, namedImports } = await import('../../scripts/deployment-guard/github-production-lambda-overlay.mjs');
  const live = {
    'app-services.mjs': "import { handleA, handleB } from './x.mjs';\nexport const route = 1;\n",
    'providers/caller-user.mjs': "export const go = async () => { const { isPlatformAdmin } = await import('../x.mjs'); return isPlatformAdmin; };\n",
    'x.mjs': 'export const handleA = 1; export const handleB = 2; export const isPlatformAdmin = 3;\n',
  };
  // The new x.mjs keeps every name: links.
  assert.deepEqual(linkProblems('x.mjs', 'export const handleA = 1; export const handleB = 2; export async function isPlatformAdmin() {}\n', live), []);
  // Dropping a statically imported name is refused.
  const dropStatic = linkProblems('x.mjs', 'export const handleA = 1; export const isPlatformAdmin = 3;\n', live);
  assert.deepEqual(dropStatic, ['app-services.mjs imports handleB from x.mjs, which the new bytes drop']);
  // Dropping a name a live file takes through a destructured dynamic import is refused too.
  const dropDynamic = linkProblems('x.mjs', 'export const handleA = 1; export const handleB = 2;\n', live);
  assert.deepEqual(dropDynamic, ['providers/caller-user.mjs imports isPlatformAdmin from x.mjs, which the new bytes drop']);
  // The new member's own dynamic imports must exist in the live modules.
  const forward = linkProblems('y.mjs', "export const f = async () => { const { missingName } = await import('./x.mjs'); };\n", live);
  assert.deepEqual(forward, ['x.mjs does not export missingName']);
  assert.deepEqual(namedImports("const { a, b: c } = await import('./z.mjs');", 'dir/m.mjs'), [{ module: 'dir/z.mjs', names: ['a', 'b'] }]);
});

test('namedImports fails closed on a binding it cannot read', async () => {
  const { namedImports } = await import('../../scripts/deployment-guard/github-production-lambda-overlay.mjs');
  for (const src of [
    "const { a = 1 } = await import('./x.mjs');",
    "const { a: { b } } = await import('./x.mjs');",
    "const { ...rest } = await import('./x.mjs');",
    "import { a /* b */ } from './x.mjs';",
  ]) {
    assert.throws(() => namedImports(src, 'm.mjs'), (error) => error.code === CODES.DEPLOYMENT_COLLISION && /cannot verify imported names/.test(error.message), src);
  }
  assert.deepEqual(namedImports("import { a, b as c } from './x.mjs';", 'm.mjs'), [{ module: 'x.mjs', names: ['a', 'b'] }]);
});

test('live reconciliation 2026-10-19: ten members expect the bytes inspect run 39179890402 recorded live', async () => {
  const FX = 'aws/tests/fixtures';
  const RELEASE = `${FX}/production-release-lock-pin-manifest-2026-10-17.json`;
  const FEES = `${FX}/production-fee-collection-pin-manifest-2026-10-17.json`;
  const ONBOARDING = `${FX}/production-checkalt-onboarding-manifest-2026-10-15.json`;
  const REGISTER = 'providers/production/checkalt-register.mjs';
  // member -> [pre-apply bytes the plan expected, live bytes (2026-10-19), plan manifest, manifest that applied them]
  const RECONCILED = {
    'workflow-rpc.mjs': ['9a630bdb5d3b42a411e7fe4043d4e4d5eb1f2e3f59b4ed1066e72351333cd075', '37cab8d6aac8ee1d9af70481b29dcda1e108904b68a2bc8e525d444e60ddf907', FEES, `${FX}/production-check-case-tenant-scope-manifest-2026-10-16.json`],
    'providers/parity/checkalt-functions.mjs': ['3d6a0495dbd797ce59ef8b553a074acdff6fd6c557a27a502587f0fa728954a7', '31e08908e587aa21552f2f6dd1a2a7bbacca88e08d4febbaf64f3368f3511357', RELEASE, `${FX}/production-checkalt-parity-functions-manifest-2026-10-15.json`],
    'homeowner.mjs': ['f9f993a71ea55f98681931e6d51ae283c0da84cde8e39e659db52b08a3c11897', '0cb700f158e01e8bf8ef5d02808fd8dd96c3710a2eebcee650db01dcc6717a95', RELEASE, `${FX}/production-review-followups-manifest-2026-10-16.json`],
    'write-signature.mjs': ['dee6b7d507d25853cc95a3de104c0c2b60bd0a87595c0976beb7fa23bc52db26', '867ab4e06cb1cda29802f1463f9af6c731898738e42d748da14b1780f7ad8b9c', RELEASE, `${FX}/production-signature-request-repairs-manifest-2026-10-15.json`],
    'email-branding.mjs': ['54cb79d1a62e9b62618d54c0f1e86e8ec43d9e1860a77bec32adde171a7b88cb', 'f248bc3fa04fdaa5221275c5812567dd701c19fd5b834e6ea391e84655d49fc0', RELEASE, `${FX}/production-signature-request-repairs-manifest-2026-10-15.json`],
    'esign.mjs': ['7c60b6462f7e0caa21800481a68735a44fc38bde19d74f78c64bc5ca97956b74', '953ef45cb9f79e4cec5309feb971490162ac23df1b5721c025da6f7a63f40b83', RELEASE, `${FX}/production-signature-request-repairs-manifest-2026-10-15.json`],
    'app-services.mjs': ['cce9d0ff48ce7644083e5aa04aec77c5100246b93a440c20ddb1ba5701bcc0c5', '51b2b4dc86b009dac49fc24ecbb412fe66a6e470f0173b4e5249fb3eaf7907fa', RELEASE, `${FX}/production-homeowner-signing-links-manifest-2026-10-15.json`],
    'write-allowlist.mjs': ['0fdc95bd7be8137d87f581ba3468d04c9581edf20933fec39dc4872076d4fea0', '9fdce9c64e5750de88a0dc2360a1383168c3f79fe20c90312689d9f74ed655b7', RELEASE, `${FX}/production-review-financial-edits-manifest-2026-10-16.json`],
    'write-check-workflow.mjs': ['d9a9ce68d10691fdb21e5050de532d918017497d69e5c4278d6ecd3b06634c76', '1f5e9444afc2bf193110e48c05447af4a26346d69445abc8f96e8e1e29be787d', RELEASE, `${FX}/production-review-financial-edits-manifest-2026-10-16.json`],
    // ADD accepted and applied by the Check Alt production onboarding (6f1c77c18); now a REPLACE.
    [REGISTER]: [null, '2264e34cc1d824d5f1c3a89c822a489bb35f90fc85b0ed90f68ebdbd1117b501', ONBOARDING, null],
  };
  const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  assert.match(PLAN.notes, /inspect run 39179890402/);
  assert.equal(Object.keys(RECONCILED).length, 10);
  // homeowner.mjs moved on: its c51ea27a release bytes went live (inspect run 39828391789,
  // ALREADY_ACCEPTED) and the plan row now replaces them for the pre-claim upload (next tests).
  // workflow-rpc.mjs moved on the same way: its fee-branch 79b7e4de bytes went live (inspect run
  // 39935902507, ALREADY_ACCEPTED), the plan row replaced them for the Refer & Earn routes, and production
  // run 39942182669 applied those (6902fe6f, now recorded live).
  // write-allowlist.mjs and write-check-workflow.mjs moved on too: their release bytes went live with
  // the 2026-10-21 production rebuilds, and production runs 40189236116 and 40189657073 replaced them
  // for the stakeholder settings edit (1fc4a43e and e1227c96, now recorded live).
  const MOVED_ON = {
    'homeowner.mjs': { accepted: 'c51ea27a37a72b18aed7881ae349212257b790e6ff400cbe675949574504a80c', liveNow: 'c51ea27a37a72b18aed7881ae349212257b790e6ff400cbe675949574504a80c' },
    'write-allowlist.mjs': { accepted: '5f84c5634190ebade1ee6ae10d3420e09548efac78f2a72eb98886d2f0341189', liveNow: '1fc4a43eda4455d406edd4566d7a2bada352d241e88ba01cb4ff2cd3afb2884a' },
    'write-check-workflow.mjs': { accepted: 'fa2c6aef0e4e6c8713f60a24804309b4cf7f9e4b9d69a379498ef9acaf621fc2', liveNow: 'e1227c967906496519db1fe9c996514c03ca04a79378ff77e93b92ecf470544a' },
    'workflow-rpc.mjs': { accepted: '79b7e4de653eb9d391afca9d27769b3b7c8e3d10d67af43e829ee32398797485', liveNow: '6902fe6f89f91c52f251ae1218257a387d6d7dd1fdb0e07687f6c99dfd5591d3' },
  };
  for (const [member, [before, live, manifestRel, appliedRel]] of Object.entries(RECONCILED)) {
    if (MOVED_ON[member]) {
      assert.equal(readJson(manifestRel).members[member].live_sha256, live, member);
      assert.equal(readJson(manifestRel).members[member].accepted_sha256, MOVED_ON[member].accepted, member);
      assert.equal(PLAN.members[member].expected_live_sha256, MOVED_ON[member].liveNow, member);
      continue;
    }
    const row = PLAN.members[member];
    assert.equal(row.operation, 'replace', member);
    assert.equal(row.expected_live_sha256, live, member);
    assert.notEqual(row.accepted_sha256, live, member);
    assert.equal(sha(`aws/functions/api/${member}`), row.accepted_sha256, member);
    assert.equal(row.manifest, manifestRel, member);
    const manifestRow = readJson(manifestRel).members[member];
    assert.equal(manifestRow.live_sha256, live, member);
    assert.equal(manifestRow.operation, 'replace', member);
    if (appliedRel) {
      // The live bytes are exactly what the earlier guarded production deploy accepted.
      const applied = readJson(appliedRel).members[member];
      assert.equal(applied.accepted_sha256, live, member);
      assert.equal(applied.live_sha256, before, member);
      const releaseRow = readJson(RELEASE).members[member];
      assert.equal(releaseRow.live_sha256, live, member);
      assert.equal(releaseRow.previous_manifest, appliedRel, member);
      assert.equal(releaseRow.supersedes_unapplied_manifest, undefined, member);
    }
    // Inspect accepts the recorded live bytes and refuses the stale pre-apply bytes.
    const inspect = { ...ENV, CHECKSOPS_PRODUCTION_DEPLOY_MODE: 'inspect', CHECKSOPS_PRODUCTION_OVERLAY_MEMBER: member };
    const ready = await run(inspect, { root: ROOT, inspectLive: liveFor(member) });
    assert.equal(ready.state, 'READY', member);
    assert.equal(ready.mutation, false, member);
    if (before) {
      await assert.rejects(
        run(inspect, { root: ROOT, inspectLive: liveFor(member, { sha256: before }) }),
        (error) => error.code === CODES.SOURCE_RECONCILIATION_REQUIRED,
        member,
      );
    }
  }
  assert.equal(PLAN.members[REGISTER].sql_before, 'aws/workflows/sql/81_checkalt_production_register.sql');
  assert.equal(PLAN.members[REGISTER].accepted_sha256, '8f06c079293a5e495043e87ad0d5aa6c01aa3fda182957efb745efa3c855f870');
});

test('Check Alt approve reconcile history: four REPLACE members, status-read and poll before submit', async () => {
  const STATUS_READ = 'providers/production/checkalt-status-read.mjs';
  const POLL = 'providers/production/checkalt-poll.mjs';
  const SUBMIT = 'providers/production/checkalt-submit.mjs';
  const APPROVE = 'providers/production/checkalt-approve.mjs';
  const MANIFEST_REL = 'aws/tests/fixtures/production-checkalt-approve-reconcile-history-manifest-2026-10-22.json';
  // Main's bytes at 008af40e2, live since the third full-package rebuild (production run 39669873076).
  const LIVE = {
    [STATUS_READ]: '10ac13a3c6c58df43d1a1dafbd8e0415c487125b2132b1cbc1caf9c3a0d18dee',
    [POLL]: 'cd083282e328caadb1b38598aa5f15ae7eda41708978afd06094ff62a24e4e56',
    [SUBMIT]: '68b0b9a8406ac1ea6ee39641eefc4fc3522d2ca6f4de0f5d8f2b46f1bff67f7d',
    [APPROVE]: 'd2aec271955373ec24cace5bf3b08116b26511aed30810499e5e15d439f9b161',
  };
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, MANIFEST_REL), 'utf8'));
  assert.equal(manifest.deploy_authorized, false);
  assert.match(manifest.notes, /run 39669873076/);
  // Submit was re-pinned after this deploy (Check Alt auto-approve always on, 2026-10-22):
  // this manifest still records its 68b0b9a8 -> 955b27e4 replace; the plan row moved on.
  assert.deepEqual(manifest.members[SUBMIT], {
    live_sha256: LIVE[SUBMIT],
    accepted_sha256: '955b27e43eea1a1aea38fc888e9e8152a248306458fd70a6d02c2cda4232e2ba',
    operation: 'replace',
  });
  // The always-on replace then started from exactly these bytes (and its bytes are what Option A replaces).
  const alwaysOn = JSON.parse(fs.readFileSync(path.join(ROOT, 'aws/tests/fixtures/production-checkalt-auto-approve-always-on-manifest-2026-10-22.json'), 'utf8'));
  assert.equal(alwaysOn.members[SUBMIT].live_sha256, manifest.members[SUBMIT].accepted_sha256);
  const optionA = JSON.parse(fs.readFileSync(path.join(ROOT, 'aws/tests/fixtures/production-checkalt-auto-approve-option-a-manifest-2026-10-24.json'), 'utf8'));
  assert.equal(optionA.members[SUBMIT].live_sha256, alwaysOn.members[SUBMIT].accepted_sha256);
  // Poll was re-pinned after this deploy (Check Alt scheduled status check, 2026-10-22):
  // this manifest still records its cd083282 -> b7a2a7f9 replace; the plan row moved on.
  assert.deepEqual(manifest.members[POLL], {
    live_sha256: LIVE[POLL],
    accepted_sha256: 'b7a2a7f9b33913625d454630939e1df3c2fe44aebbaca77f944f22e6a95af51e',
    operation: 'replace',
  });
  // The next poll replace (scheduled status check) started from exactly these bytes.
  const scheduledManifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'aws/tests/fixtures/production-checkalt-scheduled-reconcile-manifest-2026-10-22.json'), 'utf8'));
  assert.equal(scheduledManifest.members[POLL].live_sha256, manifest.members[POLL].accepted_sha256);
  const REPINNED = new Set([SUBMIT, POLL]);
  for (const [name, live] of Object.entries(LIVE)) {
    if (REPINNED.has(name)) continue;
    const row = PLAN.members[name];
    assert.equal(row.operation, 'replace', name);
    assert.equal(row.manifest, MANIFEST_REL, name);
    assert.equal(row.sql_before, null, name);
    assert.equal(row.expected_live_sha256, live, name);
    assert.equal(row.accepted_sha256, sha(`aws/functions/api/${name}`), name);
    assert.notEqual(row.accepted_sha256, live, name);
    assert.deepEqual(manifest.members[name], { live_sha256: live, accepted_sha256: row.accepted_sha256, operation: 'replace' }, name);
    assert.equal(approvalPhrase(name), `DEPLOY ${name} TO PRODUCTION`);
  }
  // The release 2026-10-17 pre-deploy values for submit and approve stay recorded in that manifest.
  const release = JSON.parse(fs.readFileSync(path.join(ROOT, 'aws/tests/fixtures/production-release-lock-pin-manifest-2026-10-17.json'), 'utf8'));
  assert.equal(release.members[SUBMIT].live_sha256, 'dd164667b1968cd487cf82b908ac3b8f2763152e700c649b53620e70425388d2');
  assert.equal(release.members[APPROVE].live_sha256, '4f19b9a7d582fd4132e7a9b6f65180268ccf41100e733ec63ba7bcf761f331ba');
  // Order: status-read (allow-list) -> poll (exports resolveSsoKey) -> submit (imports it) -> approve.
  const at = (name) => PLAN.order.indexOf(name);
  assert.ok(at(STATUS_READ) >= 0 && at(STATUS_READ) < at(POLL) && at(POLL) < at(SUBMIT) && at(SUBMIT) < at(APPROVE));
  assert.ok(localImports(fs.readFileSync(path.join(API, SUBMIT), 'utf8'), SUBMIT).includes(POLL));
  assert.ok(localImports(fs.readFileSync(path.join(API, POLL), 'utf8'), POLL).includes(STATUS_READ));
  for (const name of Object.keys(LIVE).filter((member) => !REPINNED.has(member))) {
    const ready = await run({ ...ENV, CHECKSOPS_PRODUCTION_DEPLOY_MODE: 'inspect', CHECKSOPS_PRODUCTION_OVERLAY_MEMBER: name }, { root: ROOT, inspectLive: liveFor(name) });
    assert.equal(ready.state, 'READY', name);
    assert.equal(ready.mutation, false, name);
  }
  // Submit refuses to link against a live poll that does not export resolveSsoKey yet.
  // The submit row now records its applied Option A bytes live (2026-10-24), so the check is replayed
  // from the pre-apply live bytes (d35e7841, the always-on accepted bytes): a REPLACE that still has to link.
  const oldPoll = fs.readFileSync(path.join(API, POLL), 'utf8')
    .replace('export async function resolveSsoKey(', 'async function resolveSsoKey(');
  const SUBMIT_PRE = alwaysOn.members[SUBMIT].accepted_sha256;
  const submitPre = structuredClone(PLAN);
  submitPre.members[SUBMIT].expected_live_sha256 = SUBMIT_PRE;
  await assert.rejects(
    run(
      applyEnv(SUBMIT, { CHECKSOPS_EXPECTED_LIVE_MEMBER_SHA256: SUBMIT_PRE }),
      { ...applyDeps(SUBMIT, { sha256: SUBMIT_PRE, sources: { [POLL]: oldPoll } }).deps, plan: submitPre },
    ),
    (error) => error.code === CODES.DEPLOYMENT_COLLISION
      && error.details.problems.some((row) => row === `${POLL} does not export resolveSsoKey`),
  );
});

test('Check Alt auto-approve always on: checkalt-submit.mjs REPLACE expects the bytes PR #1151 put live', async () => {
  const SUBMIT = 'providers/production/checkalt-submit.mjs';
  const POLL = 'providers/production/checkalt-poll.mjs';
  const MANIFEST_REL = 'aws/tests/fixtures/production-checkalt-auto-approve-always-on-manifest-2026-10-22.json';
  // Guarded production apply run 39778247008 (PR #1151); read-only production inspect run 39778871528.
  const LIVE = '955b27e43eea1a1aea38fc888e9e8152a248306458fd70a6d02c2cda4232e2ba';
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, MANIFEST_REL), 'utf8'));
  assert.equal(manifest.workstream_id, 'checkalt-auto-approve-always-on');
  assert.equal(manifest.deploy_authorized, false);
  assert.match(manifest.notes, /apply run 39778247008/);
  assert.match(manifest.notes, /inspect run 39778871528/);
  assert.match(PLAN.notes, /inspect run 39778871528/);
  // Submit was re-pinned before this replace was applied (Check Alt auto-approve Option A, 2026-10-24):
  // this manifest still records its 955b27e4 -> d35e7841 replace; the plan row moved on.
  assert.deepEqual(Object.keys(manifest.members), [SUBMIT]);
  assert.deepEqual(manifest.members[SUBMIT], {
    live_sha256: LIVE,
    accepted_sha256: 'd35e784179f98c2580ab2088aa4204340b727161eab55f301b91230daec19d69',
    operation: 'replace',
  });
  const row = PLAN.members[SUBMIT];
  assert.equal(row.operation, 'replace');
  assert.notEqual(row.manifest, MANIFEST_REL);
  // The always-on bytes went live (inspect run 40052246065); the Option A replace started from them.
  const optionA = JSON.parse(fs.readFileSync(path.join(ROOT, 'aws/tests/fixtures/production-checkalt-auto-approve-option-a-manifest-2026-10-24.json'), 'utf8'));
  assert.equal(optionA.members[SUBMIT].live_sha256, manifest.members[SUBMIT].accepted_sha256);
  assert.equal(approvalPhrase(SUBMIT), `DEPLOY ${SUBMIT} TO PRODUCTION`);
  assert.ok(PLAN.order.indexOf(POLL) < PLAN.order.indexOf(SUBMIT));
  assert.ok(localImports(fs.readFileSync(path.join(API, SUBMIT), 'utf8'), SUBMIT).includes(POLL));
  // The pre-#1151 bytes are no longer an accepted live state.
  await assert.rejects(
    run({ ...ENV, CHECKSOPS_PRODUCTION_DEPLOY_MODE: 'inspect', CHECKSOPS_PRODUCTION_OVERLAY_MEMBER: SUBMIT }, { root: ROOT, inspectLive: liveFor(SUBMIT, { sha256: '68b0b9a8406ac1ea6ee39641eefc4fc3522d2ca6f4de0f5d8f2b46f1bff67f7d' }) }),
    (error) => error.code === CODES.SOURCE_RECONCILIATION_REQUIRED,
  );
});

test('Check Alt auto-approve Option A: checkalt-submit.mjs expected_live records the bytes production run 40054316712 applied', async () => {
  const SUBMIT = 'providers/production/checkalt-submit.mjs';
  const POLL = 'providers/production/checkalt-poll.mjs';
  const MANIFEST_REL = 'aws/tests/fixtures/production-checkalt-auto-approve-option-a-manifest-2026-10-24.json';
  const APPLIED_REL = 'aws/tests/fixtures/production-checkalt-auto-approve-option-a-applied-manifest-2026-10-24.json';
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, MANIFEST_REL), 'utf8'));
  const applied = JSON.parse(fs.readFileSync(path.join(ROOT, APPLIED_REL), 'utf8'));
  // Always-on bytes, live in production before the apply: read-only production overlay inspect run 40052246065.
  const BEFORE = 'd35e784179f98c2580ab2088aa4204340b727161eab55f301b91230daec19d69';
  // Option A bytes, live after production apply run 40054316712 (post-apply inspect run 40055825626).
  const LIVE = '1b98060beb0645f31dabd7d366d914c95017028b993b01093de0c4d1422e47d1';
  // PR #1151 bytes (apply run 39778247008), no longer live.
  const PRE_ALWAYS_ON = '955b27e43eea1a1aea38fc888e9e8152a248306458fd70a6d02c2cda4232e2ba';
  const row = PLAN.members[SUBMIT];
  for (const runId of ['40052246065', '40054175726', '40054260101', '40054316712', '40055825626']) {
    assert.match(PLAN.notes, new RegExp(runId), runId);
    assert.match(applied.notes, new RegExp(`run ${runId}`), runId);
  }
  assert.equal(applied.workstream_id, 'production-checkalt-auto-approve-option-a-applied');
  assert.equal(applied.deploy_authorized, false);
  assert.deepEqual(Object.keys(applied.members), [SUBMIT]);
  assert.deepEqual(applied.members[SUBMIT], { live_sha256: LIVE, accepted_sha256: LIVE, operation: 'replace', previous_manifest: MANIFEST_REL });
  // The Option A manifest keeps the pre-apply record.
  assert.equal(manifest.workstream_id, 'checkalt-auto-approve-option-a');
  assert.equal(manifest.deploy_authorized, false);
  assert.match(manifest.notes, /Yes option A/);
  assert.match(manifest.notes, /inspect run 40052246065/);
  assert.deepEqual(Object.keys(manifest.members), [SUBMIT]);
  assert.deepEqual(manifest.members[SUBMIT], { live_sha256: BEFORE, accepted_sha256: LIVE, operation: 'replace' });
  assert.match(PLAN.notes, /Check Alt auto-approve Option A/);
  assert.equal(row.operation, 'replace');
  assert.equal(row.manifest, APPLIED_REL);
  assert.equal(row.sql_before, null);
  assert.equal(row.expected_live_sha256, LIVE);
  assert.equal(row.accepted_sha256, LIVE);
  assert.equal(sha(`aws/functions/api/${SUBMIT}`), LIVE);
  assert.equal(approvalPhrase(SUBMIT), `DEPLOY ${SUBMIT} TO PRODUCTION`);
  assert.ok(PLAN.order.indexOf(POLL) < PLAN.order.indexOf(SUBMIT));
  assert.ok(localImports(fs.readFileSync(path.join(API, SUBMIT), 'utf8'), SUBMIT).includes(POLL));
  const inspect = { ...ENV, CHECKSOPS_PRODUCTION_DEPLOY_MODE: 'inspect', CHECKSOPS_PRODUCTION_OVERLAY_MEMBER: SUBMIT };
  const done = await run(inspect, { root: ROOT, inspectLive: liveFor(SUBMIT, { sha256: LIVE }) });
  assert.equal(done.state, 'ALREADY_ACCEPTED');
  assert.equal(done.mutation, false);
  for (const stale of [BEFORE, PRE_ALWAYS_ON]) {
    await assert.rejects(
      run(inspect, { root: ROOT, inspectLive: liveFor(SUBMIT, { sha256: stale }) }),
      (error) => error.code === CODES.SOURCE_RECONCILIATION_REQUIRED,
      stale,
    );
  }
});

test('Check Alt scheduled status check: poll, status-reconcile, scheduled REPLACE the bytes found in the live package', async () => {
  const POLL = 'providers/production/checkalt-poll.mjs';
  const RECONCILE = 'providers/production/checkalt-status-reconcile.mjs';
  const SCHEDULED = 'scheduled.mjs';
  const MANIFEST_REL = 'aws/tests/fixtures/production-checkalt-scheduled-reconcile-manifest-2026-10-22.json';
  // Members of the live package (lambda:GetFunction, CodeSha256 L1s1+KyN4s/4nSgniwePGsv4NrjBdJwrv3Id1QRMEO0=,
  // 2026-10-22 14:18Z); each equals main at ea9b36500. Poll b7a2a7f9 is the reconcile-history accepted bytes.
  const LIVE = {
    [POLL]: 'b7a2a7f9b33913625d454630939e1df3c2fe44aebbaca77f944f22e6a95af51e',
    [RECONCILE]: 'e3ee3d433b5fae826311709b6cb142fdee308e2770047e532c450d16675785b5',
    [SCHEDULED]: '4b06d4cd578720a3996dc090cc396bda273c8de07e80cd7064d755af2b214abb',
  };
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, MANIFEST_REL), 'utf8'));
  assert.equal(manifest.workstream_id, 'checkalt-scheduled-reconcile-bank-deposits');
  assert.equal(manifest.deploy_authorized, false);
  assert.match(manifest.notes, /L1s1\+KyN4s\/4nSgniwePGsv4NrjBdJwrv3Id1QRMEO0=/);
  assert.match(PLAN.notes, /Check Alt scheduled status check/);
  assert.deepEqual(Object.keys(manifest.members), [POLL, RECONCILE, SCHEDULED]);
  for (const [name, live] of Object.entries(LIVE)) {
    if (name === POLL) {
      // Poll moved on to the time-budget bytes (next test); this manifest keeps its record.
      assert.deepEqual(manifest.members[name], { live_sha256: live, accepted_sha256: 'b2e7faa1b641f8898a3dc04c41f7f3e4723f0723157aeb6b95f2d146ee74c01e', operation: 'replace' });
      continue;
    }
    const row = PLAN.members[name];
    assert.equal(row.operation, 'replace', name);
    assert.equal(row.manifest, MANIFEST_REL, name);
    assert.equal(row.sql_before, null, name);
    assert.equal(row.expected_live_sha256, live, name);
    assert.equal(row.accepted_sha256, sha(`aws/functions/api/${name}`), name);
    assert.notEqual(row.accepted_sha256, live, name);
    assert.deepEqual(manifest.members[name], { live_sha256: live, accepted_sha256: row.accepted_sha256, operation: 'replace' }, name);
    assert.equal(approvalPhrase(name), `DEPLOY ${name} TO PRODUCTION`);
    assert.equal(resolvePlannedMember(name, { root: ROOT, plan: PLAN }).ok, true, name);
    const ready = await run({ ...ENV, CHECKSOPS_PRODUCTION_DEPLOY_MODE: 'inspect', CHECKSOPS_PRODUCTION_OVERLAY_MEMBER: name }, { root: ROOT, inspectLive: liveFor(name) });
    assert.equal(ready.state, 'READY', name);
    assert.equal(ready.mutation, false, name);
  }
  // poll -> status-reconcile (imports its new exports) -> scheduled (reaches the job through it).
  const at = (name) => PLAN.order.indexOf(name);
  assert.ok(at(POLL) >= 0 && at(POLL) < at(RECONCILE) && at(RECONCILE) < at(SCHEDULED));
  assert.ok(localImports(fs.readFileSync(path.join(API, RECONCILE), 'utf8'), RECONCILE).includes(POLL));
  assert.ok(localImports(fs.readFileSync(path.join(API, SCHEDULED), 'utf8'), SCHEDULED).includes(RECONCILE));
  // index.mjs is never overlaid and is unchanged: the scheduler event routes through the live /scheduled branch.
  assert.ok(PLAN.do_not_overlay.includes('index.mjs'));
  // status-reconcile refuses to link against a live poll without the new exports.
  const oldPoll = fs.readFileSync(path.join(API, POLL), 'utf8')
    .replace('export async function refreshDepositRow(', 'async function refreshDepositRow(');
  await assert.rejects(
    run(applyEnv(RECONCILE), applyDeps(RECONCILE, { sources: { [POLL]: oldPoll } }).deps),
    (error) => error.code === CODES.DEPLOYMENT_COLLISION
      && error.details.problems.some((row) => row === `${POLL} does not export refreshDepositRow`),
  );
});

test('Check Alt Poll Now time budget: poll REPLACEs the scheduled-reconcile bytes now live', async () => {
  const POLL = 'providers/production/checkalt-poll.mjs';
  const MANIFEST_REL = 'aws/tests/fixtures/production-checkalt-poll-time-budget-manifest-2026-10-22.json';
  // Live since the scheduled-reconcile production apply (2026-10-22).
  const LIVE = 'b2e7faa1b641f8898a3dc04c41f7f3e4723f0723157aeb6b95f2d146ee74c01e';
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, MANIFEST_REL), 'utf8'));
  assert.equal(manifest.workstream_id, 'checkalt-poll-time-budget');
  assert.equal(manifest.deploy_authorized, false);
  assert.match(manifest.notes, /2ba4b662-556b-4d09-819b-6121d47d9455/);
  assert.deepEqual(Object.keys(manifest.members), [POLL]);
  const row = PLAN.members[POLL];
  assert.equal(row.operation, 'replace');
  assert.equal(row.manifest, MANIFEST_REL);
  assert.equal(row.sql_before, null);
  assert.equal(row.expected_live_sha256, LIVE);
  assert.equal(row.accepted_sha256, sha(`aws/functions/api/${POLL}`));
  assert.notEqual(row.accepted_sha256, LIVE);
  assert.deepEqual(manifest.members[POLL], { live_sha256: LIVE, accepted_sha256: row.accepted_sha256, operation: 'replace' });
  assert.equal(resolvePlannedMember(POLL, { root: ROOT, plan: PLAN }).ok, true);
  const ready = await run({ ...ENV, CHECKSOPS_PRODUCTION_DEPLOY_MODE: 'inspect', CHECKSOPS_PRODUCTION_OVERLAY_MEMBER: POLL }, { root: ROOT, inspectLive: liveFor(POLL) });
  assert.equal(ready.state, 'READY');
  assert.equal(ready.mutation, false);
  // status-reconcile still links: the exports it imports are unchanged.
  const src = fs.readFileSync(path.join(API, POLL), 'utf8');
  for (const name of ['refreshDepositRow', 'loadDepositsForStatusRefresh', 'bindStatusRefreshGucs', 'batchDepositSummary']) {
    assert.match(src, new RegExp(`export (async )?(function|const) ${name}\\b`), name);
  }
});

test('homeowner pre-claim upload: homeowner.mjs REPLACEs the live c51ea27a bytes (no SQL hold; degrades until SQL 110)', async () => {
  const MEMBER = 'homeowner.mjs';
  const MANIFEST_REL = 'aws/tests/fixtures/production-homeowner-preclaim-upload-manifest-2026-10-22.json';
  // Live since the release lock pin apply (inspect run 39828391789: ALREADY_ACCEPTED, live c51ea27a).
  const LIVE = 'c51ea27a37a72b18aed7881ae349212257b790e6ff400cbe675949574504a80c';
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, MANIFEST_REL), 'utf8'));
  assert.equal(manifest.workstream_id, 'homeowner-preclaim-upload');
  assert.equal(manifest.deploy_authorized, false);
  assert.match(manifest.notes, /upload_unavailable/);
  const row = PLAN.members[MEMBER];
  assert.equal(row.operation, 'replace');
  assert.equal(row.manifest, MANIFEST_REL);
  assert.equal(row.sql_before, null);
  assert.equal(row.expected_live_sha256, LIVE);
  assert.equal(row.accepted_sha256, sha(`aws/functions/api/${MEMBER}`));
  assert.notEqual(row.accepted_sha256, LIVE);
  assert.deepEqual(manifest.members[MEMBER], { live_sha256: LIVE, accepted_sha256: row.accepted_sha256, operation: 'replace' });
  const ready = await run({ ...ENV, CHECKSOPS_PRODUCTION_DEPLOY_MODE: 'inspect', CHECKSOPS_PRODUCTION_OVERLAY_MEMBER: MEMBER }, { root: ROOT, inspectLive: liveFor(MEMBER) });
  assert.equal(ready.state, 'READY');
  assert.equal(ready.mutation, false);
});

test('referral billing credit: tenant-billing-engine.mjs expected_live records the bytes production run 39932114735 applied', async () => {
  const ENGINE = 'tenant-billing-engine.mjs';
  const MANIFEST_REL = 'aws/tests/fixtures/production-referral-billing-engine-manifest-2026-10-23.json';
  const MANIFEST_FEES = 'aws/tests/fixtures/production-fee-collection-pin-manifest-2026-10-17.json';
  const LIVE = '43d9a162445bf8e84824d4f60180cbcfab7b0cdae54cee1caf127a9fbb17f7f3';
  // The pre-apply member of the live package (lambda:GetFunction 2026-10-23T01:44Z, CodeSha256
  // 6YGMbhu9T8uw9tVJcMx12/x/GguD4vtGlUBrQes/kj4=): the fee branch's accepted bytes, main since f039ad6c3.
  const BEFORE = '338f93e1122d35e4929655b7418d65a6d14b51f5f61fe38812c1f2234be81d94';
  // Staging inspect 39930856507, staging apply 39931140922 (the staging acceptance), staging inspect
  // 39931640633, production apply 39932114735, production post-apply inspect 39932636916.
  for (const run of ['39930856507', '39931140922', '39931640633', '39932114735', '39932636916']) {
    assert.match(PLAN.notes, new RegExp(`run ${run}`), run);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, MANIFEST_REL), 'utf8'));
  assert.equal(manifest.workstream_id, 'referral-billing-engine-credit');
  assert.equal(manifest.deploy_authorized, false);
  assert.match(manifest.notes, /6YGMbhu9T8uw9tVJcMx12\/x\/GguD4vtGlUBrQes\/kj4=/);
  assert.match(manifest.notes, /run 39932114735/);
  assert.deepEqual(Object.keys(manifest.members), [ENGINE]);
  assert.deepEqual(manifest.members[ENGINE], { live_sha256: LIVE, accepted_sha256: LIVE, operation: 'replace' });
  // The plan row moved on to the send-fee billing change (checked in its own test below), planned
  // over the bytes this apply put live.
  const row = PLAN.members[ENGINE];
  assert.equal(row.operation, 'replace');
  const sendFee = JSON.parse(fs.readFileSync(path.join(ROOT, 'aws/tests/fixtures/production-billing-send-fee-events-manifest-2026-10-27.json'), 'utf8'));
  assert.equal(sendFee.members[ENGINE].live_sha256, LIVE);
  // The fee manifest's accepted bytes are the pre-apply bytes.
  const fees = JSON.parse(fs.readFileSync(path.join(ROOT, MANIFEST_FEES), 'utf8'));
  assert.equal(fees.members[ENGINE].accepted_sha256, BEFORE);
  // The pre-apply bytes are not an accepted live state.
  await assert.rejects(
    run({ ...ENV, CHECKSOPS_PRODUCTION_DEPLOY_MODE: 'inspect', CHECKSOPS_PRODUCTION_OVERLAY_MEMBER: ENGINE }, { root: ROOT, inspectLive: liveFor(ENGINE, { sha256: BEFORE }) }),
    (error) => error.code === CODES.SOURCE_RECONCILIATION_REQUIRED,
  );
  // The bytes now on main still read the SQL 111 credit and export the discount rule.
  const source = fs.readFileSync(path.join(API, ENGINE), 'utf8');
  assert.match(source, /aws_tenant_referral_credit_cents\(\$1::uuid\)/);
  assert.match(source, /export const maintenanceDiscountCents/);
});

test('send-fee billing: tenant-billing-engine.mjs replaced the 43d9a162 bytes; production run 40577608750 applied main\'s bytes (after SQL 120)', async () => {
  const ENGINE = 'tenant-billing-engine.mjs';
  const MANIFEST_REL = 'aws/tests/fixtures/production-billing-send-fee-events-manifest-2026-10-27.json';
  const APPLIED_REL = 'aws/tests/fixtures/production-billing-send-fee-events-applied-manifest-2026-10-27.json';
  // The member of the live package before the apply (read-only production overlay inspect run 40566119078,
  // ALREADY_ACCEPTED, CodeSha256 5w11XWe+2lgTnWTm5zQBrVWJftLs74DnwW6sZmoYbl8=): the referral credit bytes.
  const BEFORE = '43d9a162445bf8e84824d4f60180cbcfab7b0cdae54cee1caf127a9fbb17f7f3';
  const LIVE = 'bccffbe7aa9b21d3052a832f1d2c4b9ec4b333b1727156773b1ac034be96860c';
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, MANIFEST_REL), 'utf8'));
  assert.equal(manifest.workstream_id, 'billing-send-fee-events');
  assert.equal(manifest.deploy_authorized, false);
  assert.match(manifest.notes, /run 40566119078/);
  assert.match(manifest.notes, /5w11XWe\+2lgTnWTm5zQBrVWJftLs74DnwW6sZmoYbl8=/);
  assert.deepEqual(Object.keys(manifest.members), [ENGINE]);
  assert.deepEqual(manifest.members[ENGINE], { live_sha256: BEFORE, accepted_sha256: LIVE, operation: 'replace' });
  // Applied 2026-10-27: staging apply 40572754273, pre-apply inspect 40577454374, apply 40577608750 (VERIFIED).
  const applied = JSON.parse(fs.readFileSync(path.join(ROOT, APPLIED_REL), 'utf8'));
  for (const runId of ['40572754273', '40577454374', '40577608750']) {
    assert.match(PLAN.notes, new RegExp(runId), runId);
    assert.match(applied.notes, new RegExp(runId), runId);
  }
  assert.match(applied.notes, /fZPpTRW8dupjAOWnu6VKqvJ5SNaj2x7IYIaCdY4Rmfw=/);
  assert.equal(applied.workstream_id, 'billing-send-fee-events-applied');
  assert.equal(applied.deploy_authorized, false);
  assert.match(applied.authorization, /^Record only/);
  assert.deepEqual(applied.members[ENGINE], { live_sha256: LIVE, accepted_sha256: LIVE, operation: 'replace', previous_manifest: MANIFEST_REL });
  const row = PLAN.members[ENGINE];
  assert.equal(row.operation, 'replace');
  assert.equal(row.manifest, APPLIED_REL);
  assert.equal(row.expected_live_sha256, LIVE);
  assert.equal(row.accepted_sha256, LIVE);
  assert.equal(sha(`aws/functions/api/${ENGINE}`), LIVE);
  // The engine bills the fee SQL 120 writes at send time: SQL 120 stays its prerequisite.
  assert.equal(row.sql_before, 'aws/workflows/sql/120_usage_events_at_approval_and_send.sql');
  assert.equal(resolvePlannedMember(ENGINE, { root: ROOT, plan: PLAN }).ok, true);
  const inspect = { ...ENV, CHECKSOPS_PRODUCTION_DEPLOY_MODE: 'inspect', CHECKSOPS_PRODUCTION_OVERLAY_MEMBER: ENGINE };
  const done = await run(inspect, { root: ROOT, inspectLive: liveFor(ENGINE, { sha256: LIVE }) });
  assert.equal(done.state, 'ALREADY_ACCEPTED');
  assert.equal(done.mutation, false);
  await assert.rejects(
    run(inspect, { root: ROOT, inspectLive: liveFor(ENGINE, { sha256: BEFORE }) }),
    (error) => error.code === CODES.SOURCE_RECONCILIATION_REQUIRED,
  );
  const source = fs.readFileSync(path.join(API, ENGINE), 'utf8');
  assert.match(source, /export const sendRecipientKey/);
  assert.match(source, /NOT_A_SEND_LEG_ROLES = \['wallet_funding', 'parent', 'platform_fee'\]/);
});

test('Refer & Earn routes: data.mjs and workflow-rpc.mjs expected_live record the bytes production runs 39941822534 and 39942182669 applied', async () => {
  const MANIFEST_REL = 'aws/tests/fixtures/production-referral-api-routes-manifest-2026-10-23.json';
  const APPLIED_REL = 'aws/tests/fixtures/production-referral-api-routes-applied-manifest-2026-10-23.json';
  // Each row keeps its hold: workflow-rpc.mjs imports the deposits gate (SQL 98). The routes call SQL 111's
  // functions, applied in staging (run 39877945144) and production (SSM c006d74b, #1178) before this change.
  const SQL_BEFORE = {
    'data.mjs': 'aws/workflows/sql/53_claim_settlement_breakdown.sql',
    'workflow-rpc.mjs': 'aws/workflows/sql/98_tenant_fee_collection.sql',
  };
  // The bytes the guarded production applies put live (data.mjs run 39941822534, workflow-rpc.mjs run
  // 39942182669, both VERIFIED; post-apply inspects 39942016826 and 39942390776 ALREADY_ACCEPTED).
  const LIVE = {
    'data.mjs': 'c14a83e7c099150b8f6e489a6b318abc850b2868beeb3a9a981eea71fc38fae0',
    'workflow-rpc.mjs': '6902fe6f89f91c52f251ae1218257a387d6d7dd1fdb0e07687f6c99dfd5591d3',
  };
  // The pre-apply members of the live package (production preflight inspects 39941445627 and 39941608245,
  // READY, CodeSha256 busOVhKmeePCymsRvvyRdoDeF7FCmQwXhE9CJ24vpuc=).
  const BEFORE = {
    'data.mjs': '75fe96fc3a3f782a0e69e30f7dd4c4f5a1c5f64a93915bd40a0eaf6bd3ddde31',
    'workflow-rpc.mjs': '79b7e4de653eb9d391afca9d27769b3b7c8e3d10d67af43e829ee32398797485',
  };
  // The routes manifest builds on the manifest whose accepted bytes were live before the apply and keeps
  // the pre-apply bytes as live_sha256: both members are in the 2026-10-08 reconciliation and that row is
  // the chain's link (production-lambda-source-reconciliation.test.mjs). The applied manifest, which the
  // plan rows now name, records the applied bytes as live and accepted and chains to the routes manifest.
  const PREVIOUS = {
    'data.mjs': 'aws/tests/fixtures/production-checkalt-onboarding-manifest-2026-10-15.json',
    'workflow-rpc.mjs': 'aws/tests/fixtures/production-fee-collection-pin-manifest-2026-10-17.json',
  };
  for (const run of ['39940353716', '39940700184', '39941078707', '39940527401', '39940893969', '39941245219', '39941445627', '39941608245', '39941822534', '39942016826', '39942182669', '39942390776']) {
    assert.match(PLAN.notes, new RegExp(`run ${run}`), run);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, MANIFEST_REL), 'utf8'));
  assert.equal(manifest.workstream_id, 'referral-api-routes');
  assert.equal(manifest.deploy_authorized, false);
  assert.match(manifest.notes, /busOVhKmeePCymsRvvyRdoDeF7FCmQwXhE9CJ24vpuc=/);
  assert.match(manifest.notes, /39941822534/);
  assert.match(manifest.notes, /39942182669/);
  assert.deepEqual(Object.keys(manifest.members), Object.keys(LIVE));
  // Members whose plan row has since moved on to a later REPLACE that started from these applied bytes
  // (the later manifest) and was applied in turn (the row's manifest now).
  const MOVED_ON = {
    'data.mjs': {
      manifest: 'aws/tests/fixtures/production-data-secret-columns-manifest-2026-10-24.json',
      applied: 'aws/tests/fixtures/production-data-secret-columns-applied-manifest-2026-10-24.json',
    },
  };
  const appliedManifest = JSON.parse(fs.readFileSync(path.join(ROOT, APPLIED_REL), 'utf8'));
  assert.equal(appliedManifest.workstream_id, 'referral-api-routes-applied');
  assert.equal(appliedManifest.deploy_authorized, false);
  for (const run of ['39941822534', '39942016826', '39942182669', '39942390776']) assert.match(appliedManifest.notes, new RegExp(`run ${run}`), run);
  assert.deepEqual(Object.keys(appliedManifest.members), Object.keys(LIVE));
  for (const [member, live] of Object.entries(LIVE)) {
    const row = PLAN.members[member];
    assert.deepEqual(manifest.members[member], { live_sha256: BEFORE[member], accepted_sha256: live, operation: 'replace', previous_manifest: PREVIOUS[member] }, member);
    assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, PREVIOUS[member]), 'utf8')).members[member].accepted_sha256, BEFORE[member], member);
    assert.deepEqual(appliedManifest.members[member], { live_sha256: live, accepted_sha256: live, operation: 'replace', previous_manifest: MANIFEST_REL }, member);
    assert.equal(row.operation, 'replace', member);
    assert.equal(row.sql_before, SQL_BEFORE[member], member);
    assert.equal(PLAN.sql_prerequisites[row.sql_before].verified_live, true, member);
    assert.equal(resolvePlannedMember(member, { root: ROOT, plan: PLAN }).ok, true, member);
    assert.ok(PLAN.order.includes(member), member);
    const inspect = { ...ENV, CHECKSOPS_PRODUCTION_DEPLOY_MODE: 'inspect', CHECKSOPS_PRODUCTION_OVERLAY_MEMBER: member };
    if (MOVED_ON[member]) {
      // data.mjs moved on to the credential-column guard, whose REPLACE started from the bytes this apply
      // put live and was applied 2026-10-24 (its own test below): these bytes are no longer accepted live.
      const later = MOVED_ON[member];
      assert.equal(row.manifest, later.applied, member);
      assert.notEqual(row.accepted_sha256, live, member);
      assert.notEqual(row.expected_live_sha256, live, member);
      assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, later.applied), 'utf8')).members[member].previous_manifest, later.manifest, member);
      const moved = JSON.parse(fs.readFileSync(path.join(ROOT, later.manifest), 'utf8')).members[member];
      assert.equal(moved.previous_manifest, APPLIED_REL, member);
      assert.equal(moved.live_sha256, live, member);
      await assert.rejects(
        run(inspect, { root: ROOT, inspectLive: liveFor(member, { sha256: live }) }),
        (error) => error.code === CODES.SOURCE_RECONCILIATION_REQUIRED,
        member,
      );
    } else {
      assert.equal(row.expected_live_sha256, live, member);
      assert.equal(row.manifest, APPLIED_REL, member);
      assert.equal(row.accepted_sha256, live, member);
      assert.equal(sha(`aws/functions/api/${member}`), live, member);
      // Inspect accepts the live bytes as done; the pre-apply bytes are no longer an accepted live state.
      const done = await run(inspect, { root: ROOT, inspectLive: liveFor(member) });
      assert.equal(done.state, 'ALREADY_ACCEPTED', member);
      assert.equal(done.mutation, false, member);
    }
    await assert.rejects(
      run(inspect, { root: ROOT, inspectLive: liveFor(member, { sha256: BEFORE[member] }) }),
      (error) => error.code === CODES.SOURCE_RECONCILIATION_REQUIRED,
      member,
    );
  }
  // The live bytes: the redeem is a safe write RPC, the summary and the overview are read RPCs.
  assert.match(fs.readFileSync(path.join(API, 'workflow-rpc.mjs'), 'utf8'), /aws_apply_referral_code\(\$1::uuid, \$2::text\)/);
  const data = fs.readFileSync(path.join(API, 'data.mjs'), 'utf8');
  assert.match(data, /'aws_tenant_referral_summary'/);
  assert.match(data, /'aws_platform_owner_referral_overview'/);
});

test('Production Invoices: providers.mjs expected_live records the bytes production run 39955069311 applied; the added module is live', async () => {
  const INVOICE = 'providers/production/moov-invoice.mjs';
  const MANIFEST_REL = 'aws/tests/fixtures/production-moov-invoice-manifest-2026-10-22.json';
  const APPLIED_REL = 'aws/tests/fixtures/production-moov-invoice-applied-manifest-2026-10-23.json';
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, MANIFEST_REL), 'utf8'));
  const applied = JSON.parse(fs.readFileSync(path.join(ROOT, APPLIED_REL), 'utf8'));
  // The bytes the guarded production applies put live (ADD run 39954831032, REPLACE run 39955069311,
  // both VERIFIED; post-apply inspects 39955314383 and 39955539299 ALREADY_ACCEPTED).
  const LIVE = {
    [INVOICE]: 'f6d4dab35dc7bccf0a55ec7e7595a0d823ab3cd7a66279efb5663dd99baecb62',
    'providers.mjs': 'c1718779778a3b58f00b9bfa92d83b629aadc9e4b106ab4e8c460a946566b45f',
  };
  // The pre-apply providers.mjs (production inspect run 39950875106, ALREADY_ACCEPTED on the fee bytes).
  const PROVIDERS_BEFORE = '51fa3109f06470c09fc9598c5b29c92085c0833a5dd0894a1478e30db5f6423a';
  assert.equal(PROVIDERS_PRE, PROVIDERS_BEFORE);
  for (const run of ['39953598125', '39953857056', '39954096337', '39954273009', '39954302396', '39954831032', '39955069311', '39955314383', '39955539299']) {
    assert.match(PLAN.notes, new RegExp(run), run);
  }
  assert.equal(applied.workstream_id, 'moov-production-invoice-applied');
  assert.equal(applied.deploy_authorized, false);
  for (const run of ['39954831032', '39955069311', '39955314383', '39955539299']) assert.match(applied.notes, new RegExp(`run ${run}`), run);
  assert.deepEqual(Object.keys(applied.members), ['providers.mjs']);
  assert.deepEqual(applied.members['providers.mjs'], { live_sha256: LIVE['providers.mjs'], accepted_sha256: LIVE['providers.mjs'], operation: 'replace', previous_manifest: MANIFEST_REL });
  // The invoice manifest keeps the pre-apply record: providers.mjs from 51fa3109, the module absent.
  assert.equal(manifest.members['providers.mjs'].live_sha256, PROVIDERS_BEFORE);
  assert.equal(manifest.members['providers.mjs'].accepted_sha256, LIVE['providers.mjs']);
  assert.equal(manifest.members[INVOICE].live_sha256, null);
  assert.equal(manifest.members[INVOICE].accepted_sha256, LIVE[INVOICE]);
  // providers.mjs has since moved on to the Platform Finance route, whose REPLACE started from the
  // bytes this apply put live; the ADD row stays on the invoice manifest with expected_live null, as
  // applied ADD members do.
  const pf = JSON.parse(fs.readFileSync(path.join(ROOT, 'aws/tests/fixtures/production-platform-finance-manifest-2026-10-23.json'), 'utf8'));
  assert.equal(pf.members['providers.mjs'].live_sha256, LIVE['providers.mjs']);
  const add = PLAN.members[INVOICE];
  assert.equal(add.manifest, MANIFEST_REL);
  assert.equal(add.operation, 'add');
  assert.equal(add.expected_live_sha256, null);
  assert.equal(add.accepted_sha256, LIVE[INVOICE]);
  assert.equal(sha(`aws/functions/api/${INVOICE}`), LIVE[INVOICE]);
  assert.ok(PLAN.order.indexOf(INVOICE) < PLAN.order.indexOf('providers.mjs'));
  // Inspect accepts the added module as done; the pre-apply providers.mjs bytes are no longer an
  // accepted live state (providers.mjs itself: the Platform Finance test below).
  for (const member of [INVOICE]) {
    const inspect = { ...ENV, CHECKSOPS_PRODUCTION_DEPLOY_MODE: 'inspect', CHECKSOPS_PRODUCTION_OVERLAY_MEMBER: member };
    const done = await run(inspect, { root: ROOT, inspectLive: liveFor(member, { sha256: LIVE[member] }) });
    assert.equal(done.state, 'ALREADY_ACCEPTED', member);
    assert.equal(done.mutation, false, member);
  }
  const inspect = { ...ENV, CHECKSOPS_PRODUCTION_DEPLOY_MODE: 'inspect', CHECKSOPS_PRODUCTION_OVERLAY_MEMBER: 'providers.mjs' };
  await assert.rejects(
    run(inspect, { root: ROOT, inspectLive: liveFor('providers.mjs', { sha256: PROVIDERS_BEFORE }) }),
    (error) => error.code === CODES.SOURCE_RECONCILIATION_REQUIRED,
  );
});

test('Production Platform Finance: providers.mjs expected_live records the bytes production run 39988166380 applied; the added module is live', async () => {
  const PF = 'providers/production/platform-finance.mjs';
  const MANIFEST_REL = 'aws/tests/fixtures/production-platform-finance-manifest-2026-10-23.json';
  const APPLIED_REL = 'aws/tests/fixtures/production-platform-finance-applied-manifest-2026-10-23.json';
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, MANIFEST_REL), 'utf8'));
  const applied = JSON.parse(fs.readFileSync(path.join(ROOT, APPLIED_REL), 'utf8'));
  // The bytes the guarded production applies put live (ADD run 39987995317 VERIFIED, REPLACE run
  // 39988166380; post-apply inspect 39988303670 ALREADY_ACCEPTED).
  const LIVE = {
    [PF]: '2096af29aa7c0fcdbc5edf418877dabef7004e145ae7570baf793259acda8d0d',
    'providers.mjs': 'a72a583af99efff5cf9d5bba9f139080f947e04ed50a0f20ce3c2275037b40dc',
  };
  // The pre-apply providers.mjs (read-only production inspects 39983773878 / 39983961992).
  const PROVIDERS_BEFORE = 'c1718779778a3b58f00b9bfa92d83b629aadc9e4b106ab4e8c460a946566b45f';
  for (const run of ['39983773878', '39983961992', '39987501459', '39987661725', '39987878446', '39987995317', '39988166380', '39988303670']) {
    assert.match(PLAN.notes, new RegExp(run), run);
  }
  assert.equal(applied.workstream_id, 'production-platform-finance-applied');
  assert.equal(applied.deploy_authorized, false);
  for (const run of ['39987501459', '39987661725', '39987878446', '39987995317', '39988166380', '39988303670']) assert.match(applied.notes, new RegExp(`run ${run}`), run);
  assert.deepEqual(Object.keys(applied.members), ['providers.mjs']);
  assert.deepEqual(applied.members['providers.mjs'], { live_sha256: LIVE['providers.mjs'], accepted_sha256: LIVE['providers.mjs'], operation: 'replace', previous_manifest: MANIFEST_REL });
  // The Platform Finance manifest keeps the pre-apply record: providers.mjs from c1718779, the module absent.
  assert.equal(manifest.members['providers.mjs'].live_sha256, PROVIDERS_BEFORE);
  assert.equal(manifest.members['providers.mjs'].accepted_sha256, LIVE['providers.mjs']);
  assert.equal(manifest.members[PF].live_sha256, null);
  assert.equal(manifest.members[PF].accepted_sha256, LIVE[PF]);
  // The plan: providers.mjs has since moved on to the Moov payee routes, whose REPLACE started from the
  // bytes this apply put live and was applied 2026-10-24 (production run 40140208837, its own test
  // below), then on to the staging sandbox send route (applied 2026-10-25, its own test below); the ADD row stays
  // on the Platform Finance manifest with expected_live null.
  const PAYEES_REL = 'aws/tests/fixtures/production-moov-payees-manifest-2026-10-23.json';
  const PAYEES_APPLIED_REL = 'aws/tests/fixtures/production-moov-payees-applied-manifest-2026-10-24.json';
  const row = PLAN.members['providers.mjs'];
  assert.equal(row.manifest, 'aws/tests/fixtures/production-sandbox-send-applied-manifest-2026-10-25.json');
  assert.notEqual(row.expected_live_sha256, LIVE['providers.mjs']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, PAYEES_APPLIED_REL), 'utf8')).members['providers.mjs'].previous_manifest, PAYEES_REL);
  const payees = JSON.parse(fs.readFileSync(path.join(ROOT, PAYEES_REL), 'utf8'));
  assert.equal(payees.members['providers.mjs'].live_sha256, LIVE['providers.mjs']);
  const add = PLAN.members[PF];
  assert.equal(add.manifest, MANIFEST_REL);
  assert.equal(add.operation, 'add');
  assert.equal(add.expected_live_sha256, null);
  assert.equal(add.accepted_sha256, LIVE[PF]);
  assert.equal(sha(`aws/functions/api/${PF}`), LIVE[PF]);
  assert.ok(PLAN.order.indexOf('providers/production/moov-invoice.mjs') < PLAN.order.indexOf(PF));
  assert.ok(PLAN.order.indexOf(PF) < PLAN.order.indexOf('providers.mjs'));
  assert.equal(PLAN.order.at(-1), 'providers.mjs');
  // Inspect accepts the added module as done; neither the bytes this apply put live (since replaced by
  // the payee REPLACE) nor the pre-apply providers.mjs bytes are an accepted live state any more.
  const pfInspect = { ...ENV, CHECKSOPS_PRODUCTION_DEPLOY_MODE: 'inspect', CHECKSOPS_PRODUCTION_OVERLAY_MEMBER: PF };
  const done = await run(pfInspect, { root: ROOT, inspectLive: liveFor(PF, { sha256: LIVE[PF] }) });
  assert.equal(done.state, 'ALREADY_ACCEPTED');
  assert.equal(done.mutation, false);
  const inspect = { ...ENV, CHECKSOPS_PRODUCTION_DEPLOY_MODE: 'inspect', CHECKSOPS_PRODUCTION_OVERLAY_MEMBER: 'providers.mjs' };
  await assert.rejects(
    run(inspect, { root: ROOT, inspectLive: liveFor('providers.mjs', { sha256: LIVE['providers.mjs'] }) }),
    (error) => error.code === CODES.SOURCE_RECONCILIATION_REQUIRED,
  );
  await assert.rejects(
    run(inspect, { root: ROOT, inspectLive: liveFor('providers.mjs', { sha256: PROVIDERS_BEFORE }) }),
    (error) => error.code === CODES.SOURCE_RECONCILIATION_REQUIRED,
  );
});

test('Moov payees: four added modules, providers/catalog.mjs and providers.mjs record the bytes production runs 40139504036 to 40140208837 applied', async () => {
  const MANIFEST_REL = 'aws/tests/fixtures/production-moov-payees-manifest-2026-10-23.json';
  const APPLIED_REL = 'aws/tests/fixtures/production-moov-payees-applied-manifest-2026-10-24.json';
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, MANIFEST_REL), 'utf8'));
  const applied = JSON.parse(fs.readFileSync(path.join(ROOT, APPLIED_REL), 'utf8'));
  const CATALOG = 'providers/catalog.mjs';
  const ADDS = ['providers/payees/flags.mjs', 'providers/payees/moov.mjs', 'providers/payees/email.mjs', 'providers/payees/handlers.mjs'];
  // Before: providers.mjs from production run 39988166380 (Platform Finance applied manifest), the
  // catalog from the 2026-10-21 production rebuild run 39636816351 (lambda-rebuild-plan.json history[1]).
  const BEFORE = {
    'providers.mjs': 'a72a583af99efff5cf9d5bba9f139080f947e04ed50a0f20ce3c2275037b40dc',
    [CATALOG]: '43ada7ec092497fabfcd127db37d7ca25dbfe9063a61a8be713e2b62167dd561',
  };
  const rebuild = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/lambda-rebuild-plan.json'), 'utf8'));
  assert.equal(rebuild.environments.production.history[1].members[CATALOG].accepted_sha256, BEFORE[CATALOG]);
  const pfApplied = JSON.parse(fs.readFileSync(path.join(ROOT, 'aws/tests/fixtures/production-platform-finance-applied-manifest-2026-10-23.json'), 'utf8'));
  assert.equal(pfApplied.members['providers.mjs'].live_sha256, BEFORE['providers.mjs']);
  // Production preflight inspect, production apply and staging acceptance runs, in plan order (catalog
  // first); 40133588929 is the flags.mjs apply refused in preflight while the catalog was pending.
  const RUNS = {
    [CATALOG]: ['40126753113', '40139504036', '40126543954'],
    'providers/payees/flags.mjs': ['40126279422', '40133588929', '40139632951', '40126294550'],
    'providers/payees/moov.mjs': ['40126604674', '40139845109', '40125754577'],
    'providers/payees/email.mjs': ['40126644269', '40140006753', '40126471286'],
    'providers/payees/handlers.mjs': ['40126695520', '40140113163', '40123293289'],
    'providers.mjs': ['40126804899', '40140208837', '40126301381'],
  };
  for (const [name, runs] of Object.entries(RUNS)) {
    for (const runId of runs) {
      assert.match(PLAN.notes, new RegExp(runId), `${name} ${runId}`);
      assert.match(applied.notes, new RegExp(`run ${runId}`), `${name} ${runId}`);
    }
  }
  assert.match(applied.notes, /No separate post-apply inspect run was made/);
  assert.match(applied.notes, /AWS_MOOV_PAYEES_PRODUCTION_ENABLED is not set/);
  assert.equal(applied.workstream_id, 'production-moov-payees-applied');
  assert.equal(applied.deploy_authorized, false);
  assert.match(applied.authorization, /^Record only/);
  assert.deepEqual(Object.keys(applied.members), [...ADDS, CATALOG, 'providers.mjs']);
  // The Moov payees manifest keeps the pre-apply record: the four modules absent, the old bytes live.
  assert.equal(manifest.deploy_authorized, false);
  assert.match(manifest.authorization, /Planning only/);
  assert.deepEqual(Object.keys(manifest.members), [...ADDS, CATALOG, 'providers.mjs']);
  assert.match(PLAN.notes, /Moov payees \(2026-10-23, SQL 113; planning only, not authorized\)/);

  const at = (name) => PLAN.order.indexOf(name);
  assert.deepEqual(PLAN.order.slice(at('providers/production/platform-finance.mjs') + 1, at('providers/production/platform-finance.mjs') + 5), ADDS);
  assert.ok(at(CATALOG) < at(ADDS[0]));
  assert.equal(PLAN.order.at(-1), 'providers.mjs');
  const inspect = (name) => ({ ...ENV, CHECKSOPS_PRODUCTION_DEPLOY_MODE: 'inspect', CHECKSOPS_PRODUCTION_OVERLAY_MEMBER: name });
  for (const name of ADDS) {
    const LIVE = sha(`aws/functions/api/${name}`);
    assert.equal(manifest.members[name].live_sha256, null, name);
    assert.equal(manifest.members[name].accepted_sha256, LIVE, name);
    assert.deepEqual(applied.members[name], { live_sha256: LIVE, accepted_sha256: LIVE, operation: 'add', previous_manifest: MANIFEST_REL }, name);
    // The ADD rows stay as planned (precedent: secret-columns.mjs); inspect of the live module is a no-op.
    assert.deepEqual(PLAN.members[name], { operation: 'add', accepted_sha256: LIVE, expected_live_sha256: null, sql_before: null, manifest: MANIFEST_REL }, name);
    assert.equal((await run(inspect(name), { root: ROOT, inspectLive: liveFor(name, { sha256: LIVE }) })).state, 'ALREADY_ACCEPTED', name);
    // Each added module imports only members that are live or planned earlier.
    for (const dep of localImports(fs.readFileSync(path.join(API, name), 'utf8'), name)) {
      if (PLAN.members[dep]?.operation === 'add') assert.ok(at(dep) < at(name), `${dep} before ${name}`);
      assert.ok(fs.existsSync(path.join(API, dep)), dep);
    }
    for (const dep of manifest.members[name].required_imports) {
      assert.ok(localImports(fs.readFileSync(path.join(API, name), 'utf8'), name).includes(dep), `${name} imports ${dep}`);
    }
  }
  // providers.mjs has since moved on to the staging sandbox send route, whose REPLACE started from these
  // applied bytes and was applied by production run 40222801952 (its own test below): its row expects
  // main's newer bytes live.
  const SENDS = JSON.parse(fs.readFileSync(path.join(ROOT, 'aws/tests/fixtures/production-sandbox-send-manifest-2026-10-25.json'), 'utf8'));
  const MOVED_ON = { 'providers.mjs': 'aws/tests/fixtures/production-sandbox-send-applied-manifest-2026-10-25.json' };
  for (const [name, before] of Object.entries(BEFORE)) {
    const LIVE = applied.members[name].accepted_sha256;
    if (!MOVED_ON[name]) assert.equal(sha(`aws/functions/api/${name}`), LIVE, name);
    assert.deepEqual(manifest.members[name], { live_sha256: before, accepted_sha256: LIVE, operation: 'replace' }, name);
    assert.deepEqual(applied.members[name], { live_sha256: LIVE, accepted_sha256: LIVE, operation: 'replace', previous_manifest: MANIFEST_REL }, name);
    const row = PLAN.members[name];
    assert.equal(row.operation, 'replace', name);
    assert.equal(row.manifest, MOVED_ON[name] || APPLIED_REL, name);
    if (MOVED_ON[name]) assert.equal(SENDS.members[name].live_sha256, LIVE, name);
    assert.equal(row.expected_live_sha256, MOVED_ON[name] ? row.accepted_sha256 : LIVE, name);
    assert.equal(row.accepted_sha256, sha(`aws/functions/api/${name}`), name);
    assert.equal(resolvePlannedMember(name, { root: ROOT, plan: PLAN }).ok, true, name);
    const done = await run(inspect(name), { root: ROOT, inspectLive: liveFor(name, { sha256: row.accepted_sha256 }) });
    assert.equal(done.state, 'ALREADY_ACCEPTED', name);
    assert.equal(done.mutation, false, name);
    await assert.rejects(
      run(inspect(name), { root: ROOT, inspectLive: liveFor(name, { sha256: before }) }),
      (error) => error.code === CODES.SOURCE_RECONCILIATION_REQUIRED,
      name,
    );
  }
  assert.equal(PLAN.members['providers.mjs'].sql_before, 'aws/workflows/sql/98_tenant_fee_collection.sql');
  assert.equal(PLAN.members[CATALOG].sql_before, null);
  assert.ok(localImports(fs.readFileSync(path.join(API, 'providers.mjs'), 'utf8'), 'providers.mjs').includes('providers/payees/handlers.mjs'));
});

test('Platform Finance P&L accuracy: providers/parity/platform-finance.mjs expected_live records the bytes production run 40001351087 applied', async () => {
  const MEMBER = 'providers/parity/platform-finance.mjs';
  const MANIFEST_REL = 'aws/tests/fixtures/production-platform-pnl-manifest-2026-10-23.json';
  const APPLIED_REL = 'aws/tests/fixtures/production-platform-pnl-applied-manifest-2026-10-23.json';
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, MANIFEST_REL), 'utf8'));
  const applied = JSON.parse(fs.readFileSync(path.join(ROOT, APPLIED_REL), 'utf8'));
  const BEFORE = '746c89a69077463abd97f3f1a0beed23ba2d0eb17462c19ca75defd6e6fed0fb';
  const LIVE = '5b1ccfdb010d2ca3aab4ec22d3e958e7738623825c076d9531cb95c59c23d7e8';
  for (const run of ['40000973350', '40001083285', '40001243234', '40001351087']) {
    assert.match(PLAN.notes, new RegExp(run), run);
    assert.match(applied.notes, new RegExp(`run ${run}`), run);
  }
  assert.equal(applied.workstream_id, 'production-platform-pnl-applied');
  assert.equal(applied.deploy_authorized, false);
  assert.deepEqual(applied.members[MEMBER], { live_sha256: LIVE, accepted_sha256: LIVE, operation: 'replace', previous_manifest: MANIFEST_REL });
  // The P&L manifest keeps the pre-apply record.
  assert.deepEqual(manifest.members[MEMBER], { live_sha256: BEFORE, accepted_sha256: LIVE, operation: 'replace' });
  const row = PLAN.members[MEMBER];
  assert.equal(row.operation, 'replace');
  assert.equal(row.manifest, APPLIED_REL);
  assert.equal(row.expected_live_sha256, LIVE);
  assert.equal(row.accepted_sha256, LIVE);
  assert.equal(sha(`aws/functions/api/${MEMBER}`), LIVE);
  assert.ok(PLAN.order.indexOf(MEMBER) < PLAN.order.indexOf('providers/production/platform-finance.mjs'));
  assert.equal(PLAN.order.at(-1), 'providers.mjs');
  const inspect = { ...ENV, CHECKSOPS_PRODUCTION_DEPLOY_MODE: 'inspect', CHECKSOPS_PRODUCTION_OVERLAY_MEMBER: MEMBER };
  const done = await run(inspect, { root: ROOT, inspectLive: liveFor(MEMBER, { sha256: LIVE }) });
  assert.equal(done.state, 'ALREADY_ACCEPTED');
  assert.equal(done.mutation, false);
  await assert.rejects(
    run(inspect, { root: ROOT, inspectLive: liveFor(MEMBER, { sha256: BEFORE }) }),
    (error) => error.code === CODES.SOURCE_RECONCILIATION_REQUIRED,
  );
});

test('Mortgage agent login: tenant-admin.mjs expected_live records the bytes production run 40013182981 applied', async () => {
  const MEMBER = 'tenant-admin.mjs';
  const MANIFEST_REL = 'aws/tests/fixtures/production-mortgage-agent-login-manifest-2026-10-23.json';
  const APPLIED_REL = 'aws/tests/fixtures/production-mortgage-agent-login-applied-manifest-2026-10-23.json';
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, MANIFEST_REL), 'utf8'));
  const applied = JSON.parse(fs.readFileSync(path.join(ROOT, APPLIED_REL), 'utf8'));
  const BEFORE = 'e111223d673e26e27a91b24620dc8e97576b5f2a012d349e02ad3e666e35c906';
  const LIVE = '93fc41776f70c4c29349c74c4130bbafb2b87fdd7e353989ed2911be19893ed8';
  const row = PLAN.members[MEMBER];
  for (const runId of ['40011746459', '40011854288', '40012184072', '40013182981', '40013344042']) {
    assert.match(PLAN.notes, new RegExp(runId), runId);
    assert.match(applied.notes, new RegExp(`run ${runId}`), runId);
  }
  assert.equal(applied.workstream_id, 'production-mortgage-agent-login-applied');
  assert.equal(applied.deploy_authorized, false);
  assert.deepEqual(applied.members[MEMBER], { live_sha256: LIVE, accepted_sha256: LIVE, operation: 'replace', previous_manifest: MANIFEST_REL });
  // The login manifest keeps the pre-apply record.
  assert.deepEqual(manifest.members[MEMBER], { live_sha256: BEFORE, accepted_sha256: LIVE, operation: 'replace' });
  assert.equal(row.operation, 'replace');
  assert.equal(row.manifest, APPLIED_REL);
  assert.equal(row.expected_live_sha256, LIVE);
  assert.equal(row.accepted_sha256, LIVE);
  assert.equal(row.sql_before, 'aws/workflows/sql/90_users_only_tenant_roles.sql');
  assert.equal(sha(`aws/functions/api/${MEMBER}`), LIVE);
  assert.equal(PLAN.order.at(-1), 'providers.mjs');
  const inspect = { ...ENV, CHECKSOPS_PRODUCTION_DEPLOY_MODE: 'inspect', CHECKSOPS_PRODUCTION_OVERLAY_MEMBER: MEMBER };
  const done = await run(inspect, { root: ROOT, inspectLive: liveFor(MEMBER, { sha256: LIVE }) });
  assert.equal(done.state, 'ALREADY_ACCEPTED');
  assert.equal(done.mutation, false);
  await assert.rejects(
    run(inspect, { root: ROOT, inspectLive: liveFor(MEMBER, { sha256: BEFORE }) }),
    (error) => error.code === CODES.SOURCE_RECONCILIATION_REQUIRED,
  );
});

test('Data API credential columns: data.mjs expected_live records the bytes production run 40086704439 applied, keeping its SQL 53 hold', async () => {
  const MEMBER = 'data.mjs';
  const MANIFEST_REL = 'aws/tests/fixtures/production-data-secret-columns-manifest-2026-10-24.json';
  const APPLIED_REL = 'aws/tests/fixtures/production-data-secret-columns-applied-manifest-2026-10-24.json';
  const PREVIOUS_REL = 'aws/tests/fixtures/production-referral-api-routes-applied-manifest-2026-10-23.json';
  // Before: the bytes production run 39941822534 applied. Live: production apply run 40086704439,
  // post-apply inspect run 40086776532 (ALREADY_ACCEPTED).
  const BEFORE = 'c14a83e7c099150b8f6e489a6b318abc850b2868beeb3a9a981eea71fc38fae0';
  const LIVE = '4baa46e564aadf24d700aa4992180f845152d5e4ef423eb5ffa8d08c3b614517';
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, MANIFEST_REL), 'utf8'));
  const applied = JSON.parse(fs.readFileSync(path.join(ROOT, APPLIED_REL), 'utf8'));
  for (const runId of ['40086524626', '40086567392', '40086639131', '40086704439', '40086776532']) {
    assert.match(PLAN.notes, new RegExp(runId), runId);
    assert.match(applied.notes, new RegExp(`run ${runId}`), runId);
  }
  assert.equal(applied.workstream_id, 'production-data-secret-columns-applied');
  assert.equal(applied.deploy_authorized, false);
  assert.deepEqual(applied.members[MEMBER], { live_sha256: LIVE, accepted_sha256: LIVE, operation: 'replace', previous_manifest: MANIFEST_REL });
  // The secret-columns manifest keeps the pre-apply record.
  assert.equal(manifest.workstream_id, 'data-secret-columns');
  assert.deepEqual(manifest.members[MEMBER], { live_sha256: BEFORE, accepted_sha256: LIVE, operation: 'replace', previous_manifest: PREVIOUS_REL });
  assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, PREVIOUS_REL), 'utf8')).members[MEMBER].accepted_sha256, BEFORE);
  const row = PLAN.members[MEMBER];
  assert.equal(row.operation, 'replace');
  assert.equal(row.manifest, APPLIED_REL);
  assert.equal(row.expected_live_sha256, LIVE);
  assert.equal(row.accepted_sha256, LIVE);
  assert.equal(sha(`aws/functions/api/${MEMBER}`), LIVE);
  assert.equal(row.sql_before, 'aws/workflows/sql/53_claim_settlement_breakdown.sql');
  assert.equal(PLAN.sql_prerequisites[row.sql_before].verified_live, true);
  assert.equal(resolvePlannedMember(MEMBER, { root: ROOT, plan: PLAN }).ok, true);
  assert.ok(PLAN.order.indexOf('claim-settlement-rpc.mjs') < PLAN.order.indexOf(MEMBER));
  const inspect = { ...ENV, CHECKSOPS_PRODUCTION_DEPLOY_MODE: 'inspect', CHECKSOPS_PRODUCTION_OVERLAY_MEMBER: MEMBER };
  const done = await run(inspect, { root: ROOT, inspectLive: liveFor(MEMBER, { sha256: LIVE }) });
  assert.equal(done.state, 'ALREADY_ACCEPTED');
  assert.equal(done.mutation, false);
  await assert.rejects(
    run(inspect, { root: ROOT, inspectLive: liveFor(MEMBER, { sha256: BEFORE }) }),
    (error) => error.code === CODES.SOURCE_RECONCILIATION_REQUIRED,
  );
  // The live bytes refuse credential columns by name and strip them from * rows.
  const data = fs.readFileSync(path.join(API, MEMBER), 'utf8');
  assert.match(data, /export const SECRET_COLUMNS = Object\.freeze\(/);
  assert.match(data, /denySecretColumnQuery\(rawTable, parsedSelect, body\.filters, body\.order\)/);
  assert.match(data, /stripSecretColumns\(\(await client\.query\(sql, params\)\)\.rows, requested, table\)/);
});

test('Loss Draft from uploaded: workflow-transitions.mjs expected_live records the bytes production run 40089521986 applied', async () => {
  const MEMBER = 'workflow-transitions.mjs';
  const MANIFEST_REL = 'aws/tests/fixtures/production-loss-draft-from-uploaded-manifest-2026-10-24.json';
  const APPLIED_REL = 'aws/tests/fixtures/production-loss-draft-from-uploaded-applied-manifest-2026-10-24.json';
  const RELEASE = 'aws/tests/fixtures/production-release-lock-pin-manifest-2026-10-17.json';
  const LEDGER = 'supabase/migrations/20261007193200_skip_claim_ledger_event_for_endorsement_stage.sql';
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, MANIFEST_REL), 'utf8'));
  const applied = JSON.parse(fs.readFileSync(path.join(ROOT, APPLIED_REL), 'utf8'));
  const release = JSON.parse(fs.readFileSync(path.join(ROOT, RELEASE), 'utf8'));
  const BEFORE = 'f11206b4ac7239b6d75eb62e739d3c83f3dc8c568aa5c6d2be98f8335166c350';
  const LIVE = 'ed39e3c38d6f64f0b3a939ec2f741790406d913565fda6c399abe6ec6378ffe8';
  for (const runId of ['40088973289', '40089167308', '40089449374', '40089521986', '40089953478']) {
    assert.match(PLAN.notes, new RegExp(runId), runId);
    assert.match(applied.notes, new RegExp(`run ${runId}`), runId);
  }
  assert.equal(applied.workstream_id, 'production-loss-draft-from-uploaded-applied');
  assert.equal(applied.deploy_authorized, false);
  assert.deepEqual(applied.members[MEMBER], { live_sha256: LIVE, accepted_sha256: LIVE, operation: 'replace', previous_manifest: MANIFEST_REL });
  // The Loss Draft manifest keeps the pre-apply record, which chains to the release 2026-10-17 bytes.
  assert.deepEqual(manifest.members[MEMBER], { live_sha256: BEFORE, accepted_sha256: LIVE, operation: 'replace', previous_manifest: RELEASE });
  assert.equal(release.members[MEMBER].accepted_sha256, BEFORE);
  const row = PLAN.members[MEMBER];
  assert.equal(row.operation, 'replace');
  assert.equal(row.manifest, APPLIED_REL);
  assert.equal(row.expected_live_sha256, LIVE);
  assert.equal(row.accepted_sha256, LIVE);
  assert.equal(row.sql_before, LEDGER);
  assert.equal(PLAN.sql_prerequisites[LEDGER].verified_live, true);
  assert.equal(sha(`aws/functions/api/${MEMBER}`), LIVE);
  assert.equal(PLAN.order.at(-1), 'providers.mjs');
  assert.equal(resolvePlannedMember(MEMBER, { root: ROOT, plan: PLAN }).ok, true);
  const inspect = { ...ENV, CHECKSOPS_PRODUCTION_DEPLOY_MODE: 'inspect', CHECKSOPS_PRODUCTION_OVERLAY_MEMBER: MEMBER };
  const done = await run(inspect, { root: ROOT, inspectLive: liveFor(MEMBER, { sha256: LIVE }) });
  assert.equal(done.state, 'ALREADY_ACCEPTED');
  assert.equal(done.mutation, false);
  await assert.rejects(
    run(inspect, { root: ROOT, inspectLive: liveFor(MEMBER, { sha256: BEFORE }) }),
    (error) => error.code === CODES.SOURCE_RECONCILIATION_REQUIRED,
  );
});

test('Write echo secret columns: secret-columns.mjs, write-app-metadata.mjs and write.mjs record the bytes production runs 40089644649, 40089767778 and 40089891244 applied', async () => {
  const MANIFEST_REL = 'aws/tests/fixtures/production-write-echo-secret-columns-manifest-2026-10-24.json';
  const APPLIED_REL = 'aws/tests/fixtures/production-write-echo-secret-columns-applied-manifest-2026-10-24.json';
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, MANIFEST_REL), 'utf8'));
  const applied = JSON.parse(fs.readFileSync(path.join(ROOT, APPLIED_REL), 'utf8'));
  const ADD = 'secret-columns.mjs';
  const APP = 'write-app-metadata.mjs';
  const WRITE = 'write.mjs';
  const BEFORE = {
    [APP]: '32b805080a38f222ad99b8d558b16ce05795f6eb3a6d7a86b60d9fe2493766d5',
    [WRITE]: '24dbccf4d0b0aaf9b95b233efd66b44aadfd9eda6e7bf5d30c869cedb64c1f37',
  };
  const RUNS = {
    [ADD]: ['40089027682', '40089214719', '40089588106', '40089644649', '40090005596'],
    [APP]: ['40089072770', '40089257086', '40089712744', '40089767778', '40090050691'],
    [WRITE]: ['40089117635', '40089303182', '40089835380', '40089891244', '40090091796'],
  };
  for (const [name, runs] of Object.entries(RUNS)) {
    for (const runId of runs) {
      assert.match(PLAN.notes, new RegExp(runId), `${name} ${runId}`);
      assert.match(applied.notes, new RegExp(`run ${runId}`), `${name} ${runId}`);
    }
  }
  assert.equal(applied.workstream_id, 'production-write-echo-secret-columns-applied');
  assert.equal(applied.deploy_authorized, false);
  assert.deepEqual(Object.keys(applied.members), [ADD, APP, WRITE]);
  // The write echo manifest keeps the pre-apply record: secret-columns.mjs absent, the old bytes live.
  assert.deepEqual(Object.keys(manifest.members), [ADD, APP, WRITE]);
  assert.deepEqual(manifest.members[ADD], { live_sha256: null, accepted_sha256: sha(`aws/functions/api/${ADD}`), operation: 'add', required_imports: [] });
  const LIVE_ADD = sha(`aws/functions/api/${ADD}`);
  assert.deepEqual(applied.members[ADD], { live_sha256: LIVE_ADD, accepted_sha256: LIVE_ADD, operation: 'add', previous_manifest: MANIFEST_REL });
  // The ADD row stays as planned (precedent: moov-invoice.mjs); inspect of the live module is a no-op.
  assert.deepEqual(PLAN.members[ADD], { operation: 'add', accepted_sha256: LIVE_ADD, expected_live_sha256: null, sql_before: null, manifest: MANIFEST_REL });
  const inspect = (name) => ({ ...ENV, CHECKSOPS_PRODUCTION_DEPLOY_MODE: 'inspect', CHECKSOPS_PRODUCTION_OVERLAY_MEMBER: name });
  assert.equal((await run(inspect(ADD), { root: ROOT, inspectLive: liveFor(ADD, { sha256: LIVE_ADD }) })).state, 'ALREADY_ACCEPTED');

  const at = (name) => PLAN.order.indexOf(name);
  assert.deepEqual(PLAN.order.slice(at(ADD), at(ADD) + 3), [ADD, APP, WRITE]);
  assert.equal(PLAN.order.at(-1), 'providers.mjs');
  // write-app-metadata.mjs moved on: the stakeholder settings edit replaced the applied bytes in
  // production (run 40189560481, 2026-10-25), so its row expects that edit's applied bytes, which are
  // main's; write.mjs is unchanged.
  const MOVED_ON = { [APP]: 'aws/tests/fixtures/production-stakeholder-settings-edit-applied-manifest-2026-10-25.json' };
  for (const name of [APP, WRITE]) {
    const LIVE = applied.members[name].accepted_sha256;
    if (!MOVED_ON[name]) assert.equal(LIVE, sha(`aws/functions/api/${name}`), name);
    assert.ok(localImports(fs.readFileSync(path.join(API, name), 'utf8'), name).includes(ADD), `${name} imports ${ADD}`);
    assert.deepEqual(manifest.members[name], { live_sha256: BEFORE[name], accepted_sha256: LIVE, operation: 'replace' }, name);
    assert.deepEqual(applied.members[name], { live_sha256: LIVE, accepted_sha256: LIVE, operation: 'replace', previous_manifest: MANIFEST_REL }, name);
    const row = PLAN.members[name];
    assert.equal(row.operation, 'replace', name);
    assert.equal(row.manifest, MOVED_ON[name] || APPLIED_REL, name);
    assert.equal(row.accepted_sha256, sha(`aws/functions/api/${name}`), name);
    assert.equal(row.expected_live_sha256, MOVED_ON[name] ? row.accepted_sha256 : LIVE, name);
    const done = await run(inspect(name), { root: ROOT, inspectLive: liveFor(name, { sha256: row.expected_live_sha256 }) });
    assert.equal(done.state, 'ALREADY_ACCEPTED', name);
    await assert.rejects(
      run(inspect(name), { root: ROOT, inspectLive: liveFor(name, { sha256: BEFORE[name] }) }),
      (error) => error.code === CODES.SOURCE_RECONCILIATION_REQUIRED,
      name,
    );
  }
  assert.equal(PLAN.members[APP].sql_before, 'aws/workflows/sql/93_tenant_company_info.sql');
  assert.equal(PLAN.members[WRITE].sql_before, null);
});

test('Stakeholder settings edit: write-allowlist.mjs, write-app-metadata.mjs and write-check-workflow.mjs replace the bytes production runs 39636816351 and 40089767778 put live', async () => {
  const MANIFEST_REL = 'aws/tests/fixtures/production-stakeholder-settings-edit-manifest-2026-10-25.json';
  const APPLIED_REL = 'aws/tests/fixtures/production-stakeholder-settings-edit-applied-manifest-2026-10-25.json';
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, MANIFEST_REL), 'utf8'));
  const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  const ALLOWLIST = 'write-allowlist.mjs';
  const APP = 'write-app-metadata.mjs';
  const WORKFLOW_WRITES = 'write-check-workflow.mjs';
  // The live bytes, each from its recorded evidence: the production rebuild section that accepted
  // write-allowlist.mjs, the applied write echo manifest, and the release manifest whose
  // write-check-workflow.mjs bytes the deterministic rebuilds of main put live.
  const rebuild = readJson('ops/deployment-guard/lambda-rebuild-plan.json').environments.production.history[1];
  assert.equal(rebuild.applied.run_id, '39636816351');
  const LIVE = {
    [ALLOWLIST]: rebuild.members[ALLOWLIST].accepted_sha256,
    [APP]: readJson('aws/tests/fixtures/production-write-echo-secret-columns-applied-manifest-2026-10-24.json').members[APP].accepted_sha256,
    [WORKFLOW_WRITES]: readJson('aws/tests/fixtures/production-release-lock-pin-manifest-2026-10-17.json').members[WORKFLOW_WRITES].accepted_sha256,
  };
  const SQL_BEFORE = {
    [ALLOWLIST]: 'aws/workflows/sql/93_tenant_company_info.sql',
    [APP]: 'aws/workflows/sql/93_tenant_company_info.sql',
    [WORKFLOW_WRITES]: 'aws/workflows/sql/89_check_intake_items_column_update.sql',
  };
  assert.equal(manifest.workstream_id, 'production-stakeholder-settings-edit');
  assert.equal(manifest.deploy_authorized, false);
  assert.match(manifest.authorization, /^Pending owner review \(2026-10-25\)/);
  assert.deepEqual(Object.keys(manifest.members), [ALLOWLIST, APP, WORKFLOW_WRITES]);
  for (const runId of ['39636816351', '39669873076', '40089767778']) {
    assert.match(manifest.notes, new RegExp(runId), runId);
    assert.match(PLAN.notes, new RegExp(runId), runId);
  }
  const inspect = (name) => ({ ...ENV, CHECKSOPS_PRODUCTION_DEPLOY_MODE: 'inspect', CHECKSOPS_PRODUCTION_OVERLAY_MEMBER: name });
  for (const name of [ALLOWLIST, APP, WORKFLOW_WRITES]) {
    const onMain = sha(`aws/functions/api/${name}`);
    assert.notEqual(onMain, LIVE[name], name);
    assert.deepEqual(manifest.members[name], { live_sha256: LIVE[name], accepted_sha256: onMain, operation: 'replace' }, name);
    // Applied 2026-10-25 (next test): the row expects main's bytes and names the applied manifest, so
    // the pre-apply bytes this manifest planned to replace are now drift.
    assert.deepEqual(PLAN.members[name], {
      operation: 'replace', accepted_sha256: onMain, expected_live_sha256: onMain, sql_before: SQL_BEFORE[name], manifest: APPLIED_REL,
    }, name);
    assert.equal(resolvePlannedMember(name, { root: ROOT, plan: PLAN }).ok, true, name);
    await assert.rejects(
      run(inspect(name), { root: ROOT, inspectLive: liveFor(name, { sha256: LIVE[name] }) }),
      (error) => error.code === CODES.SOURCE_RECONCILIATION_REQUIRED,
      name,
    );
    assert.equal((await run(inspect(name), { root: ROOT, inspectLive: liveFor(name, { sha256: onMain }) })).state, 'ALREADY_ACCEPTED', name);
  }
  // Each in its existing place: the allowlist, then the writer, then the forwarder that opens the
  // route; the Moov send module and providers.mjs stay last.
  const at = (name) => PLAN.order.indexOf(name);
  assert.ok(at(ALLOWLIST) < at(APP) && at(APP) < at(WORKFLOW_WRITES));
  assert.deepEqual(PLAN.order.slice(-2), ['providers/production/moov-send.mjs', 'providers.mjs']);
  // SQL 114 is not yet a recorded prerequisite: the plan names it in the notes, not as a hold.
  assert.equal(PLAN.sql_prerequisites['aws/workflows/sql/114_stakeholder_accounts_settings_update_grant.sql'], undefined);
  assert.match(PLAN.notes, /apply production SQL 114 before write-check-workflow\.mjs/);
});

test('Staging sends: moov-send.mjs and providers.mjs record the bytes production runs 40222560555 and 40222801952 applied', async () => {
  const MANIFEST_REL = 'aws/tests/fixtures/production-sandbox-send-manifest-2026-10-25.json';
  const APPLIED_REL = 'aws/tests/fixtures/production-sandbox-send-applied-manifest-2026-10-25.json';
  const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  const manifest = readJson(MANIFEST_REL);
  const applied = readJson(APPLIED_REL);
  const SEND = 'providers/production/moov-send.mjs';
  const PROVIDERS = 'providers.mjs';
  // The pre-apply live bytes, each from its recorded evidence: the 2026-10-13 send manifest's accepted
  // bytes (main's file as of #1187, observed live by read-only production inspect 40221211781) and the
  // Moov payees applied bytes.
  const BEFORE = {
    [SEND]: readJson('aws/tests/fixtures/production-moov-send-manifest-2026-10-13.json').members[SEND].accepted_sha256,
    [PROVIDERS]: readJson('aws/tests/fixtures/production-moov-payees-applied-manifest-2026-10-24.json').members[PROVIDERS].accepted_sha256,
  };
  // Staging acceptance, production preflight inspect and production apply, per member.
  const RUNS = {
    [SEND]: ['40197877443', '40222492629', '40222560555'],
    [PROVIDERS]: ['40198273983', '40222650555', '40222801952'],
  };
  assert.equal(manifest.workstream_id, 'production-sandbox-send');
  assert.equal(manifest.deploy_authorized, false);
  assert.equal(applied.workstream_id, 'production-sandbox-send-applied');
  assert.equal(applied.deploy_authorized, false);
  assert.match(applied.authorization, /^Record only \(2026-10-25\)/);
  assert.deepEqual(Object.keys(manifest.members), [SEND, PROVIDERS]);
  assert.deepEqual(Object.keys(applied.members), [SEND, PROVIDERS]);
  assert.match(PLAN.notes, /Staging sends applied 2026-10-25 on main 8d8235be9/);
  const inspect = (name) => ({ ...ENV, CHECKSOPS_PRODUCTION_DEPLOY_MODE: 'inspect', CHECKSOPS_PRODUCTION_OVERLAY_MEMBER: name });
  // moov-send.mjs has since moved on to payee sends (applied 2026-10-26, its own test below): its row
  // expects main's newer bytes live and names the onboarding and payee sends applied manifest.
  const MOVED_ON = { [SEND]: 'aws/tests/fixtures/production-onboarding-payee-send-applied-manifest-2026-10-26.json' };
  for (const name of [SEND, PROVIDERS]) {
    const LIVE = applied.members[name].accepted_sha256;
    if (!MOVED_ON[name]) assert.equal(sha(`aws/functions/api/${name}`), LIVE, name);
    assert.notEqual(LIVE, BEFORE[name], name);
    // The planned manifest keeps the pre-apply state; the applied manifest chains to it.
    assert.deepEqual(manifest.members[name], { live_sha256: BEFORE[name], accepted_sha256: LIVE, operation: 'replace' }, name);
    assert.deepEqual(applied.members[name], { live_sha256: LIVE, accepted_sha256: LIVE, operation: 'replace', previous_manifest: MANIFEST_REL }, name);
    // The plan row expects the applied bytes and names the applied manifest (or the one it moved on to).
    const row = PLAN.members[name];
    assert.equal(row.operation, 'replace', name);
    assert.equal(row.manifest, MOVED_ON[name] || APPLIED_REL, name);
    assert.equal(row.expected_live_sha256, MOVED_ON[name] ? row.accepted_sha256 : LIVE, name);
    assert.equal(row.accepted_sha256, sha(`aws/functions/api/${name}`), name);
    assert.equal(resolvePlannedMember(name, { root: ROOT, plan: PLAN }).ok, true, name);
    for (const runId of RUNS[name]) {
      assert.match(applied.notes, new RegExp(`run ${runId}`), `${name} ${runId}`);
      assert.match(PLAN.notes, new RegExp(runId), `${name} ${runId}`);
    }
    const done = await run(inspect(name), { root: ROOT, inspectLive: liveFor(name, { sha256: row.accepted_sha256 }) });
    assert.equal(done.state, 'ALREADY_ACCEPTED', name);
    assert.equal(done.mutation, false, name);
    // The pre-apply bytes are no longer an accepted live state.
    await assert.rejects(
      run(inspect(name), { root: ROOT, inspectLive: liveFor(name, { sha256: BEFORE[name] }) }),
      (error) => error.code === CODES.SOURCE_RECONCILIATION_REQUIRED,
      name,
    );
  }
  assert.match(applied.notes, /run 40222963538/);
  assert.deepEqual(PLAN.order.slice(-2), [SEND, PROVIDERS]);
  assert.ok(localImports(fs.readFileSync(path.join(ROOT, 'aws/functions/api', SEND), 'utf8'), SEND).includes('providers/parity/caller.mjs'));
});

test('Payee sends: moov-send.mjs replaced the bytes production run 40222560555 applied; production run 40391523374 applied main\'s bytes', async () => {
  const APPLIED_REL = 'aws/tests/fixtures/production-onboarding-payee-send-applied-manifest-2026-10-26.json';
  const MANIFEST_REL = 'aws/tests/fixtures/production-payee-send-manifest-2026-10-26.json';
  const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  const manifest = readJson(MANIFEST_REL);
  const SEND = 'providers/production/moov-send.mjs';
  // The live bytes, from their recorded evidence: the staging sends applied manifest.
  const LIVE = readJson('aws/tests/fixtures/production-sandbox-send-applied-manifest-2026-10-25.json').members[SEND].accepted_sha256;
  const onMain = sha(`aws/functions/api/${SEND}`);
  assert.equal(manifest.workstream_id, 'production-payee-send');
  assert.equal(manifest.deploy_authorized, false);
  assert.match(manifest.authorization, /^Pending owner review \(2026-10-26\)/);
  assert.deepEqual(Object.keys(manifest.members), [SEND]);
  assert.match(PLAN.notes, /Payee sends \(2026-10-26, planning only, not authorized\)/);
  assert.notEqual(onMain, LIVE);
  assert.deepEqual(manifest.members[SEND], { live_sha256: LIVE, accepted_sha256: onMain, operation: 'replace' });
  // Applied 2026-10-26: the applied manifest chains to the planned one; the row expects main's bytes.
  const applied = readJson(APPLIED_REL);
  assert.deepEqual(applied.members[SEND], { live_sha256: onMain, accepted_sha256: onMain, operation: 'replace', previous_manifest: MANIFEST_REL });
  assert.match(applied.notes, /production apply run 40391523374/);
  assert.match(applied.notes, /staging apply run 40381567460/);
  const row = PLAN.members[SEND];
  assert.deepEqual(row, { operation: 'replace', accepted_sha256: onMain, expected_live_sha256: onMain, sql_before: null, manifest: APPLIED_REL });
  assert.equal(resolvePlannedMember(SEND, { root: ROOT, plan: PLAN }).ok, true);
  const inspect = { ...ENV, CHECKSOPS_PRODUCTION_DEPLOY_MODE: 'inspect', CHECKSOPS_PRODUCTION_OVERLAY_MEMBER: SEND };
  // The pre-apply bytes are no longer an accepted live state.
  await assert.rejects(run(inspect, { root: ROOT, inspectLive: liveFor(SEND, { sha256: LIVE }) }), (error) => error.code === CODES.SOURCE_RECONCILIATION_REQUIRED);
  const done = await run(inspect, { root: ROOT, inspectLive: liveFor(SEND, { sha256: onMain }) });
  assert.equal(done.state, 'ALREADY_ACCEPTED');
  assert.deepEqual(PLAN.order.slice(-2), [SEND, 'providers.mjs']);
});

test('Onboarding reconciliation: four live onboarding members replaced the bytes the 2026-10-21 rebuild put live; production runs applied main\'s bytes', async () => {
  const APPLIED_REL = 'aws/tests/fixtures/production-onboarding-payee-send-applied-manifest-2026-10-26.json';
  const APPLY_RUNS = { 'providers/onboarding/store.mjs': '40390899889', 'providers/onboarding/documents.mjs': '40391039339', 'providers/onboarding/moov-sync.mjs': '40391217210', 'providers/onboarding/handlers.mjs': '40391366018' };
  const MANIFEST_REL = 'aws/tests/fixtures/production-moov-onboarding-reconcile-manifest-2026-10-26.json';
  const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  const manifest = readJson(MANIFEST_REL);
  const RELEASE = readJson('aws/tests/fixtures/production-release-lock-pin-manifest-2026-10-17.json');
  // Read-only production inspect that observed each live member.
  const RUNS = {
    'providers/onboarding/store.mjs': '40384161502',
    'providers/onboarding/documents.mjs': '40382966241',
    'providers/onboarding/moov-sync.mjs': '40383433363',
    'providers/onboarding/handlers.mjs': '40383259853',
  };
  const NAMES = Object.keys(RUNS);
  assert.equal(manifest.workstream_id, 'production-moov-onboarding-reconcile');
  assert.equal(manifest.deploy_authorized, false);
  assert.match(manifest.authorization, /^Pending owner review \(2026-10-26\)/);
  assert.deepEqual(Object.keys(manifest.members), NAMES);
  assert.match(manifest.notes, /run 39669873076/);
  assert.match(PLAN.notes, /Onboarding reconciliation \(2026-10-26, planning only, not authorized\)/);
  const inspect = (name) => ({ ...ENV, CHECKSOPS_PRODUCTION_DEPLOY_MODE: 'inspect', CHECKSOPS_PRODUCTION_OVERLAY_MEMBER: name });
  for (const name of NAMES) {
    const onMain = sha(`aws/functions/api/${name}`);
    const row = PLAN.members[name];
    const entry = manifest.members[name];
    // The live bytes, from their recorded evidence: the 2026-10-17 release manifest's accepted bytes
    // (main's file at 008af40e2, which the 2026-10-21 rebuild deployed; observed by RUNS[name]).
    const live = RELEASE.members[name].accepted_sha256;
    assert.notEqual(onMain, live, name);
    assert.deepEqual(entry, { live_sha256: live, accepted_sha256: onMain, operation: 'replace', previous_manifest: entry.previous_manifest }, name);
    // The manifest that planned main's bytes still records them as accepted.
    assert.equal(readJson(entry.previous_manifest).members[name].accepted_sha256, onMain, name);
    // Applied 2026-10-26: the applied manifest chains to the planned one; the row expects main's bytes.
    assert.deepEqual(readJson(APPLIED_REL).members[name], { live_sha256: onMain, accepted_sha256: onMain, operation: 'replace', previous_manifest: MANIFEST_REL }, name);
    assert.match(readJson(APPLIED_REL).notes, new RegExp(`production apply run ${APPLY_RUNS[name]}`), name);
    assert.equal(row.operation, 'replace', name);
    assert.equal(row.accepted_sha256, onMain, name);
    assert.equal(row.expected_live_sha256, onMain, name);
    assert.equal(row.manifest, APPLIED_REL, name);
    assert.match(manifest.notes, new RegExp(`run ${RUNS[name]}`), name);
    assert.equal(resolvePlannedMember(name, { root: ROOT, plan: PLAN }).ok, true, name);
    // The pre-apply bytes are no longer an accepted live state.
    await assert.rejects(run(inspect(name), { root: ROOT, inspectLive: liveFor(name, { sha256: live }) }), (error) => error.code === CODES.SOURCE_RECONCILIATION_REQUIRED, name);
    const done = await run(inspect(name), { root: ROOT, inspectLive: liveFor(name, { sha256: onMain }) });
    assert.equal(done.state, 'ALREADY_ACCEPTED', name);
  }
  // Plan order: the four members in this order, before the send module and providers.mjs.
  const at = (name) => PLAN.order.indexOf(name);
  for (let i = 1; i < NAMES.length; i += 1) assert.ok(at(NAMES[i - 1]) < at(NAMES[i]), NAMES[i]);
  assert.ok(at(NAMES[NAMES.length - 1]) < at('providers/production/moov-send.mjs'));
  const applied = readJson(APPLIED_REL);
  assert.equal(applied.workstream_id, 'production-onboarding-payee-send-applied');
  assert.equal(applied.deploy_authorized, false);
  assert.match(applied.authorization, /^Record only \(2026-10-26\)/);
  assert.deepEqual(Object.keys(applied.members), [...NAMES, 'providers/production/moov-send.mjs']);
  assert.match(applied.notes, /SSM 8a72e2fc-c769-4ebf-9f00-64feb23d1df4/);
  assert.match(PLAN.notes, /Onboarding and payee sends applied 2026-10-26 on main 31a84414a/);
});

test('Tenant lifecycle: tenant-billing-handlers.mjs replaced the bytes production ran; production run 40425235000 applied main\'s bytes', async () => {
  const MANIFEST_REL = 'aws/tests/fixtures/production-tenant-lifecycle-manifest-2026-10-26.json';
  const APPLIED_REL = 'aws/tests/fixtures/production-tenant-lifecycle-applied-manifest-2026-10-27.json';
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, MANIFEST_REL), 'utf8'));
  const HANDLERS = 'tenant-billing-handlers.mjs';
  // The live bytes: the fee-collection pin's accepted bytes, which read-only production overlay
  // inspect run 40422339860 reported live (ALREADY_ACCEPTED).
  const fees = JSON.parse(fs.readFileSync(path.join(ROOT, 'aws/tests/fixtures/production-fee-collection-pin-manifest-2026-10-17.json'), 'utf8'));
  const LIVE = fees.members[HANDLERS].accepted_sha256;
  const onMain = sha(`aws/functions/api/${HANDLERS}`);
  assert.equal(manifest.workstream_id, 'production-tenant-lifecycle');
  assert.equal(manifest.deploy_authorized, false);
  assert.match(manifest.authorization, /^Pending owner review \(2026-10-26\)/);
  assert.match(manifest.notes, /run 40422339860/);
  assert.deepEqual(Object.keys(manifest.members), [HANDLERS]);
  assert.match(PLAN.notes, /Tenant lifecycle \(2026-10-26, planning only, not authorized\)/);
  assert.notEqual(onMain, LIVE);
  assert.deepEqual(manifest.members[HANDLERS], { live_sha256: LIVE, accepted_sha256: onMain, operation: 'replace' });
  // Not held for SQL 117: the new actions answer 'needs database update SQL 117' until it is applied.
  const SQL102 = 'aws/workflows/sql/102_platform_owner_tenant_profile.sql';
  // Applied 2026-10-27: the applied manifest chains to the planned one; the row expects main's bytes.
  const applied = JSON.parse(fs.readFileSync(path.join(ROOT, APPLIED_REL), 'utf8'));
  assert.equal(applied.workstream_id, 'production-tenant-lifecycle-applied');
  assert.equal(applied.deploy_authorized, false);
  assert.match(applied.authorization, /^Record only \(2026-10-27\)/);
  assert.deepEqual(applied.members[HANDLERS], { live_sha256: onMain, accepted_sha256: onMain, operation: 'replace', previous_manifest: MANIFEST_REL });
  for (const runId of ['40424663073', '40425119783', '40425235000', '40425379817']) assert.match(applied.notes, new RegExp(`run ${runId}`), runId);
  assert.match(applied.notes, /RevisionId 70379dc2-6a82-4deb-944a-3de6b2bda245/);
  assert.match(PLAN.notes, /Tenant lifecycle applied 2026-10-27 on main 89159a7e2/);
  assert.deepEqual(PLAN.members[HANDLERS], { operation: 'replace', accepted_sha256: onMain, expected_live_sha256: onMain, sql_before: SQL102, manifest: APPLIED_REL });
  assert.match(fs.readFileSync(path.join(API, HANDLERS), 'utf8'), /needs database update SQL 117/);
  assert.equal(resolvePlannedMember(HANDLERS, { root: ROOT, plan: PLAN }).ok, true);
  const inspect = { ...ENV, CHECKSOPS_PRODUCTION_DEPLOY_MODE: 'inspect', CHECKSOPS_PRODUCTION_OVERLAY_MEMBER: HANDLERS };
  // The pre-apply bytes are no longer an accepted live state.
  await assert.rejects(run(inspect, { root: ROOT, inspectLive: liveFor(HANDLERS, { sha256: LIVE }) }), (error) => error.code === CODES.SOURCE_RECONCILIATION_REQUIRED);
  const done = await run(inspect, { root: ROOT, inspectLive: liveFor(HANDLERS, { sha256: onMain }) });
  assert.equal(done.state, 'ALREADY_ACCEPTED');
});

test('Stakeholder settings edit: the three members record the bytes production runs 40189236116, 40189560481 and 40189657073 applied', () => {
  const PLANNED_REL = 'aws/tests/fixtures/production-stakeholder-settings-edit-manifest-2026-10-25.json';
  const APPLIED_REL = 'aws/tests/fixtures/production-stakeholder-settings-edit-applied-manifest-2026-10-25.json';
  const planned = JSON.parse(fs.readFileSync(path.join(ROOT, PLANNED_REL), 'utf8'));
  const applied = JSON.parse(fs.readFileSync(path.join(ROOT, APPLIED_REL), 'utf8'));
  // Staging acceptance, production preflight inspect and production apply, per member.
  const RUNS = {
    'write-allowlist.mjs': ['40187607327', '40189124128', '40189236116'],
    'write-app-metadata.mjs': ['40187714948', '40189305061', '40189560481'],
    'write-check-workflow.mjs': ['40187824410', '40189127903', '40189657073'],
  };
  assert.deepEqual(Object.keys(applied.members), Object.keys(RUNS));
  for (const [member, runs] of Object.entries(RUNS)) {
    const onMain = sha(`aws/functions/api/${member}`);
    const row = PLAN.members[member];
    // The plan row expects the applied bytes, which are main's bytes, and names the applied manifest.
    assert.equal(row.operation, 'replace', member);
    assert.equal(row.accepted_sha256, onMain, member);
    assert.equal(row.expected_live_sha256, onMain, member);
    assert.equal(row.manifest, APPLIED_REL, member);
    assert.deepEqual(applied.members[member], {
      live_sha256: onMain, accepted_sha256: onMain, operation: 'replace', previous_manifest: PLANNED_REL,
    }, member);
    // The planned manifest keeps the pre-apply state.
    assert.notEqual(planned.members[member].live_sha256, onMain, member);
    assert.equal(planned.members[member].accepted_sha256, onMain, member);
    for (const runId of runs) {
      assert.match(applied.notes, new RegExp(`run ${runId}`), `${member} ${runId}`);
      assert.match(PLAN.notes, new RegExp(runId), `${member} ${runId}`);
    }
  }
  assert.equal(applied.workstream_id, 'production-stakeholder-settings-edit-applied');
  assert.equal(applied.deploy_authorized, false);
  assert.match(applied.authorization, /^Record only/);
});

test('Production email to every recipient: email-policy.mjs records the bytes production run 40151123531 applied', () => {
  const MEMBER = 'email-policy.mjs';
  const PLANNED_REL = 'aws/tests/fixtures/production-email-any-recipient-manifest-2026-10-25.json';
  const APPLIED_REL = 'aws/tests/fixtures/production-email-any-recipient-applied-manifest-2026-10-25.json';
  const planned = JSON.parse(fs.readFileSync(path.join(ROOT, PLANNED_REL), 'utf8'));
  const applied = JSON.parse(fs.readFileSync(path.join(ROOT, APPLIED_REL), 'utf8'));
  const row = PLAN.members[MEMBER];
  const onMain = sha(`aws/functions/api/${MEMBER}`);
  // The plan row expects the applied bytes, which are main's bytes, and names the applied manifest.
  assert.equal(row.operation, 'replace');
  assert.equal(row.accepted_sha256, onMain);
  assert.equal(row.expected_live_sha256, onMain);
  assert.equal(row.manifest, APPLIED_REL);
  assert.deepEqual(applied.members[MEMBER], {
    live_sha256: onMain, accepted_sha256: onMain, operation: 'replace', previous_manifest: PLANNED_REL,
  });
  // The planned manifest keeps the pre-apply state: the bytes main had before #1230.
  assert.equal(planned.members[MEMBER].live_sha256, '83d73511e751130a939c2e92c0b995b45d5f9d3bdaa02d5ac04c5322a39fd3a6');
  assert.equal(planned.members[MEMBER].accepted_sha256, onMain);
  // Staging inspect and apply, production preflight inspect and apply.
  for (const runId of ['40150778782', '40150895108', '40151011646', '40151123531']) {
    assert.match(applied.notes, new RegExp(`run ${runId}`), runId);
  }
  for (const runId of ['40150895108', '40151011646', '40151123531']) assert.match(PLAN.notes, new RegExp(runId), runId);
  assert.equal(applied.workstream_id, 'production-email-any-recipient-applied');
  assert.equal(applied.deploy_authorized, false);
  assert.match(applied.authorization, /^Record only/);
});

test('Delete Check: workflow.mjs replaced the release 2026-10-17 bytes; production run 40530367414 applied main\'s bytes', async () => {
  const MEMBER = 'workflow.mjs';
  const MANIFEST_REL = 'aws/tests/fixtures/production-delete-check-shared-delete-manifest-2026-10-27.json';
  const APPLIED_REL = 'aws/tests/fixtures/production-delete-check-applied-manifest-2026-10-27.json';
  const RELEASE = 'aws/tests/fixtures/production-release-lock-pin-manifest-2026-10-17.json';
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, MANIFEST_REL), 'utf8'));
  const applied = JSON.parse(fs.readFileSync(path.join(ROOT, APPLIED_REL), 'utf8'));
  const release = JSON.parse(fs.readFileSync(path.join(ROOT, RELEASE), 'utf8'));
  const STALE = 'ecd6f716d6a2203a05446afd24eb1bf9e5849e70e49a0ee86bde708fd36c1968';
  const BEFORE = '753ae14a0d04ded5782c653bd67c308067311f4fcebf835c0aac4e6659188138';
  const LIVE = 'c7159c4d9a74342f2a0f59a2836def78376c84d2781bbeb56dbb35ba83ed9337';
  // Reconcile (#1296): inspect run 40528072440 found the release 2026-10-17 bytes live, not the stale pre-apply ones.
  assert.match(PLAN.notes, /inspect run 40528072440/);
  assert.match(manifest.notes, /inspect run 40528072440/);
  assert.deepEqual([release.members[MEMBER].live_sha256, release.members[MEMBER].accepted_sha256], [STALE, BEFORE]);
  assert.equal(manifest.deploy_authorized, false);
  assert.deepEqual(manifest.members[MEMBER], { live_sha256: BEFORE, accepted_sha256: LIVE, operation: 'replace', previous_manifest: RELEASE });
  // Applied 2026-10-27: staging apply 40526348308, pre-apply inspect 40530101746, apply 40530367414, inspect 40530792383.
  for (const runId of ['40526348308', '40530101746', '40530367414', '40530792383']) {
    assert.match(PLAN.notes, new RegExp(runId), runId);
    assert.match(applied.notes, new RegExp(runId), runId);
  }
  assert.equal(applied.workstream_id, 'production-delete-check-applied');
  assert.equal(applied.deploy_authorized, false);
  assert.deepEqual(applied.members[MEMBER], { live_sha256: LIVE, accepted_sha256: LIVE, operation: 'replace', previous_manifest: MANIFEST_REL });
  const row = PLAN.members[MEMBER];
  assert.equal(row.operation, 'replace');
  assert.equal(row.manifest, APPLIED_REL);
  assert.equal(row.expected_live_sha256, LIVE);
  assert.equal(row.accepted_sha256, LIVE);
  assert.equal(sha(`aws/functions/api/${MEMBER}`), LIVE);
  assert.equal(resolvePlannedMember(MEMBER, { root: ROOT, plan: PLAN }).ok, true);
  const inspect = { ...ENV, CHECKSOPS_PRODUCTION_DEPLOY_MODE: 'inspect', CHECKSOPS_PRODUCTION_OVERLAY_MEMBER: MEMBER };
  const done = await run(inspect, { root: ROOT, inspectLive: liveFor(MEMBER, { sha256: LIVE }) });
  assert.equal(done.state, 'ALREADY_ACCEPTED');
  assert.equal(done.mutation, false);
  await assert.rejects(
    run(inspect, { root: ROOT, inspectLive: liveFor(MEMBER, { sha256: BEFORE }) }),
    (error) => error.code === CODES.SOURCE_RECONCILIATION_REQUIRED,
  );
});

test('Planned ADDs already live: tenant-management-v2.mjs and webhook-status.mjs replaced the bytes inspect runs 40574248610 and 40574427787 found; production runs 40576842354 and 40577212139 applied them', async () => {
  for (const [member, before, accepted, inspectRun, applyRun, manifestRel, appliedRel] of [
    ['tenant-management-v2.mjs', 'b4596d1078b9acb64d333eb2f241713ec42c5a3a2188eda69c5654fad8485835', '64539881783add1157d186e8504b86831ce4e6151a7b00c0ee8a892839735cb9', '40574248610', '40576842354', 'aws/tests/fixtures/production-tenant-management-v2-provider-status-manifest-2026-10-27.json', 'aws/tests/fixtures/production-tenant-management-v2-provider-status-applied-manifest-2026-10-27.json'],
    ['providers/onboarding/webhook-status.mjs', '45ac151c468ade3ed161ddd279545ffd58dd4b7dbe52f6769137f8fc51b4237f', '2f9570fa00d92898c1c4d656bede432def7ad02a05a8c428d50d7ff34ec917e7', '40574427787', '40577212139', 'aws/tests/fixtures/production-moov-webhook-verification-read-manifest-2026-10-27.json', 'aws/tests/fixtures/production-moov-webhook-verification-read-applied-manifest-2026-10-27.json'],
  ]) {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, manifestRel), 'utf8'));
    const applied = JSON.parse(fs.readFileSync(path.join(ROOT, appliedRel), 'utf8'));
    assert.match(PLAN.notes, /inspect runs 40574248610 and 40574427787/);
    assert.match(PLAN.notes, new RegExp(`production apply run ${applyRun} VERIFIED`), member);
    assert.match(manifest.notes, new RegExp(`inspect run ${inspectRun}`), member);
    assert.equal(manifest.deploy_authorized, false, member);
    assert.deepEqual(manifest.members[member], { live_sha256: before, accepted_sha256: accepted, operation: 'replace' }, member);
    assert.match(applied.authorization, /^Record only/, member);
    assert.equal(applied.deploy_authorized, false, member);
    assert.match(applied.notes, new RegExp(`apply run ${applyRun}`), member);
    assert.deepEqual(applied.members[member], { live_sha256: accepted, accepted_sha256: accepted, operation: 'replace', previous_manifest: manifestRel }, member);
    const row = PLAN.members[member];
    assert.equal(row.operation, 'replace', member);
    assert.equal(row.expected_live_sha256, accepted, member);
    assert.equal(row.accepted_sha256, accepted, member);
    assert.equal(row.manifest, appliedRel, member);
    assert.equal(sha(`aws/functions/api/${member}`), accepted, member);
    const inspect = { ...ENV, CHECKSOPS_PRODUCTION_DEPLOY_MODE: 'inspect', CHECKSOPS_PRODUCTION_OVERLAY_MEMBER: member };
    const done = await run(inspect, { root: ROOT, inspectLive: liveFor(member, { sha256: accepted }) });
    assert.equal(done.state, 'ALREADY_ACCEPTED', member);
    assert.equal(done.mutation, false, member);
    // The pre-apply bytes are no longer an accepted live state.
    await assert.rejects(run(inspect, { root: ROOT, inspectLive: liveFor(member, { sha256: before }) }), member);
  }
});
