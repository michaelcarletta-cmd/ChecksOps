import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handler } from '../functions/api/index.mjs';
import {
  handleStorageSign,
  handleStoragePublic,
  handleStorageWritesDisabled,
  authorizeObject,
} from '../functions/api/storage.mjs';
import {
  handleStorageUploadUrl,
  handleStorageDelete,
  handleStorageMove,
} from '../functions/api/storage-write.mjs';
import { LOOKUP_MAPPING_SQL } from '../functions/api/identity.mjs';
import { matchCheckScopedPath, s3KeyFor, normalizePath, pathCandidates } from '../functions/api/storage-paths.mjs';

const APP_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const SPOOF_ID = '00000000-0000-0000-0000-000000000099';
const FREEDOM_PATH = 'checks/abc/front.jpg';
const CHECK_ID = '8d2b1c3e-4f5a-4678-9abc-def012345678';
const WRITE_PATH = `check-intake/${CHECK_ID}/files/aws-t3-test.pdf`;

process.env.FILES_BUCKET = 'checksops-staging-privatefilesbucket-erzqsolpucjp';

const jwtEvent = (path, method, body, extra = {}) => ({
  rawPath: path,
  headers: {
    authorization: 'Bearer test-id-token',
    'x-user-id': SPOOF_ID,
    'x-tenant-id': 'spoof-tenant',
    'x-role': 'admin',
    ...(extra.headers || {}),
  },
  queryStringParameters: { user_id: SPOOF_ID, tenant_id: 'spoof-tenant', ...(extra.query || {}) },
  body: body ? JSON.stringify(body) : undefined,
  requestContext: {
    stage: 'staging',
    http: { method, path },
    authorizer: { jwt: { claims: { sub: COGNITO_SUB, email: 'checksops-tester@freedomadj.com', token_use: 'id' } } },
  },
});

const mockClient = ({ authorize = false, writeCheck = false, publicLogo = false, mapping = {
  application_user_id: APP_ID,
  cognito_sub: COGNITO_SUB,
  email: 'checksops-tester@freedomadj.com',
  status: 'active',
} } = {}) => {
  const queries = [];
  return {
    queries,
    connect: async () => {},
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
      if (sql === LOOKUP_MAPPING_SQL) {
        return { rows: params[0] === mapping.cognito_sub ? [mapping] : [] };
      }
      if (/SELECT id, tenant_id FROM public.check_intake_items/.test(sql)) {
        return { rows: writeCheck && params[0] === CHECK_ID ? [{ id: CHECK_ID, tenant_id: '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a' }] : [] };
      }
      if (String(sql).includes('tenants_public')) {
        return { rows: publicLogo ? [{ logo_url: 'https://example.supabase.co/storage/v1/object/public/tenant-logos/freedom/logo.png' }] : [] };
      }
      if (String(sql).startsWith('SELECT 1 FROM')) {
        return { rows: authorize ? [{ '?column?': 1 }] : [] };
      }
      return { rows: [] };
    },
    end: async () => {},
  };
};

const depsFor = (client, { keys = new Set(), signedUrl = 'https://s3.example/presigned?X-Amz-Signature=test', forceStorageWrites = false } = {}) => {
  const sent = [];
  return {
    forceStorageWrites,
    sent,
    loadDatabaseCredentials: async () => ({
      username: 'checksops',
      password: 'unit-test-only-not-a-real-secret',
      host: 'db.example.internal',
      database: 'checksops',
    }),
    createClient: () => client,
    s3: {
      send: async (command) => {
        const name = command.constructor?.name || '';
        const key = command.input?.Key;
        sent.push({ name, key, input: command.input });
        if (name === 'DeleteObjectCommand' || name === 'CopyObjectCommand' || name === 'PutObjectCommand') {
          return {};
        }
        if (keys.has(key)) return {};
        const error = new Error('NotFound');
        error.name = 'NotFound';
        error.$metadata = { httpStatusCode: 404 };
        throw error;
      },
    },
    getSignedUrl: async () => signedUrl,
  };
};

