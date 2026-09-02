#!/usr/bin/env node
/**
 * COPY-only live Supabase Storage → staging S3 migration.
 * Does not delete or modify the source. Skips database-export / ai-knowledge-base.
 *
 * Private buckets require SUPABASE_SERVICE_ROLE_KEY (never committed).
 * Public buckets (tenant-logos, email-assets) copy with the anon key.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { APP_BUCKET_SET, SKIP_BUCKET_SET, s3KeyFor } from '../functions/api/storage-paths.mjs';

const PROD_URL = process.env.SUPABASE_URL || 'https://nbcqwpysqgyxrrbgtmkw.supabase.co';
const ANON = process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5iY3F3cHlzcWd5eHJyYmd0bWt3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcxNDQ2NTgsImV4cCI6MjA5MjcyMDY1OH0.9GNh6OK6l6vSIBgkDY-bJuqNtfHJsLNW-dc7jfRUwgw';
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const BUCKET = process.env.FILES_BUCKET || 'checksops-staging-privatefilesbucket-erzqsolpucjp';
const PUBLIC_BUCKETS = new Set(['tenant-logos', 'email-assets']);
const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

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
    else reject(new Error(`${cmd} ${args.join(' ')} failed (${code}): ${err || out}`));
  });
});

const download = async (bucket, name) => {
  const tries = [];
  if (PUBLIC_BUCKETS.has(bucket) || !SERVICE) {
    tries.push(`${PROD_URL}/storage/v1/object/public/${bucket}/${encodeURI(name)}`);
  }
  if (SERVICE) {
    tries.push(`${PROD_URL}/storage/v1/object/authenticated/${bucket}/${encodeURI(name)}`);
  }
  let last = null;
  for (const url of tries) {
    const headers = { apikey: SERVICE || ANON, Authorization: `Bearer ${SERVICE || ANON}` };
    const resp = await fetch(url, { headers });
    if (resp.ok) {
      const buf = Buffer.from(await resp.arrayBuffer());
      return {
        ok: true,
        buf,
        contentType: resp.headers.get('content-type') || 'application/octet-stream',
        url,
      };
    }
    last = { status: resp.status, body: (await resp.text()).slice(0, 120), url };
  }
  return { ok: false, ...last };
};

const headDest = async (key) => {
  try {
    const out = await run(AWS, ['s3api', 'head-object', '--bucket', BUCKET, '--key', key]);
    return { exists: true, json: JSON.parse(out || '{}') };
  } catch (error) {
    if (/Not Found|404|NotFound/i.test(String(error.message))) return { exists: false };
    throw error;
  }
};

const copyOne = async (obj, stats) => {
  const bucket = obj.bucket;
  const name = obj.name;
  if (SKIP_BUCKET_SET.has(bucket) || !APP_BUCKET_SET.has(bucket)) {
    stats.skipped.push({ bucket, name, reason: 'skipped_bucket' });
    return;
  }
  const key = s3KeyFor(bucket, name);
  if (!key) {
    stats.skipped.push({ bucket, name, reason: 'invalid_key' });
    return;
  }
  const dest = await headDest(key);
  const got = await download(bucket, name);
  if (!got.ok) {
    const reason = PUBLIC_BUCKETS.has(bucket) ? 'download_failed' : (SERVICE ? 'download_failed' : 'private_requires_service_role');
    stats.failed.push({ bucket, name, reason, status: got.status || null });
    return;
  }
  const hash = sha256(got.buf);
  const existingHash = dest.exists
    ? (dest.json?.Metadata?.sha256 || dest.json?.Metadata?.Sha256 || null)
    : null;
  if (dest.exists && existingHash && existingHash !== hash) {
    stats.conflicts.push({ bucket, name, key, reason: 'hash_mismatch', sourceSha256: hash, destSha256: existingHash });
    return;
  }
  if (dest.exists && existingHash === hash) {
    stats.copied.push({ bucket, name, key, sha256: hash, bytes: got.buf.length, skippedExisting: true });
    stats.bytes += got.buf.length;
    return;
  }
  const tmp = join(tmpdir(), `checksops-copy-${hash}`);
  await writeFile(tmp, got.buf);
  try {
    await run(AWS, [
      's3api', 'put-object',
      '--bucket', BUCKET,
      '--key', key,
      '--body', tmp,
      '--content-type', obj.mimetype || got.contentType,
      '--metadata', `sha256=${hash},source-bucket=${bucket}`,
    ]);
  } finally {
    await unlink(tmp).catch(() => {});
  }
  stats.copied.push({ bucket, name, key, sha256: hash, bytes: got.buf.length });
  stats.bytes += got.buf.length;
};

const main = async () => {
  const inventoryPath = process.argv[2] || '/tmp/storage-inventory/dump-objects.json';
  const inventory = JSON.parse(await readFile(inventoryPath, 'utf8'));
  const objects = inventory.objects || [];
  const onlyPublic = process.env.COPY_PUBLIC_ONLY === '1' || !SERVICE;
  const selected = onlyPublic ? objects.filter((o) => PUBLIC_BUCKETS.has(o.bucket)) : objects;
  const stats = {
    copied: [], failed: [], skipped: [], conflicts: [], bytes: 0,
    sourceCount: objects.length, selected: selected.length, serviceRole: Boolean(SERVICE),
  };
  for (const obj of selected) {
    await copyOne(obj, stats);
  }
  const remainingPrivate = objects.filter((o) => !PUBLIC_BUCKETS.has(o.bucket) && APP_BUCKET_SET.has(o.bucket) && !SKIP_BUCKET_SET.has(o.bucket));
  if (onlyPublic) {
    for (const obj of remainingPrivate) {
      stats.failed.push({ bucket: obj.bucket, name: obj.name, reason: 'private_requires_service_role', size: obj.size });
    }
  }
  const outDir = join(process.cwd(), 'aws/storage');
  await mkdir(outDir, { recursive: true });
  const failedByReason = stats.failed.reduce((acc, row) => {
    acc[row.reason] = (acc[row.reason] || 0) + 1;
    return acc;
  }, {});
  const manifest = {
    generatedAt: new Date().toISOString(),
    filesBucket: BUCKET,
    source: PROD_URL,
    copyMode: onlyPublic ? 'public_only' : 'all_reachable',
    sourceObjectCount: objects.length,
    selectedCount: selected.length,
    copiedCount: stats.copied.length,
    failedCount: stats.failed.length,
    skippedCount: stats.skipped.length,
    conflictCount: stats.conflicts.length,
    copiedBytes: stats.bytes,
    copied: stats.copied,
    failedSample: stats.failed.slice(0, 25),
    failedByReason,
    conflicts: stats.conflicts,
  };
  await writeFile(join(outDir, 'COPY_MANIFEST.json'), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({
    copied: manifest.copiedCount,
    failed: manifest.failedCount,
    skipped: manifest.skippedCount,
    conflicts: manifest.conflictCount,
    bytes: manifest.copiedBytes,
    mode: manifest.copyMode,
    failedByReason,
  }, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
