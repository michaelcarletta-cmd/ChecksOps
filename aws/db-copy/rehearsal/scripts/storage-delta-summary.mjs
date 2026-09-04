#!/usr/bin/env node
/**
 * Sanitize + summarize S3 inventory JSON (bucket-level aggregates only).
 * Never logs object keys (may contain claim/user UUIDs or filenames).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');

const stagingPath = process.argv[2]
  || path.join(repoRoot, 'aws/db-copy/rehearsal/analysis/staging_s3_inventory.json');
const dumpPath = path.join(repoRoot, 'aws/storage/DUMP_INVENTORY.json');
const reconPath = path.join(repoRoot, 'aws/storage/RECONCILE.json');
const outPath = path.join(repoRoot, 'aws/db-copy/rehearsal/analysis/storage_delta_vs_sept1.json');

const staging = JSON.parse(fs.readFileSync(stagingPath, 'utf8'));
const dump = JSON.parse(fs.readFileSync(dumpPath, 'utf8'));
const recon = JSON.parse(fs.readFileSync(reconPath, 'utf8'));

const dumpByBucket = dump.byBucket || {};
const stagingBy = staging.by_supabase_bucket || {};

const diffs = [];
for (const bucket of new Set([...Object.keys(dumpByBucket), ...Object.keys(stagingBy)])) {
  const d = dumpByBucket[bucket];
  const s = stagingBy[bucket];
  const dCount = typeof d === 'number' ? d : (d?.objects ?? d?.count ?? null);
  const sCount = s?.objects ?? null;
  if (dCount !== sCount) {
    diffs.push({
      bucket,
      sept1DumpObjects: dCount,
      stagingObjects: sCount,
      deltaObjects: (sCount ?? 0) - (dCount ?? 0),
      stagingBytes: s?.bytes ?? null,
    });
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  sept1: {
    dumpObjectCount: dump.objectCount,
    reconciledS3Objects: recon.s3ObjectCount,
    reconciledS3Bytes: recon.s3Bytes,
  },
  stagingNow: {
    totalObjects: staging.total_objects,
    totalBytes: staging.total_bytes,
  },
  deltaObjects: (staging.total_objects ?? 0) - (dump.objectCount ?? 0),
  deltaBytes: (staging.total_bytes ?? 0) - (recon.s3Bytes ?? 0),
  bucketDiffs: diffs,
  note: 'Object keys omitted intentionally (may contain PII paths). Storage delta sync must use bridge/copy scripts with service role on an operator host.',
};

fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`wrote ${outPath}\n`);
process.stdout.write(`deltaObjects=${report.deltaObjects} bucketDiffs=${diffs.length}\n`);
