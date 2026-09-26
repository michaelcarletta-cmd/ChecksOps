#!/usr/bin/env node
/**
 * Delete Check overlay preflight (production-prep).
 *
 * Safeguard goals:
 * - Fail closed if the local repo does not satisfy the Delete Check contract tests.
 * - Fail closed if the overlay baseline is not the current live Lambda package zip.
 *
 * This script does NOT deploy or mutate AWS resources.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const PREP = 'checksops-production-prep-api';

if (!process.argv.includes('--confirm-delete-check-preflight')) {
  console.error(JSON.stringify({ error: 'refusing_delete_check_preflight' }));
  process.exit(2);
}

const runAws = (args) => {
  try {
    const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    const trimmed = String(out || '').trim();
    if (!trimmed) return { ok: true, data: {} };
    return { ok: true, data: JSON.parse(trimmed) };
  } catch (error) {
    const text = String(error.stderr || error.message || error);
    return { ok: false, denied: /AccessDenied|not authorized|UnauthorizedOperation/i.test(text), message: text.slice(0, 900) };
  }
};

const sha256Base64File = (filePath) =>
  createHash('sha256').update(readFileSync(filePath)).digest('base64');

const workDir = '/tmp/security';
mkdirSync(workDir, { recursive: true });

const report = {
  ok: false,
  lambda: {
    functionName: PREP,
    region: REGION,
    codeSha256: null,
    liveZipSha256: null,
    baselineVerified: false,
  },
  local: {
    releaseLocksOk: false,
    deleteCheckContractOk: false,
    awsWorkflowTestsOk: false,
  },
  attempts: [],
};

const attempt = (step, fn) => {
  try {
    const out = fn();
    report.attempts.push({ step, ok: true });
    return out;
  } catch (error) {
    report.attempts.push({ step, ok: false, message: String(error?.message || error).slice(0, 900) });
    throw error;
  }
};

try {
  const cfg = attempt('getFunctionConfiguration', () =>
    runAws(['lambda', 'get-function-configuration', '--function-name', PREP]),
  );
  if (!cfg.ok) throw new Error(cfg.message || 'get_function_configuration_failed');
  report.lambda.codeSha256 = cfg.data?.CodeSha256 || null;

  const fn = attempt('getFunction', () =>
    runAws(['lambda', 'get-function', '--function-name', PREP]),
  );
  if (!fn.ok) throw new Error(fn.message || 'get_function_failed');
  const location = fn.data?.Code?.Location;
  if (!location) throw new Error('missing_code_location');

  const zipPath = `${workDir}/delete-check-prep-live.zip`;
  rmSync(zipPath, { force: true });
  attempt('downloadLiveZip', () => {
    execFileSync('curl', ['-fsSL', location, '-o', zipPath], { encoding: 'utf8' });
  });
  report.lambda.liveZipSha256 = sha256Base64File(zipPath);
  report.lambda.baselineVerified = Boolean(report.lambda.codeSha256 && report.lambda.liveZipSha256 === report.lambda.codeSha256);
  if (!report.lambda.baselineVerified) {
    throw new Error(`live_package_sha_mismatch expected=${report.lambda.codeSha256 || 'missing'} actual=${report.lambda.liveZipSha256}`);
  }

  attempt('validateReleaseLocks', () => {
    execFileSync(process.execPath, ['scripts/validate-release-locks.mjs'], { cwd: '/workspace', encoding: 'utf8' });
  });
  report.local.releaseLocksOk = true;

  attempt('deleteCheckContractTest', () => {
    execFileSync(process.execPath, ['--test', 'ops/release-locks/tests/delete-check-invariants.test.mjs'], { cwd: '/workspace', encoding: 'utf8' });
  });
  report.local.deleteCheckContractOk = true;

  attempt('awsWorkflowDeleteTests', () => {
    execFileSync(process.execPath, ['--test', 'aws/tests/api-workflow.test.mjs', 'aws/tests/frontend-delete-check-bridge.test.mjs'], { cwd: '/workspace', encoding: 'utf8' });
  });
  report.local.awsWorkflowTestsOk = true;

  report.ok = true;
} catch {
  report.ok = false;
}

writeFileSync(`${workDir}/delete-check-preflight.json`, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);

