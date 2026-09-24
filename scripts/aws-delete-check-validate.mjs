#!/usr/bin/env node
/**
 * Live Delete Check validation against AWS staging API + Cognito.
 *
 * Safety:
 * - Creates a disposable check via POST /workflow/checks
 * - Adds non-financial dependent rows (payee + check_files metadata)
 * - Deletes ONLY the disposable check via DELETE /workflow/checks/:id
 * - Verifies tenant isolation and useful error responses
 */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const API = process.env.CHECKSOPS_API_URL || 'https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging';
const FREEDOM_EMAIL = 'checksops-tester@freedomadj.com';
const C1C_EMAIL = 'payments@condition1commercial.com';
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID || 'us-east-1_vPmQ7cL1F';
const CLIENT_ID = process.env.COGNITO_USER_POOL_CLIENT_ID || '71bb7a192cbl6o6s8m259tl589';
const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;

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
  if (status === 410 && String(json?.error || '') === 'password_auth_disabled') {
    // Staging sometimes disables app-level password login in favor of EMAIL_OTP / passkeys.
    // For operator validation we fall back to Cognito admin-initiate-auth (staging only).
    const password = passwords[email] || passwords[email.toLowerCase()];
    if (!password) throw new Error(`missing password for ${email}`);
    const out = execFileSync(AWS, [
      '--region', 'us-east-1',
      'cognito-idp', 'admin-initiate-auth',
      '--user-pool-id', USER_POOL_ID,
      '--client-id', CLIENT_ID,
      '--auth-flow', 'ADMIN_NO_SRP_AUTH',
      '--auth-parameters', `USERNAME=${email},PASSWORD=${password}`,
      '--output', 'json',
    ], { encoding: 'utf8' });
    const parsed = JSON.parse(out || '{}');
    const idToken = parsed?.AuthenticationResult?.IdToken;
    if (!idToken) throw new Error(`admin-initiate-auth returned no IdToken for ${email}`);
    return idToken;
  }
  if (status !== 200 || !json.authentication?.idToken) {
    throw new Error(`login failed for ${email}: ${status} ${json.error || json.message || ''}`);
  }
  return json.authentication.idToken;
};

const write = (token, body, extraHeaders = {}) =>
  api('/data/write', { token, body, headers: extraHeaders });
const query = (token, body) => api('/data/query', { token, body });
const rowOf = (payload) => (Array.isArray(payload) ? payload[0] : payload);

const createDisposableCheck = async (token, marker) => {
  const { status, json } = await api('/workflow/checks', {
    method: 'POST',
    token,
    body: { carrier_name: marker },
  });
  if (status !== 200 || !json?.data?.id) {
    throw new Error(`create check failed: ${status} ${(json.error || json.message || '').toString()}`);
  }
  return json.data;
};

