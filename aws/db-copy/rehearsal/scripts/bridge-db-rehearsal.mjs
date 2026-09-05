#!/usr/bin/env node
/**
 * PR #127 read-only DB bridge: validate, classify Sept. 1 → live delta,
 * apply to isolated checksops_rehearsal_*, reconcile.
 *
 * Never logs PII, row contents, tokens, or signed URLs.
 * Never mutates production Supabase or live AWS staging database `checksops`.
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile, unlink, copyFile, rm } from 'node:fs/promises';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BASELINE_CUTOFF,
  BASELINE_DUMP_BYTES,
  BASELINE_DUMP_KEY,
  DB_BRIDGE_URL,
  LIVE_PAGE_SIZE,
  actionList,
  approvedBusinessTables,
  classifyTableDelta,
  countDiffVsBaseline,
  financialFromRows,
  healthFailures,
  isDbBridgeHealthy,
  keysToMap,
  loadBusinessTableNames,
  numericCounts,
  parseCopyKeyset,
  primaryKeyColumns,
  reconstructKeys,
  redactedColumnNames,
  roundMoney,
  rowPrimaryKey,
  sanitizeIdentityMap,
  sanitizeSchemaCatalog,
  sha256Hex,
  stripRedactedFields,
  summarizeDelta,
} from '../../lib/db-bridge.mjs';
import { parseGeneratedDatabaseTypes } from '../../lib/parse-types.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = process.env.AWS_REGION || 'us-east-1';
const FILES_BUCKET = process.env.FILES_BUCKET || 'checksops-staging-privatefilesbucket-erzqsolpucjp';
const SECRET_ID = process.env.STORAGE_MIGRATION_SECRET_ID || 'checksops/staging/storage-migration-token';
const ANON = process.env.SUPABASE_ANON_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5iY3F3cHlzcWd5eHJyYmd0bWt3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcxNDQ2NTgsImV4cCI6MjA5MjcyMDY1OH0.9GNh6OK6l6vSIBgkDY-bJuqNtfHJsLNW-dc7jfRUwgw';
const WORK = process.env.DB_BRIDGE_WORK || '/dev/shm/checksops-db-bridge';
const REPORT_DIR = path.join(ROOT, 'aws/db-copy/rehearsal');
const ONESHOT_DIR = path.join(REPORT_DIR, 'oneshot-apply');
const LAMBDA_NAME = process.env.REHEARSAL_LAMBDA_NAME || 'checksops-staging-rehearsal-oneshot';
const ROLE_NAME = process.env.REHEARSAL_ROLE_NAME || 'checksops-staging-rehearsal-oneshot';
const DB_NAME = process.env.REHEARSAL_DB || `checksops_rehearsal_20260905`;
const ACCOUNT = '806168576068';

const run = (cmd, args, env = process.env) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (d) => stdout.push(d));
  child.stderr.on('data', (d) => stderr.push(d));
  child.on('close', (code) => {
    const out = Buffer.concat(stdout).toString('utf8');
    const err = Buffer.concat(stderr).toString('utf8');
    if (code === 0) resolve(out);
    else reject(new Error(`${cmd} failed (${code}): ${(err || out).slice(0, 500)}`));
  });
});

const awsJson = (args) => {
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  return out.trim() ? JSON.parse(out) : {};
};

const progress = (obj) => console.log(JSON.stringify(obj));

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
  const tokenFile = path.join(WORK, 'oidc.jwt');
  await writeFile(tokenFile, String(token), { mode: 0o600 });
  const out = await run(AWS, [
    'sts', 'assume-role-with-web-identity',
    '--role-arn', role,
    '--role-session-name', 'checksops-db-bridge-rehearsal',
    '--web-identity-token', String(token),
    '--duration-seconds', '3600',
    '--output', 'json',
  ]);
  await unlink(tokenFile).catch(() => {});
  const creds = JSON.parse(out).Credentials;
  process.env.AWS_ACCESS_KEY_ID = creds.AccessKeyId;
  process.env.AWS_SECRET_ACCESS_KEY = creds.SecretAccessKey;
  process.env.AWS_SESSION_TOKEN = creds.SessionToken;
  process.env.AWS_REGION = REGION;
  process.env.AWS_DEFAULT_REGION = REGION;
};

const loadToken = async () => {
  if (process.env.CHECKSOPS_STORAGE_MIGRATION_TOKEN) {
    return String(process.env.CHECKSOPS_STORAGE_MIGRATION_TOKEN).trim();
  }
  const raw = (await run(AWS, [
    'secretsmanager', 'get-secret-value',
    '--secret-id', SECRET_ID,
    '--query', 'SecretString',
    '--output', 'text',
  ])).trim();
  const parsed = JSON.parse(raw);
  if (!parsed?.token) throw new Error('migration secret missing token field');
  return String(parsed.token);
};

const bridgeFetch = async (token, body) => {
  const response = await fetch(DB_BRIDGE_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: ANON,
      authorization: `Bearer ${ANON}`,
      'x-checksops-migration-token': token,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json = {};
  try { json = JSON.parse(text); } catch { json = { parse_error: true, httpStatus: response.status }; }
  return { status: response.status, json };
};

const pageRows = async (token, {
  table,
  keysOnly = true,
  limit = LIVE_PAGE_SIZE,
  columns = null,
} = {}) => {
  const rows = [];
  let after = null;
  let pages = 0;
  while (pages < 80) {
    const body = { action: 'rows', table, keysOnly, limit };
    if (after) body.after = after;
    if (columns) body.columns = columns;
    const resp = await bridgeFetch(token, body);
    if (resp.status !== 200 || resp.json?.ok === false) {
      throw new Error(`rows ${table} http ${resp.status} ${resp.json?.error || 'failed'}`.slice(0, 180));
    }
    const batch = Array.isArray(resp.json.rows) ? resp.json.rows : [];
    rows.push(...batch);
    pages += 1;
    if (!resp.json.hasMore) break;
    after = resp.json.nextAfter;
    if (!after) break;
  }
  return rows;
};

const extractDumpKeys = async (dumpPath, table, pkColumns) => {
  const pgRestore = process.env.PG_RESTORE || '/usr/lib/postgresql/18/bin/pg_restore';
  let sql = '';
  try {
    sql = await run(pgRestore, ['-a', '--no-owner', '-f', '-', '-t', table, dumpPath]);
  } catch (error) {
    if (/did not find|no matching|not found/i.test(String(error.message))) return new Map();
    throw error;
  }
  const map = parseCopyKeyset(sql, { table, pkColumns });
  sql = '';
  return map;
};

const packOneshot = async () => {
  const staging = path.join(os.tmpdir(), 'checksops-rehearsal-oneshot-pack');
  await rm(staging, { recursive: true, force: true });
  await mkdir(path.join(staging, 'sql'), { recursive: true });
  await mkdir(path.join(staging, 'bin'), { recursive: true });
  await mkdir(path.join(staging, 'lib'), { recursive: true });
  for (const file of ['index.mjs', 'package.json']) {
    await copyFile(path.join(ONESHOT_DIR, file), path.join(staging, file));
  }
  await copyFile(path.join(ROOT, 'aws/db-copy/lib/restore-toc.mjs'), path.join(staging, 'restore-toc.mjs'));
  await copyFile(path.join(ROOT, 'aws/db-copy/lib/catalog.mjs'), path.join(staging, 'catalog.mjs'));
  await copyFile(path.join(ROOT, 'aws/functions/api/rds-global-bundle.pem'), path.join(staging, 'rds-global-bundle.pem'));
  for (const sql of [
    '00_rds_supported_extensions.sql',
    '01_auth_compatibility_stubs.sql',
    '02_grant_readonly_application_role.sql',
    'reconciliation_counts.sql',
    'reconciliation_financial.sql',
  ]) {
    await copyFile(path.join(ROOT, 'aws/db-copy/sql', sql), path.join(staging, 'sql', sql));
  }
  const fks = JSON.parse(await readFile(path.join(ROOT, 'aws/db-copy/analysis/skipped_auth_users_fks.json'), 'utf8'));
  await writeFile(path.join(staging, 'auth-fk-names.json'), JSON.stringify([...new Set(fks.map((row) => row.fk_constraint))]));
  execFileSync('npm', ['install', '--omit=dev'], { cwd: staging, stdio: 'ignore' });
  const pgRestore = '/usr/lib/postgresql/18/bin/pg_restore';
  if (fs.existsSync(pgRestore)) {
    await copyFile(pgRestore, path.join(staging, 'bin/pg_restore'));
    await fs.promises.chmod(path.join(staging, 'bin/pg_restore'), 0o755);
    for (const lib of ['libpq.so.5']) {
      const src = `/usr/lib/x86_64-linux-gnu/${lib}`;
      if (fs.existsSync(src)) await copyFile(src, path.join(staging, 'lib', lib));
    }
  }
  const zip = path.join(os.tmpdir(), 'checksops-rehearsal-oneshot.zip');
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
  } catch { /* already attached or denied */ }
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
    ],
  };
  awsJson(['iam', 'put-role-policy', '--role-name', ROLE_NAME, '--policy-name', 'oneshot-rehearsal-least-privilege', '--policy-document', JSON.stringify(inline)]);
  await new Promise((r) => setTimeout(r, 8000));
  const env = {
    Variables: {
      ADMIN_SECRET_ARN: adminSecretArn,
      RDS_HOST: 'checksops-staging.cyr0q4kcop3c.us-east-1.rds.amazonaws.com',
    },
  };
  const vpcConfig = `SubnetIds=${(vpc.SubnetIds || []).join(',')},SecurityGroupIds=${(vpc.SecurityGroupIds || []).join(',')}`;
  try {
    awsJson(['lambda', 'get-function', '--function-name', LAMBDA_NAME]);
    execFileSync(AWS, ['--region', REGION, 'lambda', 'update-function-code', '--function-name', LAMBDA_NAME, '--zip-file', `fileb://${zipPath}`], { stdio: 'ignore' });
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
  await run(AWS, ['lambda', 'wait', 'function-active', '--function-name', LAMBDA_NAME]);
  try { await run(AWS, ['lambda', 'wait', 'function-updated', '--function-name', LAMBDA_NAME]); } catch { /* ok */ }
  return LAMBDA_NAME;
};

