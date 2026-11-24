/**
 * Endorsement request email status in the Endorsements card (owner 2026-11-19):
 *   "Is there anyway for tenants to see if an email has been delivered and opened? For this to show up near the payee
 *   signature request", then "Yeah build 1 and 2": delivered or bounced from Resend's delivery reports, and when the
 *   payee opened the signing link. Owner 2026-11-23, "Yes build opened and clicked", then "Build the opened and clicked
 *   display on the website": Resend's email opened and link clicked reports (SQL 172), for the current request only.
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
  for (const label of ['Check the email address and resend.', 'Marked as spam by the recipient', 'Delivered {format(', 'Delivery pending', 'Link opened {format(']) {
    assert.ok(list.includes(label), label);
  }
  // Since SQL 172 (owner 2026-11-23, "Build the opened and clicked display on the website"), Resend's opened and clicked
  // reports show too, with a note that a mail app can open an email automatically.
  for (const label of ['Email opened {format(', 'Email link clicked {format(', 'Some mail apps open emails automatically']) {
    assert.ok(list.includes(label), label);
  }
  assert.match(list, /\{emailStatus\.tracked && \(emailStatus\.delivery \|\| emailStatus\.linkOpenedAt \|\| emailStatus\.emailOpenedAt \|\| emailStatus\.emailClickedAt\) && \(/);
  // The card reads every column of the row, so SQL 170's columns arrive without a query change.
  assert.match(list, /selectOwnerThenPartner\("check_endorsements", PARTNER_CHECK_ENDORSEMENTS, \(from\) =>\s*\n\s*from\s*\n?\s*\.select\("\*"\)/);
});

const SENT2 = '2026-11-20T10:00:00Z';

test('SQL 172: opened and clicked after the latest send show with their counts', () => {
  const status = endorsementEmailStatus({
    request_sent_at: SENT, email_message_id: 're_1', email_delivered_at: '2026-11-18T13:36:52Z',
    email_first_opened_at: '2026-11-18T14:00:00Z', email_last_opened_at: '2026-11-18T16:00:00Z', email_open_count: 3,
    email_first_clicked_at: '2026-11-18T14:05:00Z', email_last_clicked_at: '2026-11-18T14:05:00Z', email_click_count: 1,
  });
  assert.equal(status.emailOpenedAt, '2026-11-18T16:00:00Z');
  assert.equal(status.emailOpenCount, 3);
  assert.equal(status.emailClickedAt, '2026-11-18T14:05:00Z');
  assert.equal(status.emailClickCount, 1);
});

test('SQL 172: reports older than the latest send are hidden; a count mixing two sends is not shown', () => {
  const old = endorsementEmailStatus({
    request_sent_at: SENT2, email_message_id: 're_2',
    email_first_opened_at: '2026-11-18T14:00:00Z', email_last_opened_at: '2026-11-18T16:00:00Z', email_open_count: 2,
  });
  assert.equal(old.emailOpenedAt, null);
  assert.equal(old.emailOpenCount, 0);
  const mixed = endorsementEmailStatus({
    request_sent_at: SENT2, email_message_id: 're_2',
    email_first_opened_at: '2026-11-18T14:00:00Z', email_last_opened_at: '2026-11-20T11:00:00Z', email_open_count: 4,
  });
  assert.equal(mixed.emailOpenedAt, '2026-11-20T11:00:00Z');
  assert.equal(mixed.emailOpenCount, 0);
});

test('SQL 172: before the columns exist, or with no report, nothing new shows', () => {
  const before = endorsementEmailStatus({ request_sent_at: SENT, email_message_id: 're_1', email_delivered_at: '2026-11-18T13:36:52Z' });
  assert.equal(before.emailOpenedAt, null);
  assert.equal(before.emailClickedAt, null);
  const none = endorsementEmailStatus({ request_sent_at: SENT, email_message_id: 're_1', email_open_count: 0, email_click_count: 0, email_first_opened_at: null, email_last_opened_at: null });
  assert.equal(none.emailOpenedAt, null);
  assert.equal(none.emailClickCount, 0);
  assert.equal(endorsementEmailStatus(null).emailOpenedAt, null);
});
