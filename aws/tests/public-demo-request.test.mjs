// Public marketing "Request demo" route (aws/functions/api/public-demo-request.mjs).
// Visitors are not signed in, so the route must work without Cognito, always mail the fixed
// support address, and refuse everything a spam bot or a hostile caller could try.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  DEMO_REQUEST_RECIPIENT,
  createDemoRequestRateLimiter,
  handlePublicDemoRequest,
} from '../functions/api/public-demo-request.mjs';

const event = (body, { method = 'POST', ip = '203.0.113.7', headers = {} } = {}) => ({
  rawPath: '/functions/v1/demo-request',
  headers,
  body: JSON.stringify(body),
  requestContext: { http: { method, path: '/functions/v1/demo-request', sourceIp: ip } },
});

const validBody = {
  name: 'Jane Doe',
  email: 'Jane@Firm.com',
  company: 'Doe Adjusting',
  role: 'PA',
  notes: 'About 200 checks a month.\nInterested in partner sharing.',
};

const recordingMailer = () => {
  const calls = [];
  const mailer = async (args) => {
    calls.push(args);
    return { mode: 'ses', results: [{ delivery: 'ses', status: 'sent', messageId: 'm-1' }] };
  };
  return { calls, mailer };
};

const allowAll = () => true;

test('anonymous request (no authorization header) sends to support@checksops.com', async () => {
  const { calls, mailer } = recordingMailer();
  const result = await handlePublicDemoRequest(event(validBody), { sendViaSesOrSink: mailer, rateLimit: allowAll });
  assert.equal(result.ok, true);
  assert.equal(result.statusCode, 200);
  assert.equal(result.success, true);
  assert.equal(result.sent, true);
  assert.equal(calls.length, 1);
  assert.equal(DEMO_REQUEST_RECIPIENT, 'support@checksops.com');
  assert.equal(calls[0].to, 'support@checksops.com');
  assert.equal(calls[0].replyTo, 'jane@firm.com');
  assert.match(calls[0].subject, /demo request: Jane Doe \(Doe Adjusting\)$/);
  assert.match(calls[0].text, /Jane Doe <jane@firm\.com>/);
  assert.match(calls[0].text, /Company: Doe Adjusting/);
  assert.match(calls[0].text, /200 checks a month/);
});

test('the caller cannot choose the recipient or the template', async () => {
  const { calls, mailer } = recordingMailer();
  await handlePublicDemoRequest(event({
    ...validBody,
    recipientEmail: 'victim@example.com',
    recipient_email: 'victim@example.com',
    to: 'victim@example.com',
    templateName: 'tenant-user-invite',
  }), { sendViaSesOrSink: mailer, rateLimit: allowAll });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].to, 'support@checksops.com');
  assert.match(calls[0].subject, /^ChecksOps demo request/);
});

test('user input is HTML-escaped in the email body', async () => {
  const { calls, mailer } = recordingMailer();
  await handlePublicDemoRequest(event({ ...validBody, name: '<script>alert(1)</script>' }), {
    sendViaSesOrSink: mailer, rateLimit: allowAll,
  });
  assert.ok(!calls[0].html.includes('<script>alert(1)</script>'));
  assert.ok(calls[0].html.includes('&lt;script&gt;'));
});

test('header injection through CR/LF in single-line fields is stripped', async () => {
  const { calls, mailer } = recordingMailer();
  await handlePublicDemoRequest(event({ ...validBody, name: 'Jane\r\nBcc: x@example.com' }), {
    sendViaSesOrSink: mailer, rateLimit: allowAll,
  });
  assert.ok(!/[\r\n]/.test(calls[0].subject));
});

test('missing name or email, a malformed email, or an oversized field is a 400 and sends nothing', async () => {
  const cases = [
    [{ ...validBody, name: '' }, 'missing_name'],
    [{ ...validBody, email: '   ' }, 'missing_email'],
    [{ ...validBody, email: 'not-an-email' }, 'invalid_email'],
    [{ ...validBody, email: 'a@b.com\r\nBcc: x@y.com' }, 'invalid_email'],
    [{ ...validBody, email: 'Jane <jane@firm.com>' }, 'invalid_email'],
    [{ ...validBody, name: 'x'.repeat(121) }, 'name_too_long'],
    [{ ...validBody, notes: 'x'.repeat(2001) }, 'notes_too_long'],
  ];
  for (const [body, error] of cases) {
    const { calls, mailer } = recordingMailer();
    const result = await handlePublicDemoRequest(event(body), { sendViaSesOrSink: mailer, rateLimit: allowAll });
    assert.equal(result.statusCode, 400, error);
    assert.equal(result.error, error);
    assert.equal(calls.length, 0, error);
  }
});

