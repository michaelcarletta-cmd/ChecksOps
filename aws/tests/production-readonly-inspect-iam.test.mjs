import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { buildAwsArgs } from '../../scripts/deployment-guard/production-readonly-inspect.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EVIDENCE = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'ops/deployment-guard/production-readonly-inspect-iam.json'),
  'utf8',
));
const POLICY = JSON.parse(fs.readFileSync(
  path.join(ROOT, EVIDENCE.proposed_policy_path),
  'utf8',
));
const WORKFLOW = fs.readFileSync(
  path.join(ROOT, '.github/workflows/inspect-production-readonly.yml'),
  'utf8',
);
const INSPECTOR = fs.readFileSync(
  path.join(ROOT, 'scripts/deployment-guard/production-readonly-inspect.mjs'),
  'utf8',
);

const FORBIDDEN = [
  'ec2:AuthorizeSecurityGroupIngress',
  'ec2:RevokeSecurityGroupIngress',
  'ec2:CreateSecurityGroup',
  'ec2:DeleteSecurityGroup',
  'ec2:ModifySecurityGroupRules',
  'secretsmanager:GetSecretValue',
  'ssm:GetParameter',
  'rds-db:connect',
];

test('PR #853 is recorded on main and the evidence package stays evaluate-only', () => {
  assert.equal(EVIDENCE.merged_inspector.pr, 853);
  assert.equal(EVIDENCE.merged_inspector.present_on_origin_main, true);
  assert.equal(EVIDENCE.merged_inspector.merge_commit_sha, '1097ece82f24863440634ddf061fe884f2156add');
  assert.equal(EVIDENCE.merged_inspector.merged, true);
  assert.match(INSPECTOR, /observedIngressSecurityGroupIds/);
  assert.match(INSPECTOR, /exclusive-security-group-ingress/);
  let hasOriginMain = false;
  try {
    execFileSync('git', ['rev-parse', '--verify', 'origin/main'], { cwd: ROOT, stdio: 'ignore' });
    hasOriginMain = true;
  } catch {
    hasOriginMain = false;
  }
  if (hasOriginMain) {
    const merge = execFileSync('git', ['log', '-1', '--format=%H %s', 'origin/main'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    assert.match(merge, /1097ece82f24863440634ddf061fe884f2156add|Merge pull request #853/);
  }
  assert.equal(EVIDENCE.apply_authorized, false);
  assert.equal(EVIDENCE.dispatch_authorized, false);
  assert.equal(EVIDENCE.iam_mutation_authorized, false);
  assert.equal(EVIDENCE.verdict.apply, 'NO-GO');
  assert.equal(EVIDENCE.verdict.dispatch_official_inspect, 'NO-GO');
  assert.equal(EVIDENCE.verdict.prep, 'GO');
  assert.equal(EVIDENCE.verdict.preflight, 'NO-GO');
  assert.equal(EVIDENCE.verdict.broaden_staging, 'NO-GO');
  assert.equal(EVIDENCE.smallest_safe_change.necessary, 'unknown');
  assert.equal(EVIDENCE.smallest_safe_change.safe_without_owner_inventory, false);
});

test('proposed identity policy is only additive DescribeSecurityGroups', () => {
  assert.equal(EVIDENCE.target_role_arn, 'arn:aws:iam::806168576068:role/ChecksOpsGitHubProductionReadOnlyInspect');
  assert.equal(EVIDENCE.required_permission, 'ec2:DescribeSecurityGroups');
  assert.deepEqual(POLICY, {
    Version: '2012-10-17',
    Statement: [{
      Sid: 'DescribeObservedSecurityGroupsOnly',
      Effect: 'Allow',
      Action: 'ec2:DescribeSecurityGroups',
      Resource: '*',
    }],
  });
  const actions = POLICY.Statement.flatMap((statement) => [].concat(statement.Action));
  for (const action of FORBIDDEN) {
    assert.equal(actions.includes(action), false, action);
  }
  assert.equal(EVIDENCE.smallest_safe_change.kind, 'additive_inline_policy');
  assert.equal(EVIDENCE.smallest_safe_change.preserve_trust_policy, true);
  assert.equal(EVIDENCE.smallest_safe_change.do_not_replace_unknown_existing_policy_document, true);
  assert.equal(EVIDENCE.owner_apply_after_separate_approval.authorized_in_this_package, false);
  assert.match(EVIDENCE.rollback.command, /delete-role-policy/);
  assert.match(EVIDENCE.rollback.command, /ChecksOpsProductionReadOnlyInspectDescribeSecurityGroups/);
  assert.equal(EVIDENCE.rollback.do_not_delete_other_policies, true);
});

test('merged inspector only describes previously observed approved GroupIds', () => {
  assert.match(INSPECTOR, /observedIngressSecurityGroupIds/);
  assert.match(INSPECTOR, /--group-ids/);
  assert.doesNotMatch(INSPECTOR, /--filters|--group-names|AuthorizeSecurityGroup|GetSecretValue/);
  const args = buildAwsArgs('ec2:DescribeSecurityGroups', {
    groupIds: ['sg-0bc4695a666baf49b', 'sg-0fe2698f236959353'],
  });
  assert.deepEqual(args.slice(0, 2), ['ec2', 'describe-security-groups']);
  assert.ok(args.includes('--group-ids'));
  assert.equal(args.includes('--filters'), false);
  assert.equal(args.at(-1).includes('CidrIp'), false);
  assert.throws(() => buildAwsArgs('ec2:DescribeSecurityGroups', { filters: [] }));
  assert.throws(() => buildAwsArgs('ec2:DescribeSecurityGroups', { groupNames: ['production'] }));
  assert.throws(() => buildAwsArgs('ec2:AuthorizeSecurityGroupIngress', {
    groupIds: ['sg-0bc4695a666baf49b'],
  }));
});

test('workflow session policy already allows the read and still forbids mutation', () => {
  const policy = JSON.parse(WORKFLOW.match(/inline-session-policy: >-\n\s+(\{[^\n]+\})/)[1]);
  assert.ok(policy.Statement.some((statement) => (
    statement.Effect === 'Allow'
    && statement.Action.includes('ec2:DescribeSecurityGroups')
    && statement.Resource === '*'
  )));
  assert.doesNotMatch(WORKFLOW, /ec2:(?:Authorize|Revoke|Create|Delete|Modify)|secretsmanager:GetSecretValue|ssm:GetParameter/i);
});

test('this package does not apply IAM or dispatch the official inspector', () => {
  const policyText = fs.readFileSync(path.join(ROOT, EVIDENCE.proposed_policy_path), 'utf8');
  const testText = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  assert.doesNotMatch(policyText, /put-role-policy|attach-role-policy|GetSecretValue|AuthorizeSecurityGroup/i);
  assert.equal(testText.includes(['gh', 'workflow', 'run', 'inspect-production-readonly.yml'].join(' ')), false);
  assert.equal(EVIDENCE.owner_apply_after_separate_approval.authorized_in_this_package, false);
  assert.equal(EVIDENCE.live_iam_read.existing_grant_of_describe_security_groups, 'unknown');
  assert.equal(EVIDENCE.live_iam_read.get_role, 'AccessDenied');
  assert.equal(EVIDENCE.live_iam_read.get_role_policy_proposed_name, 'AccessDenied');
  assert.equal(EVIDENCE.live_iam_read.proposed_inline_policy_exists, 'unknown');
  assert.equal(EVIDENCE.live_iam_read.trust_policy_verified, false);
  assert.equal(EVIDENCE.live_iam_read.mutations_attempted, false);
  assert.equal(EVIDENCE.live_iam_read.staging_permissions_changed, false);
  assert.equal(EVIDENCE.authorized_read_identities.in_this_environment[0].can_read_inspect_role, false);
  assert.equal(EVIDENCE.authorized_read_identities.in_this_environment[0].broadened, false);
  assert.ok(EVIDENCE.owner_preflight_before_apply.some((item) => String(item).includes('simulate-principal-policy')));
  assert.ok(EVIDENCE.owner_preflight_before_apply.some((item) => String(item).includes(EVIDENCE.proposed_inline_policy_name)));
});
