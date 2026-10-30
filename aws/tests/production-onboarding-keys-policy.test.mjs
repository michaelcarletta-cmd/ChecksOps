import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { ALIAS_NAMES, STACK_NAME, TAG_KEY } from '../../scripts/deployment-guard/production-onboarding-keys.mjs';

const read = (rel) => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const POLICY = JSON.parse(read('aws/production-lambda-overlay/policies/permissions-policy.json'));
const STACK_ARN = `arn:aws:cloudformation:us-east-1:806168576068:stack/${STACK_NAME}/*`;
const KEY_ARNS = 'arn:aws:kms:us-east-1:806168576068:key/*';
const ALIAS_ARNS = ALIAS_NAMES.map((a) => `arn:aws:kms:us-east-1:806168576068:${a}`);
const VIA_CFN = { 'ForAnyValue:StringEquals': { 'aws:CalledVia': 'cloudformation.amazonaws.com' } };
const arr = (v) => (Array.isArray(v) ? v : [v]);

const statements = POLICY.Statement.filter((s) => /OnboardingKey/.test(s.Sid));
const bySid = Object.fromEntries(statements.map((s) => [s.Sid, s]));

test('the deploy role gains exactly these onboarding keys statements', () => {
  assert.deepEqual(Object.keys(bySid).sort(), [
    'AliasTaggedOnboardingKeysThroughCloudFormation',
    'CreateExactOnboardingKeyAliasesThroughCloudFormation',
    'CreateExactOnboardingKeysStack',
    'CreateOnboardingKeysThroughCloudFormation',
    'InspectExactOnboardingKeysStack',
    'InspectTaggedOnboardingKeys',
    'ListKmsAliasesForOnboardingKeys',
    'SetUpNewOnboardingKeysThroughCloudFormation',
  ]);
  for (const s of statements) {
    assert.equal(s.Effect, 'Allow', s.Sid);
    for (const action of arr(s.Action)) assert.doesNotMatch(action, /\*/, `${s.Sid} has no wildcard action`);
  }
  const actions = statements.flatMap((s) => arr(s.Action)).sort();
  assert.deepEqual(actions, [
    'cloudformation:CreateStack',
    'cloudformation:DescribeStackEvents',
    'cloudformation:DescribeStackResources',
    'cloudformation:DescribeStacks',
    'cloudformation:GetTemplate',
    'kms:CreateAlias',
    'kms:CreateAlias',
    'kms:CreateKey',
    'kms:DescribeKey',
    'kms:EnableKeyRotation',
    'kms:GetKeyPolicy',
    'kms:GetKeyRotationStatus',
    'kms:ListAliases',
    'kms:ListResourceTags',
    'kms:PutKeyPolicy',
    'kms:TagResource',
  ]);
});

test('no delete, update, disable, grant, cryptographic or stack-update right anywhere in the deploy role', () => {
  const all = POLICY.Statement.filter((s) => s.Effect === 'Allow').flatMap((s) => arr(s.Action));
  for (const forbidden of [
    'kms:ScheduleKeyDeletion', 'kms:DeleteAlias', 'kms:UpdateAlias', 'kms:DisableKey', 'kms:DisableKeyRotation',
    'kms:CreateGrant', 'kms:UntagResource', 'kms:Encrypt', 'kms:Decrypt', 'kms:GenerateDataKey', 'kms:ReEncryptFrom',
    'cloudformation:DeleteStack', 'cloudformation:CreateChangeSet', 'cloudformation:ExecuteChangeSet',
  ]) {
    assert.equal(all.includes(forbidden), false, forbidden);
  }
  assert.equal(all.some((a) => /^kms:.*Delet/.test(a)), false);
  // The onboarding keys stack is create-only: no UpdateStack on it.
  const update = POLICY.Statement.filter((s) => arr(s.Action).includes('cloudformation:UpdateStack'));
  for (const s of update) assert.doesNotMatch(s.Resource, /onboarding-keys/, s.Sid);
});

test('CloudFormation rights name only this stack', () => {
  for (const sid of ['InspectExactOnboardingKeysStack', 'CreateExactOnboardingKeysStack']) {
    assert.equal(bySid[sid].Resource, STACK_ARN, sid);
    assert.equal(bySid[sid].Condition, undefined, sid);
  }
});

