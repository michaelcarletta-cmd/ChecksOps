import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  PRODUCTION_COGNITO_USER_POOL_ID,
  STAGING_COGNITO_USER_POOL_ID,
} from '../functions/api/identity-env.mjs';

// Target and recorded live document for the hand-made inline policy
// ApiFunctionRolePolicyClassA on checksops-staging-ApiFunctionRole-7E7XRyLe3nyi.
// See aws/staging-api/README.md.
const read = (rel) => JSON.parse(fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8'));
const TARGET = read('aws/staging-api/policies/class-a-policy.json');
const LIVE = read('aws/staging-api/policies/class-a-policy.live-2026-10-29.json');
const arr = (v) => (Array.isArray(v) ? v : [v]);
const poolArn = (id) => `arn:aws:cognito-idp:us-east-1:806168576068:userpool/${id}`;

const INVITE_ACTIONS = [
  'cognito-idp:AdminCreateUser',
  'cognito-idp:AdminDisableUser',
  'cognito-idp:AdminGetUser',
  'cognito-idp:AdminSetUserPassword',
];

const cognitoStatements = (doc) => doc.Statement.filter((s) => arr(s.Action).some((a) => a.startsWith('cognito-idp:')));

test('the staging API role keeps every invite action on the staging user pool', () => {
  const [invite, ...others] = cognitoStatements(TARGET);
  assert.equal(others.length, 0, 'one Cognito statement');
  assert.equal(invite.Sid, 'StagingCognitoAdminInvite');
  assert.equal(invite.Effect, 'Allow');
  assert.deepEqual(arr(invite.Action).sort(), INVITE_ACTIONS);
  assert.equal(invite.Resource, poolArn(STAGING_COGNITO_USER_POOL_ID));
});

test('the staging API role has no Cognito action on the production pool or on any pool wildcard', () => {
  for (const s of cognitoStatements(TARGET)) {
    for (const resource of arr(s.Resource)) {
      assert.doesNotMatch(resource, /\*/, `${s.Sid} names one pool`);
      assert.notEqual(resource, poolArn(PRODUCTION_COGNITO_USER_POOL_ID), s.Sid);
      assert.ok(!resource.includes(PRODUCTION_COGNITO_USER_POOL_ID), s.Sid);
    }
  }
  assert.ok(!JSON.stringify(TARGET).includes(PRODUCTION_COGNITO_USER_POOL_ID));
});

test('the recorded live policy is the one being fixed: Cognito invite actions on userpool/*', () => {
  const [invite] = cognitoStatements(LIVE);
  assert.equal(invite.Resource, 'arn:aws:cognito-idp:us-east-1:806168576068:userpool/*');
  assert.deepEqual(arr(invite.Action).sort(), INVITE_ACTIONS);
});

test('only the Cognito resource changes; SES, Textract and tenant OpenAI secret statements equal live', () => {
  const strip = (doc) => ({
    ...doc,
    Statement: doc.Statement.map((s) => (s.Sid === 'StagingCognitoAdminInvite' ? { ...s, Resource: null } : s)),
  });
  assert.deepEqual(strip(TARGET), strip(LIVE));
  assert.deepEqual(TARGET.Statement.map((s) => s.Sid), LIVE.Statement.map((s) => s.Sid));
});
