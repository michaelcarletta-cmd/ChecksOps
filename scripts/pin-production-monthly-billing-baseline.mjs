#!/usr/bin/env node
/**
 * Read-only production baseline pin for monthly billing safe-mode promotion.
 * Does not UpdateFunctionCode, apply SQL, set env vars, or create EventBridge.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assumeCursorRole } from './cognito-staging-token.mjs';

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const OUT = '/opt/cursor/artifacts/moov-monthly-billing-prod-safe';
const PROD_API = 'checksops-production-prep-api';
const STAGING_API = 'checksops-staging-api';
const PROD_BUCKET = 'checksops-production-frontend-806168576068';
const STAGING_BUCKET = 'checksops-staging-frontend-c48b';
const PROD_CF = 'E1B0ZWWO5559U5';
const KEEP = [
  'CHECKSOPS_ENV',
  'AWS_MOOV_MONTHLY_BILLING_ENABLED',
  'AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST',
  'AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID',
  'AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID',
  'AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED',
  'AWS_MOOV_MONTHLY_BILLING_SIMULATE',
  'AWS_MOOV_ENABLED',
  'AWS_PROVIDER_EXECUTION_ENABLED',
  'AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED',
  'DATABASE_NAME',
  'RDS_HOST',
  'ADMIN_SECRET_ARN',
  'PROVIDER_SECRETS_ARN',
  'CHECKALT_ENABLED',
  'AWS_CHECKALT_ENABLED',
  'CHECKALT_PRODUCTION_ENABLED',
  'AWS_CHECKALT_PRODUCTION_WRITER',
  'VPC_ENABLED',
];

const awsTry = (args, { json = true } = {}) => {
  try {
    const out = execFileSync(AWS, ['--region', REGION, ...(json ? ['--output', 'json'] : []), ...args], {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });
    if (!json) return { ok: true, data: { raw: String(out).trim().slice(0, 400) } };
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

const flagSlice = (vars = {}) => {
  const out = {};
  for (const key of KEEP) {
    if (key === 'ADMIN_SECRET_ARN' || key === 'PROVIDER_SECRETS_ARN') {
      out[key] = vars[key] ? String(vars[key]).replace(/:[^:]+$/, ':***') : null;
      continue;
    }
    out[key] = vars[key] === undefined ? null : vars[key];
  }
  out.AWS_SCHEDULED_JOB_SECRET_PRESENT = Boolean(vars.AWS_SCHEDULED_JOB_SECRET);
  out.envKeyCount = Object.keys(vars).length;
  out.envKeys = Object.keys(vars).sort();
  return out;
};

const httpGet = async (url) => {
  try {
    const res = await fetch(url, { redirect: 'follow' });
    const text = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      url: res.url,
      contentType: res.headers.get('content-type'),
      sha256: createHash('sha256').update(text).digest('hex'),
      snippet: text.slice(0, 400),
      assets: [...text.matchAll(/\/assets\/[A-Za-z0-9._-]+/g)].map((m) => m[0]),
    };
  } catch (error) {
    return { ok: false, error: String(error.message || error).slice(0, 240) };
  }
};

const main = async () => {
  await mkdir(OUT, { recursive: true });
  await assumeCursorRole('moov-billing-prod-baseline');
  const identity = awsTry(['sts', 'get-caller-identity']);

  const prodCfg = awsTry(['lambda', 'get-function-configuration', '--function-name', PROD_API]);
  const prodFn = awsTry(['lambda', 'get-function', '--function-name', PROD_API]);
  const stagingCfg = awsTry(['lambda', 'get-function-configuration', '--function-name', STAGING_API]);
  const rehearsal = awsTry(['lambda', 'get-function-configuration', '--function-name', 'checksops-staging-rehearsal-oneshot']);

  const prodVars = prodCfg.data?.Environment?.Variables || {};
  const stagingVars = stagingCfg.data?.Environment?.Variables || {};

  const lambdas = awsTry(['lambda', 'list-functions', '--max-items', '200']);
  const lambdaNames = (lambdas.data?.Functions || []).map((fn) => fn.FunctionName).sort();
  const relevantLambdas = lambdaNames.filter((name) => (
    /production|oneshot|billing|moov-ga|rls|prep-api|staging-api/i.test(name)
  ));

  const secrets = awsTry([
    'secretsmanager', 'list-secrets',
    '--filters', 'Key=name,Values=rds-db-credentials,checksops',
    '--max-results', '20',
  ]);
  const secretNames = (secrets.data?.SecretList || []).map((row) => row.Name);

  const spaHead = awsTry(['s3api', 'head-object', '--bucket', PROD_BUCKET, '--key', 'index.html']);
  const spaList = awsTry(['s3api', 'list-objects-v2', '--bucket', PROD_BUCKET, '--prefix', 'assets/', '--max-keys', '40']);
  const stagingSpaHead = awsTry(['s3api', 'head-object', '--bucket', STAGING_BUCKET, '--key', 'index.html']);

  const cf = awsTry(['cloudfront', 'get-distribution', '--id', PROD_CF]);
  const cfAliases = cf.data?.Distribution?.DistributionConfig?.Aliases?.Items || [];
  const cfDomain = cf.data?.Distribution?.DomainName || null;
  const cfStatus = cf.data?.Distribution?.Status || null;

  const prodCognito = awsTry([
    'cognito-idp', 'list-users',
    '--user-pool-id', 'us-east-1_h00WorYMT',
    '--limit', '5',
  ]);
  const stagingOwner = awsTry([
    'cognito-idp', 'admin-get-user',
    '--user-pool-id', 'us-east-1_vPmQ7cL1F',
    '--username', 'checksopsadmin@gmail.com',
  ]);

  const eventBridge = {
    listRules: awsTry(['events', 'list-rules', '--name-prefix', 'moov-monthly']),
    describeProd: awsTry(['events', 'describe-rule', '--name', 'moov-monthly-tenant-billing-production']),
    describeStaging: awsTry(['events', 'describe-rule', '--name', 'moov-monthly-tenant-billing']),
  };

  const oneshots = {};
  for (const name of [
    'checksops-staging-moov-billing-2d41',
    'checksops-prod-moov-billing-inspect-2d41',
    'checksops-prod-moov-ga-2d41',
    'checksops-production-rls-oneshot',
    'checksops-production-sql-oneshot',
    'checksops-prod-sql-43',
  ]) {
    const cfg = awsTry(['lambda', 'get-function-configuration', '--function-name', name]);
    oneshots[name] = cfg.ok
      ? {
        ok: true,
        sha: cfg.data.CodeSha256,
        lastModified: cfg.data.LastModified,
        role: cfg.data.Role,
        vpc: Boolean(cfg.data.VpcConfig?.SubnetIds?.length),
        env: flagSlice(cfg.data.Environment?.Variables || {}),
      }
      : { ok: false, denied: cfg.denied, error: cfg.error };
  }

  let liveZip = null;
  if (prodFn.ok && prodFn.data?.Code?.Location) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-live-'));
    const zip = path.join(tmp, 'live.zip');
    try {
      execFileSync('curl', ['-fsSL', prodFn.data.Code.Location, '-o', zip], { stdio: 'ignore' });
      const listing = execFileSync('unzip', ['-l', zip], { encoding: 'utf8' });
      const files = listing.split('\n').map((line) => line.trim().split(/\s+/).pop()).filter(Boolean);
      const billingFiles = files.filter((name) => /tenant-billing|allowed-tables|app-services|scheduled|webhook-apply|moov-money|moov-onboard|moov-functions|moov-rails/.test(name));
      liveZip = {
        ok: true,
        bytes: fs.statSync(zip).size,
        sha256: createHash('sha256').update(fs.readFileSync(zip)).digest('hex'),
        billingRelated: billingFiles,
        hasTenantBillingEngine: billingFiles.includes('tenant-billing-engine.mjs'),
        hasTenantBillingHandlers: billingFiles.includes('tenant-billing-handlers.mjs'),
        hasTenantBillingDestination: billingFiles.includes('tenant-billing-destination.mjs'),
      };
    } catch (error) {
      liveZip = { ok: false, error: String(error.message || error).slice(0, 300) };
    }
  }

  const http = {
    prodHealth: await httpGet('https://kiqojucc02.execute-api.us-east-1.amazonaws.com/prep/health'),
    prodReadiness: await httpGet('https://kiqojucc02.execute-api.us-east-1.amazonaws.com/prep/ops/readiness'),
    checksops: await httpGet('https://checksops.com/'),
    www: await httpGet('https://www.checksops.com/'),
    cloudfront: await httpGet('https://dmgs35lzv89ms.cloudfront.net/'),
    stagingHealth: await httpGet('https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging/health'),
  };

  const report = {
    generatedAt: new Date().toISOString(),
    phase: 'baseline_pin_readonly',
    mutated: false,
    identity: identity.ok ? identity.data : identity,
    productionApi: prodCfg.ok
      ? {
        name: PROD_API,
        sha: prodCfg.data.CodeSha256,
        lastModified: prodCfg.data.LastModified,
        version: prodCfg.data.Version,
        role: prodCfg.data.Role,
        runtime: prodCfg.data.Runtime,
        timeout: prodCfg.data.Timeout,
        memory: prodCfg.data.MemorySize,
        vpcSubnets: prodCfg.data.VpcConfig?.SubnetIds || [],
        vpcSecurityGroups: prodCfg.data.VpcConfig?.SecurityGroupIds || [],
        state: prodCfg.data.State,
        lastUpdateStatus: prodCfg.data.LastUpdateStatus,
        flags: flagSlice(prodVars),
      }
      : prodCfg,
    stagingApi: stagingCfg.ok
      ? {
        name: STAGING_API,
        sha: stagingCfg.data.CodeSha256,
        lastModified: stagingCfg.data.LastModified,
        flags: flagSlice(stagingVars),
      }
      : stagingCfg,
    rehearsal: rehearsal.ok
      ? {
        role: rehearsal.data.Role,
        vpcSubnets: rehearsal.data.VpcConfig?.SubnetIds || [],
        flags: flagSlice(rehearsal.data.Environment?.Variables || {}),
      }
      : rehearsal,
    liveZip,
    relevantLambdas,
    secretNames,
    oneshots,
    productionSpa: {
      bucket: PROD_BUCKET,
      head: spaHead.ok
        ? { etag: spaHead.data.ETag, lastModified: spaHead.data.LastModified, size: spaHead.data.ContentLength }
        : spaHead,
      assets: (spaList.data?.Contents || []).map((row) => ({ key: row.Key, lastModified: row.LastModified, size: row.Size })),
      cloudfront: { id: PROD_CF, domain: cfDomain, status: cfStatus, aliases: cfAliases },
    },
    stagingSpa: stagingSpaHead.ok
      ? { etag: stagingSpaHead.data.ETag, lastModified: stagingSpaHead.data.LastModified, size: stagingSpaHead.data.ContentLength }
      : stagingSpaHead,
    cognito: {
      productionPoolUsers: prodCognito.ok
        ? { count: (prodCognito.data.Users || []).length, usernames: (prodCognito.data.Users || []).map((u) => u.Username) }
        : prodCognito,
      stagingOwnerExists: stagingOwner.ok,
    },
    eventBridge,
    http,
  };
  await writeFile(path.join(OUT, 'production-baseline.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
