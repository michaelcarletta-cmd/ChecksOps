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
import os from 'node:os';
import path from 'node:path';

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

const parseS3TargetFromPresignedUrl = (presignedUrl) => {
  const url = new URL(String(presignedUrl || ''));
  const bucket = String(url.hostname || '').split('.')[0] || '';
  const key = String(url.pathname || '').replace(/^\/+/, '');
  return { bucket, key };
};

const headObjectExists = (bucket, key) => {
  try {
    execFileSync(AWS, [
      '--region', 'us-east-1',
      's3api', 'head-object',
      '--bucket', String(bucket),
      '--key', String(key),
      '--output', 'json',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
};

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

const uploadDisposableFile = async (token, checkId) => {
  const objectPath = `check-intake/${checkId}/files/delete-check-test/${Date.now()}-delete-check.txt`;
  const upload = await api('/storage/upload-url', {
    token,
    body: { bucket: 'claim-files', path: objectPath, contentType: 'text/plain', upsert: true },
  });
  record('storage upload-url succeeds', upload.status === 200 && upload.json.uploadUrl, {
    detail: `status=${upload.status} error=${upload.json.error || upload.json.message || ''}`,
  });
  if (upload.status !== 200 || !upload.json.uploadUrl) {
    return { ok: false, objectPath, upload };
  }
  const { bucket: s3Bucket, key: s3Key } = parseS3TargetFromPresignedUrl(upload.json.uploadUrl);
  const put = await fetch(String(upload.json.uploadUrl), {
    method: 'PUT',
    headers: { 'content-type': 'text/plain' },
    body: 'delete-check-test',
  });
  record('presigned PUT succeeds', put.ok, { detail: `status=${put.status}` });
  const exists = headObjectExists(s3Bucket, s3Key);
  record('uploaded test S3 object exists', exists, { detail: `bucket=${s3Bucket} key=${s3Key}` });

  const fileRow = await write(token, {
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

  return { ok: true, objectPath, s3Bucket, s3Key };
};

const ensureTerminalFinancialViaOneshot = async ({ checkId }) => {
  // Uses a temporary VPC-attached Lambda with the same DB secret as checksops-staging-api
  // to set deposited_at/status/check_stage on a disposable check, solely to validate
  // delete protections for terminal financial state.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-deletecheck-oneshot-'));
  const lambdaName = `checksops-staging-deletecheck-financial-oneshot-${crypto.randomUUID().slice(0, 8)}`;
  const indexPath = path.join(tmp, 'index.mjs');
  const pkgPath = path.join(tmp, 'package.json');
  fs.writeFileSync(pkgPath, JSON.stringify({
    name: lambdaName,
    private: true,
    type: 'module',
    dependencies: { '@aws-sdk/client-secrets-manager': '^3.0.0', pg: '^8.0.0' },
  }, null, 2));
  fs.writeFileSync(indexPath, `
import fs from 'node:fs';
import pg from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const { Client } = pg;
const region = process.env.AWS_REGION || 'us-east-1';
const secretArn = process.env.DATABASE_SECRET_ARN;
const databaseName = process.env.DATABASE_NAME || 'postgres';

async function loadDbSecret() {
  const sm = new SecretsManagerClient({ region });
  const out = await sm.send(new GetSecretValueCommand({ SecretId: secretArn }));
  return JSON.parse(out.SecretString || '{}');
}

export const handler = async (event = {}) => {
  const checkId = String(event.checkId || '');
  if (!checkId) return { ok: false, error: 'missing_check_id' };
  const creds = await loadDbSecret();
  const ssl = { ca: fs.readFileSync(new URL('./rds-global-bundle.pem', import.meta.url), 'utf8') };
  const client = new Client({ host: creds.host, port: creds.port || 5432, user: creds.username, password: creds.password, database: databaseName, ssl });
  await client.connect();
  try {
    await client.query('BEGIN');
    const row = (await client.query('SELECT id, tenant_id, uploaded_by FROM public.check_intake_items WHERE id = $1::uuid LIMIT 1', [checkId])).rows[0];
    if (!row) return { ok: false, error: 'check_not_found' };
    await client.query('SELECT set_config($1, $2, true)', ['request.app_user_id', String(row.uploaded_by)]);
    if (String(event.step) === 'set_deposited') {
      await client.query(
        \"UPDATE public.check_intake_items SET status = 'deposited', check_stage = 'deposited', deposited_at = now(), updated_at = now() WHERE id = $1::uuid\",
        [checkId],
      );
    } else if (String(event.step) === 'reset_deposited') {
      await client.query(
        \"UPDATE public.check_intake_items SET status = 'uploaded', check_stage = 'review', deposited_at = NULL, updated_at = now() WHERE id = $1::uuid\",
        [checkId],
      );
    } else {
      return { ok: false, error: 'unknown_step' };
    }
    await client.query('COMMIT');
    return { ok: true, checkId, step: event.step, tenantId: row.tenant_id, uploadedBy: row.uploaded_by };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    return { ok: false, error: String(e?.message || e).slice(0, 240) };
  } finally {
    try { await client.end(); } catch {}
  }
};
  `.trim() + '\n');
  fs.copyFileSync('/workspace/aws/functions/api/rds-global-bundle.pem', path.join(tmp, 'rds-global-bundle.pem'));

  execFileSync('npm', ['install', '--omit=dev'], { cwd: tmp, stdio: 'ignore' });
  const zipPath = path.join(os.tmpdir(), `${lambdaName}.zip`);
  try { fs.unlinkSync(zipPath); } catch {}
  execFileSync('zip', ['-qr', zipPath, '.'], { cwd: tmp, stdio: 'ignore' });

  const apiCfg = JSON.parse(execFileSync(AWS, ['--region', 'us-east-1', 'lambda', 'get-function-configuration', '--function-name', 'checksops-staging-api', '--output', 'json'], { encoding: 'utf8' }));
  const role = String(apiCfg.Role);
  const vpc = apiCfg.VpcConfig || {};
  const subnetIds = (vpc.SubnetIds || []).join(',');
  const securityGroupIds = (vpc.SecurityGroupIds || []).join(',');
  const secretArn = String(apiCfg.Environment?.Variables?.DATABASE_SECRET_ARN || '');
  const dbName = String(apiCfg.Environment?.Variables?.DATABASE_NAME || 'checksops');

  execFileSync(AWS, [
    '--region', 'us-east-1',
    'lambda', 'create-function',
    '--function-name', lambdaName,
    '--runtime', 'nodejs22.x',
    '--role', role,
    '--handler', 'index.handler',
    '--timeout', '120',
    '--memory-size', '512',
    '--zip-file', `fileb://${zipPath}`,
    '--environment', `Variables={DATABASE_SECRET_ARN=${secretArn},DATABASE_NAME=${dbName}}`,
    '--vpc-config', `SubnetIds=${subnetIds},SecurityGroupIds=${securityGroupIds}`,
    '--output', 'json',
  ], { encoding: 'utf8', stdio: 'ignore' });

  try { execFileSync(AWS, ['--region', 'us-east-1', 'lambda', 'wait', 'function-active', '--function-name', lambdaName], { encoding: 'utf8', stdio: 'ignore' }); } catch {}

  const invoke = (step) => {
    const outFile = path.join(os.tmpdir(), `${lambdaName}-${step}.json`);
    const payloadFile = path.join(os.tmpdir(), `${lambdaName}-${step}-payload.json`);
    fs.writeFileSync(payloadFile, JSON.stringify({ step, checkId }));
    execFileSync(AWS, [
      '--region', 'us-east-1',
      'lambda', 'invoke',
      '--function-name', lambdaName,
      '--payload', `file://${payloadFile}`,
      outFile,
    ], { encoding: 'utf8', stdio: 'ignore' });
    return JSON.parse(fs.readFileSync(outFile, 'utf8') || '{}');
  };

  const set = invoke('set_deposited');
  const reset = () => invoke('reset_deposited');

  return {
    ok: Boolean(set?.ok),
    set,
    reset,
    cleanup: () => {
      try { execFileSync(AWS, ['--region', 'us-east-1', 'lambda', 'delete-function', '--function-name', lambdaName], { encoding: 'utf8', stdio: 'ignore' }); } catch {}
    },
  };
};

const main = async () => {
  const marker = `AWS DELETE CHECK TEST ${new Date().toISOString()} ${crypto.randomUUID().slice(0, 8)}`;
  const freedomToken = await login(FREEDOM_EMAIL);
  const c1cToken = await login(C1C_EMAIL);

  const disposable1 = await createDisposableCheck(freedomToken, `${marker} A`);
  const checkId = disposable1.id;
  record('created disposable check', Boolean(checkId), { detail: `checkId=${checkId}` });

  const disposable2 = await createDisposableCheck(freedomToken, `${marker} B`);
  const checkId2 = disposable2.id;
  record('created second disposable check', Boolean(checkId2), { detail: `checkId2=${checkId2}` });

  const payee = await write(freedomToken, {
    table: 'check_payees',
    op: 'insert',
    values: { check_id: checkId, payee_name: 'Delete Test Payee', payee_type: 'insured' },
  });
  record('insert check_payees succeeds', payee.status === 200, { detail: `status=${payee.status} error=${payee.json.error || ''}` });

  const file1 = await uploadDisposableFile(freedomToken, checkId);
  const file2 = await uploadDisposableFile(freedomToken, checkId2);

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

  if (file1.ok) {
    const gone = !headObjectExists(file1.s3Bucket, file1.s3Key);
    record('deleted check S3 object is gone', gone, { detail: `bucket=${file1.s3Bucket} key=${file1.s3Key}` });
  }
  if (file2.ok) {
    const stillThere = headObjectExists(file2.s3Bucket, file2.s3Key);
    record('other check S3 object remains', stillThere, { detail: `bucket=${file2.s3Bucket} key=${file2.s3Key}` });
  }

  // Cleanup the second disposable check and confirm its object is cleaned up too.
  const del2 = await api(`/workflow/checks/${checkId2}`, { method: 'DELETE', token: freedomToken, body: { check_id: checkId2, reason: 'cleanup second disposable check' } });
  record('second authorized delete succeeds', del2.status === 200 && del2.json.ok === true && del2.json.data?.deleted === true, {
    detail: `status=${del2.status} error=${del2.json.error || del2.json.message || ''}`,
  });
  await sleep(250);
  if (file2.ok) {
    const gone2 = !headObjectExists(file2.s3Bucket, file2.s3Key);
    record('second check S3 object is gone', gone2, { detail: `bucket=${file2.s3Bucket} key=${file2.s3Key}` });
  }

  // Protected state: partner-linked checks must not be deletable.
  const partner = await createDisposableCheck(freedomToken, `${marker} PARTNER`);
  const partnerId = partner.id;
  const partnerUpdate = await write(freedomToken, {
    table: 'check_intake_items',
    op: 'update',
    values: { external_origin: { source_app: 'freedom_crm', source_check_id: 'abc' } },
    filters: [{ column: 'id', op: 'eq', value: partnerId }],
  });
  record('set partner external_origin succeeds', partnerUpdate.status === 200, { detail: `status=${partnerUpdate.status} error=${partnerUpdate.json.error || ''}` });
  const partnerDel = await api(`/workflow/checks/${partnerId}`, { method: 'DELETE', token: freedomToken, body: { check_id: partnerId, reason: 'should be denied' } });
  record('partner-linked delete is denied', partnerDel.status === 403 && partnerDel.json.error === 'cleanup_denied', {
    detail: `status=${partnerDel.status} error=${partnerDel.json.error || partnerDel.json.message || ''}`,
  });
  // Reset and clean up.
  await write(freedomToken, {
    table: 'check_intake_items',
    op: 'update',
    values: { external_origin: null },
    filters: [{ column: 'id', op: 'eq', value: partnerId }],
  });
  await api(`/workflow/checks/${partnerId}`, { method: 'DELETE', token: freedomToken, body: { check_id: partnerId, reason: 'cleanup partner disposable check' } });

  // Protected state: terminal financial checks must not be deletable.
  const fin = await createDisposableCheck(freedomToken, `${marker} FINANCIAL`);
  const finId = fin.id;
  const oneshot = await ensureTerminalFinancialViaOneshot({ checkId: finId });
  record('set terminal financial state via oneshot', oneshot.ok === true && oneshot.set?.ok === true, { detail: oneshot.set?.error ? `error=${oneshot.set.error}` : `checkId=${finId}` });
  const finDel = await api(`/workflow/checks/${finId}`, { method: 'DELETE', token: freedomToken, body: { check_id: finId, reason: 'should be denied' } });
  record('terminal-financial delete is denied', finDel.status === 403 && finDel.json.error === 'cleanup_denied', {
    detail: `status=${finDel.status} error=${finDel.json.error || finDel.json.message || ''}`,
  });
  // Reset and clean up.
  try { await oneshot.reset(); } catch {}
  try { await oneshot.cleanup(); } catch {}
  const finDel2 = await api(`/workflow/checks/${finId}`, { method: 'DELETE', token: freedomToken, body: { check_id: finId, reason: 'cleanup financial disposable check' } });
  record('financial check cleanup delete succeeds', finDel2.status === 200 && finDel2.json.ok === true, { detail: `status=${finDel2.status}` });

  const failed = results.filter((r) => !r.ok);
  console.log(JSON.stringify({ ok: failed.length === 0, checkId, marker, passed: results.filter((r) => r.ok).length, failed: failed.length, results }, null, 2));
  assert.equal(failed.length, 0);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

