/**
 * Finding 11 (closed 2026-10-30): the GitHub OIDC deploy roles trust only their own environment of
 * this repository, none can change IAM, and the guarded workflows run only from main. The GitHub
 * environment protection (owner the only reviewer, main only, no admin bypass) is recorded in the
 * README. Runbook: ops/deployment-guard/github-oidc-trust/README.md.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const DIR = 'ops/deployment-guard/github-oidc-trust';
const read = (rel) => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const LIVE = JSON.parse(read(`${DIR}/github-oidc-roles.live-2026-10-30.json`));
const ENVIRONMENTS = {
  ChecksOpsGitHubProductionLambdaOverlay: 'production',
  ChecksOpsGitHubProductionReadOnlyInspect: 'production-readonly',
  ChecksOpsGitHubStagingLambdaOverlay: 'staging',
};

test('each GitHub OIDC role trusts only its own environment of this repository', () => {
  assert.deepEqual(Object.keys(LIVE.roles).sort(), Object.keys(ENVIRONMENTS).sort());
  for (const [role, env] of Object.entries(ENVIRONMENTS)) {
    const statements = LIVE.roles[role].trust.Statement;
    assert.equal(statements.length, 1, role);
    const [statement] = statements;
    assert.equal(statement.Effect, 'Allow', role);
    assert.equal(statement.Action, 'sts:AssumeRoleWithWebIdentity', role);
    assert.match(statement.Principal.Federated, /oidc-provider\/token\.actions\.githubusercontent\.com$/, role);
    assert.deepEqual(statement.Condition, {
      StringEquals: {
        'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        'token.actions.githubusercontent.com:sub': `repo:michaelcarletta-cmd/ChecksOps:environment:${env}`,
      },
    }, role);
  }
});

test('no GitHub OIDC role can change IAM or schedules, and the read-only role cannot read secret values', () => {
  for (const [role, details] of Object.entries(LIVE.roles)) {
    assert.deepEqual(details.attached_policies, [], role);
    assert.equal(details.permissions_boundary ?? null, null, role);
    for (const action of details.inline_actions) {
      assert.equal(/^(iam|scheduler|sts|organizations):|^\*$/.test(action), false, `${role} ${action}`);
    }
  }
  assert.equal(LIVE.roles.ChecksOpsGitHubProductionReadOnlyInspect.inline_actions.includes('secretsmanager:GetSecretValue'), false);
});

test('the guarded workflows refuse any ref but main', () => {
  for (const workflow of ['guarded-production-lambda-overlay.yml', 'guarded-staging-lambda-overlay.yml', 'inspect-production-readonly.yml']) {
    assert.match(read(`.github/workflows/${workflow}`), /test "\$GITHUB_REF" = "refs\/heads\/main"/, workflow);
  }
});

test('the record names the owner\'s environment settings and closes the finding', () => {
  const readme = read(`${DIR}/README.md`);
  assert.match(readme, /Required reviewers is only me/);
  assert.match(readme, /It's set to selected only main/);
  assert.match(readme, /It's unchecked now/);
  assert.match(readme, /finding 11, closed/);
});
