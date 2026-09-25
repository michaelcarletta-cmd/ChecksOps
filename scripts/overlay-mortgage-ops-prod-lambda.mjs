#!/usr/bin/env node
/**
 * Overlay accepted Mortgage Ops billing files onto CURRENT production Lambda.
 * UpdateFunctionCode only. Does not rewrite environment or enable PRODUCTION_POST.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assumeCursorRole } from './cognito-staging-token.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AWS = process.env.AWS_CLI || '/usr/local/bin/aws';
const REGION = 'us-east-1';
const OUT = '/opt/cursor/artifacts/mortgage-ops-prod-safe';
const PROD_API = 'checksops-production-prep-api';
const EXPECTED_ACCOUNT = '41cb5d67-4911-4bef-aad5-d8ee9c582208';
const EXPECTED_METHOD = 'c70a90f2-9bcc-4084-8263-d5a0fb5d806c';
const OVERLAY = [
  'tenant-billing-engine.mjs',
  'tenant-billing-handlers.mjs',
  'write-allowlist.mjs',
];
const LIVE_PATCH = ['workflow-rpc.mjs'];
const ACCEPT_HOOK = `  if (!rows.length) return { error: 'already_taken', message: 'already_taken' };
  try {
    const { accrueMortgageOpsAcceptedRequest } = await import('./tenant-billing-engine.mjs');
    await accrueMortgageOpsAcceptedRequest(client, { request: rows[0], persist: true });
  } catch {
    // Accept must succeed even if usage accrual is retried later by the DB trigger.
  }
  return { data: rows[0] };
};`;
const ACCEPT_ANCHOR = `  if (!rows.length) return { error: 'already_taken', message: 'already_taken' };
  return { data: rows[0] };
};`;
const FROZEN = [
  'providers/parity/moov-money.mjs',
  'providers/parity/rail-router.mjs',
  'providers/webhook-apply.mjs',
  'tenant-billing-destination.mjs',
  'scheduled.mjs',
];
const FROZEN_FLAGS = [
  'AWS_MOOV_MONTHLY_BILLING_ENABLED',
  'AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST',
  'AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID',
  'AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID',
  'AWS_MOOV_ENABLED',
  'AWS_PROVIDER_EXECUTION_ENABLED',
  'AWS_MOOV_TRANSFER_POST_ENABLED',
  'AWS_CHECKALT_ENABLED',
  'AWS_CHECKALT_STATUS_RECONCILE_ENABLED',
  'CHECKSOPS_ENV',
];
const REASONS = {
  'tenant-billing-engine.mjs': 'Mortgage Ops accrual + cutoff + consolidated invoice totals',
  'tenant-billing-handlers.mjs': 'Mortgage Ops rate update fields',
  'write-allowlist.mjs': 'Allow tenant mortgage rate columns on admin save',
  'workflow-rpc.mjs': 'Narrow accept-hook forward-port onto current live workflow-rpc',
};

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const awsJson = (args) => {
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
    encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
  });
  return out.trim() ? JSON.parse(out) : {};
};
const waitFn = (name) => {
  try { execFileSync(AWS, ['lambda', 'wait', 'function-updated', '--function-name', name]); } catch { /* ok */ }
  try { execFileSync(AWS, ['lambda', 'wait', 'function-active', '--function-name', name]); } catch { /* ok */ }
};
const walk = (dir) => {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
};

