#!/usr/bin/env node
/**
 * Receipt-gated production SPA uploader/promoter.
 *
 * - Requires a valid signed, unexpired deployment-guard receipt + active lease
 * - Reads live production index.html before any write and fails on drift
 * - Uploads assets first, index.html last, then CloudFront invalidation
 * - Verifies the new site content via HTTPS fetch after upload
 * - Never syncs, deletes, or clears buckets
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgs, printResult, readInput } from './lib/cli.mjs';
import { CODES, fail, ok } from './lib/errors.mjs';
import { repoRootFrom } from './lib/paths.mjs';
import { enforceScriptGuard, resolveGuardRoot } from './require-guard.mjs';
import { applyProductionSpaUpload, defaultScriptName, entryFromHtml } from './lib/production-spa-upload.mjs';
import { createS3ConsumedReceiptRegistry } from './lib/shared-consumed-receipts.mjs';

const AWS = process.env.AWS_CLI || process.env.AWS || 'aws';
const REGION = process.env.AWS_REGION || 'us-east-1';

function sha256Text(text) {
  return createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadProtectedTarget(root, id) {
  const file = path.join(root, 'ops/deployment-guard/protected-targets.json');
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  const target = (json.targets || []).find((row) => row.id === id) || null;
  return { file, target };
}

function awsJson(args, env = process.env) {
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
    encoding: 'utf8',
    env,
  });
  return out.trim() ? JSON.parse(out) : {};
}

function readObjectToTmp({ bucket, key }, env) {
  const tmp = path.join(os.tmpdir(), `checksops-${bucket}-${key.replace(/\//g, '_')}-${process.pid}.tmp`);
  execFileSync(AWS, [
    '--region', REGION,
    's3api', 'get-object',
    '--bucket', bucket,
    '--key', key,
    tmp,
  ], { encoding: 'utf8', env });
  const body = fs.readFileSync(tmp, 'utf8');
  try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  return body;
}

function createAwsAdapter(env) {
  return {
    async readIndexHtml({ bucket, key }) {
      try {
        const head = awsJson(['s3api', 'head-object', '--bucket', bucket, '--key', key], env);
        const html = readObjectToTmp({ bucket, key }, env);
        const fingerprint = {
          index_html_sha256: sha256Text(html),
          entry_bundle: entryFromHtml(html),
          etag: String(head.ETag || '').replaceAll('"', ''),
          last_modified: head.LastModified || null,
          s3_version_id: head.VersionId || null,
        };
        return ok({ fingerprint, head });
      } catch (error) {
        return fail(CODES.DEPLOYMENT_COLLISION, 'failed to read index.html from S3', {
          bucket,
          key,
          error: error?.message || String(error),
        });
      }
    },
    async putObject({ bucket, key, bodyPath, contentType, cacheControl }) {
      try {
        const args = [
          's3api', 'put-object',
          '--bucket', bucket,
          '--key', key,
          '--body', bodyPath,
        ];
        if (contentType) args.push('--content-type', contentType);
        if (cacheControl) args.push('--cache-control', cacheControl);
        const out = awsJson(args, env);
        return ok({
          key,
          etag: String(out.ETag || '').replaceAll('"', ''),
          s3_version_id: out.VersionId || null,
        });
      } catch (error) {
        return fail(CODES.DEPLOYMENT_COLLISION, 'S3 put-object failed', {
          bucket,
          key,
          error: error?.message || String(error),
        });
      }
    },
    async createInvalidation({ distributionId, paths: invalidationPaths }) {
      try {
        const out = awsJson([
          'cloudfront', 'create-invalidation',
          '--distribution-id', distributionId,
          '--paths', ...(invalidationPaths || []),
        ], env);
        return ok({
          distribution_id: distributionId,
          invalidation_id: out.Invalidation?.Id || null,
        });
      } catch (error) {
        return fail(CODES.DEPLOYMENT_COLLISION, 'CloudFront invalidation failed', {
          distribution_id: distributionId,
          error: error?.message || String(error),
        });
      }
    },
    async waitForInvalidation({ distributionId, invalidationId }) {
      const timeoutMs = Number(env.CHECKSOPS_CLOUDFRONT_INVALIDATION_TIMEOUT_MS) || 15 * 60 * 1000;
      const intervalMs = Number(env.CHECKSOPS_CLOUDFRONT_INVALIDATION_POLL_MS) || 5000;
      const started = Date.now();
      try {
        for (;;) {
          const out = awsJson([
            'cloudfront', 'get-invalidation',
            '--distribution-id', distributionId,
            '--id', invalidationId,
          ], env);
          const status = out.Invalidation?.Status || null;
          if (status === 'Completed') {
            return ok({
              distribution_id: distributionId,
              invalidation_id: invalidationId,
              status,
            });
          }
          if (status === 'Failed') {
            return fail(CODES.DEPLOYMENT_COLLISION, 'CloudFront invalidation failed', {
              distribution_id: distributionId,
              invalidation_id: invalidationId,
              status,
            });
          }
          if (Date.now() - started >= timeoutMs) {
            return fail(CODES.DEPLOYMENT_COLLISION, 'CloudFront invalidation did not complete before host verification', {
              distribution_id: distributionId,
              invalidation_id: invalidationId,
              status,
            });
          }
          await sleep(intervalMs);
        }
      } catch (error) {
        return fail(CODES.DEPLOYMENT_COLLISION, 'CloudFront invalidation wait failed', {
          distribution_id: distributionId,
          invalidation_id: invalidationId,
          error: error?.message || String(error),
        });
      }
    },
  };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const repoRoot = repoRootFrom(import.meta.url);
  const guardRoot = resolveGuardRoot({}, env);
  const { opts } = parseArgs(argv);
  const input = readInput(opts, {});
  // Fail closed before any AWS call when unguarded.
  enforceScriptGuard({
    script: import.meta.url,
    target_environment: 'production',
    target_component: 'production-spa',
    deployment_type: 'spa-promote',
    workstream_id: input.workstream_id || env.CHECKSOPS_WORKSTREAM_ID || opts['workstream-id'],
    commit: input.commit || env.CHECKSOPS_COMMIT || opts.commit,
  }, { root: guardRoot, env });
  const { target, file: targetsFile } = loadProtectedTarget(repoRoot, 'production-spa');
  if (!target) {
    return printResult(fail(CODES.INVALID_MANIFEST, 'protected target production-spa not found', { targets_file: targetsFile }));
  }
  if (!target.s3_bucket || !target.cloudfront_id || !target.host) {
    return printResult(fail(CODES.INVALID_MANIFEST, 'protected target production-spa is missing s3_bucket/cloudfront_id/host', {
      target: target.id,
      targets_file: targetsFile,
    }));
  }
  const aws = createAwsAdapter(env);
  const receiptRegistry = createS3ConsumedReceiptRegistry({
    bucket: target.s3_bucket,
    region: REGION,
  });
  const fetchImpl = globalThis.fetch ? globalThis.fetch.bind(globalThis) : null;
  if (!fetchImpl) {
    return printResult(fail(CODES.INVALID_MANIFEST, 'Node.js fetch() is unavailable; cannot perform required post-deploy HTTPS verification'));
  }
  const result = await applyProductionSpaUpload(input, {
    env,
    guardRoot,
    target,
    aws,
    receiptRegistry,
    fetchImpl,
    script: defaultScriptName(import.meta.url),
  });
  return printResult(result);
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    // Fail closed; do not leak partial write assumptions.
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: error?.code || CODES.DEPLOYMENT_COLLISION,
      message: error?.message || String(error),
      details: error?.details || {},
    }, null, 2)}\n`);
    process.exitCode = 2;
  });
}

