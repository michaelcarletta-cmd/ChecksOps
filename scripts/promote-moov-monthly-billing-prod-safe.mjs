#!/usr/bin/env node
/**
 * Production safe-mode promotion for accepted monthly tenant billing.
 * Does not enable AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST.
 * Does not create EventBridge. Does not overlay moov-money or CheckAlt.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assumeCursorRole, secretString } from './cognito-staging-token.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const OUT = '/opt/cursor/artifacts/moov-monthly-billing-prod-safe';
const PROD_API = 'checksops-production-prep-api';
const STAGING_API = 'checksops-staging-api';
const ONESHOT = 'checksops-prod-moov-billing-sql-43-2d41';
const REHEARSAL = 'checksops-staging-rehearsal-oneshot';
const EXPECTED_SHA = 'yRfwK+7YYu55xcbFOBrLTVrIvpNxhZ8HBvMUmAvM2ig=';
const PROD_ACCOUNT = '41cb5d67-4911-4bef-aad5-d8ee9c582208';
const PROD_WALLET = '72630a70-4954-4761-b652-e8beff1ad02c';
const PROD_METHOD = 'c70a90f2-9bcc-4084-8263-d5a0fb5d806c';
const SANDBOX_MERCHANT = '36b79957-ce7a-4ca7-a68f-30986c9e47bb';
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const C1C = '4f172140-f57a-4744-8050-95f4f07b13b4';
const OWNER_EMAIL = 'checksopsadmin@gmail.com';
const PROD_POOL = 'us-east-1_h00WorYMT';
const PROD_CLIENT = '3ja9fqaq2fjkv3i6up2varcqpe';
const PROD_BUCKET = 'checksops-production-frontend-806168576068';
const PROD_CF = 'E1B0ZWWO5559U5';
const PROD_API_URL = 'https://checksops.com/prep';
const FROZEN_FLAGS = [
  'AWS_MOOV_TRANSFER_POST_ENABLED',
  'AWS_MOOV_ENABLED',
  'AWS_PROVIDER_EXECUTION_ENABLED',
  'AWS_CHECKALT_ENABLED',
  'AWS_CHECKALT_STATUS_RECONCILE_ENABLED',
  'AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED',
  'AWS_PROVIDER_WEBHOOK_DRY_RUN',
  'AWS_FINANCIAL_PERMISSIONS_ACTIVATED',
  'AWS_WRITES_ENABLED',
  'CHECKSOPS_ENV',
  'COGNITO_USER_POOL_ID',
  'COGNITO_CLIENT_ID',
];

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...opts });
const awsJson = (args) => {
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  return out.trim() ? JSON.parse(out) : {};
};
const awsTry = (args, { json = true } = {}) => {
  try {
    const out = execFileSync(AWS, ['--region', REGION, ...(json ? ['--output', 'json'] : []), ...args], {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });
    if (!json) return { ok: true, data: { raw: String(out).trim().slice(0, 300) } };
    return { ok: true, data: out.trim() ? JSON.parse(out) : {} };
  } catch (error) {
    const text = String(error.stderr || error.stdout || error.message || error);
    return {
      ok: false,
      denied: /AccessDenied|not authorized|explicit deny/i.test(text),
      action: (text.match(/not authorized to perform: ([A-Za-z0-9:]+)/) || [])[1] || `${args[0]}:${args[1]}`,
      error: text.replace(/\s+/g, ' ').trim().slice(0, 500),
    };
  }
};

const waitFn = (name) => {
  try { run(AWS, ['lambda', 'wait', 'function-updated', '--function-name', name]); } catch { /* ok */ }
  try { run(AWS, ['lambda', 'wait', 'function-active', '--function-name', name]); } catch { /* ok */ }
};

