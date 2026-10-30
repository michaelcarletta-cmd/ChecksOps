import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  PRODUCTION_COGNITO_USER_POOL_ID,
  STAGING_COGNITO_USER_POOL_ID,
} from '../functions/api/identity-env.mjs';

// Target and recorded live document for the inline policy ChecksOpsDenyProduction on
// ChecksOpsCursorCloudStaging. See aws/cursor-cloud-staging/README.md.
const read = (rel) => JSON.parse(fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8'));
const TARGET = read('aws/cursor-cloud-staging/policies/deny-production.json');
const LIVE = read('aws/cursor-cloud-staging/policies/deny-production.live-2026-10-29.json');
const arr = (v) => (Array.isArray(v) ? v : [v]);
const poolArn = (id) => `arn:aws:cognito-idp:us-east-1:806168576068:userpool/${id}`;

test('the Cursor staging role is denied every Cognito action on the production pool', () => {
  const s = TARGET.Statement.find((x) => x.Sid === 'DenyProductionUserPool');
  assert.ok(s, 'DenyProductionUserPool present');
  assert.equal(s.Effect, 'Deny');
  assert.deepEqual(arr(s.Action), ['cognito-idp:*']);
  assert.deepEqual(arr(s.Resource), [poolArn(PRODUCTION_COGNITO_USER_POOL_ID)]);
  assert.equal(s.Condition, undefined, 'unconditional');
});

test('the staging pool is not denied', () => {
  for (const s of TARGET.Statement) {
    for (const resource of arr(s.Resource)) {
      assert.ok(!resource.includes(STAGING_COGNITO_USER_POOL_ID), s.Sid);
      assert.doesNotMatch(resource, /cognito-idp:.*userpool\/\*/, `${s.Sid} names one pool`);
    }
  }
});

test('the recorded live policy has no Cognito deny: the gap being closed', () => {
  assert.ok(!LIVE.Statement.some((s) => arr(s.Action).some((a) => a.startsWith('cognito-idp:'))));
});

// The staging role boundary change (aws/tests/cursor-cloud-staging-role-boundary.test.mjs) later added
// its own statements after this one; they are left out of this comparison.
const BOUNDARY_SIDS = ['DenyRoleWritesWithoutStagingBoundary', 'DenyRemovingStagingBoundary', 'DenyEditingStagingBoundaryPolicy'];

test('only the new statement is added; every existing deny equals live', () => {
  const { Statement, ...rest } = TARGET;
  const { Statement: liveStatements, ...liveRest } = LIVE;
  assert.deepEqual(rest, liveRest);
  const ownStatements = Statement.filter((s) => !BOUNDARY_SIDS.includes(s.Sid));
  assert.deepEqual(ownStatements.filter((s) => s.Sid !== 'DenyProductionUserPool'), liveStatements);
  assert.equal(ownStatements.length, liveStatements.length + 1);
  assert.ok(Statement.every((s) => s.Effect === 'Deny'));
});
