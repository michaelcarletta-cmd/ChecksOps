#!/usr/bin/env node
/**
 * Narrow production write: same-URL CheckFilesSection-nvXkZh5q.js only.
 * Overlays the current DyoF Files Signature wizard onto check-scoped upload
 * and Class A send-signature-request create.
 * Does not restore C9Qr/BJZ. Does not write index.html, DyoF, CCC, Sign, DTP, or Lambda.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  EXPECTED_CCC_SHA256,
  EXPECTED_ENTRY_SHA256,
  EXPECTED_FILES_SHA256,
  EXPECTED_HTML_SHA256,
  FILES_KEY,
  LIVE_CCC,
  LIVE_ENTRY,
  LIVE_FILES,
  filesInvariants,
  patchDyofNvxkFiles,
} from './lib/sig-dyof-nvxk-files-patch.mjs';

const require = createRequire(import.meta.url);
const acorn = require('acorn');

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const BUCKET = 'checksops-production-frontend-806168576068';
const DISTRIBUTION = 'E1B0ZWWO5559U5';
const LAMBDA = 'checksops-production-prep-api';
const SPA_DEPLOY_ROLE = 'arn:aws:iam::806168576068:role/ChecksOpsProductionSpaDeploy';
const WORK = '/tmp/sig-dyof-nvxk-files';
const APPLY = process.argv.includes('--apply');
const LIVE_SIGN = 'Sign-CPLc-MwJ.js';
const LIVE_DTP = 'SharedCheckPaymentDirection-CDUDGHWu.js';
const SIGN_KEY = `assets/${LIVE_SIGN}`;
const DTP_KEY = `assets/${LIVE_DTP}`;
const LOCK_KEY = '_checksops/release-write.lock';
const FORBIDDEN_KEYS = [
  'index.html',
  `assets/${LIVE_ENTRY}`,
  `assets/${LIVE_CCC}`,
  SIGN_KEY,
  DTP_KEY,
  'assets/index-C9QrEEkl.js',
  'assets/CheckFilesSection-BJZPqPpX.js',
  'assets/Sign-DfWZrlqT.js',
];

const oidcToken = () => new Promise((resolve, reject) => {
  const req = http.request({
    socketPath: '/run/cursor/api.sock',
    path: '/v1/tokens/oidc',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  }, (res) => {
    const chunks = [];
    res.on('data', (d) => chunks.push(d));
    res.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')).token); }
      catch (error) { reject(error); }
    });
  });
  req.on('error', reject);
  req.write(JSON.stringify({ aud: 'sts.amazonaws.com' }));
  req.end();
});

const applyCreds = (creds) => {
  process.env.AWS_ACCESS_KEY_ID = creds.AccessKeyId;
  process.env.AWS_SECRET_ACCESS_KEY = creds.SecretAccessKey;
  process.env.AWS_SESSION_TOKEN = creds.SessionToken;
  process.env.AWS_REGION = REGION;
};

const awsJson = (args) => {
  const joined = args.join(' ');
  if (/update-function|create-function|publish-version/i.test(joined)) {
    throw new Error(`forbidden Lambda mutation: ${joined}`);
  }
  if (joined.includes('--delete') && !joined.includes(LOCK_KEY)) {
    throw new Error(`forbidden destructive deploy: ${joined}`);
  }
  if (joined.includes('s3 sync')) {
    throw new Error(`forbidden destructive deploy: ${joined}`);
  }
  if (/s3api put-object/.test(joined)) {
    const allowed = joined.includes(FILES_KEY) || joined.includes(LOCK_KEY);
    if (!allowed) throw new Error(`forbidden put-object outside ${FILES_KEY}: ${joined}`);
    for (const key of FORBIDDEN_KEYS) {
      if (joined.includes(key)) throw new Error(`forbidden write ${key}`);
    }
  }
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  return out.trim() ? JSON.parse(out) : {};
};

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const assumeCursor = async (session) => {
  const creds = JSON.parse(execFileSync(AWS, [
    'sts', 'assume-role-with-web-identity',
    '--role-arn', process.env.CURSOR_AWS_ASSUME_IAM_ROLE_ARN,
    '--role-session-name', session,
    '--web-identity-token', String(await oidcToken()),
    '--duration-seconds', '3600',
    '--output', 'json',
  ], { encoding: 'utf8' })).Credentials;
  applyCreds(creds);
};

const assumeSpa = async (session = 'sig-dyof-nvxk-files') => {
  const creds = JSON.parse(execFileSync(AWS, [
    'sts', 'assume-role-with-web-identity',
    '--role-arn', SPA_DEPLOY_ROLE,
    '--role-session-name', session,
    '--web-identity-token', String(await oidcToken()),
    '--duration-seconds', '3600',
    '--output', 'json',
  ], { encoding: 'utf8' })).Credentials;
  applyCreds(creds);
};

const getObject = (key, dest) => {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  execFileSync(AWS, ['--region', REGION, 's3api', 'get-object', '--bucket', BUCKET, '--key', key, dest], {
    encoding: 'utf8',
  });
  return dest;
};

const readLiveGraph = (suffix) => {
  const html = fs.readFileSync(getObject('index.html', path.join(WORK, `index${suffix}.html`)), 'utf8');
  const entry = fs.readFileSync(getObject(`assets/${LIVE_ENTRY}`, path.join(WORK, `entry${suffix}.js`)), 'utf8');
  const ccc = fs.readFileSync(getObject(`assets/${LIVE_CCC}`, path.join(WORK, `ccc${suffix}.js`)), 'utf8');
  const files = fs.readFileSync(getObject(FILES_KEY, path.join(WORK, `files${suffix}.js`)), 'utf8');
  const sign = fs.readFileSync(getObject(SIGN_KEY, path.join(WORK, `sign${suffix}.js`)), 'utf8');
  const dtp = fs.readFileSync(getObject(DTP_KEY, path.join(WORK, `dtp${suffix}.js`)), 'utf8');
  return { html, entry, ccc, files, sign, dtp };
};

const graphPins = (live) => {
  const htmlEntry = (live.html.match(/src="(\/assets\/index-[^"]+\.js)"/) || [])[1] || null;
  return {
    html_sha256: sha256(live.html),
    html_entry: htmlEntry,
    entry_sha256: sha256(live.entry),
    ccc_sha256: sha256(live.ccc),
    files_sha256: sha256(live.files),
    sign_sha256: sha256(live.sign),
    dtp_sha256: sha256(live.dtp),
    entry_imports_ccc: live.entry.includes(LIVE_CCC),
    ccc_imports_files: live.ccc.includes(LIVE_FILES),
    files_imports_dyof: live.files.includes(`from"./${LIVE_ENTRY}"`),
    files_has_signatures_claim: live.files.includes('signatures/${r}/'),
    files_already_check_scoped: live.files.includes('check-intake/${w}/files/'),
  };
};

const pinsEqual = (left, right) => JSON.stringify(left) === JSON.stringify(right);

const stopOnDrift = (pins, lambdaSha, label, extras = {}) => {
  const errors = [];
  if (pins.html_entry !== `/assets/${LIVE_ENTRY}`) errors.push(`html_entry ${pins.html_entry}`);
  if (pins.html_sha256 !== EXPECTED_HTML_SHA256) errors.push(`index.html ${pins.html_sha256}`);
  if (pins.entry_sha256 !== EXPECTED_ENTRY_SHA256) errors.push(`DyoF ${pins.entry_sha256}`);
  if (pins.ccc_sha256 !== EXPECTED_CCC_SHA256) errors.push(`CCC ${pins.ccc_sha256}`);
  if (pins.files_sha256 !== EXPECTED_FILES_SHA256) errors.push(`Files ${pins.files_sha256}`);
  if (!pins.entry_imports_ccc) errors.push('DyoF lost current CCC');
  if (!pins.ccc_imports_files) errors.push('CCC lost nvXk Files');
  if (!pins.files_imports_dyof) errors.push('Files lost DyoF import');
  if (!pins.files_has_signatures_claim) errors.push('Files already lost signatures/${r} sites; refuse blind rewrite');
  if (pins.files_already_check_scoped) errors.push('Files already has check-intake/${w}; refuse double overlay');
  if (errors.length) {
    console.error(JSON.stringify({ stop: 'target_moved', label, errors, pins, lambdaSha, ...extras }, null, 2));
    process.exit(3);
  }
};

const parseOk = (source) => {
  acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
};

const acquireLock = (owner) => {
  const body = `${JSON.stringify({
    owner,
    target: FILES_KEY,
    host: os.hostname(),
    created_at: new Date().toISOString(),
  }, null, 2)}\n`;
  const lockPath = path.join(WORK, 'release-write.lock');
  fs.writeFileSync(lockPath, body);
  try {
    execFileSync(AWS, [
      '--region', REGION, '--output', 'json',
      's3api', 'put-object',
      '--bucket', BUCKET,
      '--key', LOCK_KEY,
      '--body', lockPath,
      '--content-type', 'application/json',
      '--if-none-match', '*',
    ], { encoding: 'utf8' });
    return { ok: true, key: LOCK_KEY, owner };
  } catch (error) {
    const text = String(error.stderr || error.message || error);
    console.error(JSON.stringify({
      stop: 'lock_held_or_unavailable',
      lock: LOCK_KEY,
      error: text.slice(0, 600),
    }, null, 2));
    process.exit(5);
  }
};

const releaseLock = () => {
  try {
    execFileSync(AWS, [
      '--region', REGION, '--output', 'json',
      's3api', 'delete-object',
      '--bucket', BUCKET,
      '--key', LOCK_KEY,
    ], { encoding: 'utf8' });
  } catch (error) {
    console.error(`lock release failed: ${String(error.stderr || error.message || error).slice(0, 400)}`);
  }
};

const main = async () => {
  fs.mkdirSync(WORK, { recursive: true });
  await assumeCursor('sig-dyof-nvxk-preflight-lambda');
  const lambdaBefore = awsJson(['lambda', 'get-function-configuration', '--function-name', LAMBDA]);

  await assumeSpa('sig-dyof-nvxk-preflight-spa');
  const liveBefore = readLiveGraph('-before');
  const pinsBefore = graphPins(liveBefore);
  stopOnDrift(pinsBefore, lambdaBefore.CodeSha256, 'before-write');

  if (liveBefore.files.includes('index-C9QrEEkl.js') || liveBefore.files.includes('CheckFilesSection-BJZPqPpX.js')) {
    console.error(JSON.stringify({ stop: 'refused_c9qr_bjz_restore', pins: pinsBefore }, null, 2));
    process.exit(3);
  }

  const patched = patchDyofNvxkFiles(liveBefore.files);
  parseOk(patched);
  const patchedPath = path.join(WORK, 'files-patched.js');
  fs.writeFileSync(patchedPath, patched);
  const patchedSha = sha256(patched);
  const invariants = filesInvariants(patched);
  const failed = Object.entries(invariants).filter(([, ok]) => !ok).map(([key]) => key);
  if (failed.length) {
    console.error(JSON.stringify({ stop: 'candidate_invariants_failed', failed, patchedSha }, null, 2));
    process.exit(4);
  }

  const report = {
    ok: true,
    applied: false,
    deploy_mode: 'per_object_put',
    target: FILES_KEY,
    expected_files_sha256: EXPECTED_FILES_SHA256,
    before_files_sha256: pinsBefore.files_sha256,
    patched_files_sha256: patchedSha,
    lambda_before: lambdaBefore.CodeSha256,
    live_entry: LIVE_ENTRY,
    live_ccc: LIVE_CCC,
    live_files: LIVE_FILES,
    live_sign: LIVE_SIGN,
    live_dtp: LIVE_DTP,
    pins_before: pinsBefore,
    restore_accepted_bytes: false,
    ...invariants,
  };

  if (!APPLY) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const lock = acquireLock(`sig-dyof-nvxk:${randomUUID()}`);
  report.lock = lock;
  try {
    await assumeCursor('sig-dyof-nvxk-toctou-lambda');
    const lambdaAgain = awsJson(['lambda', 'get-function-configuration', '--function-name', LAMBDA]);
    await assumeSpa('sig-dyof-nvxk-toctou-spa');
    const liveAgain = readLiveGraph('-toctou');
    const pinsAgain = graphPins(liveAgain);
    stopOnDrift(pinsAgain, lambdaAgain.CodeSha256, 'toctou-before-write');
    if (!pinsEqual(pinsBefore, pinsAgain) || lambdaAgain.CodeSha256 !== lambdaBefore.CodeSha256) {
      console.error(JSON.stringify({
        stop: 'toctou_drift',
        pins_before: pinsBefore,
        pins_again: pinsAgain,
        lambda_before: lambdaBefore.CodeSha256,
        lambda_again: lambdaAgain.CodeSha256,
      }, null, 2));
      process.exit(3);
    }

    const put = awsJson([
      's3api', 'put-object',
      '--bucket', BUCKET,
      '--key', FILES_KEY,
      '--body', patchedPath,
      '--content-type', 'application/javascript; charset=utf-8',
      '--cache-control', 'public, max-age=31536000, immutable',
    ]);

    let invalidation = {};
    try {
      invalidation = awsJson([
        'cloudfront', 'create-invalidation',
        '--distribution-id', DISTRIBUTION,
        '--paths', `/${FILES_KEY}`,
      ]);
    } catch (error) {
      invalidation = { error: String(error.stderr || error.message || error).slice(0, 400) };
    }

    await assumeCursor('sig-dyof-nvxk-after-lambda');
    const lambdaAfter = awsJson(['lambda', 'get-function-configuration', '--function-name', LAMBDA]);
    await assumeSpa('sig-dyof-nvxk-after-spa');
    const after = readLiveGraph('-after');
    const pinsAfter = graphPins(after);
    parseOk(after.files);
    const afterInvariants = filesInvariants(after.files);

    const htmlUnchanged = pinsAfter.html_sha256 === pinsBefore.html_sha256
      && pinsAfter.html_entry === `/assets/${LIVE_ENTRY}`;
    const entryUnchanged = pinsAfter.entry_sha256 === pinsBefore.entry_sha256;
    const cccUnchanged = pinsAfter.ccc_sha256 === pinsBefore.ccc_sha256;
    const signUnchanged = pinsAfter.sign_sha256 === pinsBefore.sign_sha256;
    const dtpUnchanged = pinsAfter.dtp_sha256 === pinsBefore.dtp_sha256;
    const lambdaUnchanged = lambdaAfter.CodeSha256 === lambdaBefore.CodeSha256;
    const stillMountsNvxk = pinsAfter.ccc_imports_files && pinsAfter.html_entry === `/assets/${LIVE_ENTRY}`;

    Object.assign(report, afterInvariants);
    report.applied = true;
    report.files_version = put.VersionId || null;
    report.after_files_sha256 = pinsAfter.files_sha256;
    report.after_matches_patched = pinsAfter.files_sha256 === patchedSha;
    report.lambda_after = lambdaAfter.CodeSha256;
    report.invalidation_id = invalidation.Invalidation?.Id || null;
    report.invalidation_error = invalidation.error || null;
    report.untouched = {
      index_html: htmlUnchanged,
      dyof: entryUnchanged,
      ccc: cccUnchanged,
      sign: signUnchanged,
      dtp: dtpUnchanged,
      lambda: lambdaUnchanged,
    };
    report.still_mounts_nvxk = stillMountsNvxk;
    report.no_concurrent_drift = htmlUnchanged && entryUnchanged && cccUnchanged
      && signUnchanged && dtpUnchanged && lambdaUnchanged;
    report.ok = report.after_matches_patched
      && afterInvariants.has_wizard
      && afterInvariants.check_scoped_generate
      && afterInvariants.check_scoped_direct
      && afterInvariants.files_tab_unchanged
      && afterInvariants.missing_check_refusals
      && afterInvariants.no_signatures_claim
      && afterInvariants.no_generic_request_insert
      && afterInvariants.no_generic_signer_insert
      && afterInvariants.class_a_create
      && afterInvariants.class_a_return
      && afterInvariants.no_c9qr_restore
      && afterInvariants.no_bjz_restore
      && stillMountsNvxk
      && report.no_concurrent_drift;
  } finally {
    await assumeSpa('sig-dyof-nvxk-unlock').catch(() => {});
    releaseLock();
  }

  fs.mkdirSync('/opt/cursor/artifacts', { recursive: true });
  fs.writeFileSync('/opt/cursor/artifacts/sig-dyof-nvxk-files-promote.json', `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(4);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
