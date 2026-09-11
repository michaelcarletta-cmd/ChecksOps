import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyRecipientPolicy,
  emailMode,
  isAllowlistedRecipient,
} from '../functions/api/email-policy.mjs';
import {
  applySmsRecipientPolicy,
  smsMode,
  normalizePhone,
} from '../functions/api/sms-policy.mjs';
import { CLASS_A_FUNCTIONS, functionNameFromPath } from '../functions/api/app-services.mjs';
import { renderTransactionalTemplate, TEMPLATE_NAMES } from '../functions/api/email-templates.mjs';
import { parseCheckFields } from '../functions/api/ocr-parse.mjs';
import { CLASS_A_SCHEDULED_JOBS } from '../functions/api/scheduled.mjs';

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
  process.env.AWS_EMAIL_MODE = prev;
});

test('sms policy sinks production-looking numbers by default', () => {
  const prev = process.env.AWS_SMS_MODE;
  delete process.env.AWS_SMS_MODE;
  assert.equal(smsMode(), 'sink');
  const row = applySmsRecipientPolicy('+15551234567');
  assert.equal(row.delivery, 'sink');
  assert.equal(normalizePhone('5551234567'), '+15551234567');
  process.env.AWS_SMS_MODE = prev;
});

test('class A registry includes final cleanup functions', () => {
  assert.equal(functionNameFromPath('/functions/v1/homeowner-upload-otp-start'), 'homeowner-upload-otp-start');
  for (const name of [
    'generate-checksops-doc',
    'tenant-invite-user',
    'hire-mortgage-agent',
    'send-sms',
    'process-email-queue',
    'homeowner-upload-otp-verify',
    'tenant-domain-check',
    'tenant-tax-profiles',
  ]) {
    assert.ok(CLASS_A_FUNCTIONS.has(name), name);
  }
  assert.ok(!CLASS_A_FUNCTIONS.has('moov-disburse'));
  assert.ok(CLASS_A_SCHEDULED_JOBS.has('process-email-queue'));
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
});

test('allowlist recognizes staging domains', () => {
  assert.equal(isAllowlistedRecipient('staging-master@checksops.invalid'), true);
  assert.equal(isAllowlistedRecipient('random@gmail.com'), false);
});
