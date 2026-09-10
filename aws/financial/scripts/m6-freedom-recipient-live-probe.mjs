#!/usr/bin/env node
/**
 * M6 GET-only Freedom recipient live probe.
 *
 * Surgical Lambda overlay (UpdateFunctionCode only; Environment blob is NEVER sent):
 *   moov-read.mjs, moov-recipient-readiness.mjs, moov-config.mjs
 *
 * Does not merge/activate M5 write modules. Does not register webhooks.
 * Does not enable flags. Does not mutate Moov or RDS financial rows.
 *
 * Requires:
 *   CHECKSOPS_M6_OVERLAY=I_UNDERSTAND_GET_ONLY
 *   CHECKSOPS_M6_INVOKE=1
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const LAMBDA = 'checksops-production-prep-api';
const FREEDOM_TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const FREEDOM_SUB = 'a45884b8-d051-70b3-b19d-ca704964c6e8';

const runJson = (args) => JSON.parse(execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024,
}));

const eventFor = (body) => ({
  rawPath: '/prep/functions/v1/moov-readiness',
  headers: { authorization: 'Bearer test-id-token', 'content-type': 'application/json' },
  body: JSON.stringify(body),
  requestContext: {
    stage: 'prep',
    http: { method: 'POST', path: '/prep/functions/v1/moov-readiness' },
    authorizer: {
      jwt: { claims: { sub: FREEDOM_SUB, email: 'owner@freedomadj.com', token_use: 'id' } },
    },
  },
});

const invoke = (body) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'm6-invoke-'));
  const payloadPath = path.join(dir, 'payload.json');
  const outPath = path.join(dir, 'out.json');
  writeFileSync(payloadPath, JSON.stringify(eventFor(body)));
  execFileSync(AWS, [
    '--region', REGION, 'lambda', 'invoke',
    '--function-name', LAMBDA,
    '--cli-binary-format', 'raw-in-base64-out',
    '--payload', `fileb://${payloadPath}`,
    outPath,
  ], { stdio: 'ignore' });
  const raw = JSON.parse(readFileSync(outPath, 'utf8'));
  const parsed = typeof raw.body === 'string' ? JSON.parse(raw.body) : raw;
  return { http: raw.statusCode, body: parsed };
};

if (process.argv.includes('--rds-only')) {
  const rds = invoke({ tenant_id: FREEDOM_TENANT });
  writeFileSync('/opt/cursor/artifacts/moov_m6_rds_only.json', `${JSON.stringify({
    http: rds.http,
    mutated: rds.body?.mutated === true,
    liveProviderCalled: rds.body?.liveProviderCalled === true,
    local_recipients: rds.body?.local_recipients || null,
    inventory_recipients: rds.body?.inventory?.recipients || null,
    error: rds.body?.error || null,
  }, null, 2)}\n`);
  console.log(JSON.stringify({ ok: rds.http === 200, http: rds.http, error: rds.body?.error || null }, null, 2));
  process.exit(rds.http === 200 ? 0 : 2);
}

if (process.env.CHECKSOPS_M6_OVERLAY !== 'I_UNDERSTAND_GET_ONLY' || process.env.CHECKSOPS_M6_INVOKE !== '1') {
  console.error(JSON.stringify({ error: 'refusing_m6_overlay', hint: 'set CHECKSOPS_M6_OVERLAY and CHECKSOPS_M6_INVOKE' }));
  process.exit(2);
}

const before = runJson(['lambda', 'get-function-configuration', '--function-name', LAMBDA]);
const work = mkdtempSync(path.join(tmpdir(), 'm6-overlay-'));
const zipPath = path.join(work, 'function.zip');
const url = runJson(['lambda', 'get-function', '--function-name', LAMBDA]).Code.Location;
execFileSync('curl', ['-sS', '-o', zipPath, url], { stdio: 'ignore' });
execFileSync('unzip', ['-q', zipPath, '-d', path.join(work, 'src')]);
const prodDir = path.join(work, 'src', 'providers', 'production');
copyFileSync(
  path.join(ROOT, 'aws/functions/api/providers/production/moov-read.mjs'),
  path.join(prodDir, 'moov-read.mjs'),
);
copyFileSync(
  path.join(ROOT, 'aws/functions/api/providers/production/moov-recipient-readiness.mjs'),
  path.join(prodDir, 'moov-recipient-readiness.mjs'),
);
copyFileSync(
  path.join(ROOT, 'aws/functions/api/providers/production/moov-config.mjs'),
  path.join(prodDir, 'moov-config.mjs'),
);
const newZip = path.join(work, 'overlay.zip');
execFileSync('zip', ['-qr', newZip, '.'], { cwd: path.join(work, 'src') });
runJson(['lambda', 'update-function-code', '--function-name', LAMBDA, '--zip-file', `fileb://${newZip}`]);
for (let i = 0; i < 20; i += 1) {
  const cfg = runJson(['lambda', 'get-function-configuration', '--function-name', LAMBDA]);
  if (cfg.LastUpdateStatus === 'Successful' && cfg.State === 'Active') break;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
}
const after = runJson(['lambda', 'get-function-configuration', '--function-name', LAMBDA]);
const live = invoke({ tenant_id: FREEDOM_TENANT, recipient_live_gets: true });
const money = {
  create: invoke({ tenant_id: FREEDOM_TENANT, create_transfer: true }),
};
const out = {
  phase: 'M6',
  overlay: {
    before_sha: before.CodeSha256,
    after_sha: after.CodeSha256,
    env_blob_sent: false,
    files: ['moov-read.mjs', 'moov-recipient-readiness.mjs', 'moov-config.mjs'],
  },
  http: live.http,
  mutated: live.body?.mutated === true,
  productionExecution: live.body?.productionExecution === true,
  recipient_live_gets: live.body?.recipient_live_gets === true,
  sandbox_recipient_used: live.body?.sandbox_recipient_used === true,
  c1c_used: live.body?.c1c_used === true,
  local_recipients: live.body?.local_recipients || null,
  live_recipients: live.body?.live_recipients || null,
  error: live.body?.error || null,
  money_create_error: money.create.body?.error || money.create.body,
};
writeFileSync('/opt/cursor/artifacts/moov_m6_live_probe.json', `${JSON.stringify(out, null, 2)}\n`);
writeFileSync(path.join(ROOT, 'aws/financial/results/moov_m6_live_probe.json'), `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify({
  ok: live.http === 200,
  http: live.http,
  overlay_sha: after.CodeSha256,
  live_recipient_count: (live.body?.live_recipients || []).length,
  mutated: out.mutated,
}, null, 2));
