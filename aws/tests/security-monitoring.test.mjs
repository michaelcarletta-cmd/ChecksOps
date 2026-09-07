import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const yaml = fs.readFileSync(path.join(ROOT, 'aws/production/security-monitoring.yaml'), 'utf8');
const sns = fs.readFileSync(path.join(ROOT, 'aws/production/security-alerts-sns.yaml'), 'utf8');
const posture = fs.readFileSync(path.join(ROOT, 'aws/production/security-posture-services.yaml'), 'utf8');
const playbook = fs.readFileSync(path.join(ROOT, 'aws/cutover/INCIDENT_RESPONSE_AWS.md'), 'utf8');
const legacy = fs.readFileSync(path.join(ROOT, 'docs/INCIDENT_RESPONSE.md'), 'utf8');

test('security monitoring template is detection-only and does not block traffic', () => {
  assert.match(posture, /AWS::GuardDuty::Detector/);
  assert.match(posture, /AWS::SecurityHub::Hub/);
  assert.match(posture, /EBS_MALWARE_PROTECTION/);
  assert.match(posture, /Status: DISABLED/);
  assert.match(yaml, /AWS::Config::ConfigurationRecorder/);
  assert.match(yaml, /AWS::CloudTrail::Trail/);
  assert.match(yaml, /AWS::EC2::FlowLog/);
  assert.match(yaml, /IncludeManagementEvents: true/);
  assert.match(yaml, /TreatMissingData: notBreaching/);
  assert.match(yaml, /checksops-production-security-alerts/);
  assert.match(yaml, /PrepHttp5xx/);
  assert.match(yaml, /PrepAuthFailures/);
  assert.match(yaml, /IamSecurityChanges/);
  assert.match(yaml, /HasAlertTopic/);
  assert.doesNotMatch(yaml, /SecurityAlertsTopic/);
  assert.doesNotMatch(yaml, /AWS::SNS::Topic/);
  assert.match(sns, /AWS::SNS::Topic/);
  assert.match(sns, /checksops-production-security-alerts/);
  assert.doesNotMatch(yaml, /AWS_MOOV_ENABLED|AWS_CHECKALT_ENABLED|AWS_FINANCIAL_PERMISSIONS_ACTIVATED/);
  assert.doesNotMatch(yaml, /64_financial_activation/);
  assert.doesNotMatch(yaml, /Action:\s*\n\s*Block:/);
  assert.doesNotMatch(yaml, /DataResources:/);
});

test('AWS incident playbook replaces Supabase containment and keeps providers off', () => {
  assert.match(playbook, /Credential compromise/);
  assert.match(playbook, /Database compromise/);
  assert.match(playbook, /S3 \/ check-image exposure/);
  assert.match(playbook, /Cognito \/ account takeover/);
  assert.match(playbook, /WAF \/ DDoS \/ API abuse/);
  assert.match(playbook, /Provider \/ payment compromise/);
  assert.match(playbook, /Backup \/ PITR/);
  assert.match(playbook, /35 days/);
  assert.match(playbook, /MUST FIX before financial activation/);
  assert.doesNotMatch(playbook, /ai_gateway--rotate_lovable_api_key/);
  assert.match(legacy, /INCIDENT_RESPONSE_AWS/);
  assert.match(legacy, /providers stay OFF/);
});
