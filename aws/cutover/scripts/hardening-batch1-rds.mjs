#!/usr/bin/env node
/**
 * Enable deletion protection and 35-day automated backups/PITR on the
 * production-target RDS instance. Does not rename, recreate, delete,
 * make public, or enable Multi-AZ. Does not touch customer data.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const RDS_ID = 'checksops-staging';

if (!process.argv.includes('--confirm-rds-protection')) {
  console.error(JSON.stringify({ error: 'refusing_rds_protection' }));
  process.exit(2);
}

const awsJson = (args) => JSON.parse(execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
  encoding: 'utf8',
}) || '{}');

const summarize = (db) => ({
  identifier: db.DBInstanceIdentifier || null,
  status: db.DBInstanceStatus || null,
  class: db.DBInstanceClass || null,
  publiclyAccessible: db.PubliclyAccessible ?? null,
  storageEncrypted: db.StorageEncrypted ?? null,
  kmsKeyId: db.KmsKeyId || null,
  multiAZ: db.MultiAZ ?? null,
  backupRetention: db.BackupRetentionPeriod ?? null,
  deletionProtection: db.DeletionProtection ?? null,
  latestRestorableTime: db.LatestRestorableTime || null,
  pending: db.PendingModifiedValues || {},
});

const beforeDb = (awsJson(['rds', 'describe-db-instances', '--db-instance-identifier', RDS_ID]).DBInstances || [])[0] || {};
if (beforeDb.DBInstanceIdentifier !== RDS_ID) {
  console.error(JSON.stringify({ error: 'unexpected_rds_identifier', got: beforeDb.DBInstanceIdentifier || null }));
  process.exit(1);
}

const minimumAgentRds = {
  note: 'Grant these on the Cloud Agent staging role for this instance only. Do not broaden the agent role. Do not enable Multi-AZ here.',
  actions: ['rds:ModifyDBInstance', 'rds:DescribeDBInstances'],
  resources: [`arn:aws:rds:${REGION}:806168576068:db:${RDS_ID}`],
  modifyArgs: ['--deletion-protection', '--backup-retention-period 35', '--no-publicly-accessible', '--apply-immediately'],
};

let modifyDenied = null;
try {
  awsJson([
    'rds', 'modify-db-instance',
    '--db-instance-identifier', RDS_ID,
    '--deletion-protection',
    '--backup-retention-period', '35',
    '--no-publicly-accessible',
    '--apply-immediately',
  ]);
} catch (error) {
  const text = String(error.stderr || error.message || error);
  modifyDenied = {
    action: 'rds:ModifyDBInstance',
    denied: /AccessDenied|not authorized/i.test(text),
    message: text.slice(0, 400),
  };
  const report = {
    ok: false,
    mutated: false,
    multiAzEnabled: false,
    before: summarize(beforeDb),
    after: summarize(beforeDb),
    modifyDenied,
    minimumAgentRds,
  };
  mkdirSync('/tmp/security', { recursive: true });
  writeFileSync('/tmp/security/batch1-rds.json', `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  process.exit(1);
}

const deadline = Date.now() + 10 * 60 * 1000;
let afterDb = beforeDb;
while (Date.now() < deadline) {
  afterDb = (awsJson(['rds', 'describe-db-instances', '--db-instance-identifier', RDS_ID]).DBInstances || [])[0] || {};
  const pendingBackup = afterDb.PendingModifiedValues?.BackupRetentionPeriod;
  const applied = afterDb.DeletionProtection === true
    && afterDb.BackupRetentionPeriod === 35
    && pendingBackup == null
    && afterDb.DBInstanceStatus === 'available';
  if (applied) break;
  execFileSync('sleep', ['10']);
}

const after = summarize(afterDb);
const report = {
  ok: after.identifier === RDS_ID
    && after.deletionProtection === true
    && after.backupRetention === 35
    && after.storageEncrypted === true
    && after.publiclyAccessible === false
    && after.multiAZ === false
    && Boolean(after.latestRestorableTime),
  mutated: true,
  multiAzEnabled: false,
  before: summarize(beforeDb),
  after,
  minimumAgentRds,
};
mkdirSync('/tmp/security', { recursive: true });
writeFileSync('/tmp/security/batch1-rds.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
