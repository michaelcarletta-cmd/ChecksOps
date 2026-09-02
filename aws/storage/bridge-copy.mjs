#!/usr/bin/env node
/**
 * AWS-side COPY worker for the temporary Lovable Storage bridge.
 * Consumes short-lived signed URLs and writes private staging S3 objects.
 * Never logs credentials, signed URLs, or file contents.
 */
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  BRIDGE_TOKEN_SHA256,
  MAX_SIGN_BATCH,
  batchesOf,
  classifyCopy,
  destinationKey,
  groupByBucket,
  isBridgeHealthy,
  parseSignUrls,
  remainingPrivateObjects,
  sha256Buffer,
  tokenMatches,
} from './bridge-lib.mjs';

const PROD_FUNCTIONS = process.env.BRIDGE_URL
  || 'https://nbcqwpysqgyxrrbgtmkw.supabase.co/functions/v1/aws-staging-storage-bridge';
const ANON = process.env.SUPABASE_ANON_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5iY3F3cHlzcWd5eHJyYmd0bWt3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcxNDQ2NTgsImV4cCI6MjA5MjcyMDY1OH0.9GNh6OK6l6vSIBgkDY-bJuqNtfHJsLNW-dc7jfRUwgw';
const BUCKET = process.env.FILES_BUCKET || 'checksops-staging-privatefilesbucket-erzqsolpucjp';
const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const TOKEN_FILE = process.env.BRIDGE_TOKEN_FILE || '/tmp/storage-migration-token';
const MAX_ATTEMPTS = 4;

const run = (cmd, args) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (d) => stdout.push(d));
  child.stderr.on('data', (d) => stderr.push(d));
  child.on('close', (code) => {
    const out = Buffer.concat(stdout).toString('utf8');
    const err = Buffer.concat(stderr).toString('utf8');
    if (code === 0) resolve(out);
    else reject(new Error(`${cmd} failed (${code}): ${(err || out).slice(0, 400)}`));
  });
});

const loadToken = async () => {
  if (process.env.CHECKSOPS_STORAGE_MIGRATION_TOKEN) return process.env.CHECKSOPS_STORAGE_MIGRATION_TOKEN;
  return (await readFile(TOKEN_FILE, 'utf8')).trim();
};

const bridgeFetch = async (token, body) => {
  const response = await fetch(PROD_FUNCTIONS, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: ANON,
      authorization: `Bearer ${ANON}`,
      'x-checksops-migration-token': token,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json = {};
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 180) }; }
  return { status: response.status, json };
};

