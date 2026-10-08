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

const read = (name) => fs.readFileSync(path.join(API, name), 'utf8');
const sha256 = (name) => createHash('sha256').update(fs.readFileSync(path.join(API, name))).digest('hex');

const proof = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

test('proof pins the official live production Lambda identity', () => {
  assert.equal(proof.function_name, 'checksops-production-prep-api');
  assert.equal(proof.code_sha256, 'DMcCoF3dpIiULPe530F8DJ8vC1wL1BP7ayqr+e8SCyI=');
  assert.equal(proof.revision_id, 'fb17cb70-7b50-468d-a0a6-59a020c43f8c');
  assert.equal(proof.inspect_run, 37812416526);
});

test('reconciled members match the pinned SHA-256 values', () => {
  for (const [name, row] of Object.entries(proof.members)) {
    assert.equal(sha256(name), row.reconciled_sha256, name);
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

test('ocr.mjs stays on live production bytes including deposited payee lock', () => {
  const src = read('ocr.mjs');
  assert.equal(sha256('ocr.mjs'), 'ecd3b253c111921ee62f21bab214bd346ab19819a9c764cdef33b07524c6221f');
  assert.match(src, /resolveWritablePayeeLine/);
  assert.match(src, /check-deposited\.mjs/);
  assert.match(src, /parsed\.micr_routing_state === 'VERIFIED' \? parsed\.routing_number : null/);
  assert.match(src, /routing_number = CASE/);
  assert.match(src, /account_number = CASE/);
  assert.equal(sha256('check-deposited.mjs'), '395ddec5c88e2290fc72f2ab86ef2c934fe7654c7f2309a8176e1147ce32edf1');
  assert.equal(sha256('financial-remaining.mjs'), 'e608c00f65623bfc226eecd7d216d64141e610f2a2c1b0cb841f9736d5397989');
  const remaining = read('financial-remaining.mjs');
  assert.match(remaining, /export const MONEY_IN_OPERATION_TYPES = new Set\(\['checkalt_deposit'\]\)/);
  assert.match(remaining, /export const CONFIRMED_MONEY_STATUSES/);
  assert.doesNotMatch(remaining, /AWS_FINANCIAL_WRITES_ENABLED/);
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
  const del = read('workflow-delete-check.mjs');
  assert.match(del, /Only admins can delete checks/);
  assert.match(del, /FINANCIAL_DELETE_BLOCKERS|partner|deposited/);
});
