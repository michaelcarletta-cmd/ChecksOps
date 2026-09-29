import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { handler } from '../functions/api/index.mjs';
import { hashToken } from '../functions/api/esign.mjs';

process.env.FILES_BUCKET = process.env.FILES_BUCKET || 'checksops-staging-privatefilesbucket-erzqsolpucjp';
import {
  attachCompletedSignatureDocument,
  normalizeFieldValues,
  runPublicSignatureSubmit,
  signedDocumentPath,
  validateRequiredFields,
} from '../functions/api/signature-submit.mjs';

const TOKEN_HASH = hashToken('tok');

const lookupDoc = (overrides = {}) => ({
  signer: {
    id: 's1',
    status: 'pending',
    expires_at: null,
    signing_order: 1,
    signer_name: 'Ada',
    ...(overrides.signer || {}),
  },
  request: {
    id: 'r1',
    document_name: 'Release',
    document_path: 'unsigned/orig.pdf',
    field_data: [{ id: 'sig', type: 'signature', signerIndex: 0, required: true, label: 'Sign' }],
    claim_id: 'c1',
    check_intake_item_id: 'k1',
    status: 'pending',
    ...(overrides.request || {}),
  },
  waiting_for: overrides.waiting_for || [],
  fields: overrides.fields || [{
    id: 'sig', field_type: 'signature', label: 'Sign', required: true, page: 1, x: 0, y: 0, width: 10, height: 6,
  }],
});

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
      result: () => ({ rows: [{ doc: lookupDoc({ signer: { expires_at: '2000-01-01T00:00:00.000Z' } }) }] }),
    }]),
  });
  assert.equal(expired.statusCode, 403);
  assert.equal(expired.stage, 'token_expired');

  const already = await runPublicSignatureSubmit(eventOf({
    token: 'tok',
    eSignConsentAccepted: true,
  }), {
    client: sqlClient([
      {
        match: (sql) => sql.includes('aws_public_signature_by_token_hash'),
        result: () => ({ rows: [{ doc: lookupDoc({ signer: { status: 'signed' } }) }] }),
      },
      {
        match: (sql) => sql.includes('aws_public_signature_submit'),
        result: () => ({ rows: [{ doc: { ok: true, already_signed: true, all_signed: false } }] }),
      },
    ]),
  });
  assert.equal(already.statusCode, 400);
  assert.equal(already.alreadySigned, true);

  const blocked = await runPublicSignatureSubmit(eventOf({
    token: 'tok',
    eSignConsentAccepted: true,
    fieldValues: {},
  }), {
    client: sqlClient([{
      match: (sql) => sql.includes('aws_public_signature_by_token_hash'),
      result: () => ({ rows: [{
        doc: lookupDoc({
          signer: { id: 's2', signing_order: 2 },
          waiting_for: [{ name: 'Ada', order: 1 }],
        }),
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
        result: () => ({ rows: [{ doc: lookupDoc() }] }),
      },
      {
        match: (sql, params) => {
          sqls.push(sql);
          return sql.includes('aws_public_signature_submit') && params[0] === TOKEN_HASH;
        },
        result: (_params, sql) => {
          sqls.push(sql);
          return { rows: [{
            doc: {
              ok: true,
              already_signed: false,
              all_signed: true,
              request_completed: true,
              request_id: 'r1',
              claim_id: 'c1',
              check_intake_item_id: 'k1',
              document_path: 'unsigned/orig.pdf',
              document_name: 'Release',
              final_rel: 'signed/c1/r1-final.pdf',
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
  assert.equal(sqls.some((sql) => sql.includes('aws_public_signature_submit')), true);
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

test('signed document path keeps the unsigned original path separate', () => {
  assert.equal(
    signedDocumentPath({ id: 'r1', claim_id: 'c1', check_intake_item_id: 'k1' }),
    'signed/c1/r1-final.pdf',
  );
  assert.equal(
    signedDocumentPath({ id: 'r2', claim_id: null, check_intake_item_id: 'k2' }),
    'check-intake/k2/files/r2-final.pdf',
  );
});

test('attachCompletedSignatureDocument copies signed PDF through the token attach helper', async () => {
  const sqls = [];
  const copies = [];
  const client = sqlClient([
    {
      match: (sql) => sql.includes('aws_public_signature_attach_signed'),
      result: (_params, sql) => {
        sqls.push(sql);
        return { rows: [{ doc: { ok: true, final_pdf_path: 'signed/c1/r1-final.pdf', original_path: 'unsigned/orig.pdf', already_attached: false } }] };
      },
    },
  ]);

  const first = await attachCompletedSignatureDocument(client, {
    id: 'r1',
    claim_id: 'c1',
    check_intake_item_id: 'k1',
    document_path: 'unsigned/orig.pdf',
    document_name: 'Release.pdf',
    token_hash: TOKEN_HASH,
    final_rel: 'signed/c1/r1-final.pdf',
  }, {
    copyObject: async ({ destRel }) => {
      copies.push(destRel);
    },
  });
  assert.equal(first.final_pdf_path, 'signed/c1/r1-final.pdf');
  assert.equal(first.original_path, 'unsigned/orig.pdf');
  assert.deepEqual(copies, ['signed/c1/r1-final.pdf']);
  assert.equal(sqls.some((sql) => sql.includes('aws_public_signature_attach_signed')), true);
  assert.equal(sqls.some((sql) => sql.includes('INSERT INTO public.claim_files')), false);
  assert.equal(sqls.some((sql) => /record_check_return|ready_for_deposit|approved_for_deposit|bill_mortgage/.test(sql)), false);

  const dupSqls = [];
  const dupClient = sqlClient([
    {
      match: (sql) => sql.includes('aws_public_signature_attach_signed'),
      result: (_params, sql) => {
        dupSqls.push(sql);
        return { rows: [{ doc: { ok: true, final_pdf_path: 'signed/c1/r1-final.pdf', original_path: 'unsigned/orig.pdf', already_attached: true } }] };
      },
    },
  ]);
  const replay = await attachCompletedSignatureDocument(dupClient, {
    id: 'r1',
    claim_id: 'c1',
    check_intake_item_id: 'k1',
    document_path: 'unsigned/orig.pdf',
    document_name: 'Release.pdf',
    token_hash: TOKEN_HASH,
    final_rel: 'signed/c1/r1-final.pdf',
  }, { copyObject: async () => {} });
  assert.equal(replay.already_attached, true);
  assert.equal(dupSqls.some((sql) => sql.includes('INSERT INTO public.claim_files')), false);
});

test('successful submit without flattenPdf attaches signed document and still denies deposit', async () => {
  let attached = false;
  const sqls = [];
  const result = await runPublicSignatureSubmit(eventOf({
    token: 'tok',
    eSignConsentAccepted: true,
    fieldValues: { sig: 'data:image/png;base64,x' },
  }), {
    copyObject: async () => { attached = true; },
    client: sqlClient([
      {
        match: (sql) => sql.includes('aws_public_signature_by_token_hash'),
        result: () => ({ rows: [{ doc: lookupDoc() }] }),
      },
      {
        match: (sql) => sql.includes('aws_public_signature_submit'),
        result: (_params, sql) => {
          sqls.push(sql);
          return { rows: [{
            doc: {
              ok: true,
              already_signed: false,
              all_signed: true,
              request_completed: true,
              request_id: 'r1',
              claim_id: 'c1',
              check_intake_item_id: 'k1',
              document_path: 'unsigned/orig.pdf',
              document_name: 'Release',
              final_rel: 'signed/c1/r1-final.pdf',
            },
          }] };
        },
      },
      {
        match: (sql) => sql.includes('aws_public_signature_attach_signed'),
        result: (_params, sql) => {
          sqls.push(sql);
          return { rows: [{ doc: { ok: true, final_pdf_path: 'signed/c1/r1-final.pdf', original_path: 'unsigned/orig.pdf' } }] };
        },
      },
    ]),
  });
  assert.equal(result.ok, true);
  assert.equal(result.allSigned, true);
  assert.equal(result.depositAdvanceDenied, true);
  assert.equal(attached, true);
  assert.equal(sqls.some((sql) => sql.includes('aws_public_signature_attach_signed')), true);
  assert.equal(sqls.some((sql) => /record_check_return|ready_for_deposit|approved_for_deposit|bill_mortgage/.test(sql)), false);
});
