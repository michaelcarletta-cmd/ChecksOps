#!/usr/bin/env node
/**
 * Narrow production write: same-URL CheckFilesSection-BJZPqPpX.js only.
 * Retargets the current C9Qr Files Signature wizard onto check-scoped upload
 * and Class A send-signature-request create.
 * Does not write index.html, C9Qr, CCC, DTP, retired DJN/CXdg Files, or Lambda.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {
  EXPECTED_CCC_SHA256,
  EXPECTED_DTP_SHA256,
  EXPECTED_ENTRY_SHA256,
  EXPECTED_ESIGN_SHA256,
  EXPECTED_FILES_SHA256,
  EXPECTED_HTML_SHA256,
  EXPECTED_LAMBDA_SHA,
  FILES_KEY,
  LIVE_CCC,
  LIVE_DTP,
  LIVE_ENTRY,
  LIVE_FILES,
  filesInvariants,
  patchC9qrBjzFiles,
} from './lib/sig-c9qr-bjz-files-patch.mjs';

const require = createRequire(import.meta.url);
const acorn = require('acorn');

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const BUCKET = 'checksops-production-frontend-806168576068';
const DISTRIBUTION = 'E1B0ZWWO5559U5';
const LAMBDA = 'checksops-production-prep-api';
const SPA_DEPLOY_ROLE = 'arn:aws:iam::806168576068:role/ChecksOpsProductionSpaDeploy';
const WORK = '/tmp/sig-c9qr-bjz-files';
const APPLY = process.argv.includes('--apply');
const FORBIDDEN_KEYS = [
  'index.html',
  `assets/${LIVE_ENTRY}`,
  `assets/${LIVE_CCC}`,
  `assets/${LIVE_DTP}`,
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
  if (joined.includes('--delete') || joined.includes('s3 sync')) {
    throw new Error(`forbidden destructive deploy: ${joined}`);
  }
  if (/s3api put-object/.test(joined)) {
    if (!joined.includes(FILES_KEY)) {
      throw new Error(`forbidden put-object outside ${FILES_KEY}: ${joined}`);
    }
    for (const key of FORBIDDEN_KEYS) {
      if (joined.includes(key)) {
        throw new Error(`forbidden write ${key}`);
      }
    }
  }
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  return out.trim() ? JSON.parse(out) : {};
};

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const sha256File = (filePath) => sha256(fs.readFileSync(filePath));

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

const assumeSpa = async () => {
  const creds = JSON.parse(execFileSync(AWS, [
    'sts', 'assume-role-with-web-identity',
    '--role-arn', SPA_DEPLOY_ROLE,
    '--role-session-name', 'sig-c9qr-bjz-files',
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
  const dtp = fs.readFileSync(getObject(`assets/${LIVE_DTP}`, path.join(WORK, `dtp${suffix}.js`)), 'utf8');
  return { html, entry, ccc, files, dtp };
};

const graphPins = (live) => {
  const htmlEntry = (live.html.match(/src="(\/assets\/index-[^"]+\.js)"/) || [])[1] || null;
  return {
    html_sha256: sha256(live.html),
    html_entry: htmlEntry,
    entry_sha256: sha256(live.entry),
    ccc_sha256: sha256(live.ccc),
    files_sha256: sha256(live.files),
    dtp_sha256: sha256(live.dtp),
    entry_imports_ccc: live.entry.includes(LIVE_CCC),
    ccc_imports_files: live.ccc.includes(LIVE_FILES),
    files_imports_c9qr: live.files.includes(`from"./${LIVE_ENTRY}"`),
  };
};

const esignAcceptedFixes = (src) => ({
  optionalUuid: src.includes('optionalUuid(field.id)'),
  createBranch: src.includes('createSignatureRequestRows'),
  noAccessTokenNull: !src.includes('access_token = NULL'),
  tokenMint: src.includes('SET access_token = $2, token_hash = $3'),
  stamp: /stamp|final.?pdf|signed.?pdf/i.test(src),
});

const stopOnDrift = (pins, lambdaSha, esignSha, esignFixes, label) => {
  const errors = [];
  if (pins.html_entry !== `/assets/${LIVE_ENTRY}`) errors.push(`html_entry ${pins.html_entry}`);
  if (pins.html_sha256 !== EXPECTED_HTML_SHA256) errors.push(`index.html ${pins.html_sha256}`);
  if (pins.entry_sha256 !== EXPECTED_ENTRY_SHA256) errors.push(`C9Qr ${pins.entry_sha256}`);
  if (pins.ccc_sha256 !== EXPECTED_CCC_SHA256) errors.push(`CCC ${pins.ccc_sha256}`);
  if (pins.files_sha256 !== EXPECTED_FILES_SHA256) errors.push(`Files ${pins.files_sha256}`);
  if (pins.dtp_sha256 !== EXPECTED_DTP_SHA256) errors.push(`DTP ${pins.dtp_sha256}`);
  if (!pins.entry_imports_ccc) errors.push('C9Qr lost CCC');
  if (!pins.ccc_imports_files) errors.push('CCC lost BJZ Files');
  if (!pins.files_imports_c9qr) errors.push('Files lost C9Qr import');
  if (lambdaSha !== EXPECTED_LAMBDA_SHA) errors.push(`lambda ${lambdaSha}`);
  if (esignSha !== EXPECTED_ESIGN_SHA256) errors.push(`esign ${esignSha}`);
  const esignFailed = Object.entries(esignFixes).filter(([, ok]) => !ok).map(([key]) => key);
  if (esignFailed.length) errors.push(`esign_fixes ${esignFailed.join(',')}`);
  if (errors.length) {
    console.error(JSON.stringify({ stop: 'target_moved', label, errors, pins, lambdaSha, esignSha }, null, 2));
    process.exit(3);
  }
};

const readLiveEsign = async () => {
  const liveFn = awsJson(['lambda', 'get-function', '--function-name', LAMBDA]);
  const liveZip = path.join(WORK, 'lambda-live.zip');
  execFileSync('curl', ['-fsSL', liveFn.Code.Location, '-o', liveZip]);
  const unpack = path.join(WORK, 'lambda-live');
  fs.rmSync(unpack, { recursive: true, force: true });
  fs.mkdirSync(unpack, { recursive: true });
  execFileSync('unzip', ['-o', '-q', liveZip, '-d', unpack]);
  const candidates = [
    path.join(unpack, 'esign.mjs'),
    path.join(unpack, 'functions/api/esign.mjs'),
    path.join(unpack, 'api/esign.mjs'),
  ];
  const target = candidates.find((file) => fs.existsSync(file));
  if (!target) throw new Error('live Lambda zip has no esign.mjs');
  const src = fs.readFileSync(target, 'utf8');
  return { sha256: sha256(src), fixes: esignAcceptedFixes(src), path: path.relative(unpack, target) };
};

const parseOk = (source) => {
  acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
};

const main = async () => {
  fs.mkdirSync(WORK, { recursive: true });
  await assumeCursor('sig-c9qr-bjz-preflight-lambda');
  const lambdaBefore = awsJson(['lambda', 'get-function-configuration', '--function-name', LAMBDA]);
  const esignBefore = await readLiveEsign();

  await assumeSpa();
  const liveBefore = readLiveGraph('-before');
  const pinsBefore = graphPins(liveBefore);
  stopOnDrift(pinsBefore, lambdaBefore.CodeSha256, esignBefore.sha256, esignBefore.fixes, 'before-write');

  const patched = patchC9qrBjzFiles(liveBefore.files);
  parseOk(patched);
  const patchedPath = path.join(WORK, 'files-patched.js');
  fs.writeFileSync(patchedPath, patched);
  const patchedSha = sha256(patched);

  const report = {
    ok: true,
    applied: false,
    deploy_mode: 'per_object_put',
    target: FILES_KEY,
    expected_files_sha256: EXPECTED_FILES_SHA256,
    before_files_sha256: pinsBefore.files_sha256,
    patched_files_sha256: patchedSha,
    lambda_before: lambdaBefore.CodeSha256,
    esign_before: esignBefore.sha256,
    live_entry: LIVE_ENTRY,
    live_ccc: LIVE_CCC,
    live_files: LIVE_FILES,
    live_dtp: LIVE_DTP,
    pins_before: pinsBefore,
    ...filesInvariants(patched),
  };

  if (!APPLY) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  await assumeCursor('sig-c9qr-bjz-toctou-lambda');
  const lambdaAgain = awsJson(['lambda', 'get-function-configuration', '--function-name', LAMBDA]);
  const esignAgain = await readLiveEsign();
  await assumeSpa();
  const liveAgain = readLiveGraph('-toctou');
  const pinsAgain = graphPins(liveAgain);
  stopOnDrift(pinsAgain, lambdaAgain.CodeSha256, esignAgain.sha256, esignAgain.fixes, 'toctou-before-write');

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

  await assumeCursor('sig-c9qr-bjz-after-lambda');
  const lambdaAfter = awsJson(['lambda', 'get-function-configuration', '--function-name', LAMBDA]);
  const esignAfter = await readLiveEsign();
  await assumeSpa();
  const after = readLiveGraph('-after');
  const pinsAfter = graphPins(after);
  parseOk(after.files);
  const afterInvariants = filesInvariants(after.files);

  const htmlUnchanged = pinsAfter.html_sha256 === EXPECTED_HTML_SHA256
    && pinsAfter.html_entry === `/assets/${LIVE_ENTRY}`;
  const entryUnchanged = pinsAfter.entry_sha256 === EXPECTED_ENTRY_SHA256;
  const cccUnchanged = pinsAfter.ccc_sha256 === EXPECTED_CCC_SHA256;
  const dtpUnchanged = pinsAfter.dtp_sha256 === EXPECTED_DTP_SHA256;
  const lambdaUnchanged = lambdaAfter.CodeSha256 === EXPECTED_LAMBDA_SHA;
  const esignUnchanged = esignAfter.sha256 === EXPECTED_ESIGN_SHA256;
  const stillMountsBjz = pinsAfter.ccc_imports_files && pinsAfter.html_entry === `/assets/${LIVE_ENTRY}`;

  Object.assign(report, afterInvariants);
  report.applied = true;
  report.files_version = put.VersionId || null;
  report.after_files_sha256 = pinsAfter.files_sha256;
  report.after_matches_patched = pinsAfter.files_sha256 === patchedSha;
  report.lambda_after = lambdaAfter.CodeSha256;
  report.esign_after = esignAfter.sha256;
  report.invalidation_id = invalidation.Invalidation?.Id || null;
  report.invalidation_error = invalidation.error || null;
  report.untouched = {
    index_html: htmlUnchanged,
    c9qr: entryUnchanged,
    ccc: cccUnchanged,
    dtp: dtpUnchanged,
    lambda: lambdaUnchanged,
    esign: esignUnchanged,
  };
  report.still_mounts_bjz = stillMountsBjz;
  report.no_concurrent_drift = htmlUnchanged && entryUnchanged && cccUnchanged && dtpUnchanged && lambdaUnchanged && esignUnchanged;
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
    && stillMountsBjz
    && report.no_concurrent_drift;

  fs.mkdirSync('/opt/cursor/artifacts', { recursive: true });
  fs.writeFileSync('/opt/cursor/artifacts/sig-c9qr-bjz-files-promote.json', `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(4);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
