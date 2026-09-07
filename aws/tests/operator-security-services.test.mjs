import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pack = fs.readFileSync(path.join(ROOT, 'aws/cutover/OPERATOR_SECURITY_SERVICES.md'), 'utf8');
const trail = fs.readFileSync(path.join(ROOT, 'aws/production/security-monitoring.yaml'), 'utf8');
const config = fs.readFileSync(path.join(ROOT, 'aws/production/security-config.yaml'), 'utf8');
const configRole = fs.readFileSync(path.join(ROOT, 'aws/production/security-config-role.yaml'), 'utf8');
const tempRole = fs.readFileSync(path.join(ROOT, 'aws/production/cursor-security-hardening-role.yaml'), 'utf8');
const tempPerms = fs.readFileSync(path.join(ROOT, 'aws/production/cursor-security-hardening-role-permissions.json'), 'utf8');

test('operator package lists six detection-only deployments and stops at the temp role', () => {
  assert.match(pack, /Deployment #1 — CloudTrail/);
  assert.match(pack, /checksops-production-mgmt-events/);
  assert.match(pack, /create-trail/);
  assert.match(pack, /Do not\*\* use CloudFormation for this step/);
  assert.match(pack, /Expected monthly cost/);
  assert.match(pack, /PASS verification/);
  assert.match(pack, /Rollback/);
  assert.match(pack, /security-alerts-sns\.yaml/);
  assert.match(pack, /security-config\.yaml/);
  assert.match(pack, /security-posture-services\.yaml/);
  assert.match(pack, /security-vpc-flow\.yaml/);
  assert.match(pack, /security-alarms\.yaml/);
  assert.match(pack, /Deployment #1 \(CloudTrail\):\*\* \*\*PASS/);
  assert.match(pack, /STOP FOR REVIEW — #3 Config correction prepared/);
  assert.match(pack, /ChecksOpsCursorSecurityHardeningTemp/);
  assert.match(pack, /OPERATOR_TEMPORARY_ROLE\.md/);
  assert.match(pack, /Do not\*\* use or broaden/);
  assert.match(pack, /ChecksOpsCursorCloudStaging/);
  assert.match(pack, /64_financial_activation_grants\.sql` stays \*\*NOT_APPLIED/);
  assert.match(pack, /No application change/);
  assert.match(pack, /would delete the bucket/);
  assert.doesNotMatch(pack, /aws cloudtrail start-logging[\\s\\S]*checksops-production-management/);
});

test('deployment #1 template stays management-events only', () => {
  assert.match(trail, /AWS::CloudTrail::Trail/);
  assert.match(trail, /IncludeManagementEvents: true/);
  assert.doesNotMatch(trail, /DataResources:/);
  assert.doesNotMatch(trail, /AWS::IAM::Role/);
  assert.doesNotMatch(trail, /AWS_MOOV_ENABLED/);
});

test('deployment #3 Config correction uses new names and does not collide', () => {
  assert.match(config, /Name: checksops-production-config-items/);
  assert.match(config, /S3KeyPrefix: config/);
  assert.match(config, /AllSupported: true/);
  assert.match(config, /IncludeGlobalResourceTypes: true/);
  assert.match(config, /DependsOn: ConfigRecorder/);
  assert.doesNotMatch(config, /DependsOn: ConfigDeliveryChannel/);
  assert.match(
    config,
    /arn:aws:iam::806168576068:role\/checksops-production-config-items-recorder/,
  );
  assert.doesNotMatch(config, /Name: checksops-production$/m);
  assert.doesNotMatch(config, /checksops-production-config-recorder/);
  assert.doesNotMatch(config, /AWS::IAM::Role/);
  assert.doesNotMatch(config, /PutRemediation|AWS::Config::RemediationConfiguration/);
  assert.doesNotMatch(config, /AWS_MOOV_ENABLED|AWS_FINANCIAL_PERMISSIONS_ACTIVATED/);
  assert.doesNotMatch(config, /Type: AWS::S3::Bucket|Type: AWS::CloudTrail::Trail/);

  assert.match(configRole, /RoleName: checksops-production-config-items-recorder/);
  assert.match(configRole, /Service: config\.amazonaws.com/);
  assert.match(configRole, /service-role\/AWS_ConfigRole/);
  assert.match(configRole, /s3:PutObject/);
  assert.match(configRole, /\/config\/\*/);
  assert.match(configRole, /checksops-production-security-logs-806168576068/);
  assert.doesNotMatch(configRole, /PutRemediation|sns:Publish|ssm:SendCommand/);
  assert.doesNotMatch(configRole, /Type: AWS::S3::Bucket|Type: AWS::Config::ConfigurationRecorder/);
  assert.doesNotMatch(configRole, /AWS_MOOV_ENABLED/);

  assert.match(pack, /checksops-production-config-items/);
  assert.match(pack, /checksops-production-config-items-recorder/);
  assert.match(pack, /security-config-role\.yaml/);
  assert.match(pack, /Do not recreate this name/);
  assert.match(pack, /stop-configuration-recorder/);
  assert.doesNotMatch(pack, /aws cloudformation delete-stack[\\s\\S]*checksops-production-security-trail/);

  assert.match(tempRole, /checksops-production-config-items-recorder/);
  assert.match(tempPerms, /checksops-production-config-items-recorder/);
  assert.doesNotMatch(tempRole, /checksops-production-config-recorder"/);
  assert.doesNotMatch(tempPerms, /checksops-production-config-recorder"/);
});
