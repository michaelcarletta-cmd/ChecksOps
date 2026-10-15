/**
 * Member-level comparison for the production Lambda source reconciliation.
 * Pins live production bytes from inspect 37812416526 / CodeSha256
 * DMcCoF3dpIiULPe530F8DJ8vC1wL1BP7ayqr+e8SCyI= and asserts only the
 * accepted Review-to-Endorsing, Claim Ledger, OCR/MICR, Manual Deposit,
 * and Delete Check patches were applied.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const API = path.join(ROOT, 'aws/functions/api');
const FIXTURE = path.join(ROOT, 'aws/tests/fixtures/production-lambda-reconciliation-2026-10-08.json');
const MANIFEST = path.join(ROOT, 'aws/tests/fixtures/production-reconciliation-deployment-manifest-2026-10-08.json');

const read = (name) => fs.readFileSync(path.join(API, name), 'utf8');
const sha256 = (name) => createHash('sha256').update(fs.readFileSync(path.join(API, name))).digest('hex');
const fileSha = (rel) => createHash('sha256').update(fs.readFileSync(path.join(ROOT, rel))).digest('hex');

const PLAN_PATH = path.join(ROOT, 'ops/deployment-guard/production-api-overlay-plan.json');

const proof = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const plan = JSON.parse(fs.readFileSync(PLAN_PATH, 'utf8'));

/**
 * A member whose production overlay plan entry names a newer manifest is
 * governed by that manifest: its bytes have moved on from the 2026-10-08
 * reconciliation by design. Returns that manifest's row for the member, or null.
 */
const newerManifestRow = (name) => {
  const rel = plan.members?.[name]?.manifest;
  if (!rel) return null;
  const newer = JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  assert.ok(newer.members?.[name], `${rel} must list ${name}`);
  return newer.members[name];
};

/** Chain check: the newer manifest replaces exactly the reconciled bytes. */
const assertChainsFromReconciled = (name, row) => {
  // A second change to a member names the manifest it builds on: its live bytes
  // are that manifest's accepted bytes, which in turn chain back to 2026-10-08.
  if (row.previous_manifest) {
    const previous = JSON.parse(fs.readFileSync(path.join(ROOT, row.previous_manifest), 'utf8')).members?.[name];
    assert.ok(previous, `${row.previous_manifest} must list ${name}`);
    assert.equal(row.live_sha256, previous.accepted_sha256, `${name} live_sha256 must equal ${row.previous_manifest} accepted bytes`);
    assertChainsFromReconciled(name, previous);
    return;
  }
  assert.equal(row.live_sha256, proof.members[name].reconciled_sha256, `${name} newer manifest live_sha256 must equal the 2026-10-08 reconciled bytes`);
};

test('proof pins the official live production Lambda identity', () => {
  assert.equal(proof.function_name, 'checksops-production-prep-api');
  assert.equal(proof.code_sha256, 'DMcCoF3dpIiULPe530F8DJ8vC1wL1BP7ayqr+e8SCyI=');
  assert.equal(proof.revision_id, 'fb17cb70-7b50-468d-a0a6-59a020c43f8c');
  assert.equal(proof.inspect_run, 37812416526);
});

test('reconciled members match the pinned SHA-256 values', () => {
  for (const [name, row] of Object.entries(proof.members)) {
    const newer = name === 'ocr.mjs' ? null : newerManifestRow(name);
    if (newer) {
      assertChainsFromReconciled(name, newer);
      continue;
    }
    const expected = name === 'ocr.mjs' ? row.repo_sha256 : row.reconciled_sha256;
    assert.equal(sha256(name), expected, name);
  }
});

test('workflow.mjs keeps production-only Delete Check and applies claim-linked #762', () => {
  const src = read('workflow.mjs');
  assert.match(src, /DeleteObjectsCommand/);
  assert.match(src, /export const handleDeleteCheck = async/);
  assert.doesNotMatch(src, /workflow-delete-check\.mjs/);
  assert.match(src, /const roleAllowed = looked\.check\.claim_id/);
  assert.match(src, /claim_id IS NOT DISTINCT FROM \$6::uuid/);
  assert.match(src, /tenant_id IS NOT DISTINCT FROM \$8::uuid/);
  assert.match(src, /status IS NOT DISTINCT FROM \$7::text/);
  assert.doesNotMatch(src, /AND claim_id IS NULL\n\s+AND deposited_at IS NULL/);
  assert.match(src, /no longer matches its expected state/);
  assert.match(src, /application_workflow_writes_disabled/);
  assert.match(src, /AWS_APPLICATION_WORKFLOW_WRITES_ENABLED/);
});

