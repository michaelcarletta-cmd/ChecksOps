#!/usr/bin/env node
/**
 * M7.9 runner: inspect AWS, apply SQL 77 via VPC oneshot, surgical Lambda overlay,
 * designated sandbox tenant switch, sandbox Moov objects, dark orchestrate.
 * Never arms AWS_MOOV_TRANSFER_POST_ENABLED. Never prints secret values.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const API_FN = 'checksops-production-prep-api';
const ONESHOT_FN = 'checksops-m79-sql77-b844';
const ONESHOT_ROLE = 'arn:aws:iam::806168576068:role/checksops-staging-rehearsal-oneshot';
const ONESHOT_DIR = path.join(ROOT, 'aws/providers/oneshot/m79-sandbox-tenant');
const API_SRC = path.join(ROOT, 'aws/functions/api');
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const SANDBOX_KEYS = [
  'MOOV_SANDBOX_PUBLIC_KEY',
  'MOOV_SANDBOX_SECRET_KEY',
  'MOOV_SANDBOX_PLATFORM_ACCOUNT_ID',
  'MOOV_SANDBOX_ALLOWED_ORIGIN',
  'MOOV_SANDBOX_WEBHOOK_SECRET',
  'MOOV_SANDBOX_API_VERSION',
];
const OVERLAY_FILES = [
  'provider-flags.mjs',
  'provider-secrets.mjs',
  'providers/catalog.mjs',
  'providers/webhooks.mjs',
  'providers/webhook-apply-production.mjs',
  'providers/webhook-apply.mjs',
  'providers/moov-lifecycle.mjs',
  'providers/moov-environment.mjs',
  'providers/moov-tenant-environment.mjs',
  'providers/production/moov-dispatch.mjs',
  'providers/production/moov-payout-orchestrate.mjs',
  'providers/production/moov-payout-orchestrator.mjs',
  'providers/production/moov-secrets.mjs',
  'providers/production/moov-sandbox-client.mjs',
];
const MUST_KEEP = [
  'auth-cognito.mjs',
  'index.mjs',
  'providers/production/moov-wallet-fund.mjs',
  'providers/production/moov-wallet-disburse.mjs',
  'providers/moov-wallet-fund.mjs',
  'providers/moov-wallet-disburse.mjs',
];

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  ...opts,
});
const awsJson = (args) => {
  const out = run(AWS, ['--region', REGION, '--output', 'json', ...args]);
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
      try { resolve(JSON.parse(Buffer.concat(chunks).toString()).token); }
      catch (error) { reject(error); }
    });
  });
  req.on('error', reject);
  req.write(JSON.stringify({ aud: 'sts.amazonaws.com' }));
  req.end();
});

const assumeRole = async () => {
  const role = process.env.CURSOR_AWS_ASSUME_IAM_ROLE_ARN;
  if (!role) throw new Error('CURSOR_AWS_ASSUME_IAM_ROLE_ARN missing');
  const token = await oidcToken();
  const creds = awsJson([
    'sts', 'assume-role-with-web-identity',
    '--role-arn', role,
    '--role-session-name', 'checksops-m79-sandbox',
    '--web-identity-token', String(token),
    '--duration-seconds', '3600',
  ]).Credentials;
  process.env.AWS_ACCESS_KEY_ID = creds.AccessKeyId;
  process.env.AWS_SECRET_ACCESS_KEY = creds.SecretAccessKey;
  process.env.AWS_SESSION_TOKEN = creds.SessionToken;
  process.env.AWS_REGION = REGION;
  process.env.AWS_DEFAULT_REGION = REGION;
  return awsJson(['sts', 'get-caller-identity']);
};

const present = (value) => typeof value === 'string' && value.trim().length > 0;
const configured = (obj, key) => present(obj?.[key]) ? 'CONFIGURED' : 'MISSING';

const inspectSecrets = (arn) => {
  const raw = awsJson(['secretsmanager', 'get-secret-value', '--secret-id', arn]);
  const parsed = JSON.parse(raw.SecretString || '{}');
  const names = Object.keys(parsed).sort();
  const sandbox = {};
  for (const key of SANDBOX_KEYS) sandbox[key] = configured(parsed, key);
  return {
    secretName: raw.Name,
    arnEndsWith: String(raw.ARN || '').slice(-40),
    keyCount: names.length,
    keyNames: names,
    sandbox,
    missingSandbox: SANDBOX_KEYS.filter((key) => sandbox[key] === 'MISSING'),
    hasProductionPublic: names.includes('MOOV_PUBLIC_KEY'),
    sandboxEqualsProductionPublic: present(parsed.MOOV_SANDBOX_PUBLIC_KEY)
      && present(parsed.MOOV_PUBLIC_KEY)
      && parsed.MOOV_SANDBOX_PUBLIC_KEY === parsed.MOOV_PUBLIC_KEY,
    sandboxEqualsProductionSecret: present(parsed.MOOV_SANDBOX_SECRET_KEY)
      && present(parsed.MOOV_SECRET_KEY)
      && parsed.MOOV_SANDBOX_SECRET_KEY === parsed.MOOV_SECRET_KEY,
  };
};

const lambdaFlags = () => {
  const cfg = awsJson(['lambda', 'get-function-configuration', '--function-name', API_FN]);
  const env = cfg.Environment?.Variables || {};
  return {
    lastModified: cfg.LastModified,
    codeSha256: cfg.CodeSha256,
    state: cfg.State,
    lastUpdateStatus: cfg.LastUpdateStatus,
    flags: {
      AWS_MOOV_TRANSFER_POST_ENABLED: env.AWS_MOOV_TRANSFER_POST_ENABLED || null,
      AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED: env.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED || null,
      AWS_MOOV_ENABLED: env.AWS_MOOV_ENABLED || null,
      AWS_PROVIDER_EXECUTION_ENABLED: env.AWS_PROVIDER_EXECUTION_ENABLED || null,
      AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: env.AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED || null,
      AWS_PROVIDER_WEBHOOK_DRY_RUN: env.AWS_PROVIDER_WEBHOOK_DRY_RUN || null,
      CHECKSOPS_ENV: env.CHECKSOPS_ENV || null,
    },
    envKeyCount: Object.keys(env).length,
    providerSecretsArnEndsWith: String(env.PROVIDER_SECRETS_ARN || '').slice(-40),
    webhookSecretArnEndsWith: String(env.MOOV_WEBHOOK_SECRET_ARN || '').slice(-40),
    vpc: {
      subnetIds: cfg.VpcConfig?.SubnetIds || [],
      securityGroupIds: cfg.VpcConfig?.SecurityGroupIds || [],
    },
    PROVIDER_SECRETS_ARN: env.PROVIDER_SECRETS_ARN,
    MOOV_WEBHOOK_SECRET_ARN: env.MOOV_WEBHOOK_SECRET_ARN,
  };
};

const packOneshot = () => {
  const staging = path.join(os.tmpdir(), 'checksops-m79-oneshot-pack');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  fs.copyFileSync(path.join(ONESHOT_DIR, 'index.mjs'), path.join(staging, 'index.mjs'));
  fs.copyFileSync(path.join(ONESHOT_DIR, 'package.json'), path.join(staging, 'package.json'));
  fs.copyFileSync(path.join(ROOT, 'aws/rls/oneshot/rds-global-bundle.pem'), path.join(staging, 'rds-global-bundle.pem'));
  fs.copyFileSync(path.join(ROOT, 'aws/providers/sql/77_moov_tenant_environment.sql'), path.join(staging, '77_moov_tenant_environment.sql'));
  fs.copyFileSync(path.join(ROOT, 'aws/providers/sql/78_moov_recon_parity.sql'), path.join(staging, '78_moov_recon_parity.sql'));
  run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: staging, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const zipPath = path.join(os.tmpdir(), 'checksops-m79-oneshot.zip');
  fs.rmSync(zipPath, { force: true });
  run('zip', ['-qr', zipPath, '.'], { cwd: staging });
  return zipPath;
};

const waitFn = (name) => {
  try { run(AWS, ['--region', REGION, 'lambda', 'wait', 'function-updated', '--function-name', name]); } catch { /* ok */ }
  try { run(AWS, ['--region', REGION, 'lambda', 'wait', 'function-active', '--function-name', name]); } catch { /* ok */ }
};

