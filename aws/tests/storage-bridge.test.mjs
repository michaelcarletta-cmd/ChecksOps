import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  LIVE_SIGN_BATCH,
  approvedSourceObjects,
  batchesOf,
  classifyCopy,
  classifyCopyPreserveExisting,
  destinationKey,
  groupByBucket,
  isApprovedMigrationObject,
  isBridgeHealthy,
  keyFingerprint,
  parseSignUrls,
  remainingPrivateObjects,
  resolvedDownloadedSize,
  sanitizeCopyRow,
  sha256Hex,
  supabaseBucketFromS3Key,
  tokenMatches,
} from '../storage/bridge-lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

test('storage bridge token hash is env-configured and fail-closed', () => {
  const src = readFileSync(join(ROOT, 'supabase/functions/aws-staging-storage-bridge/index.ts'), 'utf8');
  assert.match(src, /AWS_MIGRATION_TOKEN_SHA256/);
  assert.match(src, /CHECKSOPS_STORAGE_MIGRATION_TOKEN_SHA256/);
  assert.match(src, /unconfigured/);
  assert.match(src, /dbWrites: false/);
  assert.match(src, /deletes: false/);
  assert.doesNotMatch(src, /PINNED_TOKEN_SHA256/);
  assert.doesNotMatch(src, /console\.(log|info|debug|error)\([^)]*SERVICE_ROLE/);
});

test('migration token is compared by SHA-256 and never treated as a service role', () => {
  assert.equal(tokenMatches('wrong-token'), false);
  const token = 'unit-test-token';
  assert.equal(sha256Hex(token).length, 64);
  assert.equal(tokenMatches(''), false);
});

test('only approved application buckets are migrated', () => {
  assert.equal(isApprovedMigrationObject('claim-files', 'checks/a/front.jpg'), true);
  assert.equal(isApprovedMigrationObject('endorsement-packets', 'packets/a/packet.svg'), true);
  assert.equal(isApprovedMigrationObject('ai-knowledge-base', 'doc.md'), false);
  assert.equal(isApprovedMigrationObject('database_export_01_09_26', 'dump.sql'), false);
  assert.equal(isApprovedMigrationObject('claim-files', '../etc/passwd'), false);
  assert.equal(destinationKey('claim-files', 'checks/a/front.jpg'), 'files/claim-files/checks/a/front.jpg');
});

test('remaining private set excludes already-copied public branding', () => {
  const remaining = remainingPrivateObjects([
    { bucket: 'tenant-logos', name: 'a.png' },
    { bucket: 'email-assets', name: 'checksops-logo.png' },
    { bucket: 'claim-files', name: 'checks/a/front.jpg' },
    { bucket: 'ai-knowledge-base', name: 'x' },
  ]);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].bucket, 'claim-files');
  assert.equal(batchesOf(new Array(45).fill(0), 20).map((b) => b.length).join(','), '20,20,5');
});

test('approved source inventory includes public branding and excludes skip buckets', () => {
  const approved = approvedSourceObjects([
    { bucket: 'tenant-logos', name: 'a.png' },
    { bucket: 'email-assets', name: 'checksops-logo.png' },
    { bucket: 'claim-files', name: 'checks/a/front.jpg' },
    { bucket: 'ai-knowledge-base', name: 'x' },
    { bucket: 'database-export', name: 'dump.sql' },
  ]);
  assert.equal(approved.length, 3);
  assert.equal(batchesOf(new Array(51).fill(0), LIVE_SIGN_BATCH).map((b) => b.length).join(','), '50,1');
  assert.ok(LIVE_SIGN_BATCH <= 50);
});

test('null inventory size is not treated as zero', () => {
  assert.equal(resolvedDownloadedSize(4096, null), 4096);
  assert.equal(resolvedDownloadedSize(0, null), 0);
  assert.equal(resolvedDownloadedSize(undefined, null), null);
  assert.equal(resolvedDownloadedSize(undefined, 12), 12);
});

