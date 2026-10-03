#!/usr/bin/env node
/**
 * Read-only production Lambda overlay preflight. No writes.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashZipMembers } from '../../../../scripts/deployment-guard/lib/zip-members.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const LAMBDA = 'checksops-production-prep-api';
const SPA_BUCKET = 'checksops-production-frontend-806168576068';
const EXPECTED_SHA = 'S2CV0j3zWfYfyfSvmIq0axMhnSib1UntZZVqOvzxBbc=';
const EXPECTED_REV = '2f112f18-9055-4760-859d-62be8899b91f';
const EXPECTED_SPA = 'index-BgOCQCWm.js';
const EXPECTED_SPA_SHA = '3832fadc3d3fc77c8989a3426ee9e3f4b76a85d0c434f3782ec50cf7e43ba5df';
const OWNED_REPLACE = ['app-services.mjs', 'tenant-admin.mjs', 'identity.mjs'];
const OWNED_ADD = ['mortgage-agent-compensation.mjs'];
const PRESERVE = [
  'email-branding.mjs',
  'homeowner.mjs',
  'workflow-rpc.mjs',
  'write-check-workflow.mjs',
  'index.mjs',
];
const OUT = process.argv[2] || '/opt/cursor/artifacts/prod-lambda-preflight.json';

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
    '--role-session-name', 'checksops-mac-lambda',
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
  const outFile = path.join(os.tmpdir(), `invoke-${name}-${process.pid}.json`);
  const raw = execFileSync(AWS, [
    '--region', REGION, 'lambda', 'invoke',
    '--function-name', name,
    '--cli-binary-format', 'raw-in-base64-out',
    '--payload', JSON.stringify(payload),
    outFile,
  ], { encoding: 'utf8' });
  const meta = JSON.parse(raw);
  const body = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  return { meta, body };
}

async function main() {
  const assumed = await assumeRole();
  const cfg = awsJson(['lambda', 'get-function-configuration', '--function-name', LAMBDA]);
  const fn = awsJson(['lambda', 'get-function', '--function-name', LAMBDA]);
  const zipPath = path.join(os.tmpdir(), `prod-prep-api-live-${Date.now()}.zip`);
  execFileSync('curl', ['-fsSL', fn.Code.Location, '-o', zipPath]);
  const zip = fs.readFileSync(zipPath);
  const members = hashZipMembers(zip);
  const sourceHashes = {};
  for (const name of [...OWNED_REPLACE, ...OWNED_ADD]) {
    const p = path.join(ROOT, 'aws/functions/api', name);
    sourceHashes[name] = sha256(fs.readFileSync(p));
  }
  const liveOwned = {};
  for (const name of [...OWNED_REPLACE, ...OWNED_ADD, ...PRESERVE]) {
    liveOwned[name] = members[name] || null;
  }
  const spa = awsJson(['s3api', 'get-object', '--bucket', SPA_BUCKET, '--key', 'index.html', '/tmp/prod-index.html']);
  const indexHtml = fs.readFileSync('/tmp/prod-index.html', 'utf8');
  const spaEntry = (indexHtml.match(/\/assets\/(index-[A-Za-z0-9_-]+\.js)/) || [])[1] || null;
  const spaSha = sha256(fs.readFileSync('/tmp/prod-index.html'));

  const sql49 = invokeJson('checksops-prod-macomp49-oneshot-ad99', { action: 'inspect' });
  const sql48 = invokeJson('checksops-prod-macomp48-oneshot-ad99', { action: 'inspect' });
  const sql47 = invokeJson('checksops-prod-macomp47-oneshot-ad99', { action: 'inspect' });
  const sql39 = invokeJson('checksops-prod-mops-sql39-inspect-ad99', { action: 'inspect' });
  const accept = invokeJson('checksops-prod-mops-accept-inspect-ad99', {});
  const sql44 = invokeJson('checksops-prod-sql44-inspect-2d41', { action: 'inspect' });

  const snap = sql49.body?.details?.snapshot || sql49.body?.details || {};
  const drift = [];
  if (cfg.CodeSha256 !== EXPECTED_SHA) drift.push({ item: 'lambda_sha', live: cfg.CodeSha256, expected: EXPECTED_SHA });
  if (cfg.RevisionId !== EXPECTED_REV) drift.push({ item: 'lambda_rev', live: cfg.RevisionId, expected: EXPECTED_REV });
  if (spaEntry !== EXPECTED_SPA) drift.push({ item: 'spa_entry', live: spaEntry, expected: EXPECTED_SPA });
  if (spaSha !== EXPECTED_SPA_SHA) drift.push({ item: 'spa_sha', live: spaSha, expected: EXPECTED_SPA_SHA });
  if ((snap.sql47_catalog_fingerprint || snap.sql47_catalog) !== '3ef6b9b6ff9506e7c33d097cb5e01604cd7454f943114a6d3e85f0f5364ec7c0') {
    drift.push({ item: 'sql47', live: snap.sql47_catalog_fingerprint });
  }
  if ((snap.sql48_return_hash) !== '4a8edeb99404042b141b06a2566d3f7ccfd3a74a1a423ebfdb4df99a0b87ac76') {
    drift.push({ item: 'sql48', live: snap.sql48_return_hash });
  }
  if ((snap.sql49_adjust_hash) !== 'e05bce276d9c6969fd69055b853467a7ec3fd970800d47604bf1ca4b7e541fd9') {
    drift.push({ item: 'sql49', live: snap.sql49_adjust_hash });
  }
  if ((snap.sql39_hash || sql39.body?.details?.sql39_hash) !== '0d959621d34c99879dc9092cb925bfdb169273a21bea76c6a44242c2d64cd126') {
    drift.push({ item: 'sql39', live: snap.sql39_hash });
  }
  if (Number(snap.cbe_count) !== 131) drift.push({ item: 'cbe_count', live: snap.cbe_count });
  if ((snap.compensation_counts?.total ?? snap.compensation_count) !== 0) {
    drift.push({ item: 'compensation', live: snap.compensation_counts });
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
    zip_path: zipPath,
    member_count: Object.keys(members).length,
    live_members: members,
    live_owned: liveOwned,
    source_hashes: sourceHashes,
    replace_present: OWNED_REPLACE.every((n) => Boolean(members[n])),
    add_absent: OWNED_ADD.every((n) => !members[n]),
    preserve_present: PRESERVE.filter((n) => members[n]),
    spa: {
      VersionId: spa.VersionId,
      LastModified: spa.LastModified,
      entry: spaEntry,
      index_sha256: spaSha,
    },
    sql49: sql49.body,
    sql48: sql48.body,
    sql47: sql47.body,
    sql39: sql39.body,
    accept: accept.body,
    sql44: sql44.body,
    drift,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync('/tmp/macomp-lambda.env', `export AWS_ACCESS_KEY_ID=${process.env.AWS_ACCESS_KEY_ID}\nexport AWS_SECRET_ACCESS_KEY=${process.env.AWS_SECRET_ACCESS_KEY}\nexport AWS_SESSION_TOKEN=${process.env.AWS_SESSION_TOKEN}\nexport AWS_REGION=${REGION}\nexport AWS_DEFAULT_REGION=${REGION}\n`);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    lambda: report.lambda,
    member_count: report.member_count,
    replace_present: report.replace_present,
    add_absent: report.add_absent,
    spa: report.spa,
    drift,
    out: OUT,
  }, null, 2)}\n`);
  if (drift.length) process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 2;
});
