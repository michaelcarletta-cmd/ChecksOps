#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hashZipMembers } from '../../../../scripts/deployment-guard/lib/zip-members.mjs';
import {
  FUNCTION_NAME,
  ACCEPTED_SOURCE_SHA256,
  PRESERVE,
} from './constants.mjs';

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const SPA_BUCKET = 'checksops-production-frontend-806168576068';
const BEFORE = JSON.parse(fs.readFileSync('/opt/cursor/artifacts/prod-lambda-preflight.json', 'utf8'));
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function loadAwsEnv() {
  for (const line of fs.readFileSync('/tmp/macomp-aws.env', 'utf8').split('\n')) {
    const m = line.match(/^export ([A-Z0-9_]+)=(.*)$/);
    if (m) process.env[m[1]] = m[2];
  }
}

function awsJson(args) {
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], { encoding: 'utf8' });
  return out.trim() ? JSON.parse(out) : {};
}

function invokeJson(name, payload) {
  const outFile = path.join(os.tmpdir(), `verify-${name}-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
  const raw = execFileSync(AWS, [
    '--region', REGION, 'lambda', 'invoke',
    '--function-name', name,
    '--cli-binary-format', 'raw-in-base64-out',
    '--payload', JSON.stringify(payload),
    outFile,
  ], { encoding: 'utf8' });
  return { meta: JSON.parse(raw), body: JSON.parse(fs.readFileSync(outFile, 'utf8')) };
}

function httpEvent(path, method, body, headers = {}) {
  return {
    rawPath: path,
    rawQueryString: '',
    headers: { 'content-type': 'application/json', ...headers },
    requestContext: {
      stage: '$default',
      http: { method, path, sourceIp: '127.0.0.1' },
    },
    body: body == null ? null : JSON.stringify(body),
    isBase64Encoded: false,
  };
}

function invokeApi(path, method, body, headers) {
  const result = invokeJson(FUNCTION_NAME, httpEvent(path, method, body, headers));
  const payload = result.body;
  let parsed = payload;
  if (payload && typeof payload.body === 'string') {
    try { parsed = { ...payload, json: JSON.parse(payload.body) }; } catch { parsed = payload; }
  }
  return {
    statusCode: payload.statusCode,
    json: parsed.json || parsed,
    functionError: result.meta.FunctionError || null,
  };
}

loadAwsEnv();
const cfg = awsJson(['lambda', 'get-function-configuration', '--function-name', FUNCTION_NAME]);
const fn = awsJson(['lambda', 'get-function', '--function-name', FUNCTION_NAME]);
const zipPath = path.join(os.tmpdir(), `prod-prep-api-after-${Date.now()}.zip`);
execFileSync('curl', ['-fsSL', fn.Code.Location, '-o', zipPath]);
const afterMembers = hashZipMembers(fs.readFileSync(zipPath));
const beforeMembers = BEFORE.live_members;
const changed = Object.keys({ ...beforeMembers, ...afterMembers }).filter((k) => beforeMembers[k] !== afterMembers[k]).sort();
const added = Object.keys(afterMembers).filter((k) => !beforeMembers[k]).sort();
const deleted = Object.keys(beforeMembers).filter((k) => !afterMembers[k]).sort();
const preserve = {};
for (const name of PRESERVE) {
  preserve[name] = {
    before: beforeMembers[name],
    after: afterMembers[name],
    unchanged: beforeMembers[name] === afterMembers[name],
  };
}
const owned = {};
for (const [name, expected] of Object.entries(ACCEPTED_SOURCE_SHA256)) {
  owned[name] = {
    expected,
    after: afterMembers[name] || null,
    match: afterMembers[name] === expected,
  };
}

const spa = awsJson(['s3api', 'get-object', '--bucket', SPA_BUCKET, '--key', 'index.html', '/tmp/prod-index-after.html']);
const indexHtml = fs.readFileSync('/tmp/prod-index-after.html', 'utf8');
const spaEntry = (indexHtml.match(/\/assets\/(index-[A-Za-z0-9_-]+\.js)/) || [])[1] || null;
const spaSha = sha256(fs.readFileSync('/tmp/prod-index-after.html'));

const sql49 = invokeJson('checksops-prod-macomp49-oneshot-ad99', { action: 'inspect' });
const sql48 = invokeJson('checksops-prod-macomp48-oneshot-ad99', { action: 'inspect' });
const sql47 = invokeJson('checksops-prod-macomp47-oneshot-ad99', { action: 'inspect' });
const sql39 = invokeJson('checksops-prod-mops-sql39-inspect-ad99', { action: 'inspect' });
const snap = sql49.body?.details?.snapshot || sql49.body?.details || {};

const api = {
  health: invokeApi('/health', 'GET'),
  identity_me_unauth: invokeApi('/identity/me', 'GET'),
  roster_unauth: invokeApi('/functions/v1/mortgage-agent-compensation', 'POST', { action: 'roster' }),
  monthly_unauth: invokeApi('/functions/v1/mortgage-agent-compensation', 'POST', { action: 'monthly', period: '2026-10' }),
  entries_unauth: invokeApi('/functions/v1/mortgage-agent-compensation', 'POST', { action: 'entries', period: '2026-10' }),
  return_unauth: invokeApi('/functions/v1/mortgage-agent-compensation', 'POST', { action: 'return_to_queue', request_id: '5b20db20-13e1-4919-9528-06388d8661d2', reason: 'do-not-exercise' }),
  adjust_unauth: invokeApi('/functions/v1/mortgage-agent-compensation', 'POST', { action: 'adjust', parent_entry_id: '00000000-0000-0000-0000-000000000001', amount_cents: -1, reason: 'do-not-exercise' }),
  hire_unauth: invokeApi('/functions/v1/hire-mortgage-agent', 'POST', { email: 'do-not-hire@example.invalid', full_name: 'Do Not Hire' }),
  roster_spoof: invokeApi('/functions/v1/mortgage-agent-compensation', 'POST', { action: 'roster' }, { 'x-user-id': '233c588f-dc33-4307-8c3f-3da49c9fd2b3', 'x-role': 'admin' }),
  passwordless_options: invokeApi('/auth/passwordless/start', 'OPTIONS'),
};

const report = {
  ok: true,
  inspected_at: new Date().toISOString(),
  lambda: {
    FunctionName: cfg.FunctionName,
    CodeSha256: cfg.CodeSha256,
    RevisionId: cfg.RevisionId,
    LastModified: cfg.LastModified,
  },
  member_count_before: Object.keys(beforeMembers).length,
  member_count_after: Object.keys(afterMembers).length,
  changed,
  added,
  deleted,
  preserve,
  owned,
  spa: {
    VersionId: spa.VersionId,
    entry: spaEntry,
    index_sha256: spaSha,
    unchanged: spaSha === BEFORE.spa.index_sha256 && spa.VersionId === BEFORE.spa.VersionId,
  },
  sql: {
    sql47: snap.sql47_catalog_fingerprint,
    sql48: snap.sql48_return_hash,
    sql49: snap.sql49_adjust_hash,
    sql39: snap.sql39_hash,
    cbe_unique: snap.cbe_unique?.indexname,
    cbe_count: snap.cbe_count,
    compensation: snap.compensation_counts,
    audit: snap.audit_count,
    return_audit: snap.compensation_audit_return_count,
    adjust_audit: snap.compensation_audit_adjust_count,
    children: snap.child_entry_count,
    freedom: snap.freedom_request,
    events: snap.known_billing_events,
    adjust_called: snap.adjust_called,
    return_called: snap.return_called,
  },
  sql47_ok: sql47.body?.ok !== false,
  sql48_ok: sql48.body?.ok !== false,
  sql39_ok: sql39.body?.ok !== false,
  api,
};

const failures = [];
if (cfg.CodeSha256 !== 'CWB8lxnHoqANyVcaNpKL7h4MtDSPMlHZ6wliFuGE6yA=') failures.push('lambda_sha_unexpected');
if (added.join() !== 'mortgage-agent-compensation.mjs') failures.push(`added:${added.join(',')}`);
if (deleted.length) failures.push(`deleted:${deleted.join(',')}`);
const unexpectedChanged = changed.filter((n) => !['app-services.mjs', 'tenant-admin.mjs', 'identity.mjs', 'mortgage-agent-compensation.mjs'].includes(n));
if (unexpectedChanged.length) failures.push(`unexpected_changed:${unexpectedChanged.join(',')}`);
if (!Object.values(owned).every((row) => row.match)) failures.push('owned_hash_mismatch');
if (!Object.values(preserve).every((row) => row.unchanged)) failures.push('preserve_changed');
if (report.spa.unchanged !== true) failures.push('spa_changed');
if (snap.sql47_catalog_fingerprint !== '3ef6b9b6ff9506e7c33d097cb5e01604cd7454f943114a6d3e85f0f5364ec7c0') failures.push('sql47');
if (snap.sql48_return_hash !== '4a8edeb99404042b141b06a2566d3f7ccfd3a74a1a423ebfdb4df99a0b87ac76') failures.push('sql48');
if (snap.sql49_adjust_hash !== 'e05bce276d9c6969fd69055b853467a7ec3fd970800d47604bf1ca4b7e541fd9') failures.push('sql49');
if (snap.sql39_hash !== '0d959621d34c99879dc9092cb925bfdb169273a21bea76c6a44242c2d64cd126') failures.push('sql39');
if (Number(snap.cbe_count) !== 131) failures.push('cbe_count');
if ((snap.compensation_counts?.total ?? 1) !== 0) failures.push('compensation');
if ((snap.audit_count ?? 1) !== 0 || (snap.compensation_audit_return_count ?? 1) !== 0 || (snap.compensation_audit_adjust_count ?? 1) !== 0) failures.push('audit');
if (snap.freedom_request?.id !== '5b20db20-13e1-4919-9528-06388d8661d2') failures.push('freedom');
for (const [name, row] of Object.entries(api)) {
  if (name === 'health') {
    if (![200, 204].includes(row.statusCode)) failures.push(`api_${name}_${row.statusCode}`);
    continue;
  }
  if (name === 'passwordless_options') {
    if (![200, 204].includes(row.statusCode)) failures.push(`api_${name}_${row.statusCode}`);
    continue;
  }
  if (![401, 403].includes(row.statusCode)) failures.push(`api_${name}_${row.statusCode}`);
}
report.failures = failures;
report.ok = failures.length === 0;
fs.writeFileSync('/opt/cursor/artifacts/prod-lambda-verify.json', `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({
  ok: report.ok,
  lambda: report.lambda,
  changed,
  added,
  deleted,
  owned,
  preserve_ok: Object.values(preserve).every((row) => row.unchanged),
  spa: report.spa,
  sql: {
    sql47: snap.sql47_catalog_fingerprint,
    sql48: snap.sql48_return_hash,
    sql49: snap.sql49_adjust_hash,
    sql39: snap.sql39_hash,
    cbe_count: snap.cbe_count,
    compensation: snap.compensation_counts,
    audits: { all: snap.audit_count, ret: snap.compensation_audit_return_count, adj: snap.compensation_audit_adjust_count },
  },
  api: Object.fromEntries(Object.entries(api).map(([k, v]) => [k, { statusCode: v.statusCode, error: v.json?.error || v.json?.json?.error || null }])),
  failures,
}, null, 2)}\n`);
if (!report.ok) process.exit(2);
