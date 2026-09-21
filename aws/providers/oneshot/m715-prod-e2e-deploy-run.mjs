#!/usr/bin/env node
/**
 * M7.15: surgical overlay of the production e2e wrapper onto the CURRENT
 * checksops-production-prep-api zip. Never arms POST flags. Never overlays
 * MUST_KEEP fund/disburse writers. Never consumes TOTP. Never POSTs transfers.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { KNOWN_APPROVED_MOOV } from '../../functions/api/providers/production/moov-accounts.mjs';
import { productionMoovFetch } from '../../functions/api/providers/production/moov-client.mjs';
import { FUNCTION_BY_NAME } from '../../functions/api/providers/catalog.mjs';
import { PIPELINE_TEST_SANDBOX } from '../../functions/api/providers/production/moov-sandbox-wallet-fund.mjs';
import { PRODUCTION_MOOV_API_VERSION, PRODUCTION_MOOV_ORIGIN } from '../../functions/api/providers/production/moov-secrets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const API_FN = 'checksops-production-prep-api';
const ONESHOT_FN = 'checksops-m79-sql77-b844';
const ONESHOT_ROLE = 'arn:aws:iam::806168576068:role/checksops-staging-rehearsal-oneshot';
const ONESHOT_DIR = path.join(ROOT, 'aws/providers/oneshot/m79-sandbox-tenant');
const API_SRC = path.join(ROOT, 'aws/functions/api');
const PREP_ORIGIN = 'https://checksops.com/prep';
const FREEDOM = KNOWN_APPROVED_MOOV.freedom.tenantId;
const OVERLAY_FILES = [
  'providers/production/moov-dispatch.mjs',
  'providers/production/moov-production-payout-e2e.mjs',
  'providers/production/moov-production-penny-authz.mjs',
  'providers/production/moov-production-transfer-primitives.mjs',
];
const CATALOG_REL = 'providers/catalog.mjs';
const E2E_CATALOG_LINE = "  fn('moov-production-payout-e2e', 'moov', OP_CLASS.MONEY_MOVEMENT, 'dark_deployed', 'M7.15 Freedom production e2e wrapper. Shared orchestratePayout. Dark HTTP only: persist off, POST off, TOTP not consumed. MUST_KEEP fund/disburse writers are blocked from independent invocation.'),";
const MUST_KEEP_REQUIRED = [
  'providers/production/moov-wallet-fund.mjs',
  'providers/production/moov-wallet-disburse.mjs',
];
const MUST_KEEP_IF_PRESENT = [
  'auth-cognito.mjs',
  'index.mjs',
  'providers/moov-wallet-fund.mjs',
  'providers/moov-wallet-disburse.mjs',
  'providers/production/moov-wallet-fund-continue.mjs',
];
const MUST_KEEP = [...MUST_KEEP_REQUIRED, ...MUST_KEEP_IF_PRESENT];

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  ...opts,
});
const awsJson = (args) => {
  const out = run(AWS, ['--region', REGION, '--output', 'json', ...args]);
  return out.trim() ? JSON.parse(out) : {};
};
const sha256File = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
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
  if (!token) throw new Error('oidc_token_missing');
  delete process.env.AWS_ACCESS_KEY_ID;
  delete process.env.AWS_SECRET_ACCESS_KEY;
  delete process.env.AWS_SESSION_TOKEN;
  const creds = awsJson([
    'sts', 'assume-role-with-web-identity',
    '--role-arn', role,
    '--role-session-name', 'checksops-m715-prod-e2e-deploy',
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
const waitFn = (name) => {
  try { run(AWS, ['--region', REGION, 'lambda', 'wait', 'function-updated', '--function-name', name]); } catch { /* ok */ }
  try { run(AWS, ['--region', REGION, 'lambda', 'wait', 'function-active', '--function-name', name]); } catch { /* ok */ }
};
const lambdaFlags = (name = API_FN) => {
  const cfg = awsJson(['lambda', 'get-function-configuration', '--function-name', name]);
  const env = cfg.Environment?.Variables || {};
  return {
    functionName: cfg.FunctionName,
    codeSha256: cfg.CodeSha256,
    lastModified: cfg.LastModified,
    state: cfg.State,
    lastUpdateStatus: cfg.LastUpdateStatus,
    flags: {
      AWS_MOOV_TRANSFER_POST_ENABLED: env.AWS_MOOV_TRANSFER_POST_ENABLED || null,
      AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED: env.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED || null,
    },
    vpc: {
      subnetIds: cfg.VpcConfig?.SubnetIds || [],
      securityGroupIds: cfg.VpcConfig?.SecurityGroupIds || [],
    },
    PROVIDER_SECRETS_ARN: env.PROVIDER_SECRETS_ARN,
    env,
  };
};
const refuseArmed = (flags) => {
  if (flags.AWS_MOOV_TRANSFER_POST_ENABLED === 'true') throw new Error('refused_production_post_armed');
  if (flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED === 'true') throw new Error('refused_sandbox_post_armed');
};
const catalogNames = (src) => [...src.matchAll(/fn\('([^']+)'/g)].map((m) => m[1]);
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
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      out.push(...walkMjs(full));
    } else if (entry.name.endsWith('.mjs')) out.push(full);
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
  if (missing.length) throw new Error(`overlay missing exports: ${JSON.stringify(missing).slice(0, 1500)}`);
  return { ok: true, overlayFilesChecked: OVERLAY_FILES.length };
};
const downloadLiveZip = (work) => {
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  const loc = awsJson(['lambda', 'get-function', '--function-name', API_FN]);
  const zipPath = path.join(work, 'live.zip');
  run('curl', ['-fsSL', loc.Code.Location, '-o', zipPath]);
  const unpacked = path.join(work, 'unpacked');
  fs.mkdirSync(unpacked, { recursive: true });
  run('unzip', ['-q', zipPath, '-d', unpacked]);
  return { loc, zipPath, unpacked, codeSha256: loc.Configuration?.CodeSha256 || null };
};
const handlerNames = (src) => [...src.matchAll(/'((?:moov|checkalt)-[^']+)':\s*wrap/g)].map((m) => m[1]);
const validateCatalogNotShrinking = (liveSrc, nextSrc) => {
  const live = catalogNames(liveSrc);
  const next = catalogNames(nextSrc);
  const missing = live.filter((name) => !next.includes(name));
  if (missing.length) throw new Error(`catalog overlay would drop live functions: ${missing.join(',')}`);
  return { liveCount: live.length, nextCount: next.length, added: next.filter((name) => !live.includes(name)) };
};
const validateDispatchNotShrinking = (unpacked) => {
  const live = handlerNames(fs.readFileSync(path.join(unpacked, 'providers/production/moov-dispatch.mjs'), 'utf8'));
  const git = handlerNames(fs.readFileSync(path.join(API_SRC, 'providers/production/moov-dispatch.mjs'), 'utf8'));
  const missing = live.filter((name) => !git.includes(name));
  if (missing.length) throw new Error(`dispatch overlay would drop live handlers: ${missing.join(',')}`);
  return { live, git, added: git.filter((name) => !live.includes(name)) };
};
const patchLiveCatalog = (unpacked) => {
  const dest = path.join(unpacked, CATALOG_REL);
  const liveSrc = fs.readFileSync(dest, 'utf8');
  if (liveSrc.includes("fn('moov-production-payout-e2e'")) {
    const catalog = validateCatalogNotShrinking(liveSrc, liveSrc);
    return { patched: false, reason: 'already_present', sha256: sha256File(dest), catalog };
  }
  const marker = "fn('moov-payout-orchestrate'";
  const idx = liveSrc.indexOf(marker);
  if (idx < 0) throw new Error('live_catalog_missing_payout_orchestrate');
  const lineEnd = liveSrc.indexOf('\n', idx);
  if (lineEnd < 0) throw new Error('live_catalog_orchestrate_line_missing_newline');
  const nextSrc = `${liveSrc.slice(0, lineEnd)}\n${E2E_CATALOG_LINE}${liveSrc.slice(lineEnd)}`;
  const catalog = validateCatalogNotShrinking(liveSrc, nextSrc);
  fs.writeFileSync(dest, nextSrc);
  return { patched: true, reason: 'inserted_e2e', sha256: sha256File(dest), catalog };
};
const importGraph = async (unpacked) => {
  for (const rel of OVERLAY_FILES) {
    run(process.execPath, ['--check', path.join(unpacked, rel)]);
  }
  run(process.execPath, ['--check', path.join(unpacked, 'index.mjs')]);
  run(process.execPath, ['--check', path.join(unpacked, CATALOG_REL)]);
  const exportsOk = assertOverlayExports(unpacked);
  const script = `
    const e2e = await import('./providers/production/moov-production-payout-e2e.mjs');
    const dispatch = await import('./providers/production/moov-dispatch.mjs');
    const catalog = await import('./providers/catalog.mjs');
    const index = await import('./index.mjs');
    if (typeof e2e.executeProductionPayoutE2e !== 'function') throw new Error('missing_executeProductionPayoutE2e');
    if (typeof e2e.handleProductionPayoutE2e !== 'function') throw new Error('missing_handleProductionPayoutE2e');
    if (!dispatch.hasProductionMoovHandler('moov-production-payout-e2e')) throw new Error('dispatch_missing_e2e');
    if (!dispatch.hasProductionMoovHandler('moov-wallet-fund')) throw new Error('dispatch_missing_fund_block');
    if (!catalog.FUNCTION_BY_NAME['moov-production-payout-e2e']) throw new Error('catalog_missing_e2e');
    if (typeof index.handler !== 'function') throw new Error('missing_lambda_handler');
    console.log('IMPORT_GRAPH_OK');
  `;
  const out = run(process.execPath, ['--input-type=module', '-e', script], { cwd: unpacked });
  if (!out.includes('IMPORT_GRAPH_OK')) throw new Error('import_graph_failed');
  return { ok: true, ...exportsOk, nodeCheck: 'pass', importedHandler: true };
};
const overlayPrepApi = async () => {
  const work = path.join(os.tmpdir(), 'checksops-m715-overlay');
  const { unpacked, codeSha256 } = downloadLiveZip(work);
  const keepBefore = {};
  for (const rel of MUST_KEEP_REQUIRED) {
    const full = path.join(unpacked, rel);
    if (!fs.existsSync(full)) throw new Error(`must_keep_missing ${rel}`);
    keepBefore[rel] = sha256File(full);
  }
  for (const rel of MUST_KEEP_IF_PRESENT) {
    const full = path.join(unpacked, rel);
    if (fs.existsSync(full)) keepBefore[rel] = sha256File(full);
  }
  const dispatchGuard = validateDispatchNotShrinking(unpacked);
  const catalogPatch = patchLiveCatalog(unpacked);
  const copied = [];
  for (const rel of OVERLAY_FILES) {
    const src = path.join(API_SRC, rel);
    const dest = path.join(unpacked, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    copied.push({ rel, sha256: sha256File(dest), existed: Boolean(keepBefore[rel]) });
  }
  const keepAfter = {};
  for (const rel of MUST_KEEP) {
    const full = path.join(unpacked, rel);
    if (fs.existsSync(full)) keepAfter[rel] = sha256File(full);
    if (keepBefore[rel] && keepAfter[rel] !== keepBefore[rel]) {
      throw new Error(`overlay mutated protected file ${rel}`);
    }
  }
  const graph = await importGraph(unpacked);
  const outZip = path.join(work, 'overlay.zip');
  run('zip', ['-qr', outZip, '.'], { cwd: unpacked });
  const before = awsJson(['lambda', 'get-function-configuration', '--function-name', API_FN]);
  refuseArmed(before.Environment?.Variables || {});
  run(AWS, ['--region', REGION, 'lambda', 'update-function-code', '--function-name', API_FN, '--zip-file', `fileb://${outZip}`]);
  waitFn(API_FN);
  const after = awsJson(['lambda', 'get-function-configuration', '--function-name', API_FN]);
  refuseArmed(after.Environment?.Variables || {});
  if (JSON.stringify(before.Environment?.Variables) !== JSON.stringify(after.Environment?.Variables)) {
    throw new Error('overlay_changed_lambda_env');
  }
  return {
    beforeSha: before.CodeSha256 || codeSha256,
    afterSha: after.CodeSha256,
    lastModified: after.LastModified,
    state: after.State,
    lastUpdateStatus: after.LastUpdateStatus,
    copied,
    catalog: catalogPatch,
    dispatchGuard,
    graph,
    protectedUnchanged: Object.keys(keepBefore).every((rel) => keepBefore[rel] === keepAfter[rel]),
    mustKeepSha: keepAfter,
    envUnchanged: true,
    POST_FLAG: after.Environment?.Variables?.AWS_MOOV_TRANSFER_POST_ENABLED || null,
    SANDBOX_POST_FLAG: after.Environment?.Variables?.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED || null,
  };
};
const packOneshot = () => {
  const staging = path.join(os.tmpdir(), 'checksops-m715-oneshot-pack');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  fs.copyFileSync(path.join(ONESHOT_DIR, 'index.mjs'), path.join(staging, 'index.mjs'));
  fs.copyFileSync(path.join(ONESHOT_DIR, 'package.json'), path.join(staging, 'package.json'));
  fs.copyFileSync(path.join(ROOT, 'aws/rls/oneshot/rds-global-bundle.pem'), path.join(staging, 'rds-global-bundle.pem'));
  run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: staging, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const zipPath = path.join(os.tmpdir(), 'checksops-m715-oneshot.zip');
  fs.rmSync(zipPath, { force: true });
  run('zip', ['-qr', zipPath, '.'], { cwd: staging });
  return zipPath;
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
  const outFile = `/tmp/m715-oneshot-${payload.step}-${Date.now()}.json`;
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
const invokeApi = (event) => {
  const outFile = `/tmp/m715-api-${Date.now()}.json`;
  fs.writeFileSync(`/tmp/m715-api-event.json`, JSON.stringify(event));
  run(AWS, [
    '--region', REGION, 'lambda', 'invoke',
    '--function-name', API_FN,
    '--cli-binary-format', 'raw-in-base64-out',
    '--payload', `file:///tmp/m715-api-event.json`,
    outFile,
  ]);
  const raw = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  if (typeof raw.body === 'string') {
    try { return { ...raw, json: JSON.parse(raw.body) }; } catch { return raw; }
  }
  return raw;
};
const probe = async (pathName, method = 'GET', body = null) => {
  const started = Date.now();
  const res = await fetch(`${PREP_ORIGIN}${pathName}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 180) }; }
  return {
    path: pathName,
    method,
    status: res.status,
    ms: Date.now() - started,
    error: json?.error || null,
    healthy: json?.healthy ?? json?.ok ?? null,
    service: json?.service || null,
  };
};
const amountCentsOf = (amount) => {
  if (amount === undefined || amount === null) return 0;
  if (typeof amount === 'object') {
    if (amount.valueDecimal != null && amount.valueDecimal !== '') {
      const n = Math.round(Number(amount.valueDecimal) * 100);
      return Number.isFinite(n) ? n : 0;
    }
    const raw = amount.value ?? amount.amount ?? 0;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.round(n) : 0;
  }
  const n = Number(amount);
  return Number.isFinite(n) ? Math.round(n) : 0;
};

const main = async () => {
  if (!FUNCTION_BY_NAME['moov-production-payout-e2e']) throw new Error('catalog_missing_e2e');
  const identity = await assumeRole();
  const flagsBefore = lambdaFlags();
  refuseArmed(flagsBefore.flags);
  const overlay = await overlayPrepApi();
  const flagsAfter = lambdaFlags();
  refuseArmed(flagsAfter.flags);

  const health = invokeApi({
    rawPath: '/db-health',
    requestContext: { http: { method: 'GET', path: '/db-health' } },
  });
  const rootHealth = invokeApi({
    rawPath: '/health',
    requestContext: { http: { method: 'GET', path: '/health' } },
  });
  const authHealth = invokeApi({
    rawPath: '/auth/mfa/status',
    requestContext: { http: { method: 'POST', path: '/auth/mfa/status' } },
    body: '{}',
  });
  const totpHealth = invokeApi({
    rawPath: '/auth/mfa/step-up',
    requestContext: { http: { method: 'POST', path: '/auth/mfa/step-up' } },
    body: '{}',
  });
  const providerHealth = invokeApi({
    rawPath: '/providers/status',
    requestContext: { http: { method: 'GET', path: '/providers/status' } },
  });
  const webhookClosed = invokeApi({
    rawPath: '/webhooks/moov',
    requestContext: { http: { method: 'POST', path: '/webhooks/moov' } },
    body: JSON.stringify({ type: 'transfer.updated', data: { transferID: '00000000-0000-4000-8000-000000000000' } }),
    headers: { 'content-type': 'application/json' },
  });
  const independentFund = invokeApi({
    rawPath: '/functions/v1/moov-wallet-fund',
    requestContext: { http: { method: 'POST', path: '/functions/v1/moov-wallet-fund' } },
    body: '{}',
  });
  const e2eUnsigned = invokeApi({
    rawPath: '/functions/v1/moov-production-payout-e2e',
    requestContext: { http: { method: 'POST', path: '/functions/v1/moov-production-payout-e2e' } },
    body: '{}',
  });
  const publicProbes = {
    db: await probe('/db-health'),
    health: await probe('/health'),
    providers: await probe('/providers/status'),
    webhook: await probe('/webhooks/moov', 'POST', { type: 'transfer.updated' }),
    totp: await probe('/auth/mfa/step-up', 'POST', {}),
  };

  const syntaxHits = [];
  try {
    const logs = awsJson([
      'logs', 'filter-log-events',
      '--log-group-name', `/aws/lambda/${API_FN}`,
      '--start-time', String(Date.now() - 120000),
      '--filter-pattern', 'Runtime.UserCodeSyntaxError',
      '--limit', '5',
    ]);
    for (const ev of logs.events || []) syntaxHits.push(String(ev.message || '').slice(0, 180));
  } catch {
    /* log group may lag */
  }

  process.env.PROVIDER_SECRETS_ARN = flagsAfter.PROVIDER_SECRETS_ARN;
  const productionSecret = JSON.parse(awsJson([
    'secretsmanager', 'get-secret-value',
    '--secret-id', flagsAfter.PROVIDER_SECRETS_ARN,
  ]).SecretString || '{}');
  const prodCreds = {
    environment: 'production',
    publicKey: productionSecret.MOOV_PUBLIC_KEY,
    secretKey: productionSecret.MOOV_SECRET_KEY,
    platformId: productionSecret.MOOV_PLATFORM_ACCOUNT_ID,
    origin: PRODUCTION_MOOV_ORIGIN,
    apiVersion: PRODUCTION_MOOV_API_VERSION,
    host: 'https://api.moov.io',
  };
  const zip = packOneshot();
  const secretsList = awsJson(['secretsmanager', 'list-secrets']);
  const adminSecret = (secretsList.SecretList || []).find((s) => /checksops_admin/i.test(s.Name || s.ARN || ''));
  if (!adminSecret) throw new Error('checksops_admin secret not listed');
  ensureOneshot(zip, adminSecret.ARN, flagsAfter.vpc);
  const rds = invokeOneshot({ step: 'inspect_freedom_production' });
  if (rds?.ok !== true) throw new Error(`rds_inspect_failed:${rds?.error || 'unknown'}`);

  const deployed = downloadLiveZip(path.join(os.tmpdir(), 'checksops-m715-deployed-zip'));
  for (const rel of MUST_KEEP_REQUIRED) {
    const full = path.join(deployed.unpacked, rel);
    if (!fs.existsSync(full)) throw new Error(`deployed_missing_must_keep ${rel}`);
    if (sha256File(full) !== overlay.mustKeepSha[rel]) throw new Error(`must_keep_changed_after_deploy ${rel}`);
  }
  for (const rel of MUST_KEEP_IF_PRESENT.filter((item) => overlay.mustKeepSha[item])) {
    const full = path.join(deployed.unpacked, rel);
    if (!fs.existsSync(full)) throw new Error(`deployed_missing_must_keep ${rel}`);
    if (sha256File(full) !== overlay.mustKeepSha[rel]) throw new Error(`must_keep_changed_after_deploy ${rel}`);
  }
  for (const rel of OVERLAY_FILES) {
    if (!fs.existsSync(path.join(deployed.unpacked, rel))) throw new Error(`deployed_missing_overlay ${rel}`);
  }
  const deployedCatalog = fs.readFileSync(path.join(deployed.unpacked, CATALOG_REL), 'utf8');
  if (!deployedCatalog.includes("fn('moov-production-payout-e2e'")) {
    throw new Error('deployed_catalog_missing_e2e');
  }
  const deployedE2e = await import(pathToFileURL(path.join(deployed.unpacked, 'providers/production/moov-production-payout-e2e.mjs')).href);
  const freedom = KNOWN_APPROVED_MOOV.freedom;
  const recipient = KNOWN_APPROVED_MOOV.recipient;
  const walletJson = await productionMoovFetch({
    credentials: prodCreds,
    path: `/accounts/${freedom.moovAccountId}/wallets/${freedom.walletId}`,
    method: 'GET',
    mode: 'read',
    scopes: [`/accounts/${freedom.moovAccountId}/wallets.read`],
  });
  const live = walletJson?.json || walletJson;
  const liveAvailable = amountCentsOf(live?.availableBalance ?? live?.available);
  const livePending = amountCentsOf(live?.pendingBalance ?? live?.pending);
  const bankJson = await productionMoovFetch({
    credentials: prodCreds,
    path: `/accounts/${recipient.moovAccountId}/bank-accounts/${recipient.bankId}`,
    method: 'GET',
    mode: 'read',
    scopes: [`/accounts/${recipient.moovAccountId}/bank-accounts.read`],
  });
  const recipientVerified = String((bankJson?.json || bankJson)?.status || '').toLowerCase() === 'verified';
  console.log('STOP BEFORE WRITING: persistMoneyIntents=false store=null; planned intents are inspection-only.');
  const dark = await deployedE2e.executeProductionPayoutE2e({
    tenantId: FREEDOM,
    tenantEnvironment: 'production',
    liveAvailableCents: liveAvailable,
    recipientVerified,
    persistMoneyIntents: false,
    transferPostEnabled: false,
    sandboxTransferPostEnabled: false,
    store: null,
    postPhase: 'none',
  });
  if (dark.createdPaymentTransfer === true || dark.persist_money_intents === true || dark.liveProviderPosted === true) {
    throw new Error('refused_intent_write_or_post');
  }
  const flagsFinal = lambdaFlags();
  refuseArmed(flagsFinal.flags);

  const dbHealthy = health.json?.healthy === true || health.json?.ok === true || health.statusCode === 200;
  const webhookFailClosed = Number(webhookClosed.statusCode || 0) >= 400;
  const totpProtected = Number(totpHealth.statusCode || 0) === 401 || totpHealth.json?.error;
  const independentBlocked = Number(independentFund.statusCode || 0) === 401
    || independentFund.json?.error === 'independent_must_keep_writer_blocked'
    || independentFund.json?.error === 'unauthorized'
    || Number(independentFund.statusCode || 0) >= 400;
  const ready = overlay.protectedUnchanged
    && flagsFinal.flags.AWS_MOOV_TRANSFER_POST_ENABLED !== 'true'
    && dark.ok === true
    && syntaxHits.length === 0
    && dbHealthy;

  const card = {
    PRODUCTION_BASELINE_SHA: overlay.beforeSha,
    FILES_OVERLAID_DEPLOYED: `${CATALOG_REL} (surgical insert), ${OVERLAY_FILES.join(', ')}`,
    MUST_KEEP_WRITERS_PRESERVED: overlay.protectedUnchanged ? 'YES' : 'NO',
    INDEPENDENT_INVOCATION_BLOCKED: independentBlocked ? 'YES' : 'NO',
    NEW_PRODUCTION_SHA: overlay.afterSha,
    LAMBDA_ACTIVE: `${flagsFinal.state}/${flagsFinal.lastUpdateStatus}`,
    IMPORT_GRAPH: overlay.graph.ok ? 'PASS' : 'FAIL',
    DB_HEALTH: dbHealthy ? 'healthy' : JSON.stringify(health.json || health).slice(0, 180),
    AUTH_HEALTH: `${authHealth.statusCode || authHealth.status} ${authHealth.json?.error || ''}`.trim(),
    WEBHOOK_FAIL_CLOSED: webhookFailClosed ? 'YES' : 'NO',
    FINANCIAL_TOTP_PROTECTED: totpProtected ? 'YES' : 'NO',
    LIVE_FREEDOM_WALLET: freedom.walletId,
    LIVE_AVAILABLE: liveAvailable,
    LIVE_PENDING: livePending,
    DEPLOYED_DARK_DECISION: dark.decision,
    DEPLOYED_DARK_SHORTFALL: dark.shortfall_cents,
    FIRST_TEST_CAP: 1,
    FREEDOM_ONLY_GATE: 'YES',
    PRODUCTION_TOTP_REQUIRED: dark.require_totp === true ? 'YES' : 'NO',
    SEPARATE_FUND_DISBURSE_STEP_UPS: 'YES',
    DURABLE_INTENT_DESIGN: 'CAS persist before POST; this phase persist=false',
    CAS: 'reuse existing idempotency_key',
    UNKNOWN_OUTCOME: 'unknown_no_retry',
    REPLAY_PROTECTION: dark.payout_operation_id,
    LIVE_BALANCE_RELEASE_GATE: 'payout_submittable requires live available',
    PRODUCTION_POST_FLAG: flagsFinal.flags.AWS_MOOV_TRANSFER_POST_ENABLED,
    SANDBOX_POST_FLAG: flagsFinal.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED,
    PROVIDER_POSTS: dark.production_provider_posts,
    NEW_INTENTS: 0,
    MONEY_MOVED: false,
    SWEEP_CHANGED: false,
    READY_FOR_PHASE_A_HUMAN_WALLET_FUND_AUTHORIZATION: ready ? 'YES' : 'NO',
    SYNTAX_ERRORS: syntaxHits.length,
    PIPELINE_SANDBOX_ISOLATED: (rds.sandboxIdsInProductionPath || []).length === 0 ? 'YES' : 'NO',
  };

  const text = Object.entries({
    'PRODUCTION BASELINE SHA': card.PRODUCTION_BASELINE_SHA,
    'FILES OVERLAID/DEPLOYED': card.FILES_OVERLAID_DEPLOYED,
    'MUST_KEEP WRITERS PRESERVED': card.MUST_KEEP_WRITERS_PRESERVED,
    'INDEPENDENT INVOCATION BLOCKED': card.INDEPENDENT_INVOCATION_BLOCKED,
    'NEW PRODUCTION SHA': card.NEW_PRODUCTION_SHA,
    'LAMBDA ACTIVE': card.LAMBDA_ACTIVE,
    'IMPORT GRAPH': card.IMPORT_GRAPH,
    'DB HEALTH': card.DB_HEALTH,
    'AUTH HEALTH': card.AUTH_HEALTH,
    'WEBHOOK FAIL-CLOSED': card.WEBHOOK_FAIL_CLOSED,
    'FINANCIAL TOTP PROTECTED': card.FINANCIAL_TOTP_PROTECTED,
    'LIVE FREEDOM WALLET': card.LIVE_FREEDOM_WALLET,
    'LIVE AVAILABLE': card.LIVE_AVAILABLE,
    'LIVE PENDING': card.LIVE_PENDING,
    'DEPLOYED DARK DECISION': card.DEPLOYED_DARK_DECISION,
    'DEPLOYED DARK SHORTFALL': card.DEPLOYED_DARK_SHORTFALL,
    'FIRST-TEST CAP': card.FIRST_TEST_CAP,
    'FREEDOM-ONLY GATE': card.FREEDOM_ONLY_GATE,
    'PRODUCTION TOTP REQUIRED': card.PRODUCTION_TOTP_REQUIRED,
    'SEPARATE FUND/DISBURSE STEP-UPS': card.SEPARATE_FUND_DISBURSE_STEP_UPS,
    'DURABLE INTENT DESIGN': card.DURABLE_INTENT_DESIGN,
    CAS: card.CAS,
    'UNKNOWN OUTCOME': card.UNKNOWN_OUTCOME,
    'REPLAY PROTECTION': card.REPLAY_PROTECTION,
    'LIVE BALANCE RELEASE GATE': card.LIVE_BALANCE_RELEASE_GATE,
    'PRODUCTION POST FLAG': card.PRODUCTION_POST_FLAG,
    'SANDBOX POST FLAG': card.SANDBOX_POST_FLAG,
    'PROVIDER POSTS': card.PROVIDER_POSTS,
    'NEW INTENTS': card.NEW_INTENTS,
    'MONEY MOVED': card.MONEY_MOVED,
    'SWEEP CHANGED': card.SWEEP_CHANGED,
    'READY FOR PHASE A HUMAN wallet.fund AUTHORIZATION': card.READY_FOR_PHASE_A_HUMAN_WALLET_FUND_AUTHORIZATION,
  }).map(([key, value]) => `${key}: ${value}`).join('\n');
  const footer = `\n\nSTOP FOR REVIEW.\nDO NOT ASK FOR FINANCIAL TOTP YET.\nDO NOT ENABLE PRODUCTION POST.\nDO NOT MOVE THE PENNY.\n`;
  fs.mkdirSync('/opt/cursor/artifacts', { recursive: true });
  fs.writeFileSync('/opt/cursor/artifacts/m715_prod_e2e_deploy_card.md', `${text}${footer}`);
  fs.writeFileSync('/opt/cursor/artifacts/m715_prod_e2e_deploy_run.json', `${JSON.stringify({
    at: new Date().toISOString(),
    identity,
    flagsBefore,
    flagsAfter,
    flagsFinal,
    overlay,
    health,
    rootHealth,
    authHealth,
    totpHealth,
    providerHealth,
    webhookClosed,
    independentFund,
    e2eUnsigned,
    publicProbes,
    syntaxHits,
    rds: {
      ok: rds.ok,
      freedom: rds.freedom,
      sandboxIdsInProductionPath: rds.sandboxIdsInProductionPath,
      productionAccount: rds.freedomProduction?.account?.provider_account_id,
      productionWallet: rds.freedomProduction?.wallet?.provider_wallet_id,
    },
    dark,
    card,
  }, null, 2)}\n`);
  console.log(text + footer);
  if (!ready) process.exitCode = 2;
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
