#!/usr/bin/env node
/**
 * Overlay ONLY W2 WalletOps read-path hunks onto the CURRENT live Lambda zip.
 * New files are added. Existing files are patched in place so newer unrelated
 * work is preserved. Does not enable billing POST gates. No sweep mutation.
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
const OUT = '/opt/cursor/artifacts/walletops-w2';
const TARGET = process.argv[2] || 'staging';
const API = TARGET === 'production'
  ? 'checksops-production-prep-api'
  : 'checksops-staging-api';
const EXPECTED_SHA = process.env.W2_EXPECTED_SHA || '';
const NEW_FILES = [
  'providers/parity/moov-provider-env.mjs',
  'providers/parity/sweep-read.mjs',
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
  'providers/webhook-apply.mjs',
  'scheduled.mjs',
];

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

const mustReplace = (text, find, insert, label) => {
  if (text.includes(insert.trim())) return { text, applied: false, reason: 'already_present', label };
  if (!text.includes(find)) return { text, applied: false, reason: 'anchor_missing', label };
  return { text: text.replace(find, insert), applied: true, label };
};
const slimSteps = (steps) => steps.map(({ text, ...rest }) => rest);

const patchDb = (text) => {
  const steps = [];
  let next = text;
  let step = mustReplace(
    next,
    `export const loadConnectedMethod = async (client, { tenantId, providerAccountId, externalRecipientId = null }) => {`,
    `export const loadConnectedMethod = async (client, {
  tenantId, providerAccountId, externalRecipientId = null, environment = 'sandbox',
}) => {`,
    'loadConnectedMethod-signature',
  );
  steps.push(step); next = step.text;
  step = mustReplace(
    next,
    `     WHERE tenant_id = $1::uuid AND provider = 'moov' AND environment = 'sandbox'
       AND provider_account_id = $2 AND connection_status = 'connected'`,
    `     WHERE tenant_id = $1::uuid AND provider = 'moov' AND environment = $3
       AND provider_account_id = $2 AND connection_status = 'connected'`,
    'loadConnectedMethod-sql',
  );
  steps.push(step); next = step.text;
  step = mustReplace(
    next,
    `    [tenantId, providerAccountId],
  )).rows[0] || null;
};`,
    `    [tenantId, providerAccountId, environment],
  )).rows[0] || null;
};`,
    'loadConnectedMethod-params',
  );
  steps.push(step); next = step.text;
  return { text: next, steps };
};

const patchOnboard = (text) => {
  const steps = [];
  let next = text;
  let step = mustReplace(
    next,
    `import { fail, jsonResult } from './caller.mjs';`,
    `import { fail, jsonResult } from './caller.mjs';
import { readSweepHistory, readSweepSnapshot, resolveSweepAccount } from './sweep-read.mjs';`,
    'onboard-import-sweep-read',
  );
  steps.push(step); next = step.text;
  step = mustReplace(
    next,
    `import { syncWallet } from './moov-wallet.mjs';`,
    `import { readWallet, syncWallet } from './moov-wallet.mjs';`,
    'onboard-import-read-wallet',
  );
  steps.push(step); next = step.text;
  const start = next.indexOf('export const sweepConfig = {');
  const end = next.indexOf('const INVOICE_API_VERSION');
  if (start < 0 || end < 0 || end <= start) {
    steps.push({ applied: false, reason: 'sweepConfig_block_missing', label: 'sweepConfig' });
    return { text: next, steps };
  }
  const replacement = fs.readFileSync(path.join(ROOT, 'aws/functions/api/providers/parity/moov-onboard.mjs'), 'utf8');
  const from = replacement.indexOf('export const sweepConfig = {');
  const to = replacement.indexOf('const INVOICE_API_VERSION');
  next = `${next.slice(0, start)}${replacement.slice(from, to)}${next.slice(end)}`;
  steps.push({ applied: true, reason: 'replaced', label: 'sweepConfig' });
  return { text: next, steps };
};

const patchMoney = (text) => {
  const steps = [];
  let next = text;
  let step = mustReplace(
    next,
    `import { fail, jsonResult } from './caller.mjs';`,
    `import { fail, jsonResult } from './caller.mjs';
import { failClosedMissingAccount, requireMoovProviderEnvironment } from './moov-provider-env.mjs';`,
    'money-import-env',
  );
  steps.push(step); next = step.text;
  step = mustReplace(
    next,
    `import { postTransferLedger, syncWallet, writeLedgerEntry } from './moov-wallet.mjs';`,
    `import { postTransferLedger, readWallet, syncWallet, writeLedgerEntry } from './moov-wallet.mjs';`,
    'money-import-read-wallet',
  );
  steps.push(step); next = step.text;
  const liveStart = next.indexOf('export const walletFund = {');
  const repo = fs.readFileSync(path.join(ROOT, 'aws/functions/api/providers/parity/moov-money.mjs'), 'utf8');
  const repoStart = repo.indexOf('export async function resolveWalletFundContext');
  const repoExport = repo.indexOf('export const walletFund = {');
  const repoAfterLookup = repo.indexOf('    if (!wallet?.provider_payment_method_id)', repoExport);
  if (liveStart < 0 || repoStart < 0 || repoAfterLookup < 0) {
    steps.push({ applied: false, reason: 'walletFund_block_missing', label: 'walletFund' });
    return { text: next, steps };
  }
  const liveAfterLookup = next.indexOf('    if (!wallet.provider_payment_method_id)', liveStart) >= 0
    ? next.indexOf('    if (!wallet.provider_payment_method_id)', liveStart)
    : next.indexOf('    if (!wallet?.provider_payment_method_id)', liveStart);
  if (liveAfterLookup < 0) {
    steps.push({ applied: false, reason: 'walletFund_anchor_missing', label: 'walletFund' });
    return { text: next, steps };
  }
  next = `${next.slice(0, liveStart)}${repo.slice(repoStart, repoAfterLookup)}${next.slice(liveAfterLookup)}`;
  next = next.replace(
    '    if (!wallet.provider_payment_method_id) {\n      return fail(\'Your balance account is not ready to receive funds yet.\', 409);\n    }',
    '    if (!wallet?.provider_payment_method_id) {\n      return fail(\'Your balance account is not ready to receive funds yet.\', 409);\n    }',
  );
  steps.push({ applied: true, reason: 'replaced', label: 'walletFund-lookup' });
  return { text: next, steps };
};

const main = async () => {
  await mkdir(OUT, { recursive: true });
  await assumeCursorRole(`walletops-w2-${TARGET}`);
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
  const tmp = path.join(os.tmpdir(), `walletops-w2-${TARGET}-${Date.now()}`);
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
  for (const rel of NEW_FILES) {
    const src = path.join(ROOT, 'aws/functions/api', rel);
    const dest = path.join(afterPkg, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    overlayManifest.push({ file: rel, action: 'add', afterHash: sha256(dest) });
  }

  const dbPath = path.join(afterPkg, 'providers/parity/db.mjs');
  const dbPatched = patchDb(fs.readFileSync(dbPath, 'utf8'));
  if (dbPatched.steps.some((s) => s.reason === 'anchor_missing')) {
    throw new Error(`db_patch_failed:${JSON.stringify(dbPatched.steps)}`);
  }
  fs.writeFileSync(dbPath, dbPatched.text);
  overlayManifest.push({ file: 'providers/parity/db.mjs', action: 'patch', steps: slimSteps(dbPatched.steps), afterHash: sha256(dbPath) });

  const onboardPath = path.join(afterPkg, 'providers/parity/moov-onboard.mjs');
  const onboardPatched = patchOnboard(fs.readFileSync(onboardPath, 'utf8'));
  if (onboardPatched.steps.some((s) => s.applied === false && s.reason !== 'already_present')) {
    throw new Error(`onboard_patch_failed:${JSON.stringify(onboardPatched.steps)}`);
  }
  fs.writeFileSync(onboardPath, onboardPatched.text);
  overlayManifest.push({ file: 'providers/parity/moov-onboard.mjs', action: 'patch', steps: slimSteps(onboardPatched.steps), afterHash: sha256(onboardPath) });

  const moneyPath = path.join(afterPkg, 'providers/parity/moov-money.mjs');
  const moneyPatched = patchMoney(fs.readFileSync(moneyPath, 'utf8'));
  if (moneyPatched.steps.some((s) => s.applied === false && s.reason !== 'already_present')) {
    throw new Error(`money_patch_failed:${JSON.stringify(moneyPatched.steps)}`);
  }
  fs.writeFileSync(moneyPath, moneyPatched.text);
  overlayManifest.push({ file: 'providers/parity/moov-money.mjs', action: 'patch', steps: slimSteps(moneyPatched.steps), afterHash: sha256(moneyPath) });

  const beforeFiles = new Map(walk(beforePkg).map((file) => [path.relative(beforePkg, file), sha256(file)]));
  const afterFiles = new Map(walk(afterPkg).map((file) => [path.relative(afterPkg, file), sha256(file)]));
  const changed = [];
  for (const [rel, hash] of afterFiles) {
    if (beforeFiles.get(rel) !== hash) changed.push({ file: rel, before: beforeFiles.get(rel) || null, after: hash });
  }
  for (const rel of FROZEN) {
    if (beforeFiles.get(rel) !== afterFiles.get(rel)) throw new Error(`frozen_file_changed:${rel}`);
  }
  const allowed = new Set([
    ...NEW_FILES,
    'providers/parity/db.mjs',
    'providers/parity/moov-onboard.mjs',
    'providers/parity/moov-money.mjs',
  ]);
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
    overlayManifest,
    changed,
    monthlyPost: afterVars.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST || null,
    verificationPost: afterVars.AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED || null,
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
