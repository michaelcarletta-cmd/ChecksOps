import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  HOMEOWNER_UPLOAD_MAX_BYTES,
  handleHomeownerLedgerUpload,
  runHomeownerLinkManage,
} from '../functions/api/homeowner.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TENANT = '11111111-1111-4111-8111-111111111111';
const TOKEN_ID = '22222222-2222-4222-8222-222222222222';
const STAFF = '33333333-3333-4333-8333-333333333333';
const LINK = '44444444-4444-4444-8444-444444444444';

const recordingDb = (handlers = {}) => {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      const text = String(sql);
      calls.push({ text, params });
      for (const [needle, reply] of Object.entries(handlers)) {
        if (text.includes(needle)) return typeof reply === 'function' ? reply(text, params) : reply;
      }
      return { rows: [], rowCount: 0 };
    },
  };
};

process.env.FILES_BUCKET = process.env.FILES_BUCKET || 'test-files-bucket';

const tokenDoc = { rows: [{ doc: { ok: true, token: { id: TOKEN_ID, tenant_id: TENANT, claim_id: null } } }] };

test('upload_url presigns a direct S3 PUT under the link prefix; no image passes through Lambda', async () => {
  const db = recordingDb({ aws_public_homeowner_ledger_by_token: tokenDoc });
  let presigned;
  const result = await handleHomeownerLedgerUpload(
    { body: JSON.stringify({ token: 'tok', action: 'upload_url', side: 'back', content_type: 'image/jpeg', size: 9_000_000 }) },
    { client: db, presign: async (args) => { presigned = args; return 'https://s3.example/put'; } },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.upload_url, 'https://s3.example/put');
  assert.match(result.path, new RegExp(`^ledger/${TOKEN_ID}/\\d+_back\\.jpg$`));
  assert.equal(presigned.contentLength, 9_000_000);
  assert.equal(presigned.contentType, 'image/jpeg');
  const big = await handleHomeownerLedgerUpload(
    { body: JSON.stringify({ token: 'tok', action: 'upload_url', content_type: 'image/jpeg', size: HOMEOWNER_UPLOAD_MAX_BYTES + 1 }) },
    { client: recordingDb({ aws_public_homeowner_ledger_by_token: tokenDoc }), presign: async () => 'x' },
  );
  assert.equal(big.statusCode, 413);
  const exe = await handleHomeownerLedgerUpload(
    { body: JSON.stringify({ token: 'tok', action: 'upload_url', content_type: 'application/x-msdownload', size: 10 }) },
    { client: recordingDb({ aws_public_homeowner_ledger_by_token: tokenDoc }), presign: async () => 'x' },
  );
  assert.equal(exe.statusCode, 415);
});

test('a homeowner check is recorded through SQL 110, filed into Review as the link sender, and OCR runs', async () => {
  const db = recordingDb({
    aws_public_homeowner_ledger_by_token: tokenDoc,
    aws_public_homeowner_ledger_upload: { rows: [{ doc: { ok: true, upload_id: 'u1', tenant_id: TENANT, claim_id: null, sent_by_user_id: STAFF } }] },
    'INSERT INTO public.check_intake_items': { rows: [{ id: 'check-1' }], rowCount: 1 },
    'UPDATE public.homeowner_ledger_check_uploads': { rows: [], rowCount: 1 },
  });
  const ocrCalls = [];
  const result = await handleHomeownerLedgerUpload(
    { body: JSON.stringify({ token: 'tok', front_path: `ledger/${TOKEN_ID}/1_front.jpg`, back_path: `ledger/${TOKEN_ID}/2_back.jpg`, amount_estimate: '5' }) },
    {
      client: db,
      uploadExists: async () => true,
      copyToClaimFiles: async (tenant, claim, rel) => `${tenant}/${claim}/homeowner-checks/${rel.split('/').pop()}`,
      connectWrite: async () => recordingDb(),
      runOcr: async (event, injected) => injected.withIdentity(event, async (ctx) => { ocrCalls.push(ctx); return { ocr_success: true }; }),
      sendViaSesOrSink: async () => ({ ok: true }),
    },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.in_review, true);
  assert.equal(result.ocr_started, true);
  assert.deepEqual(result.upload, { id: 'u1', status: 'attached' });
  const record = db.calls.find((c) => c.text.includes('aws_public_homeowner_ledger_upload'));
  assert.deepEqual(record.params.slice(1, 5), [`ledger/${TOKEN_ID}/1_front.jpg`, `ledger/${TOKEN_ID}/2_back.jpg`, 'check', 5]);
  // No direct INSERT into the uploads table from the identity-free session.
  assert.equal(db.calls.some((c) => c.text.includes('INSERT INTO public.homeowner_ledger_check_uploads')), false);
  const bind = db.calls.find((c) => c.text.includes('set_config') && c.params?.[1] === STAFF);
  assert.ok(bind, 'binds the link sender before filing into Review');
  const intake = db.calls.find((c) => c.text.includes('INSERT INTO public.check_intake_items'));
  assert.match(intake.text, /'pending', 'review', 'insurance'/);
  assert.equal(intake.params[2], STAFF);
  assert.equal(intake.params[5], 5);
  assert.equal(ocrCalls[0].mapping.application_user_id, STAFF);
  assert.equal(ocrCalls[0].body.check_id, 'check-1');
});

