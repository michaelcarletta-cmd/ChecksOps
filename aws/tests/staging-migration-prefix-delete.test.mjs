/**
 * Finding 5 (2026-10-30): delete every version of the production data copies under Migration/ in
 * the staging files bucket, and nothing else. The DeleteObjects requests are built from the
 * reviewed snapshot; the production bucket, other prefixes (the compliance uploads under files/)
 * and a drifted live listing are refused.
 * Runbook: ops/deployment-guard/staging-migration-prefix-delete/README.md.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { MAX_PER_REQUEST, PREFIX, STAGING_BUCKET, buildDeleteRequests, diffListing } from '../../scripts/deployment-guard/lib/s3-prefix-version-delete.mjs';

const DIR = 'ops/deployment-guard/staging-migration-prefix-delete';
const read = (rel) => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const SNAPSHOT = JSON.parse(read(`${DIR}/staging-migration-prefix.live-2026-10-30.json`));
const clone = (value) => JSON.parse(JSON.stringify(value));

test('the snapshot is the staging bucket\'s Migration/ prefix, versioned, with the production dump and rehearsal exports', () => {
  assert.equal(SNAPSHOT.bucket, STAGING_BUCKET);
  assert.equal(SNAPSHOT.prefix, PREFIX);
  assert.equal(SNAPSHOT.versioning, 'Enabled');
  assert.equal(SNAPSHOT.versions.length, 657);
  assert.equal(SNAPSHOT.versions.filter((v) => v.IsLatest).length, 169);
  assert.equal(SNAPSHOT.delete_markers.length, 0);
  const keys = new Set(SNAPSHOT.versions.map((v) => v.Key));
  assert.ok(keys.has('Migration/checksops_260901(1).backup'));
  assert.ok([...keys].some((k) => k.startsWith('Migration/rehearsal-20260905/delta/')));
  for (const key of keys) assert.ok(key.startsWith(PREFIX), key);
});

test('the requests delete every snapshot version by Key and VersionId, in batches DeleteObjects accepts', () => {
  const requests = buildDeleteRequests(SNAPSHOT);
  const objects = requests.flatMap((r) => r.Delete.Objects);
  for (const request of requests) {
    assert.equal(request.Bucket, STAGING_BUCKET);
    assert.ok(request.Delete.Objects.length <= MAX_PER_REQUEST);
    assert.equal(request.Delete.Quiet, false);
  }
  assert.equal(objects.length, SNAPSHOT.versions.length);
  assert.deepEqual(
    objects.map((o) => `${o.Key} ${o.VersionId}`).sort(),
    SNAPSHOT.versions.map((v) => `${v.Key} ${v.VersionId}`).sort(),
  );
  for (const object of objects) assert.deepEqual(Object.keys(object).sort(), ['Key', 'VersionId']);
  // Nothing outside Migration/: the compliance uploads and every other staging file stay.
  for (const object of objects) assert.equal(object.Key.startsWith('files/'), false, object.Key);
});

test('the production bucket, another prefix, a key outside Migration/ and a missing VersionId are refused', () => {
  assert.throws(() => buildDeleteRequests({ ...clone(SNAPSHOT), bucket: 'checksops-production-privatefiles-806168576068' }), /bucket must be/);
  assert.throws(() => buildDeleteRequests({ ...clone(SNAPSHOT), prefix: 'files/' }), /prefix must be/);
  const outside = clone(SNAPSHOT);
  outside.versions[0].Key = 'files/verification-docs/uploads/w9.pdf';
  assert.throws(() => buildDeleteRequests(outside), /key outside Migration\//);
  const noVersion = clone(SNAPSHOT);
  delete noVersion.versions[0].VersionId;
  assert.throws(() => buildDeleteRequests(noVersion), /missing VersionId/);
});

test('the live listing must equal the snapshot: a new, missing or changed version stops the delete', () => {
  assert.equal(diffListing(SNAPSHOT, clone(SNAPSHOT)).equal, true);
  const extra = clone(SNAPSHOT);
  extra.versions.push({ Key: 'Migration/new.json', VersionId: 'v-new', IsLatest: true, Size: 1, ETag: 'e', LastModified: '2026-10-30T00:00:00Z' });
  assert.deepEqual(diffListing(SNAPSHOT, extra).extra.length, 1);
  const missing = clone(SNAPSHOT);
  missing.versions.pop();
  assert.equal(diffListing(SNAPSHOT, missing).missing.length, 1);
  const changed = clone(SNAPSHOT);
  changed.versions[0].ETag = 'different';
  assert.equal(diffListing(SNAPSHOT, changed).changed.length, 1);
  const marker = clone(SNAPSHOT);
  marker.delete_markers.push({ Key: SNAPSHOT.versions[0].Key, VersionId: 'marker-1', IsLatest: true, LastModified: '2026-10-30T00:00:00Z' });
  assert.equal(diffListing(SNAPSHOT, marker).equal, false);
});

test('the runbook deletes only on the owner\'s approval, verifies an empty prefix and says there is no rollback', () => {
  const readme = read(`${DIR}/README.md`);
  assert.match(readme, /Finding 5 - delete it/);
  assert.match(readme, /## Apply \(only on the owner's approval of this run\)/);
  assert.match(readme, /## Verify after apply/);
  assert.match(readme, /no rollback/i);
  assert.match(readme, /checksops-production-privatefiles-806168576068/);
});

test('the delete is recorded: owner approval, the request, and an empty prefix afterwards', () => {
  const readme = read(`${DIR}/README.md`);
  assert.match(readme, /## Applied \(2026-10-30\)/);
  assert.match(readme, /Owner approval, verbatim: "delete finding 5"/);
  assert.match(readme, /request\s+`0P525DJ0GK8C56QC`: 657 deleted, `Errors` \[\]/);
  assert.match(readme, /returns 0 versions and 0 delete markers/);
  assert.match(readme, /d39f7425d23ebb0cfee902c90459f62f00019bd4e07c5e9fe9e9bcbfcd716829/);
});