const ensureOneshot = (zipPath, adminArn, vpc) => {
  const env = {
    Variables: {
      ADMIN_SECRET_ARN: adminArn,
      RDS_HOST: 'checksops-staging.cyr0q4kcop3c.us-east-1.rds.amazonaws.com',
      DATABASE_NAME: 'checksops',
    },
  };
  const vpcConfig = `SubnetIds=${vpc.subnetIds.join(',')},SecurityGroupIds=${vpc.securityGroupIds.join(',')}`;
  try {
    awsJson(['lambda', 'get-function-configuration', '--function-name', ONESHOT_FN]);
    run(AWS, ['--region', REGION, 'lambda', 'update-function-code', '--function-name', ONESHOT_FN, '--zip-file', `fileb://${zipPath}`]);
    waitFn(ONESHOT_FN);
    awsJson(['lambda', 'update-function-configuration', '--function-name', ONESHOT_FN, '--timeout', '120', '--memory-size', '512', '--environment', JSON.stringify(env)]);
    waitFn(ONESHOT_FN);
  } catch {
    awsJson([
      'lambda', 'create-function',
      '--function-name', ONESHOT_FN,
      '--runtime', 'nodejs20.x',
      '--role', ONESHOT_ROLE,
      '--handler', 'index.handler',
      '--timeout', '120',
      '--memory-size', '512',
      '--zip-file', `fileb://${zipPath}`,
      '--environment', JSON.stringify(env),
      '--vpc-config', vpcConfig,
    ]);
    waitFn(ONESHOT_FN);
  }
};

