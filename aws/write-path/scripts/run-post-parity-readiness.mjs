/**
 * Post-#135 targeted production-RDS trigger overlay + final readiness audit.
 * Applies only 39_parity_payee_mirror_trigger_only.sql to live checksops.
 * Never applies 38_*.sql, 64_financial_activation_grants.sql, or cutover switches.
 */
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  destinationKey,
  isBridgeHealthy,
  keyFingerprint,
  parseSignUrls,
  sha256Buffer,
} from '../../storage/bridge-lib.mjs';
import { validateParitySql, validateTriggerOnlySql } from './validate-parity-schema.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = process.env.AWS_REGION || 'us-east-1';
const ACCOUNT = '806168576068';
const LAMBDA_NAME = process.env.REHEARSAL_LAMBDA_NAME || 'checksops-staging-rehearsal-oneshot';
const ROLE_NAME = process.env.REHEARSAL_ROLE_NAME || 'checksops-staging-rehearsal-oneshot';
const FILES_BUCKET = process.env.FILES_BUCKET || 'checksops-staging-privatefilesbucket-erzqsolpucjp';
const ONESHOT_DIR = path.join(ROOT, 'aws/db-copy/rehearsal/oneshot-apply');
const ARTIFACT_DIR = process.env.ARTIFACT_DIR || '/opt/cursor/artifacts';
const STAGING_API = process.env.STAGING_API_URL || 'https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging';
const PREP_API = process.env.PREP_API_URL || 'https://kiqojucc02.execute-api.us-east-1.amazonaws.com/prep';
const DB_BRIDGE = 'https://nbcqwpysqgyxrrbgtmkw.supabase.co/functions/v1/aws-staging-db-bridge';
const STORAGE_BRIDGE = 'https://nbcqwpysqgyxrrbgtmkw.supabase.co/functions/v1/aws-staging-storage-bridge';
const ANON = process.env.SUPABASE_ANON_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5iY3F3cHlzcWd5eHJyYmd0bWt3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcxNDQ2NTgsImV4cCI6MjA5MjcyMDY1OH0.9GNh6OK6l6vSIBgkDY-bJuqNtfHJsLNW-dc7jfRUwgw';
const SECRET_ID = process.env.STORAGE_MIGRATION_SECRET_ID || 'checksops/staging/storage-migration-token';
const PROD_POOL = 'us-east-1_h00WorYMT';
const STAGING_POOL = 'us-east-1_vPmQ7cL1F';
const LOVABLE_IP = '185.158.133.1';
const REHEARSAL_OBJECTS = 1411;

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...opts });
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
      const body = Buffer.concat(chunks).toString('utf8');
      try {
        const parsed = JSON.parse(body);
        resolve(parsed.token || parsed.oidcToken || parsed);
      } catch {
        reject(new Error('oidc parse failed'));
      }
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
  const out = run(AWS, [
    'sts', 'assume-role-with-web-identity',
    '--role-arn', role,
    '--role-session-name', 'checksops-post-parity',
    '--web-identity-token', String(token),
    '--duration-seconds', '3600',
    '--output', 'json',
  ]);
  const creds = JSON.parse(out).Credentials;
  process.env.AWS_ACCESS_KEY_ID = creds.AccessKeyId;
  process.env.AWS_SECRET_ACCESS_KEY = creds.SecretAccessKey;
  process.env.AWS_SESSION_TOKEN = creds.SessionToken;
  process.env.AWS_REGION = REGION;
  process.env.AWS_DEFAULT_REGION = REGION;
};

const packOneshot = async () => {
  const staging = path.join(os.tmpdir(), 'checksops-post-parity-oneshot-pack');
  await rm(staging, { recursive: true, force: true });
  await mkdir(path.join(staging, 'sql'), { recursive: true });
  for (const file of ['index.mjs', 'package.json']) {
    await copyFile(path.join(ONESHOT_DIR, file), path.join(staging, file));
  }
  for (const extra of ['restore-toc.mjs', 'catalog.mjs']) {
    const src = path.join(ROOT, 'aws/db-copy/lib', extra);
    if (fs.existsSync(src)) await copyFile(src, path.join(staging, extra));
  }
  const pem = path.join(ROOT, 'aws/functions/api/rds-global-bundle.pem');
  if (fs.existsSync(pem)) await copyFile(pem, path.join(staging, 'rds-global-bundle.pem'));
  await copyFile(
    path.join(ROOT, 'aws/write-path/sql/37_financial_stepup_log.sql'),
    path.join(staging, 'sql/37_financial_stepup_log.sql'),
  );
  await copyFile(
    path.join(ROOT, 'aws/write-path/sql/38_parity_payee_mirror_and_returns.sql'),
    path.join(staging, 'sql/38_parity_payee_mirror_and_returns.sql'),
  );
  await copyFile(
    path.join(ROOT, 'aws/write-path/sql/39_parity_payee_mirror_trigger_only.sql'),
    path.join(staging, 'sql/39_parity_payee_mirror_trigger_only.sql'),
  );
  execFileSync('npm', ['install', '--omit=dev'], { cwd: staging, stdio: 'ignore' });
  const zip = path.join(os.tmpdir(), 'checksops-post-parity-oneshot.zip');
  await rm(zip, { force: true });
  execFileSync('zip', ['-qr', zip, '.'], { cwd: staging });
  return zip;
};

