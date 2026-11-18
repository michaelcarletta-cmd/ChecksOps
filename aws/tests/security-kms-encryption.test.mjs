import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const kms = read('aws/production/security-kms.yaml');
const sns = read('aws/production/security-alerts-sns.yaml');
const runbook = read('aws/cutover/OPERATOR_SECURITY_KMS_ENCRYPTION.md');

test('security KMS template creates one retained, rotating key and nothing else', () => {
  const types = [...kms.matchAll(/^\s+Type: (AWS::\S+)/gm)].map((m) => m[1]);
  assert.deepEqual(types, ['AWS::KMS::Key', 'AWS::KMS::Alias']);
  assert.match(kms, /EnableKeyRotation: true/);
  assert.match(kms, /DeletionPolicy: Retain/);
  assert.match(kms, /UpdateReplacePolicy: Retain/);
  assert.match(kms, /AliasName: alias\/checksops-production-security-monitoring/);
});

test('key policy lets only this account, its alarms and the existing trail use the key', () => {
  const principals = [...kms.matchAll(/^\s+(AWS|Service): (.+)$/gm)].map((m) => `${m[1]}=${m[2]}`);
  assert.deepEqual(principals, [
    "AWS=!Sub 'arn:aws:iam::${AWS::AccountId}:root'",
    'Service=cloudwatch.amazonaws.com',
    'Service=cloudtrail.amazonaws.com',
    'Service=cloudtrail.amazonaws.com',
  ]);
  assert.doesNotMatch(kms, /AWS: ['"]?\*/);
  // Every service statement is bound to this account's alarms or to the one trail.
  assert.match(kms, /aws:SourceAccount: !Ref AWS::AccountId/);
  assert.match(kms, /aws:SourceArn: !Sub 'arn:aws:cloudwatch:\$\{AWS::Region\}:\$\{AWS::AccountId\}:alarm:\*'/);
  assert.equal(
    kms.match(/aws:SourceArn: !Sub 'arn:aws:cloudtrail:\$\{AWS::Region\}:\$\{AWS::AccountId\}:trail\/\$\{TrailName\}'/g)?.length,
    2,
  );
  assert.match(kms, /Default: checksops-production-mgmt-events/);
  // CloudWatch needs both actions to publish to an encrypted topic.
  assert.match(kms, /Service: cloudwatch\.amazonaws\.com\s+Action:\s+- kms:Decrypt\s+- kms:GenerateDataKey\*/);
});

test('SNS topic encryption is opt-in and leaves the topic and subscriptions as they were', () => {
  assert.match(sns, /AlertTopicKmsKeyArn:\s*\n\s*Type: String\s*\n\s*Default: ''/);
  assert.match(sns, /HasAlertTopicKmsKey: !Not \[!Equals \[!Ref AlertTopicKmsKeyArn, ''\]\]/);
  assert.match(
    sns,
    /KmsMasterKeyId: !If\s*\n\s*- HasAlertTopicKmsKey\s*\n\s*- !Ref AlertTopicKmsKeyArn\s*\n\s*- !Ref AWS::NoValue/,
  );
  assert.match(sns, /TopicName: checksops-production-security-alerts/);
  assert.doesNotMatch(sns, /KmsMasterKeyId: alias\/aws\/sns/);
});

test('runbook is proposed, ordered, and requires a delivery test and rollback', () => {
  assert.match(runbook, /\*\*Status:\*\* PROPOSED\. Nothing in this runbook has been applied\./);
  const steps = ['## Step 1: create the key', '## Step 2: encrypt the SNS topic', '## Step 3: encrypt CloudTrail log files'];
  const positions = steps.map((heading) => runbook.indexOf(heading));
  assert.ok(positions.every((p) => p >= 0));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
  assert.match(runbook, /set-alarm-state/);
  assert.match(runbook, /Replacement: False/);
  assert.match(runbook, /update-trail[\s\S]*--name checksops-production-mgmt-events/);
  assert.equal(runbook.match(/^Rollback:/gm)?.length, 3);
  assert.match(runbook, /do \*\*not\*\* touch the\s+stacks `checksops-production-cloudtrail` or\s+`checksops-production-security-trail`/);
});