const invokeOneshot = (payload) => {
  const outFile = path.join(os.tmpdir(), `m79-oneshot-${payload.step}-${Date.now()}.json`);
  run(AWS, [
    '--region', REGION, 'lambda', 'invoke',
    '--function-name', ONESHOT_FN,
    '--cli-binary-format', 'raw-in-base64-out',
    '--payload', JSON.stringify(payload),
    outFile,
  ]);
  const raw = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  if (raw.statusCode && raw.body) {
    try { return JSON.parse(raw.body); } catch { return raw; }
  }
  return raw;
};

const sha256File = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const namedExportsOf = (src) => {
  const names = new Set();
  for (const match of src.matchAll(/export\s+(?:async\s+)?(?:function|const|class|let|var)\s+([A-Za-z0-9_]+)/g)) {
    names.add(match[1]);
  }
  for (const match of src.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of match[1].split(',')) {
      const bits = part.trim();
      if (!bits) continue;
      const name = bits.includes(' as ') ? bits.split(/\s+as\s+/).pop().trim() : bits;
      if (name) names.add(name);
    }
  }
  return names;
};

const walkMjs = (dir) => {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkMjs(full));
    else if (entry.name.endsWith('.mjs')) out.push(full);
  }
  return out;
};

const assertOverlayExports = (unpacked) => {
  const overlayAbs = new Set(OVERLAY_FILES.map((rel) => path.join(unpacked, rel)));
  const exportCache = new Map();
  const missing = [];
  for (const file of walkMjs(unpacked)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const match of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"](\.[^'"]+)['"]/g)) {
      let resolved = path.resolve(path.dirname(file), match[2]);
      if (!resolved.endsWith('.mjs')) {
        if (fs.existsSync(`${resolved}.mjs`)) resolved = `${resolved}.mjs`;
        else continue;
      }
      if (!overlayAbs.has(resolved) || !fs.existsSync(resolved)) continue;
      if (!exportCache.has(resolved)) exportCache.set(resolved, namedExportsOf(fs.readFileSync(resolved, 'utf8')));
      const exported = exportCache.get(resolved);
      for (const part of match[1].split(',')) {
        const bits = part.trim();
        if (!bits) continue;
        const name = bits.includes(' as ') ? bits.split(/\s+as\s+/)[0].trim() : bits;
        if (name && !exported.has(name)) {
          missing.push({
            file: path.relative(unpacked, file),
            from: path.relative(unpacked, resolved),
            name,
          });
        }
      }
    }
  }
  if (missing.length) {
    throw new Error(`overlay missing exports: ${JSON.stringify(missing).slice(0, 1500)}`);
  }
  return { ok: true, overlayFilesChecked: OVERLAY_FILES.length };
};

