import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runPublicSignatureSubmit } from '../functions/api/signature-submit.mjs';
import { handlePublicSignatureDocument, portalSignerFromBody } from '../functions/api/storage.mjs';

// SQL 127 (owner decision 2026-10-29, "Portal link is enough"): the claim portal signs a
// document with its ledger token and the signer id. The API resolves the signer's existing
// token_hash through aws_public_homeowner_document_portal_signer and never returns it.

const LEDGER = 'ledger-token-abcdef';
const SIGNER = '77777777-7777-4777-8777-777777777777';
const HASH = 'ab'.repeat(32);

const sqlClient = (handlers, seen = []) => ({
  query: async (sql, params = []) => {
    const compact = String(sql).replace(/\s+/g, ' ');
    seen.push({ sql: compact, params });
    if (/^(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)/i.test(compact.trim())) return { rows: [], rowCount: 0 };
    for (const handler of handlers) {
      if (handler.match(compact, params)) return handler.result(params, compact);
    }
    return { rows: [], rowCount: 0 };
  },
  connect: async () => {},
  end: async () => {},
});

const eventOf = (body = {}) => ({
  headers: {},
  body: JSON.stringify(body),
  requestContext: { http: { method: 'POST', path: '/public/signature-submit' } },
});

const portalSigner = (doc) => ({
  match: (sql) => sql.includes('aws_public_homeowner_document_portal_signer'),
  result: (params) => {
    assert.deepEqual(params, [LEDGER, SIGNER]);
    return { rows: [{ doc }] };
  },
});

const byHash = {
  match: (sql) => sql.includes('aws_public_signature_by_token_hash'),
  result: (params) => {
    assert.deepEqual(params, [HASH]);
    return { rows: [{ doc: {
      signer: { id: SIGNER, status: 'pending', expires_at: null, signing_order: 1, signer_name: 'Jane Doe' },
      request: { id: 'r1', document_name: 'Release', document_path: 'claims/c1/release.pdf', field_data: [] },
      fields: [{ id: 'sig', field_type: 'signature', required: true, label: 'Sign' }],
      waiting_for: [],
    } }] };
  },
};

test('portal pair is read from the body only when no emailed token is sent', () => {
  assert.equal(portalSignerFromBody({}), null);
  assert.deepEqual(portalSignerFromBody({ ledger_token: LEDGER, signer_id: SIGNER }), { ledgerToken: LEDGER, signerId: SIGNER });
});

test('portal submit signs through the existing token_hash in one transaction', async () => {
  const seen = [];
  const result = await runPublicSignatureSubmit(eventOf({
    ledger_token: LEDGER,
    signer_id: SIGNER,
    eSignConsentAccepted: true,
    fieldValues: { sig: 'data:image/png;base64,x' },
  }), {
    flattenPdf: async () => {},
    client: sqlClient([
      portalSigner({ ok: true, request_id: 'r1', signer_id: SIGNER, token_hash: HASH }),
      byHash,
      {
        match: (sql) => sql.includes('aws_public_signature_submit'),
        result: (params) => {
          assert.equal(params[0], HASH);
          return { rows: [{ doc: { ok: true, all_signed: false, request_id: 'r1' } }] };
        },
      },
    ], seen),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(JSON.stringify(result).includes(HASH), false);
  const order = seen.map((q) => q.sql);
  const begin = order.findIndex((sql) => sql.startsWith('BEGIN'));
  const portal = order.findIndex((sql) => sql.includes('aws_public_homeowner_document_portal_signer'));
  const submit = order.findIndex((sql) => sql.includes('aws_public_signature_submit'));
  assert.ok(begin >= 0 && begin < portal && portal < submit);
  assert.equal(order.at(-1), 'COMMIT');
});

test('portal submit refuses when SQL 127 refuses, and never falls back to a token', async () => {
  for (const [error, statusCode] of [['not_your_signature', 404], ['already_signed', 409], ['signer_order_blocked', 403], ['revoked', 410]]) {
    const seen = [];
    const result = await runPublicSignatureSubmit(eventOf({
      ledger_token: LEDGER,
      signer_id: SIGNER,
      eSignConsentAccepted: true,
      fieldValues: { sig: 'data:image/png;base64,x' },
    }), { client: sqlClient([portalSigner({ ok: false, error })], seen) });
    assert.equal(result.ok, false, error);
    assert.equal(result.statusCode, statusCode, error);
    assert.equal(seen.some((q) => /aws_public_signature_(by_token_hash|submit)/.test(q.sql)), false, error);
    assert.equal(seen.at(-1).sql, 'ROLLBACK');
  }
  // A malformed signer id never reaches the database.
  const seen = [];
  const bad = await runPublicSignatureSubmit(eventOf({
    ledger_token: LEDGER, signer_id: 'not-a-uuid', eSignConsentAccepted: true,
  }), { client: sqlClient([], seen) });
  assert.equal(bad.ok, false);
  assert.equal(seen.some((q) => q.sql.includes('portal_signer')), false);
});

test('portal document view resolves the hash with a write client, then reads by hash', async () => {
  const writerSeen = [];
  const readerSeen = [];
  const result = await handlePublicSignatureDocument({
    headers: {},
    body: JSON.stringify({ ledger_token: LEDGER, signer_id: SIGNER }),
  }, {
    loadDatabaseCredentials: async () => ({ username: 'checksops', password: 'unit-test-only', host: 'db.example.internal', database: 'checksops' }),
    createWriteClient: () => sqlClient([portalSigner({ ok: true, request_id: 'r1', signer_id: SIGNER, token_hash: HASH })], writerSeen),
    createClient: () => sqlClient([byHash], readerSeen),
    s3: { send: async () => ({}) },
    getSignedUrl: async () => 'https://signed.example/doc',
    writeClient: sqlClient([{ match: (sql) => sql.includes('mark_viewed'), result: () => ({ rows: [{ doc: { ok: true, recorded: true } }] }) }]),
  });
  assert.equal(writerSeen.some((q) => q.sql.includes('aws_public_homeowner_document_portal_signer')), true);
  assert.equal(writerSeen.at(-1).sql, 'COMMIT');
  assert.equal(readerSeen.some((q) => q.sql.includes('aws_public_signature_by_token_hash')), true);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.signedUrl, 'https://signed.example/doc');
  assert.equal(JSON.stringify(result).includes(HASH), false);
});

test('portal document view refuses without touching the reader when SQL 127 refuses', async () => {
  const readerSeen = [];
  const result = await handlePublicSignatureDocument({
    headers: {},
    body: JSON.stringify({ ledger_token: LEDGER, signer_id: SIGNER }),
  }, {
    loadDatabaseCredentials: async () => ({ username: 'checksops', password: 'unit-test-only', host: 'db.example.internal', database: 'checksops' }),
    createWriteClient: () => sqlClient([portalSigner({ ok: false, error: 'not_your_signature' })]),
    createClient: () => sqlClient([byHash], readerSeen),
  });
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 404);
  assert.equal(readerSeen.length, 0);
});
