#!/usr/bin/env node
/**
 * Official production SPA upload for checksops.com.
 * Requires a production-spa spa-promote receipt. Re-reads live index
 * immediately before the index switch. Per-object put only. Never
 * restores a historical SPA. Never uses s3 sync --delete.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, printResult } from './lib/cli.mjs';
import { CODES, fail, ok } from './lib/errors.mjs';
import { enforceS3Target, enforceScriptGuard } from './require-guard.mjs';
import { evaluateIndexToctou } from './lib/spa-promote.mjs';
import {
  COMPOSED_SPA_CANDIDATE,
  CURRENT_LIVE_PRODUCTION_SPA,
  evaluateHistoricalRestore,
  evaluateReviewedBaselineMatch,
} from '../lib/qdji-dsb-recovery-spa-pins.mjs';

const AWS = process.env.AWS_CLI || process.env.AWS || 'aws';
const REGION = process.env.AWS_REGION || 'us-east-1';
const PRODUCTION_BUCKET = 'checksops-production-frontend-806168576068';
const PRODUCTION_DISTRIBUTION = 'E1B0ZWWO5559U5';
const STAGING_BUCKET = 'checksops-staging-frontend-c48b';

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

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function entryFromHtml(html) {
  const match = String(html || '').match(/\/assets\/index-[^"'\s]+\.js/);
  return match ? match[0] : null;
}

export function readLiveIndexFingerprint(bucket = PRODUCTION_BUCKET, env = process.env) {
  if (bucket === STAGING_BUCKET) {
    throw new Error('production-spa-upload must never read/write the staging bucket');
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
  const entry = entryFromHtml(body);
  let spaSha256 = null;
  if (entry) {
    const entryTmp = path.join(os.tmpdir(), `production-entry-${process.pid}.js`);
    execFileSync(AWS, [
      '--region', REGION, 's3api', 'get-object',
      '--bucket', bucket, '--key', entry.replace(/^\//, ''),
      entryTmp,
    ], { encoding: 'utf8', env });
    spaSha256 = sha256File(entryTmp);
    try { fs.unlinkSync(entryTmp); } catch { /* ignore */ }
  }
  return {
    index_html_sha256: sha256Text(body),
    entry_bundle: entry,
    spa_bundle: entry,
    spa_sha256: spaSha256,
    s3_version: head.VersionId || null,
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

export function evaluateProductionSpaPolicy({
  environment,
  bucket,
  confirmApply,
  distDir,
  immediatelyBefore,
  receiptFingerprint,
  reviewed = CURRENT_LIVE_PRODUCTION_SPA,
  composed = COMPOSED_SPA_CANDIDATE,
} = {}) {
  if (environment !== 'production' || bucket === STAGING_BUCKET) {
    return fail(CODES.GUARD_APPLY_FORBIDDEN, 'production-spa-upload must never target staging');
  }
  if (bucket && bucket !== PRODUCTION_BUCKET) {
    return fail(CODES.GUARD_APPLY_FORBIDDEN, 'production-spa-upload may only target the production frontend bucket', {
      bucket,
    });
  }
  if (!confirmApply) {
    return fail(
      CODES.GUARD_APPLY_FORBIDDEN,
      'production SPA apply requires --confirm-apply after a valid receipt; no AWS write performed',
    );
  }
  const indexPath = distDir ? path.join(distDir, 'index.html') : '';
  if (!distDir || !fs.existsSync(indexPath)) {
    return fail(CODES.STALE_PACKAGE, 'fresh dist/index.html is required; refusing missing or old dist');
  }
  const candidateHtml = fs.readFileSync(indexPath, 'utf8');
  const candidateEntry = entryFromHtml(candidateHtml);
  const candidateIndexSha = sha256Text(candidateHtml);
  const restore = evaluateHistoricalRestore({ candidateBundle: candidateEntry });
  if (!restore.ok) return fail(restore.code, restore.message, { candidate_entry: candidateEntry });
  if (candidateEntry !== composed.spa_bundle) {
    return fail(CODES.STALE_PACKAGE, 'candidate entry is not the reviewed composed SPA built from current live source', {
      candidate_entry: candidateEntry,
      required_entry: composed.spa_bundle,
    });
  }
  if (candidateIndexSha !== composed.index_html_sha256) {
    return fail(CODES.STALE_PACKAGE, 'composed index.html hash does not match the reviewed candidate', {
      candidate_index_html_sha256: candidateIndexSha,
      required_index_html_sha256: composed.index_html_sha256,
    });
  }
  const entryFile = path.join(distDir, composed.spa_bundle.replace(/^\//, ''));
  if (!fs.existsSync(entryFile) || sha256File(entryFile) !== composed.spa_sha256) {
    return fail(CODES.STALE_PACKAGE, 'composed entry bundle hash does not match the reviewed candidate', {
      entry: composed.spa_bundle,
    });
  }
  const livePins = {
    spa_bundle: immediatelyBefore?.spa_bundle || immediatelyBefore?.entry_bundle || null,
    spa_sha256: immediatelyBefore?.spa_sha256 || null,
    index_html_sha256: immediatelyBefore?.index_html_sha256 || null,
    s3_version: immediatelyBefore?.s3_version || immediatelyBefore?.version || null,
  };
  const baseline = evaluateReviewedBaselineMatch({
    kind: 'spa',
    reviewed: {
      spa_bundle: reviewed.spa_bundle,
      spa_sha256: reviewed.spa_sha256,
      index_html_sha256: reviewed.index_html_sha256,
      s3_version: reviewed.s3_version,
    },
    live: livePins,
  });
  if (!baseline.ok) {
    return fail(baseline.code, baseline.message, { diffs: baseline.diffs, reviewed, live: livePins });
  }
  const toctou = evaluateIndexToctou({
    preflight: receiptFingerprint,
    immediatelyBefore,
  });
  if (!toctou.ok) return toctou;
  return ok({
    candidate_entry: candidateEntry,
    candidate_index_html_sha256: candidateIndexSha,
    deploy_mode: 'per_object_put',
  });
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const { flags, opts } = parseArgs(argv);
  const environment = opts.environment || 'production';
  const bucket = opts.bucket || PRODUCTION_BUCKET;
  if (environment !== 'production' || bucket === STAGING_BUCKET) {
    return printResult(fail(CODES.PRODUCTION_APPROVAL_REQUIRED, 'production-spa-upload must never target staging'));
  }
  const authorized = enforceScriptGuard({
    script: import.meta.url,
    target_environment: 'production',
    target_component: 'production-spa',
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

  const immediatelyBefore = readLiveIndexFingerprint(bucket, env);
  const policy = evaluateProductionSpaPolicy({
    environment,
    bucket,
    confirmApply: flags.has('confirm-apply') || opts['confirm-apply'] === true,
    distDir: path.resolve(opts.dist || 'dist'),
    immediatelyBefore,
    receiptFingerprint: authorized.details.receipt.preflight_live_fingerprint,
  });
  if (!policy.ok) return printResult(policy);

  const distDir = path.resolve(opts.dist || 'dist');
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
    candidate_entry: policy.details.candidate_entry,
    after_entry: after.entry_bundle,
    after_index_sha256: after.index_html_sha256,
    after_s3_version: after.s3_version,
    invalidation_id: invalidation.Invalidation?.Id || null,
    receipt: authorized.details.receipt_file,
    deploy_mode: 'per_object_put',
    configuration_untouched: true,
    homeowner_untouched: true,
  }));
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) process.exitCode = main();