test('S3 keys preserve bucket and object path under files/', () => {
  assert.equal(s3KeyFor('claim-files', FREEDOM_PATH), `files/claim-files/${FREEDOM_PATH}`);
  assert.equal(normalizePath('../etc/passwd', 'claim-files'), null);
  assert.equal(s3KeyFor('database_export_01_09_26', 'x.sql'), null);
  assert.ok(pathCandidates('claim-files', `https://nbcqwpysqgyxrrbgtmkw.supabase.co/storage/v1/object/sign/claim-files/${FREEDOM_PATH}?token=x`).includes(FREEDOM_PATH));
});

test('POST /storage/sign refuses objects without an RLS-visible row and ignores spoofed ids', async () => {
  const client = mockClient({ authorize: false });
  const result = await handleStorageSign(jwtEvent('/storage/sign', 'POST', {
    bucket: 'claim-files',
    path: FREEDOM_PATH,
    user_id: SPOOF_ID,
    tenant_id: 'spoof-tenant',
  }), depsFor(client, { keys: new Set([`files/claim-files/${FREEDOM_PATH}`]) }));
  assert.equal(result.statusCode, 403);
  assert.equal(result.error, 'storage_forbidden');
  assert.equal(result.applicationUserId, APP_ID);
  assert.notEqual(result.applicationUserId, result.cognitoSub);
  assert.equal(result.spoofFieldsIgnored.headerUserId, SPOOF_ID);
  const guc = client.queries.find((q) => String(q.sql).includes('set_config') && q.params?.[1] === APP_ID);
  assert.ok(guc);
  assert.equal(client.queries.some((q) => q.params?.[1] === SPOOF_ID && String(q.sql).includes('set_config')), false);
});

test('POST /storage/sign issues a presigned URL only after RLS authorization', async () => {
  const client = mockClient({ authorize: true });
  const key = `files/claim-files/${FREEDOM_PATH}`;
  const result = await handleStorageSign(jwtEvent('/storage/sign', 'POST', {
    bucket: 'claim-files',
    path: FREEDOM_PATH,
    expiresIn: 300,
  }), depsFor(client, { keys: new Set([key]) }));
  assert.equal(result.ok, true);
  assert.match(result.signedUrl, /presigned/);
  assert.equal(result.path, FREEDOM_PATH);
});

test('unauthenticated protected-file access fails; branding requires tenants_public', async () => {
  const missing = await handler({
    rawPath: '/storage/sign',
    requestContext: { stage: 'staging', http: { method: 'POST', path: '/storage/sign' } },
    body: JSON.stringify({ bucket: 'claim-files', path: FREEDOM_PATH }),
  });
  assert.equal(missing.statusCode, 401);

  const deniedPublic = await handleStoragePublic({
    rawPath: '/storage/public',
    queryStringParameters: { bucket: 'claim-files', path: FREEDOM_PATH },
    requestContext: { stage: 'staging', http: { method: 'GET', path: '/storage/public' } },
  }, depsFor(mockClient({ publicLogo: false })));
  assert.equal(deniedPublic.statusCode, 403);

  const logoClient = mockClient({ publicLogo: true });
  const logoKey = 'files/tenant-logos/freedom/logo.png';
  const allowed = await handleStoragePublic({
    rawPath: '/storage/public',
    queryStringParameters: { bucket: 'tenant-logos', path: 'freedom/logo.png' },
    requestContext: { stage: 'staging', http: { method: 'GET', path: '/storage/public' } },
  }, depsFor(logoClient, { keys: new Set([logoKey]) }));
  assert.equal(allowed.statusCode, 302);
  assert.ok(allowed.location);
});

test('storage uploads stay disabled when the storage write flag is off', async () => {
  const result = await handleStorageWritesDisabled(jwtEvent('/storage/upload', 'POST', { bucket: 'claim-files' }));
  assert.equal(result.statusCode, 403);
  assert.equal(result.error, 'uploads_disabled');

  const routed = await handler(jwtEvent('/storage/upload', 'POST', { bucket: 'claim-files', path: 'x' }));
  assert.equal(routed.statusCode, 403);
  assert.equal(JSON.parse(routed.body).error, 'uploads_disabled');
});

test('authorizeObject matches signed URL values to relative paths', async () => {
  const client = mockClient({ authorize: true });
  const result = await authorizeObject(client, 'claim-files', `https://nbcqwpysqgyxrrbgtmkw.supabase.co/storage/v1/object/sign/claim-files/${FREEDOM_PATH}?token=abc`);
  assert.equal(result.authorized, true);
  assert.equal(result.rel, FREEDOM_PATH);
});

