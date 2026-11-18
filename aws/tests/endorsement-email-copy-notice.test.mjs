// Endorsement request emails (owner 2026-11-18): "contractor copies should not include the link. It should
// show that the email went out so contractors can notify their clients of the check", and "add the $ sign to
// emails for the endorsement request for checks".
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  formatEmailAmount,
  renderEndorsementCopyNotice,
  runAuthenticatedEndorsement,
} from '../functions/api/check-endorsement.mjs';

const TENANT = '11111111-1111-4111-8111-111111111111';
const CHECK_ID = '33333333-3333-4333-8333-333333333333';
const ENDORSE_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '66666666-6666-4666-8666-666666666666';

const fakeDb = ({ contractorEmails = [], amount = 14636.33 } = {}) => {
  const row = {
    id: ENDORSE_ID, check_id: CHECK_ID, tenant_id: TENANT, payee_id: null, payee_type: 'insured',
    payee_name: 'Natalie Hernandez', contact_email: 'natalie@example.com', status: 'pending', token: 'tok-1',
  };
  const audits = [];
  return {
    audits,
    client: {
      connect: async () => {},
      end: async () => {},
      query: async (rawSql, params = []) => {
        const sql = String(rawSql).replace(/\s+/g, ' ').trim();
        if (/^(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)/i.test(sql)) return { rows: [], rowCount: 0 };
        if (sql.includes('FROM public.check_endorsements WHERE id')) return { rows: [{ ...row }] };
        if (sql.includes('FROM public.check_intake_items')) {
          return { rows: [{ id: CHECK_ID, tenant_id: TENANT, check_number: '2000348108', carrier_name: 'Pennsylvania National', amount }] };
        }
        if (sql.includes('aws_can_write_tenant')) return { rows: [{ ok: true }] };
        if (sql.startsWith('SELECT contact_email FROM public.check_payees')) {
          assert.equal(params[0], CHECK_ID);
          return { rows: contractorEmails.map((contact_email) => ({ contact_email })) };
        }
        if (sql.includes("SET status = 'sent'")) {
          return { rows: [{ id: ENDORSE_ID, status: 'sent', request_sent_at: new Date().toISOString() }], rowCount: 1 };
        }
        if (/INSERT INTO public\.(endorsement_audit|check_audit|check_events)/i.test(sql)) audits.push({ sql, params });
        return { rows: [], rowCount: 1 };
      },
    },
  };
};

const sendWith = async ({ contractorEmails, cc, amount, failCopies = false } = {}) => {
  const { client, audits } = fakeDb({ contractorEmails, amount });
  const mails = [];
  const result = await runAuthenticatedEndorsement({
    client,
    mapping: { application_user_id: USER_ID },
    body: { action: 'send_endorsement_request', endorsementId: ENDORSE_ID, ...(cc ? { cc } : {}) },
    spoof: { ignored: true },
    event: { headers: {}, body: '{}', requestContext: { http: { method: 'POST', path: '/functions/v1/check-endorsement' } } },
    send: async (message) => {
      mails.push(message);
      if (failCopies && String(message.headers?.['X-Entity-Ref-ID'] || '').endsWith(':copy')) throw new Error('rejected');
      return undefined;
    },
  });
  return { result, mails, audits };
};

test('amounts in the emails carry the dollar sign', () => {
  assert.equal(formatEmailAmount(14636.33), '$14,636.33');
  assert.equal(formatEmailAmount('2250'), '$2,250.00');
  assert.equal(formatEmailAmount(0.5), '$0.50');
  for (const none of [null, undefined, '', 'abc']) assert.equal(formatEmailAmount(none), null, String(none));
});

test('the payee\'s request shows the amount with $ and goes to the payee alone', async () => {
  const { result, mails } = await sendWith({ contractorEmails: ['roofer@example.net'] });
  assert.equal(result.ok, true, JSON.stringify(result));
  const request = mails[0];
  assert.equal(request.to, 'natalie@example.com');
  assert.equal(request.cc, undefined, 'no one is copied on the email that carries the signing link');
  assert.match(request.text, /Amount: \$14,636\.33/);
  assert.match(request.html, /Amount: \$14,636\.33/);
  assert.match(request.text, /\/endorse\?token=/, 'the payee\'s own email keeps the signing link');
});

test('contractor payees and the CC box get a notice that the request went out, without the link', async () => {
  const { result, mails } = await sendWith({
    contractorEmails: ['roofer@example.net', 'Natalie@Example.com', ''],
    cc: ['office@example.org', 'ROOFER@example.net'],
  });
  assert.equal(result.ok, true);
  // One request to the payee, then one notice per distinct copied address (never the payee herself).
  assert.deepEqual(mails.map((m) => m.to), ['natalie@example.com', 'office@example.org', 'ROOFER@example.net']);
  for (const notice of mails.slice(1)) {
    assert.equal(notice.cc, undefined);
    assert.match(notice.subject, /^Endorsement request sent — Check #2000348108 — Natalie Hernandez$/);
    assert.doesNotMatch(notice.html, /endorse\?token=|tok-1|Review and endorse/, 'no signing link or button');
    assert.doesNotMatch(notice.text, /endorse\?token=|tok-1/);
    assert.match(notice.text, /sent an endorsement request to Natalie Hernandez for check #2000348108/);
    assert.match(notice.text, /Amount: \$14,636\.33/);
    assert.match(notice.text, /let Natalie Hernandez know the check is waiting for their endorsement/);
    assert.doesNotMatch(notice.text, /natalie@example\.com/i, 'the payee\'s address is not shared');
  }
  assert.equal(result.copyNoticesSent, 2);
  assert.equal(result.copyNoticesFailed, 0);
});

test('a copy that cannot be delivered never fails the request itself', async () => {
  const { result, mails } = await sendWith({ contractorEmails: ['roofer@example.net'], failCopies: true });
  assert.equal(result.ok, true);
  assert.equal(result.emailSent, true);
  assert.equal(mails.length, 2);
  assert.equal(result.copyNoticesSent, 0);
  assert.equal(result.copyNoticesFailed, 1);
});

test('no copies when there is nobody to copy', async () => {
  const { result, mails } = await sendWith({});
  assert.equal(result.ok, true);
  assert.equal(mails.length, 1);
  assert.equal(result.copyNoticesSent, 0);
});

test('the notice uses the tenant\'s name and leaves out a missing amount', () => {
  const notice = renderEndorsementCopyNotice({
    endorsement: { payee_name: 'Sam Lee' },
    check: { check_number: '101', carrier_name: 'Acme Mutual', amount: null },
    branding: { company_name: 'Acme Restoration' },
  });
  assert.match(notice.text, /Acme Restoration sent an endorsement request to Sam Lee for check #101 from Acme Mutual\./);
  assert.doesNotMatch(notice.text, /Amount:/);
});
