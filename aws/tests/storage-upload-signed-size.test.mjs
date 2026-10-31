// Audit 2026-10-29 finding #26: every upload kind storage-write issues binds the
// declared size into the presigned PUT (signed Content-Length), bounded per bucket.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl as realGetSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  UPLOAD_MAX_BYTES_BY_BUCKET,
  handleStorageUploadUrl,
  uploadMaxBytesFor,
} from '../functions/api/storage-write.mjs';
import { LOOKUP_MAPPING_SQL } from '../functions/api/identity.mjs';
import { MAX_UPLOAD_BYTES, STORAGE_WRITE_BUCKETS } from '../functions/api/storage-paths.mjs';

const APP_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const CHECK_ID = '8d2b1c3e-4f5a-4678-9abc-def012345678';
const CLAIM_ID = '1de2f734-de37-404a-aa3e-d23905f7a6ea';
const DRAFT_ID = '3c0a7a8e-1b2c-4d3e-8f40-5a6b7c8d9e0f';
const DOC_ID = '4d1b8b9f-2c3d-4e4f-9a51-6b7c8d9e0f1a';
const DEPOSIT_ID = '5e2c9cae-3d4e-4f5a-8b62-7c8d9e0f1a2b';
const MB = 1024 * 1024;

process.env.FILES_BUCKET = 'checksops-test-files';

const event = (body) => ({
  rawPath: '/storage/upload-url',
  headers: { authorization: 'Bearer test-id-token' },
  body: JSON.stringify(body),
  requestContext: {
    stage: 'staging',
    http: { method: 'POST', path: '/storage/upload-url' },
    authorizer: { jwt: { claims: { sub: COGNITO_SUB, email: 'tester@example.com', token_use: 'id' } } },
  },
});

// A caller that is a member of TENANT and may write everything this file uploads to.
const writerClient = () => ({
  connect: async () => {},
  end: async () => {},
  query: async (sql, params) => {
    const text = String(sql).replace(/\s+/g, ' ');
    if (sql === LOOKUP_MAPPING_SQL) {
      return { rows: [{ application_user_id: APP_ID, cognito_sub: COGNITO_SUB, email: 'tester@example.com', status: 'active' }] };
    }
    if (text.startsWith('SELECT set_config')) return { rows: [{ set_config: params?.[1] }] };
    if (text.includes('aws_can_write_check($1::uuid) AS ok')) return { rows: [{ ok: true }] };
    if (text.includes('FROM public.check_intake_items WHERE id = $1::uuid')) {
      return { rows: [{ id: CHECK_ID, tenant_id: TENANT, front_image_path: `checks/${CHECK_ID}/front.jpg`, back_image_path: `checks/${CHECK_ID}/back.jpg` }] };
    }
    if (text.includes('FROM public.loss_draft_tracking')) {
      return { rows: [{ id: DRAFT_ID, check_intake_item_id: CHECK_ID, tenant_id: TENANT }] };
    }
    if (text.includes('FROM public.deposit_items')) return { rows: [{ id: DEPOSIT_ID, tenant_id: TENANT }] };
    if (text.includes('is_platform_owner()')) return { rows: [{ is_platform: false, is_master: false }] };
    if (text.includes('FROM public.tenant_users')) return { rows: [{ role: 'admin' }] };
    if (text.startsWith('SELECT 1 FROM')) return { rows: [{ '?column?': 1 }] };
    return { rows: [] };
  },
});

const depsWith = (sign) => ({
  forceStorageWrites: true,
  loadDatabaseCredentials: async () => ({ username: 'u', password: 'unit-test-only', host: 'db.example.internal', database: 'd' }),
  createClient: () => writerClient(),
  s3: {
    send: async () => {
      throw Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
    },
  },
  getSignedUrl: sign,
});

const capture = () => {
  const signed = [];
  return {
    signed,
    sign: async (_s3, command, options) => {
      signed.push({ input: command.input, options });
      return 'https://s3.example/put?X-Amz-Signature=test';
    },
  };
};

// One writable path and content type for each upload kind the handler can presign.
const KINDS = {
  'claim-files': { path: `check-intake/${CHECK_ID}/files/estimate.pdf`, contentType: 'application/pdf' },
  'endorsement-packets': { path: `check-intake/${CHECK_ID}/files/packet.pdf`, contentType: 'application/pdf' },
  'loss-draft-documents': { path: `${CLAIM_ID}/${DRAFT_ID}/${DOC_ID}/w9.pdf`, contentType: 'application/pdf' },
  'tenant-documents': { path: `${TENANT}/library/mortgage/doc.pdf`, contentType: 'application/pdf' },
  'tenant-logos': { path: `${TENANT}/logo-1730000000000.png`, contentType: 'image/png' },
  'company-branding': { path: 'letterhead_1730000000000.png', contentType: 'image/png' },
  'deposit-attachments': { path: `${DEPOSIT_ID}/receipt.pdf`, contentType: 'application/pdf' },
};