test('kms:CreateKey is account-bound, symmetric, tagged for this stack, through CloudFormation, with the lockout check kept', () => {
  const s = bySid.CreateOnboardingKeysThroughCloudFormation;
  assert.deepEqual(arr(s.Action), ['kms:CreateKey']);
  assert.equal(s.Resource, '*', 'CreateKey has no resource ARN before the key exists');
  assert.deepEqual(s.Condition, {
    StringEquals: {
      'kms:CallerAccount': '806168576068',
      'kms:KeySpec': 'SYMMETRIC_DEFAULT',
      'kms:KeyUsage': 'ENCRYPT_DECRYPT',
      [`aws:RequestTag/${TAG_KEY}`]: STACK_NAME,
    },
    ...VIA_CFN,
    BoolIfExists: { 'kms:BypassPolicyLockoutSafetyCheck': 'false', 'kms:MultiRegion': 'false' },
  });
});

test('key policy, tag and rotation writes only on keys tagged for this stack, through CloudFormation', () => {
  const s = bySid.SetUpNewOnboardingKeysThroughCloudFormation;
  assert.deepEqual(arr(s.Action).sort(), ['kms:EnableKeyRotation', 'kms:PutKeyPolicy', 'kms:TagResource']);
  assert.equal(s.Resource, KEY_ARNS);
  assert.deepEqual(s.Condition, {
    StringEquals: { 'kms:CallerAccount': '806168576068', [`aws:ResourceTag/${TAG_KEY}`]: STACK_NAME },
    ...VIA_CFN,
    BoolIfExists: { 'kms:BypassPolicyLockoutSafetyCheck': 'false' },
  });
});

test('CreateAlias: only the two alias names, and only onto a key tagged for this stack, through CloudFormation', () => {
  const aliases = bySid.CreateExactOnboardingKeyAliasesThroughCloudFormation;
  assert.deepEqual(arr(aliases.Action), ['kms:CreateAlias']);
  assert.deepEqual(arr(aliases.Resource), ALIAS_ARNS);
  assert.deepEqual(aliases.Condition, { StringEquals: { 'kms:CallerAccount': '806168576068' }, ...VIA_CFN });
  const keys = bySid.AliasTaggedOnboardingKeysThroughCloudFormation;
  assert.deepEqual(arr(keys.Action), ['kms:CreateAlias']);
  assert.equal(keys.Resource, KEY_ARNS);
  assert.deepEqual(keys.Condition, { StringEquals: { 'kms:CallerAccount': '806168576068', [`aws:ResourceTag/${TAG_KEY}`]: STACK_NAME }, ...VIA_CFN });
});

test('inspect and verify reads: only keys tagged for this stack; ListAliases has no resource ARN', () => {
  const s = bySid.InspectTaggedOnboardingKeys;
  assert.deepEqual(arr(s.Action).sort(), ['kms:DescribeKey', 'kms:GetKeyPolicy', 'kms:GetKeyRotationStatus', 'kms:ListResourceTags']);
  assert.equal(s.Resource, KEY_ARNS);
  assert.deepEqual(s.Condition, { StringEquals: { [`aws:ResourceTag/${TAG_KEY}`]: STACK_NAME } });
  const list = bySid.ListKmsAliasesForOnboardingKeys;
  assert.deepEqual(arr(list.Action), ['kms:ListAliases']);
  assert.equal(list.Resource, '*');
  // Only CreateKey and ListAliases use Resource "*".
  for (const st of statements) {
    if (arr(st.Resource).includes('*')) assert.ok(['CreateOnboardingKeysThroughCloudFormation', 'ListKmsAliasesForOnboardingKeys'].includes(st.Sid), st.Sid);
  }
});

test('the template sets the tag the conditions require, on both keys, and no IAM resource', () => {
  const template = read('aws/production/onboarding-keys.yaml');
  const tags = template.match(/ {8}- Key: checksops-stack\n {10}Value: checksops-production-onboarding-keys\n/g) || [];
  assert.equal(tags.length, 2);
  assert.doesNotMatch(template, /AWS::IAM::|AWS::S3::|AWS::Lambda::/);
  for (const alias of ALIAS_NAMES) assert.match(template, new RegExp(`AliasName: ${alias}\\n`));
});

test('the runbook and the READMEs document the one-time IAM step and the guarded workflow', () => {
  for (const rel of ['ops/production-onboarding-keys.md', 'ops/deployment-guard/README.md', 'aws/production-lambda-overlay/README.md']) {
    assert.ok(read(rel).includes('guarded-production-onboarding-keys.yml'), rel);
  }
  const runbook = read('ops/production-onboarding-keys.md');
  assert.ok(runbook.includes('CREATE ONBOARDING KEYS IN PRODUCTION'));
  for (const sid of Object.keys(bySid)) assert.ok(runbook.includes(sid), sid);
  for (const variable of ['COMPLIANCE_DOCUMENTS_KMS_KEY_ARN', 'MOOV_ONBOARDING_PII_KMS_KEY_ARN', 'guarded-production-lambda-config.yml', 'document_storage_unavailable']) {
    assert.ok(runbook.includes(variable), variable);
  }
});