const main = async () => {
  await mkdir(OUT, { recursive: true });
  await assumeCursorRole('mortgage-ops-lambda-overlay');
  const baseline = JSON.parse(fs.readFileSync(path.join(OUT, 'production-baseline.json'), 'utf8'));
  const expectedSha = baseline.productionLambda.codeSha256;
  const before = awsJson(['lambda', 'get-function-configuration', '--function-name', PROD_API]);
  const vars = before.Environment?.Variables || {};
  if (before.CodeSha256 !== expectedSha) {
    const report = {
      ok: false,
      error: 'toctou_sha_changed',
      expected: expectedSha,
      actual: before.CodeSha256,
      lastModified: before.LastModified,
    };
    await writeFile(path.join(OUT, 'lambda-toctou-stop.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    process.exit(3);
  }
  if (vars.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST !== 'false') {
    throw new Error('PRODUCTION_POST is not false; refusing overlay');
  }
  if (vars.AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID !== EXPECTED_ACCOUNT
    || vars.AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID !== EXPECTED_METHOD) {
    throw new Error('destination mismatch; refusing overlay');
  }

  const loc = awsJson(['lambda', 'get-function', '--function-name', PROD_API]);
  if (loc.Configuration?.CodeSha256 !== expectedSha) {
    throw new Error(`toctou_get_function_sha_changed:${loc.Configuration?.CodeSha256}`);
  }
  const tmp = path.join(os.tmpdir(), `mortgage-ops-prod-overlay-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  const zipIn = path.join(tmp, 'live.zip');
  execFileSync('curl', ['-fsSL', loc.Code.Location, '-o', zipIn], { stdio: 'ignore' });
  const beforePkg = path.join(tmp, 'before');
  const afterPkg = path.join(tmp, 'after');
  fs.mkdirSync(beforePkg, { recursive: true });
  fs.mkdirSync(afterPkg, { recursive: true });
  execFileSync('unzip', ['-qo', zipIn, '-d', beforePkg]);
  execFileSync('unzip', ['-qo', zipIn, '-d', afterPkg]);

  const overlayManifest = [];
  for (const rel of OVERLAY) {
    const src = path.join(ROOT, 'aws/functions/api', rel);
    const dest = path.join(afterPkg, rel);
    const currentHash = fs.existsSync(path.join(beforePkg, rel)) ? sha256(path.join(beforePkg, rel)) : null;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    overlayManifest.push({
      file: rel,
      currentHash,
      candidateHash: sha256(src),
      afterHash: sha256(dest),
      reason: REASONS[rel],
    });
  }

  const liveRpc = path.join(beforePkg, 'workflow-rpc.mjs');
  const destRpc = path.join(afterPkg, 'workflow-rpc.mjs');
  const liveRpcText = fs.readFileSync(liveRpc, 'utf8');
  if (liveRpcText.includes('accrueMortgageOpsAcceptedRequest')) {
    throw new Error('live workflow-rpc already has Mortgage Ops accrual; collision');
  }
  if (!liveRpcText.includes(ACCEPT_ANCHOR)) {
    throw new Error('live executeAcceptMortgage anchor missing; refusing wholesale replace');
  }
  const patchedRpc = liveRpcText.replace(ACCEPT_ANCHOR, ACCEPT_HOOK);
  if (patchedRpc === liveRpcText || (patchedRpc.match(/accrueMortgageOpsAcceptedRequest/g) || []).length !== 1) {
    throw new Error('workflow-rpc accept hook patch failed');
  }
  fs.writeFileSync(destRpc, patchedRpc);
  overlayManifest.push({
    file: 'workflow-rpc.mjs',
    currentHash: sha256(liveRpc),
    candidateHash: sha256(destRpc),
    afterHash: sha256(destRpc),
    reason: REASONS['workflow-rpc.mjs'],
    method: 'live_forward_port_patch',
  });

  const beforeFiles = new Map(walk(beforePkg).map((file) => [path.relative(beforePkg, file), sha256(file)]));
  const afterFiles = new Map(walk(afterPkg).map((file) => [path.relative(afterPkg, file), sha256(file)]));
  const changed = [];
  const unchangedFrozen = [];
  for (const [rel, hash] of afterFiles) {
    const prev = beforeFiles.get(rel);
    if (prev !== hash) changed.push({ file: rel, before: prev, after: hash });
  }
  for (const [rel, hash] of beforeFiles) {
    if (!afterFiles.has(rel)) changed.push({ file: rel, before: hash, after: null, deleted: true });
  }
  for (const rel of FROZEN) {
    const beforeHash = beforeFiles.get(rel);
    const afterHash = afterFiles.get(rel);
    unchangedFrozen.push({ file: rel, identical: beforeHash === afterHash, hash: afterHash });
    if (beforeHash !== afterHash) throw new Error(`frozen_file_changed:${rel}`);
  }
  const unexpected = changed.filter((row) => ![...OVERLAY, ...LIVE_PATCH].includes(row.file));
  if (unexpected.length) {
    throw new Error(`unexpected_overlay_changes:${unexpected.map((r) => r.file).join(',')}`);
  }

  const zipOut = path.join(tmp, 'overlay.zip');
  execFileSync('zip', ['-qr', zipOut, '.'], { cwd: afterPkg });
  fs.copyFileSync(zipOut, path.join(OUT, 'production-overlay-candidate.zip'));

  const toctou = awsJson(['lambda', 'get-function-configuration', '--function-name', PROD_API]);
  if (toctou.CodeSha256 !== expectedSha) {
    const report = {
      ok: false,
      error: 'toctou_pre_update_sha_changed',
      expected: expectedSha,
      actual: toctou.CodeSha256,
      lastModified: toctou.LastModified,
    };
    await writeFile(path.join(OUT, 'lambda-toctou-stop.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    process.exit(3);
  }

  const updated = awsJson([
    'lambda', 'update-function-code',
    '--function-name', PROD_API,
    '--zip-file', `fileb://${zipOut}`,
  ]);
  waitFn(PROD_API);
  const after = awsJson(['lambda', 'get-function-configuration', '--function-name', PROD_API]);
  const afterVars = after.Environment?.Variables || {};
  const flagDrift = FROZEN_FLAGS.filter((key) => String(afterVars[key] ?? '') !== String(vars[key] ?? ''));
  if (afterVars.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST !== 'false') {
    throw new Error('PRODUCTION_POST drifted after overlay');
  }

  const report = {
    ok: after.State === 'Active' || after.LastUpdateStatus === 'Successful',
    beforeSha: expectedSha,
    afterSha: after.CodeSha256,
    lastModified: after.LastModified,
    revisionId: after.RevisionId,
    lastUpdateStatus: after.LastUpdateStatus,
    overlayManifest,
    changedFiles: changed,
    unchangedFrozen,
    envRewritten: false,
    flagDrift,
    productionPost: afterVars.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST,
    destination: {
      account: afterVars.AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID,
      method: afterVars.AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID,
    },
    updateFunctionCodeSha: updated.CodeSha256 || null,
  };
  await writeFile(path.join(OUT, 'lambda-overlay.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok || flagDrift.length) process.exit(2);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
