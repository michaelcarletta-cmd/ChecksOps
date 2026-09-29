import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  runSendSignatureRequest,
  signatureRequestAlreadyComplete,
} from '../functions/api/esign.mjs';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '55555555-5555-4555-8555-555555555555';
const CLAIM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REQUEST = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SIGNER = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const mapping = { application_user_id: USER };
const spoof = { ignored: true };

const sqlClient = (handlers, seen) => ({
  query: async (sql, params = []) => {
    const compact = String(sql).replace(/\s+/g, ' ');
    seen?.push({ sql: compact, params });
    for (const handler of handlers) {
      if (handler.match(compact, params)) return handler.result(params, compact);
    }
    return { rows: [], rowCount: 0 };
  },
});

const capturingMailer = (sent) => async (payload) => {
  sent.push(payload);
  return { deliveredCount: 0, sunkCount: 1, mode: 'sink', results: [{ delivery: 'sink', messageId: 'sink-1' }] };
};

const writeTenantHandlers = (request, signers) => ([
  {
    match: (sql) => sql.includes('FROM public.signature_requests'),
    result: () => ({ rows: [request] }),
  },
  {
    match: (sql) => sql.includes('FROM public.signature_signers'),
    result: () => ({ rows: signers }),
  },
  {
    match: (sql) => sql.includes('FROM public.claims'),
    result: () => ({ rows: [{ id: CLAIM, claim_number: 'CL-1', policyholder_name: 'Ada', tenant_id: TENANT }] }),
  },
  {
    match: (sql) => sql.includes('aws_can_write_tenant'),
    result: () => ({ rows: [{ ok: true }] }),
  },
  {
    match: (sql) => sql.includes('UPDATE public.signature_signers'),
    result: () => ({ rows: [{ id: SIGNER }], rowCount: 1 }),
  },
  {
    match: (sql) => sql.includes('UPDATE public.signature_requests'),
    result: () => ({ rows: [{ id: REQUEST, status: 'pending', delivery_mode: 'aws_ses_or_sink', sent_at: new Date().toISOString() }], rowCount: 1 }),
  },
]);

test('signatureRequestAlreadyComplete detects completed, signed, and all-signers-signed', () => {
  assert.equal(signatureRequestAlreadyComplete({ status: 'completed' }, [{ status: 'signed' }]), true);
  assert.equal(signatureRequestAlreadyComplete({ status: 'signed' }, [{ status: 'pending' }]), true);
  assert.equal(signatureRequestAlreadyComplete({ status: 'pending' }, [{ status: 'signed' }]), true);
  assert.equal(signatureRequestAlreadyComplete({ status: 'COMPLETED' }, []), true);
  assert.equal(signatureRequestAlreadyComplete({ status: 'pending' }, [{ status: 'pending' }]), false);
  assert.equal(signatureRequestAlreadyComplete({ status: 'failed' }, [{ status: 'pending' }]), false);
  assert.equal(signatureRequestAlreadyComplete({ status: 'pending' }, []), false);
  assert.equal(signatureRequestAlreadyComplete({}, [{ signer_email: 'ada@example.com' }]), false);
  assert.equal(signatureRequestAlreadyComplete({ status: 'pending' }, [
    { status: 'signed' },
    { status: 'pending' },
  ]), false);
});

test('resend of a completed request returns 409 already_signed with zero mutation', async () => {
  const sent = [];
  const seen = [];
  const result = await runSendSignatureRequest({
    mapping,
    spoof,
    body: { requestId: REQUEST },
    send: capturingMailer(sent),
    client: sqlClient(writeTenantHandlers(
      { id: REQUEST, status: 'completed', document_name: 'Release', claim_id: CLAIM, field_data: [] },
      [{ id: SIGNER, status: 'signed', signer_name: 'Ada', signer_email: 'ada@example.com' }],
    ), seen),
  });
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 409);
  assert.equal(result.error, 'already_signed');
  assert.equal(sent.length, 0);
  assert.equal(seen.some((row) => /\bUPDATE\b/i.test(row.sql)), false);
  assert.equal(seen.some((row) => /\bINSERT\b/i.test(row.sql)), false);
  assert.equal(seen.some((row) => row.sql.includes('esign_event_logs') || row.sql.includes('logEvent')), false);
});

test('resend of pending-status request with all signers signed returns 409 and does not remint', async () => {
  const sent = [];
  const seen = [];
  const result = await runSendSignatureRequest({
    mapping,
    spoof,
    body: { requestId: REQUEST },
    send: capturingMailer(sent),
    client: sqlClient(writeTenantHandlers(
      { id: REQUEST, status: 'pending', document_name: 'Release', claim_id: CLAIM, field_data: [] },
      [{ id: SIGNER, status: 'signed', signer_name: 'Ada', signer_email: 'ada@example.com' }],
    ), seen),
  });
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 409);
  assert.equal(result.error, 'already_signed');
  assert.equal(sent.length, 0);
  assert.equal(seen.some((row) => row.sql.includes('SET access_token')), false);
  assert.equal(seen.some((row) => /\bUPDATE\b/i.test(row.sql)), false);
});

test('resend of an eligible pending request still remints and sends', async () => {
  const sent = [];
  const seen = [];
  const result = await runSendSignatureRequest({
    mapping,
    spoof,
    body: { requestId: REQUEST },
    send: capturingMailer(sent),
    client: sqlClient(writeTenantHandlers(
      { id: REQUEST, status: 'pending', document_name: 'Release', claim_id: CLAIM, field_data: [] },
      [{ id: SIGNER, status: 'pending', signer_name: 'Ada', signer_email: 'ada@example.com' }],
    ), seen),
  });
  assert.equal(result.ok, true);
  assert.equal(result.statusCode, 200);
  assert.equal(sent.length, 1);
  assert.equal(seen.some((row) => row.sql.includes('SET access_token')), true);
  assert.equal(seen.some((row) => row.sql.includes('UPDATE public.signature_requests')), true);
  assert.equal(result.persisted?.id, REQUEST);
});