test('honeypot field answers success without sending', async () => {
  const { calls, mailer } = recordingMailer();
  const result = await handlePublicDemoRequest(event({ ...validBody, website: 'http://spam.example' }), {
    sendViaSesOrSink: mailer, rateLimit: allowAll,
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.success, true);
  assert.equal(calls.length, 0);
});

test('only POST is accepted', async () => {
  const { calls, mailer } = recordingMailer();
  const result = await handlePublicDemoRequest(event(validBody, { method: 'GET' }), {
    sendViaSesOrSink: mailer, rateLimit: allowAll,
  });
  assert.equal(result.statusCode, 405);
  assert.equal(calls.length, 0);
});

test('rate limit: 5 per IP per hour, then 429; another IP is unaffected; the window expires', async () => {
  let now = 1_000_000;
  const rateLimit = createDemoRequestRateLimiter({ now: () => now });
  const { calls, mailer } = recordingMailer();
  for (let i = 0; i < 5; i += 1) {
    const ok = await handlePublicDemoRequest(event(validBody), { sendViaSesOrSink: mailer, rateLimit });
    assert.equal(ok.statusCode, 200);
  }
  const limited = await handlePublicDemoRequest(event(validBody), { sendViaSesOrSink: mailer, rateLimit });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.error, 'rate_limited');
  const other = await handlePublicDemoRequest(event(validBody, { ip: '198.51.100.9' }), { sendViaSesOrSink: mailer, rateLimit });
  assert.equal(other.statusCode, 200);
  assert.equal(calls.length, 6);
  now += 60 * 60 * 1000;
  const later = await handlePublicDemoRequest(event(validBody), { sendViaSesOrSink: mailer, rateLimit });
  assert.equal(later.statusCode, 200);
});

test('rate limit: per-instance ceiling across many IPs', () => {
  const allow = createDemoRequestRateLimiter({ now: () => 0, perInstance: 3 });
  assert.equal(allow('a'), true);
  assert.equal(allow('b'), true);
  assert.equal(allow('c'), true);
  assert.equal(allow('d'), false);
});

test('an SES failure is a 502 so the page falls back to mailto', async () => {
  const mailer = async () => ({ mode: 'ses', results: [{ delivery: 'sink_fallback', status: 'failed', error: 'x' }] });
  const result = await handlePublicDemoRequest(event(validBody), { sendViaSesOrSink: mailer, rateLimit: allowAll });
  assert.equal(result.statusCode, 502);
  assert.equal(result.error, 'send_failed');
});

test('POST /functions/v1/demo-request reaches the public handler with no identity', async () => {
  const { handleAppServiceRequest, CLASS_A_FUNCTIONS } = await import('../functions/api/app-services.mjs');
  assert.ok(CLASS_A_FUNCTIONS.has('demo-request'));
  // No authorization header and an invalid body: the public handler answers 400 itself
  // (an identity-bound handler would answer 401 missing_cognito_token first).
  const result = await handleAppServiceRequest(
    { headers: {}, body: JSON.stringify({ name: '' }), requestContext: { http: { method: 'POST', sourceIp: '192.0.2.1' } } },
    '/functions/v1/demo-request',
    'POST',
  );
  assert.equal(result.statusCode, 400);
  assert.equal(result.error, 'missing_name');
});

test('index.mjs is untouched: the route ships as an overlay (app-services.mjs REPLACE, public-demo-request.mjs ADD)', () => {
  const source = readFileSync(new URL('../functions/api/index.mjs', import.meta.url), 'utf8');
  assert.ok(!source.includes('demo-request'));
});

test('the module never reads identity or the database', () => {
  const source = readFileSync(new URL('../functions/api/public-demo-request.mjs', import.meta.url), 'utf8');
  assert.ok(!/withIdentity|resolveClaims|loadDatabaseCredentials|from 'pg'/.test(source));
});
