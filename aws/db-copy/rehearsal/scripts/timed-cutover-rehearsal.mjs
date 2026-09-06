#!/usr/bin/env node
/**
 * Timed freeze-free cutover rehearsal.
 * Read-only production capture + disposable AWS rehearsal DB + append-only S3 COPY.
 * Does not freeze production, import Cognito users, change DNS, flags, webhooks, or bridges.
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = process.env.AWS_REGION || 'us-east-1';
const ARTIFACT_DIR = process.env.TIMING_ARTIFACT_DIR || '/opt/cursor/artifacts';
const REPORT_DIR = path.join(ROOT, 'aws/db-copy/rehearsal/analysis');
const REHEARSAL_DB = process.env.REHEARSAL_DB || 'checksops_rehearsal_20260906';
const ORIGIN = Date.now();
const stamp = () => ({ t: new Date().toISOString(), elapsedMs: Date.now() - ORIGIN });

const log = (obj) => {
  const line = JSON.stringify({ ...stamp(), ...obj });
  console.log(line);
  return line;
};

const run = (cmd, args, env = process.env) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (d) => stdout.push(d));
  child.stderr.on('data', (d) => stderr.push(d));
  child.on('close', (code) => {
    const out = Buffer.concat(stdout).toString('utf8');
    const err = Buffer.concat(stderr).toString('utf8');
    if (code === 0) resolve({ out, err, code });
    else reject(new Error(`${cmd} failed (${code}): ${(err || out).slice(0, 500)}`));
  });
});

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
      } catch (error) {
        reject(error);
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
  const tokenFile = path.join(os.tmpdir(), `checksops-oidc-${process.pid}.jwt`);
  fs.writeFileSync(tokenFile, String(token), { mode: 0o600 });
  const assumed = await run(AWS, [
    'sts', 'assume-role-with-web-identity',
    '--role-arn', role,
    '--role-session-name', 'checksops-timed-rehearsal',
    '--web-identity-token', `file://${tokenFile}`,
    '--duration-seconds', '3600',
    '--output', 'json',
  ]);
  fs.unlinkSync(tokenFile);
  const creds = JSON.parse(assumed.out).Credentials;
  process.env.AWS_ACCESS_KEY_ID = creds.AccessKeyId;
  process.env.AWS_SECRET_ACCESS_KEY = creds.SecretAccessKey;
  process.env.AWS_SESSION_TOKEN = creds.SessionToken;
  process.env.AWS_REGION = REGION;
  process.env.AWS_DEFAULT_REGION = REGION;
  return 'assumed';
};

const assumeIfNeeded = async (force = false) => {
  if (!force && process.env.AWS_SESSION_TOKEN && process.env.AWS_ACCESS_KEY_ID) return 'existing';
  return assumeRole();
};

const awsJson = async (args) => {
  const { out } = await run(AWS, ['--region', REGION, '--output', 'json', ...args]);
  return out.trim() ? JSON.parse(out) : {};
};

const digA = (name) => {
  const child = spawn('dig', ['+short', name, 'A'], { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve) => {
    const stdout = [];
    child.stdout.on('data', (d) => stdout.push(d));
    child.on('close', () => resolve(Buffer.concat(stdout).toString('utf8').trim().split('\n')[0] || ''));
  });
};

const parseProgress = (raw) => raw.split('\n').map((line) => {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try { return JSON.parse(trimmed); } catch { return null; }
}).filter(Boolean);

const phaseMs = (events, startPred, endPred) => {
  const start = events.find(startPred);
  const end = [...events].reverse().find(endPred) || events.find(endPred);
  if (!start || !end || start.elapsedMs == null || end.elapsedMs == null) return null;
  return Math.max(0, end.elapsedMs - start.elapsedMs);
};

const spawnLogged = (cmd, args, logPath, env) => new Promise((resolve) => {
  const started = Date.now();
  const out = fs.createWriteStream(logPath);
  out.write(`${JSON.stringify({ ...stamp(), step: 'child_start', cmd, args })}\n`);
  const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => {
    process.stdout.write(d);
    out.write(d);
  });
  child.stderr.on('data', (d) => {
    process.stderr.write(d);
    out.write(d);
  });
  child.on('close', (code) => {
    const finished = Date.now();
    out.write(`\n${JSON.stringify({ ...stamp(), step: 'child_end', code, durationMs: finished - started })}\n`);
    out.end();
    resolve({ code, durationMs: finished - started, logPath });
  });
});

const safetyPreflight = async () => {
  const blocked = [];
  const apex = await digA('checksops.com');
  const www = await digA('www.checksops.com');
  if (apex !== '185.158.133.1') blocked.push(`apex_dns_${apex || 'empty'}`);
  if (www !== '185.158.133.1') blocked.push(`www_dns_${www || 'empty'}`);
  const prodEnv = fs.readFileSync(path.join(ROOT, '.env.production'), 'utf8');
  if (/VITE_AUTH_PROVIDER=cognito/.test(prodEnv)) blocked.push('env_production_cognito');
  const flags = [
    'AWS_CHECKALT_ENABLED', 'AWS_MOOV_ENABLED', 'AWS_PROVIDER_EXECUTION_ENABLED',
    'AWS_FINANCIAL_PERMISSIONS_ACTIVATED', 'AWS_PLAID_ENABLED', 'AWS_PROVIDER_LIVE_READS_ENABLED',
  ];
  const pick = (env) => Object.fromEntries(flags.map((k) => [k, env[k] ?? null]));
  const prep = await awsJson(['lambda', 'get-function-configuration', '--function-name', 'checksops-production-prep-api']);
  const staging = await awsJson(['lambda', 'get-function-configuration', '--function-name', 'checksops-staging-api']);
  const prepFlags = pick(prep.Environment?.Variables || {});
  const stagingFlags = pick(staging.Environment?.Variables || {});
  for (const [k, v] of Object.entries({ ...Object.fromEntries(Object.entries(prepFlags).map(([k, v]) => [`prep.${k}`, v])), ...Object.fromEntries(Object.entries(stagingFlags).map(([k, v]) => [`staging.${k}`, v])) })) {
    if (v !== 'false') blocked.push(`flag_${k}=${v}`);
  }
  const users = await awsJson(['cognito-idp', 'list-users', '--user-pool-id', 'us-east-1_h00WorYMT', '--limit', '5']);
  const userCount = (users.Users || []).length;
  if (userCount !== 0) blocked.push(`production_pool_has_users_${userCount}`);
  const cf = await awsJson(['cloudfront', 'get-distribution', '--id', 'E1B0ZWWO5559U5']);
  const aliases = cf.Distribution?.DistributionConfig?.Aliases?.Quantity || 0;
  if (aliases !== 0) blocked.push(`cloudfront_aliases_${aliases}`);
  if (/checksops$/.test(REHEARSAL_DB) || REHEARSAL_DB === 'postgres') blocked.push(`unsafe_rehearsal_db_${REHEARSAL_DB}`);
  if (!/^checksops_rehearsal_[0-9]{8}$/.test(REHEARSAL_DB)) blocked.push(`bad_rehearsal_db_${REHEARSAL_DB}`);
  const dangerous = process.argv.filter((arg) => /apply-checksops-ddl|apply-ddl-overlay/.test(arg));
  if (dangerous.length) blocked.push(`refused_argv_${dangerous.join(',')}`);
  return {
    ok: blocked.length === 0,
    blocked,
    apex,
    www,
    prepFlags,
    stagingFlags,
    productionCognitoUsers: userCount,
    cloudfrontAliases: aliases,
    rehearsalDatabase: REHEARSAL_DB,
    productionSupabaseChanged: false,
  };
};

const identityPrep = async () => {
  const started = Date.now();
  const dry = await run(process.execPath, [path.join(ROOT, 'aws/cutover/scripts/identity-migration-dry-run.mjs')]);
  const dryMs = Date.now() - started;
  const dryBody = JSON.parse(dry.out);
  const listStarted = Date.now();
  const listed = await awsJson(['cognito-idp', 'list-users', '--user-pool-id', 'us-east-1_h00WorYMT', '--limit', '8']);
  const listMs = Date.now() - listStarted;
  const describeStarted = Date.now();
  await awsJson(['cognito-idp', 'describe-user-pool', '--user-pool-id', 'us-east-1_h00WorYMT']);
  const describeMs = Date.now() - describeStarted;
  const rttSamples = [];
  for (let i = 0; i < 8; i += 1) {
    const t0 = Date.now();
    await awsJson(['cognito-idp', 'describe-user-pool-client', '--user-pool-id', 'us-east-1_h00WorYMT', '--client-id', '3ja9fqaq2fjkv3i6up2varcqpe']);
    rttSamples.push(Date.now() - t0);
  }
  const avgRtt = Math.round(rttSamples.reduce((a, b) => a + b, 0) / rttSamples.length);
  const estimatedCreateMs = avgRtt * 8 * 2;
  return {
    imported: false,
    productionAuthSwitch: false,
    mappedEligibleCount: dryBody.mappedEligibleCount,
    ninthExcludedFromInvite: dryBody.ninthExcludedFromInvite,
    dryRunMs: dryMs,
    listUsersMs: listMs,
    describePoolMs: describeMs,
    cognitoControlPlaneRttMs: { samples: rttSamples, average: avgRtt },
    estimatedEightUserImportMs: estimatedCreateMs,
    estimatedEightUserImportNote: 'No AdminCreateUser. Estimate is 8 users × 2 control-plane calls (create + set password) at measured DescribeUserPoolClient RTT.',
    listedProductionUsers: (listed.Users || []).length,
  };
};

const main = async () => {
  if (process.argv.includes('--apply') || process.argv.includes('--apply-checksops-ddl')) {
    console.error(JSON.stringify({ ok: false, error: 'refusing_cutover_apply' }));
    process.exit(2);
  }
  await mkdir(ARTIFACT_DIR, { recursive: true });
  await mkdir(REPORT_DIR, { recursive: true });
  await assumeIfNeeded();
  log({ step: 'safety_start', rehearsalDatabase: REHEARSAL_DB });
  const safety = await safetyPreflight();
  log({ step: 'safety_done', ok: safety.ok, blocked: safety.blocked });
  if (!safety.ok) {
    await writeFile(path.join(REPORT_DIR, 'write_freeze_timing.json'), JSON.stringify({ ok: false, safety }, null, 2));
    process.exit(1);
  }

  const identity = await identityPrep();
  log({ step: 'identity_prep_done', imported: false, estimatedMs: identity.estimatedEightUserImportMs });

  const env = {
    ...process.env,
    REHEARSAL_DB,
    RECONCILE_TO_LIVE: '1',
  };
  const dbLog = path.join(ARTIFACT_DIR, 'timed-db-rehearsal.log');
  const storageLog = path.join(ARTIFACT_DIR, 'timed-storage-rehearsal.log');
  const db = await spawnLogged(process.execPath, [path.join(ROOT, 'aws/db-copy/rehearsal/scripts/bridge-db-rehearsal.mjs')], dbLog, env);
  await assumeRole();
  const storageEnv = { ...process.env, RECONCILE_TO_LIVE: '1' };
  const storage = await spawnLogged(process.execPath, [path.join(ROOT, 'aws/db-copy/rehearsal/scripts/bridge-storage-copy.mjs')], storageLog, storageEnv);

  const dbEvents = parseProgress(fs.readFileSync(dbLog, 'utf8'));
  const storageEvents = parseProgress(fs.readFileSync(storageLog, 'utf8'));
  const dbPhases = {
    assumeAndHealthMs: phaseMs(dbEvents, (e) => e.step === 'assume_aws', (e) => e.step === 'phase1_done'),
    captureIncludingBaselineMs: phaseMs(dbEvents, (e) => e.step === 'phase1_done', (e) => e.step === 'pack_lambda'),
    packLambdaMs: phaseMs(dbEvents, (e) => e.step === 'pack_lambda', (e) => e.step === 'lambda_restore'),
    restoreMs: phaseMs(dbEvents, (e) => e.step === 'lambda_restore', (e) => e.step === 'lambda_apply_delta'),
    overlayMs: phaseMs(dbEvents, (e) => e.step === 'lambda_apply_delta', (e) => e.step === 'lambda_reconcile'),
    reconcileMs: phaseMs(dbEvents, (e) => e.step === 'lambda_reconcile', (e) => e.step === 'reports_written'),
    wallMs: db.durationMs,
  };
  const storagePhases = {
    healthInventoryMs: phaseMs(storageEvents, (e) => e.phase === 'health', (e) => e.phase === 's3_before'),
    copyAndVerifyMs: phaseMs(storageEvents, (e) => e.phase === 's3_before', (e) => e.phase === 'done'),
    wallMs: storage.durationMs,
  };

  const report = {
    generatedAt: new Date().toISOString(),
    productionFrozen: false,
    productionSupabaseChanged: false,
    productionCutoverPerformed: false,
    identityImported: false,
    dnsChanged: false,
    flagsChanged: false,
    bridgesRemoved: false,
    rehearsalDatabase: REHEARSAL_DB,
    safety,
    identity,
    db: { exitCode: db.code, log: dbLog, phases: dbPhases },
    storage: { exitCode: storage.code, log: storageLog, phases: storagePhases },
    totals: {
      measuredWallMs: Date.now() - ORIGIN,
      dbWallMs: db.durationMs,
      storageWallMs: storage.durationMs,
      identityEstimatedMs: identity.estimatedEightUserImportMs,
    },
  };
  await writeFile(path.join(REPORT_DIR, 'write_freeze_timing.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(ARTIFACT_DIR, 'write_freeze_timing.json'), `${JSON.stringify(report, null, 2)}\n`);
  log({ step: 'done', dbCode: db.code, storageCode: storage.code, dbWallMs: db.durationMs, storageWallMs: storage.durationMs });
  process.exit(db.code === 0 && storage.code === 0 ? 0 : 1);
};

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error.message || error).slice(0, 400) }));
  process.exit(1);
});
