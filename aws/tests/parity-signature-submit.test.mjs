import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { handler } from '../functions/api/index.mjs';
import { hashToken } from '../functions/api/esign.mjs';
import {
  normalizeFieldValues,
  runPublicSignatureSubmit,
  validateRequiredFields,
} from '../functions/api/signature-submit.mjs';

const sqlClient = (handlers) => ({
  query: async (sql, params = []) => {
    const compact = String(sql).replace(/\s+/g, ' ');
    if (/^BEGIN|COMMIT|ROLLBACK|SET TRANSACTION/i.test(compact.trim())) return { rows: [], rowCount: 0 };
    for (const handler of handlers) {
      if (handler.match(compact, params)) return handler.result(params, compact);
    }
    return { rows: [], rowCount: 0 };
  },
  connect: async () => {},
  end: async () => {},
});

const eventOf = (body = {}, headers = {}) => ({
  headers,
  body: JSON.stringify(body),
  requestContext: { http: { method: 'POST', path: '/public/signature-submit' } },
});

test('token hash matches e-sign SHA-256', () => {
  assert.equal(hashToken('abc'), createHash('sha256').update('abc', 'utf8').digest('hex'));
});

test('required field validation covers signature checkbox and text', () => {
  const fields = [
    { id: 'sig', type: 'signature', label: 'Sign', required: true },
    { id: 'box', type: 'checkbox', label: 'Agree', required: true },
    { id: 'name', type: 'text', label: 'Name', required: true },
  ];
  const errors = validateRequiredFields(fields, { sig: 'typed:x', box: false, name: '' });
  assert.equal(errors.length, 3);
  const ok = validateRequiredFields(fields, { sig: 'data:image/png;base64,x', box: true, name: 'Ada' });
  assert.equal(ok.length, 0);
  const normalized = normalizeFieldValues(fields, { sig: 'data:image/png;base64,x' });
  assert.equal(normalized.sig.field_type, 'signature');
});

test('public signature submit abuse and happy path', async () => {
  const missing = await runPublicSignatureSubmit(eventOf({}));
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.stage, 'validate_token');

  const noConsent = await runPublicSignatureSubmit(eventOf({ token: 'tok' }));
  assert.equal(noConsent.statusCode, 400);
  assert.equal(noConsent.stage, 'esign_consent');

  const unknown = await runPublicSignatureSubmit(eventOf({
    token: 'tok',
    eSignConsentAccepted: true,
  }), { client: sqlClient([]) });
  assert.equal(unknown.statusCode, 404);

  const expired = await runPublicSignatureSubmit(eventOf({
    token: 'tok',
    eSignConsentAccepted: true,
  }), {
    client: sqlClient([{
      match: (sql) => sql.includes('aws_public_signature_by_token_hash'),
      result: () => ({ rows: [{
        doc: {
          signer: { id: 's1', status: 'pending', expires_at: '2000-01-01T00:00:00.000Z', signing_order: 1 },
          request: { id: 'r1', document_name: 'Release' },
          waiting_for: [],
          fields: [],
        },
      }] }),
    }]),
  });
  assert.equal(expired.statusCode, 403);
  assert.equal(expired.stage, 'token_expired');

  const blocked = await runPublicSignatureSubmit(eventOf({
    token: 'tok',
    eSignConsentAccepted: true,
    fieldValues: {},
  }), {
    client: sqlClient([{
      match: (sql) => sql.includes('aws_public_signature_by_token_hash'),
      result: () => ({ rows: [{
        doc: {
          signer: { id: 's2', status: 'pending', expires_at: null, signing_order: 2 },
          request: { id: 'r1', document_name: 'Release' },
          waiting_for: [{ id: 's1' }],
          fields: [],
        },
      }] }),
    }]),
  });
  assert.equal(blocked.statusCode, 403);
  assert.equal(blocked.stage, 'signer_order_blocked');
});

test('successful submit completes request without deposit RPCs', async () => {
  let flattenCalled = false;
  const sqls = [];
  const result = await runPublicSignatureSubmit(eventOf({
    token: 'tok',
    eSignConsentAccepted: true,
    fieldValues: { sig: 'data:image/png;base64,x' },
  }, { 'x-tenant-id': 'spoof-tenant' }), {
    flattenPdf: async () => { flattenCalled = true; },
    client: sqlClient([
      {
        match: (sql) => sql.includes('aws_public_signature_by_token_hash'),
        result: () => ({ rows: [{
          doc: {
            signer: { id: 's1', status: 'pending', expires_at: null, signing_order: 1, signer_name: 'Ada' },
            request: {
              id: 'r1',
              document_name: 'Release',
              document_path: 'check-intake/c1/files/doc.pdf',
              claim_id: 'claim-1',
              field_data: [{ id: 'sig', type: 'signature', signerIndex: 0, required: true, label: 'Sign' }],
            },
            waiting_for: [],
            fields: [{ id: 'sig', field_type: 'signature', required: true, label: 'Sign' }],
          },
        }] }),
      },
      {
        match: (sql) => sql.includes('aws_public_signature_submit'),
        result: (_params, sql) => {
          sqls.push(sql);
          return { rows: [{
            doc: {
              ok: true,
              all_signed: true,
              request_completed: true,
              request_id: 'r1',
              claim_id: 'claim-1',
              document_path: 'check-intake/c1/files/doc.pdf',
              document_name: 'Release',
              final_rel: 'signed/claim-1/r1-final.pdf',
            },
          }] };
        },
      },
    ]),
  });
  assert.equal(result.ok, true);
  assert.equal(result.allSigned, true);
  assert.equal(result.depositAdvanceDenied, true);
  assert.equal(result.spoofFieldsIgnored.headerTenantId, 'spoof-tenant');
  assert.equal(flattenCalled, true);
  assert.equal(sqls.some((sql) => /record_check_return|ready_for_deposit|approved_for_deposit/.test(sql)), false);
});

test('public signature-submit is no longer writes_disabled', async () => {
  const result = await handler({
    requestContext: { http: { method: 'POST', path: '/public/signature-submit' } },
    body: JSON.stringify({ token: 'x' }),
  });
  const body = JSON.parse(result.body);
  assert.notEqual(body.error, 'writes_disabled');
  assert.equal(body.stage, 'esign_consent');
});
