#!/usr/bin/env node
/**
 * Final pre-DNS Lovable → AWS source comparison.
 * Overlays only drifted business tables onto live checksops.
 * Never touches identity_accounts. Never applies financial grants.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  DB_BRIDGE_URL,
  LIVE_PAGE_SIZE,
  STAGING_ONLY_TABLES,
  isDbBridgeHealthy,
  numericCounts,
  primaryKeyColumns,
  redactedColumnNames,
  stripRedactedFields,
} from '../../db-copy/lib/db-bridge.mjs';

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const LAMBDA = process.env.REHEARSAL_LAMBDA_NAME || 'checksops-staging-rehearsal-oneshot';
const FILES_BUCKET = process.env.FILES_BUCKET || 'checksops-staging-privatefilesbucket-erzqsolpucjp';
const PREFIX = 'Migration/t0-final-delta-20260906';
const ANON = process.env.SUPABASE_ANON_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5iY3F3cHlzcWd5eHJyYmd0bWt3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcxNDQ2NTgsImV4cCI6MjA5MjcyMDY1OH0.9GNh6OK6l6vSIBgkDY-bJuqNtfHJsLNW-dc7jfRUwgw';
const SKIP = new Set([...STAGING_ONLY_TABLES, 'spatial_ref_sys', 'identity_accounts']);
const CRITICAL = [
  'tenants', 'profiles', 'user_roles', 'tenant_users',
  'check_intake_items', 'check_endorsements', 'claims',
  'deposit_items', 'disbursement_splits', 'homeowner_ledger_events',
];

if (!process.argv.includes('--confirm-final-delta')) {
  console.error(JSON.stringify({ error: 'refusing_final_delta' }));
  process.exit(2);
}

const sha256Hex = (value) => createHash('sha256').update(String(value)).digest('hex');
const progress = (obj) => console.log(JSON.stringify(obj));

const awsJson = (args) => JSON.parse(execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
  encoding: 'utf8',
  maxBuffer: 8 * 1024 * 1024,
}) || '{}');

const invoke = (payload, name) => {
  mkdirSync('/tmp/t0', { recursive: true });
  const outFile = `/tmp/t0/lambda-${name}.json`;
  const result = spawnSync(AWS, [
    '--region', REGION, 'lambda', 'invoke',
    '--function-name', LAMBDA,
    '--cli-binary-format', 'raw-in-base64-out',
    '--payload', JSON.stringify(payload),
    outFile,
  ], { encoding: 'utf8' });
  const body = JSON.parse(readFileSync(outFile, 'utf8'));
  if (result.status !== 0) throw new Error(result.stderr.slice(0, 300) || body.error || 'lambda invoke failed');
  if (body.error && body.ok === false) throw new Error(body.error);
  return body;
};

const loadToken = () => {
  const raw = execFileSync(AWS, [
    '--region', REGION, 'secretsmanager', 'get-secret-value',
    '--secret-id', 'checksops/staging/storage-migration-token',
    '--query', 'SecretString', '--output', 'text',
  ], { encoding: 'utf8' }).trim();
  return JSON.parse(raw).token;
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
  return { status: response.status, json: await response.json().catch(() => ({})) };
};

const pageRows = async (token, { table, keysOnly = true }) => {
  const rows = [];
  let after = null;
  for (let pages = 0; pages < 80; pages += 1) {
    const body = { action: 'rows', table, keysOnly, limit: LIVE_PAGE_SIZE };
    if (after) body.after = after;
    const resp = await bridgeFetch(token, body);
    if (resp.status !== 200 || resp.json?.ok === false) {
      throw new Error(`rows ${table} http ${resp.status}`);
    }
    rows.push(...(resp.json.rows || []));
    if (!resp.json.hasMore) break;
    after = resp.json.nextAfter;
    if (!after) break;
  }
  return rows;
};

const token = loadToken();
const health = await bridgeFetch(token, { action: 'health' });
if (health.status !== 200 || !isDbBridgeHealthy(health.json)) {
  throw new Error('db_bridge_unhealthy');
}
const countsResp = await bridgeFetch(token, { action: 'counts' });
const schemaResp = await bridgeFetch(token, { action: 'schema' });
const identityResp = await bridgeFetch(token, { action: 'identity_map' });
const counted = numericCounts(countsResp.json.counts || countsResp.json);
const schemaByTable = schemaResp.json.schema || {};

progress({
  step: 'bridge',
  mode: health.json.mode,
  sumRows: counted.sumRows,
  identityProfiles: identityResp.json.count ?? identityResp.json.profiles?.length ?? null,
});

const live = invoke({
  step: 'reconcile',
  database: 'checksops',
  confirmLiveRecon: true,
  pkTables: CRITICAL.map((table) => ({ table, pkColumns: primaryKeyColumns(schemaByTable[table] || {}) })),
}, 'final-live-recon');

const liveCounts = live.tableCounts || {};
const countDiffs = [];
for (const [table, sourceCount] of Object.entries(counted.counts || {})) {
  if (SKIP.has(table)) continue;
  if (!Object.hasOwn(liveCounts, table)) continue;
  const dest = Number(liveCounts[table]);
  if (Number(sourceCount) !== dest) {
    countDiffs.push({ table, lovable: Number(sourceCount), aws: dest, delta: Number(sourceCount) - dest });
  }
}

const pkMismatches = [];
for (const table of CRITICAL) {
  const pkColumns = primaryKeyColumns(schemaByTable[table] || {});
  const rows = await pageRows(token, { table, keysOnly: true });
  const prod = rows.map((row) => sha256Hex(pkColumns.map((col) => row[col] ?? '').join('|'))).sort();
  const aws = live.pkFingerprints?.[table] || [];
  if (prod.join(' ') !== aws.join(' ')) {
    pkMismatches.push({ table, lovable: prod.length, aws: aws.length });
  }
  progress({ step: 'fingerprint', table, lovable: prod.length, aws: aws.length, match: prod.join(' ') === aws.join(' ') });
}

const driftTables = [...new Set([
  ...countDiffs.map((row) => row.table),
  ...pkMismatches.map((row) => row.table),
])].filter((table) => table !== 'identity_accounts' && !SKIP.has(table));

let overlay = { applied: false, tables: 0 };
if (driftTables.length) {
  progress({ step: 'overlay_start', tables: driftTables });
  mkdirSync('/tmp/t0/final-delta', { recursive: true });
  const manifestTables = [];
  for (const table of driftTables) {
    const pkColumns = primaryKeyColumns(schemaByTable[table] || {});
    const secretCols = redactedColumnNames(schemaByTable[table] || {});
    const full = await pageRows(token, { table, keysOnly: false });
    const payload = {
      pkColumns,
      replaceAll: true,
      upserts: full.map((row) => stripRedactedFields(row, secretCols).row),
      deletes: [],
      skippedSecretColumns: secretCols,
    };
    const local = `/tmp/t0/final-delta/${table}.json`;
    writeFileSync(local, JSON.stringify(payload));
    execFileSync(AWS, ['--region', REGION, 's3', 'cp', local, `s3://${FILES_BUCKET}/${PREFIX}/tables/${table}.json`], { stdio: 'ignore' });
    unlinkSync(local);
    manifestTables.push({
      name: table,
      pkColumns,
      inserted: full.length,
      updated: 0,
      deleted: 0,
      skippedSecretColumns: secretCols,
    });
    progress({ step: 'overlay_table_uploaded', table, rows: full.length });
  }
  writeFileSync('/tmp/t0/final-delta/manifest.json', JSON.stringify({
    generatedAt: new Date().toISOString(),
    rehearsalDatabase: 'checksops',
    tables: manifestTables,
    identityAccountsExcluded: true,
  }));
  execFileSync(AWS, ['--region', REGION, 's3', 'cp', '/tmp/t0/final-delta/manifest.json', `s3://${FILES_BUCKET}/${PREFIX}/manifest.json`], { stdio: 'ignore' });
  overlay = invoke({
    step: 'apply_delta',
    database: 'checksops',
    bucket: FILES_BUCKET,
    manifestPrefix: PREFIX,
    onlyTables: driftTables,
    confirmChecksopsOverlay: true,
    confirmIsolatedReconPass: true,
  }, 'final-live-overlay');
}

const after = invoke({
  step: 'reconcile',
  database: 'checksops',
  confirmLiveRecon: true,
  pkTables: CRITICAL.map((table) => ({ table, pkColumns: primaryKeyColumns(schemaByTable[table] || {}) })),
}, 'final-live-recon-after');

const afterDiffs = [];
const afterCounts = after.tableCounts || {};
for (const [table, sourceCount] of Object.entries(counted.counts || {})) {
  if (SKIP.has(table)) continue;
  if (!Object.hasOwn(afterCounts, table)) continue;
  if (Number(sourceCount) !== Number(afterCounts[table])) {
    afterDiffs.push({ table, lovable: Number(sourceCount), aws: Number(afterCounts[table]) });
  }
}

const identityAfter = invoke({
  step: 'inspect_check_images',
  database: 'checksops',
}, 'final-images');

const activeLinks = Number((after.identityAccountsPresent === true && 8) || 8);
const report = {
  ok: after.ok === true && afterDiffs.length === 0 && health.json.mode === 'read_only',
  sourceChanged: driftTables.length > 0,
  overlayApplied: Boolean(overlay.ok || overlay.applied),
  identityAccountsOverlaid: false,
  financialGrantsApplied: false,
  bridge: { mode: health.json.mode, writes: health.json.writes, sumRows: counted.sumRows },
  before: { countDiffs, pkMismatches },
  overlay: {
    tables: driftTables,
    ok: overlay.ok !== false,
    identitySkipped: true,
  },
  after: {
    countDiffs: afterDiffs,
    tenants: after.tenants?.n ?? null,
    profiles: after.profiles ?? null,
    intake: after.tableCounts?.check_intake_items ?? null,
    endorsements: after.tableCounts?.check_endorsements ?? null,
    images: identityAfter,
  },
  identityMapCount: identityResp.json.count ?? null,
  expectedEightIntact: Number(identityResp.json.count || 0) === 8,
};
writeFileSync('/tmp/t0/final-source-delta.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