test('the commit refuses paths outside the link prefix or missing in S3', async () => {
  for (const [frontPath, exists] of [['ledger/other/1_front.jpg', true], [`ledger/${TOKEN_ID}/../x_front.jpg`, true], [`ledger/${TOKEN_ID}/1_front.jpg`, false]]) {
    const db = recordingDb({ aws_public_homeowner_ledger_by_token: tokenDoc });
    const result = await handleHomeownerLedgerUpload(
      { body: JSON.stringify({ token: 'tok', front_path: frontPath }) },
      { client: db, uploadExists: async () => exists },
    );
    assert.equal(result.error, 'invalid_path', frontPath);
    assert.equal(db.calls.some((c) => c.text.includes('aws_public_homeowner_ledger_upload')), false);
  }
});

test('when the sender cannot write the tenant the upload stays pending_review in the inbox', async () => {
  const db = recordingDb({
    aws_public_homeowner_ledger_by_token: tokenDoc,
    aws_public_homeowner_ledger_upload: { rows: [{ doc: { ok: true, upload_id: 'u1', tenant_id: TENANT, claim_id: null, sent_by_user_id: STAFF } }] },
    'INSERT INTO public.check_intake_items': () => { throw Object.assign(new Error('new row violates row-level security policy'), { code: '42501' }); },
  });
  const result = await handleHomeownerLedgerUpload(
    { body: JSON.stringify({ token: 'tok', front_path: `ledger/${TOKEN_ID}/1_front.jpg` }) },
    { client: db, uploadExists: async () => true, copyToClaimFiles: async () => 'x', sendViaSesOrSink: async () => ({ ok: true }) },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.in_review, false);
  assert.deepEqual(result.upload, { id: 'u1', status: 'pending_review' });
  assert.ok(db.calls.some((c) => c.text === 'ROLLBACK TO SAVEPOINT homeowner_upload_review'));
});

test('before SQL 110 is applied the upload answers upload_unavailable, not a crash', async () => {
  const db = recordingDb({
    aws_public_homeowner_ledger_by_token: tokenDoc,
    aws_public_homeowner_ledger_upload: () => { throw Object.assign(new Error('function does not exist'), { code: '42883' }); },
  });
  const result = await handleHomeownerLedgerUpload(
    { body: JSON.stringify({ token: 'tok', front_path: `ledger/${TOKEN_ID}/1_front.jpg` }) },
    { client: db, uploadExists: async () => true },
  );
  assert.equal(result.error, 'upload_unavailable');
});

test('links: revoke and delete are same-tenant only; delete is refused while uploads exist', async () => {
  const mapping = { application_user_id: STAFF };
  const base = {
    'FROM public.homeowner_ledger_tokens WHERE id': { rows: [{ id: LINK, tenant_id: TENANT }] },
    'FROM public.tenant_users': { rows: [{ '?column?': 1 }] },
  };
  const revoked = await runHomeownerLinkManage({
    client: recordingDb({ ...base, 'UPDATE public.homeowner_ledger_tokens': { rows: [], rowCount: 1 } }),
    mapping, spoof: {}, body: { action: 'revoke', token_id: LINK },
  });
  assert.equal(revoked.revoked, true);
  const deleted = await runHomeownerLinkManage({
    client: recordingDb({ 'DELETE FROM public.homeowner_ledger_tokens': { rows: [], rowCount: 1 }, ...base, 'count(*)::int': { rows: [{ n: 0 }] } }),
    mapping, spoof: {}, body: { action: 'delete', token_id: LINK },
  });
  assert.equal(deleted.deleted, true);
  const inUse = await runHomeownerLinkManage({
    client: recordingDb({ ...base, 'count(*)::int': { rows: [{ n: 2 }] } }),
    mapping, spoof: {}, body: { action: 'delete', token_id: LINK },
  });
  assert.equal(inUse.error, 'link_has_uploads');
  const outsider = await runHomeownerLinkManage({
    client: recordingDb({ 'FROM public.homeowner_ledger_tokens WHERE id': base['FROM public.homeowner_ledger_tokens WHERE id'] }),
    mapping, spoof: {}, body: { action: 'delete', token_id: LINK },
  });
  assert.equal(outsider.error, 'forbidden');
  const noGrant = await runHomeownerLinkManage({
    client: recordingDb({ 'DELETE FROM public.homeowner_ledger_tokens': () => { throw Object.assign(new Error('permission denied'), { code: '42501' }); }, ...base, 'count(*)::int': { rows: [{ n: 0 }] } }),
    mapping, spoof: {}, body: { action: 'delete', token_id: LINK },
  });
  assert.equal(noGrant.error, 'delete_unavailable');
});

test('the homeowner page uploads straight to S3 and Manager links use the API for revoke and delete', () => {
  const page = fs.readFileSync(path.join(ROOT, 'src/pages/HomeownerLedger.tsx'), 'utf8');
  assert.equal(/front_base64/.test(page), false);
  assert.match(page, /action: "upload_url"/);
  const links = fs.readFileSync(path.join(ROOT, 'src/components/homeowner-ledger/SendHomeownerUploadLink.tsx'), 'utf8');
  assert.equal(/from\("homeowner_ledger_tokens"\)\s*\.update/.test(links), false);
  assert.match(links, /manageLink\(t.id, "revoke"\)/);
  assert.match(links, /manageLink\(t.id, "delete"\)/);
  assert.match(links, /"homeowner-ledger-send", \{\s*body: \{ action, token_id: id \}/);
});
