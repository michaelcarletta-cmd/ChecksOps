#!/usr/bin/env node
/**
 * Narrow production write: same-URL assets/Sign-DfWZrlqT.js only.
 * Overlay mobile document-preview sizing. Does not write index.html,
 * C9Qr, Files, CCC, DTP, or Lambda.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {
  EXPECTED_ENTRY_SHA256,
  EXPECTED_FILES_SHA256,
  EXPECTED_HTML_SHA256,
  EXPECTED_LAMBDA_SHA,
  EXPECTED_SIGN_SHA256,
  FILES_KEY,
  LIVE_ENTRY,
  LIVE_FILES,
  LIVE_SIGN,
  SIGN_KEY,
  patchSignMobilePreview,
  signPreviewInvariants,
} from './lib/sig-mobile-sign-preview-patch.mjs';

const require = createRequire(import.meta.url);
const acorn = require('acorn');

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const BUCKET = 'checksops-production-frontend-806168576068';
const DISTRIBUTION = 'E1B0ZWWO5559U5';
const LAMBDA = 'checksops-production-prep-api';
const SPA_DEPLOY_ROLE = 'arn:aws:iam::806168576068:role/ChecksOpsProductionSpaDeploy';
const WORK = '/tmp/sig-mobile-sign-preview';
const APPLY = process.argv.includes('--apply');
const FORBIDDEN_KEYS = [
  'index.html',
  `assets/${LIVE_ENTRY}`,
  FILES_KEY,
  'assets/CheckCommandCenter-CO3eXFPG.js',
  'assets/SharedCheckPaymentDirection-CxyHZONq.js',
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
    if (!joined.includes(SIGN_KEY)) {
      throw new Error(`forbidden put-object outside ${SIGN_KEY}: ${joined}`);
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
    '--role-session-name', 'sig-mobile-sign-preview',
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
  const sign = fs.readFileSync(getObject(SIGN_KEY, path.join(WORK, `sign${suffix}.js`)), 'utf8');
  const files = fs.readFileSync(getObject(FILES_KEY, path.join(WORK, `files${suffix}.js`)), 'utf8');
  return { html, entry, sign, files };
};

const graphPins = (live) => {
  const htmlEntry = (live.html.match(/src="(\/assets\/index-[^"]+\.js)"/) || [])[1] || null;
  return {
    html_sha256: sha256(live.html),
    html_entry: htmlEntry,
    entry_sha256: sha256(live.entry),
    sign_sha256: sha256(live.sign),
    files_sha256: sha256(live.files),
    entry_imports_sign: live.entry.includes(LIVE_SIGN),
    sign_imports_c9qr: live.sign.includes(`from"./${LIVE_ENTRY}"`),
  };
};

const stopOnDrift = (pins, lambdaSha, label) => {
  const errors = [];
  if (pins.html_entry !== `/assets/${LIVE_ENTRY}`) errors.push(`html_entry ${pins.html_entry}`);
  if (pins.html_sha256 !== EXPECTED_HTML_SHA256) errors.push(`index.html ${pins.html_sha256}`);
  if (pins.entry_sha256 !== EXPECTED_ENTRY_SHA256) errors.push(`C9Qr ${pins.entry_sha256}`);
  if (pins.sign_sha256 !== EXPECTED_SIGN_SHA256) errors.push(`Sign ${pins.sign_sha256}`);
  if (pins.files_sha256 !== EXPECTED_FILES_SHA256) errors.push(`Files ${pins.files_sha256}`);
  if (!pins.entry_imports_sign) errors.push('C9Qr lost Sign-DfWZrlqT.js');
  if (!pins.sign_imports_c9qr) errors.push('Sign lost C9Qr import');
  if (lambdaSha !== EXPECTED_LAMBDA_SHA) errors.push(`lambda ${lambdaSha}`);
  if (errors.length) {
    console.error(JSON.stringify({ stop: 'target_moved', label, errors, pins, lambdaSha }, null, 2));
    process.exit(3);
  }
};

const parseOk = (source) => {
  acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
};

const main = async () => {
  fs.mkdirSync(WORK, { recursive: true });
  await assumeCursor('sig-mobile-sign-preflight-lambda');
  const lambdaBefore = awsJson(['lambda', 'get-function-configuration', '--function-name', LAMBDA]);

  await assumeSpa();
  const liveBefore = readLiveGraph('-before');
  const pinsBefore = graphPins(liveBefore);
  stopOnDrift(pinsBefore, lambdaBefore.CodeSha256, 'before-write');

  const patched = patchSignMobilePreview(liveBefore.sign);
  parseOk(patched);
  const patchedPath = path.join(WORK, 'sign-patched.js');
  fs.writeFileSync(patchedPath, patched);
  const patchedSha = sha256(patched);

  const report = {
    ok: true,
    applied: false,
    deploy_mode: 'per_object_put',
    target: SIGN_KEY,
    expected_sign_sha256: EXPECTED_SIGN_SHA256,
    before_sign_sha256: pinsBefore.sign_sha256,
    patched_sign_sha256: patchedSha,
    lambda_before: lambdaBefore.CodeSha256,
    live_sign: LIVE_SIGN,
    live_entry: LIVE_ENTRY,
    live_files: LIVE_FILES,
    pins_before: pinsBefore,
    ...signPreviewInvariants(patched),
  };

  if (!APPLY) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  await assumeCursor('sig-mobile-sign-toctou-lambda');
  const lambdaAgain = awsJson(['lambda', 'get-function-configuration', '--function-name', LAMBDA]);
  await assumeSpa();
  const liveAgain = readLiveGraph('-toctou');
  const pinsAgain = graphPins(liveAgain);
  stopOnDrift(pinsAgain, lambdaAgain.CodeSha256, 'toctou-before-write');

  const put = awsJson([
    's3api', 'put-object',
    '--bucket', BUCKET,
    '--key', SIGN_KEY,
    '--body', patchedPath,
    '--content-type', 'application/javascript; charset=utf-8',
    '--cache-control', 'public, max-age=31536000, immutable',
  ]);

  let invalidation = {};
  try {
    invalidation = awsJson([
      'cloudfront', 'create-invalidation',
      '--distribution-id', DISTRIBUTION,
      '--paths', `/${SIGN_KEY}`,
    ]);
  } catch (error) {
    invalidation = { error: String(error.stderr || error.message || error).slice(0, 400) };
  }

  await assumeCursor('sig-mobile-sign-after-lambda');
  const lambdaAfter = awsJson(['lambda', 'get-function-configuration', '--function-name', LAMBDA]);
  await assumeSpa();
  const after = readLiveGraph('-after');
  const pinsAfter = graphPins(after);
  parseOk(after.sign);
  const afterInvariants = signPreviewInvariants(after.sign);

  const htmlUnchanged = pinsAfter.html_sha256 === EXPECTED_HTML_SHA256
    && pinsAfter.html_entry === `/assets/${LIVE_ENTRY}`;
  const entryUnchanged = pinsAfter.entry_sha256 === EXPECTED_ENTRY_SHA256;
  const filesUnchanged = pinsAfter.files_sha256 === EXPECTED_FILES_SHA256;
  const lambdaUnchanged = lambdaAfter.CodeSha256 === EXPECTED_LAMBDA_SHA;
  const stillMountsSign = pinsAfter.entry_imports_sign && pinsAfter.html_entry === `/assets/${LIVE_ENTRY}`;

  Object.assign(report, afterInvariants);
  report.applied = true;
  report.sign_version = put.VersionId || null;
  report.after_sign_sha256 = pinsAfter.sign_sha256;
  report.after_matches_patched = pinsAfter.sign_sha256 === patchedSha;
  report.lambda_after = lambdaAfter.CodeSha256;
  report.invalidation_id = invalidation.Invalidation?.Id || null;
  report.invalidation_error = invalidation.error || null;
  report.untouched = {
    index_html: htmlUnchanged,
    c9qr: entryUnchanged,
    files: filesUnchanged,
    lambda: lambdaUnchanged,
  };
  report.still_mounts_sign = stillMountsSign;
  report.no_concurrent_drift = htmlUnchanged && entryUnchanged && filesUnchanged && lambdaUnchanged;
  report.ok = report.after_matches_patched
    && afterInvariants.imports_c9qr
    && afterInvariants.submit_signature
    && afterInvariants.to_data_url
    && afterInvariants.canvas_400_150
    && afterInvariants.no_react_pdf
    && afterInvariants.helper
    && afterInvariants.mobile_derived_height
    && afterInvariants.desktop_70vh_400
    && afterInvariants.no_live_iframe_style
    && afterInvariants.patched_iframe_style
    && stillMountsSign
    && report.no_concurrent_drift;

  fs.mkdirSync('/opt/cursor/artifacts', { recursive: true });
  fs.writeFileSync('/opt/cursor/artifacts/sig-mobile-sign-preview-promote.json', `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(4);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
