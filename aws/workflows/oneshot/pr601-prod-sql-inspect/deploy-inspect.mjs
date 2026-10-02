#!/usr/bin/env node
/**
 * Deploy/replace the inspect-only #601 production SQL catalog probe.
 * Does not apply SQL. Clones VPC/role/secret from the existing production
 * claim-ledger inspect Lambda.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const ONESHOT = 'checksops-prod-pr601-sql-inspect-a2a4';
const SRC = path.dirname(fileURLToPath(import.meta.url));
const ZIP = '/tmp/pr601-prod/pr601-sql-inspect.zip';
const TEMPLATE = 'checksops-prod-claim-ledger-sql-inspect-a2a4';

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, {
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024,
  ...opts,
});
const awsJson = (args) => {
  const out = run(AWS, ['--region', REGION, '--output', 'json', ...args]);
  return out.trim() ? JSON.parse(out) : {};
};

const inspectCfg = awsJson(['lambda', 'get-function-configuration', '--function-name', TEMPLATE]);
const envVars = inspectCfg.Environment?.Variables || {};
if (!envVars.ADMIN_SECRET_ARN || !/checksops-production/i.test(envVars.ADMIN_SECRET_ARN)) {
  throw new Error('missing production admin secret on inspect Lambda');
}
if (!/checksops-production/i.test(String(envVars.RDS_HOST || ''))) {
  throw new Error('inspect Lambda host is not production');
}

copyFileSync(
  path.join(ROOT, 'supabase/migrations/20261001231500_tenant_users_same_check_permissions.sql'),
  path.join(SRC, '20261001231500_tenant_users_same_check_permissions.sql'),
);
if (!existsSync(path.join(SRC, 'rds-global-bundle.pem'))) {
  copyFileSync('/tmp/pr601-prod/inspect-src/rds-global-bundle.pem', path.join(SRC, 'rds-global-bundle.pem'));
}
if (!existsSync(path.join(SRC, 'node_modules'))) {
  cpSync('/tmp/pr601-prod/inspect-src/node_modules', path.join(SRC, 'node_modules'), { recursive: true });
}

run('zip', [
  '-qr', ZIP,
  'index.mjs',
  'package.json',
  '20261001231500_tenant_users_same_check_permissions.sql',
  'rds-global-bundle.pem',
  'node_modules',
], { cwd: SRC });

const env = {
  Variables: {
    ADMIN_SECRET_ARN: envVars.ADMIN_SECRET_ARN,
    RDS_HOST: envVars.RDS_HOST,
    DATABASE_NAME: envVars.DATABASE_NAME || 'checksops',
  },
};
const vpc = inspectCfg.VpcConfig || {};
const vpcConfig = `SubnetIds=${(vpc.SubnetIds || []).join(',')},SecurityGroupIds=${(vpc.SecurityGroupIds || []).join(',')}`;

let existed = false;
try {
  awsJson(['lambda', 'get-function', '--function-name', ONESHOT]);
  existed = true;
} catch {
  existed = false;
}
if (existed) {
  run(AWS, ['--region', REGION, 'lambda', 'update-function-code', '--function-name', ONESHOT, '--zip-file', `fileb://${ZIP}`]);
} else {
  awsJson([
    'lambda', 'create-function',
    '--function-name', ONESHOT,
    '--runtime', 'nodejs20.x',
    '--role', inspectCfg.Role,
    '--handler', 'index.handler',
    '--timeout', '60',
    '--memory-size', '256',
    '--zip-file', `fileb://${ZIP}`,
    '--environment', JSON.stringify(env),
    '--vpc-config', vpcConfig,
    '--description', 'Inspect-only #601 production SQL catalog probe. Read-only. Refuses caller SQL.',
  ]);
}
try { run(AWS, ['--region', REGION, 'lambda', 'wait', 'function-updated', '--function-name', ONESHOT]); } catch { /* ok */ }
try { run(AWS, ['--region', REGION, 'lambda', 'wait', 'function-active', '--function-name', ONESHOT]); } catch { /* ok */ }
console.log(JSON.stringify({ ok: true, function_name: ONESHOT, existed }, null, 2));
