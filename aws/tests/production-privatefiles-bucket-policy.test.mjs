import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const policy = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'aws/production/privatefiles-bucket-policy.json'),
  'utf8',
));
const yaml = fs.readFileSync(path.join(ROOT, 'aws/production/api-execution-role.yaml'), 'utf8');

const PROD_ROLE = 'arn:aws:iam::806168576068:role/checksops-production-api-execution';
const STAGING_ROLE = 'arn:aws:iam::806168576068:role/checksops-staging-ApiFunctionRole-7E7XRyLe3nyi';
const BUCKET = 'arn:aws:s3:::checksops-production-privatefiles-806168576068';
const OBJECTS = `${BUCKET}/*`;

const bySid = Object.fromEntries((policy.Statement || []).map((s) => [s.Sid, s]));

test('production privatefiles bucket policy keeps E7 read/sign and denies the staging API role', () => {
  assert.equal(policy.Version, '2012-10-17');
  const deny = bySid.DenyStagingApiRole;
  assert.equal(deny.Effect, 'Deny');
  assert.equal(deny.Principal.AWS, STAGING_ROLE);
  assert.equal(deny.Action, 's3:*');
  assert.deepEqual(deny.Resource, [BUCKET, OBJECTS]);

  const read = bySid.E7AllowPrepApiReadSign;
  assert.equal(read.Effect, 'Allow');
  assert.equal(read.Principal.AWS, PROD_ROLE);
  for (const action of ['s3:GetObject', 's3:GetObjectVersion', 's3:GetBucketLocation', 's3:ListBucket']) {
    assert.ok(read.Action.includes(action), action);
  }
  assert.ok(!read.Action.includes('s3:PutObject'));
});

test('production privatefiles bucket policy grants Admin Tools object write to the production API role', () => {
  const write = bySid.E14AAllowPrepApiObjectWrite;
  assert.ok(write, 'E14AAllowPrepApiObjectWrite statement required');
  assert.equal(write.Effect, 'Allow');
  assert.equal(write.Principal.AWS, PROD_ROLE);
  for (const action of ['s3:PutObject', 's3:DeleteObject', 's3:DeleteObjectVersion', 's3:AbortMultipartUpload']) {
    assert.ok(write.Action.includes(action), action);
  }
  assert.deepEqual(write.Resource, [OBJECTS]);
  assert.ok(!write.Action.includes('s3:*'));
  assert.ok(!JSON.stringify(policy).includes('checksops-staging-privatefilesbucket'));
});

test('production API execution role template documents the live production files bucket', () => {
  assert.match(yaml, /checksops-production-privatefiles-806168576068/);
  assert.match(yaml, /privatefiles-bucket-policy\.json/);
});
