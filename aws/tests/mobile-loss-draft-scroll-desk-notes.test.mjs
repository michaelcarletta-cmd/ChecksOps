/**
 * Owner 2026-11-15 (website only):
 *  1. "On mobile devices fix the loss draft scroll feature. If I open a check file it is limiting me to scrolling."
 *     The loss draft panel had a fixed height with overflow-hidden at every width; on a phone its tall header
 *     (check, actions, Mortgage Desk cards) was clipped and the page could not scroll to it. Below md the panel now
 *     grows with its content; from md up it keeps the fixed height.
 *     Owner 2026-11-16: "scrolling in loss draft needs to be fixed. When these notes and updates are completed, the
 *     tenant needs to be able to see everything still." On desktop the same clipping happened once the Mortgage Desk
 *     notes, documents and the returned box outgrew the fixed height; the panel now grows with its content at every
 *     width and the page or the View Loss Draft dialog scrolls. The returned box's amber text is readable in light mode.
 *  2. "When mortgage desk adds a note the boxes/notifications show large. Let's make those notifications smaller but
 *     easily to notice from a tenant that there is an update." Desk notes and the shipping card are compact rows with
 *     an amber accent, the "Mortgage Desk" label, the time and a "New" marker from the existing check_message_reads.
 * Source checks plus the pure display helpers.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  MORTGAGE_DESK_NOTE_CLAMP_CHARS,
  MORTGAGE_DESK_NOTE_LABEL,
  MORTGAGE_DESK_NOTES_VISIBLE,
  countUnreadMortgageDeskNotes,
  isMortgageDeskThreadMessage,
  isUnreadMortgageDeskNote,
  mortgageDeskNoteIsLong,
  mortgageDeskNoteText,
  newestMortgageDeskNotesFirst,
} from '../../src/lib/mortgageDeskNoteDisplay.ts';
import { buildMortgageDeskCompletedMessage, buildReturnAckMessage, buildReturnMessage } from '../../src/lib/mortgageDeskReturn.ts';
import { MORTGAGE_DESK_NOTE_PREFIX } from '../../src/lib/mortgageDeskWrites.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';

/* ------------------------------ 1. mobile scroll ------------------------------ */

test('loss draft panel: no fixed height or clipping at any width; the page or dialog scrolls (owner 2026-11-15, 2026-11-16)', () => {
  const panel = read('src/components/loss-draft/LossDraftDetailPanel.tsx');
  assert.match(panel, /<Card className="flex min-w-0 flex-col">/);
  assert.doesNotMatch(panel, /<Card className="[^"]*h-\[calc\(100vh-16rem\)\]/, 'no fixed height');
  assert.doesNotMatch(panel, /<Card className="[^"]*max-h-\[42rem\]/, 'no max height');
  assert.doesNotMatch(panel, /<Card className="[^"]*overflow-hidden/, 'no overflow-hidden on the card');
  assert.match(panel, /<Tabs value=\{activeTab\} onValueChange=\{setActiveTab\} className="flex flex-col">/);
  const contents = panel.match(/<TabsContent[\s\S]*?className="([^"]*)"/g) || [];
  assert.equal(contents.length >= 5, true, 'every tab body');
  for (const c of contents) {
    assert.match(c, /className="mt-0 data-\[state=inactive\]:hidden"/, c);
  }
});

test('loss draft list view: the expanded panel sits in plain block wrappers (no fixed height around it)', () => {
  const dashboard = read('src/components/loss-draft/LossDraftDashboard.tsx');
  assert.match(dashboard, /<div className="space-y-2">\s*\n\s*<Button[\s\S]*?Back to list[\s\S]*?<LossDraftDetailPanel/);
});

/* ------------------------------ 2. compact Desk notes ------------------------------ */

test('Desk thread messages are recognised by prefix or return marker; the tenant ack is not a Desk note', () => {
  assert.equal(isMortgageDeskThreadMessage(`${MORTGAGE_DESK_NOTE_PREFIX}Called PNC`), true);
  assert.equal(isMortgageDeskThreadMessage(buildMortgageDeskCompletedMessage('PNC Bank', null)), true);
  assert.equal(isMortgageDeskThreadMessage('📎 Mortgage Ops attached a document: "a.pdf".'), true);
  assert.equal(isMortgageDeskThreadMessage(buildReturnMessage(REQUEST_ID)), true);
  assert.equal(isMortgageDeskThreadMessage(buildReturnAckMessage(REQUEST_ID)), false);
  assert.equal(isMortgageDeskThreadMessage('Hi team, any update?'), false);
  assert.equal(isMortgageDeskThreadMessage(''), false);
  assert.equal(isMortgageDeskThreadMessage(null), false);
});

