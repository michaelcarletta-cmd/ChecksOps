#!/usr/bin/env node
/**
 * M6.1 GET-only Freedom recipient live probe.
 *
 * Surgical Lambda overlay (UpdateFunctionCode only; Environment blob is NEVER sent):
 *   moov-read.mjs, moov-recipient-readiness.mjs, moov-config.mjs
 *
 * Restores the original Lambda zip after the probe and verifies CodeSha256.
 *
 * Requires:
 *   CHECKSOPS_M6_OVERLAY=I_UNDERSTAND_GET_ONLY
 *   CHECKSOPS_M6_INVOKE=1
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const LAMBDA = 'checksops-production-prep-api';
const FREEDOM_SUB = 'a45884b8-d051-70b3-b19d-ca704964c6e8';
const C1C_TENANT = '4f172140-f57a-4744-8050-95f4f07b13b4';

const FLAG_NAMES = [
  'AWS_MOOV_ENABLED',
  'AWS_PROVIDER_EXECUTION_ENABLED',
  'AWS_FINANCIAL_PERMISSIONS_ACTIVATED',
  'AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED',
  'AWS_PROVIDER_LIVE_READS_ENABLED',
  'AWS_PROVIDER_WEBHOOK_DRY_RUN',
  'AWS_MOOV_ONBOARDING_WRITES_ENABLED',
  'AWS_MOOV_WEBHOOK_APPLY_ENABLED',
  'AWS_LOVABLE_MONEY_NEUTRALIZED',
];

const runJson = (args) => JSON.parse(execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024,
}));

const waitActive = () => {
  for (let i = 0; i < 30; i += 1) {
    const cfg = runJson(['lambda', 'get-function-configuration', '--function-name', LAMBDA]);
    if (cfg.LastUpdateStatus === 'Successful' && cfg.State === 'Active') return cfg;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
  }
  return runJson(['lambda', 'get-function-configuration', '--function-name', LAMBDA]);
};

const publicFlags = (cfg) => {
  const env = cfg?.Environment?.Variables || {};
  const out = {};
  for (const name of FLAG_NAMES) out[name] = env[name] === undefined ? null : env[name];
  return out;
};

const eventFor = (rawPath, body) => ({
  rawPath,
  headers: { authorization: 'Bearer test-id-token', 'content-type': 'application/json' },
  body: body == null ? undefined : JSON.stringify(body),
  requestContext: {
    stage: 'prep',
    http: { method: 'POST', path: rawPath },
    authorizer: {
      jwt: { claims: { sub: FREEDOM_SUB, email: 'owner@freedomadj.com', token_use: 'id' } },
    },
  },
});

const invoke = (rawPath, body) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'm61-invoke-'));
  const payloadPath = path.join(dir, 'payload.json');
  const outPath = path.join(dir, 'out.json');
  writeFileSync(payloadPath, JSON.stringify(eventFor(rawPath, body)));
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

if (process.env.CHECKSOPS_M6_OVERLAY !== 'I_UNDERSTAND_GET_ONLY' || process.env.CHECKSOPS_M6_INVOKE !== '1') {
  console.error(JSON.stringify({ error: 'refusing_m6_overlay', hint: 'set CHECKSOPS_M6_OVERLAY and CHECKSOPS_M6_INVOKE' }));
  process.exit(2);
}

const before = runJson(['lambda', 'get-function-configuration', '--function-name', LAMBDA]);
const work = mkdtempSync(path.join(tmpdir(), 'm61-overlay-'));
const originalZip = path.join(work, 'original.zip');
const url = runJson(['lambda', 'get-function', '--function-name', LAMBDA]).Code.Location;
execFileSync('curl', ['-sS', '-L', '-o', originalZip, url]);
execFileSync('unzip', ['-q', originalZip, '-d', path.join(work, 'src')]);
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
const overlayZip = path.join(work, 'overlay.zip');
execFileSync('zip', ['-qr', overlayZip, '.'], { cwd: path.join(work, 'src') });
runJson(['lambda', 'update-function-code', '--function-name', LAMBDA, '--zip-file', `fileb://${overlayZip}`]);
const overlaid = waitActive();

const readiness = invoke('/prep/functions/v1/moov-readiness', { recipient_live_gets: true });
const productionIds = (readiness.body?.local_recipients || [])
  .filter((row) => String(row.environment || '').toLowerCase() === 'production' && row.recipient_id)
  .map((row) => row.recipient_id);

let liveRecipients = Array.isArray(readiness.body?.live_recipients) ? readiness.body.live_recipients : [];
const perRecipient = [];
if (!liveRecipients.length && productionIds.length) {
  for (const recipientId of productionIds) {
    const one = invoke('/prep/functions/v1/moov-readiness', {
      recipient_live_gets: true,
      recipient_id: recipientId,
    });
    perRecipient.push({ recipient_id: recipientId, http: one.http, error: one.body?.error || null });
    if (Array.isArray(one.body?.live_recipients)) liveRecipients.push(...one.body.live_recipients);
  }
}

const spoof = invoke('/prep/functions/v1/moov-readiness', {
  recipient_live_gets: true,
  moov_account_id: 'browser-supplied',
  platform_account_id: 'browser-platform',
});
const c1c = invoke('/prep/functions/v1/moov-readiness', {
  recipient_live_gets: true,
  tenant_id: C1C_TENANT,
});
const moneyCreate = invoke('/prep/functions/v1/moov-transfer-create', { amount_cents: 1 });
const moneyDisburse = invoke('/prep/functions/v1/moov-disburse', { amount_cents: 1 });

runJson(['lambda', 'update-function-code', '--function-name', LAMBDA, '--zip-file', `fileb://${originalZip}`]);
const restored = waitActive();

const flagsUnchanged = JSON.stringify(publicFlags(before)) === JSON.stringify(publicFlags(restored));
const shaRestored = restored.CodeSha256 === before.CodeSha256;

const out = {
  phase: 'M6.1',
  identity: {
    account: '806168576068',
    role_session: 'ChecksOpsCursorCloudStaging/checksops-m61-live-get',
    region: REGION,
  },
  overlay: {
    before_sha: before.CodeSha256,
    before_revision: before.RevisionId,
    overlay_sha: overlaid.CodeSha256,
    restored_sha: restored.CodeSha256,
    restored_revision: restored.RevisionId,
    sha_restored: shaRestored,
    env_blob_sent: false,
    flags_before: publicFlags(before),
    flags_after: publicFlags(restored),
    flags_unchanged: flagsUnchanged,
    files: ['moov-read.mjs', 'moov-recipient-readiness.mjs', 'moov-config.mjs'],
  },
  readiness_http: readiness.http,
  mutated: readiness.body?.mutated === true || liveRecipients.some((row) => row?.mutated === true),
  productionExecution: readiness.body?.productionExecution === true,
  recipient_live_gets: readiness.body?.recipient_live_gets === true,
  sandbox_recipient_used: readiness.body?.sandbox_recipient_used === true,
  c1c_used: readiness.body?.c1c_used === true,
  tenant_id_server_derived: Boolean(readiness.body?.tenant_id),
  local_recipients: readiness.body?.local_recipients || null,
  live_recipients: liveRecipients,
  per_recipient_fallback: perRecipient,
  error: readiness.body?.error || null,
  spoof: { http: spoof.http, error: spoof.body?.error || null, liveProviderCalled: spoof.body?.liveProviderCalled === true },
  c1c: { http: c1c.http, error: c1c.body?.error || null, liveProviderCalled: c1c.body?.liveProviderCalled === true },
  money: {
    create: { http: moneyCreate.http, error: moneyCreate.body?.error || null, liveProviderCalled: moneyCreate.body?.liveProviderCalled === true },
    disburse: { http: moneyDisburse.http, error: moneyDisburse.body?.error || null, liveProviderCalled: moneyDisburse.body?.liveProviderCalled === true },
  },
};
mkdirSync('/opt/cursor/artifacts', { recursive: true });
writeFileSync('/opt/cursor/artifacts/moov_m6_1_live_probe.json', `${JSON.stringify(out, null, 2)}\n`);
writeFileSync(path.join(ROOT, 'aws/financial/results/moov_m6_1_live_probe.json'), `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify({
  ok: readiness.http === 200 && shaRestored && flagsUnchanged,
  readiness_http: readiness.http,
  overlay_sha: overlaid.CodeSha256,
  restored_sha: restored.CodeSha256,
  sha_restored: shaRestored,
  flags_unchanged: flagsUnchanged,
  live_recipient_count: liveRecipients.length,
  mutated: out.mutated,
  error: out.error,
}, null, 2));
