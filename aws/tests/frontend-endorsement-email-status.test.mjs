/**
 * Endorsement request email status in the Endorsements card (owner 2026-11-19):
 *   "Is there anyway for tenants to see if an email has been delivered and opened? For this to show up near the payee
 *   signature request", then "Yeah build 1 and 2": delivered or bounced from Resend's delivery reports, and when the
 *   payee opened the signing link. No tracking pixel ("email opened" is not shown).
 *
 * The fields are SQL 170's check_endorsements columns. Until SQL 170 is applied they are absent and the card shows
 * only what it showed before ("Last sent ...").
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { endorsementEmailStatus } from '../../src/lib/endorsementEmailStatus.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const SENT = '2026-11-18T13:36:50Z';

test('before SQL 170 the row has none of the columns: nothing is tracked, the card shows only "Last sent"', () => {
  const status = endorsementEmailStatus({ request_sent_at: SENT });
  assert.equal(status.tracked, false);
  assert.equal(status.delivery, null);
  assert.equal(status.linkOpenedAt, null);
  assert.equal(endorsementEmailStatus(null).tracked, false);
});

test('after a send with no report yet: Delivery pending', () => {
  const status = endorsementEmailStatus({
    request_sent_at: SENT, email_message_id: 're_1', email_delivered_at: null, email_bounced_at: null,
    email_complained_at: null, link_first_opened_at: null, link_last_opened_at: null, link_open_count: 0,
  });
  assert.equal(status.tracked, true);
  assert.equal(status.delivery, 'pending');
  assert.equal(status.linkOpenCount, 0);
});

test('delivered, then the link opened three times', () => {
  const status = endorsementEmailStatus({
    request_sent_at: SENT, email_message_id: 're_1', email_delivered_at: '2026-11-18T13:36:52Z',
    link_first_opened_at: '2026-11-18T14:10:00Z', link_last_opened_at: '2026-11-18T15:00:00Z', link_open_count: 3,
  });
  assert.equal(status.delivery, 'delivered');
  assert.equal(status.deliveredAt, '2026-11-18T13:36:52Z');
  assert.equal(status.linkOpenedAt, '2026-11-18T15:00:00Z');
  assert.equal(status.linkOpenCount, 3);
});

test('a bounce outranks delivery and keeps its reason; a complaint outranks delivery', () => {
  const bounced = endorsementEmailStatus({
    request_sent_at: SENT, email_delivered_at: '2026-11-18T13:36:52Z', email_bounced_at: '2026-11-18T13:37:00Z',
    email_bounce_reason: 'Mailbox does not exist',
  });
  assert.equal(bounced.delivery, 'bounced');
  assert.equal(bounced.bounceReason, 'Mailbox does not exist');
  const complained = endorsementEmailStatus({
    request_sent_at: SENT, email_delivered_at: '2026-11-18T13:36:52Z', email_complained_at: '2026-11-18T16:00:00Z',
  });
  assert.equal(complained.delivery, 'complained');
});

test('the card renders the line under "Last sent", only for tracked rows, with the agreed labels', () => {
  const list = read('src/components/check-review/EndorsementChecklist.tsx');
  assert.match(list, /import \{ endorsementEmailStatus, type EndorsementEmailFields \} from "@\/lib\/endorsementEmailStatus";/);
  assert.match(list, /interface CheckEndorsement extends EndorsementEmailFields \{/);
  assert.match(list, /const emailStatus = endorsementEmailStatus\(endorsement\);/);
  // The existing "Last sent" line is unchanged and comes first.
  const lastSent = list.indexOf('Last sent {format(new Date(endorsement.request_sent_at), "MMM d h:mm a")}');
  const block = list.indexOf('data-endorsement-email-status=""');
  assert.ok(lastSent > 0 && block > lastSent, 'status line sits under "Last sent"');
  assert.match(list, /\{emailStatus\.tracked && \(emailStatus\.delivery \|\| emailStatus\.linkOpenedAt\) && \(/);
  for (const label of ['Check the email address and resend.', 'Marked as spam by the recipient', 'Delivered {format(', 'Delivery pending', 'Link opened {format(']) {
    assert.ok(list.includes(label), label);
  }
  // No "email opened" (tracking pixel) state is shown.
  assert.doesNotMatch(list, /Email opened/);
  // The card reads every column of the row, so SQL 170's columns arrive without a query change.
  assert.match(list, /selectOwnerThenPartner\("check_endorsements", PARTNER_CHECK_ENDORSEMENTS, \(from\) =>\s*\n\s*from\s*\n?\s*\.select\("\*"\)/);
});
