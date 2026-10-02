#!/usr/bin/env node
/**
 * Guarded production SQL70 apply runner.
 * Requires an exclusive production-sql lease and signed receipt.
 * Does not reuse the staging SQL executor or the SQL43/SQL44 apply Lambda.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enforceScriptGuard } from '../../../scripts/deployment-guard/require-guard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const ONESHOT = 'checksops-prod-sql70-grant-a2a4';
const SRC = path.join(ROOT, 'aws/workflows/oneshot/sql70-prod-grant');
const ZIP = '/tmp/sql70-prod/sql70-grant.zip';
const OUT = '/tmp/sql70-prod/g2';
const EXPECTED_SPA = '/assets/index-B2T1Wfw7.js';
const EXPECTED_INDEX = 'a696053f8d8f4ae32fe2bc39622a97452b6b98ed27a03563d7f3ae50fe20ef3e';
const EXPECTED_LAMBDA = 'kqXCfyf3PVmKxV4ncmLgWKH/A6iwbi/IgsOgFTbIedQ=';
const EXPECTED_REV = '1f5bb42a-047d-4bd2-80f4-1ec11c97c2c6';
const EXPECTED_PRIV = '46589287c22aabc4f3f3bfd30784ad46dccc4e58c693e9953c13e8cd91028f18';
const CONFIRM = 'APPLY_SQL70_CLAIMS_COLUMN_GRANT';

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, {
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024,
  ...opts,
});
const awsJson = (args) => {
  const out = run(AWS, ['--region', REGION, '--output', 'json', ...args]);
  return out.trim() ? JSON.parse(out) : {};
};

mkdirSync(OUT, { recursive: true });

enforceScriptGuard({
  script: 'aws/workflows/oneshot/sql70-prod-grant/apply.mjs',
  target_environment: 'production',
  target_component: 'production-sql',
  deployment_type: 'sql-apply',
  workstream_id: process.env.CHECKSOPS_WORKSTREAM_ID,
  commit: process.env.CHECKSOPS_COMMIT,
  live_fingerprint: {
    sql: EXPECTED_PRIV,
    spa_entry: EXPECTED_SPA,
    spa_index_sha256: EXPECTED_INDEX,
    lambda_code_sha256: EXPECTED_LAMBDA,
    lambda_revision_id: EXPECTED_REV,
  },
}, { root: ROOT });

const lambda = awsJson([
  'lambda', 'get-function-configuration',
  '--function-name', 'checksops-production-prep-api',
  '--query', '{CodeSha256:CodeSha256,RevisionId:RevisionId,LastModified:LastModified}',
]);
if (lambda.CodeSha256 !== EXPECTED_LAMBDA || lambda.RevisionId !== EXPECTED_REV) {
  throw new Error(`lambda_drift:${lambda.CodeSha256}:${lambda.RevisionId}`);
}

const indexPath = path.join(OUT, 'index.html');
awsJson(['s3api', 'get-object', '--bucket', 'checksops-production-frontend-806168576068', '--key', 'index.html', indexPath]);
const html = readFileSync(indexPath);
const indexSha = createHash('sha256').update(html).digest('hex');
const entry = String(html).match(/\/assets\/index-[A-Za-z0-9_-]+\.js/)?.[0];
if (indexSha !== EXPECTED_INDEX || entry !== EXPECTED_SPA) {
  throw new Error(`spa_drift:${entry}:${indexSha}`);
}

const inspectCfg = awsJson(['lambda', 'get-function-configuration', '--function-name', 'checksops-prod-claim-ledger-sql-inspect-a2a4']);
const envVars = inspectCfg.Environment?.Variables || {};
if (!envVars.ADMIN_SECRET_ARN || !/checksops-production/i.test(envVars.ADMIN_SECRET_ARN)) {
  throw new Error('missing production admin secret on inspect Lambda');
}
if (!/checksops-production/i.test(String(envVars.RDS_HOST || ''))) {
  throw new Error('inspect Lambda host is not production');
}

copyFileSync(path.join(ROOT, 'aws/workflows/sql/70_staging_claims_number_grant.sql'), path.join(SRC, '70_staging_claims_number_grant.sql'));
copyFileSync('/tmp/sql70-prod/inspect/inspect-code/rds-global-bundle.pem', path.join(SRC, 'rds-global-bundle.pem'));
if (!existsSync(path.join(SRC, 'node_modules'))) {
  cpSync('/tmp/sql70-prod/inspect/inspect-code/node_modules', path.join(SRC, 'node_modules'), { recursive: true });
}
run('zip', ['-qr', ZIP, 'index.mjs', 'package.json', '70_staging_claims_number_grant.sql', 'rds-global-bundle.pem', 'node_modules'], { cwd: SRC });

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
    '--description', 'SQL70 only: GRANT UPDATE (claim_number, updated_at) on public.claims to checksops. Confirm required.',
  ]);
}
try { run(AWS, ['--region', REGION, 'lambda', 'wait', 'function-updated', '--function-name', ONESHOT]); } catch { /* ok */ }
try { run(AWS, ['--region', REGION, 'lambda', 'wait', 'function-active', '--function-name', ONESHOT]); } catch { /* ok */ }

const inspectOut = path.join(OUT, 'immediately-before-inspect.json');
run(AWS, [
  '--region', REGION, 'lambda', 'invoke',
  '--cli-binary-format', 'raw-in-base64-out',
  '--function-name', ONESHOT,
  '--payload', JSON.stringify({ action: 'inspect' }),
  inspectOut,
]);
const before = JSON.parse(readFileSync(inspectOut, 'utf8'));
if (before.ok !== true || before.mutated !== false) {
  throw new Error(`before_inspect_failed:${before.error || 'unknown'}`);
}
if (before.privilege_sha256 !== EXPECTED_PRIV) {
  writeFileSync(path.join(OUT, 'collision.json'), `${JSON.stringify({ expected: EXPECTED_PRIV, live: before.privilege_sha256, before }, null, 2)}\n`);
  throw new Error(`SQL_COLLISION:${before.privilege_sha256}`);
}
if (before.already_has_required_claims_column_update) {
  throw new Error('required_column_update_already_exists');
}

const applyOut = path.join(OUT, 'apply-invoke.json');
run(AWS, [
  '--region', REGION, 'lambda', 'invoke',
  '--cli-binary-format', 'raw-in-base64-out',
  '--function-name', ONESHOT,
  '--payload', JSON.stringify({
    action: 'apply',
    confirm: CONFIRM,
    expected_live_definition_sha256: EXPECTED_PRIV,
  }),
  applyOut,
]);
const applied = JSON.parse(readFileSync(applyOut, 'utf8'));
writeFileSync(path.join(OUT, 'apply-result.json'), `${JSON.stringify(applied, null, 2)}\n`);
console.log(JSON.stringify({
  oneshot: ONESHOT,
  existed,
  lambda_unchanged: true,
  spa_unchanged: true,
  before_privilege_sha256: before.privilege_sha256,
  ok: applied.ok,
  mutated: applied.mutated,
  after_privilege_sha256: applied.after_privilege_sha256 || null,
  after_columns: applied.after?.has_column_privilege_claims || null,
  settlements_privileges_unchanged: applied.settlements_privileges_unchanged,
  rls_unchanged: applied.rls_unchanged,
  error: applied.error || null,
}, null, 2));
if (applied.ok !== true) process.exit(1);