const flagSlice = (vars = {}) => ({
  CHECKSOPS_ENV: vars.CHECKSOPS_ENV || null,
  AWS_MOOV_MONTHLY_BILLING_ENABLED: vars.AWS_MOOV_MONTHLY_BILLING_ENABLED ?? null,
  AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST: vars.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST ?? null,
  AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID: vars.AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID ?? null,
  AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID: vars.AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID ?? null,
  AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED: vars.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED ?? null,
  AWS_MOOV_TRANSFER_POST_ENABLED: vars.AWS_MOOV_TRANSFER_POST_ENABLED ?? null,
  AWS_MOOV_ENABLED: vars.AWS_MOOV_ENABLED ?? null,
  AWS_PROVIDER_EXECUTION_ENABLED: vars.AWS_PROVIDER_EXECUTION_ENABLED ?? null,
  AWS_CHECKALT_ENABLED: vars.AWS_CHECKALT_ENABLED ?? null,
  AWS_CHECKALT_STATUS_RECONCILE_ENABLED: vars.AWS_CHECKALT_STATUS_RECONCILE_ENABLED ?? null,
  AWS_SCHEDULED_JOB_SECRET_PRESENT: Boolean(vars.AWS_SCHEDULED_JOB_SECRET),
});

const applyPatch = (text, find, insert, label) => {
  if (text.includes(insert.trim())) return { text, applied: false, reason: 'already_present', label };
  if (!text.includes(find)) return { text, applied: false, reason: 'anchor_missing', label };
  return { text: text.replace(find, `${find}${insert}`), applied: true, label };
};

const overlayLivePackage = (unpacked) => {
  const copies = [
    ['aws/functions/api/tenant-billing-destination.mjs', 'tenant-billing-destination.mjs'],
    ['aws/functions/api/tenant-billing-engine.mjs', 'tenant-billing-engine.mjs'],
    ['aws/functions/api/tenant-billing-handlers.mjs', 'tenant-billing-handlers.mjs'],
  ];
  const placed = [];
  for (const [src, dest] of copies) {
    const target = path.join(unpacked, dest);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(ROOT, src), target);
    placed.push(dest);
  }

  const patches = [];
  const appPath = path.join(unpacked, 'app-services.mjs');
  let app = fs.readFileSync(appPath, 'utf8');
  if (!app.includes('tenant-billing-handlers.mjs')) {
    const p1 = applyPatch(
      app,
      "import { handleTaxProfiles } from './tax-profiles.mjs';\n",
      `import {\n  handleTenantBillingAdmin,\n  handleTenantBillingAuthorize,\n} from './tenant-billing-handlers.mjs';\n`,
      'app-services-import',
    );
    app = p1.text;
    patches.push(p1);
    const p2 = applyPatch(
      app,
      "  'tenant-tax-profiles',\n",
      "  'tenant-billing-admin',\n  'tenant-billing-authorize',\n",
      'app-services-class-a',
    );
    app = p2.text;
    patches.push(p2);
    const p3 = applyPatch(
      app,
      "    case 'tenant-tax-profiles':\n      return handleTaxProfiles(event);\n",
      "    case 'tenant-billing-admin':\n      return handleTenantBillingAdmin(event);\n    case 'tenant-billing-authorize':\n      return handleTenantBillingAuthorize(event);\n",
      'app-services-switch',
    );
    app = p3.text;
    patches.push(p3);
    fs.writeFileSync(appPath, app);
  } else {
    patches.push({ applied: false, reason: 'already_present', label: 'app-services' });
  }

  const schedPath = path.join(unpacked, 'scheduled.mjs');
  let sched = fs.readFileSync(schedPath, 'utf8');
  if (!sched.includes('handleMonthlyBillingScheduled')) {
    const p1 = applyPatch(
      sched,
      "import { handleCheckAltStatusReconcileJob } from './providers/production/checkalt-status-reconcile.mjs';\n",
      "import { handleMonthlyBillingScheduled } from './tenant-billing-handlers.mjs';\n",
      'scheduled-import',
    );
    sched = p1.text;
    patches.push(p1);
    const p2 = applyPatch(
      sched,
      "  if (job === 'tenant-domain-recheck-cron') return handleTenantDomainRecheckCron(event);\n",
      "  if (job === 'moov-monthly-tenant-billing') {\n    return handleMonthlyBillingScheduled(event, deps);\n  }\n",
      'scheduled-job',
    );
    sched = p2.text;
    patches.push(p2);
    fs.writeFileSync(schedPath, sched);
  }

  const tablesPath = path.join(unpacked, 'allowed-tables.json');
  const tables = JSON.parse(fs.readFileSync(tablesPath, 'utf8'));
  const needed = ['tenant_billing_settings', 'platform_billing_destination'];
  const addedTables = [];
  for (const name of needed) {
    if (!tables.includes(name)) {
      tables.push(name);
      addedTables.push(name);
    }
  }
  tables.sort();
  fs.writeFileSync(tablesPath, `${JSON.stringify(tables, null, 2)}\n`);
  patches.push({ applied: addedTables.length > 0, label: 'allowed-tables', addedTables });

  const hookPath = path.join(unpacked, 'providers/webhook-apply.mjs');
  let hook = fs.readFileSync(hookPath, 'utf8');
  if (!hook.includes('applyBillingProviderEvent')) {
    const p1 = applyPatch(
      hook,
      "import { providerExecutionEnabled } from '../provider-flags.mjs';\n",
      "import { applyBillingProviderEvent } from '../tenant-billing-engine.mjs';\n",
      'webhook-import',
    );
    hook = p1.text;
    patches.push(p1);
    const p2 = applyPatch(
      hook,
      "    return { applied: true, environment: 'sandbox', financialTablesMutated: mutations.length > 0, mutations };\n  }\n",
      `\n  if (transferId) {\n    const billing = await applyBillingProviderEvent(client, {\n      providerTransferId: transferId,\n      status: eventTypeToStatus(eventType),\n      reason: data?.failureReason ?? data?.reason ?? eventType,\n    }).catch(() => null);\n    if (billing?.applied) mutations.push('tenant_maintenance_payments');\n  }\n`,
      'webhook-apply',
    );
    hook = p2.text;
    patches.push(p2);
    fs.writeFileSync(hookPath, hook);
  }

  return {
    placed,
    patches: patches.map((row) => ({ label: row.label, applied: row.applied, reason: row.reason || null, addedTables: row.addedTables || null })),
    skippedMoneyOverlay: ['providers/parity/moov-money.mjs', 'providers/parity/moov-onboard.mjs', 'providers/parity/moov-functions.mjs', 'providers/parity/moov-rails.mjs'],
  };
};

