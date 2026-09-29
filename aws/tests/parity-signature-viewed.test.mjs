import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  handlePublicSignatureDocument,
  recordPublicSignerViewed,
} from '../functions/api/storage.mjs';

process.env.FILES_BUCKET = 'checksops-staging-privatefilesbucket-erzqsolpucjp';

const writeClient = (handlers) => {
  const sqls = [];
  return {
    sqls,
    connect: async () => {},
    end: async () => {},
    query: async (sql, params = []) => {
      const compact = String(sql).replace(/\s+/g, ' ');
      sqls.push({ sql: compact, params });
      if (/^BEGIN|COMMIT|ROLLBACK|SET TRANSACTION/i.test(compact.trim())) {
        return { rows: [], rowCount: 0 };
      }
      for (const handler of handlers) {
        if (handler.match(compact, params)) return handler.result(params, compact);
      }
      return { rows: [], rowCount: 0 };
    },
  };
};

test('recordPublicSignerViewed skips when already viewed and does not open a write client', async () => {
  let created = false;
  const result = await recordPublicSignerViewed({
    createWriteClient: () => {
      created = true;
      throw new Error('must_not_create_write_client');
    },
  }, {
    tokenHash: 'a'.repeat(64),
    alreadyViewed: true,
  });
  assert.deepEqual(result, { recorded: false, reason: 'skipped' });
  assert.equal(created, false);
});

test('first public document open records viewed_at through the token-scoped helper', async () => {
  const tokenHash = 'b'.repeat(64);
  const writer = writeClient([
    {
      match: (sql) => sql.includes('aws_public_signature_mark_viewed'),
      result: () => ({
        rows: [{ doc: { ok: true, recorded: true, viewed_at: '2026-09-27T19:00:00.000Z' } }],
        rowCount: 1,
      }),
    },
  ]);
  const result = await recordPublicSignerViewed({ writeClient: writer }, {
    tokenHash,
    alreadyViewed: false,
  });
  assert.equal(result.recorded, true);
  assert.equal(writer.sqls.some((row) => row.sql.includes('aws_public_signature_mark_viewed') && row.params[0] === tokenHash), true);
  assert.equal(writer.sqls.some((row) => /UPDATE public.signature_signers/.test(row.sql)), false);
  assert.equal(writer.sqls.some((row) => /record_check_return|ready_for_deposit|bill_mortgage/.test(row.sql)), false);
});

test('handlePublicSignatureDocument records viewed after a successful document presign', async () => {
  const tokenHash = createHash('sha256').update('token-long-enough').digest('hex');
  const doc = {
    signer: { id: 's1', viewed_at: null, expires_at: null },
    request: { id: 'r1', document_path: 'unsigned/orig.pdf', claim_id: 'c1', status: 'pending' },
    claim: { id: 'c1' },
    fields: [],
    presets: [],
    waiting_for: [],
  };
  const reader = writeClient([
    {
      match: (sql) => sql.includes('aws_public_signature_by_token_hash'),
      result: () => ({ rows: [{ doc }] }),
    },
  ]);
  const writer = writeClient([
    {
      match: (sql) => sql.includes('aws_public_signature_mark_viewed'),
      result: () => ({ rows: [{ doc: { ok: true, recorded: true, viewed_at: '2026-09-27T19:00:00.000Z' } }], rowCount: 1 }),
    },
  ]);
  const key = 'files/claim-files/unsigned/orig.pdf';
  const result = await handlePublicSignatureDocument({
    body: JSON.stringify({ token: 'token-long-enough' }),
    requestContext: { http: { method: 'POST', path: '/public/signature-document' } },
  }, {
    loadDatabaseCredentials: async () => ({
      username: 'checksops',
      password: 'unit-test-only-not-a-real-secret',
      host: 'db.example.internal',
      database: 'checksops',
    }),
    createClient: () => reader,
    writeClient: writer,
    s3: {
      send: async (command) => {
        if (command.input?.Key === key) return {};
        const error = new Error('NotFound');
        error.name = 'NotFound';
        error.$metadata = { httpStatusCode: 404 };
        throw error;
      },
    },
    getSignedUrl: async () => 'https://s3.example/presigned?X-Amz-Signature=viewed',
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.viewedRecorded, true);
  assert.match(result.signedUrl, /presigned/);
  assert.equal(writer.sqls.some((row) => row.sql.includes('aws_public_signature_mark_viewed') && row.params[0] === tokenHash), true);
});
