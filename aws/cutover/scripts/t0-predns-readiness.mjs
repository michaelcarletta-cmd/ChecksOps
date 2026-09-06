#!/usr/bin/env node
/**
 * Final pre-DNS GO/NO-GO checklist. Read-only. Does not change Cloudflare or Route53.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NINTH_ID } from '../../identity/expected-mappings.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const DB_BRIDGE = 'https://nbcqwpysqgyxrrbgtmkw.supabase.co/functions/v1/aws-staging-db-bridge';
const STORAGE_BRIDGE = 'https://nbcqwpysqgyxrrbgtmkw.supabase.co/functions/v1/aws-staging-storage-bridge';
const ANON = process.env.SUPABASE_ANON_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5iY3F3cHlzcWd5eHJyYmd0bWt3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcxNDQ2NTgsImV4cCI6MjA5MjcyMDY1OH0.9GNh6OK6l6vSIBgkDY-bJuqNtfHJsLNW-dc7jfRUwgw';
const STAGING_API = 'https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging';
const PREP_API = 'https://kiqojucc02.execute-api.us-east-1.amazonaws.com/prep';
const LOVABLE_IP = '185.158.133.1';
const ACM_ARN = 'arn:aws:acm:us-east-1:806168576068:certificate/5cdde8e7-49fb-4b42-ba36-9aaa9d9b1aa3';
const PROD_CF = 'E1B0ZWWO5559U5';
const CF_DOMAIN = 'dmgs35lzv89ms.cloudfront.net';
const PROD_POOL = 'us-east-1_h00WorYMT';

if (process.argv.some((a) => ['--dns', '--apply', '--cutover', '--freeze'].includes(a))) {
  console.error(JSON.stringify({ error: 'refusing_dns_or_activation_from_predns_check' }));
  process.exit(2);
}

const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' });
const awsJson = (args) => JSON.parse(run(AWS, ['--region', REGION, '--output', 'json', ...args]) || '{}');
const flagOff = (vars, key) => String(vars[key] || 'false').toLowerCase() === 'false';

const fetchTimeout = async (url, options = {}, ms = 25000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
};

const token = JSON.parse(run(AWS, [
  'secretsmanager', 'get-secret-value',
  '--secret-id', 'checksops/staging/storage-migration-token',
  '--query', 'SecretString', '--output', 'text',
])).token;

const bridge = async (url, body) => {
  const response = await fetchTimeout(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: ANON,
      authorization: `Bearer ${ANON}`,
      'x-checksops-migration-token': token,
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};

const jsonGet = async (url) => {
  const response = await fetchTimeout(url);
  return { status: response.status, json: await response.json().catch(() => ({})) };
};

const db = await bridge(DB_BRIDGE, { action: 'health' });
const storage = await bridge(STORAGE_BRIDGE, { action: 'health' });
const staging = await jsonGet(`${STAGING_API}/health`);
const stagingDb = await jsonGet(`${STAGING_API}/db-health`);
const prep = await jsonGet(`${PREP_API}/health`);
const stagingFlags = (awsJson(['lambda', 'get-function-configuration', '--function-name', 'checksops-staging-api']).Environment || {}).Variables || {};
const prepFlags = (awsJson(['lambda', 'get-function-configuration', '--function-name', 'checksops-production-prep-api']).Environment || {}).Variables || {};
const apex = run('dig', ['+short', 'A', 'checksops.com']).trim().split('\n').filter(Boolean);
const www = run('dig', ['+short', 'A', 'www.checksops.com']).trim().split('\n').filter(Boolean);
const acm = awsJson(['acm', 'describe-certificate', '--certificate-arn', ACM_ARN]).Certificate || {};
const cf = awsJson(['cloudfront', 'get-distribution', '--id', PROD_CF]).Distribution || {};
const cfg = cf.DistributionConfig || {};
const aliases = cfg.Aliases?.Items || [];
const users = awsJson(['cognito-idp', 'list-users', '--user-pool-id', PROD_POOL, '--limit', '60']);
const userCount = (users.Users || []).length;
const sql64 = readFileSync(path.join(ROOT, 'aws/financial/sql/64_financial_activation_grants.sql'), 'utf8');
const delta = (() => {
  try { return JSON.parse(readFileSync('/tmp/t0/final-source-delta.json', 'utf8')); }
  catch { return null; }
})();
const storageCopy = (() => {
  try { return JSON.parse(readFileSync(path.join(ROOT, 'aws/db-copy/rehearsal/analysis/storage_copy_reconcile.json'), 'utf8')); }
  catch { return null; }
})();
const smoke = (() => {
  try { return JSON.parse(readFileSync('/tmp/t0/app-smoke-predns.json', 'utf8')); }
  catch { return null; }
})();

const checks = {
  dbReconPass: delta?.ok === true && (delta?.after?.countDiffs || []).length === 0,
  storageReconPass: storageCopy?.result === 'PASS',
  cloudfrontDeployed: cf.Status === 'Deployed' && cfg.Enabled === true,
  aliasesConfigured: aliases.includes('checksops.com') && aliases.includes('www.checksops.com'),
  acmAttachedValid: cfg.ViewerCertificate?.ACMCertificateArn === ACM_ARN
    && acm.Status === 'ISSUED'
    && (acm.InUseBy || []).some((arn) => String(arn).includes(PROD_CF)),
  identityEightIntact: userCount === 8,
  moovOff: flagOff(stagingFlags, 'AWS_MOOV_ENABLED') && flagOff(prepFlags, 'AWS_MOOV_ENABLED'),
  checkaltOff: flagOff(stagingFlags, 'AWS_CHECKALT_ENABLED') && flagOff(prepFlags, 'AWS_CHECKALT_ENABLED'),
  providerExecutionOff: flagOff(stagingFlags, 'AWS_PROVIDER_EXECUTION_ENABLED')
    && flagOff(prepFlags, 'AWS_PROVIDER_EXECUTION_ENABLED'),
  financialExecutionOff: flagOff(stagingFlags, 'AWS_FINANCIAL_PERMISSIONS_ACTIVATED')
    && flagOff(prepFlags, 'AWS_FINANCIAL_PERMISSIONS_ACTIVATED'),
  financialGrantsNotApplied: /NOT_APPLIED/.test(sql64),
  bridgesAvailable: db.status === 200 && db.json.mode === 'read_only' && db.json.writes === false
    && storage.status === 200 && storage.json.mode === 'sign_only',
  lovableRollbackDocumented: apex.includes(LOVABLE_IP) && www.includes(LOVABLE_IP),
  dnsUnchanged: apex.includes(LOVABLE_IP) && www.includes(LOVABLE_IP)
    && !apex.some((ip) => /cloudfront/i.test(ip)),
  identityNotOverlaid: delta?.identityAccountsOverlaid !== true,
  smokePass: smoke?.ok === true,
  awsHealthy: staging.status === 200 && stagingDb.json.currentDatabase === 'checksops' && prep.status === 200,
};

const go = Object.values(checks).every(Boolean);
const report = {
  generatedAt: new Date().toISOString(),
  finalDnsCutoverReadiness: go ? 'GO' : 'NO-GO',
  dnsChanged: false,
  route53Touched: false,
  cloudflareTouched: false,
  ninthUuid: NINTH_ID,
  checks,
  evidence: {
    dbDelta: delta ? {
      ok: delta.ok,
      sourceChanged: delta.sourceChanged,
      overlayApplied: delta.overlayApplied,
      identityAccountsOverlaid: delta.identityAccountsOverlaid,
      after: delta.after,
    } : null,
    storage: storageCopy ? {
      result: storageCopy.result,
      approved: storageCopy.productionInventory?.approvedObjects ?? null,
      migrated: storageCopy.reconciliation?.migratedProductionObjects ?? null,
      missing: storageCopy.reconciliation?.missingProductionObjects ?? null,
      conflicts: storageCopy.reconciliation?.mismatchedObjects ?? null,
    } : null,
    smoke: smoke ? { ok: smoke.ok, write: smoke.nonFinancialWrite?.ok ?? null } : null,
    cloudfront: {
      id: PROD_CF,
      domain: cf.DomainName || CF_DOMAIN,
      status: cf.Status,
      aliases,
      certificate: cfg.ViewerCertificate?.ACMCertificateArn || null,
    },
    acm: { status: acm.Status, inUseByCount: (acm.InUseBy || []).length },
    cognitoUsers: userCount,
    dns: { apex, www, rollbackTarget: LOVABLE_IP },
    bridges: {
      db: { http: db.status, mode: db.json.mode, writes: db.json.writes },
      storage: { http: storage.status, mode: storage.json.mode },
    },
    flags: {
      staging: {
        AWS_PROVIDER_EXECUTION_ENABLED: stagingFlags.AWS_PROVIDER_EXECUTION_ENABLED,
        AWS_MOOV_ENABLED: stagingFlags.AWS_MOOV_ENABLED,
        AWS_CHECKALT_ENABLED: stagingFlags.AWS_CHECKALT_ENABLED,
        AWS_FINANCIAL_PERMISSIONS_ACTIVATED: stagingFlags.AWS_FINANCIAL_PERMISSIONS_ACTIVATED,
      },
      prep: {
        AWS_PROVIDER_EXECUTION_ENABLED: prepFlags.AWS_PROVIDER_EXECUTION_ENABLED,
        AWS_MOOV_ENABLED: prepFlags.AWS_MOOV_ENABLED,
        AWS_CHECKALT_ENABLED: prepFlags.AWS_CHECKALT_ENABLED,
        AWS_FINANCIAL_PERMISSIONS_ACTIVATED: prepFlags.AWS_FINANCIAL_PERMISSIONS_ACTIVATED,
      },
    },
  },
  cloudflareRecordsForReview: [
    {
      type: 'CNAME',
      name: '@',
      fqdn: 'checksops.com',
      current: LOVABLE_IP,
      target: CF_DOMAIN,
      proxy: 'DNS only (grey cloud) for the initial cutover',
    },
    {
      type: 'CNAME',
      name: 'www',
      fqdn: 'www.checksops.com',
      current: LOVABLE_IP,
      target: CF_DOMAIN,
      proxy: 'DNS only (grey cloud) for the initial cutover',
    },
  ],
  stopForReview: true,
};
console.log(JSON.stringify(report, null, 2));
process.exit(go ? 0 : 1);
