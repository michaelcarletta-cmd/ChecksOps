import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  MIGRATIONS,
  MODES,
  candidateMembers,
  reportReadLive,
  run,
} from '../../scripts/deployment-guard/github-staging-sql-executor.mjs';
import {
  READ_LIVE_EXPECTED_SENTINEL,
  checkReceiptActionBinding,
  readLiveSummary,
} from '../../scripts/deployment-guard/lib/sql-executor-read-live.mjs';
import { loadContractRegistry } from '../../scripts/deployment-guard/lib/contracts.mjs';
import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import { validateReceipt } from '../../scripts/deployment-guard/lib/receipt.mjs';
import {
  AUTHORIZED_LEDGER_20261007193200 as PIN,
  AUTHORIZED_SQL76_PARTNERSHIP_CONSENT as SQL76_PIN,
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
  assert.deepEqual(Object.keys(MIGRATIONS), ['ledger-20261007193200', 'sql71-review-amount-grant', 'sql72-member-payment-writes', 'sql76-tenant-partnership-consent', 'sql77-check-stakeholders-grant', 'sql78-check-partner-stakeholder-removals', 'sql79-member-stakeholder-writes', 'sql80-checkalt-member-auto-deposit', 'sql81-checkalt-depositor-register', 'sql82-homeowner-ledger-view', 'sql83-homeowner-signing-capabilities', 'sql84-mortgage-return-to-queue', 'sql85-mortgage-compensation-adjust', 'sql86-mortgage-compensation-owner-only', 'sql87-resolve-check-case-tenant-scope', 'sql88-claim-id-assign-case-tenant-scope', 'sql89-check-intake-column-update', 'sql29-mortgage-ops-library-parity', 'sql30-tenant-documents-doc-type', 'sql90-users-only-tenant-roles', 'sql91-moov-onboarding', 'sql92-signature-request-check-files-link-grant', 'sql93-tenant-company-info', 'sql94-document-library-restore', 'sql95-remove-freedom-claims-bridge', 'sql96-platform-owner-tenant-pricing', 'sql97-financial-stepup-log-server-writer', 'sql98-tenant-fee-collection', 'sql99-mortgage-desk-completion-messages', 'sql100-mortgage-desk-live-access', 'sql101-invite-identity-insert-order', 'sql102-platform-owner-tenant-profile', 'sql103-share-library-trigger-acl', 'sql104-payment-idempotency-keys-grant', 'sql105-onboarding-payment-table-grants', 'sql107-moov-transfer-webhook-status']);
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

/** Run the official invoke script against a fake Lambda; returns { code, invoked, output }. */
async function invokeOfficially(root, receiptFile, inputFile, commit, lambda) {
  const { main } = await import('../../scripts/deployment-guard/sql-executor-invoke.mjs');
  const saved = { ...process.env };
  process.env.CHECKSOPS_DEPLOYMENT_GUARD_ROOT = root;
  process.env.CHECKSOPS_DEPLOYMENT_GUARD_APPLY = '1';
  process.env.CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT = receiptFile;
  const invoked = [];
  const writes = [];
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
  let code;
  try {
    code = main([
      '--input', inputFile,
      '--receipt', receiptFile,
      '--workstream-id', 'github-staging-sql-9876',
      '--commit', commit,
    ], process.env, (name, payload) => {
      invoked.push({ name, payload });
      return lambda(payload);
    });
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
    process.env = saved;
  }
  return { code, invoked, output: writes.join('') };
}

const SQL76_INSPECT_RECEIPT = Object.freeze({
  workstream: 'github-staging-sql-9876',
  commit: SQL76_PIN.commit,
  sql_file: SQL76_PIN.filename,
  before_hash: '1'.repeat(64),
  after_hash: '1'.repeat(64),
  result: 'inspect',
  executor_identity: 'checksops-staging-guarded-sql-executor',
  table_present: true,
  connect_function_present: true,
  required_functions_present: true,
  consent_state: {
    guard: 'absent', trigger: 'absent', marker: 'unset', connect: 'pinned', other_triggers: 'none',
    policies: { 'Inviter can create partnerships': 'present', 'Admins can view any partnership': 'absent' },
  },
  other_policy_count: 2,
  other_trigger_count: 0,
  preserved_sha256: '2'.repeat(64),
  live_definition_sha256: '1'.repeat(64),
  pin_executable: false,
  apply_preconditions_met: false,
});

test('read-live is a mode; it refuses a stale executor, unknown migrations and any expected live hash', async (t) => {
  assert.deepEqual([...MODES], ['inspect', 'deploy', 'apply', 'read-live']);
  const root = tempRoot(t);
  const neverSign = () => { throw new Error('must not sign'); };
  const stale = liveZip({ 'index.mjs': OLD_INDEX });
  const { createHash } = await import('node:crypto');
  const oldSha = createHash('sha256').update(OLD_INDEX).digest('hex');
  const base = { ...BASE_ENV, CHECKSOPS_SQL_EXECUTOR_MODE: 'read-live', CHECKSOPS_SQL_EXECUTOR_MIGRATION: 'sql76-tenant-partnership-consent' };
  await assert.rejects(run(base, {
    root, aws: fakeAws(stale), historyOf: () => new Set([oldSha]), contractRunner: () => true, signer: neverSign,
  }), (error) => error.code === CODES.STALE_PACKAGE);
  await assert.rejects(run({ ...base, CHECKSOPS_SQL_EXECUTOR_MIGRATION: '76_tenant_partnership_invitee_consent' }, {
    root, aws: fakeAws(liveZip()), historyOf: () => new Set(), contractRunner: () => true, signer: neverSign,
  }), (error) => error.code === CODES.SQL_COLLISION);
  await assert.rejects(run({ ...base, CHECKSOPS_EXPECTED_LIVE_DEFINITION_SHA256: '1'.repeat(64) }, {
    root, aws: fakeAws(liveZip()), historyOf: () => new Set(), contractRunner: () => true, signer: neverSign,
  }), (error) => error.code === CODES.INVALID_MANIFEST);
  // An optional inspected CodeSha256 must still be live.
  await assert.rejects(run({ ...base, CHECKSOPS_EXPECTED_EXECUTOR_CODE_SHA256: `${'B'.repeat(43)}=` }, {
    root, aws: fakeAws(liveZip()), historyOf: () => new Set(), contractRunner: () => true, signer: neverSign,
  }), (error) => error.code === CODES.DEPLOYMENT_COLLISION);
  // A failing accepted contract still blocks the receipt.
  await assert.rejects(run(base, {
    root, aws: fakeAws(liveZip()), historyOf: () => new Set(), contractRunner: () => false, signer: (u) => u,
  }));
  assert.equal(fs.existsSync(path.join(root, '.deployment-guard/receipts')), false);
});

for (const [migration, pin] of [['sql76-tenant-partnership-consent', SQL76_PIN], ['ledger-20261007193200', PIN]]) {
  test(`read-live (${migration}, pinned expected ${pin.expected_live_definition_sha256 ? 'set' : 'null'}) issues an inspect-bound receipt and never sends apply`, async (t) => {
    const root = tempRoot(t);
    const current = liveZip();
    const result = await run({
      ...BASE_ENV,
      CHECKSOPS_SQL_EXECUTOR_MODE: 'read-live',
      CHECKSOPS_SQL_EXECUTOR_MIGRATION: migration,
      CHECKSOPS_BUILD_TIMESTAMP: '2026-10-14T13:00:00Z',
    }, {
      root, aws: fakeAws(current), historyOf: () => new Set(), contractRunner: () => true, signer: (unsigned) => unsigned,
    });
    assert.equal(result.invoke_action, 'inspect');
    assert.equal(result.mutation, false);
    const input = JSON.parse(fs.readFileSync(result.authorization.inputFile, 'utf8'));
    assert.equal(input.action, 'inspect');
    assert.equal(input.expected_live_definition_sha256, READ_LIVE_EXPECTED_SENTINEL);
    assert.notEqual(input.expected_live_definition_sha256, pin.expected_live_definition_sha256);
    assert.equal(input.one_use_id, 'github-staging-sql-9876-1-read-live');
    assert.equal(input.commit, pin.commit);
    const receipt = JSON.parse(fs.readFileSync(result.authorization.receiptFile, 'utf8'));
    assert.equal(receipt.preflight_live_fingerprint.action, 'inspect');
    assert.equal(receipt.preflight_live_fingerprint.sql, READ_LIVE_EXPECTED_SENTINEL);

    const accepted = await invokeOfficially(root, result.authorization.receiptFile, result.authorization.inputFile, pin.commit, () => ({
      ok: true, details: { receipt: { ...SQL76_INSPECT_RECEIPT, commit: pin.commit } },
    }));
    assert.equal(accepted.code, 0, accepted.output);
    assert.equal(accepted.invoked.length, 1);
    assert.equal(accepted.invoked[0].payload.action, 'inspect');
    assert.equal(accepted.invoked[0].payload.expected_live_definition_sha256, READ_LIVE_EXPECTED_SENTINEL);

    // The same signed receipt cannot authorize an apply: relabel the input, keep the fingerprint.
    const tampered = path.join(root, 'tampered-input.json');
    fs.writeFileSync(tampered, JSON.stringify({ ...input, action: 'apply' }));
    const refused = await invokeOfficially(root, result.authorization.receiptFile, tampered, pin.commit, () => {
      throw new Error('lambda must not be invoked');
    });
    assert.notEqual(refused.code, 0);
    assert.equal(refused.invoked.length, 0);
    assert.match(refused.output, /RECEIPT_MISMATCH/);
    assert.match(refused.output, /bound to executor action inspect/);

    // Dropping the action from the input's fingerprint no longer matches the signed receipt,
    // and the sentinel still refuses apply.
    const stripped = path.join(root, 'stripped-input.json');
    const { action: _dropped, ...fingerprint } = input.preflight_live_fingerprint;
    fs.writeFileSync(stripped, JSON.stringify({ ...input, action: 'apply', preflight_live_fingerprint: fingerprint }));
    let exitCode;
    const exit = process.exit;
    process.exit = (value) => { exitCode = value; throw new Error('exit'); };
    let stale;
    try {
      stale = await invokeOfficially(root, result.authorization.receiptFile, stripped, pin.commit, () => {
        throw new Error('lambda must not be invoked');
      }).catch((error) => ({ error }));
    } finally {
      process.exit = exit;
    }
    // The guard exits 2 (DEPLOYMENT_COLLISION: stale fingerprint) before any Lambda invoke.
    assert.ok(stale.error);
    assert.equal(exitCode, 2);
  });
}

test('receipt action binding: an inspect-bound receipt or a sentinel package never authorizes apply', () => {
  const inspectReceipt = { preflight_live_fingerprint: { sql: READ_LIVE_EXPECTED_SENTINEL, action: 'inspect' } };
  assert.equal(checkReceiptActionBinding(inspectReceipt, { action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL }).ok, true);
  assert.equal(checkReceiptActionBinding(inspectReceipt, { action: 'apply' }).code, CODES.RECEIPT_MISMATCH);
  assert.equal(checkReceiptActionBinding(inspectReceipt, { action: 'verify_data' }).code, CODES.RECEIPT_MISMATCH);
  // Even an unbound (apply-style) receipt cannot carry the read-live sentinel into apply.
  assert.equal(checkReceiptActionBinding({ preflight_live_fingerprint: {} }, {
    action: 'apply', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL,
  }).code, CODES.RECEIPT_MISMATCH);
  // Existing apply receipts are unaffected.
  assert.equal(checkReceiptActionBinding({ preflight_live_fingerprint: { sql: PIN.expected_live_definition_sha256 } }, {
    action: 'apply', expected_live_definition_sha256: PIN.expected_live_definition_sha256,
  }).ok, true);
  assert.ok(!AUTHORIZED_STAGING_SQL.some((pin) => [pin.expected_live_definition_sha256, pin.intended_replacement_sha256].includes(READ_LIVE_EXPECTED_SENTINEL)));
});

test('every selectable pin refuses apply with the read-live sentinel before connecting', async () => {
  const { importGuardedSqlExecutor } = await import('./helpers/import-guarded-sql-executor.mjs');
  const { authorizationFingerprint } = await import('../../scripts/deployment-guard/lib/sql-executor-auth.mjs');
  const { module } = await importGuardedSqlExecutor();
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `read-live-sentinel-${process.pid}.json`);
  const file = (pin) => path.join(REPO_ROOT, pin.filename);
  const handler = module.createHandler({
    connect: async () => { throw new Error('should-not-connect'); },
    now: () => Date.parse('2026-10-14T13:00:00Z'),
    sqlFileLedger: file(MIGRATIONS['ledger-20261007193200']),
    sqlFile71: file(MIGRATIONS['sql71-review-amount-grant']),
    sqlFile72: file(MIGRATIONS['sql72-member-payment-writes']),
    sqlFile76: file(MIGRATIONS['sql76-tenant-partnership-consent']),
    sqlFile77: file(MIGRATIONS['sql77-check-stakeholders-grant']),
    sqlFile78: file(MIGRATIONS['sql78-check-partner-stakeholder-removals']),
    sqlFile79: file(MIGRATIONS['sql79-member-stakeholder-writes']),
    sqlFile80: file(MIGRATIONS['sql80-checkalt-member-auto-deposit']),
    sqlFile81: file(MIGRATIONS['sql81-checkalt-depositor-register']),
    sqlFile82: file(MIGRATIONS['sql82-homeowner-ledger-view']),
    sqlFile83: file(MIGRATIONS['sql83-homeowner-signing-capabilities']),
    sqlFile84: file(MIGRATIONS['sql84-mortgage-return-to-queue']),
    sqlFile85: file(MIGRATIONS['sql85-mortgage-compensation-adjust']),
    sqlFile86: file(MIGRATIONS['sql86-mortgage-compensation-owner-only']),
    sqlFile87: file(MIGRATIONS['sql87-resolve-check-case-tenant-scope']),
    sqlFile88: file(MIGRATIONS['sql88-claim-id-assign-case-tenant-scope']),
    sqlFile89: file(MIGRATIONS['sql89-check-intake-column-update']),
    sqlFile29: file(MIGRATIONS['sql29-mortgage-ops-library-parity']),
    sqlFile30: file(MIGRATIONS['sql30-tenant-documents-doc-type']),
    // SQL 90-107, by migration key.
    releaseSqlFiles: Object.fromEntries(Object.values(MIGRATIONS).filter((pin) => /^sql(9[0-9]|10[0-7])$/.test(String(pin.key))).map((pin) => [pin.key, file(pin)])),
  });
  for (const [key, pin] of Object.entries(MIGRATIONS)) {
    const event = {
      action: 'apply',
      workstream_id: 'github-staging-sql-9876',
      branch: 'main',
      commit: pin.commit,
      operator: 'test-agent',
      target_environment: 'staging',
      target_component: 'staging-sql',
      deployment_type: 'sql-executor-invoke',
      owned_components: [pin.filename],
      filename: pin.filename,
      migration_id: pin.migration_id,
      source_sha256: pin.source_sha256,
      intended_replacement_sha256: pin.intended_replacement_sha256,
      expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL,
      one_use_id: 'github-staging-sql-9876-1-read-live',
      expiry: '2026-10-14T13:15:00Z',
      function_name: 'checksops-staging-guarded-sql-executor',
      build_timestamp: '2026-10-14T13:00:00Z',
    };
    event.preflight_live_fingerprint = { ...authorizationFingerprint(event), action: 'inspect' };
    const refused = await handler(event);
    assert.equal(refused.ok, false, key);
    assert.equal(refused.code, CODES.SQL_COLLISION, `${key}: ${refused.message}`);
    // Refused by the pin binding itself (not a missing file or a hash mismatch).
    assert.match(String(refused.message), /apply is bound to the exact allowlisted pin|no reviewed pre-apply live definition hash/, key);
  }
});

