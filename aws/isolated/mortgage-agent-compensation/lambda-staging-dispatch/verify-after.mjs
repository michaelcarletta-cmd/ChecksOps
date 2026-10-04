#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hashZipMembers } from '../../../../scripts/deployment-guard/lib/zip-members.mjs';
import {
  FUNCTION_NAME,
  PRODUCTION_FUNCTION_NAME,
  PRODUCTION_CODE_SHA256,
  PRODUCTION_REVISION_ID,
  PATCHED_APP_SERVICES_SHA256,
  LIVE_APP_SERVICES_SHA256,
  LIVE_PRESERVE_SHA256,
  EXPECTED_LIVE_CODE_SHA256,
  EXPECTED_LIVE_REVISION_ID,
} from './constants.mjs';

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const BEFORE = JSON.parse(fs.readFileSync('/opt/cursor/artifacts/staging-macomp-dispatch-preflight.json', 'utf8'));
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

function httpEvent(apiPath, method, body, headers = {}) {
  return {
    rawPath: apiPath,
    rawQueryString: '',
    headers: { 'content-type': 'application/json', ...headers },
    requestContext: {
      stage: '$default',
      http: { method, path: apiPath, sourceIp: '127.0.0.1' },
    },
    body: body == null ? null : JSON.stringify(body),
    isBase64Encoded: false,
  };
}

function invokeApi(name, apiPath, method, body, headers) {
  const result = invokeJson(name, httpEvent(apiPath, method, body, headers));
  const payload = result.body;
  let json = payload;
  if (payload && typeof payload.body === 'string') {
    try { json = JSON.parse(payload.body); } catch { json = payload; }
  }
  return {
    statusCode: payload.statusCode,
    json,
    functionError: result.meta.FunctionError || null,
  };
}

function extractClassA(source) {
  const match = String(source).match(/export const CLASS_A_FUNCTIONS = new Set\(\[([\s\S]*?)\]\);/);
  if (!match) return [];
  return [...match[1].matchAll(/'([a-z0-9-]+)'/g)].map((row) => row[1]);
}

loadAwsEnv();
const cfg = awsJson(['lambda', 'get-function-configuration', '--function-name', FUNCTION_NAME]);
const fn = awsJson(['lambda', 'get-function', '--function-name', FUNCTION_NAME]);
const prod = awsJson(['lambda', 'get-function-configuration', '--function-name', PRODUCTION_FUNCTION_NAME]);
const zipPath = path.join(os.tmpdir(), `staging-api-dispatch-after-${Date.now()}.zip`);
execFileSync('curl', ['-fsSL', fn.Code.Location, '-o', zipPath]);
const afterMembers = hashZipMembers(fs.readFileSync(zipPath));
const beforeMembers = BEFORE.live_owned
  ? { ...BEFORE.live_owned, ...(BEFORE.live_members || {}) }
  : BEFORE.live_members;
const allBefore = BEFORE.live_members || beforeMembers;
const changed = Object.keys({ ...allBefore, ...afterMembers }).filter((k) => allBefore[k] !== afterMembers[k]).sort();
const added = Object.keys(afterMembers).filter((k) => !allBefore[k]).sort();
const deleted = Object.keys(allBefore).filter((k) => !afterMembers[k]).sort();
const afterDispatcher = execFileSync('unzip', ['-p', zipPath, 'app-services.mjs']).toString('utf8');
const afterClassA = extractClassA(afterDispatcher);

const preserve = {};
for (const [name, expected] of Object.entries(LIVE_PRESERVE_SHA256)) {
  preserve[name] = {
    expected,
    before: allBefore[name] || BEFORE.live_owned?.[name] || null,
    after: afterMembers[name] || null,
    unchanged: (allBefore[name] || BEFORE.live_owned?.[name]) === afterMembers[name] && afterMembers[name] === expected,
  };
}