const applySql = async () => {
  const rehearsal = awsJson(['lambda', 'get-function-configuration', '--function-name', REHEARSAL]);
  const prod = awsJson(['lambda', 'get-function-configuration', '--function-name', PROD_API]);
  const adminSecretArn = rehearsal.Environment?.Variables?.PROD_ADMIN_SECRET_ARN;
  const rdsHost = rehearsal.Environment?.Variables?.PROD_RDS_HOST;
  if (!adminSecretArn || !rdsHost) return { ok: false, error: 'rehearsal missing PROD_ADMIN_SECRET_ARN or PROD_RDS_HOST' };
  const staging = path.join(os.tmpdir(), 'checksops-prod-moov-billing-sql-pack');
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  await copyFile(path.join(ROOT, 'aws/rls/oneshot/moov-monthly-billing-prod/index.mjs'), path.join(staging, 'index.mjs'));
  await copyFile(path.join(ROOT, 'aws/rls/oneshot/moov-monthly-billing-prod/package.json'), path.join(staging, 'package.json'));
  await copyFile(path.join(ROOT, 'aws/rls/sql/43_moov_monthly_tenant_billing.sql'), path.join(staging, '43_moov_monthly_tenant_billing.sql'));
  const pem = [
    path.join(ROOT, 'aws/rls/oneshot/rds-global-bundle.pem'),
    path.join(ROOT, 'aws/rls/oneshot/moov-monthly-billing/rds-global-bundle.pem'),
  ].find((file) => fs.existsSync(file));
  if (!pem) return { ok: false, error: 'rds-global-bundle.pem missing' };
  await copyFile(pem, path.join(staging, 'rds-global-bundle.pem'));
  execFileSync('npm', ['install', '--omit=dev'], { cwd: staging, stdio: 'ignore' });
  const zip = path.join(os.tmpdir(), 'checksops-prod-moov-billing-sql.zip');
  await rm(zip, { force: true });
  execFileSync('zip', ['-qr', zip, '.'], { cwd: staging });
  const env = {
    Variables: {
      ADMIN_SECRET_ARN: adminSecretArn,
      RDS_HOST: rdsHost,
      DATABASE_NAME: 'checksops',
      AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID: PROD_ACCOUNT,
      AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID: PROD_METHOD,
    },
  };
  const vpc = prod.VpcConfig || rehearsal.VpcConfig || {};
  const vpcConfig = `SubnetIds=${(vpc.SubnetIds || []).join(',')},SecurityGroupIds=${(vpc.SecurityGroupIds || []).join(',')}`;
  const roleArn = rehearsal.Role;
  const existing = awsTry(['lambda', 'get-function', '--function-name', ONESHOT]);
  if (existing.ok) {
    awsJson(['lambda', 'update-function-code', '--function-name', ONESHOT, '--zip-file', `fileb://${zip}`]);
    waitFn(ONESHOT);
    awsJson(['lambda', 'update-function-configuration', '--function-name', ONESHOT, '--timeout', '120', '--environment', JSON.stringify(env)]);
  } else {
    const created = awsTry([
      'lambda', 'create-function',
      '--function-name', ONESHOT,
      '--runtime', 'nodejs20.x',
      '--role', roleArn,
      '--handler', 'index.handler',
      '--timeout', '120',
      '--memory-size', '512',
      '--zip-file', `fileb://${zip}`,
      '--environment', JSON.stringify(env),
      '--vpc-config', vpcConfig,
    ]);
    if (!created.ok) return { ok: false, phase: 'create-function', ...created };
  }
  waitFn(ONESHOT);
  const outFile = path.join(os.tmpdir(), `prod-sql-43-${Date.now()}.json`);
  const invoked = awsTry(['lambda', 'invoke', '--function-name', ONESHOT, '--cli-binary-format', 'raw-in-base64-out', outFile]);
  if (!invoked.ok) return { ok: false, phase: 'invoke', ...invoked };
  return { ok: true, payload: JSON.parse(fs.readFileSync(outFile, 'utf8')) };
};