test('note text drops the note prefix (the row shows the label) and clamps long or multi-line text', () => {
  assert.equal(mortgageDeskNoteText(`${MORTGAGE_DESK_NOTE_PREFIX}Called PNC`), 'Called PNC');
  assert.equal(mortgageDeskNoteText(buildReturnMessage(REQUEST_ID)).startsWith('Mortgage Desk completed work'), true);
  assert.equal(MORTGAGE_DESK_NOTE_LABEL, 'Mortgage Desk');
  assert.equal(mortgageDeskNoteIsLong('short'), false);
  assert.equal(mortgageDeskNoteIsLong('x'.repeat(MORTGAGE_DESK_NOTE_CLAMP_CHARS + 1)), true);
  assert.equal(mortgageDeskNoteIsLong('line one\nline two'), true);
  assert.equal(MORTGAGE_DESK_NOTES_VISIBLE, 3);
});

test('"New" uses the existing last_read_at: unknown marks nothing, never read marks all, else after the read', () => {
  const notes = [
    { id: 'a', created_at: '2026-11-10T10:00:00Z' },
    { id: 'b', created_at: '2026-11-14T10:00:00Z' },
    { id: 'c', created_at: '2026-11-15T10:00:00Z' },
  ];
  assert.equal(countUnreadMortgageDeskNotes(notes, undefined), 0, 'read state unknown');
  assert.equal(countUnreadMortgageDeskNotes(notes, null), 3, 'thread never opened');
  assert.equal(countUnreadMortgageDeskNotes(notes, '2026-11-14T12:00:00Z'), 1);
  assert.equal(isUnreadMortgageDeskNote('2026-11-15T10:00:00Z', '2026-11-15T10:00:00Z'), false, 'read at the same instant');
  assert.equal(isUnreadMortgageDeskNote(null, null), false);
  assert.deepEqual(newestMortgageDeskNotesFirst(notes).map((n) => n.id), ['c', 'b', 'a']);
});

