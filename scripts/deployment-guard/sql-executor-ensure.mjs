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

// [source path in the repo, member path in the executor zip]
export const EXECUTOR_PACK_MEMBERS = Object.freeze([
  ['aws/write-path/guarded-sql-executor/index.mjs', 'index.mjs'],
  ['aws/write-path/guarded-sql-executor/package.json', 'package.json'],
  ['aws/write-path/sql/44_claim_ledger_link_or_create.sql', 'sql/44_claim_ledger_link_or_create.sql'],
  ['aws/workflows/sql/53_claim_settlement_breakdown.sql', 'sql/53_claim_settlement_breakdown.sql'],
  ['aws/write-path/guarded-sql-executor/sql/39_tmp_write_policy_reconcile.sql', 'sql/39_tmp_write_policy_reconcile.sql'],
  ['aws/write-path/guarded-sql-executor/sql/40_collection_v2_synthetic_uat_cleanup.sql', 'sql/40_collection_v2_synthetic_uat_cleanup.sql'],
  ['supabase/migrations/20261001231500_tenant_users_same_check_permissions.sql', 'sql/20261001231500_tenant_users_same_check_permissions.sql'],
  ['supabase/migrations/20261001193100_tenant_users_can_override_check_status.sql', 'sql/20261001193100_tenant_users_can_override_check_status.sql'],
  ['supabase/migrations/20261007193200_skip_claim_ledger_event_for_endorsement_stage.sql', 'sql/20261007193200_skip_claim_ledger_event_for_endorsement_stage.sql'],
  ['aws/workflows/sql/71_review_amount_column_grant.sql', 'sql/71_review_amount_column_grant.sql'],
  ['aws/workflows/sql/72_member_payment_writes.sql', 'sql/72_member_payment_writes.sql'],
  ['aws/workflows/sql/76_tenant_partnership_invitee_consent.sql', 'sql/76_tenant_partnership_invitee_consent.sql'],
  ['aws/workflows/sql/77_check_stakeholders_write_grant.sql', 'sql/77_check_stakeholders_write_grant.sql'],
  ['aws/workflows/sql/78_check_partner_stakeholder_removals.sql', 'sql/78_check_partner_stakeholder_removals.sql'],
  ['aws/workflows/sql/79_member_stakeholder_writes.sql', 'sql/79_member_stakeholder_writes.sql'],
  ['aws/workflows/sql/80_checkalt_member_auto_deposit.sql', 'sql/80_checkalt_member_auto_deposit.sql'],
  ['aws/workflows/sql/81_checkalt_production_register.sql', 'sql/81_checkalt_production_register.sql'],
  ['aws/workflows/sql/82_homeowner_ledger_view.sql', 'sql/82_homeowner_ledger_view.sql'],
  ['aws/workflows/sql/83_homeowner_signing_capabilities.sql', 'sql/83_homeowner_signing_capabilities.sql'],
  ['aws/workflows/sql/84_mortgage_return_to_queue.sql', 'sql/84_mortgage_return_to_queue.sql'],
  ['aws/workflows/sql/85_mortgage_compensation_adjust.sql', 'sql/85_mortgage_compensation_adjust.sql'],
  ['aws/workflows/sql/86_mortgage_compensation_owner_only.sql', 'sql/86_mortgage_compensation_owner_only.sql'],
  ['aws/workflows/sql/87_resolve_check_case_tenant_scope.sql', 'sql/87_resolve_check_case_tenant_scope.sql'],
  ['aws/workflows/sql/88_claim_id_assign_case_tenant_scope.sql', 'sql/88_claim_id_assign_case_tenant_scope.sql'],
  ['aws/workflows/sql/89_check_intake_items_column_update.sql', 'sql/89_check_intake_items_column_update.sql'],
  ['aws/rls/sql/29_mortgage_ops_library_parity.sql', 'sql/29_mortgage_ops_library_parity.sql'],
  ['aws/rls/sql/30_tenant_documents_mortgage_doc_type.sql', 'sql/30_tenant_documents_mortgage_doc_type.sql'],
  ['aws/workflows/sql/90_users_only_tenant_roles.sql', 'sql/90_users_only_tenant_roles.sql'],
  ['aws/workflows/sql/91_moov_onboarding.sql', 'sql/91_moov_onboarding.sql'],
  ['aws/workflows/sql/92_signature_request_check_files_link_grant.sql', 'sql/92_signature_request_check_files_link_grant.sql'],
  ['aws/workflows/sql/93_tenant_company_info.sql', 'sql/93_tenant_company_info.sql'],
  ['aws/workflows/sql/94_document_library_restore.sql', 'sql/94_document_library_restore.sql'],
  ['aws/workflows/sql/95_remove_freedom_claims_bridge.sql', 'sql/95_remove_freedom_claims_bridge.sql'],
  ['aws/workflows/sql/96_platform_owner_tenant_pricing.sql', 'sql/96_platform_owner_tenant_pricing.sql'],
  ['aws/workflows/sql/97_financial_stepup_log_server_writer.sql', 'sql/97_financial_stepup_log_server_writer.sql'],
  ['aws/workflows/sql/98_tenant_fee_collection.sql', 'sql/98_tenant_fee_collection.sql'],
  ['aws/workflows/sql/99_mortgage_desk_completion_messages.sql', 'sql/99_mortgage_desk_completion_messages.sql'],
  ['aws/workflows/sql/100_mortgage_desk_live_access.sql', 'sql/100_mortgage_desk_live_access.sql'],
  ['aws/workflows/sql/101_invite_identity_insert_order.sql', 'sql/101_invite_identity_insert_order.sql'],
  ['aws/workflows/sql/102_platform_owner_tenant_profile.sql', 'sql/102_platform_owner_tenant_profile.sql'],
  ['aws/workflows/sql/103_share_library_trigger_acl.sql', 'sql/103_share_library_trigger_acl.sql'],
  ['aws/functions/api/rds-global-bundle.pem', 'rds-global-bundle.pem'],
  ['scripts/deployment-guard/lib/sql-apply.mjs', 'lib/sql-apply.mjs'],
  ['scripts/deployment-guard/lib/sql-executor-auth.mjs', 'lib/sql-executor-auth.mjs'],
  ['scripts/deployment-guard/lib/release-sql-state.mjs', 'lib/release-sql-state.mjs'],
  ['scripts/deployment-guard/lib/release-sql-specs.mjs', 'lib/release-sql-specs.mjs'],
  ['scripts/deployment-guard/lib/errors.mjs', 'lib/errors.mjs'],
  ['scripts/deployment-guard/lib/identity.mjs', 'lib/identity.mjs'],
  ['scripts/deployment-guard/lib/function-def-lookup.mjs', 'lib/function-def-lookup.mjs'],
  ['scripts/deployment-guard/lib/collection-v2-synthetic-uat-cleanup.mjs', 'lib/collection-v2-synthetic-uat-cleanup.mjs'],
  ['scripts/deployment-guard/lib/tmp-rls-catalog.mjs', 'lib/tmp-rls-catalog.mjs'],
]);

