#!/usr/bin/env node
/**
 * Batch 4 apply: overlay storage TTL + RLS audit modules onto prep Lambda.
 * Does not change Lambda env/VPC/role. Does not FORCE RLS. Does not enable money flags.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const PREP = 'checksops-production-prep-api';

if (!process.argv.includes('--confirm-batch4')) {
  console.error(JSON.stringify({ error: 'refusing_batch4_apply' }));
  process.exit(2);
}

const run = (args) => {
  try {
    const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    const trimmed = String(out || '').trim();
    if (!trimmed) return { ok: true, data: {} };
    try { return { ok: true, data: JSON.parse(trimmed) }; } catch { return { ok: true, data: { raw: trimmed.slice(0, 240) } }; }
  } catch (error) {
    const text = String(error.stderr || error.message || error);
    return { ok: false, denied: /AccessDenied|not authorized/i.test(text), message: text.slice(0, 700) };
  }
};

const attempts = [];
const record = (step, result) => {
  attempts.push({ step, ok: result.ok, denied: result.denied || false, message: result.ok ? null : result.message });
  return result;
};

const sha256Base64File = (filePath) =>
  createHash('sha256').update(readFileSync(filePath)).digest('base64');

const codeUrl = run(['lambda', 'get-function', '--function-name', PREP]);
if (codeUrl.ok && codeUrl.data.Code?.Location) {
  try {
    const work = '/tmp/security/prep-lambda-b4';
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    execFileSync('curl', ['-fsSL', codeUrl.data.Code.Location, '-o', '/tmp/security/prep-b4-current.zip'], { encoding: 'utf8' });
    const expectedSha = codeUrl.data.Configuration?.CodeSha256
      || run(['lambda', 'get-function-configuration', '--function-name', PREP]).data?.CodeSha256
      || null;
    const actualSha = sha256Base64File('/tmp/security/prep-b4-current.zip');
    if (!expectedSha || actualSha !== expectedSha) {
      throw new Error(`live_package_sha_mismatch expected=${expectedSha || 'missing'} actual=${actualSha}`);
    }
    execFileSync('unzip', ['-o', '-q', '/tmp/security/prep-b4-current.zip', '-d', work], { encoding: 'utf8' });
    for (const file of [
      'storage.mjs',
      'homeowner.mjs',
      'documents.mjs',
      'rls-audit.mjs',
      'db-readonly-validate.mjs',
    ]) {
      cpSync(`/workspace/aws/functions/api/${file}`, join(work, file));
    }
    execFileSync('bash', ['-lc', `cd ${work} && zip -qr /tmp/security/prep-b4-updated.zip .`], { encoding: 'utf8' });
    record('updatePrepLambdaCode', run([
      'lambda', 'update-function-code',
      '--function-name', PREP,
      '--zip-file', 'fileb:///tmp/security/prep-b4-updated.zip',
    ]));
    try {
      execFileSync(AWS, ['--region', REGION, 'lambda', 'wait', 'function-updated', '--function-name', PREP], { encoding: 'utf8' });
    } catch { /* describe below */ }
  } catch (error) {
    record('updatePrepLambdaCode', { ok: false, message: String(error.message || error).slice(0, 400) });
  }
} else {
  record('updatePrepLambdaCode', { ok: false, message: codeUrl.message || 'missing_code_location' });
}

const afterPrep = run(['lambda', 'get-function-configuration', '--function-name', PREP]);
const vars = afterPrep.data.Environment?.Variables || {};
const update = attempts.find((row) => row.step === 'updatePrepLambdaCode') || { ok: false };
const report = {
  ok: Boolean(update.ok
    && String(vars.AWS_MOOV_ENABLED || 'false') !== 'true'
    && String(vars.AWS_FINANCIAL_PERMISSIONS_ACTIVATED || 'false') !== 'true'
    && String(vars.AWS_PROVIDER_EXECUTION_ENABLED || 'false') !== 'true'),
  mutated: true,
  forceRlsApplied: false,
  kmsMigrationApplied: false,
  moneyFlags: {
    moov: vars.AWS_MOOV_ENABLED || null,
    checkalt: vars.AWS_CHECKALT_ENABLED || null,
    provider: vars.AWS_PROVIDER_EXECUTION_ENABLED || null,
    financial: vars.AWS_FINANCIAL_PERMISSIONS_ACTIVATED || null,
  },
  lambda: {
    role: afterPrep.data.Role || null,
    filesBucket: vars.FILES_BUCKET || null,
    lastModified: afterPrep.data.LastModified || null,
  },
  overlays: ['storage.mjs', 'homeowner.mjs', 'documents.mjs', 'rls-audit.mjs', 'db-readonly-validate.mjs'],
  attempts,
};
mkdirSync('/tmp/security', { recursive: true });
writeFileSync('/tmp/security/batch4-apply.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
