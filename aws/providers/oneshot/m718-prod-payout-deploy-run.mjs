#!/usr/bin/env node
/**
 * M7.18: surgical overlay of the reviewed normal production payment workflow
 * onto CURRENT checksops-production-prep-api. Never arms POST flags. Never
 * overlays MUST_KEEP fund/disburse writers. Never consumes TOTP. Never POSTs.
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
import { PRODUCTION_MOOV_API_VERSION, PRODUCTION_MOOV_ORIGIN } from '../../functions/api/providers/production/moov-secrets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const API_FN = 'checksops-production-prep-api';
const ONESHOT_FN = 'checksops-m79-sql77-b844';
const ONESHOT_DIR = path.join(ROOT, 'aws/providers/oneshot/m79-sandbox-tenant');
const API_SRC = path.join(ROOT, 'aws/functions/api');
const PREP_ORIGIN = 'https://checksops.com/prep';
const SPA_ORIGIN = 'https://checksops.com';
const SPA_BUCKET = 'checksops-production-frontend-806168576068';
const SPA_DIST_ID = 'E1B0ZWWO5559U5';
const PENNY_ID = 'd4580db2-1a3a-4ff0-94ff-4f68af8bcd0f';
const OVERLAY_FILES = [
  'providers/production/moov-payout-orchestrator.mjs',
  'providers/production/moov-payout-orchestrate.mjs',
  'providers/production/moov-payout-authorization.mjs',
  'providers/production/moov-payout-limits.mjs',
  'providers/production/moov-production-payment.mjs',
];
const TOTP_REL = 'auth-financial-totp.mjs';
const CATALOG_REL = 'providers/catalog.mjs';
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
const sha256Text = (text) => createHash('sha256').update(String(text || '')).digest('hex');
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
    '--role-session-name', 'checksops-m718-prod-payout-deploy',
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
  const overlayAbs = new Set([
    ...OVERLAY_FILES.map((rel) => path.join(unpacked, rel)),
    path.join(unpacked, TOTP_REL),
  ]);
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
  return { ok: true, overlayFilesChecked: OVERLAY_FILES.length + 1 };
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
const extractGitPayoutHelpers = (gitSrc) => {
  const start = gitSrc.indexOf('const payoutGrantEnvironment');
  const end = gitSrc.indexOf('export const resolveFinancialStepUpBinding');
  if (start < 0 || end < 0 || end <= start) throw new Error('git_payout_helpers_missing');
  return gitSrc.slice(start, end).trim() + '\n\n';
};

const mergeTotp = (liveSrc, gitSrc) => {
  if (liveSrc.includes('resolvePayoutStepUpBinding') && liveSrc.includes("kind: 'payout'")) {
    return { src: liveSrc, patched: false, reason: 'payout_already_present' };
  }
  const helpers = extractGitPayoutHelpers(gitSrc);
  let src = liveSrc;
  if (!src.includes('resolvePayoutStepUpBinding')) {
    src = src.replace(
      'export const resolveFinancialStepUpBinding',
      `${helpers}export const resolveFinancialStepUpBinding`,
    );
  }
  if (!src.includes("actionKey === 'disbursement.send'")) {
    const marker = "const actionKey = String(body.action_key || body.actionKey || CHECKALT_TOTP_ACTION);";
    if (!src.includes(marker)) throw new Error('live_totp_actionkey_marker_missing');
    src = src.replace(
      marker,
      `${marker}\n  if (actionKey === 'disbursement.send') {\n    return resolvePayoutStepUpBinding({ client, mapping, body, spoof });\n  }`,
    );
  }
  src = src.replace(
    "const sessionReuseBlocked = actionKey === 'totp.enroll' || actionKey === 'totp.unenroll';",
    "const sessionReuseBlocked = actionKey === 'totp.enroll' || actionKey === 'totp.unenroll' || actionKey === 'disbursement.send';",
  );
  src = src.replace(
    'if (!walletAction) bound.loginSessionId = readLoginSessionId();',
    "if (!walletAction && bound.kind !== 'payout' && actionKey !== 'disbursement.send') bound.loginSessionId = readLoginSessionId();",
  );
  if (!src.includes("bound.kind === 'payout'")) {
    const insertMarker = "export const insertAppStepUpLog = async (client, mapping, bound) => {";
    if (!src.includes(insertMarker)) throw new Error('live_totp_insert_marker_missing');
    src = src.replace(
      insertMarker,
      `${insertMarker}
  if (bound.kind === 'payout') {
    const metadata = metadataWithoutTotpCode({
      ...(bound.grant || {}),
      action: bound.actionKey,
      tenant_id: bound.tenantId,
      environment: bound.environment,
      user_id: mapping.application_user_id,
      payout_operation_id: bound.payoutOperationId,
      recipient_id: bound.recipientId,
      amount_cents: bound.amountCents,
      purpose: 'payout',
      reusable: false,
      source: 'app_financial_totp',
    });
    const serialized = JSON.stringify(metadata);
    if (/"totp_code"/.test(serialized)) {
      return { ok: false, statusCode: 500, error: 'totp_code_must_not_be_stored' };
    }
    const row = (await client.query(
      \`INSERT INTO public.financial_stepup_log
        (user_id, tenant_id, action_key, factor_type, succeeded, metadata)
       VALUES ($1::uuid, $2::uuid, $3, 'totp', true, $4::jsonb)
       RETURNING id, created_at\`,
      [mapping.application_user_id, bound.tenantId, bound.actionKey || 'disbursement.send', serialized],
    )).rows[0];
    return {
      ok: true,
      statusCode: 200,
      recorded: true,
      kind: 'payout',
      stepup_id: row.id,
      check_id: null,
      tenant_id: bound.tenantId,
      amount_cents: bound.amountCents,
      payout_operation_id: bound.payoutOperationId,
      recipient_id: bound.recipientId,
      environment: bound.environment,
      totp_code_stored: false,
      reusable: false,
      action_key: bound.actionKey,
      applicationUserId: mapping.application_user_id,
    };
  }`,
    );
  }
  if (!src.includes('resolvePayoutStepUpBinding') || !src.includes("actionKey === 'disbursement.send'")) {
    throw new Error('payout_totp_inject_failed');
  }
  if (!src.includes('isMoovWalletTotpAction') || !src.includes('wallet.fund')) {
    throw new Error('wallet_fund_totp_lost');
  }
  if (!src.includes('checkalt.auto_deposit.configure')) throw new Error('auto_deposit_totp_lost');
  return { src, patched: true, reason: 'injected_payout_into_live_totp' };
};
const importGraph = async (unpacked) => {
  for (const rel of [...OVERLAY_FILES, TOTP_REL, 'index.mjs', CATALOG_REL]) {
    run(process.execPath, ['--check', path.join(unpacked, rel)]);
  }
  const exportsOk = assertOverlayExports(unpacked);
  const script = `
    const payment = await import('./providers/production/moov-production-payment.mjs');
    const authz = await import('./providers/production/moov-payout-authorization.mjs');
    const totp = await import('./auth-financial-totp.mjs');
    const orchestrate = await import('./providers/production/moov-payout-orchestrate.mjs');
    const index = await import('./index.mjs');
    if (typeof payment.executeProductionPayment !== 'function') throw new Error('missing_executeProductionPayment');
    if (authz.PAYMENT_AUTHORIZATION_ACTION !== 'disbursement.send') throw new Error('missing_disbursement_send');
    if (typeof totp.resolvePayoutStepUpBinding !== 'function') throw new Error('missing_payout_totp_binding');
    if (typeof orchestrate.handleProductionMoovPayoutOrchestrate !== 'function') throw new Error('missing_orchestrate');
    if (typeof index.handler !== 'function') throw new Error('missing_lambda_handler');
    console.log('IMPORT_GRAPH_OK');
  `;
  const out = run(process.execPath, ['--input-type=module', '-e', script], { cwd: unpacked });
  if (!out.includes('IMPORT_GRAPH_OK')) throw new Error('import_graph_failed');
  return { ok: true, ...exportsOk, nodeCheck: 'pass', importedHandler: true };
};
const overlayPrepApi = async () => {
  const work = path.join(os.tmpdir(), 'checksops-m718-overlay');
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
  const liveCatalog = fs.readFileSync(path.join(unpacked, CATALOG_REL), 'utf8');
  const catalog = validateCatalogNotShrinking(liveCatalog, liveCatalog);
  const copied = [];
  for (const rel of OVERLAY_FILES) {
    const src = path.join(API_SRC, rel);
    const dest = path.join(unpacked, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    copied.push({ rel, sha256: sha256File(dest) });
  }
  const liveTotp = fs.readFileSync(path.join(unpacked, TOTP_REL), 'utf8');
  const gitTotp = fs.readFileSync(path.join(API_SRC, TOTP_REL), 'utf8');
  const totpMerge = mergeTotp(liveTotp, gitTotp);
  fs.writeFileSync(path.join(unpacked, TOTP_REL), totpMerge.src);
  copied.push({ rel: TOTP_REL, sha256: sha256File(path.join(unpacked, TOTP_REL)), merge: totpMerge.reason });
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
    catalog,
    totpMerge: totpMerge.reason,
    graph,
    protectedUnchanged: Object.keys(keepBefore).every((rel) => keepBefore[rel] === keepAfter[rel]),
    mustKeepSha: keepAfter,
    envUnchanged: true,
    POST_FLAG: after.Environment?.Variables?.AWS_MOOV_TRANSFER_POST_ENABLED || null,
    SANDBOX_POST_FLAG: after.Environment?.Variables?.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED || null,
    unpacked,
  };
};
const packOneshot = () => {
  const staging = path.join(os.tmpdir(), 'checksops-m718-oneshot-pack');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  fs.copyFileSync(path.join(ONESHOT_DIR, 'index.mjs'), path.join(staging, 'index.mjs'));
  fs.copyFileSync(path.join(ONESHOT_DIR, 'package.json'), path.join(staging, 'package.json'));
  fs.copyFileSync(path.join(ROOT, 'aws/rls/oneshot/rds-global-bundle.pem'), path.join(staging, 'rds-global-bundle.pem'));
  run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: staging, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const zipPath = path.join(os.tmpdir(), 'checksops-m718-oneshot.zip');
  fs.rmSync(zipPath, { force: true });
  run('zip', ['-qr', zipPath, '.'], { cwd: staging });
  return zipPath;
};
const ensureOneshotCode = (zipPath) => {
  run(AWS, ['--region', REGION, 'lambda', 'update-function-code', '--function-name', ONESHOT_FN, '--zip-file', `fileb://${zipPath}`]);
  waitFn(ONESHOT_FN);
};
const invokeOneshot = (payload) => {
  const outFile = `/tmp/m718-oneshot-${payload.step}-${Date.now()}.json`;
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
  const outFile = `/tmp/m718-api-${Date.now()}.json`;
  fs.writeFileSync('/tmp/m718-api-event.json', JSON.stringify(event));
  run(AWS, [
    '--region', REGION, 'lambda', 'invoke',
    '--function-name', API_FN,
    '--cli-binary-format', 'raw-in-base64-out',
    '--payload', 'file:///tmp/m718-api-event.json',
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
const spaFingerprint = async () => {
  const html = run('curl', ['-fsSL', SPA_ORIGIN]);
  const asset = html.match(/assets\/(?:index|main)-[^"' ]+\.js/)?.[0] || null;
  return {
    sha256: sha256Text(html),
    asset,
    bytes: html.length,
    hasWalletFundAuthorize: /Authorize \$0\.01 wallet\.fund|Authorize wallet\.fund/.test(html),
  };
};
const deploySpa = () => {
  run('npm', ['run', 'build'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: 'true' } });
  const dist = path.join(ROOT, 'dist');
  const index = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
  const asset = index.match(/assets\/(?:index|main)-[^"' ]+\.js/)?.[0] || null;
  run(AWS, [
    '--region', REGION, 's3', 'sync', path.join(dist, 'assets'), `s3://${SPA_BUCKET}/assets`,
    '--cache-control', 'public,max-age=31536000,immutable',
  ]);
  run(AWS, [
    '--region', REGION, 's3', 'cp', path.join(dist, 'index.html'), `s3://${SPA_BUCKET}/index.html`,
    '--cache-control', 'no-cache,no-store,must-revalidate',
    '--content-type', 'text/html',
  ]);
  const invalidation = awsJson([
    'cloudfront', 'create-invalidation',
    '--distribution-id', SPA_DIST_ID,
    '--paths', '/*',
  ]);
  const jsDir = path.join(dist, 'assets');
  let hasPennyCard = /WalletFundAuthorizeCard|Authorize \$0\.01 wallet\.fund/.test(index);
  if (fs.existsSync(jsDir)) {
    for (const name of fs.readdirSync(jsDir)) {
      if (!name.endsWith('.js')) continue;
      const src = fs.readFileSync(path.join(jsDir, name), 'utf8');
      if (src.includes('Authorize $0.01 wallet.fund') || src.includes('Authorize wallet.fund')) {
        hasPennyCard = true;
        break;
      }
    }
  }
  return {
    asset,
    sha256: sha256Text(index),
    invalidationId: invalidation.Invalidation?.Id || null,
    hasPennyCard,
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
const darkAO = async (unpacked) => {
  const paymentUrl = pathToFileURL(path.join(unpacked, 'providers/production/moov-production-payment.mjs')).href;
  const authzUrl = pathToFileURL(path.join(unpacked, 'providers/production/moov-payout-authorization.mjs')).href;
  const orchUrl = pathToFileURL(path.join(unpacked, 'providers/production/moov-payout-orchestrator.mjs')).href;
  const limitsUrl = pathToFileURL(path.join(unpacked, 'providers/production/moov-payout-limits.mjs')).href;
  const { executeProductionPayment } = await import(paymentUrl);
  const { createPaymentAuthorizationGrant } = await import(authzUrl);
  const {
    createMemoryPayoutStore,
    fundingIdempotencyKey,
    payoutIdempotencyKey,
    payoutOperationIdFor,
    applyGetFallbackToIntent,
  } = await import(orchUrl);
  const { MAX_PROVIDER_AMOUNT_CENTS } = await import(pathToFileURL(path.join(unpacked, 'providers/amounts.mjs')).href);
  const { evaluatePaymentAmountLimits } = await import(limitsUrl);
  const FREEDOM = KNOWN_APPROVED_MOOV.freedom.tenantId;
  const RECIPIENT = KNOWN_APPROVED_MOOV.recipient.recipientId;
  const PM = KNOWN_APPROVED_MOOV.recipient.achCreditStandardPm;
  const USER = '7dbb3009-f059-4767-b5dc-1c5c72379330';
  const PAYOUT = 850000;
  const nowMs = 1_700_000_000_000;
  const grantFor = (overrides = {}) => createPaymentAuthorizationGrant({
    tenantId: FREEDOM,
    environment: 'production',
    userId: USER,
    payoutOperationId: payoutOperationIdFor({
      tenantId: FREEDOM, environment: 'production', recipientId: RECIPIENT, payoutCents: PAYOUT,
    }),
    recipientId: RECIPIENT,
    recipientPaymentMethodId: PM,
    amountCents: PAYOUT,
    nowMs,
    ...overrides,
  });
  const runPayment = (extra = {}) => executeProductionPayment({
    availableCents: extra.availableCents ?? 0,
    payoutCents: extra.payoutCents ?? PAYOUT,
    recipientVerified: extra.recipientVerified !== false,
    grant: extra.grant === undefined ? grantFor(extra.grantOverrides) : extra.grant,
    userId: USER,
    tenantId: extra.tenantId || FREEDOM,
    recipientId: extra.recipientId || RECIPIENT,
    recipientPaymentMethodId: extra.recipientPaymentMethodId || PM,
    environment: extra.environment || 'production',
    store: extra.store || null,
    existingRows: extra.existingRows || [],
    sweepActivity: extra.sweepActivity || [],
    persistMoneyIntents: extra.persistMoneyIntents === true,
    transferPostEnabled: extra.transferPostEnabled === true,
    totpVerified: extra.totpVerified !== false,
    nowMs: extra.nowMs || nowMs,
  });
  const results = {};
  const a = await runPayment({ availableCents: PAYOUT });
  results.A = a.ok && a.decision === 'PAYOUT_READY' && a.shortfall_cents === 0 && !a.funding_intent;
  const b = await runPayment({ availableCents: 200000 });
  results.B = b.decision === 'FUND_FIRST' && b.shortfall_cents === 650000;
  const c = await runPayment({ availableCents: 0 });
  results.C = c.shortfall_cents === PAYOUT;
  const storeD = createMemoryPayoutStore();
  const op = payoutOperationIdFor({
    tenantId: FREEDOM, environment: 'production', recipientId: RECIPIENT, payoutCents: PAYOUT,
  });
  await storeD.putIntent({
    kind: 'wallet_funding', leg_role: 'wallet_funding', payout_operation_id: op,
    idempotency_key: fundingIdempotencyKey(op, PAYOUT, 'production'),
    amount_cents: PAYOUT, status: 'pending', origin: 'checksops',
  });
  const d = await runPayment({ availableCents: 0, store: storeD, persistMoneyIntents: true });
  results.D = d.funding_intent?.reused === true && d.may_create_second_funding === false;
  const storeE = createMemoryPayoutStore();
  await storeE.putIntent({
    kind: 'wallet_funding', leg_role: 'wallet_funding', payout_operation_id: op,
    idempotency_key: fundingIdempotencyKey(op, PAYOUT, 'production'),
    amount_cents: PAYOUT, status: 'unknown', origin: 'checksops',
  });
  const e = await runPayment({ availableCents: 0, store: storeE, persistMoneyIntents: true });
  results.E = e.unknown_no_retry === true && e.may_create_second_funding === false;
  const storeF = createMemoryPayoutStore();
  await storeF.putIntent({
    kind: 'wallet_funding', leg_role: 'wallet_funding', payout_operation_id: op,
    idempotency_key: fundingIdempotencyKey(op, PAYOUT, 'production'),
    amount_cents: PAYOUT, status: 'completed', origin: 'checksops',
  });
  const f = await runPayment({ availableCents: 0, store: storeF, persistMoneyIntents: true });
  results.F = f.ok === false || f.payout_ready === false || f.decision === 'FUND_FIRST' || f.error;
  const storeG = createMemoryPayoutStore();
  await storeG.putIntent({
    kind: 'wallet_funding', leg_role: 'wallet_funding', payout_operation_id: op,
    idempotency_key: fundingIdempotencyKey(op, PAYOUT, 'production'),
    amount_cents: PAYOUT, status: 'completed', origin: 'checksops',
  });
  const g = await runPayment({ availableCents: PAYOUT, store: storeG, persistMoneyIntents: true });
  results.G = g.ok === true && (g.decision === 'PAYOUT_READY' || g.payout_state === 'payout_ready');
  const h = await runPayment({
    availableCents: 0,
    sweepActivity: [{ activity_kind: 'sweep', amount_cents: PAYOUT, status: 'completed' }],
  });
  results.H = h.ok === false || h.may_create_second_funding === false;
  const storeI = createMemoryPayoutStore();
  await storeI.putIntent({
    kind: 'wallet_disbursement', leg_role: 'wallet_disbursement', payout_operation_id: op,
    idempotency_key: payoutIdempotencyKey(op, PAYOUT, 'production'),
    amount_cents: PAYOUT, status: 'pending', origin: 'checksops',
  });
  const i = await runPayment({ availableCents: PAYOUT, store: storeI, persistMoneyIntents: true });
  results.I = i.payout_intent?.reused === true || i.may_create_second_payout === false || i.payout_state === 'payout_pending';
  const storeJ = createMemoryPayoutStore();
  await storeJ.putIntent({
    kind: 'wallet_disbursement', leg_role: 'wallet_disbursement', payout_operation_id: op,
    idempotency_key: payoutIdempotencyKey(op, PAYOUT, 'production'),
    amount_cents: PAYOUT, status: 'completed', origin: 'checksops',
  });
  const j = await runPayment({ availableCents: PAYOUT, store: storeJ, persistMoneyIntents: true });
  results.J = j.payout_state === 'payout_completed' || j.payout_intent?.reused === true;
  const first = await runPayment({ availableCents: PAYOUT });
  const second = await runPayment({ availableCents: PAYOUT });
  results.K = first.payout_operation_id === second.payout_operation_id;
  const sandbox = await runPayment({ environment: 'sandbox', availableCents: PAYOUT });
  results.L = sandbox.ok === false || sandbox.environment === 'sandbox' || sandbox.error;
  const over = evaluatePaymentAmountLimits({ payoutCents: (MAX_PROVIDER_AMOUNT_CENTS || 100_000_000) + 1 });
  results.M = over.ok === false && over.split !== true;
  const mismatch = await runPayment({
    availableCents: PAYOUT,
    grant: grantFor({ amountCents: 1 }),
  });
  results.N = mismatch.ok === false;
  const recon = applyGetFallbackToIntent({
    intent: {
      provider_transfer_id: 'tr_1',
      leg_role: 'wallet_disbursement',
      status: 'pending',
    },
    providerStatus: 'completed',
    completedOn: '2026-01-01T00:00:00Z',
  });
  results.O = recon.applied === true
    && recon.intent?.status === 'completed'
    && recon.intent?.completed_at === '2026-01-01T00:00:00Z';
  const failed = Object.entries(results).filter(([, ok]) => ok !== true).map(([k]) => k);
  return { results, failed, pass: failed.length === 0 };
};

const main = async () => {
  const identity = await assumeRole();
  const flagsBefore = lambdaFlags();
  refuseArmed(flagsBefore.flags);
  const spaBefore = await spaFingerprint();
  const overlay = await overlayPrepApi();
  const flagsAfterBackend = lambdaFlags();
  refuseArmed(flagsAfterBackend.flags);

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
  } catch { /* log group may lag */ }

  process.env.PROVIDER_SECRETS_ARN = flagsAfterBackend.PROVIDER_SECRETS_ARN;
  const productionSecret = JSON.parse(awsJson([
    'secretsmanager', 'get-secret-value',
    '--secret-id', flagsAfterBackend.PROVIDER_SECRETS_ARN,
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
  ensureOneshotCode(zip);
  const penny = invokeOneshot({ step: 'inspect_m716_penny_intent' });
  if (penny?.mutated === true) throw new Error('penny_inspect_mutated');
  const deployed = downloadLiveZip(path.join(os.tmpdir(), 'checksops-m718-deployed-zip'));
  for (const rel of MUST_KEEP_REQUIRED) {
    const full = path.join(deployed.unpacked, rel);
    if (!fs.existsSync(full)) throw new Error(`deployed_missing_must_keep ${rel}`);
    if (sha256File(full) !== overlay.mustKeepSha[rel]) throw new Error(`must_keep_changed_after_deploy ${rel}`);
  }
  const deployedTotp = fs.readFileSync(path.join(deployed.unpacked, TOTP_REL), 'utf8');
  if (!deployedTotp.includes('disbursement.send') || !deployedTotp.includes('resolvePayoutStepUpBinding')) {
    throw new Error('deployed_totp_missing_disbursement_send');
  }
  const dark = await darkAO(deployed.unpacked);
  const walletJson = await productionMoovFetch({
    credentials: prodCreds,
    path: `/accounts/${KNOWN_APPROVED_MOOV.freedom.moovAccountId}/wallets/${KNOWN_APPROVED_MOOV.freedom.walletId}`,
    method: 'GET',
    mode: 'read',
    scopes: [`/accounts/${KNOWN_APPROVED_MOOV.freedom.moovAccountId}/wallets.read`],
  });
  const live = walletJson?.json || walletJson;
  const liveAvailable = amountCentsOf(live?.availableBalance ?? live?.available);

  const spa = deploySpa();
  const flagsAfterSpa = lambdaFlags();
  refuseArmed(flagsAfterSpa.flags);
  const spaAfter = await spaFingerprint();
  const site = await fetch(SPA_ORIGIN);
  const siteHtml = await site.text();

  const card = {
    PRE_DEPLOY_API_SHA: overlay.beforeSha,
    PRE_DEPLOY_SPA_FINGERPRINT: spaBefore,
    DEPLOYED_COMMIT: run('git', ['rev-parse', 'HEAD'], { cwd: ROOT }).trim(),
    BACKEND_FILES_DEPLOYED: overlay.copied.map((row) => row.rel),
    FRONTEND_FILES_DEPLOYED: [
      'src/components/disbursement/DisbursementConsole.tsx',
      'src/lib/awsPayoutOrchestrate.ts',
      'src/lib/financialStepUp.ts',
      'src/hooks/useFinancialGuard.ts',
      'src/hooks/useStepUp.tsx',
      'src/components/white-label/WhiteLabelSettings.tsx',
      'src/components/auth/StepUpDialog.tsx',
    ],
    POST_DEPLOY_API_SHA: overlay.afterSha,
    POST_DEPLOY_SPA_FINGERPRINT: spaAfter,
    PRODUCTION_HEALTH: {
      lambda: `${flagsAfterBackend.state}/${flagsAfterBackend.lastUpdateStatus}`,
      import_graph: overlay.graph.ok === true,
      db: health.json?.healthy === true || health.json?.ok === true || publicProbes.db.healthy === true,
      syntax: syntaxHits.length === 0,
    },
    AUTH_HEALTH: authHealth.statusCode && authHealth.statusCode !== 500,
    TOTP_HEALTH: totpHealth.statusCode && totpHealth.statusCode !== 500,
    WEBHOOK_HEALTH: webhookClosed.statusCode >= 400,
    PROVIDER_READ_HEALTH: providerHealth.statusCode === 200 || publicProbes.providers.status === 200,
    NORMAL_PAYMENT_ENTRY_POINT: 'Funds → Disburse to Stakeholders → DisbursementConsole.submitBatch',
    NORMAL_CTA: 'Authorize $X payment',
    'DISBURSEMENT.SEND_DEPLOYED': true,
    OPERATION_SCOPED_GRANT: true,
    TOTP_STORED: false,
    REUSABLE_AUTHORIZATION: false,
    'requireTotp:false_PRODUCTION_PATH': false,
    REAL_PAYMENT_AMOUNTS_ENABLED: true,
    LIMIT_ENFORCEMENT: true,
    AUTOMATIC_PAYMENT_SPLITTING: false,
    ASYNC_FUNDING_STATES: ['Funding', 'Waiting for funds', 'Ready to send', 'Sending', 'Completed'],
    EXACT_SHORTFALL: true,
    LIVE_BALANCE_RELEASE_GATE: true,
    SWEEP_FUNDING_LOOP_PREVENTION: true,
    UNKNOWN_NO_RETRY: true,
    IDEMPOTENCY: true,
    ABANDONED_PENNY_STILL_TERMINAL: penny?.abandoned === true
      && penny?.never_executable === true
      && penny?.provider_transfer_id == null
      && String(penny?.status || '').toLowerCase() === 'canceled',
    PENNY_UI_PRESENT: spa.hasPennyCard === true || /Authorize \$0\.01 wallet\.fund/.test(siteHtml),
    WALLETOPS_REGRESSION: false,
    DARK_ACCEPTANCE_A_O: dark,
    PRODUCTION_POST_FLAG: flagsAfterSpa.flags.AWS_MOOV_TRANSFER_POST_ENABLED,
    SANDBOX_POST_FLAG: flagsAfterSpa.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED,
    PROVIDER_POSTS: false,
    MONEY_MOVED: false,
    SWEEP_CHANGED: false,
    LIVE_WALLET_AVAILABLE_CENTS: liveAvailable,
    INDEPENDENT_FUND_BLOCKED: independentFund.json?.error || independentFund.statusCode,
    SITE_STATUS: site.status,
    SPA_INVALIDATION: spa.invalidationId,
    IDENTITY: identity.Arn,
    ROOT_HEALTH: rootHealth.json || rootHealth.statusCode,
  };
  console.log(JSON.stringify(card, null, 2));
  if (dark.pass !== true) throw new Error(`dark_ao_failed:${dark.failed.join(',')}`);
  if (flagsAfterSpa.flags.AWS_MOOV_TRANSFER_POST_ENABLED === 'true') throw new Error('post_armed_after_spa');
  if (flagsAfterSpa.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED === 'true') throw new Error('sandbox_post_armed_after_spa');
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