/** Environment the executor runs with, derived from the staging rehearsal function. */
export function executorEnvironment(rehearsal = {}) {
  return {
    Variables: {
      ADMIN_SECRET_ARN: rehearsal.Environment?.Variables?.ADMIN_SECRET_ARN
        || 'arn:aws:secretsmanager:us-east-1:806168576068:secret:rds-db-credentials/checksops-staging/checksops_admin/1788286368527-Kv5tBt',
      RDS_HOST: rehearsal.Environment?.Variables?.RDS_HOST || 'checksops-staging.cyr0q4kcop3c.us-east-1.rds.amazonaws.com',
      DATABASE_NAME: 'checksops',
      EXECUTOR_IDENTITY: SQL_EXECUTOR_FUNCTION,
      SECRETS_MANAGER_ENDPOINT: rehearsal.Environment?.Variables?.SECRETS_MANAGER_ENDPOINT || '',
    },
  };
}

export function packExecutor(root) {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-guarded-sql-executor-'));
  fs.mkdirSync(path.join(staging, 'sql'), { recursive: true });
  fs.mkdirSync(path.join(staging, 'lib'), { recursive: true });
  for (const [from, to] of EXECUTOR_PACK_MEMBERS) {
    fs.copyFileSync(path.join(root, from), path.join(staging, to));
  }
  installExecutorDependencies(staging);
  const zip = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-guarded-sql-executor-zip-')), 'package.zip');
  execFileSync('zip', ['-qr', zip, '.'], { cwd: staging });
  return { zip, staging };
}

function installExecutorDependencies(staging) {
  const npmCache = fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-executor-npm-cache-'));
  const args = ['install', '--omit=dev', '--no-audit', '--no-fund', '--no-progress', '--cache', npmCache];
  const env = {
    ...process.env,
    npm_config_cache: npmCache,
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
  };
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      execFileSync('npm', args, {
        cwd: staging,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      });
      return;
    } catch (error) {
      lastError = error;
    }
  }
  const detail = String(lastError?.stderr || lastError?.stdout || lastError?.message || '').slice(0, 800);
  throw new Error(`executor package install failed: ${detail}`);
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

  const packed = packExecutor(root);
  const rehearsal = awsJson(['lambda', 'get-function-configuration', '--function-name', 'checksops-staging-rehearsal-oneshot'], env);
  const api = awsJson(['lambda', 'get-function-configuration', '--function-name', 'checksops-staging-api'], env);
  const vpc = api.VpcConfig || {};
  const roleArn = opts.role || rehearsal.Role || `arn:aws:iam::${ACCOUNT}:role/checksops-staging-rehearsal-oneshot`;
  const environment = executorEnvironment(rehearsal);
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
