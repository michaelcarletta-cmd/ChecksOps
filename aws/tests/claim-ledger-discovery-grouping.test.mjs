import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  CLAIM_LEDGER_LINK_RPC,
  claimLedgerCreatedSummary,
  claimLedgerDiscoverySummary,
  claimNumberSaveWritePayload,
  planClaimNumberSave,
} from '../../src/lib/checkClaimLinkGuard.ts';
import { WRITE_ALLOWLIST, INTAKE_PROHIBITED_COLUMNS } from '../functions/api/write-allowlist.mjs';

const read = (p) => readFileSync(p, 'utf8');

test('1 existing real ledger inspect copy stays Existing Claim Found', () => {
  const card = read('src/components/payments/ClaimLedgerCard.tsx');
  assert.match(card, /Existing claim found/);
  assert.match(card, /Link Existing Ledger/);
  assert.equal(claimLedgerDiscoverySummary({
    code: 'existing_found',
    claim_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    claim_number: '695064-GQ',
  }), null);
});

test('2 no ledger + one same-tenant OCR check', () => {
  const summary = claimLedgerDiscoverySummary({
    code: 'no_match',
    claim_number: '695064-GQ',
    same_tenant_detected_count: 1,
    same_tenant_unlinked_count: 1,
    same_tenant_already_linked_count: 0,
  });
  assert.equal(summary.kind, 'ocr_group');
  assert.equal(summary.headline, 'Claim #695064-GQ');
  assert.equal(summary.lines[0], '1 check found for this claim number.');
  assert.equal(summary.lines[1], 'No Claim Ledger has been created yet.');
});

test('3 no ledger + four same-tenant OCR checks', () => {
  const summary = claimLedgerDiscoverySummary({
    code: 'no_match',
    claim_number: '695064-GQ',
    same_tenant_detected_count: 4,
    same_tenant_unlinked_count: 4,
    same_tenant_already_linked_count: 0,
  });
  assert.equal(summary.lines[0], '4 checks found for this claim number.');
  const created = claimLedgerCreatedSummary({
    claim_number: '695064-GQ',
    associated_check_count: 4,
    already_linked_sibling_count: 0,
  });
  assert.ok(created.lines.includes('4 checks associated with this claim.'));
});

test('4-5 foreign and mixed-tenant OCR are never grouped in SQL', () => {
  const sql = read('aws/write-path/sql/44_claim_ledger_link_or_create.sql');
  assert.match(sql, /s\.tenant_id IS NOT DISTINCT FROM p_tenant_id/);
  assert.match(sql, /i\.tenant_id IS NOT DISTINCT FROM p_tenant_id/);
  assert.match(sql, /ocr_claim_number_key\(s\.detected_claim_number\) = v_key/);
  assert.doesNotMatch(sql, /ev\.detected_claim_number/);
});

test('6 already-linked checks stay immutable in create_new', () => {
  const sql = read('aws/write-path/sql/44_claim_ledger_link_or_create.sql');
  assert.match(sql, /AND s\.claim_id IS NULL/);
  assert.match(sql, /AND i\.claim_id IS NULL/);
  assert.match(sql, /Existing claim_id is never rewritten/);
});

test('7-8 duplicate create race resolves to one ledger', () => {
  const sql = read('aws/write-path/sql/44_claim_ledger_link_or_create.sql');
  assert.match(sql, /unique_violation/);
  assert.match(sql, /WHEN unique_violation THEN/);
  assert.match(sql, /code', CASE WHEN v_new_id IS NOT NULL THEN 'created' ELSE 'linked' END/);
  assert.match(sql, /FOR UPDATE OF s SKIP LOCKED/);
});

test('9-10 generic claims INSERT and claim_id UPDATE remain denied', () => {
  assert.equal(WRITE_ALLOWLIST.claims.ops.has('insert'), false);
  assert.equal(INTAKE_PROHIBITED_COLUMNS.has('claim_id'), true);
  assert.equal(WRITE_ALLOWLIST.check_intake_items.columns.has('claim_id'), false);
});

test('11-12 amount/deposit/stage unchanged and linked Save stays update-only', () => {
  const sql = read('aws/write-path/sql/44_claim_ledger_link_or_create.sql');
  assert.doesNotMatch(sql, /deposited_at\s*=/);
  assert.doesNotMatch(sql, /SET[\s\S]*amount\s*=/);
  assert.doesNotMatch(sql, /SET[\s\S]*check_stage\s*=/);
  const plan = planClaimNumberSave({
    existingClaimId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    claimNumber: '695064-GQ',
  });
  assert.equal(plan.mode, 'update_existing');
  const write = claimNumberSaveWritePayload(plan);
  assert.equal(write.op, 'update');
  assert.equal(write.table, 'claims');
  assert.deepEqual(write.values, { claim_number: '695064-GQ' });
});

test('13-16 Review, Moov, signature, and #524 layout source stay composed', () => {
  const sql43 = read('aws/write-path/sql/43_review_save_detected_claim_number.sql');
  assert.match(sql43, /Never inserts a claims row/);
  assert.doesNotMatch(sql43, /INSERT INTO public\.claims/);

  const flags = read('src/lib/payments/featureFlags.ts');
  assert.match(flags, /generally available/);
  assert.match(flags, /return PAYMENT_FLAGS\.USE_MOOV;/);

  const files = read('src/components/check-review/CheckFilesSection.tsx');
  assert.match(files, /Send for Homeowner Signature/);
  const sig = read('src/components/claim-detail/SignatureRequests.tsx');
  assert.match(sig, /Send for Signature/);

  const ccc = read('src/pages/CheckCommandCenter.tsx');
  assert.match(ccc, /lg:flex-row/);
  assert.match(ccc, /selectedCheck \? "58%" : "80%"/);
  assert.match(ccc, /selectedCheck \? "42%" : "20%"/);

  assert.equal(CLAIM_LEDGER_LINK_RPC, 'claim_ledger_link_or_create');
});