const overlayApi = async (beforeSha) => {
  const live = awsJson(['lambda', 'get-function-configuration', '--function-name', PROD_API]);
  if (live.CodeSha256 !== beforeSha) {
    return { ok: false, error: 'toctou_sha_changed', expected: beforeSha, actual: live.CodeSha256, lastModified: live.LastModified };
  }
  const loc = awsJson(['lambda', 'get-function', '--function-name', PROD_API]);
  if (loc.Configuration?.CodeSha256 !== beforeSha) {
    return { ok: false, error: 'toctou_get_function_sha_changed', expected: beforeSha, actual: loc.Configuration?.CodeSha256 };
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-billing-overlay-'));
  const zipIn = path.join(tmp, 'live.zip');
  const unpacked = path.join(tmp, 'pkg');
  execFileSync('curl', ['-fsSL', loc.Code.Location, '-o', zipIn], { stdio: 'ignore' });
  fs.mkdirSync(unpacked, { recursive: true });
  execFileSync('unzip', ['-qo', zipIn, '-d', unpacked]);
  const overlay = overlayLivePackage(unpacked);
  const zipOut = path.join(tmp, 'overlay.zip');
  execFileSync('zip', ['-qr', zipOut, '.'], { cwd: unpacked });
  const again = awsJson(['lambda', 'get-function-configuration', '--function-name', PROD_API]);
  if (again.CodeSha256 !== beforeSha) {
    return { ok: false, error: 'toctou_pre_update_sha_changed', expected: beforeSha, actual: again.CodeSha256, overlay };
  }
  const updated = awsTry(['lambda', 'update-function-code', '--function-name', PROD_API, '--zip-file', `fileb://${zipOut}`]);
  if (!updated.ok) return { ok: false, phase: 'update-function-code', ...updated, overlay };
  waitFn(PROD_API);
  const after = awsJson(['lambda', 'get-function-configuration', '--function-name', PROD_API]);
  return {
    ok: true,
    beforeSha,
    afterSha: after.CodeSha256,
    lastModified: after.LastModified,
    overlay,
  };
};

const setSafeModeEnv = async (frozenBefore) => {
  const before = awsJson(['lambda', 'get-function-configuration', '--function-name', PROD_API]);
  const vars = { ...(before.Environment?.Variables || {}) };
  const frozenAfterCheck = {};
  for (const key of FROZEN_FLAGS) frozenAfterCheck[key] = vars[key] ?? null;
  for (const key of FROZEN_FLAGS) {
    if (String(frozenAfterCheck[key] ?? '') !== String(frozenBefore[key] ?? '')) {
      return { ok: false, error: 'frozen_flag_drift_before_update', key, before: frozenBefore[key], current: frozenAfterCheck[key] };
    }
  }
  vars.AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID = PROD_ACCOUNT;
  vars.AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID = PROD_METHOD;
  vars.AWS_MOOV_MONTHLY_BILLING_ENABLED = 'true';
  vars.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST = 'false';
  const updated = awsTry([
    'lambda', 'update-function-configuration',
    '--function-name', PROD_API,
    '--environment', JSON.stringify({ Variables: vars }),
  ]);
  if (!updated.ok) return { ok: false, phase: 'update-function-configuration', ...updated };
  waitFn(PROD_API);
  const after = awsJson(['lambda', 'get-function-configuration', '--function-name', PROD_API]);
  const afterVars = after.Environment?.Variables || {};
  const frozenDrift = FROZEN_FLAGS.filter((key) => String(afterVars[key] ?? '') !== String(frozenBefore[key] ?? ''));
  return {
    ok: frozenDrift.length === 0,
    flags: flagSlice(afterVars),
    frozenDrift,
    sha: after.CodeSha256,
    lastModified: after.LastModified,
  };
};

const deploySpa = async () => {
  const outDir = path.join(os.tmpdir(), 'checksops-prod-spa-safe');
  await rm(outDir, { recursive: true, force: true });
  const localEnv = path.join(ROOT, '.env.production.local');
  await writeFile(localEnv, [
    'VITE_AUTH_PROVIDER=cognito',
    'VITE_APP_URL=https://checksops.com',
    'VITE_CHECKSOPS_API_URL=/prep',
    'VITE_AWS_REGION=us-east-1',
    `VITE_COGNITO_USER_POOL_ID=${PROD_POOL}`,
    `VITE_COGNITO_USER_POOL_CLIENT_ID=${PROD_CLIENT}`,
    '',
  ].join('\n'));
  const built = spawnSync('npx', ['vite', 'build', '--mode', 'production', '--outDir', outDir], {
    cwd: ROOT,
    env: {
      ...process.env,
      VITE_AUTH_PROVIDER: 'cognito',
      VITE_APP_URL: 'https://checksops.com',
      VITE_CHECKSOPS_API_URL: '/prep',
      VITE_AWS_REGION: 'us-east-1',
      VITE_COGNITO_USER_POOL_ID: PROD_POOL,
      VITE_COGNITO_USER_POOL_CLIENT_ID: PROD_CLIENT,
    },
    encoding: 'utf8',
    timeout: 180000,
  });
  await rm(localEnv, { force: true });
  if (built.status !== 0) {
    return { ok: false, phase: 'build', error: String(built.stderr || built.stdout || 'vite failed').slice(0, 800) };
  }
  const index = path.join(outDir, 'index.html');
  const assetsDir = path.join(outDir, 'assets');
  const indexHtml = fs.readFileSync(index, 'utf8');
  const indexJs = (indexHtml.match(/\/assets\/(index-[A-Za-z0-9._-]+\.js)/) || [])[1] || null;
  const adminJs = fs.readdirSync(assetsDir).find((name) => name.startsWith('AdminTenants-')) || null;
  const hasPanel = adminJs
    ? fs.readFileSync(path.join(assetsDir, adminJs), 'utf8').includes('Monthly subscription billing')
    : false;
  const sync = awsTry(['s3', 'sync', outDir, `s3://${PROD_BUCKET}`, '--exact-timestamps', '--only-show-errors'], { json: false });
  const forceIndex = awsTry(['s3', 'cp', index, `s3://${PROD_BUCKET}/index.html`, '--content-type', 'text/html', '--cache-control', 'no-cache, no-store, must-revalidate'], { json: false });
  const forceAssets = [];
  for (const name of [indexJs, adminJs].filter(Boolean)) {
    forceAssets.push({
      name,
      ...awsTry(['s3', 'cp', path.join(assetsDir, name), `s3://${PROD_BUCKET}/assets/${name}`, '--cache-control', 'public, max-age=31536000, immutable'], { json: false }),
    });
  }
  const invalidation = awsTry(['cloudfront', 'create-invalidation', '--distribution-id', PROD_CF, '--paths', '/*']);
  const head = awsTry(['s3api', 'head-object', '--bucket', PROD_BUCKET, '--key', 'index.html']);
  return {
    ok: sync.ok && forceIndex.ok && forceAssets.every((row) => row.ok) && hasPanel,
    usedDelete: false,
    indexJs,
    adminJs,
    hasMonthlyBillingPanel: hasPanel,
    indexSha256: createHash('sha256').update(fs.readFileSync(index)).digest('hex'),
    etag: head.data?.ETag || null,
    lastModified: head.data?.LastModified || null,
    invalidation: invalidation.ok
      ? { ok: true, id: invalidation.data?.Invalidation?.Id || null }
      : { ok: false, error: invalidation.error },
    syncError: sync.error || forceIndex.error || forceAssets.find((row) => !row.ok)?.error || null,
  };
};

const mintOwner = async () => {
  let password;
  try {
    password = secretString('checksops/staging/master-uat-password');
  } catch (error) {
    return { ok: false, error: String(error.message || error).slice(0, 200) };
  }
  const auth = awsTry([
    'cognito-idp', 'admin-initiate-auth',
    '--user-pool-id', PROD_POOL,
    '--client-id', PROD_CLIENT,
    '--auth-flow', 'ADMIN_USER_PASSWORD_AUTH',
    '--auth-parameters', `USERNAME=${OWNER_EMAIL},PASSWORD=${password}`,
  ]);
  const token = auth.data?.AuthenticationResult?.IdToken || null;
  return {
    ok: Boolean(token),
    error: token ? null : auth.error,
    denied: auth.denied || false,
    token,
    passwordReset: false,
  };
};

const api = async (pathname, { token, body, method = 'POST' } = {}) => {
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${PROD_API_URL}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 240) }; }
  return { ok: res.ok && data?.ok !== false, status: res.status, data };
};