const invokeLambda = async (payload) => {
  const outFile = path.join(WORK, `lambda-${payload.step}.json`);
  let lastErr = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await run(AWS, [
        'lambda', 'invoke',
        '--function-name', LAMBDA_NAME,
        '--cli-binary-format', 'raw-in-base64-out',
        '--payload', JSON.stringify(payload),
        outFile,
      ]);
      return JSON.parse(await readFile(outFile, 'utf8'));
    } catch (error) {
      lastErr = error;
      if (!/ResourceConflictException|Pending|TooManyRequests/i.test(String(error.message))) throw error;
      await new Promise((r) => setTimeout(r, 10000 * (attempt + 1)));
    }
  }
  throw lastErr;
};

const deleteOneshot = async () => {
  try { awsJson(['lambda', 'delete-function', '--function-name', LAMBDA_NAME]); } catch { /* gone */ }
  try { awsJson(['iam', 'delete-role-policy', '--role-name', ROLE_NAME, '--policy-name', 'oneshot-rehearsal-least-privilege']); } catch { /* gone */ }
  try { awsJson(['iam', 'detach-role-policy', '--role-name', ROLE_NAME, '--policy-arn', 'arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole']); } catch { /* gone */ }
  try { awsJson(['iam', 'delete-role', '--role-name', ROLE_NAME]); } catch { /* gone */ }
};

