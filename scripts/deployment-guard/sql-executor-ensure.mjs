#!/usr/bin/env node
/**
 * Update ONLY checksops-staging-guarded-sql-executor.
 * Cannot be retargeted at shared APIs or checksops-staging-sql44-2d41.
 * Does not apply SQL. Does not modify checksops-staging-api.
 * Does not invoke the executor.
 *
 * Existing-function updates require expected CodeSha256 + RevisionId CAS.
 * update-function-code and update-function-configuration both pass --revision-id.
 * A failed update never falls through to create-function.
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
const DEDICATED_ROLE = `arn:aws:iam::${ACCOUNT}:role/${SQL_EXECUTOR_FUNCTION}`;
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

function shortError(error) {
  return String(error?.stderr || error?.message || error).replace(/\s+/g, ' ').slice(0, 400);
}

export function packExecutor(root) {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-guarded-sql-executor-'));
  fs.mkdirSync(path.join(staging, 'sql'), { recursive: true });
  fs.mkdirSync(path.join(staging, 'lib'), { recursive: true });
  const copies = [
    ['aws/write-path/guarded-sql-executor/index.mjs', 'index.mjs'],
    ['aws/write-path/guarded-sql-executor/package.json', 'package.json'],
    ['aws/write-path/sql/44_claim_ledger_link_or_create.sql', 'sql/44_claim_ledger_link_or_create.sql'],
    ['aws/workflows/sql/53_claim_settlement_breakdown.sql', 'sql/53_claim_settlement_breakdown.sql'],
    ['aws/write-path/guarded-sql-executor/sql/39_tmp_write_policy_reconcile.sql', 'sql/39_tmp_write_policy_reconcile.sql'],
    ['aws/write-path/guarded-sql-executor/sql/40_collection_v2_synthetic_uat_cleanup.sql', 'sql/40_collection_v2_synthetic_uat_cleanup.sql'],
    ['supabase/migrations/20261001231500_tenant_users_same_check_permissions.sql', 'sql/20261001231500_tenant_users_same_check_permissions.sql'],
    ['supabase/migrations/20261001193100_tenant_users_can_override_check_status.sql', 'sql/20261001193100_tenant_users_can_override_check_status.sql'],
    ['aws/functions/api/rds-global-bundle.pem', 'rds-global-bundle.pem'],
    ['scripts/deployment-guard/lib/sql-apply.mjs', 'lib/sql-apply.mjs'],
    ['scripts/deployment-guard/lib/sql-executor-auth.mjs', 'lib/sql-executor-auth.mjs'],
    ['scripts/deployment-guard/lib/errors.mjs', 'lib/errors.mjs'],
    ['scripts/deployment-guard/lib/identity.mjs', 'lib/identity.mjs'],
    ['scripts/deployment-guard/lib/function-def-lookup.mjs', 'lib/function-def-lookup.mjs'],
    ['scripts/deployment-guard/lib/collection-v2-synthetic-uat-cleanup.mjs', 'lib/collection-v2-synthetic-uat-cleanup.mjs'],
    ['scripts/deployment-guard/lib/tmp-rls-catalog.mjs', 'lib/tmp-rls-catalog.mjs'],
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

function intendedEnvironment(rehearsal) {
  const adminSecretArn = rehearsal.Environment?.Variables?.ADMIN_SECRET_ARN
    || 'arn:aws:secretsmanager:us-east-1:806168576068:secret:rds-db-credentials/checksops-staging/checksops_admin/1788286368527-Kv5tBt';
  return {
    Variables: {
      ADMIN_SECRET_ARN: adminSecretArn,
      RDS_HOST: rehearsal.Environment?.Variables?.RDS_HOST || 'checksops-staging.cyr0q4kcop3c.us-east-1.rds.amazonaws.com',
      DATABASE_NAME: 'checksops',
      EXECUTOR_IDENTITY: SQL_EXECUTOR_FUNCTION,
      SECRETS_MANAGER_ENDPOINT: rehearsal.Environment?.Variables?.SECRETS_MANAGER_ENDPOINT || '',
    },
  };
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

  const expectedCodeSha256 = String(opts['expected-code-sha256'] || '');
  const expectedRevisionId = String(opts['expected-revision-id'] || '');
  if (!expectedCodeSha256 || !expectedRevisionId) {
    return printResult(fail(
      CODES.DEPLOYMENT_COLLISION,
      'sql-executor-ensure requires expected CodeSha256 and RevisionId CAS',
      {
        expected_code_sha256: expectedCodeSha256 || null,
        expected_revision_id: expectedRevisionId || null,
      },
    ));
  }

  let live;
  try {
    live = awsJson(['lambda', 'get-function-configuration', '--function-name', functionName], env);
  } catch (error) {
    return printResult(fail(
      CODES.DEPLOYMENT_COLLISION,
      'live executor is missing or unreadable; create-function is forbidden on this path',
      { function_name: functionName, error: shortError(error) },
    ));
  }
  if (live.CodeSha256 !== expectedCodeSha256 || live.RevisionId !== expectedRevisionId) {
    return printResult(fail(
      CODES.DEPLOYMENT_COLLISION,
      'live executor fingerprint changed after preflight',
      {
        expected_code_sha256: expectedCodeSha256,
        live_code_sha256: live.CodeSha256 || null,
        expected_revision_id: expectedRevisionId,
        live_revision_id: live.RevisionId || null,
      },
    ));
  }
  if (live.Role !== DEDICATED_ROLE) {
    return printResult(fail(
      CODES.UNRELATED_MUTATION,
      'live executor role is not the dedicated staging SQL executor role',
      { role: live.Role || null },
    ));
  }

  const packed = packExecutor(root);
  const rehearsal = awsJson(['lambda', 'get-function-configuration', '--function-name', 'checksops-staging-rehearsal-oneshot'], env);
  const api = awsJson(['lambda', 'get-function-configuration', '--function-name', 'checksops-staging-api'], env);
  const environment = intendedEnvironment(rehearsal);

  let finalLive;
  try {
    finalLive = awsJson(['lambda', 'get-function-configuration', '--function-name', functionName], env);
  } catch (error) {
    return printResult(fail(
      CODES.DEPLOYMENT_COLLISION,
      'final live executor read failed before update-function-code',
      { error: shortError(error) },
    ));
  }
  if (finalLive.CodeSha256 !== expectedCodeSha256 || finalLive.RevisionId !== expectedRevisionId) {
    return printResult(fail(
      CODES.DEPLOYMENT_COLLISION,
      'live executor fingerprint changed between pack and update',
      {
        expected_code_sha256: expectedCodeSha256,
        live_code_sha256: finalLive.CodeSha256 || null,
        expected_revision_id: expectedRevisionId,
        live_revision_id: finalLive.RevisionId || null,
      },
    ));
  }

  try {
    execFileSync(AWS, [
      '--region', REGION, 'lambda', 'update-function-code',
      '--function-name', functionName,
      '--zip-file', `fileb://${packed.zip}`,
      '--revision-id', expectedRevisionId,
    ], { encoding: 'utf8', env });
  } catch (error) {
    return printResult(fail(
      CODES.DEPLOYMENT_COLLISION,
      'update-function-code failed or RevisionId CAS rejected',
      { error: shortError(error) },
    ));
  }
  try {
    execFileSync(AWS, ['--region', REGION, 'lambda', 'wait', 'function-updated', '--function-name', functionName], { env });
  } catch { /* ok */ }

  let afterCode;
  try {
    afterCode = awsJson(['lambda', 'get-function-configuration', '--function-name', functionName], env);
  } catch (error) {
    return printResult(fail(
      CODES.DEPLOYMENT_COLLISION,
      'executor was unreadable after update-function-code; configuration was not changed',
      { error: shortError(error) },
    ));
  }
  if (afterCode.Role !== DEDICATED_ROLE) {
    return printResult(fail(
      CODES.UNRELATED_MUTATION,
      'update-function-code changed the dedicated executor role; configuration update refused',
      { role: afterCode.Role || null },
    ));
  }

  try {
    execFileSync(AWS, [
      '--region', REGION, 'lambda', 'update-function-configuration',
      '--function-name', functionName,
      '--timeout', '120',
      '--memory-size', '256',
      '--environment', JSON.stringify(environment),
      '--revision-id', afterCode.RevisionId,
    ], { encoding: 'utf8', env });
  } catch (error) {
    return printResult(fail(
      CODES.DEPLOYMENT_COLLISION,
      'update-function-configuration failed or RevisionId CAS rejected',
      {
        after_code_revision_id: afterCode.RevisionId || null,
        error: shortError(error),
      },
    ));
  }
  try {
    execFileSync(AWS, ['--region', REGION, 'lambda', 'wait', 'function-updated', '--function-name', functionName], { env });
  } catch { /* ok */ }

  const config = awsJson(['lambda', 'get-function-configuration', '--function-name', functionName], env);
  return printResult(ok({
    function_name: functionName,
    created: false,
    role: config.Role,
    code_sha256: config.CodeSha256,
    revision_id: config.RevisionId,
    previous_code_sha256: expectedCodeSha256,
    previous_revision_id: expectedRevisionId,
    vpc: config.VpcConfig || api.VpcConfig || {},
    database_name: config.Environment?.Variables?.DATABASE_NAME || null,
    executor_identity: config.Environment?.Variables?.EXECUTOR_IDENTITY || null,
    admin_secret_is_checksops_admin: String(config.Environment?.Variables?.ADMIN_SECRET_ARN || '').includes('checksops_admin'),
    staging_api_untouched: true,
    billing_sql44_untouched: true,
    invoked: false,
    sql_executed: false,
    receipt_issued: false,
  }));
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) process.exitCode = main();