const headDest = async (key) => {
  try {
    const out = await run(AWS, ['s3api', 'head-object', '--bucket', BUCKET, '--key', key, '--output', 'json']);
    return { exists: true, json: JSON.parse(out || '{}') };
  } catch (error) {
    if (/Not Found|404|NotFound/i.test(String(error.message))) return { exists: false, json: {} };
    throw error;
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const downloadSigned = async (url) => {
  const response = await fetch(url);
  if (!response.ok) {
    return { ok: false, status: response.status, contentType: null, buf: null };
  }
  const buf = Buffer.from(await response.arrayBuffer());
  return {
    ok: true,
    status: response.status,
    contentType: response.headers.get('content-type') || 'application/octet-stream',
    buf,
  };
};

const putObject = async (key, filePath, contentType, hash, bucket, byteLength) => {
  const args = [
    's3api', 'put-object',
    '--bucket', BUCKET,
    '--key', key,
    '--content-type', contentType,
    '--metadata', `sha256=${hash},source-bucket=${bucket}`,
  ];
  // AWS CLI rejects --body for a zero-byte file ("Blob values must be a path to a file").
  if (byteLength > 0) args.push('--body', filePath);
  await run(AWS, args);
};

const copyOne = async (obj, signedUrl, stats) => {
  const key = destinationKey(obj.bucket, obj.name);
  if (!key) {
    stats.skipped.push({ bucket: obj.bucket, name: obj.name, reason: 'invalid_key' });
    return;
  }
  const dest = await headDest(key);
  let got = { ok: false, status: 0, buf: null, contentType: null };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    got = await downloadSigned(signedUrl);
    if (got.ok) break;
    if (stats && Number.isFinite(stats.downloadRetries)) stats.downloadRetries += 1;
    if (got.status && got.status < 500 && got.status !== 429) break;
    await sleep(Math.min(8000, 500 * 2 ** (attempt - 1)));
  }
  if (!got.ok) {
    stats.failed.push({ bucket: obj.bucket, name: obj.name, key, reason: 'download_failed', status: got.status || null });
    return;
  }
  const hash = sha256Buffer(got.buf);
  const existingHash = dest.exists
    ? (dest.json?.Metadata?.sha256 || dest.json?.Metadata?.Sha256 || null)
    : null;
  const decision = classifyCopy({ exists: dest.exists, existingHash, sourceHash: hash });
  if (decision.action === 'conflict') {
    stats.conflicts.push({
      bucket: obj.bucket, name: obj.name, key,
      reason: 'hash_mismatch', sourceSha256: hash, destSha256: existingHash, bytes: got.buf.length,
    });
    return;
  }
  if (decision.action === 'skip_existing') {
    stats.copied.push({
      bucket: obj.bucket, name: obj.name, key, sha256: hash, bytes: got.buf.length, skippedExisting: true,
    });
    stats.bytes += got.buf.length;
    return;
  }
  // Unique temp path per put: identical source bytes share a sha256, and
  // concurrent copies must not unlink each other's --body file.
  const tmp = join(tmpdir(), `checksops-bridge-${hash.slice(0, 16)}-${randomUUID()}`);
  if (got.buf.length > 0) await writeFile(tmp, got.buf);
  try {
    await putObject(key, tmp, obj.mimetype || got.contentType, hash, obj.bucket, got.buf.length);
  } finally {
    if (got.buf.length > 0) await unlink(tmp).catch(() => {});
  }
  stats.copied.push({
    bucket: obj.bucket, name: obj.name, key, sha256: hash, bytes: got.buf.length, skippedExisting: false,
  });
  stats.bytes += got.buf.length;
};

const main = async () => {
  const inventoryPath = process.argv[2] || '/tmp/storage-inventory/dump-objects.json';
  const inventory = JSON.parse(await readFile(inventoryPath, 'utf8'));
  const token = await loadToken();
  if (!tokenMatches(token, BRIDGE_TOKEN_SHA256)) {
    throw new Error('migration token does not match pinned SHA-256');
  }
  const health = await bridgeFetch(token, { action: 'health' });
  if (health.status === 404) {
    const summary = {
      ok: false,
      blocked: 'bridge_not_deployed',
      message: 'Production Edge Function aws-staging-storage-bridge is not deployed. Management PAT is unauthorized; service-role key was not requested.',
      healthStatus: health.status,
      healthError: health.json?.error || health.json?.code || null,
    };
    await mkdir(join(process.cwd(), 'aws/storage'), { recursive: true });
    await writeFile(join(process.cwd(), 'aws/storage/BRIDGE_COPY_SUMMARY.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary, null, 2));
    process.exit(2);
  }
  if (health.status !== 200 || !isBridgeHealthy(health.status, health.json)) {
    const summary = {
      ok: false,
      blocked: 'bridge_health_failed',
      healthStatus: health.status,
      error: health.json?.error || null,
    };
    await writeFile(join(process.cwd(), 'aws/storage/BRIDGE_COPY_SUMMARY.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary, null, 2));
    process.exit(2);
  }

  const remaining = remainingPrivateObjects(inventory.objects || []);
  const stats = {
    copied: [], failed: [], skipped: [], conflicts: [], bytes: 0,
    sourceCount: (inventory.objects || []).length,
    remainingPrivate: remaining.length,
    signRetries: 0,
    downloadRetries: 0,
  };
  const grouped = groupByBucket(remaining);
  let batchIndex = 0;
  const totalBatches = [...grouped.values()].reduce((n, rows) => n + batchesOf(rows, MAX_SIGN_BATCH).length, 0);

  for (const [bucket, objects] of grouped) {
    for (const batch of batchesOf(objects, MAX_SIGN_BATCH)) {
      batchIndex += 1;
      let signedResp = { status: 0, json: {} };
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        signedResp = await bridgeFetch(token, {
          action: 'sign',
          bucket,
          paths: batch.map((obj) => obj.name),
        });
        if (isBridgeHealthy(signedResp.status, signedResp.json)) break;
        if (signedResp.status && signedResp.status < 500 && signedResp.status !== 429) break;
        stats.signRetries += 1;
        await sleep(Math.min(8000, 500 * 2 ** (attempt - 1)));
      }
      if (!isBridgeHealthy(signedResp.status, signedResp.json)) {
        for (const obj of batch) {
          stats.failed.push({
            bucket: obj.bucket, name: obj.name, reason: 'sign_batch_failed', status: signedResp.status,
            error: signedResp.json?.error || null,
          });
        }
        continue;
      }
      const parsed = parseSignUrls(signedResp.json, bucket);
      for (const row of parsed.failed) stats.failed.push(row);
      const jobs = [];
      for (const obj of batch) {
        const signedUrl = parsed.byName.get(`${obj.bucket}/${obj.name}`);
        if (!signedUrl) {
          if (!stats.failed.some((row) => row.bucket === obj.bucket && row.name === obj.name)) {
            stats.failed.push({ bucket: obj.bucket, name: obj.name, reason: 'missing_signed_url' });
          }
          continue;
        }
        jobs.push(obj);
        obj._signedUrl = signedUrl;
      }
      const concurrency = 5;
      for (let i = 0; i < jobs.length; i += concurrency) {
        const slice = jobs.slice(i, i + concurrency);
        await Promise.all(slice.map(async (obj) => {
          try {
            await copyOne(obj, obj._signedUrl, stats);
          } catch (error) {
            stats.failed.push({
              bucket: obj.bucket, name: obj.name, reason: 'copy_exception',
              message: String(error.message || error).slice(0, 180),
            });
          } finally {
            delete obj._signedUrl;
          }
        }));
      }
      console.log(JSON.stringify({
        progress: `${batchIndex}/${totalBatches}`,
        bucket,
        batchSize: batch.length,
        copied: stats.copied.length,
        failed: stats.failed.length,
        conflicts: stats.conflicts.length,
        bytes: stats.bytes,
      }));
    }
  }

  const failedByReason = stats.failed.reduce((acc, row) => {
    acc[row.reason] = (acc[row.reason] || 0) + 1;
    return acc;
  }, {});
  const summary = {
    generatedAt: new Date().toISOString(),
    filesBucket: BUCKET,
    copyMode: 'bridge_signed_urls',
    sourceObjectCount: stats.sourceCount,
    remainingPrivate: stats.remainingPrivate,
    copiedCount: stats.copied.length,
    failedCount: stats.failed.length,
    skippedCount: stats.skipped.length,
    conflictCount: stats.conflicts.length,
    copiedBytes: stats.bytes,
    signRetries: stats.signRetries,
    failedByReason,
    conflicts: stats.conflicts,
    failedSample: stats.failed.slice(0, 25),
    copiedSample: stats.copied.slice(0, 10),
  };
  const outDir = join(process.cwd(), 'aws/storage');
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'BRIDGE_COPY_SUMMARY.json'), JSON.stringify(summary, null, 2));
  await writeFile(join(outDir, 'BRIDGE_COPY_MANIFEST.json'), JSON.stringify({
    ...summary,
    copied: stats.copied,
    failed: stats.failed,
    skipped: stats.skipped,
  }, null, 2));
  console.log(JSON.stringify({
    copied: summary.copiedCount,
    failed: summary.failedCount,
    conflicts: summary.conflictCount,
    bytes: summary.copiedBytes,
    signRetries: summary.signRetries,
    failedByReason,
  }, null, 2));
  if (stats.failed.length || stats.conflicts.length) process.exit(3);
};

main().catch((error) => {
  console.error(String(error.message || error).slice(0, 300));
  process.exit(1);
});
