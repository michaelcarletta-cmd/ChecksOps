#!/usr/bin/env node
/**
 * Production narrow overlay with Phase 1 freeze preflight.
 *
 * Default is local/preflight-only and does not call AWS.
 * --live-preflight fetches the current live package and diffs; no mutation.
 * UpdateFunctionCode runs only when both --apply and
 * CHECKSOPS_PRODUCTION_DEPLOY=1 are set AND every freeze check passes.
 * There is no force-through path.
 *
 * Never calls UpdateFunctionConfiguration.
 * Never executes SQL.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PHASE1_FREEZE_LABEL,
  PRODUCTION_FUNCTION,
  assertCandidatePreservesPhase1,
  assertCodeOnlyPromotion,
  assertDeployShaUnchanged,
  assertPromotionScriptsRemainCodeOnly,
  loadPhase1FreezeManifest,
  planNarrowOverlay,
  reportConfigDrift,
  requireCandidateBaselineSha,
} from './lib/phase1-freeze.mjs';

const AWS = process.env.AWS_CLI || (existsSync(`${process.env.HOME}/.local/bin/aws`)
  ? `${process.env.HOME}/.local/bin/aws`
  : 'aws');
const REGION = process.env.AWS_REGION || 'us-east-1';
const FUNCTION_NAME = process.env.PRODUCTION_API_FUNCTION || PRODUCTION_FUNCTION;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const awsJson = (args) => JSON.parse(execFileSync(AWS, ['--region', REGION, ...args], { encoding: 'utf8' }));

const parseArgs = (argv) => {
  const args = {
    apply: false,
    livePreflight: false,
    files: [],
    removes: [],
    baselineSha: process.env.CANDIDATE_BASELINE_SHA || '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--apply') args.apply = true;
    else if (token === '--live-preflight') args.livePreflight = true;
    else if (token === '--file') args.files.push(argv[++i]);
    else if (token === '--remove') args.removes.push(argv[++i]);
    else if (token === '--baseline-sha') args.baselineSha = argv[++i];
  }
  return args;
};

const zipListing = (zipPath) => execFileSync('unzip', ['-Z', '-1', zipPath], { encoding: 'utf8' })
  .split('\n')
  .map((row) => row.trim())
  .filter(Boolean);

const findZipEntry = (names, basename) => {
  const matches = names.filter((name) => name === basename || name.endsWith(`/${basename}`));
  return matches.find((name) => !name.includes('node_modules')) || matches[0] || basename;
};

export const runProductionPreflight = ({
  root = ROOT,
  liveSha,
  baselineSha,
  liveFiles,
  candidateFiles,
  intendedAdds = [],
  intendedModifies = [],
  intendedRemoves = [],
  liveConfig = null,
  candidateConfig = null,
  applyConfig = false,
  executeSql = false,
} = {}) => {
  requireCandidateBaselineSha(baselineSha);
  const freeze = assertCandidatePreservesPhase1(root);
  assertCodeOnlyPromotion({ applyConfig, executeSql, updateFunctionConfiguration: applyConfig });
  assertPromotionScriptsRemainCodeOnly(root);
  const plan = planNarrowOverlay({
    liveFiles,
    candidateFiles,
    intendedAdds,
    intendedModifies,
    intendedRemoves,
    liveSha,
    baselineSha,
    candidateMode: 'narrow-overlay',
    applyConfig,
    executeSql,
    liveConfig,
    candidateConfig,
  });
  const configDrift = reportConfigDrift(liveConfig || {}, candidateConfig || liveConfig || {});
  return {
    ok: plan.ok,
    errors: plan.errors,
    freeze,
    plan,
    configDrift,
    configurationUpdated: false,
    sqlExecuted: false,
  };
};

const fetchLive = () => {
  const fn = awsJson(['lambda', 'get-function', '--function-name', FUNCTION_NAME]);
  return {
    sha: fn.Configuration?.CodeSha256,
    location: fn.Code?.Location,
    config: fn.Configuration,
  };
};

const writePromotionManifest = (payload) => {
  const dest = process.env.PHASE1_PROMOTION_MANIFEST
    || path.join(os.tmpdir(), 'phase1-production-promotion-manifest.json');
  writeFileSync(dest, JSON.stringify(payload, null, 2));
  return dest;
};

const prepareLivePackage = (args) => {
  const live = fetchLive();
  const baselineSha = requireCandidateBaselineSha(args.baselineSha);
  const work = mkdtempSync(path.join(os.tmpdir(), 'phase1-prod-overlay-'));
  const zipPath = path.join(work, 'live.zip');
  execFileSync('curl', ['-fsSL', live.location, '-o', zipPath]);
  const names = zipListing(zipPath);
  const extractDir = path.join(work, 'pkg');
  mkdirSync(extractDir);
  execFileSync('unzip', ['-o', '-q', zipPath, '-d', extractDir]);

  const liveFiles = {};
  const candidateFiles = {};
  const intendedAdds = [];
  const intendedModifies = [];
  for (const rel of args.files) {
    const src = path.join(ROOT, rel);
    if (!existsSync(src)) throw new Error(`missing candidate file ${rel}`);
    const basename = path.basename(rel);
    const entry = findZipEntry(names, basename);
    const dest = path.join(extractDir, entry);
    liveFiles[entry] = existsSync(dest) ? readFileSync(dest, 'utf8') : null;
    candidateFiles[entry] = readFileSync(src, 'utf8');
    if (liveFiles[entry] == null) intendedAdds.push(entry);
    else intendedModifies.push(entry);
  }
  for (const rel of args.removes) {
    const basename = path.basename(rel);
    const entry = findZipEntry(names, basename);
    const dest = path.join(extractDir, entry);
    if (existsSync(dest)) liveFiles[entry] = readFileSync(dest, 'utf8');
  }

  const preflight = runProductionPreflight({
    root: ROOT,
    liveSha: live.sha,
    baselineSha,
    liveFiles: Object.fromEntries(Object.entries(liveFiles).filter(([, value]) => value != null)),
    candidateFiles,
    intendedAdds,
    intendedModifies,
    intendedRemoves: args.removes.map((rel) => findZipEntry(names, path.basename(rel))),
    liveConfig: live.config,
    candidateConfig: live.config,
    applyConfig: false,
    executeSql: false,
  });

  return {
    live,
    baselineSha,
    work,
    names,
    extractDir,
    preflight,
  };
};

const main = (argv = process.argv.slice(2)) => {
  const args = parseArgs(argv);
  const manifest = loadPhase1FreezeManifest(ROOT);
  assertCandidatePreservesPhase1(ROOT);
  assertCodeOnlyPromotion({ applyConfig: false, executeSql: false });
  assertPromotionScriptsRemainCodeOnly(ROOT);

  if (!args.apply && !args.livePreflight) {
    console.log(JSON.stringify({
      ok: true,
      mode: 'preflight-only',
      functionName: FUNCTION_NAME,
      phase1: manifest.status,
      shaPinPolicy: manifest.shaPinPolicy,
      note: 'No AWS call. Use --live-preflight to diff the current live package, or --apply with CHECKSOPS_PRODUCTION_DEPLOY=1 and --baseline-sha after that preflight.',
    }, null, 2));
    return 0;
  }

  if (args.apply && process.env.CHECKSOPS_PRODUCTION_DEPLOY !== '1') {
    console.error(`${PHASE1_FREEZE_LABEL}: --apply requires CHECKSOPS_PRODUCTION_DEPLOY=1`);
    return 1;
  }
  if (args.apply && args.livePreflight) {
    console.error(`${PHASE1_FREEZE_LABEL}: --live-preflight and --apply are mutually exclusive`);
    return 1;
  }
  if (FUNCTION_NAME !== PRODUCTION_FUNCTION && !/production/i.test(FUNCTION_NAME)) {
    console.error(`${PHASE1_FREEZE_LABEL}: refusing non-production function ${FUNCTION_NAME}`);
    return 1;
  }
  if (!args.files.length && !args.removes.length) {
    console.error(`${PHASE1_FREEZE_LABEL}: narrow overlay requires explicit --file or --remove`);
    return 1;
  }
  requireCandidateBaselineSha(args.baselineSha);

  const prepared = prepareLivePackage(args);
  if (!prepared.preflight.ok) {
    console.error(JSON.stringify({
      ok: false,
      errors: prepared.preflight.errors,
      manifest: prepared.preflight.plan.manifest,
      configDrift: prepared.preflight.configDrift,
    }, null, 2));
    rmSync(prepared.work, { recursive: true, force: true });
    return 1;
  }

  const promotionManifest = {
    ...prepared.preflight.plan.manifest,
    productionShaBefore: prepared.live.sha,
    candidateBaselineSha: prepared.baselineSha,
    configDrift: prepared.preflight.configDrift,
    configurationUpdated: false,
    sqlExecuted: false,
  };
  const manifestPath = writePromotionManifest(promotionManifest);

  if (args.livePreflight) {
    console.log(JSON.stringify({
      ok: true,
      mode: 'live-preflight',
      functionName: FUNCTION_NAME,
      manifestPath,
      manifest: promotionManifest,
    }, null, 2));
    rmSync(prepared.work, { recursive: true, force: true });
    return 0;
  }

  for (const rel of args.files) {
    const basename = path.basename(rel);
    const entry = findZipEntry(prepared.names, basename);
    const dest = path.join(prepared.extractDir, entry);
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(path.join(ROOT, rel), dest);
  }
  for (const rel of args.removes) {
    const basename = path.basename(rel);
    const entry = findZipEntry(prepared.names, basename);
    const dest = path.join(prepared.extractDir, entry);
    if (existsSync(dest)) rmSync(dest);
  }
  const outZip = path.join(prepared.work, 'updated.zip');
  execFileSync('zip', ['-qr', outZip, '.'], { cwd: prepared.extractDir });

  const recheck = fetchLive();
  assertDeployShaUnchanged({ preflightSha: prepared.live.sha, currentSha: recheck.sha });

  awsJson(['lambda', 'update-function-code', '--function-name', FUNCTION_NAME, '--zip-file', `fileb://${outZip}`]);
  console.log(JSON.stringify({
    ok: true,
    applied: true,
    manifestPath,
    manifest: promotionManifest,
  }, null, 2));
  rmSync(prepared.work, { recursive: true, force: true });
  return 0;
};

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error.message || error);
    process.exitCode = 1;
  }
}
