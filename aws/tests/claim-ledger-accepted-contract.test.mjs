/**
 * #539 accepted-contract gate for Claim Ledger discovery/grouping.
 * Source and evidence only. Does not deploy, mutate staging, or change SQL 44.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { INTAKE_PROHIBITED_COLUMNS, WRITE_ALLOWLIST } from '../functions/api/write-allowlist.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const sha256 = (rel) => createHash('sha256').update(read(rel), 'utf8').digest('hex');

const EVIDENCE_REL = 'ops/deployment-guard/claim-ledger-accepted-695064-gq.json';
const SQL44_REL = 'aws/write-path/sql/44_claim_ledger_link_or_create.sql';
const REQUIRED_INVARIANTS = [
  'existing real ledger discovery',
  'same-tenant OCR/detected-number discovery',
  'OCR remains discovery evidence, not ownership',
  'one ledger for multiple same-tenant unlinked checks',
  'all eligible unlinked siblings associate with that ledger',
  'already-linked checks never move',
  'foreign-tenant checks never associate',
  'duplicate/race protection',
  'linked claim-number Save remains update-only',
  'generic claims INSERT remains denied',
  'generic claim_id UPDATE remains denied',
  'financial/check state remains untouched',
];

function loadEvidence() {
  return JSON.parse(read(EVIDENCE_REL));
}

function loadContract() {
  const registry = JSON.parse(read('ops/deployment-guard/accepted-contracts.json'));
  return (registry.contracts || []).find((row) => row.id === 'claim-ledger');
}

test('accepted 695064-GQ evidence remains the Claim Ledger contract pin', () => {
  const evidence = loadEvidence();
  assert.equal(evidence.accepted, true);
  assert.equal(evidence.environment, 'staging');
  assert.equal(evidence.production_changed, false);
  assert.equal(evidence.claim_number, '695064-GQ');
  assert.equal(evidence.tenant_id, '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a');
  assert.equal(evidence.created_claim_id, '398df4b8-f23a-476f-b856-ff864a4148b8');
  assert.equal(evidence.behavior.same_tenant_checks_discovered, 4);
  assert.equal(evidence.behavior.public_claims_rows_created, 1);
  assert.equal(evidence.behavior.previously_unlinked_checks_linked, 4);
  assert.equal(evidence.behavior.duplicate_ledger, false);
  assert.equal(evidence.behavior.foreign_tenant_links, false);
  assert.equal(evidence.behavior.financial_or_provider_state_changed, false);
  assert.equal(evidence.staging_fingerprints.spa_entry, '/assets/index-Bax7aYr9.js');
  assert.equal(evidence.staging_fingerprints.api_lambda_sha256, 'OzfDx3keAu695zQ8d29AfE6nizJo88Ju4UBy3uNaoKI=');
  assert.equal(
    evidence.staging_fingerprints.sql44_definition_sha256,
    '96d038c97a85bc3e49346442862c044e1e16ec1eb062519b4ad277bd998063a5',
  );
  assert.equal(evidence.checks.length, 4);
  assert.ok(evidence.checks.every((row) => row.claim_id_before === null));
  assert.ok(evidence.checks.every((row) => row.claim_id_after === evidence.created_claim_id));
  for (const invariant of REQUIRED_INVARIANTS) {
    assert.ok(evidence.invariants.includes(invariant), invariant);
  }
});

test('#539 claim-ledger registry entry is complete enough for future deploys', () => {
  const contract = loadContract();
  const evidence = loadEvidence();
  assert.ok(contract, 'claim-ledger contract missing');
  assert.equal(contract.accepted, true);
  assert.equal(contract.enabled, true);
  assert.equal(contract.test, 'aws/tests/claim-ledger-accepted-contract.test.mjs');
  assert.equal(contract.evidence, EVIDENCE_REL);
  for (const type of ['spa-promote', 'lambda-overlay', 'sql-apply', 'sql-executor-invoke']) {
    assert.ok(contract.deployment_types.includes(type), type);
  }
  for (const invariant of REQUIRED_INVARIANTS) {
    assert.ok(contract.invariants.includes(invariant), invariant);
  }
  assert.deepEqual(contract.invariants.filter((row) => evidence.invariants.includes(row)).sort(), [...REQUIRED_INVARIANTS].sort());
  for (const rel of contract.tests || []) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), rel);
  }
  assert.ok((contract.tests || []).includes('aws/tests/claim-ledger-link-or-create-rpc.test.mjs'));
});

test('accepted SQL 44 source is unchanged and still groups same-tenant OCR siblings', () => {
  const evidence = loadEvidence();
  assert.equal(sha256(SQL44_REL), evidence.source_pins.sql44_source_sha256);
  const sql = read(SQL44_REL);
  assert.match(sql, /same_tenant_detected_count/);
  assert.match(sql, /same_tenant_unlinked_count/);
  assert.match(sql, /same_tenant_already_linked_count/);
  assert.match(sql, /detected_claim_number is NOT ownership evidence/);
  assert.match(sql, /ocr_claim_number_key\(s\.detected_claim_number\) = v_key/);
  assert.match(sql, /Existing claim_id is never rewritten/);
  assert.match(sql, /AND s\.claim_id IS NULL/);
  assert.match(sql, /AND i\.claim_id IS NULL/);
  assert.match(sql, /s\.tenant_id IS NOT DISTINCT FROM p_tenant_id/);
  assert.match(sql, /i\.tenant_id IS NOT DISTINCT FROM p_tenant_id/);
  assert.match(sql, /unique_violation/);
  assert.match(sql, /FOR UPDATE OF s SKIP LOCKED/);
  assert.match(sql, /existing_found/);
  assert.match(sql, /INSERT INTO public\.claims \(claim_number, status, org_id\)/);
  assert.doesNotMatch(sql, /ev\.detected_claim_number/);
  assert.doesNotMatch(sql, /deposited_at\s*=/);
  assert.doesNotMatch(sql, /SET[\s\S]*amount\s*=/);
  assert.doesNotMatch(sql, /SET[\s\S]*check_stage\s*=/);
  assert.doesNotMatch(sql, /GRANT INSERT/);
  assert.doesNotMatch(sql, /GRANT UPDATE/);
});

test('generic claims INSERT and claim_id UPDATE remain denied; linked Save stays update-only', () => {
  assert.equal(WRITE_ALLOWLIST.claims.ops.has('insert'), false);
  assert.equal(WRITE_ALLOWLIST.claims.ops.has('update'), true);
  assert.equal(WRITE_ALLOWLIST.claims.columns.has('claim_number'), true);
  assert.equal(WRITE_ALLOWLIST.claims.columns.has('org_id'), false);
  assert.equal(INTAKE_PROHIBITED_COLUMNS.has('claim_id'), true);
  assert.equal(WRITE_ALLOWLIST.check_intake_items.columns.has('claim_id'), false);
  assert.equal(WRITE_ALLOWLIST.check_intake_items.columns.has('amount'), false);
  assert.equal(WRITE_ALLOWLIST.check_intake_items.columns.has('deposited_at'), false);
  assert.equal(WRITE_ALLOWLIST.check_intake_items.columns.has('check_stage'), false);

  const guard = read('src/lib/checkClaimLinkGuard.ts');
  assert.match(guard, /Existing linked claims rename in place/);
  assert.match(guard, /mode: "update_existing"/);
  assert.match(guard, /Claim Ledger Save only writes an in-place claim_number update/);
  assert.match(guard, /OCR candidates are discovery evidence, not ownership/);
  assert.match(guard, /export const CLAIM_LEDGER_LINK_RPC = "claim_ledger_link_or_create"/);
  assert.doesNotMatch(guard, /op:\s*"insert"/);

  const card = read('src/components/payments/ClaimLedgerCard.tsx');
  assert.match(card, /Find Existing Claim/);
  assert.match(card, /Start New Claim Ledger/);
  assert.match(card, /Existing claim found/);
  assert.match(card, /Link Existing Ledger/);
  assert.match(card, /plan\.mode === "update_existing"/);

  const workflow = read('aws/functions/api/workflow-rpc.mjs');
  assert.match(workflow, /export const SAFE_WRITE_RPCS = new Set\([\s\S]*'claim_ledger_link_or_create'/);
  assert.match(workflow, /const executeClaimLedgerLinkOrCreate/);
  assert.match(workflow, /case 'claim_ledger_link_or_create'/);
});
