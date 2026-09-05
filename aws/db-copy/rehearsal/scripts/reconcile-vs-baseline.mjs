#!/usr/bin/env node
/**
 * Compare staging inventory JSON to the September 1 baseline artifacts.
 * Pure offline diff — no database connections, no PII.
 *
 * Usage:
 *   node aws/db-copy/rehearsal/scripts/reconcile-vs-baseline.mjs \
 *     --staging path/to/staging_inventory.json \
 *     --out aws/db-copy/rehearsal/analysis/staging_vs_baseline.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

const stagingPath = arg('staging', path.join(repoRoot, 'aws/db-copy/rehearsal/analysis/staging_inventory.json'));
const outPath = arg('out', path.join(repoRoot, 'aws/db-copy/rehearsal/analysis/staging_vs_baseline.json'));
const baselineCountsPath = path.join(repoRoot, 'aws/db-copy/analysis/table_counts_backup_vs_restore.json');
const baselineFinancialPath = path.join(repoRoot, 'aws/db-copy/analysis/financial_backup_vs_restore.json');
const liveInventoryPath = path.join(repoRoot, 'aws/db-copy/live-inventory-status.json');

const staging = JSON.parse(fs.readFileSync(stagingPath, 'utf8'));
const baselineCounts = JSON.parse(fs.readFileSync(baselineCountsPath, 'utf8'));
const baselineFinancial = JSON.parse(fs.readFileSync(baselineFinancialPath, 'utf8'));
const live = fs.existsSync(liveInventoryPath)
  ? JSON.parse(fs.readFileSync(liveInventoryPath, 'utf8'))
  : null;

const baseline = baselineCounts.backup_counts || baselineCounts.restored_counts || {};
const stagingCounts = staging.tableCounts || {};

const countDiffs = [];
const allTables = new Set([...Object.keys(baseline), ...Object.keys(stagingCounts)]);
for (const table of [...allTables].sort()) {
  if (table === 'spatial_ref_sys') continue; // PostGIS catalog noise
  const b = Number(baseline[table] ?? NaN);
  const s = Number(stagingCounts[table] ?? NaN);
  if (!Number.isFinite(b) || !Number.isFinite(s)) {
    countDiffs.push({ table, baseline: baseline[table] ?? null, staging: stagingCounts[table] ?? null, status: 'missing_side' });
    continue;
  }
  if (b !== s) {
    countDiffs.push({ table, baseline: b, staging: s, delta: s - b, status: 'changed' });
  }
}

const finBaseline = Object.fromEntries(
  (baselineFinancial.metrics || []).map((m) => [m.metric, String(m.backup ?? m.restored_artifact)]),
);
const finStaging = staging.financialAggregates || {};
const financialDiffs = [];
for (const metric of new Set([...Object.keys(finBaseline), ...Object.keys(finStaging)])) {
  const b = finBaseline[metric];
  const s = finStaging[metric];
  if (b == null || s == null) {
    financialDiffs.push({ metric, baseline: b ?? null, staging: s ?? null, status: 'missing_side' });
    continue;
  }
  if (Number(b) !== Number(s)) {
    financialDiffs.push({ metric, baseline: b, staging: s, status: 'changed' });
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  baselineLabel: 'checksops_260901 (2026-09-01 first copy)',
  stagingInventoriedAt: staging.inventoriedAt || null,
  productionSupabaseChanged: false,
  catalog: {
    staging: staging.catalog || null,
    liveInventoryCommitted: live?.live?.public || null,
  },
  rowCounts: {
    tablesCompared: allTables.size,
    unchanged: allTables.size - countDiffs.length,
    changedOrMissing: countDiffs.length,
    diffs: countDiffs,
  },
  financial: {
    unchanged: Object.keys(finBaseline).length - financialDiffs.length,
    changedOrMissing: financialDiffs.length,
    diffs: financialDiffs,
  },
  identity: staging.identity || null,
  fkOrphanCounts: staging.fkOrphanCounts || null,
  stagingOnlyMarkers: staging.stagingOnlyMarkers || null,
  interpretation: {
    note:
      'Deltas here are staging vs Sept-1 dump baseline. Staging has accumulated Cognito identity overlays, ' +
      'UAT hires, and grants since first copy. A fresh production dump is required before claiming production↔staging parity.',
    preserveOnRehearsalRestore: [
      'public.identity_accounts (and Cognito mappings)',
      'staging Cognito user pool state',
      'AWS_WRITES_ENABLED / provider flags on Lambda',
      'aws_provider_sandbox_operations (if present)',
      'homeowner_upload_otp_sessions (if present)',
    ],
  },
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`wrote ${outPath}\n`);
process.stdout.write(`row_diffs=${countDiffs.length} financial_diffs=${financialDiffs.length}\n`);
