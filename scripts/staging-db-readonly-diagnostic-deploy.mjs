#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enforceSharedStackTarget } from './deployment-guard/require-guard.mjs';
import { repoRootFrom } from './deployment-guard/lib/paths.mjs';

export const DEPLOYMENT = Object.freeze({
  account: '806168576068',
  region: 'us-east-1',
  roleArn: 'arn:aws:iam::806168576068:role/ChecksOpsGitHubStagingDbReadonlyDiagnosticDeploy',
  executionRoleArn: 'arn:aws:iam::806168576068:role/ChecksOpsStagingDbReadonlyDiagnosticCloudFormationExecution',
  artifactBucket: 'checksops-staging-db-readonly-diagnostic-artifacts-806168576068',
  stackName: 'checksops-staging-db-readonly-diagnostic',
  functionName: 'checksops-staging-db-readonly-diagnostic',
  databaseSecretArn: 'arn:aws:secretsmanager:us-east-1:806168576068:secret:rds-db-credentials/checksops-staging/checksops/1788286468693-b4U0Rn',
  subnetIds: ['subnet-0df2518070c5b9ff0', 'subnet-092e4e41821fba6c4'],
  securityGroupId: 'sg-0fe2698f236959353',
});

const ROOT = repoRootFrom(import.meta.url);
const WORKSTREAM_ID = 'staging-db-readonly-diagnostic';
const TEMPLATE = 'aws/staging-db-readonly-diagnostic/template.yaml';

export function validateDeployContext({
  githubRef,
  githubSha,
  checkedOutSha,
  approvedSha,
  environment,
  region,
  roleArn,
  runId,
  runAttempt,
  targetStack = DEPLOYMENT.stackName,
  targetFunction = DEPLOYMENT.functionName,
}) {
  if (githubRef !== 'refs/heads/main'
      || !/^[0-9a-f]{40}$/.test(githubSha || '')
      || checkedOutSha !== githubSha
      || approvedSha !== githubSha) {
    throw new Error('unreviewed_source');
  }
  if (environment !== 'staging' || region !== DEPLOYMENT.region || roleArn !== DEPLOYMENT.roleArn) {
    throw new Error('staging_identity_rejected');
  }
  if (targetStack !== DEPLOYMENT.stackName || targetFunction !== DEPLOYMENT.functionName) {
    throw new Error('deployment_target_rejected');
  }
  if (!/^[1-9][0-9]*$/.test(String(runId || ''))
      || !/^[1-9][0-9]*$/.test(String(runAttempt || ''))) {
    throw new Error('fresh_run_identity_required');
  }
  return true;
}

export function validateAwsIdentity({ Account, Arn }) {
  if (Account !== DEPLOYMENT.account
      || !new RegExp(`^arn:aws:sts::${DEPLOYMENT.account}:assumed-role/ChecksOpsGitHubStagingDbReadonlyDiagnosticDeploy/[^/]+$`).test(Arn || '')) {
    throw new Error('aws_account_or_role_rejected');
  }
  return true;
}

export function isMissingStackError(error) {
  return /(?:ValidationError|StackNotFound)[\s\S]*(?:does not exist|not found)|(?:stack|Stack) [^\n]*(?:does not exist|not found)/i
    .test(String(error || ''));
}

export function safeVersionRecord({ FunctionArn, Version, CodeSha256 }, expectedCodeSha256 = CodeSha256) {
  if (FunctionArn !== `arn:aws:lambda:${DEPLOYMENT.region}:${DEPLOYMENT.account}:function:${DEPLOYMENT.functionName}`
      || !/^[1-9][0-9]*$/.test(String(Version || ''))
      || !/^[A-Za-z0-9+/]{43}=$/.test(String(CodeSha256 || ''))
      || CodeSha256 !== expectedCodeSha256) {
    throw new Error('published_version_contract_rejected');
  }
  return {
    version_arn: `${FunctionArn}:${Version}`,
    code_sha256: CodeSha256,
  };
}

function run(command, args, { cwd = ROOT, json = false } = {}) {
  try {
    const output = execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 20 * 1024 * 1024,
    }).trim();
    return json ? JSON.parse(output) : output;
  } catch (error) {
    const detail = `${error.stderr || ''}\n${error.message || ''}`;
    const wrapped = new Error('deployment_command_failed');
    wrapped.missingStack = isMissingStackError(detail);
    throw wrapped;
  }
}

function runQuiet(command, args, options = {}) {
  try {
    execFileSync(command, args, {
      cwd: ROOT,
      stdio: 'ignore',
      ...options,
    });
  } catch {
    throw new Error('deployment_command_failed');
  }
}

function guardDeployment(env, root) {
  enforceSharedStackTarget({
    script: 'staging-db-readonly-diagnostic-deploy',
    stackName: DEPLOYMENT.stackName,
    workstream_id: WORKSTREAM_ID,
    commit: env.GITHUB_SHA,
    live_fingerprint: { stack_state: 'must-be-absent' },
  }, { root, env });
}

