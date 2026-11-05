/**
 * Team two-factor reset IAM (ops/team-two-factor-reset-iam.md): each API role gets a new inline policy
 * granting exactly the two Cognito actions admin-reset-totp.mjs calls and the roles lack, on exactly that
 * environment's user pool. Static.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  PRODUCTION_COGNITO_USER_POOL_ID,
  STAGING_COGNITO_USER_POOL_ID,
} from '../functions/api/identity-env.mjs';

const text = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const json = (rel) => JSON.parse(text(rel));
const poolArn = (id) => `arn:aws:cognito-idp:us-east-1:806168576068:userpool/${id}`;
const ACTIONS = ['cognito-idp:AdminSetUserMFAPreference', 'cognito-idp:AdminUserGlobalSignOut'];
const RUNBOOK = text('ops/team-two-factor-reset-iam.md');
const ENVS = {
  staging: { role: 'checksops-staging-ApiFunctionRole-7E7XRyLe3nyi', pool: STAGING_COGNITO_USER_POOL_ID, other: PRODUCTION_COGNITO_USER_POOL_ID },
  production: { role: 'checksops-production-api-execution', pool: PRODUCTION_COGNITO_USER_POOL_ID, other: STAGING_COGNITO_USER_POOL_ID },
};

test('1 admin-reset-totp.mjs calls exactly the granted actions beyond AdminGetUser', () => {
  const src = text('aws/functions/api/admin-reset-totp.mjs');
  const called = [...src.matchAll(/new (Admin[A-Za-z]+)Command\(/g)].map((m) => `cognito-idp:${m[1]}`).sort();
  assert.deepEqual([...new Set(called)], ['cognito-idp:AdminGetUser', ...ACTIONS].sort());
});

for (const [env, { role, pool, other }] of Object.entries(ENVS)) {
  test(`2 ${env}: one Allow statement, exactly the two actions, exactly this pool`, () => {
    const doc = json(`ops/team-two-factor-reset-iam/${env}-after.json`);
    assert.equal(doc.Version, '2012-10-17');
    assert.equal(doc.Statement.length, 1);
    const [s] = doc.Statement;
    assert.equal(s.Effect, 'Allow');
    assert.deepEqual([...s.Action].sort(), ACTIONS);
    assert.equal(s.Resource, poolArn(pool));
    assert.notEqual(s.Resource, poolArn(other));
    assert.doesNotMatch(JSON.stringify(doc), /\*/);
    assert.equal(s.Condition, undefined);
  });

  test(`3 ${env}: the recorded before state has no such policy and both actions denied`, () => {
    const before = json(`ops/team-two-factor-reset-iam/${env}-before-2026-11-04.json`);
    assert.equal(before.role, role);
    assert.equal(before.user_pool_arn, poolArn(pool));
    assert.equal(before.policy_TeamTwoFactorResetCognito, 'absent');
    assert.ok(!before.inline_policy_names.includes('TeamTwoFactorResetCognito'));
    for (const a of ACTIONS) assert.equal(before.simulate[a], 'implicitDeny', a);
  });

  test(`4 ${env}: the runbook refuses if the policy exists, applies this file, reads it back and simulates`, () => {
    const section = RUNBOOK.slice(RUNBOOK.indexOf(`ROLE=${role}`));
    const block = section.slice(0, section.indexOf("'\n```"));
    assert.match(RUNBOOK, /bash -euo pipefail -c/);
    assert.match(block, new RegExp(`POOL=${poolArn(pool).replaceAll('/', '\\/')}`));
    assert.match(block, /STOP: TeamTwoFactorResetCognito already exists/);
    assert.ok(block.includes(`--policy-name TeamTwoFactorResetCognito --policy-document file://ops/team-two-factor-reset-iam/${env}-after.json`));
    assert.ok(block.includes(`python3 -m json.tool --sort-keys ops/team-two-factor-reset-iam/${env}-after.json`));
    assert.match(block, /LIVE MATCHES AFTER/);
    assert.match(block, /simulate-principal-policy[\s\S]*cognito-idp:AdminSetUserMFAPreference cognito-idp:AdminUserGlobalSignOut/);
    assert.ok(RUNBOOK.includes(`aws iam delete-role-policy --role-name ${role} --policy-name TeamTwoFactorResetCognito`));
  });
}

test('5 staging comes first; the runbook records nothing applied yet', () => {
  assert.ok(RUNBOOK.indexOf('## Staging (first)') < RUNBOOK.indexOf('## Production (a separate owner step'));
  assert.match(RUNBOOK, /\*\*Status:\*\* not applied anywhere\./);
});
