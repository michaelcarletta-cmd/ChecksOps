#!/usr/bin/env node
/**
 * Create or update ONLY checksops-staging-guarded-sql-executor.
 * Cannot be retargeted at shared APIs or checksops-staging-sql44-2d41.
 * Does not apply SQL. Does not modify checksops-staging-api.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, printResult } from './lib/cli.mjs';
import { CODES, fail, ok } from './lib/errors.mjs';
import { enforceSharedLambdaTarget } from './require-guard.mjs';
import { SQL_EXECUTOR_FUNCTION } from './lib/sql-executor-auth.mjs';
import { repoRootFrom } from './lib/paths.mjs';

const AWS = process.env.AWS_CLI || process.env.AWS || 'aws';
const REGION = process.env.AWS_REGION || 'us-east-1';
const ACCOUNT = '806168576068';
const FORBIDDEN = new Set([
  'checksops-staging-api',
  'checksops-staging-sql44-2d41',
  'checksops-production-prep-api',
  'checksops-production-origin-verify',
]);

function awsJson(args, env = process.env) {
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
    encoding: 'utf8',
    env,
  });
  return out.trim() ? JSON.parse(out) : {};
}

export function packExecutor(root) {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-guarded-sql-executor-'));
  fs.mkdirSync(path.join(staging, 'sql'), { recursive: true });
  fs.mkdirSync(path.join(staging, 'lib'), { recursive: true });
  const copies = [
    ['aws/write-path/guarded-sql-executor/index.mjs', 'index.mjs'],
    ['aws/write-path/guarded-sql-executor/package.json', 'package.json'],
    ['aws/write-path/guarded-sql-executor/mortgage-ops-sql39.mjs', 'mortgage-ops-sql39.mjs'],
    ['aws/write-path/sql/44_claim_ledger_link_or_create.sql', 'sql/44_claim_ledger_link_or_create.sql'],
    ['aws/workflows/sql/71_homeowner_ledger_view_contract.sql', 'sql/71_homeowner_ledger_view_contract.sql'],
    ['aws/write-path/guarded-sql-executor/sql/39_mortgage_ops_agent_accept_complete.sql', 'sql/39_mortgage_ops_agent_accept_complete.sql'],
    ['supabase/migrations/20261001231500_tenant_users_same_check_permissions.sql', 'sql/20261001231500_tenant_users_same_check_permissions.sql'],
    ['supabase/migrations/20261001193100_tenant_users_can_override_check_status.sql', 'sql/20261001193100_tenant_users_can_override_check_status.sql'],
    ['supabase/migrations/20261002200000_user_can_move_tenant_checks_membership_only.sql', 'sql/20261002200000_user_can_move_tenant_checks_membership_only.sql'],
    ['aws/functions/api/rds-global-bundle.pem', 'rds-global-bundle.pem'],
    ['scripts/deployment-guard/lib/sql-apply.mjs', 'lib/sql-apply.mjs'],
    ['scripts/deployment-guard/lib/sql-executor-auth.mjs', 'lib/sql-executor-auth.mjs'],
    ['scripts/deployment-guard/lib/errors.mjs', 'lib/errors.mjs'],
    ['scripts/deployment-guard/lib/identity.mjs', 'lib/identity.mjs'],
    ['scripts/deployment-guard/lib/function-def-lookup.mjs', 'lib/function-def-lookup.mjs'],
  ];
  for (const [from, to] of copies) {
    fs.copyFileSync(path.join(root, from), path.join(staging, to));
  }
  execFileSync('npm', ['install', '--omit=dev'], { cwd: staging, stdio: 'ignore' });
  const zip = path.join(os.tmpdir(), `checksops-guarded-sql-executor-${process.pid}.zip`);
  try { fs.unlinkSync(zip); } catch { /* ok */ }
  execFileSync('zip', ['-qr', zip, '.'], { cwd: staging });
  return { zip, staging };
}

