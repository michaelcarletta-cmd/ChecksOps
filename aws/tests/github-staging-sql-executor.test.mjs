import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  MIGRATIONS,
  candidateMembers,
  run,
} from '../../scripts/deployment-guard/github-staging-sql-executor.mjs';
import { loadContractRegistry } from '../../scripts/deployment-guard/lib/contracts.mjs';
import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import { validateReceipt } from '../../scripts/deployment-guard/lib/receipt.mjs';
import {
  AUTHORIZED_LEDGER_20261007193200 as PIN,
  AUTHORIZED_STAGING_SQL,
} from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import {
  environmentMatches,
  lambdaCodeSha256,
  reconcileExecutorMembers,
} from '../../scripts/deployment-guard/lib/sql-executor-inventory.mjs';
import { writeZipMembers } from '../../scripts/deployment-guard/lib/zip-members.mjs';
import { EXECUTOR_PACK_MEMBERS, executorEnvironment } from '../../scripts/deployment-guard/sql-executor-ensure.mjs';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const SHA = 'b'.repeat(40);
const BASE_ENV = {
  GITHUB_SHA: SHA,
  GITHUB_REF_NAME: 'main',
  GITHUB_ACTOR: 'michaelcarletta-cmd',
  GITHUB_RUN_ID: '9876',
  GITHUB_RUN_ATTEMPT: '1',
  CHECKSOPS_SQL_EXECUTOR_MIGRATION: 'ledger-20261007193200',
};
const workflow = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
const registry = loadContractRegistry(REPO_ROOT);
const LIVE_ENV = executorEnvironment({
  Environment: {
    Variables: {
      ADMIN_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:806168576068:secret:rds-db-credentials/checksops-staging/checksops_admin/1788286368527-Kv5tBt',
      RDS_HOST: 'checksops-staging.cyr0q4kcop3c.us-east-1.rds.amazonaws.com',
      SECRETS_MANAGER_ENDPOINT: 'https://vpce-example.secretsmanager.us-east-1.vpce.amazonaws.com',
    },
  },
});

function repoMembers() {
  const members = {};
  for (const [from, to] of EXECUTOR_PACK_MEMBERS) members[to] = fs.readFileSync(path.join(REPO_ROOT, from));
  return members;
}

// A live executor zip; npm-installed members are ignored by the inventory.
function liveZip(overrides = {}, drop = []) {
  const members = { ...repoMembers(), 'node_modules/pg/package.json': Buffer.from('{"version":"8.23.0"}'), 'package-lock.json': Buffer.from('{}') };
  for (const name of drop) delete members[name];
  Object.assign(members, overrides);
  return writeZipMembers(members);
}

function fakeAws(zip, { env = LIVE_ENV, reportedSha } = {}) {
  const codeSha = lambdaCodeSha256(zip);
  return {
    calls: [],
    getConfig(name) {
      this.calls.push(name);
      if (name === 'checksops-staging-guarded-sql-executor') {
        return { CodeSha256: codeSha, RevisionId: 'rev-1', LastModified: '2026-10-09T17:47:48.000+0000', Environment: env };
      }
      if (name === 'checksops-staging-rehearsal-oneshot') {
        return { Environment: { Variables: { ...LIVE_ENV.Variables, PROD_ADMIN_SECRET_ARN: 'not-copied' } } };
      }
      throw new Error(`unexpected function ${name}`);
    },
    async getCodeZip() {
      return { zip, codeSha256: reportedSha || codeSha };
    },
  };
}

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-staging-sql-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const OLD_INDEX = Buffer.from('// executor as deployed for SQL 53\n');
// main's history holds some other index.mjs, never OLD_INDEX.
const historyWithoutOldIndex = () => new Set(['0'.repeat(64)]);

