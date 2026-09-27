import assert from 'node:assert/strict';
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
    signerId: 's1',
    requestId: 'r1',
    claimId: 'c1',
    alreadyViewed: true,
  });
  assert.deepEqual(result, { recorded: false, reason: 'skipped' });
  assert.equal(created, false);
});

test('first public document open records viewed_at, moves pending to in_progress, and logs signer_viewed', async () => {
  const writer = writeClient([
    {
      match: (sql) => sql.includes('SET viewed_at'),
      result: () => ({ rows: [{ id: 's1', viewed_at: '2026-09-27T19:00:00.000Z' }], rowCount: 1 }),
    },
    {
      match: (sql) => sql.includes("SET status = 'in_progress'"),
      result: () => ({ rows: [], rowCount: 1 }),
    },
    {
      match: (sql) => sql.includes("stage, status, message") && sql.includes('esign_event_logs'),
      result: () => ({ rows: [], rowCount: 1 }),
    },
  ]);
  const result = await recordPublicSignerViewed({ writeClient: writer }, {
    signerId: 's1',
    requestId: 'r1',
    claimId: 'c1',
    alreadyViewed: false,
  });
  assert.equal(result.recorded, true);
  assert.equal(writer.sqls.some((row) => row.sql.includes('SET viewed_at') && row.params[0] === 's1'), true);
  assert.equal(writer.sqls.some((row) => row.sql.includes("status = 'in_progress'") && row.params[0] === 'r1'), true);
  const log = writer.sqls.find((row) => row.sql.includes('esign_event_logs'));
  assert.ok(log);
  assert.equal(log.params[0], 'r1');
  assert.equal(log.params[1], 's1');
  assert.equal(log.params[2], 'c1');
  assert.match(log.sql, /signer_viewed/);
  assert.equal(writer.sqls.some((row) => /record_check_return|ready_for_deposit|bill_mortgage/.test(row.sql)), false);
});

test('handlePublicSignatureDocument records viewed after a successful document presign', async () => {
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
      match: (sql) => sql.includes('SET viewed_at'),
      result: () => ({ rows: [{ id: 's1', viewed_at: '2026-09-27T19:00:00.000Z' }], rowCount: 1 }),
    },
    {
      match: (sql) => sql.includes("SET status = 'in_progress'"),
      result: () => ({ rows: [], rowCount: 1 }),
    },
    {
      match: (sql) => sql.includes('esign_event_logs'),
      result: () => ({ rows: [], rowCount: 1 }),
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
  assert.equal(writer.sqls.some((row) => row.sql.includes('SET viewed_at')), true);
});