export function main(argv = process.argv.slice(2), env = process.env, root = repoRootFrom(import.meta.url)) {
  const { opts } = parseArgs(argv);
  const functionName = opts['function-name'] || SQL_EXECUTOR_FUNCTION;
  if (FORBIDDEN.has(functionName) || functionName !== SQL_EXECUTOR_FUNCTION) {
    return printResult(fail(
      CODES.UNRELATED_MUTATION,
      'sql-executor-ensure may only create/update checksops-staging-guarded-sql-executor',
      { function_name: functionName },
    ));
  }
  enforceSharedLambdaTarget({
    script: import.meta.url,
    functionName,
    workstream_id: opts['workstream-id'],
    commit: opts.commit,
  });

  const composedZip = opts['composed-zip'] ? path.resolve(String(opts['composed-zip'])) : null;
  if (composedZip) {
    if (!fs.existsSync(composedZip)) {
      return printResult(fail(CODES.INVALID_MANIFEST, 'composed executor zip is missing', { composed_zip: composedZip }));
    }
    const live = awsJson(['lambda', 'get-function-configuration', '--function-name', functionName], env);
    const expectedSha = opts['expected-code-sha256'];
    const expectedRev = opts['expected-revision-id'];
    if (!expectedSha || !expectedRev) {
      return printResult(fail(
        CODES.INVALID_MANIFEST,
        'composed-zip deploy requires expected-code-sha256 and expected-revision-id for CAS',
      ));
    }
    if (live.CodeSha256 !== expectedSha || live.RevisionId !== expectedRev) {
      return printResult(fail(CODES.DEPLOYMENT_COLLISION, 'live executor fingerprint changed after preflight; STOP', {
        expected_code_sha256: expectedSha,
        expected_revision_id: expectedRev,
        live_code_sha256: live.CodeSha256 || null,
        live_revision_id: live.RevisionId || null,
      }));
    }
    execFileSync(AWS, [
      '--region', REGION, 'lambda', 'update-function-code',
      '--function-name', functionName,
      '--zip-file', `fileb://${composedZip}`,
      '--revision-id', expectedRev,
    ], { encoding: 'utf8', env });
    try {
      execFileSync(AWS, ['--region', REGION, 'lambda', 'wait', 'function-updated', '--function-name', functionName], { env });
    } catch { /* ok */ }
    const config = awsJson(['lambda', 'get-function-configuration', '--function-name', functionName], env);
    return printResult(ok({
      function_name: functionName,
      created: false,
      composed_zip: true,
      code_only: true,
      configuration_untouched: true,
      role: config.Role,
      code_sha256: config.CodeSha256,
      revision_id: config.RevisionId,
      expected_code_sha256: expectedSha,
      expected_revision_id: expectedRev,
      staging_api_untouched: true,
      billing_sql44_untouched: true,
    }));
  }

  const packed = packExecutor(root);
  const rehearsal = awsJson(['lambda', 'get-function-configuration', '--function-name', 'checksops-staging-rehearsal-oneshot'], env);
  const api = awsJson(['lambda', 'get-function-configuration', '--function-name', 'checksops-staging-api'], env);
  const vpc = api.VpcConfig || {};
  const adminSecretArn = rehearsal.Environment?.Variables?.ADMIN_SECRET_ARN
    || 'arn:aws:secretsmanager:us-east-1:806168576068:secret:rds-db-credentials/checksops-staging/checksops_admin/1788286368527-Kv5tBt';
  const roleArn = opts.role || rehearsal.Role || `arn:aws:iam::${ACCOUNT}:role/checksops-staging-rehearsal-oneshot`;
  const environment = {
    Variables: {
      ADMIN_SECRET_ARN: adminSecretArn,
      RDS_HOST: rehearsal.Environment?.Variables?.RDS_HOST || 'checksops-staging.cyr0q4kcop3c.us-east-1.rds.amazonaws.com',
      DATABASE_NAME: 'checksops',
      EXECUTOR_IDENTITY: SQL_EXECUTOR_FUNCTION,
      SECRETS_MANAGER_ENDPOINT: rehearsal.Environment?.Variables?.SECRETS_MANAGER_ENDPOINT || '',
    },
  };
  const vpcConfig = `SubnetIds=${(vpc.SubnetIds || []).join(',')},SecurityGroupIds=${(vpc.SecurityGroupIds || []).join(',')}`;

  let created = false;
  try {
    awsJson(['lambda', 'get-function', '--function-name', functionName], env);
    execFileSync(AWS, [
      '--region', REGION, 'lambda', 'update-function-code',
      '--function-name', functionName,
      '--zip-file', `fileb://${packed.zip}`,
    ], { encoding: 'utf8', env });
    try {
      execFileSync(AWS, ['--region', REGION, 'lambda', 'wait', 'function-updated', '--function-name', functionName], { env });
    } catch { /* ok */ }
    awsJson([
      'lambda', 'update-function-configuration',
      '--function-name', functionName,
      '--timeout', '120',
      '--memory-size', '256',
      '--environment', JSON.stringify(environment),
    ], env);
  } catch {
    created = true;
    awsJson([
      'lambda', 'create-function',
      '--function-name', functionName,
      '--runtime', 'nodejs20.x',
      '--role', roleArn,
      '--handler', 'index.handler',
      '--timeout', '120',
      '--memory-size', '256',
      '--zip-file', `fileb://${packed.zip}`,
      '--environment', JSON.stringify(environment),
      '--vpc-config', vpcConfig,
    ], env);
  }
  try {
    execFileSync(AWS, ['--region', REGION, 'lambda', 'wait', 'function-active', '--function-name', functionName], { env });
  } catch { /* ok */ }
  const config = awsJson(['lambda', 'get-function-configuration', '--function-name', functionName], env);
  return printResult(ok({
    function_name: functionName,
    created,
    role: config.Role,
    code_sha256: config.CodeSha256,
    revision_id: config.RevisionId,
    vpc: config.VpcConfig || vpc,
    staging_api_untouched: true,
    billing_sql44_untouched: true,
  }));
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) process.exitCode = main();