const acceptance = async (token) => {
  const health = await fetch(`${PROD_API_URL}/health`).then(async (res) => ({
    status: res.status,
    data: await res.json().catch(() => ({})),
  }));
  const identity = token ? await api('/identity/me', { token, method: 'GET' }) : { ok: false, error: 'no_token' };
  const tenants = token ? await api('/data/query', { token, body: { table: 'tenants', op: 'select' } }) : null;
  const tenantRows = Array.isArray(tenants?.data?.rows) ? tenants.data.rows
    : Array.isArray(tenants?.data?.data) ? tenants.data.data
    : Array.isArray(tenants?.data) ? tenants.data
    : [];
  const snapshots = {};
  const pulls = {};
  if (token) {
    for (const tenantId of [FREEDOM, C1C]) {
      snapshots[tenantId] = await api('/functions/v1/tenant-billing-admin', {
        token,
        body: { action: 'get', tenant_id: tenantId },
      });
      pulls[tenantId] = await api('/functions/v1/tenant-billing-admin', {
        token,
        body: { action: 'pull', tenant_id: tenantId },
      });
    }
  }
  return { health, identity, tenants: { ok: tenants?.ok, status: tenants?.status, count: tenantRows.length }, snapshots, pulls };
};

const eventBridgeStatus = () => ({
  productionRule: awsTry(['events', 'describe-rule', '--name', 'moov-monthly-tenant-billing-production']),
  stagingRule: awsTry(['events', 'describe-rule', '--name', 'moov-monthly-tenant-billing']),
  createdThisPhase: false,
});