const overlayApi = () => {
  const work = path.join(os.tmpdir(), 'checksops-m79-overlay');
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  const loc = awsJson(['lambda', 'get-function', '--function-name', API_FN]);
  const zipPath = path.join(work, 'live.zip');
  run('curl', ['-fsSL', loc.Code.Location, '-o', zipPath]);
  const unpacked = path.join(work, 'unpacked');
  fs.mkdirSync(unpacked, { recursive: true });
  run('unzip', ['-q', zipPath, '-d', unpacked]);
  const keepBefore = {};
  for (const rel of MUST_KEEP) {
    const full = path.join(unpacked, rel);
    if (fs.existsSync(full)) keepBefore[rel] = sha256File(full);
  }
  const copied = [];
  for (const rel of OVERLAY_FILES) {
    const src = path.join(API_SRC, rel);
    const dest = path.join(unpacked, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    copied.push({ rel, existed: fs.existsSync(path.join(unpacked, rel)) });
  }
  const keepAfter = {};
  for (const rel of MUST_KEEP) {
    const full = path.join(unpacked, rel);
    if (fs.existsSync(full)) keepAfter[rel] = sha256File(full);
    if (keepBefore[rel] && keepAfter[rel] !== keepBefore[rel]) {
      throw new Error(`overlay mutated protected file ${rel}`);
    }
  }
  const exportCompat = assertOverlayExports(unpacked);
  const outZip = path.join(work, 'overlay.zip');
  run('zip', ['-qr', outZip, '.'], { cwd: unpacked });
  const before = awsJson(['lambda', 'get-function-configuration', '--function-name', API_FN]);
  run(AWS, ['--region', REGION, 'lambda', 'update-function-code', '--function-name', API_FN, '--zip-file', `fileb://${outZip}`]);
  waitFn(API_FN);
  const after = awsJson(['lambda', 'get-function-configuration', '--function-name', API_FN]);
  return {
    beforeSha: before.CodeSha256,
    afterSha: after.CodeSha256,
    lastModified: after.LastModified,
    state: after.State,
    lastUpdateStatus: after.LastUpdateStatus,
    copied,
    protectedUnchanged: Object.keys(keepBefore).every((rel) => keepBefore[rel] === keepAfter[rel]),
    envUnchanged: JSON.stringify(before.Environment?.Variables) === JSON.stringify(after.Environment?.Variables),
    POST_FLAG: after.Environment?.Variables?.AWS_MOOV_TRANSFER_POST_ENABLED || null,
    SANDBOX_POST_FLAG: after.Environment?.Variables?.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED || null,
    exportCompat,
  };
};

const probe = async (pathName, method = 'GET', body = null) => {
  const started = Date.now();
  const res = await fetch(`https://checksops.com/prep${pathName}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 180) }; }
  return {
    path: pathName,
    status: res.status,
    ms: Date.now() - started,
    error: json?.error || null,
    service: json?.service || null,
    environment: json?.environment || null,
  };
};

const sandboxMoov = async (secrets, { method, path: apiPath, body, scopes }) => {
  const origin = secrets.MOOV_SANDBOX_ALLOWED_ORIGIN || 'https://checksops.com';
  const basic = Buffer.from(`${secrets.MOOV_SANDBOX_PUBLIC_KEY}:${secrets.MOOV_SANDBOX_SECRET_KEY}`).toString('base64');
  const tokenRes = await fetch('https://api.moov.io/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: origin,
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: scopes.join(' '),
    }),
  });
  const tokenJson = await tokenRes.json();
  if (!tokenRes.ok || !tokenJson.access_token) {
    const err = new Error(`moov_oauth_${tokenRes.status}`);
    err.status = tokenRes.status;
    throw err;
  }
  const res = await fetch(`https://api.moov.io${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${tokenJson.access_token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Origin: origin,
      'x-moov-version': secrets.MOOV_SANDBOX_API_VERSION || 'v2024.01.00',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, json };
};

const redactId = (id) => {
  if (!id) return null;
  const s = String(id);
  if (s.length <= 8) return `${s.slice(0, 2)}…`;
  return `${s.slice(0, 8)}…${s.slice(-4)}`;
};

const loadSandboxSecretObject = (arn) => {
  const raw = awsJson(['secretsmanager', 'get-secret-value', '--secret-id', arn]);
  return JSON.parse(raw.SecretString || '{}');
};

const main = async () => {
  const step = process.argv[2] || 'inspect';
  const identity = await assumeRole();
  const flags = lambdaFlags();
  const secrets = inspectSecrets(flags.PROVIDER_SECRETS_ARN);
  let webhookSandbox = { MOOV_SANDBOX_WEBHOOK_SECRET: 'MISSING' };
  if (flags.MOOV_WEBHOOK_SECRET_ARN) {
    const webhook = inspectSecrets(flags.MOOV_WEBHOOK_SECRET_ARN);
    webhookSandbox = { MOOV_SANDBOX_WEBHOOK_SECRET: webhook.sandbox.MOOV_SANDBOX_WEBHOOK_SECRET };
    if (webhook.sandbox.MOOV_SANDBOX_WEBHOOK_SECRET === 'CONFIGURED') {
      secrets.sandbox.MOOV_SANDBOX_WEBHOOK_SECRET = 'CONFIGURED';
      secrets.missingSandbox = secrets.missingSandbox.filter((key) => key !== 'MOOV_SANDBOX_WEBHOOK_SECRET');
    }
  }

  const report = {
    at: new Date().toISOString(),
    step,
    identity: { arn: identity.Arn, account: identity.Account },
    flags,
    secrets: {
      provider: {
        secretName: secrets.secretName,
        arnEndsWith: secrets.arnEndsWith,
        keyNames: secrets.keyNames,
        sandbox: secrets.sandbox,
        missingSandbox: secrets.missingSandbox,
        sandboxCopiedFromProduction: secrets.sandboxEqualsProductionPublic || secrets.sandboxEqualsProductionSecret,
      },
      webhookSandbox,
    },
    POST_ARMED: flags.flags.AWS_MOOV_TRANSFER_POST_ENABLED === 'true',
    SANDBOX_POST_ARMED: flags.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED === 'true',
  };

  if (step === 'overlay') {
    report.overlay = overlayApi();
    report.authProbe = await probe('/auth/login', 'POST', { email: 'nobody@example.com', password: 'invalid' });
    report.webhookUnsigned = await probe('/webhooks/moov', 'POST', { type: 'transfer.updated' });
    report.providersStatus = await probe('/providers/status', 'GET');
    fs.writeFileSync('/opt/cursor/artifacts/m79_overlay_fix.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify({
      ok: report.overlay?.lastUpdateStatus === 'Successful' && report.authProbe?.status !== 500,
      overlay: {
        beforeSha: report.overlay.beforeSha,
        afterSha: report.overlay.afterSha,
        envUnchanged: report.overlay.envUnchanged,
        protectedUnchanged: report.overlay.protectedUnchanged,
        POST_FLAG: report.overlay.POST_FLAG,
      },
      authProbe: report.authProbe,
      webhookUnsigned: report.webhookUnsigned,
      providersStatus: report.providersStatus,
    }, null, 2));
    return;
  }

  if (step === 'aws-inspect') {
    fs.writeFileSync('/opt/cursor/artifacts/m79_aws_inspect.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const zip = packOneshot();
  const secretsList = awsJson(['secretsmanager', 'list-secrets']);
  const adminSecret = (secretsList.SecretList || []).find((s) => /checksops_admin/i.test(s.Name || s.ARN || ''));
  if (!adminSecret) throw new Error('checksops_admin secret not listed');
  ensureOneshot(zip, adminSecret.ARN, flags.vpc);
  const inspect = invokeOneshot({ step: 'inspect' });
  report.inspect = inspect;
  fs.writeFileSync('/opt/cursor/artifacts/m79_inspect.json', JSON.stringify(report, null, 2));
  if (step === 'inspect') {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (step === 'verify') {
    const tenantId = inspect.designated?.id;
    report.switch = invokeOneshot({ step: 'switch', tenantId });
    report.verify = invokeOneshot({ step: 'verify', tenantId });
    try {
      const staging = inspectSecrets('checksops/staging/providers');
      report.stagingProviderSandbox = {
        secretName: staging.secretName,
        sandbox: staging.sandbox,
        missingSandbox: staging.missingSandbox,
        sandboxCopiedFromProduction: staging.sandboxEqualsProductionPublic || staging.sandboxEqualsProductionSecret,
        usedForProductionPrep: false,
      };
    } catch (error) {
      report.stagingProviderSandbox = { readable: false, error: String(error?.message || error).slice(0, 180) };
    }
    report.authProbe = await probe('/auth/login', 'POST', { email: 'nobody@example.com', password: 'invalid' });
    report.webhookUnsigned = await probe('/webhooks/moov', 'POST', { type: 'transfer.updated' });
    report.providersStatus = await probe('/providers/status', 'GET');
    report.stopped = report.secrets.provider.missingSandbox.length
      ? 'sandbox_credentials_missing_on_production_prep_secret'
      : null;
    fs.writeFileSync('/opt/cursor/artifacts/m79_verify.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify({
      ok: report.verify?.ok === true && report.authProbe?.status !== 500,
      designated: inspect.designated,
      switch: report.switch,
      verify: {
        ok: report.verify?.ok,
        tenant: report.verify?.tenant,
        freedomEnvironment: report.verify?.freedomEnvironment,
        audit: report.verify?.audit,
        sandbox: report.verify?.sandbox && {
          account: Boolean(report.verify.sandbox.account),
          wallet: Boolean(report.verify.sandbox.wallet),
          banks: report.verify.sandbox.banks?.length || 0,
          recipients: report.verify.sandbox.recipients?.length || 0,
          productionIdHits: report.verify.sandbox.productionIdHits,
        },
        productionIgnored: report.verify?.productionIgnored,
      },
      productionPrepSandbox: report.secrets.provider.sandbox,
      missingSandbox: report.secrets.provider.missingSandbox,
      stagingProviderSandbox: report.stagingProviderSandbox,
      authProbe: report.authProbe,
      webhookUnsigned: report.webhookUnsigned,
      POST_ARMED: report.POST_ARMED,
      SANDBOX_POST_ARMED: report.SANDBOX_POST_ARMED,
      stopped: report.stopped,
    }, null, 2));
    return;
  }
  if (!inspect.sql77Safe) {
    report.stopped = 'sql77_preflight_failed';
    console.log(JSON.stringify(report, null, 2));
    process.exit(2);
  }
  if (step === 'apply' || step === 'all' || step === 'overlay') {
    if (step !== 'overlay') report.sql77 = invokeOneshot({ step: 'apply_sql77' });
    report.overlay = overlayApi();
    report.authProbe = await probe('/auth/login', 'POST', { email: 'nobody@example.com', password: 'invalid' });
    report.webhookUnsigned = await probe('/webhooks/moov', 'POST', { type: 'transfer.updated' });
    report.providersStatus = await probe('/providers/status', 'GET');
  }
  fs.writeFileSync('/opt/cursor/artifacts/m79_apply.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    ok: report.sql77?.ok === true && report.overlay?.lastUpdateStatus === 'Successful',
    freedom: inspect.freedom,
    designated: inspect.designated,
    sql77: report.sql77,
    overlay: report.overlay && {
      beforeSha: report.overlay.beforeSha,
      afterSha: report.overlay.afterSha,
      envUnchanged: report.overlay.envUnchanged,
      protectedUnchanged: report.overlay.protectedUnchanged,
      POST_FLAG: report.overlay.POST_FLAG,
    },
    authProbe: report.authProbe,
    webhookUnsigned: report.webhookUnsigned,
    secrets: report.secrets.provider.sandbox,
    missingSandbox: report.secrets.provider.missingSandbox,
    sandboxCopiedFromProduction: report.secrets.provider.sandboxCopiedFromProduction,
  }, null, 2));
};

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error?.message || error).slice(0, 500) }, null, 2));
  process.exit(1);
});