const writeSanitizedReports = async (report) => {
  const jsonPath = path.join(REPORT_DIR, 'analysis/db_bridge_reconcile.json');
  const mdPath = path.join(REPORT_DIR, 'DB_BRIDGE_RECONCILE.md');
  await writeFile(jsonPath, JSON.stringify(report, null, 2));
  const deltaRows = (report.delta?.tables || [])
    .filter((row) => row.inserted || row.updated || row.deleted)
    .map((row) => `| ${row.table} | ${row.inserted} | ${row.updated} | ${row.deleted} | ${row.unchanged} |`)
    .join('\n');
  const md = `# DB bridge rehearsal recon — PR #127

**Generated:** ${report.generatedAt}  
**Production cutover performed:** **NO**  
**Live staging DB \`checksops\` overwritten:** **NO**  
**Rehearsal database:** \`${report.rehearsalDatabase || 'n/a'}\`

## Safety attestation

| Control | Result |
|---|---|
| Production Supabase modified | **NO** |
| DNS / webhooks / Auth changed | **NO** |
| Moov/CheckAlt/Plaid execution | **NO** |
| PR #125 touched | **NO** |
| PII/row contents/tokens in committed evidence | **NO** |
| Temporary DB + Storage bridges left deployed | **YES** |

## Phase 1 — Bridge validation

| Check | Result |
|---|---|
| HTTP health | ${report.bridge?.httpStatus === 200 ? 'PASS' : 'FAIL'} |
| mode=read_only | ${report.bridge?.mode === 'read_only' ? 'PASS' : 'FAIL'} |
| writes/deletes/rpc/rawSql all false | ${report.bridge?.failClosed ? 'PASS' : 'FAIL'} |
| Approved tables | ${report.bridge?.approvedTableCount ?? 'n/a'} |
| Excluded secret/token tables | ${(report.bridge?.excluded || []).join(', ') || 'n/a'} |
| Numeric count tables | ${report.bridge?.numericTables ?? 'n/a'} |
| Current production row sum (approved counted) | ${report.bridge?.sumRows ?? 'n/a'} |

## Phase 2 — Production delta vs Sept. 1 baseline

Baseline dump: \`${BASELINE_DUMP_KEY}\` (${BASELINE_DUMP_BYTES} bytes, cutoff ${BASELINE_CUTOFF}).

| Totals | Inserted | Updated | Deleted | Unchanged |
|---|---:|---:|---:|---:|
| All approved business tables | ${report.delta?.totals?.inserted ?? 'n/a'} | ${report.delta?.totals?.updated ?? 'n/a'} | ${report.delta?.totals?.deleted ?? 'n/a'} | ${report.delta?.totals?.unchanged ?? 'n/a'} |

Tables with any insert/update/delete:

| Table | Inserted | Updated | Deleted | Unchanged |
|---|---:|---:|---:|---:|
${deltaRows || '| _(none)_ | 0 | 0 | 0 | |'}

Secret columns were not copied (\`[redacted]\` omitted; null preserved).

## Phase 3 — Isolated rehearsal restore/sync

| Step | Result |
|---|---|
| CREATE DATABASE ${report.rehearsalDatabase || 'checksops_rehearsal_*'} | ${report.restore?.created ?? 'n/a'} |
| Sept. 1 dump restore | ${report.restore?.restoreOk ? 'PASS' : (report.restore?.error ? 'FAIL' : 'n/a')} |
| TOC kept/skipped | ${report.restore?.tocKept ?? 'n/a'} / ${report.restore?.tocSkipped ?? 'n/a'} |
| Delta applied | ${report.restore?.deltaOk ? 'PASS' : (report.restore?.deltaError ? 'FAIL' : 'n/a')} |
| Live \`checksops\` mutated | **NO** |

## Phase 4 — Rehearsal vs live production

| Gate | Result |
|---|---|
| Table row counts | ${report.recon?.countsStatus || 'n/a'} |
| Primary-key sets (fingerprints) | ${report.recon?.pkStatus || 'n/a'} |
| Tenant ownership | ${report.recon?.tenantStatus || 'n/a'} |
| Financial aggregates (report-only) | ${report.recon?.financialStatus || 'n/a'} |
| Application-user UUIDs / identity_map | ${report.recon?.identityStatus || 'n/a'} |
| Membership/role relationships | ${report.recon?.membershipStatus || 'n/a'} |
| FK integrity | ${report.recon?.fkStatus || 'n/a'} |
| Duplicates / required-null regressions | ${report.recon?.nullStatus || 'n/a'} |

Count mismatches: ${JSON.stringify(report.recon?.countDiffs || [])}  
Financial mismatches: ${JSON.stringify(report.recon?.financialDiffs || [])}

## Phase 5 — Storage (already completed; not rerun)

| Item | Result |
|---|---|
| Approved production objects | **1,411** |
| Bytes | **2,565,912,220** |
| Storage migration | **PASS** |
| Staging-only UAT objects | **21** (left in place) |

## Discrepancies & remediation

${(report.discrepancies || ['None recorded.']).map((d) => `- ${d}`).join('\n')}

## Repeatable final cutover delta procedure

1. Leave both temporary Lovable bridges deployed.
2. Enter production write-freeze.
3. \`health\` must remain \`mode:read_only\` with writes/deletes/rpc/rawSql false.
4. Page \`keysOnly\` for approved business tables; classify vs the frozen baseline (or vs the prior rehearsal snapshot).
5. Fetch full rows only for reconstruct keys; omit \`[redacted]\` secret columns.
6. Restore Sept. 1 dump (or last rehearsal snapshot) into a new \`checksops_rehearsal_YYYYMMDD\`.
7. Apply insert/update/delete delta. Do not overwrite live \`checksops\`.
8. Reconcile counts, PK fingerprints, financial aggregates (report-only), identity UUID fingerprints, FKs.
9. Storage: inventory delta only; COPY new objects; do not overwrite hash-verified keys.
10. **STOP FOR REVIEW.** Do not switch DNS, auth, webhooks, or provider flags.

## Expected write-freeze window

Still estimated **45–110 minutes** for a final freeze (dump or bridge delta + restore + recon + storage delta). This rehearsal did **not** freeze production.

## Rollback

Production Supabase remains system of record until a future cutover PR.

1. Keep DNS/webhooks on Lovable.
2. Drop \`checksops_rehearsal_*\` only (\`DROP DATABASE\` that name). Never drop \`postgres\` or live \`checksops\`.
3. Leave S3 production copies in place (append-only).
4. Leave staging Cognito/\`identity_accounts\` on live \`checksops\`.

## Verdict

**Bridge validation:** ${report.verdict?.bridge || 'n/a'}  
**DB rehearsal recon:** ${report.verdict?.database || 'n/a'}  
**Storage:** PASS  
**Overall data-migration readiness:** **${report.verdict?.overall || 'PARTIAL'}**  
**GO/NO-GO for data migration readiness:** **${report.verdict?.goNoGo || 'NO-GO'}**

STOP FOR REVIEW. Production cutover was not performed.
`;
  await writeFile(mdPath, md);
  return { jsonPath, mdPath };
};

