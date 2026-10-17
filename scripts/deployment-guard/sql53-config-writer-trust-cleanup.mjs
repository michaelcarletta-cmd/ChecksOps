#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, printResult } from './lib/cli.mjs';
import { CODES, fail, ok } from './lib/errors.mjs';
import { applySql53ConfigWriterOidcTrustCleanup } from './lib/sql53-config-writer-trust-cleanup.mjs';
import {
  SQL53_CONFIG_WRITER_ROLE,
  isIdentityCenterAdministratorIdentity,
} from './lib/sql53-config-writer-trust-merge.mjs';

function createAwsAdapter(region = process.env.AWS_REGION || 'us-east-1') {
  const run = (args) => JSON.parse(execFileSync('aws', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
  const iam = (args) => run([
    '--region', region,
    '--output', 'json',
    'iam',
    ...args,
  ]);

  return {
    async getCallerIdentity() {
      return run([
        '--region', region,
        '--output', 'json',
        'sts', 'get-caller-identity',
      ]);
    },
    async getRole({ roleName }) {
      return iam(['get-role', '--role-name', roleName]);
    },
    async listRolePolicies({ roleName }) {
      return iam(['list-role-policies', '--role-name', roleName]);
    },
    async listAttachedRolePolicies({ roleName }) {
      return iam(['list-attached-role-policies', '--role-name', roleName]);
    },
    async getRolePolicy({ roleName, policyName }) {
      return iam(['get-role-policy', '--role-name', roleName, '--policy-name', policyName]);
    },
    async updateAssumeRolePolicy({ roleName, policyDocument }) {
      return iam([
        'update-assume-role-policy',
        '--role-name', roleName,
        '--policy-document', JSON.stringify(policyDocument),
      ]);
    },
  };
}

function classifyArn(arn) {
  const value = String(arn || '');
  if (/AWSReservedSSO_AdministratorAccess_[A-Za-z0-9]+\//.test(value)) return 'AWSReservedSSO_AdministratorAccess';
  if (value.includes('ChecksOpsCursorCloudStaging')) return 'ChecksOpsCursorCloudStaging';
  if (value.includes('ChecksOpsProductionSql53ConfigWriter')) return 'ChecksOpsProductionSql53ConfigWriter';
  if (!value) return 'unavailable';
  return 'other';
}

export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const { flags } = parseArgs(argv);
  const aws = deps.aws || createAwsAdapter(env.AWS_REGION || env.AWS_DEFAULT_REGION || 'us-east-1');

  if (flags.has('identity-only')) {
    try {
      const identity = await aws.getCallerIdentity();
      const arn = identity?.Arn || null;
      return printResult(ok({
        identity_ok: isIdentityCenterAdministratorIdentity(identity),
        account: identity?.Account || null,
        arn_class: classifyArn(arn),
        apply_executed: false,
      }));
    } catch {
      return printResult(fail(
        CODES.PRODUCTION_APPROVAL_REQUIRED,
        'SQL53 OIDC trust cleanup could not verify the Identity Center administrator',
        { apply_executed: false, arn_class: 'unavailable' },
      ));
    }
  }

  if (!flags.has('apply')) {
    return printResult(fail(CODES.GUARD_APPLY_FORBIDDEN, 'SQL53 OIDC trust cleanup requires --apply'));
  }
  const result = await applySql53ConfigWriterOidcTrustCleanup({
    apply: true,
    role_name: SQL53_CONFIG_WRITER_ROLE,
  }, {
    ...deps,
    aws,
    env,
  });
  return printResult(result);
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  main().then((code) => { process.exitCode = code; }).catch(() => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: CODES.DEPLOYMENT_COLLISION,
      message: 'SQL53 OIDC trust cleanup failed closed',
    })}\n`);
    process.exitCode = 2;
  });
}