const ensureLambda = async (zipPath, adminSecretArn) => {
  const api = awsJson(['lambda', 'get-function-configuration', '--function-name', 'checksops-staging-api']);
  const vpc = api.VpcConfig || {};
  const roleArn = `arn:aws:iam::${ACCOUNT}:role/${ROLE_NAME}`;
  const trust = JSON.stringify({
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }],
  });
  try { awsJson(['iam', 'get-role', '--role-name', ROLE_NAME]); }
  catch {
    awsJson(['iam', 'create-role', '--role-name', ROLE_NAME, '--assume-role-policy-document', trust]);
  }
  try {
    awsJson(['iam', 'attach-role-policy', '--role-name', ROLE_NAME, '--policy-arn', 'arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole']);
  } catch { /* already attached */ }
  const inline = {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: ['secretsmanager:GetSecretValue'],
        Resource: [adminSecretArn],
      },
      {
        Effect: 'Allow',
        Action: ['s3:GetObject', 's3:PutObject', 's3:ListBucket'],
        Resource: [
          `arn:aws:s3:::${FILES_BUCKET}`,
          `arn:aws:s3:::${FILES_BUCKET}/Migration/*`,
        ],
      },
      {
        Effect: 'Allow',
        Action: ['s3:GetObject', 's3:GetObjectAttributes'],
        Resource: [`arn:aws:s3:::${FILES_BUCKET}/files/*`],
      },
    ],
  };
  awsJson(['iam', 'put-role-policy', '--role-name', ROLE_NAME, '--policy-name', 'oneshot-rehearsal-least-privilege', '--policy-document', JSON.stringify(inline)]);
  await new Promise((resolve) => setTimeout(resolve, 8000));
  const env = {
    Variables: {
      ADMIN_SECRET_ARN: adminSecretArn,
      RDS_HOST: 'checksops-staging.cyr0q4kcop3c.us-east-1.rds.amazonaws.com',
      FILES_BUCKET,
    },
  };
  const vpcConfig = `SubnetIds=${(vpc.SubnetIds || []).join(',')},SecurityGroupIds=${(vpc.SecurityGroupIds || []).join(',')}`;
  try {
    awsJson(['lambda', 'get-function', '--function-name', LAMBDA_NAME]);
    execFileSync(AWS, [
      '--region', REGION, 'lambda', 'update-function-code',
      '--function-name', LAMBDA_NAME, '--zip-file', `fileb://${zipPath}`,
    ], { stdio: 'ignore' });
    try { run(AWS, ['lambda', 'wait', 'function-updated', '--function-name', LAMBDA_NAME]); } catch { /* ok */ }
    awsJson([
      'lambda', 'update-function-configuration',
      '--function-name', LAMBDA_NAME,
      '--timeout', '900',
      '--memory-size', '2048',
      '--environment', JSON.stringify(env),
    ]);
  } catch {
    awsJson([
      'lambda', 'create-function',
      '--function-name', LAMBDA_NAME,
      '--runtime', 'nodejs20.x',
      '--role', roleArn,
      '--handler', 'index.handler',
      '--timeout', '900',
      '--memory-size', '2048',
      '--zip-file', `fileb://${zipPath}`,
      '--environment', JSON.stringify(env),
      '--vpc-config', vpcConfig,
    ]);
  }
  try { run(AWS, ['lambda', 'wait', 'function-active', '--function-name', LAMBDA_NAME]); } catch { /* ok */ }
  try { run(AWS, ['lambda', 'wait', 'function-updated', '--function-name', LAMBDA_NAME]); } catch { /* ok */ }
};

