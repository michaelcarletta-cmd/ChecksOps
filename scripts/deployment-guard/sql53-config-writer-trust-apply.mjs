#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, printResult } from './lib/cli.mjs';
import { CODES, fail } from './lib/errors.mjs';
import { applySql53ConfigWriterOidcTrust } from './lib/sql53-config-writer-trust-apply.mjs';
import { SQL53_CONFIG_WRITER_ROLE } from './lib/sql53-config-writer-trust-merge.mjs';

function createAwsAdapter(region = process.env.AWS_REGION || 'us-east-1') {
  const iam = (args) => JSON.parse(execFileSync('aws', [
    '--region', region,
    '--output', 'json',
    'iam',
    ...args,
  ], { encoding: 'utf8' }));

  return {
    async getCallerIdentity() {
      return JSON.parse(execFileSync('aws', [
        '--region', region,
        '--output', 'json',
        'sts', 'get-caller-identity',
      ], { encoding: 'utf8' }));
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

export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const { flags } = parseArgs(argv);
  const aws = deps.aws || createAwsAdapter(env.AWS_REGION || env.AWS_DEFAULT_REGION || 'us-east-1');
  if (!flags.has('apply')) {
    return printResult(fail(CODES.GUARD_APPLY_FORBIDDEN, 'SQL53 OIDC trust apply requires --apply'));
  }
  const result = await applySql53ConfigWriterOidcTrust({
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
      message: 'SQL53 OIDC trust apply failed closed',
    })}\n`);
    process.exitCode = 2;
  });
}