test('read-live report prints only non-sensitive fields and a LIVE_DEFINITION_SHA256 line', (t) => {
  const root = tempRoot(t);
  const out = path.join(root, 'invoke.json');
  const err = path.join(root, 'invoke.err');
  const summaryFile = path.join(root, 'summary.md');
  fs.writeFileSync(out, JSON.stringify({
    ok: true,
    details: { ok: true, details: { authorization: { allowlist_entry: { filename: SQL76_PIN.filename } }, receipt: SQL76_INSPECT_RECEIPT } },
  }));
  const writes = [];
  const env = { CHECKSOPS_SQL_EXECUTOR_MIGRATION: 'sql76-tenant-partnership-consent', GITHUB_STEP_SUMMARY: summaryFile };
  const details = reportReadLive(out, err, env, (text) => writes.push(text));
  assert.deepEqual(Object.keys(details).sort(), [
    'already_applied', 'apply_preconditions_met', 'connect_function_present', 'consent_state', 'intended_replacement_sha256',
    'live_definition_sha256', 'matches_pinned_expected', 'migration', 'migration_id', 'other_policy_count', 'other_trigger_count',
    'pin_executable', 'pinned_expected_live_definition_sha256', 'required_functions_present', 'result', 'table_present',
  ]);
  assert.equal(details.migration_id, SQL76_PIN.migration_id);
  assert.equal(details.intended_replacement_sha256, SQL76_PIN.intended_replacement_sha256);
  assert.equal(details.pinned_expected_live_definition_sha256, SQL76_PIN.expected_live_definition_sha256);
  assert.equal(details.pinned_expected_live_definition_sha256, '7c5276d8d04973c51f28238ec32091d77b01613c79dc8961d4dbc4bfd92d20d8');
  // The fixture's live hash ('1' x 64) is not the reviewed pin.
  assert.equal(details.matches_pinned_expected, false);
  assert.equal(details.live_definition_sha256, '1'.repeat(64));
  assert.equal(details.consent_state.policies['Inviter can create partnerships'], 'present');
  const text = writes.join('');
  assert.match(text, new RegExp(`^LIVE_DEFINITION_SHA256: ${'1'.repeat(64)}$`, 'm'));
  for (const hidden of ['github-staging-sql-9876', 'checksops-staging-guarded-sql-executor', 'workstream', 'operator', 'allowlist_entry', '2'.repeat(64)]) {
    assert.ok(!text.includes(hidden), hidden);
  }
  const md = fs.readFileSync(summaryFile, 'utf8');
  assert.match(md, /read-live \(inspect only, no writes\)/);
  assert.match(md, /live_definition_sha256: `1{64}`/);
  assert.ok(!md.includes('github-staging-sql-9876'));

  // Labels that are not short lowercase words are masked.
  const odd = readLiveSummary({ ok: true, details: { ok: true, details: { receipt: {
    ...SQL76_INSPECT_RECEIPT, consent_state: { guard: 'CREATE POLICY x USING (true)' },
  } } } }, { migration: 'sql76-tenant-partnership-consent', pin: SQL76_PIN });
  assert.equal(odd.details.consent_state.guard, 'unrecognized');

  // A live hash equal to the committed pin is reported as matching it.
  const matching = readLiveSummary({ ok: true, details: { ok: true, details: { receipt: {
    ...SQL76_INSPECT_RECEIPT,
    before_hash: SQL76_PIN.expected_live_definition_sha256,
    after_hash: SQL76_PIN.expected_live_definition_sha256,
    live_definition_sha256: SQL76_PIN.expected_live_definition_sha256,
  } } } }, { migration: 'sql76-tenant-partnership-consent', pin: SQL76_PIN });
  assert.equal(matching.ok, true);
  assert.equal(matching.details.matches_pinned_expected, true);
  assert.equal(matching.details.pinned_expected_live_definition_sha256, SQL76_PIN.expected_live_definition_sha256);

  // Anything but an inspect result, or a failure, fails with only code and message.
  fs.writeFileSync(out, JSON.stringify({ ok: true, details: { ok: true, details: { receipt: { ...SQL76_INSPECT_RECEIPT, result: 'applied' } } } }));
  assert.throws(() => reportReadLive(out, err, env, () => {}), (error) => error.code === CODES.UNRELATED_MUTATION);
  fs.writeFileSync(out, '');
  fs.writeFileSync(err, JSON.stringify({ ok: false, code: 'RECEIPT_MISMATCH', message: 'bound', details: { receipt_action: 'inspect' } }));
  assert.throws(() => reportReadLive(out, err, env, () => {}), (error) => error.code === 'RECEIPT_MISMATCH' && Object.keys(error.details || {}).length === 0);
  assert.throws(() => reportReadLive(out, err, { CHECKSOPS_SQL_EXECUTOR_MIGRATION: 'nope' }, () => {}), (error) => error.code === CODES.SQL_COLLISION);

  // Executor and driver error text is never echoed: only the code and a fixed message.
  const leaky = readLiveSummary({ ok: false, code: 'DEPLOYMENT_COLLISION', message: 'no pg_hba.conf entry for host "10.0.3.17", user "checksops_admin", database "checksops"' },
    { migration: 'sql76-tenant-partnership-consent', pin: SQL76_PIN });
  assert.equal(leaky.ok, false);
  assert.equal(leaky.code, 'DEPLOYMENT_COLLISION');
  for (const hidden of ['10.0.3.17', 'checksops_admin', 'pg_hba']) assert.ok(!leaky.message.includes(hidden), hidden);
  const oddCode = readLiveSummary({ ok: false, code: 'select * from x', message: 'boom' }, { migration: 'sql76-tenant-partnership-consent', pin: SQL76_PIN });
  assert.equal(oddCode.code, CODES.DEPLOYMENT_COLLISION);

  // A result for another file or commit cannot be reported as this pin's live hash.
  for (const other of [{ sql_file: 'aws/workflows/sql/44_other.sql' }, { commit: 'f'.repeat(40) }, { sql_file: undefined }]) {
    const wrong = readLiveSummary({ ok: true, details: { ok: true, details: { receipt: { ...SQL76_INSPECT_RECEIPT, ...other } } } },
      { migration: 'sql76-tenant-partnership-consent', pin: SQL76_PIN });
    assert.equal(wrong.ok, false, JSON.stringify(other));
    assert.equal(wrong.code, CODES.UNRELATED_MUTATION);
  }
});

