/**
 * Claim Ledger card: correct a linked check's claim number (owner 2026-11-14, "Need to be able to change/correct claim
 * number once edited for ledger to link to existing claim"; SQL 167 through the API's claim_ledger_relink_check).
 * Mirrors claim-ledger-discovery-grouping.test.mjs and ledger-safety-backfill.test.mjs: the pure guard helpers, then the
 * card's source. AWS backend: inspect first; an existing same-tenant claim is confirmed, then relink; no_match keeps
 * today's rename (with a warning when other checks share the claim); refusals show a clear message. Legacy backend:
 * today's rename, unchanged.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  CLAIM_LEDGER_LINK_RPC,
  CLAIM_LEDGER_NOT_LINKED,
  CLAIM_LEDGER_RELINK_RPC,
  claimLedgerRelinkArgs,
  claimLedgerRelinkConfirmCopy,
  claimLedgerRelinkedToast,
  claimLedgerRelinkNext,
  claimLedgerRelinkUserMessage,
  claimLedgerRenameWarning,
  claimNumberSaveWritePayload,
  planClaimNumberSave,
  planLinkedClaimNumberSave,
} from '../../src/lib/checkClaimLinkGuard.ts';

const read = (p) => readFileSync(p, 'utf8');
const CHECK = '8d2b1c3e-4f5a-4678-9abc-def012345678';
const OLD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NEW = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const INSPECT_FOUND = {
  ok: true,
  persisted: false,
  code: 'relink_available',
  can_relink: true,
  claim_id: NEW,
  claim_number: '695064-GQ',
  policyholder_name: 'Jane Homeowner',
  check_claim_id: OLD,
  old_claim_id: OLD,
  old_claim_number: '695064-QG',
  old_claim_other_check_count: 2,
  old_claim_has_settlements: true,
  loss_draft_rows_to_move: 1,
  signature_request_rows_to_move: 2,
};

// SQL 167's refusal codes (the API answers each as a 4xx whose error is the code).
const SQL167 = read('aws/workflows/sql/167_claim_ledger_relink_check.sql');
const REFUSALS = [...new Set([...SQL167.matchAll(/'ok', false, 'persisted', false, 'code', '([a-z_]+)'/g)].map((m) => m[1]))];

test('the relink RPC is SQL 167\'s function; the link RPC is unchanged', () => {
  assert.equal(CLAIM_LEDGER_RELINK_RPC, 'claim_ledger_relink_check');
  assert.match(SQL167, /CREATE OR REPLACE FUNCTION public\.claim_ledger_relink_check\(/);
  assert.equal(CLAIM_LEDGER_LINK_RPC, 'claim_ledger_link_or_create');
  assert.deepEqual([...REFUSALS].sort(), ['actor_required', 'ambiguous', 'check_not_found', 'cross_tenant', 'invalid_action', 'invalid_args', 'locked', 'not_linked', 'tenant_mismatch']);
});

test('linked Save: AWS backend inspects first; legacy backend keeps the in-place rename', () => {
  assert.deepEqual(planLinkedClaimNumberSave({ awsBackend: true, existingClaimId: OLD, claimNumber: ' 695064-GQ ' }), {
    mode: 'relink_inspect', claimId: OLD, claimNumber: '695064-GQ',
  });
  const legacy = planLinkedClaimNumberSave({ awsBackend: false, existingClaimId: OLD, claimNumber: '695064-GQ' });
  assert.deepEqual(legacy, planClaimNumberSave({ existingClaimId: OLD, claimNumber: '695064-GQ' }));
  assert.equal(legacy.mode, 'update_existing');
  assert.deepEqual(claimNumberSaveWritePayload(legacy).values, { claim_number: '695064-GQ' });
  assert.throws(() => planLinkedClaimNumberSave({ awsBackend: true, existingClaimId: null, claimNumber: 'X' }), new RegExp(CLAIM_LEDGER_NOT_LINKED));
  assert.throws(() => planLinkedClaimNumberSave({ awsBackend: true, existingClaimId: OLD, claimNumber: '  ' }), /Enter a claim number/);
});

test('relink args carry the check, the number and inspect|relink only, never a tenant or actor', () => {
  assert.deepEqual(claimLedgerRelinkArgs({ checkId: CHECK, claimNumber: ' 695064-GQ ', action: 'inspect' }), {
    p_check_id: CHECK, p_claim_number: '695064-GQ', p_action: 'inspect',
  });
  const relink = claimLedgerRelinkArgs({ checkId: CHECK, claimNumber: '695064-GQ', action: 'relink' });
  assert.equal(relink.p_action, 'relink');
  assert.equal('p_tenant_id' in relink, false);
  assert.equal('p_actor_id' in relink, false);
  assert.throws(() => claimLedgerRelinkArgs({ checkId: CHECK, claimNumber: 'X', action: 'create_new' }), /Invalid claim number action/);
  assert.throws(() => claimLedgerRelinkArgs({ checkId: '', claimNumber: 'X', action: 'inspect' }), /Missing check/);
  assert.throws(() => claimLedgerRelinkArgs({ checkId: CHECK, claimNumber: '', action: 'inspect' }), /Enter a claim number/);
});

test('inspect: an existing claim is confirmed with the old-claim facts; no_match renames; unchanged is a no-op', () => {
  const next = claimLedgerRelinkNext(INSPECT_FOUND);
  assert.equal(next.kind, 'confirm_move');
  const copy = claimLedgerRelinkConfirmCopy(next.result);
  assert.equal(copy.title, 'Claim #695064-GQ exists — move this check (and its loss draft and signature requests) to it?');
  assert.deepEqual(copy.lines, [
    "Claim #695064-GQ is Jane Homeowner's claim.",
    '2 other checks stay on claim #695064-QG.',
    'The settlement amounts entered on claim #695064-QG stay on it.',
    '1 loss draft file moves with this check.',
    '2 signature requests move with this check.',
    'Only checks that are not deposited can move.',
  ]);
  assert.equal(copy.confirmLabel, 'Move to claim #695064-GQ');
  const lone = claimLedgerRelinkConfirmCopy({ ...INSPECT_FOUND, policyholder_name: null, old_claim_other_check_count: 0, old_claim_has_settlements: false, loss_draft_rows_to_move: 0, signature_request_rows_to_move: 1 });
  assert.deepEqual(lone.lines, [
    'No other check is on claim #695064-QG; it will have no checks left.',
    'This check has no loss draft file to move.',
    '1 signature request moves with this check.',
    'Only checks that are not deposited can move.',
  ]);
  assert.deepEqual(claimLedgerRelinkNext({ ok: true, code: 'no_match', claim_id: null }), { kind: 'rename' });
  assert.deepEqual(claimLedgerRelinkNext({ ok: true, code: 'unchanged', claim_number: 'CL-1' }), { kind: 'unchanged', claimNumber: 'CL-1' });
  assert.throws(() => claimLedgerRelinkNext({ ok: false, code: 'locked' }), /deposited/);
  assert.throws(() => claimLedgerRelinkNext(null), /rejected/);
});

test('after relink the toast reports old_claim_remaining_check_count', () => {
  const relinked = { ...INSPECT_FOUND, code: 'relinked', persisted: true, old_claim_remaining_check_count: 2 };
  assert.deepEqual(claimLedgerRelinkedToast(relinked), {
    title: 'Check moved to claim #695064-GQ',
    description: 'Claim #695064-QG still has 2 checks.',
  });
  assert.equal(claimLedgerRelinkedToast({ ...relinked, old_claim_remaining_check_count: 1 }).description, 'Claim #695064-QG still has 1 check.');
  assert.equal(claimLedgerRelinkedToast({ ...relinked, old_claim_remaining_check_count: 0 }).description, 'Claim #695064-QG has no checks left.');
});

test('no_match rename warns only when other checks share the claim', () => {
  assert.equal(claimLedgerRenameWarning({ otherCheckCount: 0, currentClaimNumber: 'OLD', newClaimNumber: 'NEW' }), null);
  assert.deepEqual(claimLedgerRenameWarning({ otherCheckCount: 3, currentClaimNumber: 'OLD', newClaimNumber: 'NEW' }), {
    title: 'No claim has #NEW. Rename claim #OLD instead?',
    lines: ['3 other checks share this claim and will show the new number too.'],
    confirmLabel: 'Rename claim to #NEW',
  });
});

test('every refusal the API answers has its own message; locked explains the deposit', () => {
  for (const code of [...REFUSALS, 'no_match']) {
    if (code === 'invalid_action' || code === 'actor_required') continue;
    assert.notEqual(claimLedgerRelinkUserMessage(code), claimLedgerRelinkUserMessage('something_else'), code);
  }
  assert.match(claimLedgerRelinkUserMessage('locked'), /deposited/);
  assert.match(claimLedgerRelinkUserMessage('claim_ledger_relink_unavailable'), /not available yet/);
});

test('card: AWS-only inspect -> confirm -> relink, rename kept for no_match and legacy, label matches', () => {
  const card = read('src/components/payments/ClaimLedgerCard.tsx');
  // The AWS decision is the data client's (integrations/supabase/client): the AWS build, or a ChecksOps host with Cognito.
  assert.match(card, /import\.meta\.env\.MODE === "aws"/);
  assert.match(card, /shouldUseAwsChecksOpsBackendFor\(/);
  assert.match(card, /planLinkedClaimNumberSave\(\{\s*awsBackend/);
  assert.match(card, /CLAIM_LEDGER_RELINK_RPC/);
  assert.match(card, /claimLedgerRelinkArgs\(\{[\s\S]*?action: "inspect"/);
  assert.match(card, /claimLedgerRelinkArgs\(\{[\s\S]*?action: "relink"/);
  assert.match(card, /claimLedgerRelinkConfirmCopy/);
  assert.match(card, /claimLedgerRelinkedToast/);
  assert.match(card, /claimLedgerRenameWarning/);
  // The move is proven from the authoritative link before it is reported.
  assert.match(card, /Authoritative claim_id did not match the moved claim\./);
  // Today's rename stays the only write the card makes itself, update-only.
  assert.match(card, /mode === "update_existing"/);
  assert.match(card, /\.from\("claims"\)[\s\S]*\.update\(\{ claim_number: plan\.claimNumber \}\)/);
  assert.equal(/\.from\("claims"\)[\s\S]*\.insert\(/.test(card), false);
  assert.equal(/\.from\("check_intake_items"\)[\s\S]{0,80}\.update\(/.test(card), false);
  assert.equal(/p_tenant_id|p_actor_id/.test(card), false);
  // The box says what Save does.
  assert.doesNotMatch(card, /Re-link to a different claim number/);
  assert.match(card, /Correct claim number/);
  assert.match(card, /moves to it \(before deposit\)/);
  assert.match(card, /Saving renames this claim/);
  assert.match(card, /onClick=\{handleLinkedSave\}/);
});
