#!/usr/bin/env node
/**
 * Official #539 entry for the staging VPC SQL executor.
 * Direct invocation without a valid receipt fails closed before Lambda invoke.
 * Never accepts arbitrary SQL text. Never targets production or shared APIs.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, printResult, readInput } from './lib/cli.mjs';
import { CODES, fail } from './lib/errors.mjs';
import { enforceScriptGuard } from './require-guard.mjs';
import {
  SQL_EXECUTOR_COMPONENT,
  SQL_EXECUTOR_DEPLOYMENT_TYPE,
  SQL_EXECUTOR_FUNCTION,
  authorizationFingerprint,
  evaluateSqlExecutorAuthorization,
  resolveAuthorizedMigration,
} from './lib/sql-executor-auth.mjs';
const AWS = process.env.AWS_CLI || process.env.AWS || 'aws';
const REGION = process.env.AWS_REGION || 'us-east-1';

function refuseFunctionName(name) {
  if (name !== SQL_EXECUTOR_FUNCTION) {
    return fail(
      CODES.UNRELATED_MUTATION,
      'sql-executor-invoke may only target checksops-staging-guarded-sql-executor',
      { function_name: name },
    );
  }
  return null;
}

export function buildExecutorPayload(input = {}, receipt = {}) {
  const authorized = resolveAuthorizedMigration(input);
  const payload = {
    action: input.action || 'apply',
    workstream_id: input.workstream_id || receipt.workstream_id,
    branch: input.branch || receipt.branch,
    commit: input.commit || receipt.commit || authorized.commit,
    operator: input.operator || receipt.operator,
    target_environment: 'staging',
    target_component: SQL_EXECUTOR_COMPONENT,
    deployment_type: SQL_EXECUTOR_DEPLOYMENT_TYPE,
    owned_components: input.owned_components || [authorized.filename],
    filename: input.filename || authorized.filename,
    migration_id: input.migration_id || authorized.migration_id,
    source_sha256: input.source_sha256 || authorized.source_sha256,
    intended_replacement_sha256: input.intended_replacement_sha256 || authorized.intended_replacement_sha256,
    expected_live_definition_sha256: input.expected_live_definition_sha256,
    one_use_id: input.one_use_id,
    expiry: input.expiry || receipt.expiry,
    function_name: SQL_EXECUTOR_FUNCTION,
    build_timestamp: input.build_timestamp,
    preflight_live_fingerprint: input.preflight_live_fingerprint || receipt.preflight_live_fingerprint,
    inspect: input.inspect || null,
    verify: input.verify || null,
    applied_after_hash: input.applied_after_hash || null,
  };
  return payload;
}

export function main(argv = process.argv.slice(2), env = process.env, invokeFn = null) {
  const { opts } = parseArgs(argv);
  const input = readInput(opts, {});
  const functionName = opts['function-name'] || input.function_name || SQL_EXECUTOR_FUNCTION;
  const refused = refuseFunctionName(functionName);
  if (refused) return printResult(refused);

  const authorizedMigration = resolveAuthorizedMigration(input);
  const fingerprint = input.preflight_live_fingerprint || authorizationFingerprint({
    ...authorizedMigration,
    ...input,
    commit: input.commit || authorizedMigration.commit,
  });

  const authorized = enforceScriptGuard({
    script: import.meta.url,
    workstream_id: opts['workstream-id'] || input.workstream_id,
    commit: opts.commit || input.commit || authorizedMigration.commit,
    target_environment: 'staging',
    target_component: SQL_EXECUTOR_COMPONENT,
    deployment_type: SQL_EXECUTOR_DEPLOYMENT_TYPE,
    preflight_live_fingerprint: fingerprint,
    receipt_path: opts.receipt || input.receipt_path,
    receipt: input.receipt,
  });

  const payload = buildExecutorPayload({
    ...input,
    expected_live_definition_sha256: input.expected_live_definition_sha256 || fingerprint.sql,
    one_use_id: input.one_use_id || fingerprint.one_use_id,
    function_name: functionName,
  }, authorized.details.receipt);

  const evaluation = evaluateSqlExecutorAuthorization(payload);
  if (!evaluation.ok) return printResult(evaluation);

  if (payload.sql_text || input.sql_text) {
    return printResult(fail(
      CODES.UNRELATED_MUTATION,
      'arbitrary SQL text is forbidden on the invoke path',
    ));
  }

  const invoke = invokeFn || ((name, body) => {
    const payloadFile = path.join(os.tmpdir(), `sql-executor-payload-${process.pid}.json`);
    const outFile = path.join(os.tmpdir(), `sql-executor-out-${process.pid}.json`);
    fs.writeFileSync(payloadFile, JSON.stringify(body));
    execFileSync(AWS, [
      '--region', REGION,
      'lambda', 'invoke',
      '--function-name', name,
      '--cli-binary-format', 'raw-in-base64-out',
      '--payload', `file://${payloadFile}`,
      outFile,
    ], { encoding: 'utf8', env });
    return JSON.parse(fs.readFileSync(outFile, 'utf8'));
  });

  const result = invoke(functionName, payload);
  return printResult(result && result.ok === false ? result : {
    ok: result?.ok !== false,
    code: result?.code || null,
    message: result?.message || null,
    details: result,
    errors: result?.errors || [],
  });
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) process.exitCode = main();
