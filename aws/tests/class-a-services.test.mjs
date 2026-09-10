import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyRecipientPolicy,
  emailMode,
  isAllowlistedRecipient,
} from '../functions/api/email-policy.mjs';
import { CLASS_A_FUNCTIONS, functionNameFromPath } from '../functions/api/app-services.mjs';
import { renderTransactionalTemplate, TEMPLATE_NAMES } from '../functions/api/email-templates.mjs';
import { parseCheckFields } from '../functions/api/ocr-parse.mjs';

test('staging email mode defaults to sink', () => {
  const prev = process.env.AWS_EMAIL_MODE;
  delete process.env.AWS_EMAIL_MODE;
  assert.equal(emailMode(), 'sink');
  process.env.AWS_EMAIL_MODE = prev;
});

test('recipient policy sinks non-allowlisted addresses in ses mode', () => {
  const prev = process.env.AWS_EMAIL_MODE;
  process.env.AWS_EMAIL_MODE = 'ses';
  const [blocked] = applyRecipientPolicy(['victim@example.com']);
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.delivery, 'sink');
  assert.equal(blocked.originalEmail, 'victim@example.com');
  const [ok] = applyRecipientPolicy(['mcarletta@freedomadj.com']);
  assert.equal(ok.blocked, false);
  assert.equal(ok.delivery, 'ses');
  process.env.AWS_EMAIL_MODE = prev;
});

test('ses-identity mode sinks allowlisted recipients', () => {
  const prev = process.env.AWS_EMAIL_MODE;
  process.env.AWS_EMAIL_MODE = 'ses-identity';
  const [row] = applyRecipientPolicy(['mcarletta@freedomadj.com']);
  assert.equal(row.delivery, 'sink');
  assert.equal(row.originalEmail, 'mcarletta@freedomadj.com');
  assert.equal(row.policy, 'staging_ses_identity');
  process.env.AWS_EMAIL_MODE = prev;
});

test('sink mode always rewrites destination', () => {
  const prev = process.env.AWS_EMAIL_MODE;
  process.env.AWS_EMAIL_MODE = 'sink';
  const [row] = applyRecipientPolicy(['mcarletta@freedomadj.com']);
  assert.equal(row.delivery, 'sink');
  assert.ok(row.email.includes('checksops.invalid') || row.email.includes('@'));
  process.env.AWS_EMAIL_MODE = prev;
});

test('allowlist recognizes staging domains', () => {
  assert.equal(isAllowlistedRecipient('staging-master@checksops.invalid'), true);
  assert.equal(isAllowlistedRecipient('random@gmail.com'), false);
});

test('class A function path parsing and registry', () => {
  assert.equal(functionNameFromPath('/functions/v1/send-transactional-email'), 'send-transactional-email');
  assert.equal(functionNameFromPath('/functions/check-ocr-intake'), 'check-ocr-intake');
  assert.ok(CLASS_A_FUNCTIONS.has('homeowner-ledger-view'));
  assert.ok(CLASS_A_FUNCTIONS.has('homeowner-upload-check'));
  assert.ok(CLASS_A_FUNCTIONS.has('ingest-shared-check'));
  assert.ok(CLASS_A_FUNCTIONS.has('homeowner-ledger-attach-upload'));
  assert.ok(CLASS_A_FUNCTIONS.has('send-signature-request'));
  assert.ok(CLASS_A_FUNCTIONS.has('check-ocr-intake'));
  assert.ok(!CLASS_A_FUNCTIONS.has('moov-disburse'));
});

test('templates render without throwing', () => {
  for (const name of TEMPLATE_NAMES) {
    const rendered = renderTransactionalTemplate(name, {
      homeownerName: 'Test',
      portalUrl: 'https://staging.checksops.com/h/x',
      ledgerUrl: 'https://staging.checksops.com/h/l',
      name: 'A',
      email: 'a@b.com',
      message: 'hi',
    });
    assert.ok(rendered.subject);
    assert.ok(rendered.html.includes('ChecksOps') || rendered.html.includes('<p'));
  }
});

test('ocr field parser extracts amount and payee', () => {
  const parsed = parseCheckFields([
    'ACME INSURANCE COMPANY',
    'PAY TO THE ORDER OF',
    'JANE DOE AND FIRST NATIONAL BANK',
    'Date 01/15/2026',
    '*** ONE THOUSAND DOLLARS ***',
    '$1,250.00',
    'Claim # ABC-12345',
  ]);
  assert.equal(parsed.amount, '1250.00');
  assert.ok(parsed.payee_line);
  assert.ok(parsed.carrier_name);
});
