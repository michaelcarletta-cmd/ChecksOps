#!/usr/bin/env node
/**
 * Probe IAM capabilities for a dedicated production API role.
 * May create no durable resources except an empty probe role if CreateRole is allowed.
 * Does not attach any role to Lambda. Does not print secrets.
 */
import { execFileSync } from 'node:child_process';

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const CANDIDATE = 'checksops-production-api-execution';
const LEFTOVER = 'checksops-production-prep-api-role';

if (!process.argv.includes('--confirm-iam-probe')) {
  console.error(JSON.stringify({ error: 'refusing_iam_probe' }));
  process.exit(2);
}

const run = (args) => {
  try {
    return { ok: true, data: JSON.parse(execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], { encoding: 'utf8' }) || '{}') };
  } catch (error) {
    const text = String(error.stderr || error.message || error);
    const action = (text.match(/perform: ([a-z0-9:]+)/i) || [])[1] || null;
    return {
      ok: false,
      action,
      noSuch: /NoSuchEntity|not found/i.test(text),
      alreadyExists: /EntityAlreadyExists/i.test(text),
      denied: /AccessDenied|not authorized/i.test(text),
      message: text.slice(0, 400),
    };
  }
};

const list = run(['iam', 'list-roles', '--path-prefix', '/', '--max-items', '200']);
const names = (list.data?.Roles || []).map((r) => r.RoleName).filter((n) => /checksops|production|prep|api/i.test(n));
const leftoverGet = run(['iam', 'get-role', '--role-name', LEFTOVER]);
const leftoverPut = run([
  'iam', 'put-role-policy',
  '--role-name', LEFTOVER,
  '--policy-name', 'Batch1ProbeNoop',
  '--policy-document', JSON.stringify({
    Version: '2012-10-17',
    Statement: [{
      Sid: 'ProbeNoop',
      Effect: 'Allow',
      Action: 'logs:DescribeLogGroups',
      Resource: 'arn:aws:logs:us-east-1:806168576068:log-group:/aws/lambda/checksops-production-prep-api:*',
    }],
  }),
]);
if (leftoverPut.ok) {
  run(['iam', 'delete-role-policy', '--role-name', LEFTOVER, '--policy-name', 'Batch1ProbeNoop']);
}

const attach = run([
  'iam', 'attach-role-policy',
  '--role-name', LEFTOVER,
  '--policy-arn', 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
]);

const stacks = run(['cloudformation', 'describe-stacks', '--stack-name', 'checksops-production-prep-api']);

const report = {
  listRoles: list.ok ? { ok: true, matching: names } : { ok: false, denied: list.denied, action: list.action },
  leftoverGet: leftoverGet.ok ? { exists: true, arn: leftoverGet.data.Role?.Arn } : leftoverGet,
  leftoverPut: leftoverPut.ok ? { allowed: true } : leftoverPut,
  leftoverAttach: attach.ok ? { allowed: true } : attach,
  stack: stacks.ok ? { status: stacks.data.Stacks?.[0]?.StackStatus } : stacks,
};
console.log(JSON.stringify(report, null, 2));
