#!/usr/bin/env node
/**
 * Gate 3A: secret + authorizer Lambda + unattached REQUEST authorizer.
 * ORIGIN_VERIFY_REQUIRE stays false. Does not attach $default.
 * Does not print the secret.
 *
 * Requires:
 *   CHECKSOPS_APPLY_GATE3A=I_UNDERSTAND_PRODUCTION
 *   CHECKSOPS_STEP3_EXECUTE=1  (otherwise plan-only, exit 2)
 *   assumed role ChecksOpsCursorApiPerimeterStep3Temp
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  API_ID,
  AUTHORIZER_NAME,
  EXECUTION_ROLE_NAME,
  LAMBDA_NAME,
  SECRET_NAME,
  awsJson,
  awsText,
  refuseRequireMode,
  requireGate,
  requireStep3Temp,
  shouldExecute,
} from './lib.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

refuseRequireMode();
requireGate('CHECKSOPS_APPLY_GATE3A');

const plan = {
  gate: '3A',
  secretName: SECRET_NAME,
  lambdaName: LAMBDA_NAME,
  apiId: API_ID,
  ORIGIN_VERIFY_REQUIRE: false,
  attached: false,
  secretValuePrinted: false,
};

if (!shouldExecute()) {
  console.log(JSON.stringify({ ...plan, note: 'Plan only. Set CHECKSOPS_STEP3_EXECUTE=1 to apply.' }));
  process.exit(2);
}

const identity = requireStep3Temp();
const account = '806168576068';
const execArn = `arn:aws:iam::${account}:role/${EXECUTION_ROLE_NAME}`;

const execRole = awsJson(['iam', 'get-role', '--role-name', EXECUTION_ROLE_NAME], { allowFail: true });
if (execRole.__error) {
  throw new Error(
    `execution_role_missing ${EXECUTION_ROLE_NAME}. Privileged operator must create it from aws/production/cursor-api-perimeter-step3-execution-role.yaml before Gate 3A. Do not create the secret first.`,
  );
}

const existingSecret = awsJson(
  ['secretsmanager', 'describe-secret', '--secret-id', SECRET_NAME],
  { allowFail: true },
);
let secretArn;
if (existingSecret.__error) {
  const payload = JSON.stringify({ current: randomBytes(32).toString('hex'), next: '' });
  const created = awsJson([
    'secretsmanager',
    'create-secret',
    '--name',
    SECRET_NAME,
    '--secret-string',
    payload,
  ]);
  secretArn = created.ARN;
} else {
  secretArn = existingSecret.ARN;
}

const zipDir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-verify-'));
const src = path.join(ROOT, 'aws/functions/origin-verify');
fs.copyFileSync(path.join(src, 'authorizer.mjs'), path.join(zipDir, 'authorizer.mjs'));
fs.copyFileSync(path.join(src, 'package.json'), path.join(zipDir, 'package.json'));
const npm = spawnSync('npm', ['install', '--omit=dev', '--no-fund', '--no-audit'], {
  cwd: zipDir,
  encoding: 'utf8',
  env: process.env,
});
if (npm.status !== 0) {
  throw new Error(`npm install failed: ${(npm.stderr || npm.stdout || '').slice(0, 800)}`);
}
const zipPath = path.join(zipDir, 'function.zip');
const zip = spawnSync('zip', ['-qr', zipPath, 'authorizer.mjs', 'node_modules', 'package.json'], {
  cwd: zipDir,
  encoding: 'utf8',
});
if (zip.status !== 0) throw new Error('zip failed');

const fn = awsJson(['lambda', 'get-function', '--function-name', LAMBDA_NAME], { allowFail: true });
if (fn.__error) {
  awsJson([
    'lambda',
    'create-function',
    '--function-name',
    LAMBDA_NAME,
    '--runtime',
    'nodejs20.x',
    '--role',
    execArn,
    '--handler',
    'authorizer.handler',
    '--timeout',
    '10',
    '--memory-size',
    '256',
    '--zip-file',
    `fileb://${zipPath}`,
    '--environment',
    JSON.stringify({
      Variables: {
        ORIGIN_VERIFY_REQUIRE: 'false',
        ORIGIN_VERIFY_SECRET_ARN: secretArn,
      },
    }),
  ]);
} else {
  awsJson(['lambda', 'update-function-code', '--function-name', LAMBDA_NAME, '--zip-file', `fileb://${zipPath}`]);
  awsJson([
    'lambda',
    'update-function-configuration',
    '--function-name',
    LAMBDA_NAME,
    '--environment',
    JSON.stringify({
      Variables: {
        ORIGIN_VERIFY_REQUIRE: 'false',
        ORIGIN_VERIFY_SECRET_ARN: secretArn,
      },
    }),
  ]);
}

const lambdaArn = `arn:aws:lambda:us-east-1:${account}:function:${LAMBDA_NAME}`;
const authorizerUri = `arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/${lambdaArn}/invocations`;

const authorizers = awsJson(['apigatewayv2', 'get-authorizers', '--api-id', API_ID]);
let authorizer = (authorizers.Items || []).find((a) => a.Name === AUTHORIZER_NAME);
if (!authorizer) {
  authorizer = awsJson([
    'apigatewayv2',
    'create-authorizer',
    '--api-id',
    API_ID,
    '--name',
    AUTHORIZER_NAME,
    '--authorizer-type',
    'REQUEST',
    '--identity-source',
    '$context.httpMethod',
    '--authorizer-uri',
    authorizerUri,
    '--authorizer-payload-format-version',
    '2.0',
    '--enable-simple-responses',
    '--authorizer-result-ttl-in-seconds',
    '0',
  ]);
}

awsJson(
  [
    'lambda',
    'add-permission',
    '--function-name',
    LAMBDA_NAME,
    '--statement-id',
    'apigateway-origin-verify',
    '--action',
    'lambda:InvokeFunction',
    '--principal',
    'apigateway.amazonaws.com',
    '--source-arn',
    `arn:aws:execute-api:us-east-1:${account}:${API_ID}/authorizers/${authorizer.AuthorizerId}`,
  ],
  { allowFail: true },
);

const routes = awsJson(['apigatewayv2', 'get-routes', '--api-id', API_ID]);
const def = (routes.Items || []).find((r) => r.RouteKey === '$default');
if (!def || def.AuthorizationType !== 'NONE') {
  throw new Error('refusing: $default is not AuthorizationType=NONE after Gate 3A');
}

try {
  fs.rmSync(zipDir, { recursive: true, force: true });
} catch {
  /* ignore */
}

console.log(JSON.stringify({
  ...plan,
  identity,
  secretCreatedOrPresent: true,
  secretArnPresent: Boolean(secretArn),
  lambdaName: LAMBDA_NAME,
  authorizerId: authorizer.AuthorizerId,
  authorizerAttached: false,
  defaultAuthorizationType: def.AuthorizationType,
  ORIGIN_VERIFY_REQUIRE: false,
}));
