#!/usr/bin/env node
/**
 * Official #539 staging SPA upload. Requires a staging-frontend spa-promote receipt.
 * Refuses production. Re-reads the live index immediately before the index switch.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, printResult } from './lib/cli.mjs';
import { CODES, fail, ok } from './lib/errors.mjs';
import { enforceS3Target, enforceScriptGuard } from './require-guard.mjs';
import { evaluateIndexToctou } from './lib/spa-promote.mjs';

const AWS = process.env.AWS_CLI || process.env.AWS || 'aws';
const REGION = process.env.AWS_REGION || 'us-east-1';
const STAGING_BUCKET = 'checksops-staging-frontend-c48b';
const STAGING_DISTRIBUTION = 'E1CG52WRQZI7X1';
const PRODUCTION_BUCKET = 'checksops-production-frontend-806168576068';

function awsJson(args, env = process.env) {
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
    encoding: 'utf8',
    env,
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

export function readLiveIndexFingerprint(bucket = STAGING_BUCKET, env = process.env) {
  if (bucket === PRODUCTION_BUCKET) {
    throw new Error('staging-spa-upload must never read/write the production bucket');
  }
  const head = awsJson(['s3api', 'head-object', '--bucket', bucket, '--key', 'index.html'], env);
  const body = execFileSync(AWS, [
    '--region', REGION, 's3api', 'get-object',
    '--bucket', bucket, '--key', 'index.html',
    '/dev/stdout',
  ], { encoding: 'utf8', env });
  return {
    index_html_sha256: sha256Text(body),
    entry_bundle: entryFromHtml(body),
    etag: String(head.ETag || '').replaceAll('"', ''),
    last_modified: head.LastModified || null,
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
  const { opts } = parseArgs(argv);
  const environment = opts.environment || 'staging';
  if (environment === 'production' || opts.bucket === PRODUCTION_BUCKET) {
    return printResult(fail(
      CODES.PRODUCTION_APPROVAL_REQUIRED,
      'staging-spa-upload must never target production',
    ));
  }
  const bucket = opts.bucket || STAGING_BUCKET;
  const component = 'staging-frontend';
  const authorized = enforceScriptGuard({
    script: import.meta.url,
    target_environment: 'staging',
    target_component: component,
    deployment_type: 'spa-promote',
    workstream_id: opts['workstream-id'],
    commit: opts.commit,
    live_fingerprint: opts.fingerprint ? JSON.parse(opts.fingerprint) : undefined,
  });
  enforceS3Target({
    script: import.meta.url,
    bucket,
    workstream_id: opts['workstream-id'],
    commit: opts.commit,
  });

  const distDir = path.resolve(opts.dist || 'dist');
  if (!fs.existsSync(path.join(distDir, 'index.html'))) {
    return printResult(fail(CODES.STALE_PACKAGE, 'fresh dist/index.html is required; refusing missing or old dist'));
  }
  const candidateHtml = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
  const candidateEntry = entryFromHtml(candidateHtml);
  if (!candidateEntry || candidateEntry.includes('DJNHggvS') || candidateEntry.includes('B4Tts4y1') || candidateEntry.includes('Da1p11Te')) {
    return printResult(fail(CODES.STALE_PACKAGE, 'candidate index is missing a fresh entry bundle or reuses a restored previous entry', {
      candidate_entry: candidateEntry,
    }));
  }

  const preflight = authorized.details.receipt.preflight_live_fingerprint;
  const immediatelyBefore = readLiveIndexFingerprint(bucket, env);
  const toctou = evaluateIndexToctou({
    preflight,
    immediatelyBefore,
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
    '--distribution-id', opts.distribution || STAGING_DISTRIBUTION,
    '--paths', '/index.html', '/assets/*',
  ], env);

  const after = readLiveIndexFingerprint(bucket, env);
  return printResult(ok({
    environment: 'staging',
    bucket,
    uploaded_count: uploaded.length,
    candidate_entry: candidateEntry,
    after_entry: after.entry_bundle,
    after_index_sha256: after.index_html_sha256,
    invalidation_id: invalidation.Invalidation?.Id || null,
    receipt: authorized.details.receipt_file,
    production_untouched: true,
  }));
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) process.exitCode = main();
