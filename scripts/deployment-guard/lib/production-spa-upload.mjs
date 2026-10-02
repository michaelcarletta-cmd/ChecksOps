import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { requireDeploymentGuard, refuseUnguardedDeploy } from '../require-guard.mjs';
import { validateReceipt } from './receipt.mjs';
import { lookupSharedBucket, lookupSharedCloudFront } from './shared-targets.mjs';
import { evaluateIndexToctou } from './spa-promote.mjs';
import { CODES, errorEntry, fail, failMany, ok } from './errors.mjs';
import { consumeReceiptOnce } from './consumed-receipts.mjs';

function sha256Text(text) {
  return createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function sha256File(file) {
  const buf = fs.readFileSync(file);
  return createHash('sha256').update(buf).digest('hex');
}

function entryFromHtml(html) {
  const match = String(html || '').match(/\/assets\/index-[^"'\\s]+\.js/);
  return match ? match[0] : null;
}

export function distFingerprint(distDir) {
  const abs = path.resolve(distDir || 'dist');
  const indexFile = path.join(abs, 'index.html');
  if (!fs.existsSync(indexFile)) {
    return fail(CODES.STALE_PACKAGE, 'fresh dist/index.html is required; refusing missing or old dist', {
      dist: abs,
    });
  }
  const html = fs.readFileSync(indexFile, 'utf8');
  const entry = entryFromHtml(html);
  if (!entry) {
    return fail(CODES.STALE_PACKAGE, 'candidate dist/index.html is missing an /assets/index-*.js entry bundle reference');
  }
  const entryPath = path.join(abs, entry.replace(/^\//, ''));
  if (!fs.existsSync(entryPath)) {
    return fail(CODES.STALE_PACKAGE, 'candidate dist is missing the referenced entry bundle', {
      entry_bundle: entry,
      expected_path: entryPath,
    });
  }
  return ok({
    dist: abs,
    index_html_sha256: sha256Text(html),
    entry_bundle: entry,
    entry_bundle_sha256: sha256File(entryPath),
  });
}

function contentTypeForKey(key) {
  if (key.endsWith('.js')) return 'application/javascript';
  if (key.endsWith('.css')) return 'text/css';
  if (key.endsWith('.svg')) return 'image/svg+xml';
  if (key.endsWith('.json')) return 'application/json';
  if (key.endsWith('.ico')) return 'image/x-icon';
  if (key.endsWith('.png')) return 'image/png';
  if (key.endsWith('.jpg') || key.endsWith('.jpeg')) return 'image/jpeg';
  if (key.endsWith('.webp')) return 'image/webp';
  return undefined;
}

function walkDistFiles(distDir) {
  const files = [];
  const walk = (dir, prefix = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const key = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(abs, key);
        continue;
      }
      files.push({ abs, key });
    }
  };
  walk(distDir);
  return files;
}

export async function verifySpaHost({ fetchImpl, host, expected }) {
  if (!fetchImpl) return fail(CODES.INVALID_MANIFEST, 'verifySpaHost requires fetchImpl');
  if (!host) return fail(CODES.INVALID_MANIFEST, 'verifySpaHost requires host');
  const indexRes = await fetchImpl(`${host.replace(/\/$/, '')}/index.html`, {
    headers: { 'cache-control': 'no-cache' },
  });
  if (!indexRes?.ok) {
    return fail(CODES.DEPLOYMENT_COLLISION, 'failed to fetch live index.html for post-deploy verification', {
      status: indexRes?.status || null,
    });
  }
  const html = await indexRes.text();
  const entry = entryFromHtml(html);
  const indexSha = sha256Text(html);
  if (expected?.index_html_sha256 && expected.index_html_sha256 !== indexSha) {
    return fail(CODES.DEPLOYMENT_COLLISION, 'post-deploy index.html sha256 mismatch', {
      expected: expected.index_html_sha256,
      actual: indexSha,
    });
  }
  if (expected?.entry_bundle && expected.entry_bundle !== entry) {
    return fail(CODES.DEPLOYMENT_COLLISION, 'post-deploy entry bundle mismatch', {
      expected: expected.entry_bundle,
      actual: entry,
    });
  }
  if (entry) {
    const jsRes = await fetchImpl(`${host.replace(/\/$/, '')}${entry}`, {
      headers: { 'cache-control': 'no-cache' },
    });
    if (!jsRes?.ok) {
      return fail(CODES.DEPLOYMENT_COLLISION, 'failed to fetch live entry bundle for post-deploy verification', {
        entry_bundle: entry,
        status: jsRes?.status || null,
      });
    }
    const js = await jsRes.text();
    const entrySha = sha256Text(js);
    if (expected?.entry_bundle_sha256 && expected.entry_bundle_sha256 !== entrySha) {
      return fail(CODES.DEPLOYMENT_COLLISION, 'post-deploy entry bundle sha256 mismatch', {
        expected: expected.entry_bundle_sha256,
        actual: entrySha,
      });
    }
    return ok({ index_html_sha256: indexSha, entry_bundle: entry, entry_bundle_sha256: entrySha });
  }
  return ok({ index_html_sha256: indexSha, entry_bundle: entry });
}

export async function applyProductionSpaUpload(input = {}, ctx = {}) {
  const env = ctx.env || process.env;
  const guardRoot = ctx.guardRoot;
  const target = ctx.target;
  const aws = ctx.aws;
  const fetchImpl = ctx.fetchImpl;
  const now = ctx.now || Date.now();

  if (!guardRoot) return fail(CODES.INVALID_MANIFEST, 'applyProductionSpaUpload requires guardRoot');
  if (!target || target.id !== 'production-spa' || target.kind !== 'spa' || target.environment !== 'production') {
    return fail(CODES.INVALID_MANIFEST, 'applyProductionSpaUpload must target only the registered production-spa target', {
      target_id: target?.id || null,
    });
  }
  const sharedBucket = lookupSharedBucket(target.s3_bucket);
  if (!sharedBucket || sharedBucket.target_environment !== 'production' || sharedBucket.target_component !== 'production-spa') {
    return fail(CODES.INVALID_MANIFEST, 'production SPA upload must target the registered production bucket', {
      bucket: target.s3_bucket || null,
    });
  }
  const sharedCf = lookupSharedCloudFront(target.cloudfront_id);
  if (!sharedCf || sharedCf.target_environment !== 'production' || sharedCf.target_component !== 'production-spa') {
    return fail(CODES.INVALID_MANIFEST, 'production SPA upload must target the registered production CloudFront distribution', {
      cloudfront_id: target.cloudfront_id || null,
    });
  }
  if (env.CHECKSOPS_DEPLOYMENT_GUARD_APPLY !== '1') {
    return fail(CODES.GUARD_APPLY_FORBIDDEN, 'production SPA upload is blocked unless CHECKSOPS_DEPLOYMENT_GUARD_APPLY=1');
  }

  const workstream_id = input.workstream_id || env.CHECKSOPS_WORKSTREAM_ID || null;
  const commit = input.commit || env.CHECKSOPS_COMMIT || null;
  if (!workstream_id || !commit) {
    return fail(CODES.ANONYMOUS_DEPLOYMENT, 'production SPA upload requires workstream_id and commit SHA', {
      workstream_id,
      commit,
    });
  }

  if (input.deployment_type !== 'spa-promote') {
    return fail(CODES.INVALID_MANIFEST, 'production SPA upload requires deployment_type: spa-promote', {
      deployment_type: input.deployment_type ?? null,
    });
  }

  if (input.deploy_mode && input.deploy_mode !== 'per_object_put') {
    return fail(CODES.STALE_PACKAGE, 'production SPA upload requires deploy_mode: per_object_put (no sync, no delete)', {
      deploy_mode: input.deploy_mode,
    });
  }

  if (!aws?.readIndexHtml || !aws?.putObject || !aws?.createInvalidation) {
    return fail(CODES.INVALID_MANIFEST, 'applyProductionSpaUpload requires aws adapter with readIndexHtml/putObject/createInvalidation');
  }

  // Validate the receipt/lease first (fail closed before any AWS call).
  const authorized = refuseUnguardedDeploy({
    target_environment: 'production',
    target_component: 'production-spa',
    deployment_type: 'spa-promote',
    workstream_id,
    commit,
    receipt_path: input.receipt_path,
    receipt: input.receipt,
  }, {
    root: guardRoot,
    now,
    env: ctx.guardEnv || env,
  });
  if (!authorized.ok) return authorized;

  const distDir = input.dist_dir || input.distDir || input.dist_path || input.distPath || 'dist';
  const dist = distFingerprint(distDir);
  if (!dist.ok) return dist;

  const before = await aws.readIndexHtml({ bucket: target.s3_bucket, key: 'index.html' });
  if (!before?.ok) return before || fail(CODES.DEPLOYMENT_COLLISION, 'failed to read live index.html');

  // Enforce preflight/live fingerprint match immediately before any write.
  const receiptFingerprint = authorized.details.receipt?.preflight_live_fingerprint || null;
  const orderedExpectedFingerprint = {};
  if (receiptFingerprint && typeof receiptFingerprint === 'object') {
    for (const key of Object.keys(receiptFingerprint)) {
      orderedExpectedFingerprint[key] = before.details.fingerprint?.[key] ?? null;
    }
  }
  const drift = validateReceipt(authorized.details.receipt, {
    workstream_id,
    commit,
    target_environment: 'production',
    target_component: 'production-spa',
    deployment_type: 'spa-promote',
    preflight_live_fingerprint: orderedExpectedFingerprint,
  }, { now, root: guardRoot });
  if (!drift.ok) return drift;

  // Second: require the full production gate + accepted contracts + accepted source composition.
  try {
    requireDeploymentGuard({
      ...input,
      workstream_id,
      commit,
      target_environment: 'production',
      target_component: 'production-spa',
      deployment_type: 'spa-promote',
      owned_components: ['index.html'],
      preflight: before.details.fingerprint,
      preflight_live_fingerprint: before.details.fingerprint,
      immediately_before: before.details.fingerprint,
      production_fingerprint: before.details.fingerprint,
      immediately_before_fingerprint: before.details.fingerprint,
      dist: { ...(typeof input.dist === 'object' ? input.dist : {}), clean_build: true },
      clean_build: true,
    }, {
      root: guardRoot,
      env: ctx.guardEnv || env,
      now,
      skip_contracts: false,
    });
  } catch (error) {
    return fail(error.code || CODES.DEPLOYMENT_GUARD_REQUIRED, error.message, error.details || {});
  }

  // Enforce single-use receipt only after all pre-write validation passes.
  const consumed = consumeReceiptOnce(guardRoot, authorized.details.receipt, {
    now,
    actor: input.operator || env.USER || null,
    script: ctx.script || null,
  });
  if (!consumed.ok) return consumed;

  // Upload assets first (non-index.html) with per-object put.
  const uploads = [];
  const files = walkDistFiles(dist.details.dist);
  const nonIndex = files.filter((f) => f.key !== 'index.html');
  for (const file of nonIndex) {
    const contentType = contentTypeForKey(file.key);
    const cacheControl = file.key.startsWith('assets/')
      ? 'public,max-age=31536000,immutable'
      : undefined;
    const put = await aws.putObject({
      bucket: target.s3_bucket,
      key: file.key,
      bodyPath: file.abs,
      contentType,
      cacheControl,
    });
    if (!put?.ok) return put || fail(CODES.DEPLOYMENT_COLLISION, 'asset upload failed', { key: file.key });
    uploads.push({ key: file.key, ...put.details });
  }

  // TOCTOU check immediately before the index switch.
  const immediatelyBefore = await aws.readIndexHtml({ bucket: target.s3_bucket, key: 'index.html' });
  if (!immediatelyBefore?.ok) return immediatelyBefore || fail(CODES.DEPLOYMENT_COLLISION, 'failed to re-read live index.html');
  const toctou = evaluateIndexToctou({
    preflight: before.details.fingerprint,
    immediatelyBefore: immediatelyBefore.details.fingerprint,
  });
  if (!toctou.ok) return toctou;

  // Upload index.html last.
  const indexPut = await aws.putObject({
    bucket: target.s3_bucket,
    key: 'index.html',
    bodyPath: path.join(dist.details.dist, 'index.html'),
    contentType: 'text/html; charset=utf-8',
    cacheControl: 'no-cache,no-store,must-revalidate',
  });
  if (!indexPut?.ok) return indexPut || fail(CODES.DEPLOYMENT_COLLISION, 'index.html upload failed');

  const invalidation = await aws.createInvalidation({
    distributionId: target.cloudfront_id,
    paths: ['/index.html', '/assets/*'],
  });
  if (!invalidation?.ok) return invalidation || fail(CODES.DEPLOYMENT_COLLISION, 'cloudfront invalidation failed');

  const after = await aws.readIndexHtml({ bucket: target.s3_bucket, key: 'index.html' });
  if (!after?.ok) return after || fail(CODES.DEPLOYMENT_COLLISION, 'failed to read index.html after upload');

  const expected = {
    index_html_sha256: dist.details.index_html_sha256,
    entry_bundle: dist.details.entry_bundle,
    entry_bundle_sha256: dist.details.entry_bundle_sha256,
  };
  if (after.details.fingerprint.index_html_sha256 !== expected.index_html_sha256
    || after.details.fingerprint.entry_bundle !== expected.entry_bundle) {
    return fail(CODES.DEPLOYMENT_COLLISION, 'S3 index.html fingerprint after upload does not match candidate', {
      expected,
      actual: after.details.fingerprint,
    });
  }

  const hostVerify = await verifySpaHost({
    fetchImpl,
    host: target.host,
    expected,
  });
  if (!hostVerify.ok) return hostVerify;

  return ok({
    environment: 'production',
    component: 'production-spa',
    target: {
      id: target.id,
      bucket: target.s3_bucket,
      cloudfront_id: target.cloudfront_id,
      host: target.host,
    },
    receipt: {
      file: authorized.details.receipt_file || null,
      mac: authorized.details.receipt.mac,
      consumed_marker: consumed.details.file,
    },
    workstream_id,
    commit,
    old_production_fingerprint: before.details.fingerprint,
    immediately_before_switch_fingerprint: immediatelyBefore.details.fingerprint,
    candidate_fingerprint: expected,
    after_s3_fingerprint: after.details.fingerprint,
    after_host_fingerprint: hostVerify.details,
    uploads,
    index_put: indexPut.details,
    cloudfront_invalidation: invalidation.details,
    timestamps: {
      started_at: new Date(now).toISOString(),
      finished_at: new Date(Date.now()).toISOString(),
    },
    rollback: false,
    reclaim_forbidden: true,
  });
}

export function defaultScriptName(metaUrl) {
  try {
    return fileURLToPath(metaUrl);
  } catch {
    return String(metaUrl || '');
  }
}

