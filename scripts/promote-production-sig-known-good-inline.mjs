#!/usr/bin/env node
/**
 * Narrow production write: same-URL CheckFilesSection-0Fmhwbep.js only.
 * Inlines the 2026-09-28T14:16 Signature implementation onto the current
 * DJN/CCC/Files host graph. Leaves SignatureRequests-ipdlcpz2.js in place.
 * Does not write index.html, index-*.js, CCC, DTP, CSS, or Lambda.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {
  CANONICAL_ENTRY,
  LIVE_CCC,
  LIVE_DTP,
  LIVE_FILES,
  LEFT_IN_PLACE_ENTRY,
  PINNED_CURRENT_LIVE,
} from './lib/live-sig-baseline.mjs';
import {
  assertUntouchedHostGraph,
  transplantKnownGoodSignature,
} from './lib/sig-known-good-inline.mjs';

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const BUCKET = 'checksops-production-frontend-806168576068';
const DISTRIBUTION = 'E1B0ZWWO5559U5';
const LAMBDA = 'checksops-production-prep-api';
const SPA_DEPLOY_ROLE = 'arn:aws:iam::806168576068:role/ChecksOpsProductionSpaDeploy';
const LIVE_DIR = '/tmp/prod-sig-known-good-inline/live';
const DIST = process.env.CHECKSOPS_SPA_OUTDIR || '/tmp/prod-sig-known-good-inline/dist';
const KNOWN_GOOD = process.env.CHECKSOPS_KNOWN_GOOD_FILE
  || '/tmp/sig-hist/CheckFilesSection-CHseToMm.js';
const FILES_KEY = 'assets/CheckFilesSection-0Fmhwbep.js';

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
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  return out.trim() ? JSON.parse(out) : {};
};

const sha256File = (filePath) => createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

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
  try {
    const creds = JSON.parse(execFileSync(AWS, [
      'sts', 'assume-role-with-web-identity',
      '--role-arn', SPA_DEPLOY_ROLE,
      '--role-session-name', 'sig-known-good-inline',
      '--web-identity-token', String(await oidcToken()),
      '--duration-seconds', '3600',
      '--output', 'json',
    ], { encoding: 'utf8' })).Credentials;
    applyCreds(creds);
    return { ok: true, method: 'oidc' };
  } catch (oidcError) {
    await assumeCursor('sig-known-good-inline-bridge');
    try {
      const creds = JSON.parse(execFileSync(AWS, [
        'sts', 'assume-role',
        '--role-arn', SPA_DEPLOY_ROLE,
        '--role-session-name', 'sig-known-good-inline',
        '--duration-seconds', '3600',
        '--output', 'json',
      ], { encoding: 'utf8' })).Credentials;
      applyCreds(creds);
      return { ok: true, method: 'role-chain' };
    } catch (chainError) {
      return {
        ok: false,
        oidc: String(oidcError.stderr || oidcError.message || oidcError).slice(0, 400),
        chain: String(chainError.stderr || chainError.message || chainError).slice(0, 400),
      };
    }
  }
};

const getObject = (key, dest) => {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  execFileSync(AWS, ['--region', REGION, 's3api', 'get-object', '--bucket', BUCKET, '--key', key, dest], {
    encoding: 'utf8',
  });
  return dest;
};

const readLive = () => {
  fs.mkdirSync(LIVE_DIR, { recursive: true });
  const html = fs.readFileSync(getObject('index.html', path.join(LIVE_DIR, 'index.html')), 'utf8');
  const htmlHead = awsJson(['s3api', 'head-object', '--bucket', BUCKET, '--key', 'index.html']);
  const entry = fs.readFileSync(getObject('assets/index-DJNHggvS.js', path.join(LIVE_DIR, 'index-DJNHggvS.js')), 'utf8');
  const ccc = fs.readFileSync(getObject('assets/CheckCommandCenter-M7p55m49.js', path.join(LIVE_DIR, 'CheckCommandCenter-M7p55m49.js')), 'utf8');
  const files = fs.readFileSync(getObject(FILES_KEY, path.join(LIVE_DIR, 'CheckFilesSection-0Fmhwbep.js')), 'utf8');
  const dtp = fs.readFileSync(getObject('assets/SharedCheckPaymentDirection-CxW2noA2.js', path.join(LIVE_DIR, 'SharedCheckPaymentDirection-CxW2noA2.js')), 'utf8');
  return {
    html,
    entry,
    ccc,
    files,
    dtp,
    index_version: htmlHead.VersionId || null,
    html_sha256: sha256File(path.join(LIVE_DIR, 'index.html')),
    entry_sha256: sha256File(path.join(LIVE_DIR, 'index-DJNHggvS.js')),
    ccc_sha256: sha256File(path.join(LIVE_DIR, 'CheckCommandCenter-M7p55m49.js')),
    files_sha256: sha256File(path.join(LIVE_DIR, 'CheckFilesSection-0Fmhwbep.js')),
    dtp_sha256: sha256File(path.join(LIVE_DIR, 'SharedCheckPaymentDirection-CxW2noA2.js')),
  };
};

const stopOnDrift = (live, label) => {
  try {
    assertUntouchedHostGraph({
      indexHtml: live.html,
      entryJs: live.entry,
      cccJs: live.ccc,
      dtpJs: live.dtp,
    });
  } catch (error) {
    console.error(JSON.stringify({ stop: 'host_drift', label, error: String(error) }, null, 2));
    process.exit(3);
  }
  if (live.files_sha256 !== PINNED_CURRENT_LIVE.files_sha256) {
    console.error(JSON.stringify({
      stop: 'files_drift',
      label,
      expected: PINNED_CURRENT_LIVE.files_sha256,
      actual: live.files_sha256,
    }, null, 2));
    process.exit(3);
  }
  if (live.index_version && live.index_version !== PINNED_CURRENT_LIVE.index_version) {
    console.error(JSON.stringify({
      stop: 'index_version_drift',
      label,
      expected: PINNED_CURRENT_LIVE.index_version,
      actual: live.index_version,
    }, null, 2));
    process.exit(3);
  }
};

const main = async () => {
  if (!fs.existsSync(KNOWN_GOOD)) {
    throw new Error(`known-good CHseToMm missing: ${KNOWN_GOOD}`);
  }
  await assumeCursor('sig-known-good-inline-preflight');
  const lambdaBefore = awsJson(['lambda', 'get-function-configuration', '--function-name', LAMBDA]);

  const assumed = await assumeSpa();
  if (!assumed.ok) {
    console.error(JSON.stringify({ stop: 'spa_role', assumed }, null, 2));
    process.exit(3);
  }

  const liveBefore = readLive();
  stopOnDrift(liveBefore, 'before-build');

  const result = transplantKnownGoodSignature({
    liveFilesJs: liveBefore.files,
    knownGoodChseJs: fs.readFileSync(KNOWN_GOOD, 'utf8'),
  });
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIST, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(DIST, FILES_KEY), result.writes[FILES_KEY]);

  const liveAgain = readLive();
  stopOnDrift(liveAgain, 'toctou-before-write');

  const put = awsJson([
    's3api', 'put-object',
    '--bucket', BUCKET,
    '--key', FILES_KEY,
    '--body', path.join(DIST, FILES_KEY),
    '--content-type', 'application/javascript; charset=utf-8',
    '--cache-control', 'public, max-age=31536000, immutable',
  ]);

  const invalidation = awsJson([
    'cloudfront', 'create-invalidation',
    '--distribution-id', DISTRIBUTION,
    '--paths', '/assets/CheckFilesSection-0Fmhwbep.js',
  ]);

  await assumeCursor('sig-known-good-inline-after');
  const lambdaAfter = awsJson(['lambda', 'get-function-configuration', '--function-name', LAMBDA]);
  const afterFiles = fs.readFileSync(getObject(FILES_KEY, path.join(LIVE_DIR, 'CheckFilesSection-0Fmhwbep-after.js')), 'utf8');
  const afterHtml = sha256File(getObject('index.html', path.join(LIVE_DIR, 'index-after.html')));
  const afterEntry = sha256File(getObject('assets/index-DJNHggvS.js', path.join(LIVE_DIR, 'index-DJNHggvS-after.js')));
  const afterCcc = sha256File(getObject('assets/CheckCommandCenter-M7p55m49.js', path.join(LIVE_DIR, 'ccc-after.js')));
  const afterDtp = sha256File(getObject('assets/SharedCheckPaymentDirection-CxW2noA2.js', path.join(LIVE_DIR, 'dtp-after.js')));
  const afterCss = awsJson(['s3api', 'head-object', '--bucket', BUCKET, '--key', 'assets/index-D9SwIqYu.css']);
  const afterSig = awsJson(['s3api', 'head-object', '--bucket', BUCKET, '--key', 'assets/SignatureRequests-ipdlcpz2.js']);
  const afterQket = awsJson(['s3api', 'head-object', '--bucket', BUCKET, '--key', 'assets/index-QKetcACR.js']);

  const report = {
    ok: sha256File(path.join(LIVE_DIR, 'CheckFilesSection-0Fmhwbep-after.js')) === result.report.files_sha256
      && afterHtml === PINNED_CURRENT_LIVE.index_html_sha256
      && afterEntry === PINNED_CURRENT_LIVE.djnh_sha256
      && afterCcc === PINNED_CURRENT_LIVE.ccc_sha256
      && afterDtp === PINNED_CURRENT_LIVE.dtp_sha256
      && afterFiles.includes('Send for Signature')
      && afterFiles.includes('function Ss(')
      && !afterFiles.includes('SignatureRequests-ipdlcpz2')
      && !afterFiles.includes('ReactCurrentBatchConfig')
      && afterFiles.includes('return s??[]}}),{data:checkClaim}=T(')
      && lambdaAfter.CodeSha256 === lambdaBefore.CodeSha256
      && Boolean(afterSig.ETag)
      && Boolean(afterQket.ETag),
    deploy_mode: 'known_good_signature_inline_files_only',
    uploaded: [FILES_KEY],
    files_version: put.VersionId || null,
    live_before: {
      html_sha256: liveBefore.html_sha256,
      entry_sha256: liveBefore.entry_sha256,
      ccc_sha256: liveBefore.ccc_sha256,
      files_sha256: liveBefore.files_sha256,
      dtp_sha256: liveBefore.dtp_sha256,
      index_version: liveBefore.index_version,
    },
    live_after: {
      html_sha256: afterHtml,
      entry_sha256: afterEntry,
      ccc_sha256: afterCcc,
      files_sha256: sha256File(path.join(LIVE_DIR, 'CheckFilesSection-0Fmhwbep-after.js')),
      dtp_sha256: afterDtp,
      css_etag: afterCss.ETag || null,
      ipdlcpz2_left_in_place: Boolean(afterSig.ETag),
      qketcacr_left_in_place: Boolean(afterQket.ETag),
    },
    candidate: result.report,
    invalidation_id: invalidation.Invalidation?.Id || null,
    invalidation_status: invalidation.Invalidation?.Status || null,
    lambda_before: lambdaBefore.CodeSha256,
    lambda_after: lambdaAfter.CodeSha256,
    lambda_unchanged: lambdaAfter.CodeSha256 === lambdaBefore.CodeSha256,
    host_untouched: true,
    assume: assumed,
    canonical_entry: CANONICAL_ENTRY,
    live_ccc: LIVE_CCC,
    live_files: LIVE_FILES,
    live_dtp: LIVE_DTP,
    left_in_place_entry: LEFT_IN_PLACE_ENTRY,
  };
  fs.mkdirSync('/opt/cursor/artifacts', { recursive: true });
  fs.writeFileSync('/opt/cursor/artifacts/prod-sig-known-good-inline-upload.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(4);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