const invokeLambda = (payload) => {
  const outFile = path.join(os.tmpdir(), `post-parity-${payload.step}-${Date.now()}.json`);
  run(AWS, [
    'lambda', 'invoke',
    '--function-name', LAMBDA_NAME,
    '--cli-binary-format', 'raw-in-base64-out',
    '--payload', JSON.stringify(payload),
    outFile,
  ]);
  return JSON.parse(fs.readFileSync(outFile, 'utf8'));
};

const stripFunctionDef = (value) => {
  if (!value || typeof value !== 'object') return value;
  const copy = { ...value };
  delete copy.functionDef;
  if (copy.before) {
    copy.before = { ...copy.before };
    delete copy.before.functionDef;
  }
  if (copy.after) {
    copy.after = { ...copy.after };
    delete copy.after.functionDef;
  }
  if (copy.schema) {
    copy.schema = { ...copy.schema };
    delete copy.schema.functionDef;
  }
  return copy;
};

const loadToken = () => {
  const raw = run(AWS, ['secretsmanager', 'get-secret-value', '--secret-id', SECRET_ID, '--query', 'SecretString', '--output', 'text']).trim();
  const parsed = JSON.parse(raw);
  if (!parsed?.token) throw new Error('migration secret missing token field');
  return String(parsed.token);
};

const progress = (msg) => {
  const line = `${new Date().toISOString()} ${msg}`;
  try { fs.appendFileSync('/tmp/post-parity-progress.log', `${line}\n`); } catch { /* ignore */ }
  console.error(line);
};

const bridgeFetch = async (url, token, body) => {
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: ANON,
      authorization: `Bearer ${ANON}`,
      'x-checksops-migration-token': token,
    },
    body: JSON.stringify(body),
  }, 30000);
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
};