const main = async () => {
  const marker = `AWS DELETE CHECK TEST ${new Date().toISOString()} ${crypto.randomUUID().slice(0, 8)}`;
  const freedomToken = await login(FREEDOM_EMAIL);
  const c1cToken = await login(C1C_EMAIL);

  const disposable = await createDisposableCheck(freedomToken, marker);
  const checkId = disposable.id;
  record('created disposable check', Boolean(checkId), { detail: `checkId=${checkId}` });

  const payee = await write(freedomToken, {
    table: 'check_payees',
    op: 'insert',
    values: { check_id: checkId, payee_name: 'Delete Test Payee', payee_type: 'insured' },
  });
  record('insert check_payees succeeds', payee.status === 200, { detail: `status=${payee.status} error=${payee.json.error || ''}` });

  // Upload a small file and insert its metadata row (non-financial dependency).
  const objectPath = `check-intake/${checkId}/files/delete-check-test/${Date.now()}-delete-check.txt`;
  const upload = await api('/storage/upload-url', {
    token: freedomToken,
    body: { bucket: 'claim-files', path: objectPath, contentType: 'text/plain', upsert: true },
  });
  record('storage upload-url succeeds', upload.status === 200 && upload.json.uploadUrl, {
    detail: `status=${upload.status} error=${upload.json.error || upload.json.message || ''}`,
  });
  if (upload.status === 200 && upload.json.uploadUrl) {
    const put = await fetch(String(upload.json.uploadUrl), {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: 'delete-check-test',
    });
    record('presigned PUT succeeds', put.ok, { detail: `status=${put.status}` });

    const fileRow = await write(freedomToken, {
      table: 'check_files',
      op: 'insert',
      values: {
        check_intake_item_id: checkId,
        file_name: 'delete-check-test.txt',
        file_path: objectPath,
        file_type: 'text/plain',
        file_size: 17,
        category: 'other',
        source: 'manual',
      },
    });
    record('insert check_files row succeeds', fileRow.status === 200, { detail: `status=${fileRow.status} error=${fileRow.json.error || ''}` });
  }

  const unauth = await api(`/workflow/checks/${checkId}`, { method: 'DELETE', token: null, body: { check_id: checkId, reason: 'duplicate' } });
  record('unauthenticated delete is 401', unauth.status === 401, { detail: `status=${unauth.status}` });

  const crossTenant = await api(`/workflow/checks/${checkId}`, { method: 'DELETE', token: c1cToken, body: { check_id: checkId, reason: 'duplicate' } });
  record('cross-tenant delete is denied', crossTenant.status === 403, { detail: `status=${crossTenant.status} error=${crossTenant.json.error || crossTenant.json.message || ''}` });

  const missingReason = await api(`/workflow/checks/${checkId}`, { method: 'DELETE', token: freedomToken, body: { check_id: checkId, reason: 'x' } });
  record('reason is required (min 3)', missingReason.status === 400, { detail: `status=${missingReason.status} error=${missingReason.json.error || ''}` });

  const del = await api(`/workflow/checks/${checkId}`, { method: 'DELETE', token: freedomToken, body: { check_id: checkId, reason: 'duplicate intake' } });
  record('authorized delete succeeds', del.status === 200 && del.json.ok === true && del.json.data?.deleted === true, {
    detail: `status=${del.status} error=${del.json.error || del.json.message || ''}`,
  });

  // Give the API a moment before validating reads (Lambda + DB commit).
  await sleep(250);

  const checkGone = await query(freedomToken, {
    table: 'check_intake_items',
    select: 'id',
    filters: [{ column: 'id', op: 'eq', value: checkId }],
    limit: 1,
  });
  record('deleted check no longer queryable', checkGone.status === 200 && Array.isArray(checkGone.json.data) && checkGone.json.data.length === 0, {
    detail: `status=${checkGone.status} rows=${(checkGone.json.data || []).length}`,
  });

  const payeesGone = await query(freedomToken, {
    table: 'check_payees',
    select: 'id',
    filters: [{ column: 'check_id', op: 'eq', value: checkId }],
    limit: 1,
  });
  record('dependent payees cleaned up', payeesGone.status === 200 && Array.isArray(payeesGone.json.data) && payeesGone.json.data.length === 0, {
    detail: `status=${payeesGone.status} rows=${(payeesGone.json.data || []).length}`,
  });

  const filesGone = await query(freedomToken, {
    table: 'check_files',
    select: 'id',
    filters: [{ column: 'check_intake_item_id', op: 'eq', value: checkId }],
    limit: 1,
  });
  record('dependent check_files rows cleaned up', filesGone.status === 200 && Array.isArray(filesGone.json.data) && filesGone.json.data.length === 0, {
    detail: `status=${filesGone.status} rows=${(filesGone.json.data || []).length}`,
  });

  const failed = results.filter((r) => !r.ok);
  console.log(JSON.stringify({ ok: failed.length === 0, checkId, marker, passed: results.filter((r) => r.ok).length, failed: failed.length, results }, null, 2));
  assert.equal(failed.length, 0);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

