import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sendPayeeSetupEmail } from '../functions/api/providers/payees/email.mjs';
import { PLATFORM_ENDORSEMENT_FROM } from '../functions/api/endorsement-parity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HANDLERS = fs.readFileSync(path.join(ROOT, 'aws/functions/api/providers/payees/handlers.mjs'), 'utf8');

delete process.env.RESEND_API_KEY;
delete process.env.AWS_EMAIL_ALLOWLIST_DOMAINS;
delete process.env.AWS_EMAIL_ALLOWLIST_EXACT;

const loadSecrets = async () => ({ RESEND_API_KEY: 're_test_key' });
const MESSAGE = { subject: 'Set up', html: '<p>link</p>', text: 'link' };

const recorder = (response = { ok: true, status: 200, json: async () => ({ id: 'msg_1' }) }) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return response;
  };
  return { calls, fetchImpl };
};

test('staging: an allowlisted payee is emailed through Resend with the platform From', async () => {
  const { calls, fetchImpl } = recorder();
  const out = await sendPayeeSetupEmail({ ...MESSAGE, to: ' Claims@FreedomAdj.com ', branding: { replyTo: 'support@checksops.com' }, fetchImpl, loadSecrets });
  assert.deepEqual(out, { mode: 'resend', results: [{ status: 'sent', messageId: 'msg_1' }] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer re_test_key');
  assert.deepEqual(calls[0].body, {
    from: PLATFORM_ENDORSEMENT_FROM,
    to: ['claims@freedomadj.com'],
    subject: 'Set up',
    html: '<p>link</p>',
    text: 'link',
    reply_to: 'support@checksops.com',
  });
});

test('staging: a payee outside the allowlist is blocked and Resend is never called', async () => {
  const { calls, fetchImpl } = recorder();
  const out = await sendPayeeSetupEmail({ ...MESSAGE, to: 'someone@gmail.com', fetchImpl, loadSecrets });
  assert.deepEqual(out.results.map((r) => r.status), ['blocked']);
  assert.equal(calls.length, 0);
});

test('production: any payee address is emailed', async () => {
  const { calls, fetchImpl } = recorder();
  const out = await sendPayeeSetupEmail({ ...MESSAGE, to: 'someone@gmail.com', production: true, fetchImpl, loadSecrets });
  assert.deepEqual(out.results.map((r) => r.status), ['sent']);
  assert.deepEqual(calls[0].body.to, ['someone@gmail.com']);
});

test('a verified tenant sender is used; an unverified one falls back to the platform From', async () => {
  const verified = recorder();
  await sendPayeeSetupEmail({ ...MESSAGE, to: 'claims@freedomadj.com', branding: { usingCustomFrom: true, from: 'Acme <pay@notify.acme.com>' }, fetchImpl: verified.fetchImpl, loadSecrets });
  assert.equal(verified.calls[0].body.from, 'Acme <pay@notify.acme.com>');
  const unverified = recorder();
  await sendPayeeSetupEmail({ ...MESSAGE, to: 'claims@freedomadj.com', branding: { usingCustomFrom: false, from: 'Acme via ChecksOps <noreply@checksops.com>' }, fetchImpl: unverified.fetchImpl, loadSecrets });
  assert.equal(unverified.calls[0].body.from, PLATFORM_ENDORSEMENT_FROM);
});

test('a Resend refusal, a missing key or a missing address reports failed without the provider message', async () => {
  const refused = recorder({ ok: false, status: 422, json: async () => ({ message: 'contains https://app/pay-setup/secret' }) });
  const out = await sendPayeeSetupEmail({ ...MESSAGE, to: 'claims@freedomadj.com', fetchImpl: refused.fetchImpl, loadSecrets });
  assert.deepEqual(out.results, [{ status: 'failed', reason: 'resend_422' }]);
  assert.doesNotMatch(JSON.stringify(out), /secret/);

  const { calls, fetchImpl } = recorder();
  const noKey = await sendPayeeSetupEmail({ ...MESSAGE, to: 'claims@freedomadj.com', fetchImpl, loadSecrets: async () => ({}) });
  assert.deepEqual(noKey.results, [{ status: 'failed', reason: 'resend_not_configured' }]);
  const noAddress = await sendPayeeSetupEmail({ ...MESSAGE, to: '', fetchImpl, loadSecrets });
  assert.deepEqual(noAddress.results, [{ status: 'failed', reason: 'missing_email' }]);
  assert.equal(calls.length, 0);
});

test('the setup link handler sends through Resend, production only for a production payee deployment', () => {
  assert.match(HANDLERS, /typeof deps\.sendEmail === 'function' \? deps\.sendEmail : sendPayeeSetupEmail/);
  assert.match(HANDLERS, /production: payeeDeployment\(\) === 'production'/);
  assert.doesNotMatch(HANDLERS, /sendViaSesOrSink/);
});
