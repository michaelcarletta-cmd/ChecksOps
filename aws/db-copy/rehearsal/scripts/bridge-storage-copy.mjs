#!/usr/bin/env node
/**
 * PR #127 read-only production Lovable Storage → AWS staging S3 COPY + recon.
 *
 * Uses the temporary aws-staging-storage-bridge (sign ≤ 50). Never mutates
 * Lovable Storage. Never overwrites an existing staging object whose hash
 * does not match production. Staging-only UAT keys are left in place.
 *
 * Logs and committed outputs contain counts/aggregates and key fingerprints
 * only — no signed URLs, tokens, object paths, or file bytes.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
  LIVE_SIGN_BATCH,
  approvedSourceObjects,
  batchesOf,
  classifyCopyPreserveExisting,
  destinationKey,
  groupByBucket,
  isApprovedMigrationObject,
  isBridgeHealthy,
  keyFingerprint,
  parseSignUrls,
  resolvedDownloadedSize,
  sanitizeCopyRow,
  sha256Buffer,
  sha256Hex,
  supabaseBucketFromS3Key,
} from '../../../storage/bridge-lib.mjs';
import { SKIP_BUCKET_SET } from '../../../functions/api/storage-paths.mjs';
import { enforceS3Target } from '../../../../scripts/deployment-guard/require-guard.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const PROD_FUNCTIONS = process.env.BRIDGE_URL
  || 'https://nbcqwpysqgyxrrbgtmkw.supabase.co/functions/v1/aws-staging-storage-bridge';
const ANON = process.env.SUPABASE_ANON_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5iY3F3cHlzcWd5eHJyYmd0bWt3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcxNDQ2NTgsImV4cCI6MjA5MjcyMDY1OH0.9GNh6OK6l6vSIBgkDY-bJuqNtfHJsLNW-dc7jfRUwgw';
const FILES_BUCKET = process.env.FILES_BUCKET || 'checksops-staging-privatefilesbucket-erzqsolpucjp';
const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const SECRET_ID = process.env.STORAGE_MIGRATION_SECRET_ID || 'checksops/staging/storage-migration-token';
const MAX_ATTEMPTS = 4;
const SIGN_BATCH = Math.min(Number(process.env.SIGN_BATCH) || LIVE_SIGN_BATCH, LIVE_SIGN_BATCH);
const COPY_CONCURRENCY = Math.min(Number(process.env.COPY_CONCURRENCY) || 6, 8);
const INVENTORY_LIMIT = 100;
const EXPECTED_TOTAL = 1411;
const EXPECTED_BY_BUCKET = {
  'claim-files': 1254,
  'endorsement-packets': 131,
  'homeowner-uploads': 8,
  'tenant-documents': 8,
  'tenant-logos': 5,
  'loss-draft-documents': 3,
  'document-templates': 1,
  'email-assets': 1,
};

const run = (cmd, args, env = process.env) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const progress = (obj) => {
  console.log(JSON.stringify(obj));
};

const loadToken = async () => {
  if (process.env.CHECKSOPS_STORAGE_MIGRATION_TOKEN) {
    return String(process.env.CHECKSOPS_STORAGE_MIGRATION_TOKEN).trim();
  }
  const raw = (await run(AWS, [
    'secretsmanager', 'get-secret-value',
    '--secret-id', SECRET_ID,
    '--query', 'SecretString',
    '--output', 'text',
  ])).trim();
  const parsed = JSON.parse(raw);
  if (!parsed?.token) throw new Error('migration secret missing token field');
  return String(parsed.token);
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
  try { json = JSON.parse(text); } catch { json = { parse_error: true }; }
  return { status: response.status, json };
};

const inventoryAll = async (token) => {
  const objects = [];
  let offset = 0;
  let pages = 0;
  let reportedTotal = null;
  while (pages < 80) {
    let resp = { status: 0, json: {} };
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      resp = await bridgeFetch(token, { action: 'inventory', limit: INVENTORY_LIMIT, offset });
      if (resp.status === 200 && resp.json?.ok === true && Array.isArray(resp.json.objects)) break;
      if (resp.status && resp.status < 500 && resp.status !== 429) break;
      await sleep(Math.min(8000, 500 * 2 ** (attempt - 1)));
    }
    if (resp.status !== 200 || resp.json?.ok !== true || !Array.isArray(resp.json.objects)) {
      throw new Error(`inventory_failed status=${resp.status} error=${resp.json?.error || 'unknown'}`);
    }
    pages += 1;
    if (Number.isFinite(resp.json.total)) reportedTotal = resp.json.total;
    const page = resp.json.objects;
    objects.push(...page);
    if (page.length < INVENTORY_LIMIT) break;
    offset += INVENTORY_LIMIT;
  }
  return { objects, pages, reportedTotal };
};

const signBatch = async (token, batch) => {
  const items = batch.map((obj) => ({ bucket: obj.bucket, name: obj.name }));
  let resp = { status: 0, json: {} };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    resp = await bridgeFetch(token, { action: 'sign', items });
    if (isBridgeHealthy(resp.status, resp.json)) break;
    if (resp.status === 400 && resp.json?.error === 'invalid_batch') {
      const bucket = batch[0]?.bucket;
      resp = await bridgeFetch(token, {
        action: 'sign',
        bucket,
        paths: batch.map((obj) => obj.name),
      });
      if (isBridgeHealthy(resp.status, resp.json)) break;
    }
    if (resp.status && resp.status < 500 && resp.status !== 429) break;
    await sleep(Math.min(8000, 500 * 2 ** (attempt - 1)));
  }
  return resp;
};

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

const headDest = async (key) => {
  try {
    const out = await run(AWS, ['s3api', 'head-object', '--bucket', FILES_BUCKET, '--key', key, '--output', 'json']);
    const json = JSON.parse(out || '{}');
    const meta = json.Metadata || json.metadata || {};
    return {
      exists: true,
      contentLength: Number.isFinite(json.ContentLength) ? json.ContentLength : null,
      hash: meta.sha256 || meta.Sha256 || null,
      json,
    };
  } catch (error) {
    if (/Not Found|404|NotFound/i.test(String(error.message))) return { exists: false, contentLength: null, hash: null, json: {} };
    throw error;
  }
};

const hashDestObject = async (key) => {
  const tmp = join(tmpdir(), `checksops-dest-${keyFingerprint(key).slice(0, 16)}-${Date.now()}`);
  try {
    await run(AWS, ['s3api', 'get-object', '--bucket', FILES_BUCKET, '--key', key, tmp]);
    const { readFile } = await import('node:fs/promises');
    const buf = await readFile(tmp);
    return { hash: sha256Buffer(buf), bytes: buf.length };
  } finally {
    await unlink(tmp).catch(() => {});
  }
};

const putObject = async (key, filePath, contentType, hash, bucket, byteLength) => {
  const args = [
    's3api', 'put-object',
    '--bucket', FILES_BUCKET,
    '--key', key,
    '--content-type', contentType,
    '--metadata', `sha256=${hash},source-bucket=${bucket}`,
  ];
  if (byteLength > 0) args.push('--body', filePath);
  await run(AWS, args);
};

const listAllS3Files = async () => {
  const objects = [];
  let token = null;
  do {
    const args = [
      's3api', 'list-objects-v2',
      '--bucket', FILES_BUCKET,
      '--prefix', 'files/',
      '--output', 'json',
    ];
    if (token) args.push('--continuation-token', token);
    const json = JSON.parse(await run(AWS, args) || '{}');
    for (const item of json.Contents || []) {
      objects.push({ key: item.Key, bytes: item.Size || 0 });
    }
    token = json.IsTruncated ? json.NextContinuationToken : null;
  } while (token);
  return objects;
};

const copyOne = async (obj, signedUrl, stats, token) => {
  const key = destinationKey(obj.bucket, obj.name);
  if (!key) {
    stats.skipped.push({ bucket: obj.bucket, reason: 'invalid_key', keyHash: null });
    return;
  }
  let dest = await headDest(key);
  let got = { ok: false, status: 0, buf: null, contentType: null };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    got = await downloadSigned(signedUrl);
    if (got.ok) break;
    if (got.status === 400 || got.status === 403) {
      const resign = await signBatch(token, [obj]);
      if (isBridgeHealthy(resign.status, resign.json)) {
        const parsed = parseSignUrls(resign.json, obj.bucket);
        signedUrl = parsed.byName.get(`${obj.bucket}/${obj.name}`) || signedUrl;
      }
      stats.signRetries += 1;
    } else {
      stats.downloadRetries += 1;
    }
    if (got.status && got.status < 500 && got.status !== 429 && got.status !== 400 && got.status !== 403) break;
    await sleep(Math.min(8000, 500 * 2 ** (attempt - 1)));
  }
  if (!got.ok) {
    stats.failed.push({
      bucket: obj.bucket, key, reason: 'download_failed', status: got.status || null, bytes: null,
    });
    return;
  }
  const actualBytes = resolvedDownloadedSize(got.buf.length, obj.size);
  if (obj.size == null) {
    stats.nullSizeVerified.push({
      actualBytes: got.buf.length,
      destExisted: dest.exists,
      destBytesAfter: dest.exists ? dest.contentLength : null,
    });
  }
  if (actualBytes == null) {
    stats.failed.push({
      bucket: obj.bucket, key, reason: 'unknown_size_after_download', status: got.status, bytes: null,
    });
    return;
  }
  const hash = sha256Buffer(got.buf);
  let destHash = dest.hash || null;
  if (dest.exists && !destHash) {
    const destHashed = await hashDestObject(key);
    destHash = destHashed.hash;
    stats.destHashFetches += 1;
  }
  const decision = classifyCopyPreserveExisting({
    exists: dest.exists,
    existingHash: destHash,
    sourceHash: hash,
  });
  if (decision.action === 'need_dest_hash') {
    stats.conflicts.push({
      bucket: obj.bucket, key, reason: 'unverified_existing', bytes: got.buf.length,
    });
    return;
  }
  if (decision.action === 'conflict') {
    stats.conflicts.push({
      bucket: obj.bucket, key, reason: decision.reason, bytes: got.buf.length,
    });
    return;
  }
  if (decision.action === 'skip_existing') {
    stats.verified.push({ bucket: obj.bucket, key, bytes: got.buf.length, sha256: hash });
    stats.bytes += got.buf.length;
    return;
  }
  const tmp = join(tmpdir(), `checksops-bridge-${hash.slice(0, 16)}-${createHash('sha1').update(key).digest('hex').slice(0, 8)}`);
  if (got.buf.length > 0) await writeFile(tmp, got.buf);
  try {
    let putOk = false;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        await putObject(key, tmp, obj.mimetype || got.contentType, hash, obj.bucket, got.buf.length);
        putOk = true;
        break;
      } catch (error) {
        stats.putRetries += 1;
        if (attempt === MAX_ATTEMPTS) throw error;
        await sleep(Math.min(8000, 500 * 2 ** (attempt - 1)));
      }
    }
    if (!putOk) throw new Error('put_failed');
  } finally {
    if (got.buf.length > 0) await unlink(tmp).catch(() => {});
  }
  stats.copied.push({ bucket: obj.bucket, key, bytes: got.buf.length, sha256: hash });
  stats.bytes += got.buf.length;
};

const main = async () => {
  enforceS3Target({
    script: import.meta.url,
    bucket: FILES_BUCKET,
  });
  const token = await loadToken();
  const expectedHash = process.env.CHECKSOPS_STORAGE_MIGRATION_TOKEN_SHA256;
  if (expectedHash && sha256Hex(token) !== String(expectedHash).toLowerCase()) {
    throw new Error('migration token hash mismatch');
  }
  const health = await bridgeFetch(token, { action: 'health' });
  if (health.status !== 200 || !isBridgeHealthy(health.status, health.json)
    || health.json?.mode !== 'sign_only' || health.json?.deletes !== false || health.json?.dbWrites !== false) {
    throw new Error(`bridge_health_failed status=${health.status}`);
  }
  progress({
    phase: 'health',
    ok: true,
    mode: health.json.mode,
    maxSign: health.json.maxSign || null,
    signTtlSeconds: health.json.signTtlSeconds || null,
  });

  const inv = await inventoryAll(token);
  const source = approvedSourceObjects(inv.objects);
  const skippedExcluded = inv.objects.length - source.length;
  const byBucketSource = {};
  const sourceKeySet = new Set();
  const duplicateSource = [];
  for (const obj of source) {
    const key = destinationKey(obj.bucket, obj.name);
    if (!key) continue;
    if (sourceKeySet.has(key)) duplicateSource.push({ bucket: obj.bucket, keyHash: keyFingerprint(key) });
    sourceKeySet.add(key);
    byBucketSource[obj.bucket] = (byBucketSource[obj.bucket] || 0) + 1;
  }
  progress({
    phase: 'inventory',
    pages: inv.pages,
    reportedTotal: inv.reportedTotal,
    approved: source.length,
    excludedNotCounted: skippedExcluded,
    byBucket: byBucketSource,
  });

  const s3Before = await listAllS3Files();
  const beforeByBucket = {};
  for (const item of s3Before) {
    const b = supabaseBucketFromS3Key(item.key);
    if (!b || SKIP_BUCKET_SET.has(b)) continue;
    beforeByBucket[b] = (beforeByBucket[b] || 0) + 1;
  }
  progress({ phase: 's3_before', objects: s3Before.length, byBucket: beforeByBucket });

  const stats = {
    copied: [], verified: [], failed: [], skipped: [], conflicts: [],
    nullSizeVerified: [],
    bytes: 0,
    signRetries: 0,
    downloadRetries: 0,
    putRetries: 0,
    destHashFetches: 0,
  };

  const grouped = groupByBucket(source);
  let batchIndex = 0;
  const totalBatches = [...grouped.values()].reduce((n, rows) => n + batchesOf(rows, SIGN_BATCH).length, 0);

  for (const [bucket, objects] of grouped) {
    for (const batch of batchesOf(objects, SIGN_BATCH)) {
      if (batch.length > LIVE_SIGN_BATCH) throw new Error('sign_batch_exceeds_live_max');
      batchIndex += 1;
      const signedResp = await signBatch(token, batch);
      if (!isBridgeHealthy(signedResp.status, signedResp.json)) {
        for (const obj of batch) {
          stats.failed.push({
            bucket: obj.bucket,
            key: destinationKey(obj.bucket, obj.name),
            reason: 'sign_batch_failed',
            status: signedResp.status,
          });
        }
        progress({
          progress: `${batchIndex}/${totalBatches}`,
          bucket,
          signed: false,
          failed: stats.failed.length,
        });
        continue;
      }
      const parsed = parseSignUrls(signedResp.json, bucket);
      for (const row of parsed.failed) {
        stats.failed.push({
          bucket: row.bucket || bucket,
          key: destinationKey(row.bucket || bucket, row.name),
          reason: row.reason || 'sign_failed',
        });
      }
      const jobs = [];
      for (const obj of batch) {
        const signedUrl = parsed.byName.get(`${obj.bucket}/${obj.name}`);
        if (!signedUrl) {
          if (!stats.failed.some((row) => row.bucket === obj.bucket && row.key === destinationKey(obj.bucket, obj.name))) {
            stats.failed.push({
              bucket: obj.bucket,
              key: destinationKey(obj.bucket, obj.name),
              reason: 'missing_signed_url',
            });
          }
          continue;
        }
        jobs.push({ obj, signedUrl });
      }
      for (let i = 0; i < jobs.length; i += COPY_CONCURRENCY) {
        const slice = jobs.slice(i, i + COPY_CONCURRENCY);
        await Promise.all(slice.map(async (job) => {
          try {
            await copyOne(job.obj, job.signedUrl, stats, token);
          } catch (error) {
            stats.failed.push({
              bucket: job.obj.bucket,
              key: destinationKey(job.obj.bucket, job.obj.name),
              reason: 'copy_exception',
              message: String(error.message || error).slice(0, 120),
            });
          }
        }));
      }
      progress({
        progress: `${batchIndex}/${totalBatches}`,
        bucket,
        batchSize: batch.length,
        copied: stats.copied.length,
        verified: stats.verified.length,
        failed: stats.failed.length,
        conflicts: stats.conflicts.length,
        bytes: stats.bytes,
      });
    }
  }

  const s3After = await listAllS3Files();
  const afterKeys = new Map(s3After.map((item) => [item.key, item.bytes]));
  const missing = [];
  const migratedByBucket = {};
  const migratedBytesByBucket = {};
  let migratedBytes = 0;
  for (const obj of source) {
    const key = destinationKey(obj.bucket, obj.name);
    if (!key) continue;
    if (!afterKeys.has(key)) {
      missing.push({ bucket: obj.bucket, keyHash: keyFingerprint(key) });
      continue;
    }
    const destBytes = afterKeys.get(key);
    migratedByBucket[obj.bucket] = (migratedByBucket[obj.bucket] || 0) + 1;
    migratedBytesByBucket[obj.bucket] = (migratedBytesByBucket[obj.bucket] || 0) + destBytes;
    migratedBytes += destBytes;
  }
  const stagingOnly = [];
  const stagingOnlyByBucket = {};
  let stagingOnlyBytes = 0;
  for (const item of s3After) {
    if (!item.key?.startsWith('files/')) continue;
    const bucket = supabaseBucketFromS3Key(item.key);
    if (!bucket || SKIP_BUCKET_SET.has(bucket)) continue;
    if (sourceKeySet.has(item.key)) continue;
    stagingOnly.push({ bucket, keyHash: keyFingerprint(item.key), bytes: item.bytes });
    stagingOnlyByBucket[bucket] = (stagingOnlyByBucket[bucket] || { objects: 0, bytes: 0 });
    stagingOnlyByBucket[bucket].objects += 1;
    stagingOnlyByBucket[bucket].bytes += item.bytes;
    stagingOnlyBytes += item.bytes;
  }

  const expectedDiffs = Object.entries(EXPECTED_BY_BUCKET)
    .map(([bucket, expected]) => ({ bucket, expected, actual: migratedByBucket[bucket] || 0, delta: (migratedByBucket[bucket] || 0) - expected }))
    .filter((row) => row.delta !== 0);

  const failedByReason = stats.failed.reduce((acc, row) => {
    acc[row.reason] = (acc[row.reason] || 0) + 1;
    return acc;
  }, {});
  const conflictByReason = stats.conflicts.reduce((acc, row) => {
    acc[row.reason] = (acc[row.reason] || 0) + 1;
    return acc;
  }, {});

  const hashCompared = stats.copied.length + stats.verified.length + stats.conflicts.length;
  const hashMatched = stats.verified.length + stats.copied.length;
  const migratedCount = Object.values(migratedByBucket).reduce((n, v) => n + v, 0);

  const copyComplete = missing.length === 0 && stats.failed.length === 0 && stats.conflicts.length === 0
    && migratedCount === EXPECTED_TOTAL && expectedDiffs.length === 0 && duplicateSource.length === 0;
  const result = copyComplete ? 'PASS' : (migratedCount > 0 && health.status === 200 ? 'PARTIAL' : 'FAIL');

  const report = {
    generatedAt: new Date().toISOString(),
    result,
    copyMode: 'bridge_signed_urls',
    filesBucket: FILES_BUCKET,
    productionSupabaseChanged: false,
    lovableBridgeRemoved: false,
    signRequested: true,
    maxSignBatchUsed: SIGN_BATCH,
    s3CopyRequested: true,
    tokenExposed: false,
    signedUrlsLogged: false,
    objectPathsCommitted: false,
    health: {
      ok: true,
      mode: health.json.mode,
      deletes: health.json.deletes,
      dbWrites: health.json.dbWrites,
      maxSign: health.json.maxSign || null,
    },
    productionInventory: {
      reportedTotal: inv.reportedTotal,
      approvedObjects: source.length,
      expectedObjects: EXPECTED_TOTAL,
      inventoryPages: inv.pages,
      byBucket: byBucketSource,
      excludedSkipBuckets: skippedExcluded,
      duplicateSourceKeys: duplicateSource.length,
      nullSizeInventory: stats.nullSizeVerified.length,
    },
    copy: {
      copiedNew: stats.copied.length,
      verifiedExisting: stats.verified.length,
      failed: stats.failed.length,
      conflicts: stats.conflicts.length,
      skipped: stats.skipped.length,
      downloadedBytes: stats.bytes,
      signRetries: stats.signRetries,
      downloadRetries: stats.downloadRetries,
      putRetries: stats.putRetries,
      destHashFetches: stats.destHashFetches,
      failedByReason,
      conflictByReason,
      nullSizeVerified: stats.nullSizeVerified,
    },
    reconciliation: {
      productionObjects: source.length,
      migratedProductionObjects: migratedCount,
      missingProductionObjects: missing.length,
      failedObjects: stats.failed.length,
      mismatchedObjects: stats.conflicts.length,
      duplicateSourceKeys: duplicateSource.length,
      totalProductionBytesOnS3: migratedBytes,
      hashComparisons: {
        compared: hashCompared,
        matched: hashMatched,
        mismatched: stats.conflicts.length,
      },
      expectedBucketDiffs: expectedDiffs,
      perBucket: Object.fromEntries(
        [...new Set([...Object.keys(EXPECTED_BY_BUCKET), ...Object.keys(migratedByBucket)])].sort()
          .map((bucket) => [bucket, {
            production: byBucketSource[bucket] || 0,
            expected: EXPECTED_BY_BUCKET[bucket] || 0,
            migrated: migratedByBucket[bucket] || 0,
            bytes: migratedBytesByBucket[bucket] || 0,
          }]),
      ),
      stagingOnlyUat: {
        objects: stagingOnly.length,
        bytes: stagingOnlyBytes,
        byBucket: stagingOnlyByBucket,
        note: 'Left in place. Not overwritten or deleted.',
      },
      s3FilesPrefix: {
        before: s3Before.length,
        after: s3After.length,
      },
    },
    samples: {
      failed: stats.failed.slice(0, 15).map(sanitizeCopyRow),
      conflicts: stats.conflicts.slice(0, 15).map(sanitizeCopyRow),
      missing: missing.slice(0, 15),
    },
  };

  const outDir = join(ROOT, 'aws/db-copy/rehearsal/analysis');
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'storage_copy_reconcile.json'), `${JSON.stringify(report, null, 2)}\n`);
  progress({
    phase: 'done',
    result,
    approved: source.length,
    migrated: migratedCount,
    copiedNew: stats.copied.length,
    verifiedExisting: stats.verified.length,
    failed: stats.failed.length,
    conflicts: stats.conflicts.length,
    missing: missing.length,
    stagingOnlyUat: stagingOnly.length,
    productionBytesOnS3: migratedBytes,
    downloadedBytes: stats.bytes,
  });
  if (result !== 'PASS') process.exit(3);
};

main().catch((error) => {
  console.error(String(error.message || error).slice(0, 300));
  process.exit(1);
});