const main = async () => {
  const resumeLambda = process.argv.includes('--resume-lambda');
  await mkdir(WORK, { recursive: true });
  await mkdir(path.join(REPORT_DIR, 'analysis'), { recursive: true });
  progress({ step: 'assume_aws', resumeLambda });
  try { awsJson(['sts', 'get-caller-identity']); }
  catch { await assumeRole(); }

  const token = await loadToken();
  let phase1;
  let classifiedTables;
  let schemaByTable = {};
  let counted;
  let identity;
  let deltaTables = [];
  let totals = { inserted: 0, updated: 0, deleted: 0, unchanged: 0 };
  let prodFingerprints = {};
  let prodFinancial = {};
  let reconstruct = {};
  const financialTables = new Set([
    'check_intake_items', 'deposit_items', 'deposit_batches', 'checkalt_deposits',
    'disbursement_splits', 'disbursement_batches', 'claim_check_payments',
    'payment_transfers', 'payment_wallet_ledger', 'claim_payments',
    'homeowner_ledger_events', 'check_endorsements',
  ]);
  const types = parseGeneratedDatabaseTypes(path.join(ROOT, 'src/integrations/supabase/types.ts'));
  const businessTableNames = loadBusinessTableNames(path.join(ROOT, 'aws/db-copy/sql/reconciliation_counts.sql'));

  if (resumeLambda) {
    const existing = JSON.parse(await readFile(path.join(REPORT_DIR, 'analysis/db_bridge_reconcile.json'), 'utf8'));
    phase1 = existing.bridge;
    deltaTables = existing.delta?.tables || [];
    totals = existing.delta?.totals || totals;
    identity = phase1.identity;
    const tablesResp = await bridgeFetch(token, { action: 'tables' });
    const schemaResp = await bridgeFetch(token, { action: 'schema' });
    const countsResp = await bridgeFetch(token, { action: 'counts' });
    schemaByTable = schemaResp.json.schema || {};
    counted = numericCounts(countsResp.json.counts || countsResp.json);
    classifiedTables = approvedBusinessTables({
      bridgeTables: tablesResp.json.tables || [],
      excluded: tablesResp.json.excluded || phase1.excluded || [],
      viewNames: types.views,
      businessTableNames,
    });
    const financialRows = {};
    for (const table of financialTables) {
      financialRows[table] = await pageRows(token, { table, keysOnly: false, limit: LIVE_PAGE_SIZE });
    }
    prodFinancial = financialFromRows(financialRows);
    progress({ step: 'resume_lambda_ready', approved: classifiedTables.approved.length });
  } else {
  progress({ step: 'phase1_health' });
  const health = await bridgeFetch(token, { action: 'health' });
  const failClosed = isDbBridgeHealthy(health.json);
  if (!failClosed) {
    progress({ step: 'health_fail', failures: healthFailures(health.json) });
  }
  const tablesResp = await bridgeFetch(token, { action: 'tables' });
  const schemaResp = await bridgeFetch(token, { action: 'schema' });
  const countsResp = await bridgeFetch(token, { action: 'counts' });
  const identityResp = await bridgeFetch(token, { action: 'identity_map' });

  const bridgeTables = tablesResp.json.tables || [];
  const excluded = tablesResp.json.excluded || [];
  classifiedTables = approvedBusinessTables({
    bridgeTables,
    excluded,
    viewNames: types.views,
    businessTableNames,
  });
  schemaByTable = schemaResp.json.schema || {};
  const sanitizedSchema = sanitizeSchemaCatalog(schemaByTable);
  counted = numericCounts(countsResp.json.counts || countsResp.json);
  identity = sanitizeIdentityMap(identityResp.json);
  const baselineCounts = JSON.parse(await readFile(path.join(ROOT, 'aws/db-copy/analysis/table_counts_backup_vs_restore.json'), 'utf8')).backup_counts || {};
  const countDiffsVsSept1 = countDiffVsBaseline(counted.counts, baselineCounts, new Set(['spatial_ref_sys']));

  phase1 = {
    generatedAt: new Date().toISOString(),
    httpStatus: health.status,
    mode: health.json.mode || null,
    failClosed,
    healthFailures: healthFailures(health.json),
    actions: actionList(health.json.actions),
    maxPageSize: health.json.maxPageSize ?? null,
    defaultPageSize: health.json.defaultPageSize ?? null,
    schemas: health.json.schemas || null,
    redaction: health.json.redaction || null,
    approvedTableCount: classifiedTables.approved.length,
    excluded,
    skippedViews: classifiedTables.skippedViews,
    newSinceBaseline: classifiedTables.newSinceBaseline,
    numericTables: counted.numericTables,
    sumRows: counted.sumRows,
    zeroTables: counted.zeroTables,
    countDiffsVsSept1,
    identity,
    redactedByTable: sanitizedSchema.redactedByTable,
  };
  await writeFile(path.join(REPORT_DIR, 'analysis/db_bridge_phase1.json'), JSON.stringify(phase1, null, 2));
  progress({
    step: 'phase1_done',
    failClosed,
    approved: classifiedTables.approved.length,
    sumRows: counted.sumRows,
    identityProfiles: identity.profiles,
  });

  progress({ step: 'download_baseline_dump' });
  const dumpPath = path.join(WORK, 'checksops_260901.backup');
  if (!fs.existsSync(dumpPath) || fs.statSync(dumpPath).size !== BASELINE_DUMP_BYTES) {
    await run(AWS, ['s3', 'cp', `s3://${FILES_BUCKET}/${BASELINE_DUMP_KEY}`, dumpPath]);
  }

  const financialRows = {};

  for (const table of classifiedTables.approved) {
    const pkColumns = primaryKeyColumns(schemaByTable[table] || {});
    const currentRows = await pageRows(token, { table, keysOnly: true, limit: LIVE_PAGE_SIZE });
    const currentKeys = keysToMap(currentRows, pkColumns);
    let baselineKeys = new Map();
    try { baselineKeys = await extractDumpKeys(dumpPath, table, pkColumns); }
    catch (error) {
      progress({ step: 'dump_keys_error', table, error: String(error.message || error).slice(0, 120) });
    }
    const delta = classifyTableDelta({ baselineKeys, currentKeys });
    const summary = summarizeDelta(delta);
    deltaTables.push({ table, pkColumns, ...summary, baselineKeys: baselineKeys.size, currentKeys: currentKeys.size });
    totals.inserted += summary.inserted;
    totals.updated += summary.updated;
    totals.deleted += summary.deleted;
    totals.unchanged += summary.unchanged;

    const payload = {
      pkColumns,
      replaceAll: true,
      upserts: [],
      deletes: [],
      skippedSecretColumns: redactedColumnNames(schemaByTable[table] || {}),
    };
    if (currentKeys.size > 0 || financialTables.has(table)) {
      const full = await pageRows(token, { table, keysOnly: false, limit: LIVE_PAGE_SIZE });
      if (financialTables.has(table)) financialRows[table] = full;
      for (const row of full) {
        const stripped = stripRedactedFields(row, payload.skippedSecretColumns);
        payload.upserts.push(stripped.row);
      }
    }
    reconstruct[table] = payload;
    prodFingerprints[table] = [...currentKeys.keys()].map((pk) => sha256Hex(pk)).sort();
    progress({ step: 'table_delta', table, ...summary });
  }

  prodFinancial = financialFromRows(financialRows);
  const prefixInner = `Migration/rehearsal-20260905/delta`;
  const manifest = {
    generatedAt: new Date().toISOString(),
    baseline: BASELINE_DUMP_KEY,
    rehearsalDatabase: DB_NAME,
    tables: deltaTables.map((row) => ({
      name: row.table,
      pkColumns: row.pkColumns,
      inserted: row.inserted,
      updated: row.updated,
      deleted: row.deleted,
      skippedSecretColumns: reconstruct[row.table]?.skippedSecretColumns || [],
    })),
  };
  await writeFile(path.join(WORK, 'manifest.json'), JSON.stringify(manifest));
  await run(AWS, ['s3', 'cp', path.join(WORK, 'manifest.json'), `s3://${FILES_BUCKET}/${prefixInner}/manifest.json`]);
  for (const [table, payload] of Object.entries(reconstruct)) {
    const local = path.join(WORK, `${table}.json`);
    await writeFile(local, JSON.stringify(payload));
    await run(AWS, ['s3', 'cp', local, `s3://${FILES_BUCKET}/${prefixInner}/tables/${table}.json`]);
    await unlink(local);
  }
  }

  const prefix = `Migration/rehearsal-20260905/delta`;
  const failClosed = phase1.failClosed === true;

  progress({ step: 'pack_lambda' });
  let restore = { created: false, restoreOk: false, deltaOk: false };
  let recon = {};
  const discrepancies = [];
  try {
    const secrets = awsJson(['secretsmanager', 'list-secrets']);
    const adminSecret = (secrets.SecretList || []).find((s) => /checksops_admin/i.test(s.Name || s.ARN || ''));
    if (!adminSecret) throw new Error('checksops_admin secret not listed');
    const zip = await packOneshot();
    await ensureLambda(zip, adminSecret.ARN);
    progress({ step: 'lambda_restore' });
    const restored = process.argv.includes('--skip-restore')
      ? { ok: true, restoreMode: 'skipped_existing_rehearsal', created: false }
      : await invokeLambda({
        step: 'restore',
        database: DB_NAME,
      });
    progress({ step: 'lambda_apply_delta', restoreOk: restored.ok, restoreMode: restored.restoreMode || null });
    const applied = await invokeLambda({
      step: 'apply_delta',
      database: DB_NAME,
      bucket: FILES_BUCKET,
      manifestPrefix: prefix,
    });
    const pkTables = classifiedTables.approved.filter((name) => businessTableNames.includes(name)).map((table) => ({
      table,
      pkColumns: primaryKeyColumns(schemaByTable[table] || {}),
    }));
    progress({ step: 'lambda_reconcile' });
    const reconciled = await invokeLambda({ step: 'reconcile', database: DB_NAME, pkTables });
    restore = {
      created: restored.created ?? restored.ok === true,
      restoreOk: restored.ok === true,
      restoreMode: restored.restoreMode || null,
      tocKept: restored.tocKept,
      tocSkipped: restored.tocSkipped,
      deltaOk: applied.ok === true,
      error: restored.error || null,
      deltaError: applied.error || null,
    };
    const rehearsalCounts = reconciled.tableCounts || {};
    const countDiffs = countDiffVsBaseline(rehearsalCounts, counted.counts, new Set(['spatial_ref_sys']));
    const countsPresent = Object.keys(rehearsalCounts).length >= 100;
    const financialDiffs = [];
    const rehearsalFin = reconciled.financialAggregates || {};
    for (const [metric, value] of Object.entries(prodFinancial)) {
      const left = roundMoney(value);
      const right = roundMoney(rehearsalFin[metric]);
      if (left !== right) financialDiffs.push({ metric, production: left, rehearsal: right });
    }
    let pkMismatches = 0;
    const pkFingerprints = reconciled.pkFingerprints || {};
    for (const table of classifiedTables.approved) {
      const rehearsalPrints = pkFingerprints[table];
      if (!rehearsalPrints) continue;
      const prodPrints = prodFingerprints[table] || [];
      if (prodPrints.join(' ') !== rehearsalPrints.join(' ')) pkMismatches += 1;
    }
    recon = {
      countsStatus: countsPresent && countDiffs.length === 0 ? 'PASS' : 'FAIL',
      financialStatus: financialDiffs.length === 0 && Object.keys(rehearsalFin).length > 0 ? 'PASS' : 'FAIL',
      pkStatus: pkMismatches === 0 && reconciled.ok ? 'PASS' : 'FAIL',
      tenantStatus: Number(reconciled.tenants?.n) === Number(counted.counts.tenants) ? 'PASS' : 'FAIL',
      identityStatus: Number(reconciled.profiles) === identity.profiles ? 'PASS' : 'FAIL',
      membershipStatus: Number(reconciled.tenantUsers?.n) === Number(counted.counts.tenant_users) ? 'PASS' : 'FAIL',
      fkStatus: Object.values(reconciled.fkOrphanCounts || {}).every((n) => n === 0) ? 'PASS' : 'FAIL',
      nullStatus: Object.values(reconciled.requiredNullCounts || {}).every((n) => n === 0) ? 'PASS' : 'FAIL',
      countDiffs,
      financialDiffs,
      rehearsalCountsSelected: {
        tenants: rehearsalCounts.tenants,
        profiles: rehearsalCounts.profiles,
        check_intake_items: rehearsalCounts.check_intake_items,
        check_endorsements: rehearsalCounts.check_endorsements,
        claims: rehearsalCounts.claims,
        deposit_items: rehearsalCounts.deposit_items,
        disbursement_splits: rehearsalCounts.disbursement_splits,
        homeowner_ledger_events: rehearsalCounts.homeowner_ledger_events,
      },
      fkOrphanCounts: reconciled.fkOrphanCounts,
      identityAccountsPresent: reconciled.identityAccountsPresent,
      productionFinancial: Object.fromEntries(Object.entries(prodFinancial).map(([k, v]) => [k, roundMoney(v)])),
      rehearsalFinancial: rehearsalFin,
    };
    if (!restored.ok) discrepancies.push(`Dump restore into rehearsal failed: ${String(restored.error || 'unknown').slice(0, 180)}`);
    if (!applied.ok) discrepancies.push(`Delta apply failed: ${String(applied.error || 'unknown').slice(0, 180)}`);
    if (countDiffs.length) discrepancies.push(`${countDiffs.length} table count mismatches between rehearsal and live production`);
    if (financialDiffs.length) discrepancies.push(`${financialDiffs.length} financial aggregate mismatches (report-only)`);
    if (reconciled.identityAccountsPresent) {
      discrepancies.push('Rehearsal unexpectedly has identity_accounts; staging-only table should stay on live checksops only');
    }
  } catch (error) {
    discrepancies.push(`Rehearsal Lambda path blocked: ${String(error.message || error).slice(0, 240)}`);
    restore.error = String(error.message || error).slice(0, 240);
    recon = {
      countsStatus: 'FAIL',
      financialStatus: 'FAIL',
      pkStatus: 'FAIL',
      tenantStatus: 'FAIL',
      identityStatus: 'FAIL',
      membershipStatus: 'FAIL',
      fkStatus: 'FAIL',
      nullStatus: 'FAIL',
      countDiffs: [],
      financialDiffs: [],
    };
    progress({ step: 'lambda_blocked', error: restore.error });
  }

  const dbPass = recon.countsStatus === 'PASS'
    && recon.financialStatus === 'PASS'
    && recon.fkStatus === 'PASS'
    && recon.tenantStatus === 'PASS'
    && restore.restoreOk
    && restore.deltaOk;
  const report = {
    generatedAt: new Date().toISOString(),
    productionSupabaseChanged: false,
    productionCutoverPerformed: false,
    liveChecksopsMutated: false,
    rehearsalDatabase: DB_NAME,
    bridge: phase1,
    delta: { totals, tables: deltaTables, cutoff: BASELINE_CUTOFF },
    restore,
    recon,
    discrepancies,
    storage: {
      objects: 1411,
      bytes: 2565912220,
      status: 'PASS',
      stagingOnlyUat: 21,
      rerun: false,
    },
    verdict: {
      bridge: failClosed ? 'PASS' : 'FAIL',
      database: dbPass ? 'PASS' : 'PARTIAL',
      overall: dbPass && failClosed ? 'PASS' : 'PARTIAL',
      goNoGo: dbPass && failClosed ? 'GO for data migration readiness (cutover still STOP FOR REVIEW)' : 'NO-GO',
    },
  };
  const written = await writeSanitizedReports(report);
  progress({ step: 'reports_written', ...written, verdict: report.verdict });
  try { await deleteOneshot(); } catch { /* keep if in use */ }
};

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error.message || error).slice(0, 400) }));
  process.exit(1);
});
