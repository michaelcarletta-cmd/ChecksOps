#!/usr/bin/env node
/**
 * Timed write-freeze DRILL. Read-only. Does not freeze production,
 * does not run a final delta, does not COPY storage, does not change DNS.
 */
import { spawnSync } from 'node:child_process';

const REGION = process.env.AWS_REGION || 'us-east-1';
const SECRET_ID = process.env.STORAGE_MIGRATION_SECRET_ID || 'checksops/staging/storage-migration-token';
const DB_BRIDGE = 'https://nbcqwpysqgyxrrbgtmkw.supabase.co/functions/v1/aws-staging-db-bridge';
const STORAGE_BRIDGE = 'https://nbcqwpysqgyxrrbgtmkw.supabase.co/functions/v1/aws-staging-storage-bridge';
const ANON = process.env.SUPABASE_ANON_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5iY3F3cHlzcWd5eHJyYmd0bWt3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcxNDQ2NTgsImV4cCI6MjA5MjcyMDY1OH0.9GNh6OK6l6vSIBgkDY-bJuqNtfHJsLNW-dc7jfRUwgw';

if (process.argv.includes('--apply') || process.argv.includes('--freeze')) {
  console.error(JSON.stringify({
    error: 'refusing_production_write_freeze',
    message: 'This script is a timed drill only. Do not freeze production writes from this PR.',
  }, null, 2));
  process.exit(2);
}

const awsOut = spawnSync('aws', [
  'secretsmanager', 'get-secret-value',
  '--region', REGION,
  '--secret-id', SECRET_ID,
  '--query', 'SecretString',
  '--output', 'text',
], { encoding: 'utf8' });

if (awsOut.status !== 0) {
  console.log(JSON.stringify({ ok: false, skipped: true, reason: 'secretsmanager_unavailable' }, null, 2));
  process.exit(0);
}

let token = awsOut.stdout.trim();
try {
  const parsed = JSON.parse(token);
  token = parsed.token || parsed.migrationToken || token;
} catch { /* raw */ }

const post = async (url, payload) => {
  const started = Date.now();
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-checksops-migration-token': String(token).trim(),
      apikey: ANON,
      authorization: `Bearer ${ANON}`,
    },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  return { http: response.status, ms: Date.now() - started, body };
};

const started = Date.now();
const dbHealth = await post(DB_BRIDGE, { action: 'health' });
const tables = await post(DB_BRIDGE, { action: 'tables' });
const counts = await post(DB_BRIDGE, { action: 'counts' });
const identity = await post(DB_BRIDGE, { action: 'identity_map' });
const storageHealth = await post(STORAGE_BRIDGE, { action: 'health' });
const inventory = await post(STORAGE_BRIDGE, { action: 'inventory' });
const elapsedMs = Date.now() - started;

const countValues = counts.body.counts && typeof counts.body.counts === 'object'
  ? Object.values(counts.body.counts).filter((v) => typeof v === 'number')
  : [];

const report = {
  ok: dbHealth.http === 200
    && dbHealth.body.mode === 'read_only'
    && dbHealth.body.writes === false
    && storageHealth.http === 200,
  drillOnly: true,
  productionWriteFreezeEnabled: false,
  finalDeltaExecuted: false,
  storageCopyExecuted: false,
  dnsChanged: false,
  elapsedMs,
  steps: {
    dbHealthMs: dbHealth.ms,
    tablesMs: tables.ms,
    countsMs: counts.ms,
    identityMapMs: identity.ms,
    storageHealthMs: storageHealth.ms,
    storageInventoryMs: inventory.ms,
  },
  dbBridge: {
    http: dbHealth.http,
    mode: dbHealth.body.mode || null,
    writes: dbHealth.body.writes,
    tableCount: tables.body.count ?? null,
    countedTables: countValues.length,
    identityMapCount: identity.body.count ?? null,
  },
  storageBridge: {
    http: storageHealth.http,
    mode: storageHealth.body.mode || null,
    deletes: storageHealth.body.deletes ?? null,
    inventoryHttp: inventory.http,
    inventoryOk: inventory.body.ok === true,
  },
  estimateNote: 'This drill times live read-only bridge calls only. Overlay/restore and storage COPY from PR #127 remain the 45–110 min pre-DNS budget; this number is the capture-path floor, not a freeze.',
};

console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
