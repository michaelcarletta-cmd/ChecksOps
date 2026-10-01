#!/usr/bin/env node
/**
 * Narrow production write: new Files URL + index.html import-map remap.
 * Copies the already-applied nvXk Signature overlay to a new hashed filename
 * so normal browsers are not stuck on the immutable pre-overlay nvXk URL.
 * Does not restore C9Qr/BJZ. Does not write DyoF, CCC, Sign, DTP, old nvXk, or Lambda.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
  LIVE_CCC,
  LIVE_DTP,
  LIVE_ENTRY,
  LIVE_FILES,
  LIVE_SIGN,
  PATCHED_FILES_SHA256,
  buildNvXkCachebust,
  sha256,
} from './lib/sig-dyof-nvxk-cachebust.mjs';

const require = createRequire(import.meta.url);
const acorn = require('acorn');

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const BUCKET = 'checksops-production-frontend-806168576068';
const DISTRIBUTION = 'E1B0ZWWO5559U5';
const LAMBDA = 'checksops-production-prep-api';
const SPA_DEPLOY_ROLE = 'arn:aws:iam::806168576068:role/ChecksOpsProductionSpaDeploy';
const WORK = '/tmp/sig-dyof-nvxk-cachebust';
const APPLY = process.argv.includes('--apply');
const SIGN_KEY = `assets/${LIVE_SIGN}`;
const DTP_KEY = `assets/${LIVE_DTP}`;
const FILES_KEY = `assets/${LIVE_FILES}`;
const LOCK_KEY = '_checksops/release-write.lock';
const FORBIDDEN_KEYS = [
  `assets/${LIVE_ENTRY}`,
  `assets/${LIVE_CCC}`,
  FILES_KEY,
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

const awsJson = (args, allowedPuts = []) => {
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
    const allowed = [LOCK_KEY, 'index.html', ...allowedPuts].some((key) => joined.includes(key));
    if (!allowed) throw new Error(`forbidden put-object outside cachebust writes: ${joined}`);
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

const assumeSpa = async (session = 'sig-dyof-nvxk-cachebust') => {
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
    has_importmap: live.html.includes('type="importmap"'),
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
  const filesKnown = pins.files_sha256 === PATCHED_FILES_SHA256
    || pins.files_sha256 === EXPECTED_FILES_SHA256;
  if (!filesKnown) errors.push(`Files ${pins.files_sha256}`);
  if (pins.has_importmap) errors.push('index.html already remapped');
  if (!pins.entry_imports_ccc) errors.push('DyoF lost current CCC');
  if (!pins.ccc_imports_files) errors.push('CCC lost nvXk Files');
  if (!pins.files_imports_dyof) errors.push('Files lost DyoF import');
  if (pins.files_sha256 === EXPECTED_FILES_SHA256 && !pins.files_has_signatures_claim) {
    errors.push('pre-overlay Files lost signatures/${r} sites');
  }
  if (pins.files_sha256 === PATCHED_FILES_SHA256 && !pins.files_already_check_scoped) {
    errors.push('live overlay Files lost check-intake/${w}');
  }
  if (errors.length) {
    console.error(JSON.stringify({ stop: 'target_moved', label, errors, pins, lambdaSha, ...extras }, null, 2));
    process.exit(3);
  }
};

const acquireLock = (owner) => {
  const body = `${JSON.stringify({
    owner,
    target: 'index.html+new-files-url',
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

const contentTypeFor = (key) => (
  key === 'index.html'
    ? 'text/html; charset=utf-8'
    : 'application/javascript; charset=utf-8'
);

const cacheControlFor = (key) => (
  key === 'index.html'
    ? 'no-cache, no-store, must-revalidate'
    : 'public, max-age=31536000, immutable'
);

const main = async () => {
  fs.mkdirSync(WORK, { recursive: true });
  await assumeCursor('sig-nvxk-bust-preflight-lambda');
  const lambdaBefore = awsJson(['lambda', 'get-function-configuration', '--function-name', LAMBDA]);

  await assumeSpa('sig-nvxk-bust-preflight-spa');
  const liveBefore = readLiveGraph('-before');
  const pinsBefore = graphPins(liveBefore);
  stopOnDrift(pinsBefore, lambdaBefore.CodeSha256, 'before-write');

  if (liveBefore.files.includes('index-C9QrEEkl.js') || liveBefore.files.includes('CheckFilesSection-BJZPqPpX.js')) {
    console.error(JSON.stringify({ stop: 'refused_c9qr_bjz_restore', pins: pinsBefore }, null, 2));
    process.exit(3);
  }

  const built = buildNvXkCachebust({ html: liveBefore.html, files: liveBefore.files });
  acorn.parse(built.files, { ecmaVersion: 'latest', sourceType: 'module' });
  if (built.files_sha256 !== PATCHED_FILES_SHA256) {
    console.error(JSON.stringify({
      stop: 'candidate_files_sha_mismatch',
      expected: PATCHED_FILES_SHA256,
      actual: built.files_sha256,
    }, null, 2));
    process.exit(4);
  }

  const filesPath = path.join(WORK, built.new_files);
  const htmlPath = path.join(WORK, 'index.html');
  fs.writeFileSync(filesPath, built.files);
  fs.writeFileSync(htmlPath, built.html);

  const report = {
    ok: true,
    applied: false,
    deploy_mode: 'per_object_put',
    writes: Object.keys(built.writes),
    new_files: built.new_files,
    new_files_key: built.new_files_key,
    before_files_sha256: pinsBefore.files_sha256,
    patched_files_sha256: built.files_sha256,
    candidate_html_sha256: built.html_sha256,
    lambda_before: lambdaBefore.CodeSha256,
    live_entry: LIVE_ENTRY,
    live_ccc: LIVE_CCC,
    live_files: LIVE_FILES,
    live_sign: LIVE_SIGN,
    live_dtp: LIVE_DTP,
    pins_before: pinsBefore,
    restore_accepted_bytes: false,
    files_invariants: built.files_invariants,
    html_invariants: built.html_invariants,
  };

  if (!APPLY) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const allowedPuts = [built.new_files_key];
  const lock = acquireLock(`sig-dyof-nvxk-cachebust:${randomUUID()}`);
  report.lock = lock;
  try {
    await assumeCursor('sig-nvxk-bust-toctou-lambda');
    const lambdaAgain = awsJson(['lambda', 'get-function-configuration', '--function-name', LAMBDA], allowedPuts);
    await assumeSpa('sig-nvxk-bust-toctou-spa');
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

    const uploaded = [];
    const putFiles = awsJson([
      's3api', 'put-object',
      '--bucket', BUCKET,
      '--key', built.new_files_key,
      '--body', filesPath,
      '--content-type', contentTypeFor(built.new_files_key),
      '--cache-control', cacheControlFor(built.new_files_key),
    ], allowedPuts);
    uploaded.push(built.new_files_key);

    const putHtml = awsJson([
      's3api', 'put-object',
      '--bucket', BUCKET,
      '--key', 'index.html',
      '--body', htmlPath,
      '--content-type', contentTypeFor('index.html'),
      '--cache-control', cacheControlFor('index.html'),
    ], allowedPuts);
    uploaded.push('index.html');
    if (uploaded.at(-1) !== 'index.html') throw new Error('index.html was not last');

    let invalidation = {};
    try {
      invalidation = awsJson([
        'cloudfront', 'create-invalidation',
        '--distribution-id', DISTRIBUTION,
        '--paths', '/index.html', '/', `/${built.new_files_key}`,
      ], allowedPuts);
    } catch (error) {
      invalidation = { error: String(error.stderr || error.message || error).slice(0, 400) };
    }

    await assumeCursor('sig-nvxk-bust-after-lambda');
    const lambdaAfter = awsJson(['lambda', 'get-function-configuration', '--function-name', LAMBDA], allowedPuts);
    await assumeSpa('sig-nvxk-bust-after-spa');
    const after = readLiveGraph('-after');
    const afterNewFiles = fs.readFileSync(
      getObject(built.new_files_key, path.join(WORK, 'files-new-after.js')),
      'utf8',
    );
    acorn.parse(afterNewFiles, { ecmaVersion: 'latest', sourceType: 'module' });
    const pinsAfter = graphPins(after);
    const afterBuilt = {
      html_sha256: sha256(after.html),
      new_files_sha256: sha256(afterNewFiles),
    };

    const oldFilesUnchanged = pinsAfter.files_sha256 === pinsBefore.files_sha256;
    const entryUnchanged = pinsAfter.entry_sha256 === pinsBefore.entry_sha256;
    const cccUnchanged = pinsAfter.ccc_sha256 === pinsBefore.ccc_sha256;
    const signUnchanged = pinsAfter.sign_sha256 === pinsBefore.sign_sha256;
    const dtpUnchanged = pinsAfter.dtp_sha256 === pinsBefore.dtp_sha256;
    const lambdaUnchanged = lambdaAfter.CodeSha256 === lambdaBefore.CodeSha256;
    const stillMountsDyof = pinsAfter.html_entry === `/assets/${LIVE_ENTRY}`;
    const remapped = after.html.includes(`"/assets/${LIVE_FILES}":"/assets/${built.new_files}"`);

    Object.assign(report, built.files_invariants, built.html_invariants);
    report.applied = true;
    report.uploaded = uploaded;
    report.files_version = putFiles.VersionId || null;
    report.index_version = putHtml.VersionId || null;
    report.after_html_sha256 = afterBuilt.html_sha256;
    report.after_new_files_sha256 = afterBuilt.new_files_sha256;
    report.after_matches_candidate = afterBuilt.html_sha256 === built.html_sha256
      && afterBuilt.new_files_sha256 === built.files_sha256;
    report.lambda_after = lambdaAfter.CodeSha256;
    report.invalidation_id = invalidation.Invalidation?.Id || null;
    report.invalidation_error = invalidation.error || null;
    report.untouched = {
      dyof: entryUnchanged,
      ccc: cccUnchanged,
      old_nvxk: oldFilesUnchanged,
      sign: signUnchanged,
      dtp: dtpUnchanged,
      lambda: lambdaUnchanged,
    };
    report.still_mounts_dyof = stillMountsDyof;
    report.remapped_nvxk = remapped;
    report.no_concurrent_drift = entryUnchanged && cccUnchanged && oldFilesUnchanged
      && signUnchanged && dtpUnchanged && lambdaUnchanged;
    report.ok = report.after_matches_candidate
      && remapped
      && stillMountsDyof
      && built.files_invariants.has_wizard
      && built.files_invariants.check_scoped_generate
      && built.files_invariants.check_scoped_direct
      && built.files_invariants.no_signatures_claim
      && built.files_invariants.class_a_create
      && built.files_invariants.no_c9qr_restore
      && built.files_invariants.no_bjz_restore
      && report.no_concurrent_drift;
  } finally {
    await assumeSpa('sig-nvxk-bust-unlock').catch(() => {});
    releaseLock();
  }

  fs.mkdirSync('/opt/cursor/artifacts', { recursive: true });
  fs.writeFileSync('/opt/cursor/artifacts/sig-dyof-nvxk-cachebust-promote.json', `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(4);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
