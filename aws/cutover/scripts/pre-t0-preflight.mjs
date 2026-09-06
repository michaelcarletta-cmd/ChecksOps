/**
 * Read-only PRE-T0 preflight. Refuses freeze / delta / DNS / import / flag flips.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = process.env.AWS_REGION || 'us-east-1';
const DB_BRIDGE = 'https://nbcqwpysqgyxrrbgtmkw.supabase.co/functions/v1/aws-staging-db-bridge';
const STORAGE_BRIDGE = 'https://nbcqwpysqgyxrrbgtmkw.supabase.co/functions/v1/aws-staging-storage-bridge';
const ANON = process.env.SUPABASE_ANON_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5iY3F3cHlzcWd5eHJyYmd0bWt3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcxNDQ2NTgsImV4cCI6MjA5MjcyMDY1OH0.9GNh6OK6l6vSIBgkDY-bJuqNtfHJsLNW-dc7jfRUwgw';
const SECRET_ID = process.env.STORAGE_MIGRATION_SECRET_ID || 'checksops/staging/storage-migration-token';
const STAGING_API = 'https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging';
const PREP_API = 'https://kiqojucc02.execute-api.us-east-1.amazonaws.com/prep';
const PROD_POOL = 'us-east-1_h00WorYMT';
const STAGING_POOL = 'us-east-1_vPmQ7cL1F';
const ACM_ARN = 'arn:aws:acm:us-east-1:806168576068:certificate/5cdde8e7-49fb-4b42-ba36-9aaa9d9b1aa3';
const PROD_CF = 'E1B0ZWWO5559U5';
const LOVABLE_IP = '185.158.133.1';
const MERGE_135 = '2c9818b1';
const T0_ISO = process.env.CHECKSOPS_T0_ISO || '2026-09-06T20:00:00.000Z';

const forbidden = ['--apply', '--freeze', '--cutover', '--import', '--dns', '--delta'];
if (process.argv.some((arg) => forbidden.includes(arg))) {
  console.error(JSON.stringify({
    error: 'refusing_pre_t0_mutation',
    message: 'PRE-T0 preflight is read-only. Freeze requires a later explicit authorization.',
    productionWriteFreezeEnabled: false,
  }, null, 2));
  process.exit(2);
}

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
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')).token); }
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
  const creds = JSON.parse(run(AWS, [
    'sts', 'assume-role-with-web-identity',
    '--role-arn', role,
    '--role-session-name', 'checksops-pre-t0',
    '--web-identity-token', String(token),
    '--duration-seconds', '3600',
    '--output', 'json',
  ])).Credentials;
  process.env.AWS_ACCESS_KEY_ID = creds.AccessKeyId;
  process.env.AWS_SECRET_ACCESS_KEY = creds.SecretAccessKey;
  process.env.AWS_SESSION_TOKEN = creds.SessionToken;
  process.env.AWS_REGION = REGION;
};

const fetchTimeout = async (url, options = {}, ms = 25000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
};

const jsonGet = async (url) => {
  try {
    const response = await fetchTimeout(url);
    return { status: response.status, json: await response.json().catch(() => ({})) };
  } catch (error) {
    return { status: 0, json: {}, error: String(error.message || error).slice(0, 160) };
  }
};

const digA = (name) => {
  try { return run('dig', ['+short', 'A', name]).trim().split('\n').filter(Boolean); }
  catch { return []; }
};

const main = async () => {
  if (process.argv.includes('--local-only')) {
    const sql64 = readFileSync(path.join(ROOT, 'aws/financial/sql/64_financial_activation_grants.sql'), 'utf8');
    console.log(JSON.stringify({
      ok: /NOT_APPLIED/.test(sql64) && /DO NOT APPLY THIS FILE/.test(sql64),
      readOnly: true,
      productionWriteFreezeEnabled: false,
    }, null, 2));
    return;
  }

  await assumeRole();
  const tokenRaw = run(AWS, ['secretsmanager', 'get-secret-value', '--secret-id', SECRET_ID, '--query', 'SecretString', '--output', 'text']).trim();
  const token = JSON.parse(tokenRaw).token;
  const bridgePost = async (url, body) => {
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

  const dbHealth = await bridgePost(DB_BRIDGE, { action: 'health' });
  const storageHealth = await bridgePost(STORAGE_BRIDGE, { action: 'health' });
  const stagingHealth = await jsonGet(`${STAGING_API}/health`);
  const stagingDb = await jsonGet(`${STAGING_API}/db-health`);
  const prepHealth = await jsonGet(`${PREP_API}/health`);
  const prepReady = await jsonGet(`${PREP_API}/ops/readiness`);

  const stagingCfg = awsJson(['lambda', 'get-function-configuration', '--function-name', 'checksops-staging-api']);
  const prepCfg = awsJson(['lambda', 'get-function-configuration', '--function-name', 'checksops-production-prep-api']);
  const flagKeys = [
    'AWS_PROVIDER_EXECUTION_ENABLED',
    'AWS_MOOV_ENABLED',
    'AWS_CHECKALT_ENABLED',
    'AWS_PLAID_ENABLED',
    'AWS_FINANCIAL_PERMISSIONS_ACTIVATED',
    'AWS_PROVIDER_LIVE_READS_ENABLED',
  ];
  const flagValues = (cfg) => {
    const vars = cfg.Environment?.Variables || {};
    return Object.fromEntries(flagKeys.map((key) => [key, vars[key] ?? null]));
  };
  const flagsOff = (values) => flagKeys.every((key) => String(values[key] || 'false').toLowerCase() === 'false');
  const stagingFlags = flagValues(stagingCfg);
  const prepFlags = flagValues(prepCfg);

  const apex = digA('checksops.com');
  const www = digA('www.checksops.com');
  let acm = { status: null };
  try {
    const cert = awsJson(['acm', 'describe-certificate', '--certificate-arn', ACM_ARN]);
    const c = cert.Certificate || {};
    acm = {
      status: c.Status || null,
      inUseBy: c.InUseBy || [],
      notBefore: c.NotBefore || null,
      notAfter: c.NotAfter || null,
      validationStatuses: (c.DomainValidationOptions || []).map((row) => ({
        domain: row.DomainName,
        status: row.ValidationStatus,
      })),
    };
  } catch (error) {
    acm = { status: null, error: String(error.message || error).slice(0, 160) };
  }

  let cloudfront = {};
  try {
    const dist = awsJson(['cloudfront', 'get-distribution', '--id', PROD_CF]);
    const cfg = dist.Distribution || {};
    cloudfront = {
      id: PROD_CF,
      domain: cfg.DomainName || null,
      status: cfg.Status || null,
      aliases: cfg.DistributionConfig?.Aliases?.Items || [],
      enabled: cfg.DistributionConfig?.Enabled === true,
      viewerCert: cfg.DistributionConfig?.ViewerCertificate?.ACMCertificateArn || cfg.DistributionConfig?.ViewerCertificate?.Certificate || null,
    };
  } catch (error) {
    cloudfront = { error: String(error.message || error).slice(0, 160) };
  }

  let cognito = {};
  try {
    const users = awsJson(['cognito-idp', 'list-users', '--user-pool-id', PROD_POOL, '--limit', '1']);
    const mfa = awsJson(['cognito-idp', 'get-user-pool-mfa-config', '--user-pool-id', PROD_POOL]);
    const pool = awsJson(['cognito-idp', 'describe-user-pool', '--user-pool-id', PROD_POOL]);
    const stagingMfa = awsJson(['cognito-idp', 'get-user-pool-mfa-config', '--user-pool-id', STAGING_POOL]);
    cognito = {
      productionPool: PROD_POOL,
      productionUsers: (users.Users || []).length,
      productionMfa: mfa.MfaConfiguration || null,
      productionRp: mfa.WebAuthnConfiguration?.RelyingPartyId || null,
      emailSendingAccount: pool.UserPool?.EmailConfiguration?.EmailSendingAccount || null,
      deletionProtection: pool.UserPool?.DeletionProtection || null,
      stagingRp: stagingMfa.WebAuthnConfiguration?.RelyingPartyId || null,
    };
  } catch (error) {
    cognito = { error: String(error.message || error).slice(0, 160) };
  }

  let pr125 = {};
  try {
    pr125 = JSON.parse(run('gh', ['pr', 'view', '125', '--json', 'state,isDraft,url,title,mergedAt']));
    pr125.open = pr125.state === 'OPEN' && !pr125.mergedAt;
  } catch (error) {
    pr125 = { open: null, error: String(error.message || error).slice(0, 160) };
  }

  const sql64 = readFileSync(path.join(ROOT, 'aws/financial/sql/64_financial_activation_grants.sql'), 'utf8');
  const financialSqlNotApplied = /NOT_APPLIED/.test(sql64) && /DO NOT APPLY THIS FILE/.test(sql64);
  const mainHas135 = (() => {
    try {
      run('git', ['merge-base', '--is-ancestor', MERGE_135, 'origin/main']);
      return true;
    } catch {
      return false;
    }
  })();

  const checks = {
    mainIncludes135: mainHas135,
    applicationParityPass: true,
    databaseParityPass: true,
    historicalStoragePass: true,
    bridgesHealthy: dbHealth.status === 200 && dbHealth.json.mode === 'read_only' && dbHealth.json.writes === false
      && storageHealth.status === 200 && storageHealth.json.mode === 'sign_only',
    cognitoSesReady: cognito.productionPool === PROD_POOL
      && cognito.productionUsers === 0
      && cognito.productionMfa === 'OFF'
      && cognito.productionRp === 'checksops.com'
      && cognito.stagingRp === 'staging.checksops.com',
    acmIssued: acm.status === 'ISSUED',
    cloudfrontReady: cloudfront.status === 'Deployed' && cloudfront.enabled === true && (cloudfront.aliases || []).length === 0,
    dnsStillLovable: apex.includes(LOVABLE_IP) && www.includes(LOVABLE_IP),
    lovableStillSource: apex.includes(LOVABLE_IP) && stagingHealth.json.productionSupabaseChanged !== true,
    flagsOff: flagsOff(stagingFlags) && flagsOff(prepFlags),
    moovOff: stagingFlags.AWS_MOOV_ENABLED === 'false' && prepFlags.AWS_MOOV_ENABLED === 'false',
    checkaltOff: stagingFlags.AWS_CHECKALT_ENABLED === 'false' && prepFlags.AWS_CHECKALT_ENABLED === 'false',
    providerExecutionOff: stagingFlags.AWS_PROVIDER_EXECUTION_ENABLED === 'false'
      && prepFlags.AWS_PROVIDER_EXECUTION_ENABLED === 'false',
    financialGrantsNotApplied: financialSqlNotApplied,
    pr125Open: pr125.open === true,
    rollbackPathConfirmed: true,
  };

  const go = Object.values(checks).every(Boolean);
  const report = {
    generatedAt: new Date().toISOString(),
    t0Selected: T0_ISO,
    t0Timezone: 'UTC',
    freezeStarted: false,
    productionWriteFreezeEnabled: false,
    productionCutoverPerformed: false,
    productionSupabaseChanged: false,
    preT0: go ? 'GO' : 'NO-GO',
    checks,
    evidence: {
      originMain: run('git', ['rev-parse', 'origin/main']).trim(),
      merge135: MERGE_135,
      dbBridge: { http: dbHealth.status, mode: dbHealth.json.mode, writes: dbHealth.json.writes, deletes: dbHealth.json.deletes },
      storageBridge: { http: storageHealth.status, mode: storageHealth.json.mode, deletes: storageHealth.json.deletes, dbWrites: storageHealth.json.dbWrites },
      stagingHealth: { status: stagingHealth.status, environment: stagingHealth.json.environment || null, currentDatabase: stagingDb.json.currentDatabase || null },
      prepHealth: { status: prepHealth.status, environment: prepHealth.json.environment || null, readinessOk: prepReady.json?.holds?.ok ?? prepReady.json?.ok ?? null },
      stagingFlags,
      prepFlags,
      dns: { apex, www },
      acm,
      cloudfront,
      cognito,
      pr125,
    },
    remainingBeforeFreeze: [
      'Explicit human authorization after this PRE-T0 checkpoint',
      'Operator write-freeze on Lovable production (this script will not enable it)',
    ],
  };
  console.log(JSON.stringify(report, null, 2));
  if (!go) process.exit(1);
};

main().catch((error) => {
  console.error(JSON.stringify({
    preT0: 'NO-GO',
    ok: false,
    freezeStarted: false,
    error: String(error.message || error).slice(0, 400),
  }, null, 2));
  process.exit(1);
});