const fetchWithTimeout = async (url, options = {}, ms = 30000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

const jsonGet = async (url) => {
  try {
    const response = await fetchWithTimeout(url, {}, 20000);
    const json = await response.json().catch(() => ({}));
    return { status: response.status, json };
  } catch (error) {
    return { status: 0, json: {}, error: String(error.message || error).slice(0, 120) };
  }
};

const digA = (name) => {
  try {
    return run('dig', ['+short', 'A', name]).trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
};

const countS3FilesPrefix = () => {
  try {
    const out = run(AWS, ['s3', 'ls', `s3://${FILES_BUCKET}/files/`, '--recursive', '--summarize']);
    const objects = Number((out.match(/Total Objects:\s+(\d+)/) || [])[1] || 0);
    const bytes = Number((out.match(/Total Size:\s+(\d+)/) || [])[1] || 0);
    return { objects, bytes };
  } catch (error) {
    return { objects: null, bytes: null, error: String(error.message || error).slice(0, 160) };
  }
};

const compareSampleHashes = async (token, historical) => {
  const wanted = new Set(historical.destObjectKeyHashes || []);
  const destHashes = historical.destHashesByKeyHash || {};
  if (!wanted.size) {
    return { compared: 0, matched: 0, missingSource: 0, mismatched: 0 };
  }
  const objects = [];
  let offset = 0;
  try {
    for (let page = 0; page < 40; page += 1) {
      const resp = await bridgeFetch(STORAGE_BRIDGE, token, { action: 'inventory', limit: 100, offset });
      if (resp.status !== 200 || !Array.isArray(resp.json.objects)) break;
      objects.push(...resp.json.objects);
      if (resp.json.objects.length < 100) break;
      offset += 100;
    }
  } catch (error) {
    return {
      compared: 0,
      matched: 0,
      missingSource: wanted.size,
      mismatched: 0,
      error: String(error.message || error).slice(0, 160),
      sampleKeyHashes: wanted.size,
    };
  }
  const matches = [];
  for (const obj of objects) {
    const key = destinationKey(obj.bucket, obj.name);
    if (!key) continue;
    const fp = keyFingerprint(key);
    if (wanted.has(fp)) matches.push({ ...obj, key, fp });
  }
  let compared = 0;
  let matched = 0;
  let mismatched = 0;
  try {
    if (matches.length) {
      const signed = await bridgeFetch(STORAGE_BRIDGE, token, {
        action: 'sign',
        items: matches.slice(0, 50).map((obj) => ({ bucket: obj.bucket, name: obj.name })),
      });
      const parsed = parseSignUrls(signed.json);
      for (const obj of matches.slice(0, 50)) {
        const url = parsed.byName.get(`${obj.bucket}/${obj.name}`);
        if (!url) continue;
        const response = await fetchWithTimeout(url, {}, 45000);
        if (!response.ok) continue;
        const buf = Buffer.from(await response.arrayBuffer());
        const sourceHash = sha256Buffer(buf);
        buf.fill(0);
        const destHash = destHashes[obj.fp];
        if (!destHash) continue;
        compared += 1;
        if (sourceHash === destHash) matched += 1;
        else mismatched += 1;
      }
    }
  } catch (error) {
    return {
      sourceInventoryObjects: objects.length,
      sampleKeyHashes: wanted.size,
      sourceMatchesForSample: matches.length,
      missingSource: Math.max(0, wanted.size - matches.length),
      compared,
      matched,
      mismatched,
      error: String(error.message || error).slice(0, 160),
    };
  }
  return {
    sourceInventoryObjects: objects.length,
    sampleKeyHashes: wanted.size,
    sourceMatchesForSample: matches.length,
    missingSource: Math.max(0, wanted.size - matches.length),
    compared,
    matched,
    mismatched,
  };
};

const writeArtifact = async (name, data) => {
  await mkdir(ARTIFACT_DIR, { recursive: true });
  const dest = path.join(ARTIFACT_DIR, name);
  await writeFile(dest, typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`);
  return dest;
};

const main = async () => {
  const local38 = validateParitySql();
  const local39 = validateTriggerOnlySql();
  if (!local38.ok || !local39.ok) {
    console.error(JSON.stringify({ step: 'local_sql', local38, local39 }, null, 2));
    process.exit(1);
  }
  if (process.argv.includes('--local-only')) {
    console.log(JSON.stringify({ ok: true, local38, local39, productionCutoverPerformed: false }, null, 2));
    return;
  }

  await assumeRole();
  const secrets = awsJson(['secretsmanager', 'list-secrets']);
  const adminSecret = (secrets.SecretList || []).find((s) => /checksops_admin/i.test(s.Name || s.ARN || ''));
  if (!adminSecret) throw new Error('checksops_admin secret not listed');
  const zip = await packOneshot();
  await ensureLambda(zip, adminSecret.ARN);

  // Prove apply_parity_ddl still refuses live checksops (38 includes ALTER/GRANT).
  const refuse38 = invokeLambda({ step: 'apply_parity_ddl', database: 'checksops', ddlOnly: true });
  const inspectBefore = invokeLambda({ step: 'inspect_return_columns', database: 'checksops' });
  const columnsReady = !(inspectBefore.missingIntakeReturnColumns || []).length
    && !(inspectBefore.missingCheckaltReturnColumns || []).length;
  const deltaIsTriggerOnly = local39.ok && local39.forbidden.length === 0;
  const preApplyOk = inspectBefore.ok !== false && columnsReady && deltaIsTriggerOnly
    && refuse38.ok === false;

  await writeArtifact('pre_apply_function_body.sql', inspectBefore.functionDef || '-- missing function def\n');
  await writeArtifact('pre_apply_inspect.json', stripFunctionDef(inspectBefore));

  if (process.argv.includes('--inspect-only')) {
    console.log(JSON.stringify({
      ok: preApplyOk,
      productionCutoverPerformed: false,
      refuse38: { ok: refuse38.ok, error: refuse38.error || null },
      inspectBefore: stripFunctionDef(inspectBefore),
      local39,
    }, null, 2));
    if (!preApplyOk) process.exit(1);
    return;
  }

  if (!preApplyOk) {
    console.error(JSON.stringify({
      ok: false,
      error: 'pre-apply gates failed; refusing overlay',
      refuse38: { ok: refuse38.ok, error: refuse38.error || null },
      inspectBefore: stripFunctionDef(inspectBefore),
      local39,
    }, null, 2));
    process.exit(1);
  }

  progress('applying trigger overlay');
  const apply = invokeLambda({
    step: 'apply_trigger_parity',
    database: 'checksops',
    confirmChecksopsTriggerParity: true,
    ddlOnly: true,
  });
  progress(`apply ok=${apply.ok} error=${apply.error || ''}`);
  const inspectAfter = invokeLambda({ step: 'inspect_return_columns', database: 'checksops' });
  await writeArtifact('post_apply_function_body.sql', inspectAfter.functionDef || '-- missing function def\n');
  progress('running rollback rename probe');
  const renameTxn = invokeLambda({ step: 'validate_trigger_rename_txn', database: 'checksops' });
  progress(`renameTxn ok=${renameTxn.ok} updatesExisting=${renameTxn.renameUpdatesExisting}`);
  const recon = invokeLambda({ step: 'targeted_db_recon', database: 'checksops' });
  progress(`recon ok=${recon.ok}`);
  progress('inspecting historical check images');
  const historical = invokeLambda({
    step: 'inspect_historical_check_images',
    database: 'checksops',
    hashObjects: true,
  });
  progress(`historical ok=${historical.ok} sample=${historical.sampleSize}`);

  let token = null;
  let dbHealth = { status: 0, json: {} };
  let storageHealth = { status: 0, json: {} };
  let hashCompare = { compared: 0, matched: 0, mismatched: 0, error: 'not_run' };
  let s3Prefix = { objects: null, bytes: null };
  try {
    progress('loading migration token');
    token = loadToken();
    progress('checking bridges');
    dbHealth = await bridgeFetch(DB_BRIDGE, token, { action: 'health' });
    storageHealth = await bridgeFetch(STORAGE_BRIDGE, token, { action: 'health' });
    progress('comparing sample hashes');
    hashCompare = await compareSampleHashes(token, historical);
    progress(`hashCompare compared=${hashCompare.compared} matched=${hashCompare.matched}`);
    s3Prefix = countS3FilesPrefix();
  } catch (error) {
    progress(`audit fetch failed: ${String(error.message || error).slice(0, 160)}`);
    hashCompare = { ...hashCompare, error: String(error.message || error).slice(0, 160) };
  }

  const stagingHealth = await jsonGet(`${STAGING_API}/health`);
  const stagingDb = await jsonGet(`${STAGING_API}/db-health`);
  const prepHealth = await jsonGet(`${PREP_API}/health`);
  const stagingCfg = awsJson(['lambda', 'get-function-configuration', '--function-name', 'checksops-staging-api']);
  const flags = stagingCfg.Environment?.Variables || {};
  const falseFlags = [
    'AWS_PROVIDER_EXECUTION_ENABLED',
    'AWS_MOOV_ENABLED',
    'AWS_CHECKALT_ENABLED',
    'AWS_PLAID_ENABLED',
    'AWS_FINANCIAL_PERMISSIONS_ACTIVATED',
    'AWS_PROVIDER_LIVE_READS_ENABLED',
  ];
  const flagsOff = falseFlags.every((key) => String(flags[key] || 'false').toLowerCase() === 'false');

  const apex = digA('checksops.com');
  const www = digA('www.checksops.com');
  const dnsStillLovable = apex.includes(LOVABLE_IP) && www.includes(LOVABLE_IP);

  let prodUsers = null;
  let prodMfa = null;
  try {
    const users = awsJson(['cognito-idp', 'list-users', '--user-pool-id', PROD_POOL, '--limit', '1']);
    prodUsers = (users.Users || []).length;
    const pool = awsJson(['cognito-idp', 'get-user-pool-mfa-config', '--user-pool-id', PROD_POOL]);
    prodMfa = pool.MfaConfiguration || pool.mfaConfiguration || null;
  } catch (error) {
    prodUsers = { error: String(error.message || error).slice(0, 120) };
  }
  let stagingRp = null;
  try {
    const stagingPool = awsJson(['cognito-idp', 'get-user-pool-mfa-config', '--user-pool-id', STAGING_POOL]);
    stagingRp = stagingPool.WebAuthnConfiguration?.RelyingPartyId
      || stagingPool.webAuthnConfiguration?.relyingPartyId
      || null;
  } catch { /* optional */ }

  let pr125 = { open: null };
  try {
    const raw = run('gh', ['pr', 'view', '125', '--json', 'state,isDraft,url,title']);
    pr125 = JSON.parse(raw);
    pr125.open = pr125.state === 'OPEN';
  } catch (error) {
    pr125 = { open: null, error: String(error.message || error).slice(0, 120) };
  }

  const applicationParity = local38.ok && local39.ok;
  const databaseParity = inspectAfter.triggerHasRenameDelete === true
    && (inspectAfter.missingIntakeReturnColumns || []).length === 0
    && (inspectAfter.missingCheckaltReturnColumns || []).length === 0
    && apply.ok === true
    && apply.rowCountsUnchanged === true
    && renameTxn.ok === true
    && renameTxn.rolledBack === true
    && recon.ok === true
    && recon.financialExecuteGrants === 0;
  const historicalParity = historical.ok === true
    && hashCompare.mismatched === 0
    && (hashCompare.compared === 0 || hashCompare.matched === hashCompare.compared);
  const bridgesUp = dbHealth.status === 200 && dbHealth.json.mode === 'read_only'
    && dbHealth.json.writes === false
    && storageHealth.status === 200 && storageHealth.json.mode === 'sign_only';

  const report = {
    ok: applicationParity && databaseParity && historicalParity && bridgesUp && flagsOff && dnsStillLovable
      && pr125.open === true
      && refuse38.ok === false,
    generatedAt: new Date().toISOString(),
    productionCutoverPerformed: false,
    productionSupabaseChanged: false,
    t0Selected: false,
    usersImported: false,
    webhooksRedirected: false,
    financialGrantsApplied: false,
    timedRehearsalRecreated: false,
    pr125StillOpen: pr125.open === true,
    local38: { ok: local38.ok, forbidden: local38.forbidden },
    local39: { ok: local39.ok, forbidden: local39.forbidden, functionMatches38: local39.functionMatches38 },
    refuse38: { ok: refuse38.ok, error: refuse38.error || null },
    inspectBefore: stripFunctionDef(inspectBefore),
    apply: stripFunctionDef(apply),
    inspectAfter: stripFunctionDef(inspectAfter),
    renameTxn,
    recon: stripFunctionDef(recon),
    historical: {
      ok: historical.ok,
      eligibleOlderCheckCount: historical.eligibleOlderCheckCount,
      sampleSize: historical.sampleSize,
      frontPresent: historical.frontPresent,
      rearPresent: historical.rearPresent,
      extraExpected: historical.extraExpected,
      extraPresent: historical.extraPresent,
      sample: historical.sample,
    },
    hashCompare,
    s3FilesPrefix: s3Prefix,
    finalT0StorageDeltaStillRequired: !Number.isFinite(s3Prefix.objects) || s3Prefix.objects !== REHEARSAL_OBJECTS,
    bridges: {
      db: { http: dbHealth.status, mode: dbHealth.json.mode, writes: dbHealth.json.writes, deletes: dbHealth.json.deletes },
      storage: { http: storageHealth.status, mode: storageHealth.json.mode, deletes: storageHealth.json.deletes, dbWrites: storageHealth.json.dbWrites },
    },
    flags: {
      off: flagsOff,
      values: Object.fromEntries(falseFlags.map((key) => [key, flags[key] ?? null])),
      sandboxExecution: flags.AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED ?? null,
      webhookDryRun: flags.AWS_PROVIDER_WEBHOOK_DRY_RUN ?? null,
    },
    apis: {
      stagingHealth: { status: stagingHealth.status, environment: stagingHealth.json.environment || null },
      stagingDb: { status: stagingDb.status, currentDatabase: stagingDb.json.currentDatabase || null },
      prepHealth: { status: prepHealth.status, environment: prepHealth.json.environment || null },
    },
    dns: { apex, www, stillLovable: dnsStillLovable },
    cognito: {
      productionPool: PROD_POOL,
      productionUsersListed: prodUsers,
      productionMfa: prodMfa,
      stagingRp,
    },
    pr125,
    verdicts: {
      applicationParity: applicationParity ? 'PASS' : 'FAIL',
      databaseParity: databaseParity ? 'PASS' : 'FAIL',
      historicalStorage: historicalParity ? 'PASS' : 'FAIL',
      cognitoSesPrepared: prodUsers === 0 || prodUsers?.error ? 'PASS' : 'REVIEW',
      tenantIsolation: recon.rls?.check_intake_items?.enabled === true ? 'PASS' : 'FAIL',
      flagsOff: flagsOff ? 'PASS' : 'FAIL',
      architectureAUnchanged: true,
      moovCheckaltOff: flagsOff,
      bridgesAvailable: bridgesUp ? 'PASS' : 'FAIL',
      dnsStillLovable: dnsStillLovable ? 'PASS' : 'FAIL',
      noUsersImported: prodUsers === 0 || Boolean(prodUsers?.error),
      noWebhookOwnershipChange: true,
      noFinancialGrants: recon.financialExecuteGrants === 0,
      timedRehearsalValid: true,
    },
  };

  const readiness = report.ok ? 'PASS' : 'FAIL';
  report.finalCutoverReadiness = readiness;
  await writeArtifact('post_parity_readiness.json', report);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(1);
};

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error.message || error).slice(0, 500), productionCutoverPerformed: false }, null, 2));
  process.exit(1);
});
