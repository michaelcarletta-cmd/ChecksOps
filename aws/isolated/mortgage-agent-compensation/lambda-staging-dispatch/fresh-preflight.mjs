#!/usr/bin/env node
/**
 * Read-only staging Lambda dispatcher-repair preflight. No writes.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashZipMembers } from '../../../../scripts/deployment-guard/lib/zip-members.mjs';
import { patchLiveAppServices, addedLines } from './patch-app-services.mjs';
import {
  FUNCTION_NAME,
  PRODUCTION_FUNCTION_NAME,
  EXPECTED_LIVE_CODE_SHA256,
  EXPECTED_LIVE_REVISION_ID,
  PRODUCTION_CODE_SHA256,
  PRODUCTION_REVISION_ID,
  LIVE_APP_SERVICES_SHA256,
  PATCHED_APP_SERVICES_SHA256,
  LIVE_PRESERVE_SHA256,
  STAGING_ONLY_HOMEOWNER_ROUTES,
} from './constants.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const OUT = process.argv[2] || '/opt/cursor/artifacts/staging-macomp-dispatch-preflight.json';
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const awsJson = (args) => {
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], { encoding: 'utf8' });
  return out.trim() ? JSON.parse(out) : {};
};

const oidcToken = () => new Promise((resolve, reject) => {
  const req = http.request({
    socketPath: '/run/cursor/api.sock',
    path: '/v1/tokens/oidc',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  }, (res) => {
    const chunks = [];
    res.on('data', (d) => chunks.push(d));
    res.on('end', () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed.token || parsed.oidcToken || parsed);
      } catch (e) { reject(e); }
    });
  });
  req.on('error', reject);
  req.write(JSON.stringify({ aud: 'sts.amazonaws.com' }));
  req.end();
});

async function assumeRole() {
  const role = process.env.CURSOR_AWS_ASSUME_IAM_ROLE_ARN;
  if (!role) throw new Error('CURSOR_AWS_ASSUME_IAM_ROLE_ARN missing');
  const token = await oidcToken();
  const out = execFileSync(AWS, [
    'sts', 'assume-role-with-web-identity',
    '--role-arn', role,
    '--role-session-name', 'checksops-mac-dispatch',
    '--web-identity-token', String(token),
    '--duration-seconds', '3600',
    '--output', 'json',
  ], { encoding: 'utf8' });
  const creds = JSON.parse(out).Credentials;
  process.env.AWS_ACCESS_KEY_ID = creds.AccessKeyId;
  process.env.AWS_SECRET_ACCESS_KEY = creds.SecretAccessKey;
  process.env.AWS_SESSION_TOKEN = creds.SessionToken;
  process.env.AWS_REGION = REGION;
  process.env.AWS_DEFAULT_REGION = REGION;
  fs.writeFileSync('/tmp/macomp-aws.env', [
    `export AWS_ACCESS_KEY_ID=${creds.AccessKeyId}`,
    `export AWS_SECRET_ACCESS_KEY=${creds.SecretAccessKey}`,
    `export AWS_SESSION_TOKEN=${creds.SessionToken}`,
    `export AWS_REGION=${REGION}`,
    `export AWS_DEFAULT_REGION=${REGION}`,
    `export AWS_EXPIRY=${creds.Expiration}`,
    '',
  ].join('\n'));
  return { expiry: creds.Expiration, identity: awsJson(['sts', 'get-caller-identity']) };
}

function invokeJson(name, payload) {
  const outFile = path.join(os.tmpdir(), `invoke-${name}-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
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

async function main() {
  const assumed = await assumeRole();
  const cfg = awsJson(['lambda', 'get-function-configuration', '--function-name', FUNCTION_NAME]);
  const fn = awsJson(['lambda', 'get-function', '--function-name', FUNCTION_NAME]);
  const prod = awsJson(['lambda', 'get-function-configuration', '--function-name', PRODUCTION_FUNCTION_NAME]);
  const zipPath = path.join(os.tmpdir(), `staging-api-dispatch-preflight-${Date.now()}.zip`);
  execFileSync('curl', ['-fsSL', fn.Code.Location, '-o', zipPath]);
  const zip = fs.readFileSync(zipPath);
  const members = hashZipMembers(zip);
  const liveDispatcher = execFileSync('unzip', ['-p', zipPath, 'app-services.mjs']);
  const liveText = liveDispatcher.toString('utf8');
  const fixtureLive = fs.readFileSync(path.join(ROOT, 'aws/isolated/mortgage-agent-compensation/lambda-staging-dispatch/fixtures/app-services.live.mjs'));
  const fixturePatched = fs.readFileSync(path.join(ROOT, 'aws/isolated/mortgage-agent-compensation/lambda-staging-dispatch/fixtures/app-services.patched.mjs'), 'utf8');
  const patched = patchLiveAppServices(liveText);
  const delta = addedLines(liveText, patched);

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

  const preserve = {};
  for (const [name, expected] of Object.entries(LIVE_PRESERVE_SHA256)) {
    preserve[name] = { expected, live: members[name] || null, match: members[name] === expected };
  }

  const drift = [];
  if (cfg.CodeSha256 !== EXPECTED_LIVE_CODE_SHA256) drift.push({ item: 'lambda_sha', live: cfg.CodeSha256, expected: EXPECTED_LIVE_CODE_SHA256 });
  if (cfg.RevisionId !== EXPECTED_LIVE_REVISION_ID) drift.push({ item: 'lambda_rev', live: cfg.RevisionId, expected: EXPECTED_LIVE_REVISION_ID });
  if (prod.CodeSha256 !== PRODUCTION_CODE_SHA256) drift.push({ item: 'prod_sha', live: prod.CodeSha256, expected: PRODUCTION_CODE_SHA256 });
  if (prod.RevisionId !== PRODUCTION_REVISION_ID) drift.push({ item: 'prod_rev', live: prod.RevisionId, expected: PRODUCTION_REVISION_ID });
  if (members['app-services.mjs'] !== LIVE_APP_SERVICES_SHA256) drift.push({ item: 'live_app_services', live: members['app-services.mjs'] });
  if (sha256(fixtureLive) !== LIVE_APP_SERVICES_SHA256) drift.push({ item: 'fixture_live' });
  if (sha256(Buffer.from(patched)) !== PATCHED_APP_SERVICES_SHA256) drift.push({ item: 'patched_hash', live: sha256(Buffer.from(patched)) });
  if (patched !== fixturePatched) drift.push({ item: 'patched_fixture_mismatch' });
  if (delta.removed.length) drift.push({ item: 'delta_removed', live: delta.removed });
  if (!members['mortgage-agent-compensation.mjs']) drift.push({ item: 'compensation_member_missing' });
  for (const [name, row] of Object.entries(preserve)) {
    if (!row.match) drift.push({ item: `preserve_${name}`, live: row.live });
  }
  const liveClassA = extractClassA(liveText);
  for (const route of STAGING_ONLY_HOMEOWNER_ROUTES) {
    if (!liveClassA.includes(route)) drift.push({ item: `missing_live_route_${route}` });
  }
  if (liveClassA.includes('mortgage-agent-compensation')) drift.push({ item: 'already_registered' });
  if (api.compensation_roster_unauth.json?.error !== 'provider_disabled') {
    drift.push({ item: 'pre_compensation_not_provider_disabled', live: api.compensation_roster_unauth });
  }
  if (api.hire_unauth.json?.error !== 'missing_cognito_token') {
    drift.push({ item: 'hire_not_class_a', live: api.hire_unauth });
  }
  if (api.unknown_unauth.json?.error !== 'provider_disabled') {
    drift.push({ item: 'unknown_not_provider_disabled', live: api.unknown_unauth });
  }
  if (api.prod_compensation_unauth.json?.error !== 'missing_cognito_token') {
    drift.push({ item: 'prod_compensation_drift', live: api.prod_compensation_unauth });
  }
  for (const name of ['endorse_link_unauth', 'document_sign_link_unauth', 'signature_request_unauth', 'branding_unauth']) {
    if (api[name].json?.error === 'provider_disabled') {
      drift.push({ item: `${name}_fell_through_provider_disabled`, live: api[name] });
    }
  }

  const report = {
    ok: drift.length === 0,
    inspected_at: new Date().toISOString(),
    assumed,
    lambda: {
      FunctionName: cfg.FunctionName,
      CodeSha256: cfg.CodeSha256,
      RevisionId: cfg.RevisionId,
      LastModified: cfg.LastModified,
      Runtime: cfg.Runtime,
      Handler: cfg.Handler,
      MemorySize: cfg.MemorySize,
      Timeout: cfg.Timeout,
      Role: cfg.Role,
    },
    production: {
      FunctionName: prod.FunctionName,
      CodeSha256: prod.CodeSha256,
      RevisionId: prod.RevisionId,
      LastModified: prod.LastModified,
    },
    zip_path: zipPath,
    member_count: Object.keys(members).length,
    live_members: members,
    live_owned: {
      'app-services.mjs': members['app-services.mjs'] || null,
      ...Object.fromEntries(Object.keys(LIVE_PRESERVE_SHA256).map((name) => [name, members[name] || null])),
    },
    preserve,
    live_class_a: liveClassA,
    patched_class_a: extractClassA(patched),
    delta,
    patched_sha256: sha256(Buffer.from(patched)),
    api,
    drift,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    lambda: report.lambda,
    production: report.production,
    member_count: report.member_count,
    delta: report.delta,
    patched_sha256: report.patched_sha256,
    api: Object.fromEntries(Object.entries(api).map(([k, v]) => [k, { statusCode: v.statusCode, error: v.json?.error || null }])),
    drift,
    out: OUT,
  }, null, 2)}\n`);
  if (drift.length) process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 2;
});
