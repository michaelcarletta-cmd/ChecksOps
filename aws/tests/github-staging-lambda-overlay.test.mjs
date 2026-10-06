import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  validateExpectedMemberHash,
  validateRequestedMember,
  workflowIdentity,
} from '../../scripts/deployment-guard/github-staging-lambda-overlay.mjs';

const SHA='a'.repeat(40);

test('GitHub staging overlay accepts a normal Lambda member inside aws/functions/api',()=>{
  const result=validateRequestedMember('index.mjs');
  assert.equal(result.ok,true);
  assert.equal(result.details.member,'index.mjs');
  assert.equal(result.details.sourceRelative,'aws/functions/api/index.mjs');
});

test('GitHub staging overlay refuses traversal and missing members',()=>{
  assert.equal(validateRequestedMember('../index.mjs').ok,false);
  assert.equal(validateRequestedMember('definitely-missing.mjs').ok,false);
});

test('apply requires exact reviewed live member hash',()=>{
  const hash='b'.repeat(64);
  assert.equal(validateExpectedMemberHash(hash,hash).ok,true);
  const moved=validateExpectedMemberHash(hash,'c'.repeat(64));
  assert.equal(moved.ok,false);
  assert.equal(moved.code,'SOURCE_RECONCILIATION_REQUIRED');
  assert.equal(validateExpectedMemberHash(hash,'').ok,false);
});

test('workflow identity is pinned to main with complete GitHub identity',()=>{
  const identity=workflowIdentity({
    GITHUB_SHA:SHA,
    GITHUB_REF_NAME:'main',
    GITHUB_ACTOR:'operator',
    GITHUB_RUN_ID:'1234',
  });
  assert.equal(identity.commit,SHA);
  assert.equal(identity.branch,'main');
  assert.equal(identity.workstreamId,'github-staging-overlay-1234');
  assert.throws(()=>workflowIdentity({
    GITHUB_SHA:SHA,
    GITHUB_REF_NAME:'feature',
    GITHUB_ACTOR:'operator',
    GITHUB_RUN_ID:'1234',
  }),/only run from main/);
});