test('workflow read-live mode can only read, sign, and invoke action inspect', () => {
  assert.match(workflow, /- read-live\n/);
  assert.match(workflow, /inspect\|deploy\|apply\|read-live\) ;;/);
  assert.match(workflow, /read-live does not accept expected_live_definition_sha256/);
  const policy = JSON.parse(workflow.match(/\(read-live\)\n[\s\S]*?inline-session-policy: >-\n\s*(\{.*\})/)[1]);
  assert.deepEqual(policy.Statement.flatMap((row) => row.Action).sort(), [
    'kms:GetPublicKey', 'kms:Sign', 'lambda:GetFunction', 'lambda:GetFunctionConfiguration', 'lambda:InvokeFunction',
  ]);
  // ensure/deploy and apply steps never run in read-live.
  const steps = workflow.split(/\n      - name: /).slice(1);
  const step = (name) => steps.find((row) => row.startsWith(name));
  assert.match(step("Deploy main's executor"), /if: \$\{\{ inputs\.mode == 'deploy' \}\}/);
  assert.match(step('Configure executor deploy session'), /if: \$\{\{ inputs\.mode == 'deploy' \}\}/);
  assert.match(step('Apply through'), /if: \$\{\{ inputs\.mode == 'apply' \}\}/);
  const readStep = step('Read live state');
  assert.match(readStep, /if: \$\{\{ inputs\.mode == 'read-live' \}\}/);
  assert.match(readStep, /test "\$INVOKE_ACTION" = "inspect"/);
  assert.match(readStep, /sql-executor-invoke\.mjs/);
  assert.match(readStep, /--read-live-report invoke\.json invoke\.err/);
  assert.doesNotMatch(readStep, /sql-executor-ensure|cat invoke|EXPECTED_LIVE_DEFINITION/);
  assert.match(step('Cleanup'), /invoke\.err/);
  // Every step that can change executor code or configuration is gated to deploy only.
  for (const row of steps.filter((text) => /UpdateFunction|sql-executor-ensure/.test(text))) {
    assert.match(row, /if: \$\{\{ inputs\.mode == 'deploy' \}\}/);
  }
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
