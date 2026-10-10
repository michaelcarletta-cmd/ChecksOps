#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, printResult, readInput } from './lib/cli.mjs';
import { CODES, fail, ok } from './lib/errors.mjs';
import { repoRootFrom } from './lib/paths.mjs';
import {
  SQL53_CONFIG_DEPLOYMENT_TYPE,
  SQL53_CONFIG_ENV,
  SQL53_CONFIG_FUNCTION,
  applySql53TemporaryLambdaConfig,
  fingerprintSql53LambdaConfiguration,
  isSql53ConfigWriterIdentity,
} from './lib/sql53-temporary-lambda-config.mjs';
import { refuseUnguardedDeploy } from './require-guard.mjs';

function createAwsAdapter(region = process.env.AWS_REGION || 'us-east-1') {
  let lambdaClient;
  let lambdaModule;
  async function send(operation, input) {
    lambdaModule ||= await import('@aws-sdk/client-lambda');
    lambdaClient ||= new lambdaModule.LambdaClient({ region });
    const Commands = {
      get: lambdaModule.GetFunctionConfigurationCommand,
      update: lambdaModule.UpdateFunctionConfigurationCommand,
      invoke: lambdaModule.InvokeCommand,
    };
    return lambdaClient.send(new Commands[operation](input));
  }

  return {
    async getCallerIdentity() {
      return JSON.parse(execFileSync('aws', [
        '--region', region,
        '--output', 'json',
        'sts', 'get-caller-identity',
      ], { encoding: 'utf8' }));
    },
    getFunctionConfiguration: ({ functionName }) => send('get', { FunctionName: functionName }),
    updateFunctionConfiguration: ({ functionName, environment, revisionId }) => send('update', {
      FunctionName: functionName,
      Environment: { Variables: environment },
      RevisionId: revisionId,
    }),
    invokeFunction: ({ functionName, payload }) => send('invoke', {
      FunctionName: functionName,
      InvocationType: 'RequestResponse',
      Payload: Buffer.from(JSON.stringify(payload)),
    }),
  };
}

export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const { flags, opts } = parseArgs(argv);
  const input = readInput(opts, {});
  const aws = deps.aws || createAwsAdapter(env.AWS_REGION || env.AWS_DEFAULT_REGION || 'us-east-1');
  const guardRoot = deps.guardRoot || repoRootFrom(import.meta.url);

  if (flags.has('fingerprint-only')) {
    try {
      const identity = await aws.getCallerIdentity();
      if (!isSql53ConfigWriterIdentity(identity)) {
        return printResult(fail(CODES.PRODUCTION_APPROVAL_REQUIRED, 'fingerprint-only requires the dedicated production execution role'));
      }
      const configuration = await aws.getFunctionConfiguration({ functionName: SQL53_CONFIG_FUNCTION });
      const result = fingerprintSql53LambdaConfiguration(configuration);
      return printResult(result.ok
        ? ok({ fingerprint: result.details.fingerprint })
        : result);
    } catch {
      return printResult(fail(CODES.DEPLOYMENT_COLLISION, 'failed to read production Lambda fingerprint'));
    }
  }

  const functionName = input.function_name || SQL53_CONFIG_FUNCTION;
  if (functionName !== SQL53_CONFIG_FUNCTION
    || (input.target_environment && input.target_environment !== SQL53_CONFIG_ENV)
    || (input.target_component && input.target_component !== SQL53_CONFIG_FUNCTION)
    || (input.deployment_type && input.deployment_type !== SQL53_CONFIG_DEPLOYMENT_TYPE)) {
    return printResult(fail(CODES.UNRELATED_MUTATION, 'SQL53 temporary configuration target is fixed to the production prep Lambda'));
  }
  const guarded = refuseUnguardedDeploy({
    target_environment: SQL53_CONFIG_ENV,
    target_component: SQL53_CONFIG_FUNCTION,
    deployment_type: SQL53_CONFIG_DEPLOYMENT_TYPE,
    workstream_id: input.workstream_id || env.CHECKSOPS_WORKSTREAM_ID,
    commit: input.commit || env.CHECKSOPS_COMMIT || opts.commit,
    receipt: input.receipt,
    receipt_path: opts.receipt || input.receipt_path,
  }, { root: guardRoot, env });
  if (!guarded.ok) return printResult(guarded);
  if (!flags.has('apply') || input.apply !== true) {
    return printResult(fail(CODES.GUARD_APPLY_FORBIDDEN, 'temporary SQL53 configuration requires --apply and apply:true'));
  }

  const result = await applySql53TemporaryLambdaConfig({
    ...input,
    function_name: functionName,
    receipt: guarded.details.receipt,
    workstream_id: input.workstream_id || env.CHECKSOPS_WORKSTREAM_ID,
    commit: input.commit || env.CHECKSOPS_COMMIT || opts.commit,
    receipt_path: opts.receipt || input.receipt_path,
  }, {
    ...deps,
    aws,
    env,
    guardRoot,
    script: fileURLToPath(import.meta.url),
  });
  return printResult(result);
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  main().then((code) => { process.exitCode = code; }).catch(() => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: CODES.DEPLOYMENT_COLLISION,
      message: 'SQL53 guarded Lambda configuration writer failed closed',
    })}\n`);
    process.exitCode = 2;
  });
}