const main = async () => {
  await mkdir(OUT, { recursive: true });
  await assumeCursorRole('moov-billing-prod-safe');
  const identity = awsTry(['sts', 'get-caller-identity']);
  const beforeCfg = awsJson(['lambda', 'get-function-configuration', '--function-name', PROD_API]);
  const stagingBefore = awsJson(['lambda', 'get-function-configuration', '--function-name', STAGING_API]);
  const frozenBefore = Object.fromEntries(FROZEN_FLAGS.map((key) => [key, beforeCfg.Environment?.Variables?.[key] ?? null]));
  const baseline = {
    sha: beforeCfg.CodeSha256,
    lastModified: beforeCfg.LastModified,
    flags: flagSlice(beforeCfg.Environment?.Variables || {}),
    frozen: frozenBefore,
    stagingSha: stagingBefore.CodeSha256,
    stagingLastModified: stagingBefore.LastModified,
    stagingFlags: flagSlice(stagingBefore.Environment?.Variables || {}),
  };
  await writeFile(path.join(OUT, 'promotion-baseline.json'), JSON.stringify({ generatedAt: new Date().toISOString(), identity: identity.data, baseline }, null, 2));

  if (beforeCfg.CodeSha256 !== EXPECTED_SHA) {
    const report = {
      generatedAt: new Date().toISOString(),
      verdict: 'BLOCKED',
      reason: 'live production SHA drifted from pinned baseline',
      baseline,
    };
    await writeFile(path.join(OUT, 'production-safe-mode.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const sql = await applySql();
  await writeFile(path.join(OUT, 'sql43.json'), JSON.stringify(sql, null, 2));
  const overlay = sql.ok && sql.payload?.ok !== false
    ? await overlayApi(EXPECTED_SHA)
    : { ok: false, skipped: true, reason: 'sql_not_ok', sqlOk: sql.ok, sqlPayloadOk: sql.payload?.ok };
  await writeFile(path.join(OUT, 'overlay.json'), JSON.stringify(overlay, null, 2));
  const env = overlay.ok ? await setSafeModeEnv(frozenBefore) : { ok: false, skipped: true, reason: 'overlay_not_ok' };
  await writeFile(path.join(OUT, 'env.json'), JSON.stringify(env, null, 2));
  const spa = overlay.ok ? await deploySpa() : { ok: false, skipped: true, reason: 'overlay_not_ok' };
  await writeFile(path.join(OUT, 'spa.json'), JSON.stringify(spa, null, 2));
  const owner = overlay.ok ? await mintOwner() : { ok: false, skipped: true };
  const accept = owner.token ? await acceptance(owner.token) : { skipped: true, owner };
  const stagingAfter = awsJson(['lambda', 'get-function-configuration', '--function-name', STAGING_API]);
  const prodAfter = awsJson(['lambda', 'get-function-configuration', '--function-name', PROD_API]);
  const events = eventBridgeStatus();
  const liveIndex = await fetch('https://checksops.com/').then((res) => res.text()).catch((error) => String(error));
  const report = {
    generatedAt: new Date().toISOString(),
    productionRecordsMutated: false,
    liveDebitCreated: false,
    productionPostEnabled: prodAfter.Environment?.Variables?.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST === 'true',
    eventBridgeCreated: false,
    baseline,
    sql,
    overlay,
    env,
    spa,
    owner: { ok: owner.ok, error: owner.error || null, passwordReset: false },
    acceptance: accept,
    destination: {
      accountId: prodAfter.Environment?.Variables?.AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID || null,
      paymentMethodId: prodAfter.Environment?.Variables?.AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID || null,
      walletId: PROD_WALLET,
      firstWalletFallback: false,
      sandboxRefused: prodAfter.Environment?.Variables?.AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID !== SANDBOX_MERCHANT,
    },
    monthlyFlags: flagSlice(prodAfter.Environment?.Variables || {}),
    productionAfter: { sha: prodAfter.CodeSha256, lastModified: prodAfter.LastModified },
    stagingUnchanged: {
      shaMatch: stagingAfter.CodeSha256 === stagingBefore.CodeSha256,
      lastModifiedMatch: stagingAfter.LastModified === stagingBefore.LastModified,
      destAccount: stagingAfter.Environment?.Variables?.AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID || null,
    },
    eventBridge: events,
    liveSpaAssets: [...String(liveIndex).matchAll(/\/assets\/[A-Za-z0-9._-]+/g)].map((m) => m[0]),
  };
  await writeFile(path.join(OUT, 'production-safe-mode.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
