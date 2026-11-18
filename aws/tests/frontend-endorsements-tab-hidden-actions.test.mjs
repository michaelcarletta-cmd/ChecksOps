/**
 * Endorsements tab and check file (owner 2026-11-18):
 *   "mark all endorsements received gives an error. Just hide that for now. The tenant can manually click each payee
 *   'endorsed on check' which works. Hide deposits blocked box above that as well. Also remove linked claim on the bottom
 *   of each claim check file."
 * Asked which of the two "deposit blocked" notices, the owner chose the large box only: the thin one-line notice stays.
 *
 * Hidden, not deleted: the button, the box and their handlers stay in the code behind two switches that are off.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('"Mark All Endorsements Received" is switched off; the per-payee "Endorsed on Check" and the one-line notice stay', () => {
  const list = read('src/components/check-review/EndorsementChecklist.tsx');
  assert.match(list, /^const SHOW_MARK_ALL_ENDORSEMENTS = false;$/m);
  // The whole dialog (button and confirmation) renders only behind the switch.
  const gate = list.indexOf('{SHOW_MARK_ALL_ENDORSEMENTS && (');
  // The button label as rendered (the phrase also appears in the comment that explains the switch).
  const button = list.indexOf('                Mark All Endorsements Received\n');
  const confirm = list.indexOf('<AlertDialogAction onClick={forceCompleteAll}>');
  assert.ok(gate > 0 && gate < button && button < confirm);
  assert.match(list.slice(gate, button), /^\{SHOW_MARK_ALL_ENDORSEMENTS && \(\n\s+<AlertDialog>\n\s+<AlertDialogTrigger asChild>/);
  assert.match(list.slice(confirm), /^<AlertDialogAction onClick=\{forceCompleteAll\}>[\s\S]*?<\/AlertDialog>\n\s+\)\}\n\s+<\/div>/);
  assert.equal(list.split('                Mark All Endorsements Received\n').length - 1, 1);
  // Still there: the thin notice above it, and the action the owner says works.
  assert.ok(list.indexOf('Deposit blocked until all required endorsements are completed') < gate);
  assert.match(list, /onClick=\{waiveEndorsement\}[\s\S]{0,200}Endorsed on Check/);
});

test('the large "Deposit Blocked" box, with its Skip Endorsements button, is switched off', () => {
  const page = read('src/pages/CheckCommandCenter.tsx');
  assert.match(page, /^const SHOW_DEPOSIT_BLOCKED_BOX = false;$/m);
  assert.match(page, /<TabsContent value="endorsements"[^>]*>\n[\s\S]{0,400}\{SHOW_DEPOSIT_BLOCKED_BOX && isDepositBlocked && \(/);
  // The box is rendered in one place only, and nowhere without the switch.
  assert.equal(page.split('{isDepositBlocked && (').length - 1, 0);
  const gate = page.indexOf('{SHOW_DEPOSIT_BLOCKED_BOX && isDepositBlocked && (');
  const checklist = page.indexOf('<EndorsementChecklist');
  const box = page.slice(gate, checklist);
  assert.ok(box.includes('Deposit Blocked') && box.includes('Skip Endorsements — Already Signed') && box.includes('handleBypassEndorsements'));
  // Rendered once (the phrase also appears in the comments that explain the switch).
  assert.equal(page.split('/>Skip Endorsements — Already Signed</>').length - 1, 1);
  // Deposit is still held back by the same rule: only the notice is hidden.
  assert.match(page, /const isDepositBlocked =/);
  assert.match(page, /allEndorsementsComplete && !isDepositBlocked && check\.check_stage !== "deposited"/);
});

test('the check file no longer shows a "Linked Claim" row', () => {
  const page = read('src/pages/CheckCommandCenter.tsx');
  assert.doesNotMatch(page, /Linked Claim/);
  assert.doesNotMatch(page, /check\.claim_id\.slice\(0, 8\)/);
  // Only the row is gone: the DetailRow helper stays (issue-date.test.mjs pins its shared issue-date formatting).
  assert.doesNotMatch(page, /<DetailRow/);
  assert.match(page, /function DetailRow\(/);
});
