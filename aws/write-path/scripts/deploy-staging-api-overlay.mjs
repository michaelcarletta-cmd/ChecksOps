/**
 * Overlay checksops-staging-api from aws/functions/api. Staging only.
 * Does not UpdateFunctionConfiguration (provider flags stay as-is).
 * Refuses production / production-prep function names.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const FUNCTION_NAME = 'checksops-staging-api';
const FORBIDDEN = /production|prep/i;
const API_DIR = path.join(ROOT, 'aws/functions/api');

const awsJson = (args) => {
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  return out.trim() ? JSON.parse(out) : {};
};

if (FORBIDDEN.test(FUNCTION_NAME)) throw new Error('refusing production function');

const before = awsJson(['lambda', 'get-function-configuration', '--function-name', FUNCTION_NAME]);
if (FORBIDDEN.test(before.FunctionName || '')) throw new Error('refusing production function');
const flags = before.Environment?.Variables || {};
if (String(flags.AWS_PROVIDER_EXECUTION_ENABLED) === 'true') {
  throw new Error('refusing to overlay while provider execution is ON');
}

const staging = path.join(os.tmpdir(), 'checksops-staging-api-pack');
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
execFileSync('bash', ['-lc', `cp -a "${API_DIR}/." "${staging}/"`], { stdio: 'ignore' });
execFileSync('npm', ['ci', '--omit=dev'], { cwd: staging, stdio: 'inherit' });
const zip = path.join(os.tmpdir(), 'checksops-staging-api-phase2.zip');
await rm(zip, { force: true });
execFileSync('zip', ['-qr', zip, '.', '-x', '*.test.mjs', '-x', 'tsconfig*'], { cwd: staging });

const updated = awsJson([
  'lambda', 'update-function-code',
  '--function-name', FUNCTION_NAME,
  '--zip-file', `fileb://${zip}`,
]);
try {
  execFileSync(AWS, ['--region', REGION, 'lambda', 'wait', 'function-updated', '--function-name', FUNCTION_NAME], {
    encoding: 'utf8',
  });
} catch { /* continue */ }
const after = awsJson(['lambda', 'get-function-configuration', '--function-name', FUNCTION_NAME]);
const afterFlags = after.Environment?.Variables || {};
const report = {
  productionUntouched: true,
  function: FUNCTION_NAME,
  account: after.FunctionArn?.split(':')[4] || null,
  region: REGION,
  beforeSha: before.CodeSha256,
  afterSha: after.CodeSha256 || updated.CodeSha256,
  lastModified: after.LastModified,
  providerExecution: afterFlags.AWS_PROVIDER_EXECUTION_ENABLED,
  applicationWrites: afterFlags.AWS_APPLICATION_WORKFLOW_WRITES_ENABLED,
  envUnchanged: JSON.stringify(flags) === JSON.stringify(afterFlags),
};
if (String(report.providerExecution) !== 'false') {
  throw new Error('provider execution is not false after overlay');
}
fs.writeFileSync('/opt/cursor/artifacts/phase2_integration_api_deploy.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