test('inventory classifies same, superseded, added, dropped and foreign members', () => {
  const sourceOf = { 'index.mjs': 'aws/write-path/guarded-sql-executor/index.mjs' };
  const history = new Set(['old']);
  const ok = reconcileExecutorMembers({
    live: { 'index.mjs': 'old', 'lib/a.mjs': 'x' },
    candidate: { 'index.mjs': 'new', 'lib/a.mjs': 'x', 'sql/new.sql': 'y' },
    sourceOf,
    historyOf: () => history,
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.details.superseded, ['index.mjs']);
  assert.deepEqual(ok.details.added, ['sql/new.sql']);
  assert.equal(ok.details.current, false);

  const foreign = reconcileExecutorMembers({
    live: { 'index.mjs': 'someone-else' },
    candidate: { 'index.mjs': 'new' },
    sourceOf,
    historyOf: () => history,
  });
  assert.equal(foreign.code, CODES.DEPLOYMENT_COLLISION);

  const dropped = reconcileExecutorMembers({ live: { 'lib/gone.mjs': 'z' }, candidate: {}, historyOf: () => history });
  assert.equal(dropped.code, CODES.SOURCE_RECONCILIATION_REQUIRED);

  const current = reconcileExecutorMembers({ live: { a: '1' }, candidate: { a: '1' } });
  assert.equal(current.details.current, true);
});

test('environment check refuses any changed executor variable', () => {
  assert.equal(environmentMatches(LIVE_ENV, LIVE_ENV).ok, true);
  const changed = environmentMatches(
    { Variables: { ...LIVE_ENV.Variables, RDS_HOST: 'other' } },
    LIVE_ENV,
  );
  assert.equal(changed.code, CODES.DEPLOYMENT_COLLISION);
  assert.deepEqual(changed.details.differing_keys, ['RDS_HOST']);
});

test('only reviewed pins are selectable and candidate members mirror the ensure pack list', () => {
  assert.deepEqual(Object.keys(MIGRATIONS), ['ledger-20261007193200', 'sql71-review-amount-grant']);
  assert.ok(Object.values(MIGRATIONS).every((pin) => AUTHORIZED_STAGING_SQL.includes(pin)));
  const { members, sourceOf } = candidateMembers(REPO_ROOT);
  assert.deepEqual(Object.keys(members).sort(), EXECUTOR_PACK_MEMBERS.map(([, to]) => to).sort());
  assert.equal(sourceOf['sql/20261007193200_skip_claim_ledger_event_for_endorsement_stage.sql'], PIN.filename);
});

test('inspect reports a current executor and never signs', async (t) => {
  const result = await run({ ...BASE_ENV, CHECKSOPS_SQL_EXECUTOR_MODE: 'inspect' }, {
    root: tempRoot(t),
    aws: fakeAws(liveZip()),
    historyOf: () => new Set(),
    signer: () => { throw new Error('inspect must not sign'); },
  });
  assert.equal(result.inventory.current, true);
  assert.equal(result.mutation, false);
});

test('inspect fails closed on unknown migrations, non-main refs, and a racing code change', async (t) => {
  const root = tempRoot(t);
  await assert.rejects(run({ ...BASE_ENV, CHECKSOPS_SQL_EXECUTOR_MODE: 'inspect', CHECKSOPS_SQL_EXECUTOR_MIGRATION: 'arbitrary' }, {
    root, aws: fakeAws(liveZip()),
  }), (error) => error.code === CODES.SQL_COLLISION);
  await assert.rejects(run({ ...BASE_ENV, GITHUB_REF_NAME: 'feature', CHECKSOPS_SQL_EXECUTOR_MODE: 'inspect' }, {
    root, aws: fakeAws(liveZip()),
  }), (error) => error.code === CODES.UNRELATED_MUTATION);
  await assert.rejects(run({ ...BASE_ENV, CHECKSOPS_SQL_EXECUTOR_MODE: 'inspect' }, {
    root, aws: fakeAws(liveZip(), { reportedSha: `${'A'.repeat(43)}=` }), historyOf: () => new Set(),
  }), (error) => error.code === CODES.DEPLOYMENT_COLLISION);
});

test('deploy is allowed only when every live member is equal or superseded by main', async (t) => {
  const root = tempRoot(t);
  const stale = liveZip({ 'index.mjs': OLD_INDEX }, ['sql/20261007193200_skip_claim_ledger_event_for_endorsement_stage.sql']);
  const { createHash } = await import('node:crypto');
  const oldSha = createHash('sha256').update(OLD_INDEX).digest('hex');
  const aws = fakeAws(stale);
  const allowed = await run({
    ...BASE_ENV,
    CHECKSOPS_SQL_EXECUTOR_MODE: 'deploy',
    CHECKSOPS_EXPECTED_EXECUTOR_CODE_SHA256: lambdaCodeSha256(stale),
  }, { root, aws, historyOf: () => new Set([oldSha]) });
  assert.equal(allowed.deploy_allowed, true);
  assert.deepEqual(allowed.inventory.superseded, ['index.mjs']);
  assert.deepEqual(allowed.inventory.added, ['sql/20261007193200_skip_claim_ledger_event_for_endorsement_stage.sql']);

  // live code another workstream wrote (not on main's history) is never overwritten
  await assert.rejects(run({
    ...BASE_ENV,
    CHECKSOPS_SQL_EXECUTOR_MODE: 'deploy',
    CHECKSOPS_EXPECTED_EXECUTOR_CODE_SHA256: lambdaCodeSha256(stale),
  }, { root, aws: fakeAws(stale), historyOf: historyWithoutOldIndex }), (error) => error.code === CODES.DEPLOYMENT_COLLISION);

  // a live-only member would be dropped
  const extra = liveZip({ 'lib/live-only.mjs': Buffer.from('x') });
  await assert.rejects(run({
    ...BASE_ENV,
    CHECKSOPS_SQL_EXECUTOR_MODE: 'deploy',
    CHECKSOPS_EXPECTED_EXECUTOR_CODE_SHA256: lambdaCodeSha256(extra),
  }, { root, aws: fakeAws(extra), historyOf: () => new Set() }), (error) => error.code === CODES.SOURCE_RECONCILIATION_REQUIRED);

  // the inspected CodeSha256 must still be live
  await assert.rejects(run({
    ...BASE_ENV,
    CHECKSOPS_SQL_EXECUTOR_MODE: 'deploy',
    CHECKSOPS_EXPECTED_EXECUTOR_CODE_SHA256: `${'B'.repeat(43)}=`,
  }, { root, aws: fakeAws(stale), historyOf: () => new Set([oldSha]) }), (error) => error.code === CODES.DEPLOYMENT_COLLISION);

  // deploy would change the executor environment
  await assert.rejects(run({
    ...BASE_ENV,
    CHECKSOPS_SQL_EXECUTOR_MODE: 'deploy',
    CHECKSOPS_EXPECTED_EXECUTOR_CODE_SHA256: lambdaCodeSha256(stale),
  }, {
    root,
    aws: fakeAws(stale, { env: { Variables: { ...LIVE_ENV.Variables, RDS_HOST: 'drifted' } } }),
    historyOf: () => new Set([oldSha]),
  }), (error) => error.code === CODES.DEPLOYMENT_COLLISION);

  // nothing to deploy when the live executor already matches main
  const current = liveZip();
  await assert.rejects(run({
    ...BASE_ENV,
    CHECKSOPS_SQL_EXECUTOR_MODE: 'deploy',
    CHECKSOPS_EXPECTED_EXECUTOR_CODE_SHA256: lambdaCodeSha256(current),
  }, { root, aws: fakeAws(current), historyOf: () => new Set() }), (error) => error.code === CODES.STALE_PACKAGE);
});

test('apply refuses a stale executor and an unpinned live definition', async (t) => {
  const root = tempRoot(t);
  const stale = liveZip({ 'index.mjs': OLD_INDEX });
  const { createHash } = await import('node:crypto');
  const oldSha = createHash('sha256').update(OLD_INDEX).digest('hex');
  await assert.rejects(run({
    ...BASE_ENV,
    CHECKSOPS_SQL_EXECUTOR_MODE: 'apply',
    CHECKSOPS_EXPECTED_EXECUTOR_CODE_SHA256: lambdaCodeSha256(stale),
    CHECKSOPS_EXPECTED_LIVE_DEFINITION_SHA256: PIN.expected_live_definition_sha256,
  }, { root, aws: fakeAws(stale), historyOf: () => new Set([oldSha]), contractRunner: () => true, signer: (u) => u }),
  (error) => error.code === CODES.STALE_PACKAGE);

  const current = liveZip();
  await assert.rejects(run({
    ...BASE_ENV,
    CHECKSOPS_SQL_EXECUTOR_MODE: 'apply',
    CHECKSOPS_EXPECTED_EXECUTOR_CODE_SHA256: lambdaCodeSha256(current),
    CHECKSOPS_EXPECTED_LIVE_DEFINITION_SHA256: PIN.intended_replacement_sha256,
  }, { root, aws: fakeAws(current), historyOf: () => new Set(), contractRunner: () => true, signer: (u) => u }),
  (error) => error.code === CODES.DEPLOYMENT_COLLISION);
  assert.equal(fs.existsSync(path.join(root, '.deployment-guard/receipts')), false);

  await assert.rejects(run({
    ...BASE_ENV,
    CHECKSOPS_SQL_EXECUTOR_MODE: 'apply',
    CHECKSOPS_EXPECTED_EXECUTOR_CODE_SHA256: lambdaCodeSha256(current),
    CHECKSOPS_EXPECTED_LIVE_DEFINITION_SHA256: PIN.expected_live_definition_sha256,
  }, { root, aws: fakeAws(current), historyOf: () => new Set(), contractRunner: (file) => !file.includes('claim-ledger'), signer: (u) => u }));
  assert.equal(fs.existsSync(path.join(root, '.deployment-guard/receipts')), false);
});

test('apply issues one staging-sql receipt that the official invoke script accepts', async (t) => {
  const root = tempRoot(t);
  const current = liveZip();
  const result = await run({
    ...BASE_ENV,
    CHECKSOPS_SQL_EXECUTOR_MODE: 'apply',
    CHECKSOPS_EXPECTED_EXECUTOR_CODE_SHA256: lambdaCodeSha256(current),
    CHECKSOPS_EXPECTED_LIVE_DEFINITION_SHA256: PIN.expected_live_definition_sha256,
    CHECKSOPS_BUILD_TIMESTAMP: '2026-10-12T13:00:00Z',
  }, {
    root,
    aws: fakeAws(current),
    historyOf: () => new Set(),
    contractRunner: () => true,
    // Offline test signer only; the workflow signs with the staging KMS key.
    signer: (unsigned) => unsigned,
  });
  const receipt = JSON.parse(fs.readFileSync(result.authorization.receiptFile, 'utf8'));
  assert.equal(receipt.target_environment, 'staging');
  assert.equal(receipt.target_component, 'staging-sql');
  assert.equal(receipt.deployment_type, 'sql-executor-invoke');
  assert.equal(receipt.commit, PIN.commit);
  assert.equal(receipt.workstream_id, 'github-staging-sql-9876');
  assert.deepEqual(receipt.owned_components, [PIN.filename]);
  assert.equal(validateReceipt(receipt, {
    workstream_id: 'github-staging-sql-9876',
    commit: PIN.commit,
    target_environment: 'staging',
    target_component: 'staging-sql',
    deployment_type: 'sql-executor-invoke',
  }, { root }).ok, true);

  // Hand the receipt and input to the official invoke script with a fake Lambda.
  const { main } = await import('../../scripts/deployment-guard/sql-executor-invoke.mjs');
  const saved = { ...process.env };
  process.env.CHECKSOPS_DEPLOYMENT_GUARD_ROOT = root;
  process.env.CHECKSOPS_DEPLOYMENT_GUARD_APPLY = '1';
  // The workflow sets the receipt env as well as --receipt; the guard requires the env.
  process.env.CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT = result.authorization.receiptFile;
  const invoked = [];
  let code;
  try {
    code = main([
      '--input', result.authorization.inputFile,
      '--receipt', result.authorization.receiptFile,
      '--workstream-id', 'github-staging-sql-9876',
      '--commit', PIN.commit,
    ], process.env, (name, payload) => {
      invoked.push({ name, payload });
      return { ok: true, details: { receipt: { result: 'applied' } } };
    });
  } finally {
    process.env = saved;
  }
  assert.equal(code, 0);
  assert.equal(invoked.length, 1);
  assert.equal(invoked[0].name, 'checksops-staging-guarded-sql-executor');
  const payload = invoked[0].payload;
  assert.equal(payload.action, 'apply');
  assert.equal(payload.filename, PIN.filename);
  assert.equal(payload.expected_live_definition_sha256, PIN.expected_live_definition_sha256);
  assert.equal(payload.intended_replacement_sha256, PIN.intended_replacement_sha256);
  assert.equal(payload.one_use_id, 'github-staging-sql-9876-1');
  assert.equal(payload.target_environment, 'staging');
  assert.equal(payload.sql_text, undefined);
});

test('workflow is main-only, staging-only, narrows each mode, and uses the official writers', () => {
  assert.match(workflow, /environment: staging/);
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /test "\$GITHUB_REF" = "refs\/heads\/main"/);
  assert.match(workflow, /approved commit does not match workflow SHA/);
  assert.match(workflow, /role\/ChecksOpsGitHubStagingSqlExecutor/);
  assert.match(workflow, /node scripts\/deployment-guard\/sql-executor-ensure\.mjs/);
  assert.match(workflow, /node scripts\/deployment-guard\/sql-executor-invoke\.mjs/);
  assert.match(workflow, /CHECKSOPS_REQUIRE_EXECUTOR_CURRENT: "1"/);
  assert.doesNotMatch(workflow, /production/);
  assert.doesNotMatch(workflow, /CHECKSOPS_DEPLOYMENT_GUARD_BYPASS|CHECKSOPS_SKIP_DEPLOYMENT_GUARD|sql_text/);
  // inspect never gets write or invoke actions
  const inspectPolicy = workflow.match(/\(inspect\)[\s\S]*?inline-session-policy: >-\n\s*(\{.*\})/)[1];
  assert.deepEqual(JSON.parse(inspectPolicy).Statement.flatMap((row) => row.Action).sort(), [
    'lambda:GetFunction', 'lambda:GetFunctionConfiguration',
  ]);
  // deploy cannot invoke, apply cannot update code
  const deployPolicy = workflow.match(/\(deploy\)[\s\S]*?inline-session-policy: >-\n\s*(\{.*\})/)[1];
  assert.ok(!deployPolicy.includes('InvokeFunction') && !deployPolicy.includes('kms:'));
  const applyPolicy = workflow.match(/\(apply\)[\s\S]*?inline-session-policy: >-\n\s*(\{.*\})/)[1];
  assert.ok(!applyPolicy.includes('UpdateFunction'));
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
});

test('IAM role is staging-environment only and scoped to the executor and guard key', () => {
  const policy = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'aws/staging-sql-executor/policies/permissions-policy.json'), 'utf8'));
  const trust = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'aws/staging-sql-executor/policies/trust-policy.json'), 'utf8'));
  assert.equal(
    trust.Statement[0].Condition.StringEquals['token.actions.githubusercontent.com:sub'],
    'repo:michaelcarletta-cmd/ChecksOps:environment:staging',
  );
  for (const row of policy.Statement) {
    const actions = [].concat(row.Action);
    const resources = [].concat(row.Resource);
    for (const resource of resources) assert.doesNotMatch(resource, /production|\*/);
    if (actions.some((a) => a.startsWith('lambda:Update') || a === 'lambda:InvokeFunction')) {
      assert.deepEqual(resources, ['arn:aws:lambda:us-east-1:806168576068:function:checksops-staging-guarded-sql-executor']);
    }
    if (actions.includes('kms:Sign')) {
      assert.equal(row.Condition.StringEquals['kms:SigningAlgorithm'], 'ECDSA_SHA_256');
    }
  }
  assert.ok(!policy.Statement.some((row) => [].concat(row.Action).some((a) => a.startsWith('iam:'))));
});
