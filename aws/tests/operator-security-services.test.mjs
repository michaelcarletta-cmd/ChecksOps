import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pack = fs.readFileSync(path.join(ROOT, 'aws/cutover/OPERATOR_SECURITY_SERVICES.md'), 'utf8');
const trail = fs.readFileSync(path.join(ROOT, 'aws/production/security-monitoring.yaml'), 'utf8');

test('operator package lists six detection-only deployments and stops at #1', () => {
  assert.match(pack, /Deployment #1 — CloudTrail/);
  assert.match(pack, /aws\/production\/security-monitoring\.yaml/);
  assert.match(pack, /checksops-production-cloudtrail/);
  assert.match(pack, /IAM capability acknowledgement/);
  assert.match(pack, /Not required/);
  assert.match(pack, /Expected monthly cost/);
  assert.match(pack, /PASS verification/);
  assert.match(pack, /Rollback/);
  assert.match(pack, /security-alerts-sns\.yaml/);
  assert.match(pack, /security-config\.yaml/);
  assert.match(pack, /security-posture-services\.yaml/);
  assert.match(pack, /security-vpc-flow\.yaml/);
  assert.match(pack, /security-alarms\.yaml/);
  assert.match(pack, /STOP FOR OPERATOR DEPLOYMENT #1/);
  assert.match(pack, /Do not\*\* use or broaden `ChecksOpsCursorCloudStaging`/);
  assert.doesNotMatch(pack, /64_financial_activation_grants\.sql` stays \*\*APPLIED/);
  assert.match(pack, /64_financial_activation_grants\.sql` stays \*\*NOT_APPLIED/);
  assert.match(pack, /No application change/);
  assert.match(pack, /No[\s\S]*API-behind-CloudFront/);
});

test('deployment #1 template stays management-events only', () => {
  assert.match(trail, /AWS::CloudTrail::Trail/);
  assert.match(trail, /IncludeManagementEvents: true/);
  assert.doesNotMatch(trail, /DataResources:/);
  assert.doesNotMatch(trail, /AWS::IAM::Role/);
  assert.doesNotMatch(trail, /AWS_MOOV_ENABLED/);
});