test('check-scoped write prefixes encode the parent check id', () => {
  assert.equal(matchCheckScopedPath(WRITE_PATH), CHECK_ID);
  assert.equal(matchCheckScopedPath(`checks/reupload/${CHECK_ID}/front.jpg`), CHECK_ID);
  assert.equal(matchCheckScopedPath('deposit-attachments/x.pdf'), null);
});

test('authorized upload-url succeeds and ignores spoofed identity', async () => {
  const client = mockClient({ writeCheck: true });
  const deps = depsFor(client, { forceStorageWrites: true });
  const result = await handleStorageUploadUrl(jwtEvent('/storage/upload-url', 'POST', {
    bucket: 'claim-files',
    path: WRITE_PATH,
    contentType: 'application/pdf',
    user_id: SPOOF_ID,
    tenant_id: 'spoof-tenant',
  }), deps);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.path, WRITE_PATH);
  assert.match(result.uploadUrl, /presigned/);
  assert.equal(result.applicationUserId, APP_ID);
  assert.equal(result.spoofFieldsIgnored.headerUserId, SPOOF_ID);
});

test('upload-url conflicts when the object exists and upsert is false', async () => {
  const client = mockClient({ writeCheck: true });
  const key = `files/claim-files/${WRITE_PATH}`;
  const result = await handleStorageUploadUrl(jwtEvent('/storage/upload-url', 'POST', {
    bucket: 'claim-files',
    path: WRITE_PATH,
    contentType: 'application/pdf',
  }), depsFor(client, { keys: new Set([key]), forceStorageWrites: true }));
  assert.equal(result.statusCode, 409);
  assert.equal(result.error, 'object_exists');
});

test('C1C cannot authorize a Freedom check-scoped upload and knowing the key is insufficient', async () => {
  const client = mockClient({ writeCheck: false, authorize: false });
  const result = await handleStorageUploadUrl(jwtEvent('/storage/upload-url', 'POST', {
    bucket: 'claim-files',
    path: WRITE_PATH,
    contentType: 'application/pdf',
  }), depsFor(client, { forceStorageWrites: true }));
  assert.equal(result.statusCode, 403);
  assert.equal(result.error, 'rls_denied');
});

test('deposit and endorsement-packet writes stay denied', async () => {
  const client = mockClient({ writeCheck: true, authorize: true });
  const deposit = await handleStorageUploadUrl(jwtEvent('/storage/upload-url', 'POST', {
    bucket: 'deposit-attachments',
    path: 'freedom/x.pdf',
    contentType: 'application/pdf',
  }), depsFor(client, { forceStorageWrites: true }));
  assert.equal(deposit.statusCode, 403);
  const packet = await handleStorageUploadUrl(jwtEvent('/storage/upload-url', 'POST', {
    bucket: 'endorsement-packets',
    path: WRITE_PATH,
    contentType: 'application/pdf',
  }), depsFor(client, { forceStorageWrites: true }));
  assert.equal(packet.statusCode, 403);
});

test('delete and move require server-side authorization', async () => {
  const client = mockClient({ writeCheck: true });
  const deps = depsFor(client, { forceStorageWrites: true });
  const deleted = await handleStorageDelete(jwtEvent('/storage/delete', 'POST', {
    bucket: 'claim-files',
    path: WRITE_PATH,
  }), deps);
  assert.equal(deleted.ok, true);
  assert.deepEqual(deleted.deleted, [WRITE_PATH]);

  const denied = await handleStorageDelete(jwtEvent('/storage/delete', 'POST', {
    bucket: 'claim-files',
    path: 'checks/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/x.jpg',
  }), depsFor(mockClient({ writeCheck: false }), { forceStorageWrites: true }));
  assert.equal(denied.statusCode, 403);

  const moved = await handleStorageMove(jwtEvent('/storage/move', 'POST', {
    bucket: 'claim-files',
    from: WRITE_PATH,
    to: `check-intake/${CHECK_ID}/files/aws-t3-test-moved.pdf`,
  }), depsFor(client, { forceStorageWrites: true }));
  assert.equal(moved.ok, true, JSON.stringify(moved));
  assert.equal(moved.to, `check-intake/${CHECK_ID}/files/aws-t3-test-moved.pdf`);
});

