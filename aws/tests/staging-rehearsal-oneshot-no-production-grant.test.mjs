import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// Target and recorded live inline policies of checksops-staging-rehearsal-oneshot.
// See aws/staging-rehearsal-oneshot/README.md.
const read = (rel) => JSON.parse(fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8'));
const TARGET = read('aws/staging-rehearsal-oneshot/policies/inline-policies.json');
const LIVE = read('aws/staging-rehearsal-oneshot/policies/inline-policies.live-2026-10-29.json');
const arr = (v) => (Array.isArray(v) ? v : [v]);
const REMOVED = 'ChecksOpsP6PromoteTemp';

const STAGING_ADMIN_SECRET = 'arn:aws:secretsmanager:us-east-1:806168576068:secret:rds-db-credentials/checksops-staging/checksops_admin/1788286368527-Kv5tBt';
const STAGING_BUCKET = 'arn:aws:s3:::checksops-staging-privatefilesbucket-erzqsolpucjp';

const allows = (policies, action, resource) => Object.values(policies).some((doc) => doc.Statement.some((s) => (
  s.Effect === 'Allow' && arr(s.Action).includes(action) && arr(s.Resource).includes(resource)
)));

test('the recorded live role reads the production admin secret and production Migration/ objects through ChecksOpsP6PromoteTemp only', () => {
  const p6 = LIVE[REMOVED];
  assert.ok(p6, 'recorded');
  const resources = p6.Statement.flatMap((s) => arr(s.Resource));
  assert.ok(resources.includes('arn:aws:secretsmanager:us-east-1:806168576068:secret:rds-db-credentials/checksops-production/checksops_admin/*'));
  assert.ok(resources.includes('arn:aws:s3:::checksops-production-privatefiles-806168576068/Migration/*'));
  const others = Object.entries(LIVE).filter(([name]) => name !== REMOVED);
  assert.ok(others.every(([, doc]) => !JSON.stringify(doc).includes('production')), 'no other policy names production');
});

test('the target removes ChecksOpsP6PromoteTemp and keeps every other policy byte-equal to live', () => {
  assert.deepEqual(Object.keys(TARGET).sort(), Object.keys(LIVE).filter((n) => n !== REMOVED).sort());
  for (const [name, doc] of Object.entries(TARGET)) assert.deepEqual(doc, LIVE[name], name);
});

test('the target grants nothing on production', () => {
  assert.doesNotMatch(JSON.stringify(TARGET), /production/);
});

test('the staging rehearsal keeps its staging admin secret and staging Migration/ access', () => {
  assert.ok(allows(TARGET, 'secretsmanager:GetSecretValue', STAGING_ADMIN_SECRET));
  for (const action of ['s3:GetObject', 's3:PutObject']) {
    assert.ok(allows(TARGET, action, `${STAGING_BUCKET}/Migration/*`), action);
  }
  assert.ok(allows(TARGET, 's3:ListBucket', STAGING_BUCKET));
});
