#!/usr/bin/env node
/**
 * T0: snapshot RDS, then overlay isolated-recon-PASS production rows onto live checksops.
 * Requires confirm flags. Never applies 64_financial_activation_grants.sql.
 * Never overlays identity_accounts.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const LAMBDA = process.env.REHEARSAL_LAMBDA_NAME || 'checksops-staging-rehearsal-oneshot';
const FILES_BUCKET = process.env.FILES_BUCKET || 'checksops-staging-privatefilesbucket-erzqsolpucjp';
const PREFIX = 'Migration/rehearsal-20260905/delta';
const RECON_PATH = path.join(ROOT, 'aws/db-copy/rehearsal/analysis/db_bridge_reconcile.json');

if (!process.argv.includes('--confirm-t0-promote')) {
  console.error(JSON.stringify({
    error: 'refusing_live_promote',
    message: 'Pass --confirm-t0-promote after isolated recon PASS.',
  }));
  process.exit(2);
}

const recon = JSON.parse(readFileSync(RECON_PATH, 'utf8'));
const r = recon.recon || {};
const isolatedPass = recon.verdict?.database === 'PASS'
  && recon.restore?.restoreOk === true
  && recon.restore?.deltaOk === true
  && r.countsStatus === 'PASS'
  && r.financialStatus === 'PASS'
  && r.pkStatus === 'PASS'
  && r.fkStatus === 'PASS';

if (!isolatedPass) {
  console.error(JSON.stringify({
    error: 'isolated_recon_not_pass',
    database: recon.verdict?.database,
    counts: r.countsStatus,
    financial: r.financialStatus,
    pk: r.pkStatus,
    fk: r.fkStatus,
  }, null, 2));
  process.exit(2);
}

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
  if (result.status !== 0) {
    throw new Error(result.stderr.slice(0, 300) || body.error || 'lambda invoke failed');
  }
  return body;
};

const snapshotId = `checksops-t0-prepromote-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}`;
let snapshot = { id: snapshotId, status: 'not_started' };
try {
  const created = awsJson([
    'rds', 'create-db-snapshot',
    '--db-instance-identifier', 'checksops-staging',
    '--db-snapshot-identifier', snapshotId,
  ]);
  snapshot = {
    id: created.DBSnapshot?.DBSnapshotIdentifier || snapshotId,
    status: created.DBSnapshot?.Status || 'creating',
  };
  execFileSync(AWS, ['--region', REGION, 'rds', 'wait', 'db-snapshot-completed', '--db-snapshot-identifier', snapshotId], {
    timeout: 45 * 60 * 1000,
  });
  snapshot.status = 'available';
} catch (error) {
  const raw = String(error.message || error);
  snapshot.error = raw.slice(0, 240);
  snapshot.status = /AccessDenied|not authorized|CreateDBSnapshot/i.test(raw) ? 'denied' : 'failed';
  snapshot.fallback = 'isolated checksops_rehearsal_20260906b plus Lovable source-of-record';
}

if (snapshot.status === 'failed') {
  console.error(JSON.stringify({ ok: false, error: 'snapshot_failed', snapshot }, null, 2));
  process.exit(1);
}

const applied = invoke({
  step: 'apply_delta',
  database: 'checksops',
  bucket: FILES_BUCKET,
  manifestPrefix: PREFIX,
  confirmChecksopsOverlay: true,
  confirmIsolatedReconPass: true,
}, 'live-overlay');

const liveRecon = invoke({
  step: 'reconcile',
  database: 'checksops',
  confirmLiveRecon: true,
}, 'live-recon');

const images = invoke({
  step: 'inspect_check_images',
  database: 'checksops',
}, 'live-images');

const report = {
  ok: applied.ok === true && liveRecon.ok === true && images.ok === true,
  snapshot,
  overlay: {
    ok: applied.ok === true,
    tables: applied.tables || 0,
    identitySkipped: (applied.tableSummary || []).some((row) => row.skipped === 'staging_only_identity'),
    error: applied.error || null,
  },
  liveRecon: {
    ok: liveRecon.ok === true,
    database: liveRecon.database,
    tenants: liveRecon.tenants?.n ?? null,
    profiles: liveRecon.profiles ?? null,
    identityAccountsPresent: liveRecon.identityAccountsPresent,
    financial: liveRecon.financialAggregates || {},
    error: liveRecon.error || null,
  },
  images,
  financialGrantsApplied: false,
};
mkdirSync('/tmp/t0', { recursive: true });
writeFileSync('/tmp/t0/promote-live.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
