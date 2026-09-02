#!/usr/bin/env node
/**
 * Live Tranche 3 write + storage validation against staging API + Cognito.
 * Cleans up test notes, files, and zero-amount ledger mirrors.
 * Does not touch production Supabase or payment providers.
 */
import fs from 'node:fs';

const API = process.env.CHECKSOPS_API_URL || 'https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging';
const FREEDOM_EMAIL = 'checksops-tester@freedomadj.com';
const C1C_EMAIL = 'payments@condition1commercial.com';
const FREEDOM_TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const C1C_TENANT = '4f172140-f57a-4744-8050-95f4f07b13b4';
const NINTH = 'dd24eea5-5d12-47d1-999e-d5930c278b7d';
const MARKER = `AWS T3 TEST ${Date.now()}`;

const passwords = JSON.parse(fs.readFileSync(process.env.COGNITO_PASSWORD_FILE || '/tmp/cognito-login-passwords.json', 'utf8'));

const results = [];
const record = (name, ok, extra = {}) => {
  results.push({ name, ok, ...extra });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra.detail ? ` — ${extra.detail}` : ''}`);
};

const api = async (path, { method = 'POST', token, body, headers: extra } = {}) => {
  const headers = { 'content-type': 'application/json', ...(extra || {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = {};
  try { json = await response.json(); } catch { json = {}; }
  return { status: response.status, json };
};

const login = async (email) => {
  const { status, json } = await api('/auth/login', {
    body: { email, password: passwords[email] || passwords[email.toLowerCase()] },
  });
  if (status !== 200 || !json.authentication?.idToken) {
    throw new Error(`login failed for ${email}: ${status} ${json.error || json.message || ''}`);
  }
  return json.authentication.idToken;
};

const write = (token, body, extraHeaders = {}) =>
  api('/data/write', { token, body, headers: extraHeaders });
const query = (token, body) => api('/data/query', { token, body });
const rowOf = (payload) => (Array.isArray(payload) ? payload[0] : payload);

const aCheck = async (token) => {
  const { status, json } = await query(token, {
    table: 'check_intake_items',
    select: 'id, tenant_id, carrier_name, amount, status, check_stage, front_image_path',
    limit: 1,
  });
  if (status !== 200 || !json.data?.[0]?.id) throw new Error('no visible check for tenant');
  return json.data[0];
};

const main = async () => {
  const freedomToken = await login(FREEDOM_EMAIL);
  const c1cToken = await login(C1C_EMAIL);
  const freedomCheck = await aCheck(freedomToken);
  record('Freedom check loaded', Boolean(freedomCheck?.id) && freedomCheck.tenant_id === FREEDOM_TENANT, {
    detail: `freedom=${freedomCheck.id} amount=${freedomCheck.amount}`,
  });
  try {
    await aCheck(c1cToken);
    record('C1C has visible check_intake_items', true);
  } catch (error) {
    record('C1C has no visible check_intake_items (restore has Freedom checks only)', true, {
      detail: String(error.message),
    });
  }

  const unauth = await write(null, {
    table: 'check_messages',
    op: 'insert',
    values: { check_id: freedomCheck.id, body: MARKER },
  });
  record('unauthenticated write is 401', unauth.status === 401, { detail: `status=${unauth.status}` });

  const note = await write(freedomToken, {
    table: 'check_messages',
    op: 'insert',
    values: { check_id: freedomCheck.id, body: MARKER, sender_id: NINTH, tenant_id: C1C_TENANT, user_id: NINTH },
  }, { 'x-user-id': NINTH, 'x-tenant-id': C1C_TENANT });
  const noteRow = rowOf(note.json.data);
  record('Freedom insert own check note', note.status === 200 && noteRow?.body === MARKER, {
    detail: `status=${note.status} error=${note.json.error || ''}`,
  });
  record('spoofed sender ignored on note insert', note.status === 200 && noteRow?.sender_id !== NINTH, {
    detail: `sender=${noteRow?.sender_id}`,
  });

  const c1cNote = await write(c1cToken, {
    table: 'check_messages',
    op: 'insert',
    values: { check_id: freedomCheck.id, body: `${MARKER} c1c` },
  });
  record('C1C cannot insert Freedom check note', c1cNote.status === 403, {
    detail: `status=${c1cNote.status} error=${c1cNote.json.error || ''}`,
  });

  const badUuid = await write(freedomToken, {
    table: 'check_messages',
    op: 'insert',
    values: { check_id: 'not-a-uuid', body: MARKER },
  });
  record('invalid UUID is 400', badUuid.status === 400, { detail: `status=${badUuid.status}` });

  const financial = await write(freedomToken, {
    table: 'homeowner_ledger_events',
    op: 'insert',
    values: { amount: 1, event_type: 'ops_note' },
  });
  record('direct ledger insert denied', financial.status === 403, {
    detail: `status=${financial.status} error=${financial.json.error || ''}`,
  });

  const intakeAmount = await write(freedomToken, {
    table: 'check_intake_items',
    op: 'update',
    values: { amount: 1 },
    filters: [{ column: 'id', op: 'eq', value: freedomCheck.id }],
  });
  record('intake amount update denied', intakeAmount.status === 403);

  const endorse = await write(freedomToken, {
    table: 'check_endorsements',
    op: 'update',
    values: { status: 'signed', signed_at: new Date().toISOString() },
    filters: [{ column: 'check_id', op: 'eq', value: freedomCheck.id }],
  });
  record('endorsement signed status denied', endorse.status === 403, {
    detail: `error=${endorse.json.error || ''}`,
  });

  const ccAmount = await write(freedomToken, {
    table: 'claim_checks',
    op: 'update',
    values: { amount: 12 },
    filters: [{ column: 'check_intake_item_id', op: 'eq', value: freedomCheck.id }],
  });
  record('claim_checks amount denied', ccAmount.status === 403);

  const ccSafe = await write(freedomToken, {
    table: 'claim_checks',
    op: 'update',
    values: { notes: MARKER },
    filters: [{ column: 'check_intake_item_id', op: 'eq', value: freedomCheck.id }],
  });
  record('Freedom descriptive claim_checks update (or no row)', ccSafe.status === 200 || (ccSafe.status === 403 && ccSafe.json.error === 'rls_denied'), {
    detail: `status=${ccSafe.status} error=${ccSafe.json.error || ''}`,
  });

  const objectPath = `check-intake/${freedomCheck.id}/files/aws-t3-test/${Date.now()}.txt`;
  const uploadUrl = await api('/storage/upload-url', {
    token: freedomToken,
    body: {
      bucket: 'claim-files',
      path: objectPath,
      contentType: 'text/plain',
      contentLength: MARKER.length,
      tenant_id: C1C_TENANT,
    },
    headers: { 'x-tenant-id': C1C_TENANT },
  });
  record('Freedom authorized upload-url', uploadUrl.status === 200 && Boolean(uploadUrl.json.uploadUrl), {
    detail: `status=${uploadUrl.status} error=${uploadUrl.json.error || ''}`,
  });

  let uploaded = false;
  if (uploadUrl.json.uploadUrl) {
    const put = await fetch(uploadUrl.json.uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: MARKER,
    });
    uploaded = put.ok;
    record('presigned PUT succeeds', put.ok, { detail: `status=${put.status}` });
  } else {
    record('presigned PUT succeeds', false, { detail: 'no uploadUrl' });
  }

  const conflict = await api('/storage/upload-url', {
    token: freedomToken,
    body: { bucket: 'claim-files', path: objectPath, contentType: 'text/plain' },
  });
  record('overwrite without upsert is 409', conflict.status === 409, { detail: `status=${conflict.status}` });

  const fileRow = await write(freedomToken, {
    table: 'check_files',
    op: 'insert',
    values: {
      check_intake_item_id: freedomCheck.id,
      file_name: 'aws-t3-test.txt',
      file_path: objectPath,
      file_type: 'text/plain',
      file_size: MARKER.length,
      category: 'other',
      source: 'manual',
      uploaded_by: NINTH,
    },
  });
  const file = rowOf(fileRow.json.data);
  record('Freedom insert check_files metadata', fileRow.status === 200 && file?.file_path === objectPath, {
    detail: `status=${fileRow.status} error=${fileRow.json.error || ''}`,
  });

  const sign = await api('/storage/sign', {
    token: freedomToken,
    body: { bucket: 'claim-files', path: objectPath, expiresIn: 120 },
  });
  record('authorized read/sign succeeds', sign.status === 200 && Boolean(sign.json.signedUrl), {
    detail: `status=${sign.status}`,
  });

  const c1cSign = await api('/storage/sign', {
    token: c1cToken,
    body: { bucket: 'claim-files', path: objectPath, expiresIn: 120 },
  });
  record('C1C cannot access Freedom object', c1cSign.status === 403, { detail: `status=${c1cSign.status}` });

  const c1cUpload = await api('/storage/upload-url', {
    token: c1cToken,
    body: { bucket: 'claim-files', path: objectPath, contentType: 'text/plain' },
  });
  record('C1C cannot upload to Freedom check prefix', c1cUpload.status === 403, {
    detail: `status=${c1cUpload.status} error=${c1cUpload.json.error || ''}`,
  });

  const unauthSign = await api('/storage/sign', {
    body: { bucket: 'claim-files', path: objectPath },
  });
  record('unauthenticated storage access fails', unauthSign.status === 401, { detail: `status=${unauthSign.status}` });

  const depositBucket = await api('/storage/upload-url', {
    token: freedomToken,
    body: { bucket: 'deposit-attachments', path: objectPath, contentType: 'text/plain' },
  });
  record('deposit-attachments write denied', depositBucket.status === 403);

  const movedPath = `check-intake/${freedomCheck.id}/files/aws-t3-test/${Date.now()}-moved.txt`;
  const moved = await api('/storage/move', {
    token: freedomToken,
    body: { bucket: 'claim-files', from: objectPath, to: movedPath },
  });
  record('authorized move succeeds', moved.status === 200, { detail: `status=${moved.status} error=${moved.json.error || ''}` });

  const c1cDelete = await api('/storage/delete', {
    token: c1cToken,
    body: { bucket: 'claim-files', path: moved.status === 200 ? movedPath : objectPath },
  });
  record('C1C cannot delete Freedom object', c1cDelete.status === 403);

  const del = await api('/storage/delete', {
    token: freedomToken,
    body: { bucket: 'claim-files', path: moved.status === 200 ? movedPath : objectPath },
  });
  record('authorized delete succeeds', del.status === 200, { detail: `status=${del.status}` });

  if (file?.id) {
    const delRow = await write(freedomToken, {
      table: 'check_files',
      op: 'delete',
      filters: [{ column: 'id', op: 'eq', value: file.id }],
    });
    record('Freedom delete check_files row', delRow.status === 200, { detail: `status=${delRow.status}` });
  } else {
    record('Freedom delete check_files row', false, { detail: 'no file row' });
  }

  if (noteRow?.id) {
    const soft = await write(freedomToken, {
      table: 'check_messages',
      op: 'update',
      values: { is_deleted: true },
      filters: [{ column: 'id', op: 'eq', value: noteRow.id }],
    });
    record('Freedom soft-delete own note', soft.status === 200, { detail: `status=${soft.status}` });
  }

  const provider = await api('/functions/v1/moov-transfer', { token: freedomToken, body: { amount: 1 } });
  record('provider guard still 403', provider.status === 403 && /provider/i.test(String(provider.json.error || provider.json.message || '')), {
    detail: `status=${provider.status} error=${provider.json.error || provider.json.message || ''}`,
  });

  const failed = results.filter((row) => !row.ok);
  console.log(JSON.stringify({
    ok: failed.length === 0,
    passed: results.filter((row) => row.ok).length,
    failed: failed.length,
    uploaded,
    freedomCheck: freedomCheck.id,
    results,
  }, null, 2));
  if (failed.length) process.exit(1);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
