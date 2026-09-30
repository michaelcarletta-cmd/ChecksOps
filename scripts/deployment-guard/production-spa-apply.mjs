#!/usr/bin/env node
/**
 * Official #539/#543 production SPA apply.
 *
 * Requires a valid signed receipt for production-spa.
 * Re-reads live index.html + entry bundle immediately before the index switch (TOCTOU).
 * If production moved: STOP PRODUCTION_DRIFT_RECOMPOSITION_REQUIRED.
 * Do not write. Do not regenerate. Do not restore an older baseline.
 * Uploads per-object (no s3 sync --delete). Never targets staging.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { parseArgs, printResult } from './lib/cli.mjs';
import { CODES, fail, ok } from './lib/errors.mjs';
import { evaluateIndexToctou } from './lib/spa-promote.mjs';
import { enforceS3Target, enforceScriptGuard } from './require-guard.mjs';

const AWS = process.env.AWS_CLI || process.env.AWS || 'aws';
const REGION = process.env.AWS_REGION || 'us-east-1';
const PRODUCTION_BUCKET = 'checksops-production-frontend-806168576068';
const PRODUCTION_DISTRIBUTION = 'E1B0ZWWO5559U5';
const STAGING_BUCKET = 'checksops-staging-frontend-c48b';
const FORBIDDEN_CANDIDATE_ENTRIES = [
  'DJNHggvS',
  'BPbQUNFr',
  'B4Tts4y1',
  'Da1p11Te',
  'Bax7aYr9',
];

function awsJson(args, env = process.env) {
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
    encoding: 'utf8',
    env,
    maxBuffer: 16 * 1024 * 1024,
  });
  return out.trim() ? JSON.parse(out) : {};
}

function sha256Text(text) {
  return createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function entryFromHtml(html) {
  const match = String(html || '').match(/\/assets\/index-[^"'\\s]+\.js/);
  return match ? match[0] : null;
}

export function readLiveIndexFingerprint(bucket = PRODUCTION_BUCKET, env = process.env) {
  if (bucket === STAGING_BUCKET) {
    throw new Error('production-spa-apply must never read/write the staging bucket');
  }
  const head = awsJson(['s3api', 'head-object', '--bucket', bucket, '--key', 'index.html'], env);
  const tmp = path.join(os.tmpdir(), `production-index-${process.pid}.html`);
  execFileSync(AWS, [
    '--region', REGION, 's3api', 'get-object',
    '--bucket', bucket, '--key', 'index.html',
    tmp,
  ], { encoding: 'utf8', env });
  const body = fs.readFileSync(tmp, 'utf8');
  try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  return {
    index_html_sha256: sha256Text(body),
    entry_bundle: entryFromHtml(body),
    etag: String(head.ETag || '').replaceAll('"', ''),
    last_modified: head.LastModified || null,
    version_id: head.VersionId || null,
  };
}

function uploadTree(distDir, bucket, env) {
  const uploaded = [];
  const walk = (dir, prefix = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const key = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(abs, key);
        continue;
      }
      if (key === 'index.html') continue;
      const contentType = key.endsWith('.js')
        ? 'application/javascript'
        : key.endsWith('.css')
          ? 'text/css'
          : key.endsWith('.svg')
            ? 'image/svg+xml'
            : key.endsWith('.json')
              ? 'application/json'
              : undefined;
      const args = [
        '--region', REGION, 's3api', 'put-object',
        '--bucket', bucket,
        '--key', key,
        '--body', abs,
      ];
      if (contentType) args.push('--content-type', contentType);
      if (key.startsWith('assets/')) args.push('--cache-control', 'public,max-age=31536000,immutable');
      execFileSync(AWS, args, { encoding: 'utf8', env });
      uploaded.push(key);
    }
  };
  walk(distDir);
  return uploaded;
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const { flags, opts } = parseArgs(argv);
  if (opts.environment === 'staging' || opts.bucket === STAGING_BUCKET) {
    return printResult(fail(
      CODES.PRODUCTION_APPROVAL_REQUIRED,
      'production-spa-apply must never target staging',
    ));
  }
  const bucket = opts.bucket || PRODUCTION_BUCKET;
  const authorized = enforceScriptGuard({
    script: import.meta.url,
    target_environment: 'production',
    target_component: 'production-spa',
    deployment_type: 'spa-promote',
    workstream_id: opts['workstream-id'],
    commit: opts.commit,
  });
  enforceS3Target({
    script: import.meta.url,
    bucket,
    workstream_id: opts['workstream-id'],
    commit: opts.commit,
  });

  if (!flags.has('confirm-apply') && opts['confirm-apply'] !== true) {
    return printResult(fail(
      CODES.GUARD_APPLY_FORBIDDEN,
      'production SPA apply requires --confirm-apply after a valid receipt; no S3/CloudFront write performed',
      { receipt: authorized.details.receipt_file },
    ));
  }

  const distDir = path.resolve(opts.dist || '');
  if (!distDir || !fs.existsSync(path.join(distDir, 'index.html'))) {
    return printResult(fail(CODES.STALE_PACKAGE, 'fresh dist/index.html is required; refusing missing or old dist'));
  }
  const candidateHtml = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
  const candidateEntry = entryFromHtml(candidateHtml);
  if (!candidateEntry || FORBIDDEN_CANDIDATE_ENTRIES.some((token) => candidateEntry.includes(token))) {
    return printResult(fail(CODES.STALE_PACKAGE, 'candidate index is missing a fresh entry bundle or reuses a restored previous/staging entry', {
      candidate_entry: candidateEntry,
    }));
  }

  const preflight = authorized.details.receipt.preflight_live_fingerprint;
  let immediatelyBefore;
  try {
    immediatelyBefore = readLiveIndexFingerprint(bucket, env);
  } catch (error) {
    return printResult(fail(
      CODES.PRODUCTION_DRIFT_RECOMPOSITION_REQUIRED,
      `failed to re-read live SPA before write: ${error.message}`,
    ));
  }
  const toctou = evaluateIndexToctou({
    preflight,
    immediatelyBefore,
    driftCode: CODES.PRODUCTION_DRIFT_RECOMPOSITION_REQUIRED,
  });
  if (!toctou.ok) return printResult(toctou);

  const uploaded = uploadTree(distDir, bucket, env);
  execFileSync(AWS, [
    '--region', REGION, 's3api', 'put-object',
    '--bucket', bucket,
    '--key', 'index.html',
    '--body', path.join(distDir, 'index.html'),
    '--content-type', 'text/html; charset=utf-8',
    '--cache-control', 'no-cache,no-store,must-revalidate',
  ], { encoding: 'utf8', env });
  const invalidation = awsJson([
    'cloudfront', 'create-invalidation',
    '--distribution-id', opts.distribution || PRODUCTION_DISTRIBUTION,
    '--paths', '/index.html', '/assets/*',
  ], env);

  const after = readLiveIndexFingerprint(bucket, env);
  return printResult(ok({
    environment: 'production',
    bucket,
    uploaded_count: uploaded.length,
    candidate_entry: candidateEntry,
    candidate_index_sha256: sha256Text(candidateHtml),
    before_entry: immediatelyBefore.entry_bundle,
    before_index_sha256: immediatelyBefore.index_html_sha256,
    after_entry: after.entry_bundle,
    after_index_sha256: after.index_html_sha256,
    invalidation_id: invalidation.Invalidation?.Id || null,
    receipt: authorized.details.receipt_file,
    deploy_mode: 'per_object_put',
    staging_untouched: true,
  }));
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) process.exitCode = main();