test('every storage write bucket carries a size bound taken from the SPA limits or the 25 MB library limit', () => {
  assert.deepEqual(Object.keys(UPLOAD_MAX_BYTES_BY_BUCKET).sort(), [...STORAGE_WRITE_BUCKETS].sort());
  assert.deepEqual({ ...UPLOAD_MAX_BYTES_BY_BUCKET }, {
    'claim-files': 25 * MB,
    'endorsement-packets': 25 * MB,
    'loss-draft-documents': 25 * MB,
    'tenant-documents': 25 * MB,
    'tenant-logos': 5 * MB,
    'company-branding': 5 * MB,
    'deposit-attachments': 25 * MB,
    'homeowner-uploads': 15 * MB,
  });
  for (const max of Object.values(UPLOAD_MAX_BYTES_BY_BUCKET)) assert.ok(max <= MAX_UPLOAD_BYTES);
  assert.equal(uploadMaxBytesFor('not-a-bucket'), MAX_UPLOAD_BYTES);
  assert.equal(uploadMaxBytesFor('__proto__'), MAX_UPLOAD_BYTES);
});

test('each upload kind signs its declared size at its limit and refuses one byte more', async () => {
  for (const [bucket, kind] of Object.entries(KINDS)) {
    const max = UPLOAD_MAX_BYTES_BY_BUCKET[bucket];
    const { signed, sign } = capture();
    const ok = await handleStorageUploadUrl(event({ bucket, ...kind, contentLength: max }), depsWith(sign));
    assert.equal(ok.ok, true, `${bucket}: ${JSON.stringify(ok)}`);
    assert.equal(ok.method, 'PUT');
    assert.deepEqual(ok.requiredHeaders, { 'content-type': kind.contentType }, bucket);
    assert.equal(signed.length, 1, bucket);
    assert.equal(signed[0].input.ContentLength, max, bucket);
    assert.equal(signed[0].input.ContentType, kind.contentType, bucket);
    assert.deepEqual(signed[0].options, { expiresIn: 60 }, bucket);

    const over = capture();
    const refused = await handleStorageUploadUrl(event({ bucket, ...kind, contentLength: max + 1 }), depsWith(over.sign));
    assert.equal(refused.statusCode, 400, bucket);
    assert.equal(refused.error, 'invalid_field', bucket);
    assert.equal(refused.field, 'contentLength', bucket);
    assert.equal(refused.maxBytes, max, bucket);
    assert.equal(over.signed.length, 0, `${bucket}: nothing presigned over the limit`);
  }
});

test('an upload with no, zero, fractional or non-numeric contentLength is refused before signing', async () => {
  const kind = KINDS['claim-files'];
  for (const contentLength of [undefined, null, '', 0, -1, 1.5, 'abc', Infinity]) {
    const { signed, sign } = capture();
    const body = { bucket: 'claim-files', ...kind };
    if (contentLength !== undefined) body.contentLength = contentLength;
    const refused = await handleStorageUploadUrl(event(body), depsWith(sign));
    assert.equal(refused.statusCode, 400, String(contentLength));
    assert.equal(refused.field, 'contentLength', String(contentLength));
    assert.equal(signed.length, 0, String(contentLength));
  }
});

test('an in-limit upload of every kind gets a URL whose signature binds content-length (real presigner)', async () => {
  const s3 = new S3Client({ region: 'us-east-1', credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' } });
  const sign = (_s3, command, options) => realGetSignedUrl(s3, command, options);
  const kinds = { ...KINDS, 'claim-files': { path: `checks/${CHECK_ID}/front.jpg`, contentType: 'image/jpeg' } };
  for (const [bucket, kind] of Object.entries(kinds)) {
    const result = await handleStorageUploadUrl(event({ bucket, ...kind, contentLength: 123456, upsert: true }), depsWith(sign));
    assert.equal(result.ok, true, `${bucket}: ${JSON.stringify(result)}`);
    const url = new URL(result.uploadUrl);
    const signedHeaders = url.searchParams.get('X-Amz-SignedHeaders').split(';');
    for (const h of ['content-length', 'host']) assert.ok(signedHeaders.includes(h), `${bucket}: ${h}`);
    assert.equal(url.searchParams.get('X-Amz-Expires'), '60', bucket);
  }
});

test('a logo over 5 MB is refused even though the generic 25 MB limit would allow it', async () => {
  const { signed, sign } = capture();
  const refused = await handleStorageUploadUrl(event({ bucket: 'tenant-logos', ...KINDS['tenant-logos'], contentLength: 6 * MB }), depsWith(sign));
  assert.equal(refused.statusCode, 400);
  assert.equal(refused.field, 'contentLength');
  assert.equal(signed.length, 0);
});
