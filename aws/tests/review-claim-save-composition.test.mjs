/**
 * Live staging dropped peelReviewClaimNumber and the claims allowlist
 * when Signature write tables were added. Keep all three.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { WRITE_ALLOWLIST, pickAllowlistedValues } from '../functions/api/write-allowlist.mjs';

const WRITE_SRC = readFileSync('aws/functions/api/write.mjs', 'utf8');
const WORKFLOW_SRC = readFileSync('aws/functions/api/write-check-workflow.mjs', 'utf8');

test('detected_claim_number stays prohibited on the generic intake allowlist', () => {
  assert.equal(WRITE_ALLOWLIST.check_intake_items.columns.has('detected_claim_number'), false);
  const denied = pickAllowlistedValues('check_intake_items', { detected_claim_number: '695064-GQ' });
  assert.equal(denied.error, 'column_not_allowlisted');
  assert.deepEqual(denied.columns, ['detected_claim_number']);
});

test('Review claim # save is peeled to SQL 43 before allowlist denial', () => {
  assert.match(WRITE_SRC, /const peelReviewClaimNumber/);
  assert.match(WRITE_SRC, /review_save_detected_claim_number/);
  assert.match(WRITE_SRC, /pickAllowlistedValues\(table, peeled\.row\)/);
});

test('linked Claim Ledger Save remains claims.claim_number update-only', () => {
  assert.equal(WRITE_ALLOWLIST.claims.ops.has('update'), true);
  assert.equal(WRITE_ALLOWLIST.claims.ops.has('insert'), false);
  assert.deepEqual([...WRITE_ALLOWLIST.claims.columns], ['claim_number']);
  assert.match(WORKFLOW_SRC, /'claims'/);
});

test('live Signature draft inserts remain allowlisted', () => {
  assert.equal(WRITE_ALLOWLIST.signature_requests.ops.has('insert'), true);
  assert.equal(WRITE_ALLOWLIST.signature_signers.ops.has('insert'), true);
  assert.ok(WRITE_ALLOWLIST.signature_requests.columns.has('document_path'));
  assert.ok(WRITE_ALLOWLIST.signature_signers.columns.has('signer_email'));
  assert.match(WORKFLOW_SRC, /executeSignatureWrite/);
});