test('note row: amber left border and dot, Mortgage Desk label, time, New marker, clamp with Show more', () => {
  const row = read('src/components/loss-draft/MortgageDeskNoteRow.tsx');
  assert.match(row, /"border-l-2 border-amber-400 py-0\.5 pl-2 text-\[11px\] leading-snug"/);
  assert.match(row, /h-1\.5 w-1\.5 shrink-0 rounded-full/);
  assert.match(row, /\{MORTGAGE_DESK_NOTE_LABEL\}/);
  assert.match(row, /<time dateTime=\{createdAt\}/);
  assert.match(row, /\{isNew && \(/);
  assert.match(row, />\s*New\s*</);
  assert.match(row, /clamped && "line-clamp-2"/);
  assert.match(row, /aria-expanded=\{expanded\}/);
  assert.match(row, /\{expanded \? "Show less" : "Show more"\}/);
});

test('returned work: compact accented box, newest notes first, "N new" from check_message_reads, show all', () => {
  const work = read('src/components/loss-draft/MortgageDeskReturnedWork.tsx');
  assert.match(work, /className="w-full rounded-md border border-border\/60 border-l-2 border-l-amber-400 bg-muted\/30 px-2 py-1\.5 text-xs space-y-1\.5 scroll-mt-4"/);
  assert.doesNotMatch(work, /p-3 text-xs space-y-3/, 'the old large box is gone');
  assert.match(work, /\.from\("check_message_reads"\)\s*\n\s*\.select\("last_read_at"\)/);
  assert.match(work, /queryKey: \["check-unread-counts", "mortgage-desk-notes", checkId/);
  assert.match(work, /data-testid="mortgage-desk-notes-new"/);
  assert.match(work, /\{newCount\} new/);
  assert.match(work, /<MortgageDeskNoteRow/);
  assert.match(work, /isNew=\{isUnreadMortgageDeskNote\(note\.created_at, lastReadAt\)\}/);
  assert.match(work, /newestMortgageDeskNotesFirst\(data\.notes\)/);
  assert.match(work, /`Show all \$\{sortedNotes\.length\} notes`/);
  // No writes: display only.
  assert.doesNotMatch(work, /\.(insert|upsert|update|delete)\(/);
});

test('shipping card: one compact line, address truncated, Copy as an icon, full details behind a tap', () => {
  const card = read('src/components/loss-draft/MortgageDeskShippingCard.tsx');
  assert.match(card, /className="w-full rounded-md border border-border\/60 border-l-2 border-l-amber-400 bg-muted\/30 px-2 py-1\.5 text-xs"/);
  assert.doesNotMatch(card, /p-3 text-xs space-y-2/, 'the old large box is gone');
  assert.match(card, /<span className="shrink-0 text-\[11px\] font-semibold">Mortgage Desk<\/span>/);
  assert.match(card, /<span className="min-w-0 truncate text-\[10px\] text-muted-foreground">\{summary\}<\/span>/);
  assert.match(card, /aria-label="Copy mailing address"/);
  assert.match(card, /size="icon"[\s\S]*?<Copy className="h-3 w-3" \/>/);
  assert.doesNotMatch(card, /<Copy className="mr-1 h-3 w-3" \/> Copy/, 'Copy is an icon, not a text button');
  assert.match(card, /aria-expanded=\{expanded\}/);
  assert.match(card, /\{expanded && \(/);
  assert.match(card, /Check is being mailed to/);
  assert.match(card, /Print label/);
});

test('check thread: a Desk message from someone else is a compact note row, other messages are unchanged', () => {
  const thread = read('src/components/check-messages/CheckMessageThread.tsx');
  assert.match(thread, /if \(!isMe && isMortgageDeskThreadMessage\(m\.body\)\) \{[\s\S]*?<MortgageDeskNoteRow/);
  assert.match(thread, /max-w-\[80%\] rounded-lg px-3 py-2 text-sm/, 'ordinary bubbles unchanged');
});

test('loss draft panel uses the compact returned banner', () => {
  const panel = read('src/components/loss-draft/LossDraftDetailPanel.tsx');
  assert.match(panel, /<MortgageDeskReturnedBanner\s*\n\s*compact\s*\n/);
});

test('check file: the View Loss Draft dialog scrolls at every width; the tab area has its fixed height only from md up', () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src/pages/CheckCommandCenter.tsx'), 'utf8');
  // The dialog scrolls itself at every width (the panel inside grows with its content).
  assert.match(src, /<DialogContent className="max-w-4xl max-h-\[85vh\] p-0 overflow-y-auto overscroll-contain border-border bg-card">/);
  assert.doesNotMatch(src, /max-h-\[85vh\] p-0 overflow-y-auto overscroll-contain md:overflow-hidden/);
  assert.doesNotMatch(src, /max-h-\[85vh\] p-0 overflow-hidden/);
  // The check file's tab area has its fixed height only from md up; on a phone the page scrolls.
  assert.match(src, /<ScrollArea className="md:h-\[calc\(100vh-340px\)\] md:min-h-\[400px\]">/);
  assert.doesNotMatch(src, /<ScrollArea className="h-\[calc\(100vh-340px\)\] min-h-\[400px\]">/);
});

test('returned work and Mortgage Desk pills stay readable in light mode (dark text, light text only in dark mode)', () => {
  const banner = read('src/components/loss-draft/MortgageDeskReturnedBanner.tsx');
  assert.match(banner, /font-semibold text-amber-800 dark:text-amber-100/);
  assert.match(banner, /text-\[11px\] text-amber-800\/90 dark:text-amber-100\/80/);
  assert.doesNotMatch(banner, /(?<!dark:)text-amber-100/);
  for (const rel of ['src/components/loss-draft/LossDraftDashboard.tsx', 'src/components/loss-draft/SendToMortgageDeskButton.tsx', 'src/components/loss-draft/LossDraftDetailPanel.tsx']) {
    assert.doesNotMatch(read(rel), /(?<!dark:)text-amber-200/, rel);
  }
  assert.doesNotMatch(read('src/components/loss-draft/LossDraftDetailPanel.tsx'), /(?<!dark:)text-emerald-200/);
});
