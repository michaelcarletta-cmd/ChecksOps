#!/usr/bin/env node
/**
 * READ-ONLY production Freedom WalletOps + $1 transfer inspect.
 * Never creates/updates/deletes a sweep, bank, payment method, or transfer.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';

const AWS = process.env.AWS_CLI || '/usr/local/bin/aws';
const REGION = 'us-east-1';
const OUT = '/opt/cursor/artifacts/walletops-w2';
const PROD_SECRET = 'arn:aws:secretsmanager:us-east-1:806168576068:secret:checksops/production/provider-At4ZFR';
const FREEDOM_ACCOUNT = '60922058-7eca-4889-81dd-5720d7b9de96';
const FREEDOM_WALLET = '3e6286ca-a19c-45f6-aad9-f73dac5f0358';
const FREEDOM_SWEEP = '2d2c900d-6efb-43a2-ba90-2fd77e22afdd';
const VERIFY_TRANSFER = '367c5353-ed20-430b-b767-c3e5d47f28ad';
const PLATFORM_ACCOUNT = '41cb5d67-4911-4bef-aad5-d8ee9c582208';
const MOOV_VERSION = 'v2024.01.00';

const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' });
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
      } catch (error) { reject(error); }
    });
  });
  req.on('error', reject);
  req.write(JSON.stringify({ aud: 'sts.amazonaws.com' }));
  req.end();
});

const assumeRole = async () => {
  const creds = JSON.parse(run(AWS, [
    'sts', 'assume-role-with-web-identity',
    '--role-arn', process.env.CURSOR_AWS_ASSUME_IAM_ROLE_ARN,
    '--role-session-name', 'walletops-w2-readonly',
    '--web-identity-token', String(await oidcToken()),
    '--duration-seconds', '3600',
    '--output', 'json',
  ])).Credentials;
  process.env.AWS_ACCESS_KEY_ID = creds.AccessKeyId;
  process.env.AWS_SECRET_ACCESS_KEY = creds.SecretAccessKey;
  process.env.AWS_SESSION_TOKEN = creds.SessionToken;
  process.env.AWS_REGION = REGION;
};

const moovToken = async ({ key, secret, origin, scope }) => {
  const basic = Buffer.from(`${key}:${secret}`).toString('base64');
  const res = await fetch('https://api.moov.io/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: origin,
      'x-moov-version': MOOV_VERSION,
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope }).toString(),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, token: body.access_token || null, error: body.error || body.errorCode || null };
};

const moovGet = async (creds, path, scope) => {
  const auth = await moovToken({ ...creds, scope });
  if (!auth.ok) return { ok: false, status: auth.status, error: auth.error, path };
  const res = await fetch(`https://api.moov.io${path}`, {
    headers: {
      Authorization: `Bearer ${auth.token}`,
      Accept: 'application/json',
      Origin: creds.origin,
      'x-moov-version': MOOV_VERSION,
    },
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body, path };
};

const main = async () => {
  await mkdir(OUT, { recursive: true });
  await assumeRole();
  const secret = JSON.parse(awsJson(['secretsmanager', 'get-secret-value', '--secret-id', PROD_SECRET]).SecretString);
  const creds = {
    key: secret.MOOV_PUBLIC_KEY,
    secret: secret.MOOV_SECRET_KEY,
    origin: secret.MOOV_ALLOWED_ORIGIN || 'https://checksops.com',
  };
  const sweep = await moovGet(creds, `/accounts/${FREEDOM_ACCOUNT}/sweep-configs/${FREEDOM_SWEEP}`, `/accounts/${FREEDOM_ACCOUNT}/wallets.read`);
  const wallet = await moovGet(creds, `/accounts/${FREEDOM_ACCOUNT}/wallets/${FREEDOM_WALLET}`, `/accounts/${FREEDOM_ACCOUNT}/wallets.read`);
  const transfer = await moovGet(
    creds,
    `/accounts/${PLATFORM_ACCOUNT}/transfers/${VERIFY_TRANSFER}`,
    `/accounts/${PLATFORM_ACCOUNT}/transfers.read`,
  );
  const page = await fetch('https://checksops.com/freedom/wallet-ops').then(async (res) => {
    const html = await res.text();
    return {
      status: res.status,
      js: (html.match(/\/assets\/(index-[A-Za-z0-9._-]+\.js)/) || [])[1] || null,
      css: (html.match(/\/assets\/(index-[A-Za-z0-9._-]+\.css)/) || [])[1] || null,
      hasAwsStagingText: /AWS staging — Cognito/.test(html),
    };
  });
  const login = await fetch('https://checksops.com/login').then(async (res) => {
    const html = await res.text();
    return { status: res.status, hasAwsStagingSuffix: /AWS staging\./.test(html) };
  });
  const staging = await fetch('https://staging.checksops.com/').then(async (res) => ({
    status: res.status,
    js: ((await res.text()).match(/\/assets\/(index-[A-Za-z0-9._-]+\.js)/) || [])[1] || null,
  }));
  const cfg = sweep.body || {};
  const report = {
    generatedAt: new Date().toISOString(),
    mutated: false,
    sweep: {
      ok: sweep.ok,
      status: sweep.status,
      id: cfg.sweepConfigID || null,
      unchanged: cfg.sweepConfigID === FREEDOM_SWEEP,
      sweepStatus: cfg.status || null,
      walletID: cfg.walletID || null,
      push: cfg.pushPaymentMethod?.paymentMethodID || cfg.pushPaymentMethodID || null,
      pull: cfg.pullPaymentMethod?.paymentMethodID || cfg.pullPaymentMethodID || null,
      minimumBalance: cfg.minimumBalance ?? null,
    },
    wallet: {
      ok: wallet.ok,
      available: wallet.body?.availableBalance || null,
      pending: wallet.body?.pendingBalance || null,
    },
    verificationTransfer: {
      ok: transfer.ok,
      status: transfer.status,
      providerStatus: transfer.body?.status || null,
      amount: transfer.body?.amount || null,
      destination: transfer.body?.destination || null,
    },
    productionPage: page,
    productionLogin: login,
    stagingHome: staging,
  };
  await writeFile(`${OUT}/readonly-inspect.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
