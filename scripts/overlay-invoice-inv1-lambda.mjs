#!/usr/bin/env node
/**
 * Overlay ONLY the INV1 invoice environment hunk onto the CURRENT live Lambda zip.
 * Does not replace the package. Does not touch W2, billing, SPA, SQL, or env.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assumeCursorRole } from './cognito-staging-token.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AWS = process.env.AWS_CLI || '/usr/local/bin/aws';
const REGION = 'us-east-1';
const OUT = '/opt/cursor/artifacts/invoice-inv1';
const TARGET = process.argv[2] || 'staging';
const API = TARGET === 'production'
  ? 'checksops-production-prep-api'
  : 'checksops-staging-api';
const EXPECTED_SHA = process.env.INV1_EXPECTED_SHA || '';
const ADD_IF_MISSING = [
  'providers/parity/moov-provider-env.mjs',
];
const FROZEN = [
  'tenant-billing-engine.mjs',
  'tenant-billing-destination.mjs',
  'tenant-billing-handlers.mjs',
  'providers/parity/caller.mjs',
  'providers/parity/moov-client.mjs',
  'providers/parity/moov-functions.mjs',
  'providers/parity/moov-rails.mjs',
  'providers/parity/rail-router.mjs',
  'providers/parity/moov-provider-env.mjs',
  'providers/parity/sweep-read.mjs',
  'providers/parity/moov-money.mjs',
  'providers/parity/db.mjs',
  'providers/webhook-apply.mjs',
  'scheduled.mjs',
];

const INVOICE_FIND = `export const invoice = {
  run: async ({ client, body, ctx, fetchImpl }) => {
    const account = await loadMoovAccount(client, ctx.tenantId, 'sandbox');
    if (!account?.provider_account_id) return fail('Set up your payment account first.', 409);
    const accountId = account.provider_account_id;
    const action = body.action || 'create';
    if (action === 'list') {`;

const INVOICE_INSERT = `export const invoice = {
  run: async ({ client, body, ctx, fetchImpl }) => {
    const envRes = requireMoovProviderEnvironment(ctx);
    if (!envRes.ok) {
      return fail(envRes.message || envRes.error, envRes.statusCode || 503, { error: envRes.error });
    }
    const account = await loadMoovAccount(client, ctx.tenantId, envRes.environment);
    const missing = failClosedMissingAccount(account, envRes.environment);
    if (missing) return fail(missing.message || missing.error, missing.statusCode, { error: missing.error });
    const accountId = account.provider_account_id;
    const action = body.action || 'create';
    if (action === 'preflight') {
      return jsonResult({
        success: true,
        preflight: true,
        tenant_id: ctx.tenantId,
        environment: envRes.environment,
        merchantAccountId: accountId,
        liveProviderCalled: false,
        apiVersion: INVOICE_API_VERSION,
      });
    }
    if (action === 'list') {`;

const IMPORT_FIND = `import { fail, jsonResult } from './caller.mjs';`;
const IMPORT_INSERT = `import { fail, jsonResult } from './caller.mjs';
import { failClosedMissingAccount, requireMoovProviderEnvironment } from './moov-provider-env.mjs';`;

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

const patchOnboard = (text) => {
  const steps = [];
  let next = text;
  if (next.includes("from './moov-provider-env.mjs'")) {
    steps.push({ applied: false, reason: 'already_present', label: 'onboard-import-provider-env' });
  } else if (!next.includes(IMPORT_FIND)) {
    return { text: next, steps: [{ applied: false, reason: 'anchor_missing', label: 'onboard-import-provider-env' }] };
  } else {
    next = next.replace(IMPORT_FIND, IMPORT_INSERT);
    steps.push({ applied: true, reason: 'replaced', label: 'onboard-import-provider-env' });
  }
  if (next.includes('action === \'preflight\'') && next.includes('requireMoovProviderEnvironment(ctx)')) {
    steps.push({ applied: false, reason: 'already_present', label: 'invoice-env-lookup' });
    return { text: next, steps };
  }
  if (!next.includes(INVOICE_FIND)) {
    steps.push({ applied: false, reason: 'anchor_missing', label: 'invoice-env-lookup' });
    return { text: next, steps };
  }
  next = next.replace(INVOICE_FIND, INVOICE_INSERT);
  steps.push({ applied: true, reason: 'replaced', label: 'invoice-env-lookup' });
  return { text: next, steps };
};

const main = async () => {
  await mkdir(OUT, { recursive: true });
  await assumeCursorRole(`invoice-inv1-${TARGET}`);
  const before = awsJson(['lambda', 'get-function-configuration', '--function-name', API]);
  const vars = before.Environment?.Variables || {};
  if (EXPECTED_SHA && before.CodeSha256 !== EXPECTED_SHA) {
    const report = { ok: false, error: 'toctou_sha_changed', expected: EXPECTED_SHA, actual: before.CodeSha256, target: TARGET };
    await writeFile(path.join(OUT, `${TARGET}-lambda-toctou-stop.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    process.exit(3);
  }
  if (vars.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST !== 'false') {
    throw new Error('PRODUCTION_POST is not false; refusing overlay');
  }
  if (vars.AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED === 'true') {
    throw new Error('verification POST is true; refusing overlay');
  }

  const loc = awsJson(['lambda', 'get-function', '--function-name', API]);
  if (EXPECTED_SHA && loc.Configuration?.CodeSha256 !== EXPECTED_SHA) {
    throw new Error(`toctou_get_function_sha_changed:${loc.Configuration?.CodeSha256}`);
  }
  const tmp = path.join(os.tmpdir(), `invoice-inv1-${TARGET}-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  const zipIn = path.join(tmp, 'live.zip');
  execFileSync('curl', ['-fsSL', loc.Code.Location, '-o', zipIn], { stdio: 'ignore' });
  const beforePkg = path.join(tmp, 'before');
  const afterPkg = path.join(tmp, 'after');
  fs.mkdirSync(beforePkg, { recursive: true });
  fs.mkdirSync(afterPkg, { recursive: true });
  execFileSync('unzip', ['-qo', zipIn, '-d', beforePkg]);
  execFileSync('unzip', ['-qo', zipIn, '-d', afterPkg]);

  const onboardPath = path.join(afterPkg, 'providers/parity/moov-onboard.mjs');
  if (!fs.existsSync(onboardPath)) throw new Error('live_onboard_missing');
  const beforeOnboardHash = sha256(onboardPath);
  const patched = patchOnboard(fs.readFileSync(onboardPath, 'utf8'));
  if (patched.steps.some((step) => step.reason === 'anchor_missing')) {
    const report = {
      ok: false,
      error: 'target_file_ambiguous_or_newer',
      message: 'Live moov-onboard.mjs invoice hunk did not match the frozen sandbox lookup. Stopping.',
      steps: patched.steps,
      beforeOnboardHash,
    };
    await writeFile(path.join(OUT, `${TARGET}-lambda-stop.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    process.exit(4);
  }
  fs.writeFileSync(onboardPath, patched.text);

  const added = [];
  for (const rel of ADD_IF_MISSING) {
    const dest = path.join(afterPkg, rel);
    if (fs.existsSync(dest)) continue;
    const src = path.join(ROOT, 'aws/functions/api', rel);
    if (!fs.existsSync(src)) throw new Error(`missing_helper_source:${rel}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    added.push({
      file: rel,
      action: 'add_if_missing',
      afterHash: sha256(dest),
      reasonChanged: 'Existing W2 provider-environment helper required by the invoice import. Added only because the live package did not already contain it.',
    });
  }

  const beforeFiles = new Map(walk(beforePkg).map((file) => [path.relative(beforePkg, file), sha256(file)]));
  const afterFiles = new Map(walk(afterPkg).map((file) => [path.relative(afterPkg, file), sha256(file)]));
  const changed = [];
  const unchanged = [];
  for (const [rel, hash] of afterFiles) {
    if (beforeFiles.get(rel) !== hash) changed.push({ file: rel, before: beforeFiles.get(rel) || null, after: hash });
    else unchanged.push({ file: rel, sha256: hash, reason: 'unchanged' });
  }
  for (const rel of FROZEN) {
    if (!beforeFiles.has(rel) && ADD_IF_MISSING.includes(rel)) continue;
    if (beforeFiles.get(rel) !== afterFiles.get(rel)) throw new Error(`frozen_file_changed:${rel}`);
  }
  const allowed = new Set(['providers/parity/moov-onboard.mjs', ...added.map((row) => row.file)]);
  const unexpected = changed.filter((row) => !allowed.has(row.file));
  if (unexpected.length) throw new Error(`unexpected_overlay_changes:${unexpected.map((r) => r.file).join(',')}`);

  const zipOut = path.join(tmp, 'overlay.zip');
  execFileSync('zip', ['-qr', zipOut, '.'], { cwd: afterPkg });
  fs.copyFileSync(zipOut, path.join(OUT, `${TARGET}-overlay-candidate.zip`));

  const toctou = awsJson(['lambda', 'get-function-configuration', '--function-name', API]);
  if (EXPECTED_SHA && toctou.CodeSha256 !== EXPECTED_SHA) {
    const report = { ok: false, error: 'toctou_pre_update_sha_changed', expected: EXPECTED_SHA, actual: toctou.CodeSha256 };
    await writeFile(path.join(OUT, `${TARGET}-lambda-toctou-stop.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    process.exit(3);
  }

  const updated = awsJson([
    'lambda', 'update-function-code',
    '--function-name', API,
    '--zip-file', `fileb://${zipOut}`,
  ]);
  waitFn(API);
  const after = awsJson(['lambda', 'get-function-configuration', '--function-name', API]);
  const afterVars = after.Environment?.Variables || {};
  const report = {
    ok: true,
    target: TARGET,
    api: API,
    beforeSha: before.CodeSha256,
    afterSha: after.CodeSha256,
    beforeRevision: before.RevisionId,
    afterRevision: after.RevisionId,
    lastModified: after.LastModified,
    overlayManifest: [{
      file: 'providers/parity/moov-onboard.mjs',
      currentProductionSha: beforeOnboardHash,
      candidateSha: sha256(onboardPath),
      reasonChanged: 'Reuse W2 requireMoovProviderEnvironment + failClosedMissingAccount for moov-invoice; add non-mutating preflight. Invoice API version/scopes unchanged.',
      steps: patched.steps,
    }, ...added],
    unchangedProof: unchanged.filter((row) => FROZEN.includes(row.file)),
    changed,
    monthlyPost: afterVars.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST || null,
    verificationPost: afterVars.AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED || null,
    spaDeployed: false,
    sqlApplied: false,
    envModified: false,
    update: { codeSha256: updated.CodeSha256, revisionId: updated.RevisionId },
  };
  await writeFile(path.join(OUT, `${TARGET}-lambda-overlay.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (afterVars.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST !== 'false') process.exit(2);
  if (afterVars.AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED === 'true') process.exit(2);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
