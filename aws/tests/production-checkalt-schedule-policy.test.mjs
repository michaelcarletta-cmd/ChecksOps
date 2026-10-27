import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  ROLE_ARN,
  SCHEDULE_NAME,
  STACK_NAME,
} from '../../scripts/deployment-guard/production-checkalt-schedule.mjs';

const read = (rel) => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const POLICY = JSON.parse(read('aws/production-lambda-overlay/policies/permissions-policy.json'));
const STACK_ARN = `arn:aws:cloudformation:us-east-1:806168576068:stack/${STACK_NAME}/*`;
const SCHEDULE_ARN = `arn:aws:scheduler:us-east-1:806168576068:schedule/default/${SCHEDULE_NAME}`;
const arr = (v) => (Array.isArray(v) ? v : [v]);

const statements = POLICY.Statement.filter((s) => arr(s.Action).some((a) => /^(cloudformation|iam|scheduler):/.test(a)));

test('the deploy role gains CloudFormation, IAM and Scheduler rights only on this stack, role and schedule', () => {
  const bySid = Object.fromEntries(statements.map((s) => [s.Sid, s]));
  assert.deepEqual(Object.keys(bySid).sort(), [
    'CreateExactCheckAltStatusScheduleRole',
    'CreateExactCheckAltStatusScheduleStack',
    'CreateUpdateExactCheckAltStatusSchedule',
    'InspectExactCheckAltStatusSchedule',
    'InspectExactCheckAltStatusScheduleRole',
    'InspectExactCheckAltStatusScheduleStack',
    'PassCheckAltStatusScheduleRoleToSchedulerOnly',
    'UpdateExactCheckAltStatusScheduleStack',
  ]);
  for (const s of statements) {
    assert.equal(s.Effect, 'Allow', s.Sid);
    assert.equal(typeof s.Resource, 'string', `${s.Sid} names one resource`);
    assert.doesNotMatch(s.Resource, /^\*$|:\*$/, s.Sid);
    for (const action of arr(s.Action)) {
      assert.doesNotMatch(action, /\*/, `${s.Sid} has no wildcard action`);
      const service = action.split(':')[0];
      const expected = { cloudformation: STACK_ARN, iam: ROLE_ARN, scheduler: SCHEDULE_ARN }[service];
      assert.equal(s.Resource, expected, `${s.Sid} ${action}`);
    }
  }
  const actions = statements.flatMap((s) => arr(s.Action)).sort();
  assert.deepEqual(actions, [
    'cloudformation:CreateStack',
    'cloudformation:DescribeStackEvents',
    'cloudformation:DescribeStackResources',
    'cloudformation:DescribeStacks',
    'cloudformation:GetTemplate',
    'cloudformation:UpdateStack',
    'iam:CreateRole',
    'iam:GetRole',
    'iam:GetRolePolicy',
    'iam:PassRole',
    'iam:PutRolePolicy',
    'iam:TagRole',
    'scheduler:CreateSchedule',
    'scheduler:GetSchedule',
    'scheduler:UpdateSchedule',
  ]);
  // No delete anywhere: a failed create stays for the owner to inspect.
  assert.equal(actions.some((a) => /Delete/.test(a)), false);
});

test('PassRole is limited to the scheduler service', () => {
  const pass = statements.find((s) => arr(s.Action).includes('iam:PassRole'));
  assert.deepEqual(arr(pass.Action), ['iam:PassRole']);
  assert.deepEqual(pass.Condition, { StringEquals: { 'iam:PassedToService': 'scheduler.amazonaws.com' } });
});

test('the stack, role and schedule names match the template', () => {
  const template = read('aws/production/checkalt-status-reconcile-schedule.yaml');
  assert.match(template, /RoleName: checksops-production-checkalt-status-schedule\n/);
  assert.match(template, /Name: checksops-production-checkalt-status-reconcile\n/);
  assert.match(template, /\(stack\n\s+checksops-production-checkalt-status-schedule\)/);
});

test('the runbook and the README document the one-time IAM step and the guarded workflow', () => {
  for (const rel of ['ops/checkalt-status-reconcile-schedule.md', 'ops/deployment-guard/README.md', 'aws/production-lambda-overlay/README.md']) {
    const doc = read(rel);
    assert.ok(doc.includes('guarded-production-checkalt-schedule.yml'), rel);
  }
  const runbook = read('ops/checkalt-status-reconcile-schedule.md');
  for (const phrase of ['CREATE CHECKALT STATUS SCHEDULE IN PRODUCTION', 'PAUSE CHECKALT STATUS SCHEDULE IN PRODUCTION', 'RESUME CHECKALT STATUS SCHEDULE IN PRODUCTION']) {
    assert.ok(runbook.includes(phrase), phrase);
  }
  assert.doesNotMatch(runbook, /has no guarded\s+CloudFormation workflow/);
});
