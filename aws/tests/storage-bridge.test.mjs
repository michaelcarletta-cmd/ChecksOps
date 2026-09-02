import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  BRIDGE_TOKEN_SHA256,
  batchesOf,
  classifyCopy,
  destinationKey,
  groupByBucket,
  isApprovedMigrationObject,
  isBridgeHealthy,
  parseSignUrls,
  remainingPrivateObjects,
  sha256Hex,
  tokenMatches,
} from '../storage/bridge-lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

test('pinned token SHA-256 matches the Edge Function constant', () => {
  const src = readFileSync(join(ROOT, 'supabase/functions/aws-staging-storage-bridge/index.ts'), 'utf8');
  assert.match(src, new RegExp(`PINNED_TOKEN_SHA256 = "${BRIDGE_TOKEN_SHA256}"`));
  assert.match(src, /dbWrites: false/);
  assert.match(src, /deletes: false/);
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
  const fn = readFileSync(join(ROOT, 'supabase/functions/aws-staging-storage-bridge/index.ts'), 'utf8');
  assert.doesNotMatch(worker, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(fn, /createSignedUrl/);
  assert.doesNotMatch(fn, /\.remove\(|\.delete\(/);
});