function writeVersionOutput(record, env) {
  const line = `version_arn=${record.version_arn}\ncode_sha256=${record.code_sha256}\n`;
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, line);
  if (env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(env.GITHUB_STEP_SUMMARY,
      `### Staging DB diagnostic deployment\n\n- Version ARN: \`${record.version_arn}\`\n- Code SHA-256: \`${record.code_sha256}\`\n`);
  }
  console.log(JSON.stringify(record));
}

export function main(env = process.env, deps = {}) {
  const root = deps.root || ROOT;
  const runCommand = deps.run || run;
  const runCommandQuiet = deps.runQuiet || runQuiet;
  try {
    validateDeployContext({
      githubRef: env.GITHUB_REF,
      githubSha: env.GITHUB_SHA,
      checkedOutSha: deps.checkedOutSha || runCommand('git', ['rev-parse', 'HEAD'], { cwd: root }),
      approvedSha: env.APPROVED_COMMIT,
      environment: env.CHECKSOPS_DEPLOY_ENVIRONMENT,
      region: env.AWS_REGION,
      roleArn: env.CHECKSOPS_STAGING_DB_DIAGNOSTIC_ROLE_ARN,
      runId: env.GITHUB_RUN_ID,
      runAttempt: env.GITHUB_RUN_ATTEMPT,
    });
    guardDeployment(env, root);

    const identity = runCommand('aws', ['sts', 'get-caller-identity', '--output', 'json'], { json: true });
    validateAwsIdentity(identity);
    try {
      runCommand('aws', [
        'cloudformation', 'describe-stacks', '--stack-name', DEPLOYMENT.stackName, '--region', DEPLOYMENT.region,
      ], { json: true });
      throw new Error('target_stack_already_exists');
    } catch (error) {
      if (error.message !== 'deployment_command_failed' || error.missingStack !== true) throw error;
    }

    const packagedTemplate = path.join(env.RUNNER_TEMP || '/tmp', 'checksops-staging-db-readonly-diagnostic-packaged.yaml');
    const parametersFile = path.join(env.RUNNER_TEMP || '/tmp', 'checksops-staging-db-readonly-diagnostic-parameters.json');
    fs.rmSync(packagedTemplate, { force: true });
    runCommandQuiet('aws', [
      'cloudformation', 'package',
      '--template-file', TEMPLATE,
      '--s3-bucket', DEPLOYMENT.artifactBucket,
      '--s3-prefix', `${DEPLOYMENT.stackName}/${env.GITHUB_SHA}/${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`,
      '--output-template-file', packagedTemplate,
      '--region', DEPLOYMENT.region,
    ], { cwd: root });
    fs.writeFileSync(parametersFile, JSON.stringify([
      { ParameterKey: 'Environment', ParameterValue: 'staging' },
      { ParameterKey: 'DatabaseSecretArn', ParameterValue: DEPLOYMENT.databaseSecretArn },
      { ParameterKey: 'SubnetIds', ParameterValue: DEPLOYMENT.subnetIds.join(',') },
      { ParameterKey: 'ApiLambdaSecurityGroupId', ParameterValue: DEPLOYMENT.securityGroupId },
    ]));
    runCommandQuiet('aws', [
      'cloudformation', 'create-stack',
      '--stack-name', DEPLOYMENT.stackName,
      '--template-body', `file://${packagedTemplate}`,
      '--capabilities', 'CAPABILITY_IAM',
      '--role-arn', DEPLOYMENT.executionRoleArn,
      '--parameters', `file://${parametersFile}`,
      '--region', DEPLOYMENT.region,
    ], { cwd: root });
    runCommandQuiet('aws', [
      'cloudformation', 'wait', 'stack-create-complete',
      '--stack-name', DEPLOYMENT.stackName,
      '--region', DEPLOYMENT.region,
    ], { cwd: root });

    const codeSha256 = runCommand('aws', [
      'lambda', 'get-function-configuration',
      '--function-name', DEPLOYMENT.functionName,
      '--region', DEPLOYMENT.region,
      '--query', 'CodeSha256',
      '--output', 'text',
    ]);
    if (!/^[A-Za-z0-9+/]{43}=$/.test(codeSha256)) throw new Error('function_code_fingerprint_unavailable');
    const published = runCommand('aws', [
      'lambda', 'publish-version',
      '--function-name', DEPLOYMENT.functionName,
      '--code-sha256', codeSha256,
      '--region', DEPLOYMENT.region,
      '--query', '{FunctionArn:FunctionArn,Version:Version,CodeSha256:CodeSha256}',
      '--output', 'json',
    ], { json: true });
    const record = safeVersionRecord(published, codeSha256);
    writeVersionOutput(record, env);
    return 0;
  } catch (error) {
    console.error(JSON.stringify({ ok: false, code: error.message || 'deployment_failed' }));
    return 2;
  }
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) process.exitCode = main();
