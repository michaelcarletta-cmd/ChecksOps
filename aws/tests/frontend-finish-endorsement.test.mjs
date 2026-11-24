/**
 * "Finish endorsement" on the check page (owner 2026-11-24, "1 and 3"; item 3 is this button).
 *
 * When the last payee signs, finalizeEndorsementState composites the endorsed back image and only then
 * advances the check to ready. A composite failure at that moment leaves the check stuck with every
 * signature collected. The owner-only button re-runs that path through the live authenticated action
 * check-endorsement { action: 'finalize_existing_endorsements', checkId } and says what happened in
 * plain English. Website only: no API, SQL or Lambda change.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  FINISH_ENDORSEMENT_ACTION,
  FINISH_ENDORSEMENT_MESSAGES,
  FINISH_ENDORSEMENT_SUCCESS,
  FINISH_ENDORSEMENT_SUCCESS_BRANCH,
  describeFinishEndorsementResult,
  hasCheckAdvancedPastEndorsing,
  shouldShowFinishEndorsement,
} from '../../src/lib/finishEndorsement.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const SIGNED = [
  { status: 'signed', payee_type: 'insured' },
  { status: 'waived', payee_type: 'contractor' },
];
const STUCK = { status: 'endorsements_in_progress', check_stage: 'endorsing', deposited_at: null };
const visible = (extra = {}) => shouldShowFinishEndorsement({
  isOwner: true,
  readOnly: false,
  partnerMode: false,
  endorsements: SIGNED,
  check: STUCK,
  ...extra,
});

// ---- visibility -------------------------------------------------------------------------------

test('shows for the owner when every required endorsement is signed or waived and the check has not advanced', () => {
  assert.equal(visible(), true);
  // Mortgage manual_required counts as satisfied in the existing endorsement math.
  assert.equal(visible({ endorsements: [...SIGNED, { status: 'manual_required', payee_type: 'mortgage_company' }] }), true);
  assert.equal(visible({ check: { status: 'needs_review', check_stage: 'review' } }), true);
});

test('hidden in the shared / partner / read-only view and when ownership is unknown', () => {
  assert.equal(visible({ isOwner: false }), false);
  assert.equal(visible({ partnerMode: true }), false);
  assert.equal(visible({ readOnly: true }), false);
});

test('hidden until every required endorsement is satisfied, and when one is rejected', () => {
  assert.equal(visible({ endorsements: [] }), false);
  assert.equal(visible({ endorsements: [...SIGNED, { status: 'sent', payee_type: 'insured' }] }), false);
  assert.equal(visible({ endorsements: [...SIGNED, { status: 'pending', payee_type: 'mortgage_company' }] }), false);
  assert.equal(visible({ endorsements: [...SIGNED, { status: 'rejected', payee_type: 'insured' }] }), false);
});

test('hidden once the check is ready, routed to branch, deposited or released, and when the check is unknown', () => {
  for (const status of ['approved_for_deposit', 'deposit_ready', 'endorsements_complete', 'branch_deposit_required',
    'deposited', 'released', 'funds_released', 'cleared', 'settled']) {
    assert.equal(visible({ check: { status, check_stage: 'endorsing' } }), false, status);
    assert.equal(hasCheckAdvancedPastEndorsing({ status }), true, status);
  }
  for (const check_stage of ['ready_for_deposit', 'branch', 'deposited', 'funds_released', 'disbursed_externally', 'cleared']) {
    assert.equal(visible({ check: { status: 'endorsements_in_progress', check_stage } }), false, check_stage);
  }
  assert.equal(visible({ check: { ...STUCK, deposited_at: '2026-11-20T10:00:00Z' } }), false);
  assert.equal(visible({ check: null }), false);
  assert.equal(hasCheckAdvancedPastEndorsing(STUCK), false);
});

// ---- message mapping ----------------------------------------------------------------------------

const completion = (extra = {}) => ({
  ok: true,
  success: true,
  action: 'finalize_existing_endorsements',
  allSigned: true,
  anyRejected: false,
  ...extra,
});

test('advanced: "Endorsement finished. The check is ready for deposit."', () => {
  const applied = describeFinishEndorsementResult(completion({
    composited: { ok: true, back_image_deposit_path: 'x/endorsed_deposit_1.checkalt.jpg' },
    officialRearReady: true,
    depositAdvanceDenied: false,
    advance_check_on_endorsement_complete: 'applied',
    newStatus: 'approved_for_deposit',
  }));
  assert.equal(applied.advanced, true);
  assert.equal(applied.message, 'Endorsement finished. The check is ready for deposit.');
  assert.equal(applied.message, FINISH_ENDORSEMENT_SUCCESS);

  const already = describeFinishEndorsementResult(completion({
    composited: { ok: true, reused: true }, depositAdvanceDenied: false, advance_check_on_endorsement_complete: 'already_ready',
  }));
  assert.equal(already.advanced, true);
  assert.equal(already.message, FINISH_ENDORSEMENT_SUCCESS);

  const branch = describeFinishEndorsementResult(completion({
    composited: { ok: true }, depositAdvanceDenied: false, advance_check_on_endorsement_complete: 'branch_deposit_required',
  }));
  assert.equal(branch.advanced, true);
  assert.equal(branch.message, FINISH_ENDORSEMENT_SUCCESS_BRANCH);
});

const failedComposite = (error, extra = {}) => describeFinishEndorsementResult(completion({
  composited: { ok: false, error, ...extra },
  officialRearReady: false,
  depositAdvanceDenied: true,
  advance_check_on_endorsement_complete: 'blocked_official_rear_missing',
}));

test('signature_image_missing names the payees the API returns', () => {
  const out = failedComposite('signature_image_missing', {
    message: 'A signed endorsement is missing drawn signature image data.',
    missing: ['Jane Homeowner', ' Acme Roofing ', null],
  });
  assert.equal(out.advanced, false);
  assert.equal(out.code, 'signature_image_missing');
  assert.equal(out.message,
    'One of the signed endorsements has no drawn signature saved. Ask that payee to sign again. Missing: Jane Homeowner, Acme Roofing.');
  assert.equal(failedComposite('signature_image_missing').message,
    'One of the signed endorsements has no drawn signature saved. Ask that payee to sign again.');
});

test('original back missing / ambiguous', () => {
  assert.equal(failedComposite('original_back_missing').message,
    'The original photo of the back of the check is missing. Upload the back of the check again.');
  assert.equal(failedComposite('original_back_ambiguous').message,
    'More than one back photo was found; upload the back of the check again so we know which to use.');
});

test('image too small or unreadable', () => {
  for (const code of ['source_too_small', 'too_small', 'too_large', 'aspect_distorted', 'checkalt_normalize_failed', 'unsupported_image']) {
    const out = failedComposite(code);
    assert.equal(out.code, code);
    assert.equal(out.message,
      "The back photo couldn't be made into a bank-ready image; upload a clearer photo of the back.", code);
  }
});

test('already deposited, loss-draft hold, ineligible stage', () => {
  const locked = failedComposite('historical_deposit_locked');
  assert.equal(locked.message, FINISH_ENDORSEMENT_MESSAGES.historical_deposit_locked);
  assert.match(locked.message, /already been deposited/);

  const held = describeFinishEndorsementResult(completion({
    composited: { ok: true }, depositAdvanceDenied: true, advance_check_on_endorsement_complete: 'held_loss_draft',
  }));
  assert.equal(held.code, 'held_loss_draft');
  assert.match(held.message, /loss-draft hold/);

  // finalizeEndorsementState returns skipped_ineligible without a composite for an ineligible status.
  const skipped = describeFinishEndorsementResult(completion({
    depositAdvanceDenied: true, advance_check_on_endorsement_complete: 'skipped_ineligible', officialRearReady: false,
  }));
  assert.equal(skipped.code, 'skipped_ineligible');
  assert.match(skipped.message, /current stage can't be moved to ready/);
});

test('anything else: a generic message plus the error code', () => {
  const persist = describeFinishEndorsementResult({
    ok: false, success: false, error: 'auto_advance_persist_failed', composited: { ok: true },
    depositAdvanceDenied: true, advance_check_on_endorsement_complete: 'persist_failed',
  });
  assert.equal(persist.advanced, false);
  assert.match(persist.message, /couldn't be finished/);
  assert.match(persist.message, /persist_failed/);

  const odd = failedComposite('original_back_bucket_exploded');
  assert.match(odd.message, /\(Error code: original_back_bucket_exploded\)$/);

  assert.match(describeFinishEndorsementResult(null).message, /no_response/);
  assert.match(describeFinishEndorsementResult({ ok: false, error: 'Check not found' }).message, /Check not found/);
  // Image made but the server returned no advance decision (automatic advance off): not a success.
  const noAdvance = describeFinishEndorsementResult(completion({ composited: { ok: true }, officialRearReady: true }));
  assert.equal(noAdvance.advanced, false);
  assert.match(noAdvance.message, /not_advanced/);
});

test('a success flag alone never reads as advanced', () => {
  assert.equal(describeFinishEndorsementResult({ ok: true, success: true }).advanced, false);
  assert.equal(describeFinishEndorsementResult(completion({
    depositAdvanceDenied: true, advance_check_on_endorsement_complete: 'applied',
  })).advanced, false);
});

// ---- the page wiring, by source text --------------------------------------------------------

const checklist = read('src/components/check-review/EndorsementChecklist.tsx');
const page = read('src/pages/CheckCommandCenter.tsx');

test('the endorsement card calls check-endorsement with finalize_existing_endorsements and the Authorization header', () => {
  assert.equal(FINISH_ENDORSEMENT_ACTION, 'finalize_existing_endorsements');
  const start = checklist.indexOf('const finishEndorsement = async');
  assert.ok(start > 0, 'finishEndorsement handler present');
  const handler = checklist.slice(start, checklist.indexOf('if (isLoading)', start));
  assert.match(handler, /supabase\.functions\.invoke\("check-endorsement"/);
  assert.match(handler, /action: FINISH_ENDORSEMENT_ACTION, checkId/);
  assert.match(handler, /Authorization: `Bearer \$\{session\.session\.access_token\}`/);
  assert.match(handler, /describeFinishEndorsementResult\(/);
  assert.match(handler, /refresh\(\)/);
  assert.match(checklist, /\{finishingEndorsement \? "Finishing endorsement\.\.\." : "Finish endorsement"\}/);
});

test('the button is not shown in the shared / read-only view', () => {
  // Rendered only behind shouldShowFinishEndorsement, which refuses non-owners, readOnly and partnerMode.
  assert.match(checklist, /\{showFinishEndorsement && \(/);
  assert.match(checklist, /shouldShowFinishEndorsement\(\{\s*isOwner,\s*readOnly,\s*partnerMode,/);
  // isOwner defaults to false: a caller that does not pass it never shows the button.
  assert.match(checklist, /isOwner = false,/);
  // The page passes its own ownership and the shared view as partner mode.
  const usage = page.slice(page.indexOf('<EndorsementChecklist'), page.indexOf('/>', page.indexOf('<EndorsementChecklist')));
  assert.match(usage, /partnerMode=\{isSharedView\}/);
  assert.match(usage, /isOwner=\{isOwner\}/);
  assert.match(usage, /checkWorkflow=\{check\}/);
  assert.match(page, /const isOwner = !!tenantId && !!checkOwnerTenantId && tenantId === checkOwnerTenantId;/);
  assert.match(page, /const isSharedView = !!check && !isOwner;/);
});

test('website only: no API or Lambda source references the new helper', () => {
  assert.doesNotMatch(read('aws/functions/api/check-endorsement.mjs'), /finishEndorsement\.ts/);
});

test('voided, returned and cancelled checks do not show the button (the server never advances them)', async () => {
  const { INELIGIBLE_CHECK_STATUSES, hasCheckAdvancedPastEndorsing } = await import('../../src/lib/finishEndorsement.ts');
  const { INELIGIBLE_AUTO_ADVANCE_STATUSES } = await import(`../../aws/functions/api/endorsement-parity.mjs`);
  assert.deepEqual([...INELIGIBLE_CHECK_STATUSES].sort(), [...INELIGIBLE_AUTO_ADVANCE_STATUSES].sort());
  for (const status of ['voided', 'returned', 'cancelled']) {
    assert.equal(hasCheckAdvancedPastEndorsing({ status }), true, status);
  }
  assert.equal(hasCheckAdvancedPastEndorsing({ status: 'pending_endorsement' }), false);
});