const api = {
  compensation_roster_unauth: invokeApi(FUNCTION_NAME, '/functions/v1/mortgage-agent-compensation', 'POST', { action: 'roster' }),
  compensation_monthly_unauth: invokeApi(FUNCTION_NAME, '/functions/v1/mortgage-agent-compensation', 'POST', { action: 'monthly', period: '2026-10' }),
  hire_unauth: invokeApi(FUNCTION_NAME, '/functions/v1/hire-mortgage-agent', 'POST', { email: 'do-not-hire@example.invalid', full_name: 'Do Not Hire' }),
  endorse_link_unauth: invokeApi(FUNCTION_NAME, '/functions/v1/homeowner-ledger-endorse-link', 'POST', {}),
  document_sign_link_unauth: invokeApi(FUNCTION_NAME, '/functions/v1/homeowner-ledger-document-sign-link', 'POST', {}),
  signature_request_unauth: invokeApi(FUNCTION_NAME, '/functions/v1/send-signature-request', 'POST', {}),
  branding_unauth: invokeApi(FUNCTION_NAME, '/functions/v1/tenant-email-branding-get', 'POST', {}),
  unknown_unauth: invokeApi(FUNCTION_NAME, '/functions/v1/this-function-does-not-exist', 'POST', {}),
  prod_compensation_unauth: invokeApi(PRODUCTION_FUNCTION_NAME, '/functions/v1/mortgage-agent-compensation', 'POST', { action: 'roster' }),
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
  production: {
    FunctionName: prod.FunctionName,
    CodeSha256: prod.CodeSha256,
    RevisionId: prod.RevisionId,
    LastModified: prod.LastModified,
  },
  starting_authority: {
    CodeSha256: EXPECTED_LIVE_CODE_SHA256,
    RevisionId: EXPECTED_LIVE_REVISION_ID,
  },
  member_count_before: BEFORE.member_count,
  member_count_after: Object.keys(afterMembers).length,
  changed,
  added,
  deleted,
  preserve,
  after_app_services: afterMembers['app-services.mjs'] || null,
  after_class_a_has_compensation: afterClassA.includes('mortgage-agent-compensation'),
  after_class_a_has_endorse: afterClassA.includes('homeowner-ledger-endorse-link'),
  after_class_a_has_document_sign: afterClassA.includes('homeowner-ledger-document-sign-link'),
  api,
};

const failures = [];
if (cfg.CodeSha256 === EXPECTED_LIVE_CODE_SHA256) failures.push('lambda_sha_unchanged');
if (cfg.RevisionId === EXPECTED_LIVE_REVISION_ID) failures.push('lambda_rev_unchanged');
if (afterMembers['app-services.mjs'] !== PATCHED_APP_SERVICES_SHA256) failures.push('app_services_not_patched');
if (afterMembers['app-services.mjs'] === LIVE_APP_SERVICES_SHA256) failures.push('app_services_still_live');
if (changed.join() !== 'app-services.mjs') failures.push(`changed:${changed.join(',')}`);
if (added.length) failures.push(`added:${added.join(',')}`);
if (deleted.length) failures.push(`deleted:${deleted.join(',')}`);
if (report.member_count_after !== BEFORE.member_count) failures.push('member_count_changed');
if (!Object.values(preserve).every((row) => row.unchanged)) failures.push('preserve_changed');
if (prod.CodeSha256 !== PRODUCTION_CODE_SHA256 || prod.RevisionId !== PRODUCTION_REVISION_ID) failures.push('production_drift');
if (api.compensation_roster_unauth.statusCode !== 401 || api.compensation_roster_unauth.json?.error !== 'missing_cognito_token') {
  failures.push(`compensation_roster:${api.compensation_roster_unauth.statusCode}:${api.compensation_roster_unauth.json?.error}`);
}
if (api.compensation_monthly_unauth.statusCode !== 401 || api.compensation_monthly_unauth.json?.error !== 'missing_cognito_token') {
  failures.push(`compensation_monthly:${api.compensation_monthly_unauth.statusCode}:${api.compensation_monthly_unauth.json?.error}`);
}
if (api.hire_unauth.json?.error !== 'missing_cognito_token') failures.push('hire_not_class_a');
if (api.unknown_unauth.json?.error !== 'provider_disabled') failures.push('unknown_not_provider_disabled');
if (api.prod_compensation_unauth.json?.error !== 'missing_cognito_token') failures.push('prod_compensation_drift');
for (const name of ['endorse_link_unauth', 'document_sign_link_unauth', 'signature_request_unauth', 'branding_unauth']) {
  if (api[name].json?.error === 'provider_disabled') failures.push(`${name}_provider_disabled`);
}
if (!report.after_class_a_has_compensation) failures.push('class_a_missing_compensation');
if (!report.after_class_a_has_endorse) failures.push('class_a_missing_endorse');
if (!report.after_class_a_has_document_sign) failures.push('class_a_missing_document_sign');

report.failures = failures;
report.ok = failures.length === 0;
fs.writeFileSync('/opt/cursor/artifacts/staging-macomp-dispatch-verify.json', `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({
  ok: report.ok,
  lambda: report.lambda,
  production: report.production,
  changed,
  added,
  deleted,
  after_app_services: report.after_app_services,
  preserve_ok: Object.values(preserve).every((row) => row.unchanged),
  api: Object.fromEntries(Object.entries(api).map(([k, v]) => [k, { statusCode: v.statusCode, error: v.json?.error || null }])),
  failures,
}, null, 2)}\n`);
if (!report.ok) process.exit(2);
