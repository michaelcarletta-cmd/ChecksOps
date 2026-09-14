import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLASS_A_FUNCTIONS, handleAppServiceRequest } from '../functions/api/app-services.mjs';
import { sql71EmailAuditHandle } from './sql71-email-audit-mock.mjs';
import {
  buildPaymentDirectionEmail,
  runSendPaymentDirectionRequest,
} from '../functions/api/payment-direction-email.mjs';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const CLAIM_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CHECK_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const sqlClient = (handlers) => {
  const logs = new Map();
  const audit = sql71EmailAuditHandle({ logs });
  return {
    query: async (sql, params = []) => {
      const compact = String(sql).replace(/\s+/g, ' ');
      const hit = audit(compact, params);
      if (hit) return hit;
      for (const handler of handlers) {
        if (handler.match(compact, params)) return handler.result(params, compact);
      }
      return { rows: [], rowCount: 0 };
    },
  };
};

test('send-payment-direction-request is Class A SES/sink not Resend', async () => {
  assert.ok(CLASS_A_FUNCTIONS.has('send-payment-direction-request'));
  const denied = await handleAppServiceRequest({
    body: '{}',
    requestContext: { http: { method: 'POST', path: '/functions/v1/send-payment-direction-request' } },
  }, '/functions/v1/send-payment-direction-request', 'POST');
  assert.equal(denied.statusCode, 401);
  assert.notEqual(denied.error, 'provider_disabled');

  const mail = buildPaymentDirectionEmail({
    policyholderName: 'Ada',
    claimNumber: 'CL-1',
    requestUrl: 'https://staging.checksops.com/payment-direction/x',
  });
  assert.match(mail.subject, /Payment direction/i);
  assert.match(mail.html, /payment-direction\/x/);
});

test('payment direction send is tenant-isolated and uses injected SES/sink', async () => {
  const sent = [];
  const cross = await runSendPaymentDirectionRequest({
    spoof: { ignored: true, headerTenantId: 'other' },
    body: { claimId: CLAIM_ID, checkId: CHECK_ID, requestUrl: 'https://example.test/pd' },
    send: async () => { throw new Error('should not send'); },
    client: sqlClient([
      {
        match: (sql) => sql.includes('FROM public.claims'),
        result: () => ({ rows: [{ id: CLAIM_ID, tenant_id: TENANT_A, policyholder_email: 'a@b.c', policyholder_name: 'Ada' }] }),
      },
      {
        match: (sql) => sql.includes('aws_can_write_tenant'),
        result: () => ({ rows: [{ ok: false }] }),
      },
    ]),
  });
  assert.equal(cross.statusCode, 403);

  const ok = await runSendPaymentDirectionRequest({
    spoof: { ignored: true },
    body: { claimId: CLAIM_ID, checkId: CHECK_ID, requestUrl: 'https://example.test/pd' },
    send: async (payload) => {
      sent.push(payload);
      return { deliveredCount: 0, sunkCount: 1, results: [{ delivery: 'sink', status: 'sunk', messageId: 'sink-pd' }] };
    },
    client: sqlClient([
      {
        match: (sql) => sql.includes('FROM public.claims'),
        result: () => ({ rows: [{
          id: CLAIM_ID,
          tenant_id: TENANT_A,
          policyholder_email: 'ada@example.com',
          policyholder_name: 'Ada',
          claim_number: 'CL-1',
        }] }),
      },
      {
        match: (sql) => sql.includes('aws_can_write_tenant'),
        result: () => ({ rows: [{ ok: true }] }),
      },
    ]),
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.results.sms, false);
  assert.equal(ok.telnyxCalled, false);
  assert.equal(ok.resendCalled, false);
  assert.equal(ok.results.provider, 'aws_ses_or_sink');
  assert.equal(sent[0].to, 'ada@example.com');
});
