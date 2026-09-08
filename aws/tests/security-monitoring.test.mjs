import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const yaml = fs.readFileSync(path.join(ROOT, 'aws/production/security-monitoring.yaml'), 'utf8');
const alarms = fs.readFileSync(path.join(ROOT, 'aws/production/security-alarms.yaml'), 'utf8');
const sns = fs.readFileSync(path.join(ROOT, 'aws/production/security-alerts-sns.yaml'), 'utf8');
const posture = fs.readFileSync(path.join(ROOT, 'aws/production/security-posture-services.yaml'), 'utf8');
const flow = fs.readFileSync(path.join(ROOT, 'aws/production/security-vpc-flow.yaml'), 'utf8');
const config = fs.readFileSync(path.join(ROOT, 'aws/production/security-config.yaml'), 'utf8');
const playbook = fs.readFileSync(path.join(ROOT, 'aws/cutover/INCIDENT_RESPONSE_AWS.md'), 'utf8');
const legacy = fs.readFileSync(path.join(ROOT, 'docs/INCIDENT_RESPONSE.md'), 'utf8');

test('security monitoring template is detection-only and does not block traffic', () => {
  assert.match(posture, /AWS::GuardDuty::Detector/);
  assert.match(posture, /AWS::SecurityHub::Hub/);
  assert.match(posture, /EBS_MALWARE_PROTECTION/);
  assert.match(posture, /Status: DISABLED/);
  assert.match(config, /AWS::Config::ConfigurationRecorder/);
  assert.match(yaml, /AWS::CloudTrail::Trail/);
  assert.match(flow, /AWS::EC2::FlowLog/);
  assert.match(yaml, /IncludeManagementEvents: true/);
  assert.match(alarms, /IamSecurityChanges/);
  assert.match(yaml, /checksops-production-security-alerts/);
  assert.doesNotMatch(yaml, /AWS::CloudWatch::Alarm/);
  assert.doesNotMatch(yaml, /SecurityAlertsTopic/);
  assert.doesNotMatch(yaml, /AWS::SNS::Topic/);
  assert.match(alarms, /TreatMissingData: notBreaching/);
  assert.match(alarms, /PrepHttp5xx/);
  assert.match(alarms, /PrepAuthFailures/);
  assert.match(alarms, /HasAlertTopic/);
  assert.match(alarms, /AWS::CloudWatch::Alarm/);
  assert.match(sns, /AWS::SNS::Topic/);
  assert.match(sns, /checksops-production-security-alerts/);
  assert.match(sns, /CreateEmailSubscription/);
  assert.match(sns, /ShouldCreateEmailSubscription/);
  assert.match(
    sns,
    /AlertTopic:\s*\n\s*Type: AWS::SNS::Topic\s*\n\s*Properties:/,
  );
  assert.match(
    sns,
    /AlertSubscription:\s*\n\s*Type: AWS::SNS::Subscription\s*\n\s*Condition: ShouldCreateEmailSubscription/,
  );
  assert.match(sns, /Protocol: email/);
  assert.match(sns, /Endpoint: !Ref AlertEmail/);
  assert.match(sns, /Default: security@checksops\.com/);
  assert.match(sns, /TemporaryAlertSubscription:/);
  assert.match(sns, /Endpoint: !Ref TemporaryAlertEmail/);
  assert.match(sns, /Default: support@checksops\.com/);
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