test('workflow-transitions.mjs removes only the claim-linked deny', () => {
  const src = read('workflow-transitions.mjs');
  assert.doesNotMatch(src, /claim_linked_transition_denied/);
  assert.match(src, /partner_linked_transition_denied/);
  assert.match(src, /financial_or_provider/);
  assert.equal(sha256('workflow-transitions.mjs'), proof.members['workflow-transitions.mjs'].reconciled_sha256);
});

test('workflow-rpc.mjs keeps production settlement writer and adds mark_manual_deposit', () => {
  const src = read('workflow-rpc.mjs');
  assert.match(src, /admin_set_check_claim/);
  assert.match(src, /write-claim-settlement\.mjs/);
  assert.match(src, /SAVE_CLAIM_SETTLEMENT_BREAKDOWN/);
  assert.match(src, /mark_manual_deposit/);
  assert.match(src, /requireDepositManagerForTenant/);
  assert.match(src, /provider = 'manual_branch'/);
  assert.match(src, /provider_execution: false/);
  assert.match(src, /SAFE_DEPOSIT_ACTIONS = new Set\(\[[\s\S]*'mark_manual_deposit'/);
  assert.doesNotMatch(src, /claim_settlements/);
});

test('data.mjs early-routes settlement RPC before the generic write path', () => {
  const src = read('data.mjs');
  const settlement = src.indexOf("earlyName === 'save_claim_settlement_breakdown'");
  const partner = src.indexOf('PARTNER_SHARE_RPCS');
  const safe = src.indexOf('SAFE_WRITE_RPCS.has(earlyName)');
  assert.ok(settlement > 0);
  assert.ok(settlement < partner);
  assert.ok(partner < safe);
  assert.match(src, /claim-settlement-rpc\.mjs/);
});

test('ocr.mjs is not rewritten; live bytes stay KEEP and payee-lock deps remain live', () => {
  const src = read('ocr.mjs');
  assert.equal(sha256('ocr.mjs'), proof.members['ocr.mjs'].repo_sha256);
  assert.equal(proof.members['ocr.mjs'].live_sha256, 'ecd3b253c111921ee62f21bab214bd346ab19819a9c764cdef33b07524c6221f');
  assert.equal(proof.members['ocr.mjs'].overlay, 'keep_live');
  assert.doesNotMatch(src, /check-deposited\.mjs/);
  assert.match(src, /persistOcrDescriptiveHandoff/);
  assert.match(src, /parsed\.micr_routing_state === 'VERIFIED' \? parsed\.routing_number : null/);
  assert.equal(sha256('check-deposited.mjs'), '395ddec5c88e2290fc72f2ab86ef2c934fe7654c7f2309a8176e1147ce32edf1');
  assert.equal(sha256('financial-remaining.mjs'), 'e608c00f65623bfc226eecd7d216d64141e610f2a2c1b0cb841f9736d5397989');
  const remaining = read('financial-remaining.mjs');
  assert.match(remaining, /export const MONEY_IN_OPERATION_TYPES = new Set\(\['checkalt_deposit'\]\)/);
  assert.match(remaining, /export const CONFIRMED_MONEY_STATUSES/);
  assert.doesNotMatch(remaining, /AWS_FINANCIAL_WRITES_ENABLED/);
  const deposited = read('check-deposited.mjs');
  assert.match(deposited, /resolveWritablePayeeLine/);
  assert.match(deposited, /financial-remaining\.mjs/);
});

test('write-claim-settlement.mjs stays on live production bytes', () => {
  assert.equal(sha256('write-claim-settlement.mjs'), 'ce53b3683504081fb6ab3f52559a4c6fcad8856cadd078bbf635359f2cc8779d');
  const src = read('write-claim-settlement.mjs');
  assert.match(src, /export const executeClaimSettlementBreakdownWrite/);
  assert.match(src, /must not be added to AWS_WRITE_TABLES/);
  assert.match(src, /FOR UPDATE/);
  assert.doesNotMatch(src, /save_claim_settlement_breakdown\(/);
});

test('added members are the accepted claim-settlement and extracted delete modules', () => {
  const settlement = read('claim-settlement-rpc.mjs');
  assert.match(settlement, /save_claim_settlement_breakdown/);
  assert.match(settlement, /applicationWorkflowWritesEnabled/);
  assert.match(settlement, /application_workflow_writes_disabled/);
  assert.equal(sha256('claim-settlement-rpc.mjs'), proof.members['claim-settlement-rpc.mjs'].reconciled_sha256);
  const del = read('workflow-delete-check.mjs');
  assert.match(del, /Only admins can delete checks/);
  assert.match(del, /FINANCIAL_DELETE_BLOCKERS|partner|deposited/);
});

test('deployment manifest pins live hashes, accepted hashes, and SQL order', () => {
  assert.equal(manifest.deploy_authorized, false);
  assert.equal(manifest.sql_apply_authorized, false);
  assert.equal(manifest.live_lambda.code_sha256, proof.code_sha256);
  assert.equal(manifest.live_lambda.revision_id, proof.revision_id);
  assert.deepEqual(manifest.do_not_overlay, ['ocr.mjs']);
  assert.deepEqual(manifest.do_not_overlay_until_sql, ['workflow-transitions.mjs']);
  assert.equal(manifest.members['claim-settlement-rpc.mjs'].required, true);
  assert.equal(manifest.members['claim-settlement-rpc.mjs'].operation, 'add');
  assert.ok(!manifest.overlay_sequence_when_authorized.includes('ocr.mjs'));
  assert.ok(!manifest.overlay_sequence_when_authorized.includes('workflow-transitions.mjs'));

  for (const [name, row] of Object.entries(manifest.members)) {
    assert.equal(row.accepted_sha256, proof.members[name].reconciled_sha256, name);
    assert.equal(row.live_sha256, proof.members[name].live_sha256, name);
    if (name === 'ocr.mjs') {
      assert.equal(sha256(name), row.repo_sha256);
      continue;
    }
    const newer = newerManifestRow(name);
    if (newer) {
      assertChainsFromReconciled(name, newer);
      continue;
    }
    assert.equal(sha256(name), row.accepted_sha256, name);
  }

  const sqlOrder = manifest.sql_order.map((row) => row.order);
  assert.deepEqual(sqlOrder, [1, 2, 3]);
  for (const row of manifest.sql_order) {
    assert.equal(fileSha(row.path), row.sha256, row.path);
  }
  assert.equal(manifest.members['claim-settlement-rpc.mjs'].sql_before, manifest.sql_order[1].path);
  assert.equal(manifest.members['workflow-transitions.mjs'].sql_before, manifest.sql_order[2].path);
});

test('required member imports resolve without staging-503 files', () => {
  const forbidden = [
    'db-readonly-validate.mjs',
    'db-validator-access.mjs',
    'github-staging-lambda-overlay.mjs',
  ];
  for (const [name, row] of Object.entries(manifest.members)) {
    const src = fs.existsSync(path.join(API, name)) ? read(name) : '';
    for (const spec of row.required_imports || []) {
      assert.match(src, new RegExp(spec.replace('.', '\\.')), `${name} imports ${spec}`);
      assert.equal(fs.existsSync(path.join(API, spec)), true, spec);
    }
    for (const blocked of forbidden) {
      assert.doesNotMatch(src, new RegExp(blocked.replace('.', '\\.')), `${name} must not import ${blocked}`);
    }
  }
  assert.equal(fs.existsSync(path.join(API, 'claim-settlement-rpc.mjs')), true);
  assert.match(read('data.mjs'), /claim-settlement-rpc\.mjs/);
  assert.match(read('workflow-rpc.mjs'), /write-claim-settlement\.mjs/);
  assert.doesNotMatch(read('workflow.mjs'), /workflow-delete-check\.mjs/);
});

test('overlay sequence adds new members before any member that imports them', () => {
  const sequence = manifest.overlay_sequence_when_authorized;
  const added = new Set(Object.entries(manifest.members)
    .filter(([, row]) => row.live_sha256 === null)
    .map(([name]) => name));
  for (const [idx, name] of sequence.entries()) {
    const specs = [...read(name).matchAll(/(?:from\s+|import\(\s*)['"]\.\/([^'"]+\.mjs)['"]/g)].map((m) => m[1]);
    for (const spec of specs.filter((s) => added.has(s))) {
      const at = sequence.indexOf(spec);
      assert.ok(at !== -1 && at < idx, `${name} imports ${spec}, which is absent live and must be overlaid first`);
    }
  }
  assert.ok(sequence.indexOf('claim-settlement-rpc.mjs') < sequence.indexOf('data.mjs'));
  assert.equal(manifest.members['data.mjs'].sql_before, manifest.sql_order[1].path);
});
