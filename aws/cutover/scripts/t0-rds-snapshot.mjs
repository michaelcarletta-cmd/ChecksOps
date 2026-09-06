#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const id = process.argv[2] || `checksops-t0-prepromote-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}`;
const created = JSON.parse(execFileSync(AWS, [
  '--region', 'us-east-1', '--output', 'json',
  'rds', 'create-db-snapshot',
  '--db-instance-identifier', 'checksops-staging',
  '--db-snapshot-identifier', id,
], { encoding: 'utf8' }));
console.log(JSON.stringify({ started: created.DBSnapshot?.Status, id: created.DBSnapshot?.DBSnapshotIdentifier || id }));
execFileSync(AWS, ['--region', 'us-east-1', 'rds', 'wait', 'db-snapshot-completed', '--db-snapshot-identifier', id], { stdio: 'inherit' });
const out = JSON.parse(execFileSync(AWS, [
  '--region', 'us-east-1', '--output', 'json',
  'rds', 'describe-db-snapshots',
  '--db-snapshot-identifier', id,
], { encoding: 'utf8' }));
console.log(JSON.stringify({
  done: true,
  status: out.DBSnapshots?.[0]?.Status,
  id: out.DBSnapshots?.[0]?.DBSnapshotIdentifier,
}));
