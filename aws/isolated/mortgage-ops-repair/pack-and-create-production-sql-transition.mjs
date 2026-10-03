#!/usr/bin/env node
/**
 * Pack and create the dedicated production Mortgage Ops SQL transition oneshot.
 * Embeds Step A privilege narrowing + pinned SQL 39. Refuses caller SQL.
 * Does not modify the inspect-only function.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const AWS = process.env.AWS_CLI || 'aws';
const REGION = 'us-east-1';
const ROOT = '/tmp/mops-repair-src';
const SRC = '/tmp/mops-repair/prod-promote/sql';
const NAME = 'checksops-prod-mops-sql-transition-ad99';
const ROLE = 'arn:aws:iam::806168576068:role/checksops-staging-rehearsal-oneshot';
const ADMIN_SECRET = 'arn:aws:secretsmanager:us-east-1:806168576068:secret:rds-db-credentials/checksops-production/checksops_admin/1790081257144-R3rJpx';
const RDS_HOST = 'checksops-production.cyr0q4kcop3c.us-east-1.rds.amazonaws.com';
const PINNED = 'c59845e439cfdfd48be955d8ab78128de4ba39211b136616fc23799215145e3f';

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function awsJson(args) {
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], { encoding: 'utf8' });
  return out.trim() ? JSON.parse(out) : {};
}

function pack() {
  const sql39 = path.join(ROOT, 'aws/rls/sql/39_mortgage_ops_agent_accept_complete.sql');
  const hash = sha256File(sql39);
  if (hash !== PINNED) {
    throw new Error(`SQL 39 hash mismatch: ${hash}`);
  }
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'mops-prod-sql-transition-'));
  fs.mkdirSync(path.join(staging, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(staging, 'sql'), { recursive: true });
  const copies = [
    [path.join(SRC, 'transition-index.mjs'), 'index.mjs'],
    [path.join(ROOT, 'aws/write-path/guarded-sql-executor/mortgage-ops-sql39.mjs'), 'mortgage-ops-sql39.mjs'],
    [path.join(ROOT, 'aws/write-path/guarded-sql-executor/package.json'), 'package.json'],
    [path.join(ROOT, 'aws/functions/api/rds-global-bundle.pem'), 'rds-global-bundle.pem'],
    [path.join(ROOT, 'scripts/deployment-guard/lib/sql-apply.mjs'), 'lib/sql-apply.mjs'],
    [path.join(ROOT, 'scripts/deployment-guard/lib/sql-executor-auth.mjs'), 'lib/sql-executor-auth.mjs'],
    [path.join(ROOT, 'scripts/deployment-guard/lib/errors.mjs'), 'lib/errors.mjs'],
    [path.join(ROOT, 'scripts/deployment-guard/lib/identity.mjs'), 'lib/identity.mjs'],
    [path.join(ROOT, 'scripts/deployment-guard/lib/function-def-lookup.mjs'), 'lib/function-def-lookup.mjs'],
    [sql39, 'sql/39_mortgage_ops_agent_accept_complete.sql'],
  ];
  for (const [from, to] of copies) {
    fs.copyFileSync(from, path.join(staging, to));
  }
  execFileSync('npm', ['install', '--omit=dev'], { cwd: staging, stdio: 'ignore' });
  const zip = path.join(SRC, 'transition.zip');
  try { fs.unlinkSync(zip); } catch { /* ok */ }
  execFileSync('zip', ['-qr', zip, '.'], { cwd: staging });
  return { zip, staging, sql39_sha256: hash };
}

const packed = pack();
let exists = true;
try {
  awsJson(['lambda', 'get-function-configuration', '--function-name', NAME]);
} catch {
  exists = false;
}

if (!exists) {
  const created = awsJson([
    'lambda', 'create-function',
    '--function-name', NAME,
    '--runtime', 'nodejs20.x',
    '--role', ROLE,
    '--handler', 'index.handler',
    '--timeout', '120',
    '--memory-size', '256',
    '--description', 'Dedicated production Mortgage Ops SQL transition. Embeds Step A 17-col narrowing + pinned SQL 39. Refuses caller SQL. Not the staging executor.',
    '--zip-file', `fileb://${packed.zip}`,
    '--vpc-config', JSON.stringify({
      SubnetIds: ['subnet-0df2518070c5b9ff0', 'subnet-092e4e41821fba6c4'],
      SecurityGroupIds: ['sg-0bc4695a666baf49b', 'sg-0fe2698f236959353'],
    }),
    '--environment', JSON.stringify({
      Variables: {
        ADMIN_SECRET_ARN: ADMIN_SECRET,
        DATABASE_NAME: 'checksops',
        RDS_HOST,
      },
    }),
    '--tags', 'Workstream=mortgage-ops-repair-ad99,Purpose=sql-transition-step-a-sql39',
  ]);
  fs.writeFileSync(path.join(SRC, 'transition-create.json'), `${JSON.stringify(created, null, 2)}\n`);
  console.log(JSON.stringify({ created: true, name: NAME, sha: created.CodeSha256, sql39: packed.sql39_sha256 }, null, 2));
} else {
  const updated = awsJson([
    'lambda', 'update-function-code',
    '--function-name', NAME,
    '--zip-file', `fileb://${packed.zip}`,
  ]);
  fs.writeFileSync(path.join(SRC, 'transition-update-code.json'), `${JSON.stringify(updated, null, 2)}\n`);
  console.log(JSON.stringify({ created: false, updated: true, name: NAME, sha: updated.CodeSha256, sql39: packed.sql39_sha256 }, null, 2));
}