test('existing staging objects are verified and never blindly overwritten', () => {
  assert.deepEqual(classifyCopyPreserveExisting({
    exists: true, existingHash: 'aaa', sourceHash: 'bbb',
  }), { action: 'conflict', reason: 'hash_mismatch' });
  assert.equal(classifyCopyPreserveExisting({
    exists: true, existingHash: 'aaa', sourceHash: 'aaa',
  }).action, 'skip_existing');
  assert.equal(classifyCopyPreserveExisting({
    exists: false, existingHash: null, sourceHash: 'aaa',
  }).action, 'put');
  assert.equal(classifyCopyPreserveExisting({
    exists: true, existingHash: null, sourceHash: 'aaa',
  }).action, 'need_dest_hash');
});

test('recon helpers fingerprint keys and map files/ prefixes without exposing paths in the fingerprint API', () => {
  assert.equal(supabaseBucketFromS3Key('files/claim-files/checks/a.jpg'), 'claim-files');
  assert.equal(supabaseBucketFromS3Key('files/homeowner-uploads/x.pdf'), 'homeowner-uploads');
  assert.equal(keyFingerprint('files/claim-files/secret.jpg').length, 64);
  assert.notEqual(keyFingerprint('files/claim-files/secret.jpg'), 'files/claim-files/secret.jpg');
  const row = sanitizeCopyRow({
    bucket: 'claim-files',
    key: 'files/claim-files/checks/pii.jpg',
    reason: 'hash_mismatch',
    bytes: 12,
  });
  assert.equal(row.bucket, 'claim-files');
  assert.equal(row.keyHash.length, 64);
  assert.equal(row.reason, 'hash_mismatch');
  assert.equal(JSON.stringify(row).includes('pii.jpg'), false);
});

test('hash mismatch refuses silent overwrite', () => {
  assert.deepEqual(classifyCopy({ exists: true, existingHash: 'aaa', sourceHash: 'bbb' }), {
    action: 'conflict',
    reason: 'hash_mismatch',
  });
  assert.equal(classifyCopy({ exists: true, existingHash: 'aaa', sourceHash: 'aaa' }).action, 'skip_existing');
  assert.equal(classifyCopy({ exists: false, existingHash: null, sourceHash: 'aaa' }).action, 'put');
});

test('live bridge health and per-bucket sign payloads are accepted', () => {
  assert.equal(isBridgeHealthy(200, { status: 'ok', mode: 'migration-bridge' }), true);
  assert.equal(isBridgeHealthy(200, { ok: true }), true);
  assert.equal(isBridgeHealthy(401, { error: 'unauthorized' }), false);
  const grouped = groupByBucket([
    { bucket: 'claim-files', name: 'a.jpg' },
    { bucket: 'endorsement-packets', name: 'b.svg' },
    { bucket: 'claim-files', name: 'c.jpg' },
  ]);
  assert.equal(grouped.get('claim-files').length, 2);
  const parsed = parseSignUrls({
    status: 'ok',
    urls: [
      { path: 'a.jpg', signed_url: 'https://example/a', error: null },
      { path: 'c.jpg', signed_url: null, error: 'not_found' },
    ],
  }, 'claim-files');
  assert.equal(parsed.byName.get('claim-files/a.jpg'), 'https://example/a');
  assert.equal(parsed.failed[0].reason, 'not_found');
});

test('bridge and worker source never request a service-role key from the operator', () => {
  const worker = readFileSync(join(ROOT, 'aws/storage/bridge-copy.mjs'), 'utf8');
  const rehearsal = readFileSync(join(ROOT, 'aws/db-copy/rehearsal/scripts/bridge-storage-copy.mjs'), 'utf8');
  const fn = readFileSync(join(ROOT, 'supabase/functions/aws-staging-storage-bridge/index.ts'), 'utf8');
  assert.doesNotMatch(worker, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(rehearsal, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(rehearsal, /action: 'sign'/);
  assert.match(rehearsal, /LIVE_SIGN_BATCH/);
  assert.match(fn, /createSignedUrl/);
  assert.doesNotMatch(fn, /\.remove\(|\.delete\(/);
  assert.match(rehearsal, /classifyCopyPreserveExisting/);
  assert.doesNotMatch(rehearsal, /console\.(log|info).*signedUrl/);
});
