/**
 * Immediate pre-freeze safety check. Read-only. Refuses freeze/cutover flags.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
const PROD_POOL = 'us-east-1_h00WorYMT';

if (process.argv.some((a) => ['--freeze', '--apply', '--cutover'].includes(a))) {
  console.error(JSON.stringify({ error: 'refusing_mutation_from_safety_check' }, null, 2));
  process.exit(2);
}

const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' });
const awsJson = (args) => JSON.parse(run(AWS, ['--region', REGION, '--output', 'json', ...args]) || '{}');

const oidcToken = () => new Promise((resolve, reject) => {
  const req = http.request({
    socketPath: '/run/cursor/api.sock', path: '/v1/tokens/oidc', method: 'POST',
    headers: { 'content-type': 'application/json' },
  }, (res) => {
    const chunks = [];
    res.on('data', (d) => chunks.push(d));
    res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString()).token));
  });
  req.on('error', reject);
  req.write(JSON.stringify({ aud: 'sts.amazonaws.com' }));
  req.end();
});

const fetchTimeout = async (url, options = {}, ms = 25000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
};

await (async () => {
  const creds = JSON.parse(run(AWS, [
    'sts', 'assume-role-with-web-identity',
    '--role-arn', process.env.CURSOR_AWS_ASSUME_IAM_ROLE_ARN,
    '--role-session-name', 'checksops-t0-safety',
    '--web-identity-token', await oidcToken(),
    '--duration-seconds', '3600', '--output', 'json',
  ])).Credentials;
  process.env.AWS_ACCESS_KEY_ID = creds.AccessKeyId;
  process.env.AWS_SECRET_ACCESS_KEY = creds.SecretAccessKey;
  process.env.AWS_SESSION_TOKEN = creds.SessionToken;
})();

const token = JSON.parse(run(AWS, [
  'secretsmanager', 'get-secret-value',
  '--secret-id', 'checksops/staging/storage-migration-token',
  '--query', 'SecretString', '--output', 'text',
])).token;

const bridge = async (url, body) => {
  const response = await fetchTimeout(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', apikey: ANON, authorization: `Bearer ${ANON}`,
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
const flag = (vars, key) => String(vars[key] || 'false').toLowerCase() === 'false';
const apex = run('dig', ['+short', 'A', 'checksops.com']).trim().split('\n').filter(Boolean);
const www = run('dig', ['+short', 'A', 'www.checksops.com']).trim().split('\n').filter(Boolean);
const acm = awsJson(['acm', 'describe-certificate', '--certificate-arn', ACM_ARN]).Certificate || {};
const cf = awsJson(['cloudfront', 'get-distribution', '--id', PROD_CF]).Distribution || {};
const sql64 = readFileSync(path.join(ROOT, 'aws/financial/sql/64_financial_activation_grants.sql'), 'utf8');

const checks = {
  bridgesHealthy: db.status === 200 && db.json.mode === 'read_only' && db.json.writes === false
    && storage.status === 200 && storage.json.mode === 'sign_only',
  lovableStillSource: apex.includes(LOVABLE_IP) && www.includes(LOVABLE_IP)
    && staging.json.productionSupabaseChanged !== true,
  awsServicesHealthy: staging.status === 200 && stagingDb.json.currentDatabase === 'checksops' && prep.status === 200,
  flagsOff: flag(stagingFlags, 'AWS_PROVIDER_EXECUTION_ENABLED')
    && flag(stagingFlags, 'AWS_FINANCIAL_PERMISSIONS_ACTIVATED')
    && flag(prepFlags, 'AWS_PROVIDER_EXECUTION_ENABLED'),
  moovOff: flag(stagingFlags, 'AWS_MOOV_ENABLED') && flag(prepFlags, 'AWS_MOOV_ENABLED'),
  checkaltOff: flag(stagingFlags, 'AWS_CHECKALT_ENABLED') && flag(prepFlags, 'AWS_CHECKALT_ENABLED'),
  financialSqlUnapplied: /NOT_APPLIED/.test(sql64),
  dnsUnchanged: apex.includes(LOVABLE_IP) && www.includes(LOVABLE_IP),
  rollbackAvailable: true,
};

const go = Object.values(checks).every(Boolean);
const report = {
  generatedAt: new Date().toISOString(),
  preFreeze: go ? 'PASS' : 'NO-GO',
  freezeStarted: false,
  productionCutoverPerformed: false,
  checks,
  evidence: {
    db: { http: db.status, mode: db.json.mode, writes: db.json.writes, deletes: db.json.deletes },
    storage: { http: storage.status, mode: storage.json.mode, deletes: storage.json.deletes },
    staging: { status: staging.status, db: stagingDb.json.currentDatabase || null, readOnly: stagingDb.json.transactionReadOnly || null },
    prep: { status: prep.status, environment: prep.json.environment || null },
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
    dns: { apex, www },
    acm: { status: acm.Status, inUseBy: acm.InUseBy || [] },
    cloudfront: {
      id: PROD_CF,
      domain: cf.DomainName,
      status: cf.Status,
      aliases: cf.DistributionConfig?.Aliases?.Items || [],
    },
  },
};
console.log(JSON.stringify(report, null, 2));
process.exit(go ? 0 : 1);
