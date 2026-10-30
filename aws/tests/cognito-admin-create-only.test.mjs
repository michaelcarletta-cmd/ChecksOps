/**
 * Self sign-up off on the Cognito pools (2026-10-30). The UpdateUserPool request built from each
 * pool's live DescribeUserPool snapshot sets AllowAdminCreateUserOnly and carries every other
 * mutable setting unchanged, so MFA, passkeys, email and sign-in factors survive the update.
 * Runbook: ops/deployment-guard/cognito-admin-create-only/README.md.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { NOT_UPDATABLE, buildAdminCreateOnlyUpdate } from '../../scripts/deployment-guard/lib/cognito-admin-create-only.mjs';

const DIR = 'ops/deployment-guard/cognito-admin-create-only';
const read = (rel) => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const POOLS = {
  staging: { id: 'us-east-1_vPmQ7cL1F', live: JSON.parse(read(`${DIR}/staging-pool.live-2026-10-30.json`)) },
  production: { id: 'us-east-1_h00WorYMT', live: JSON.parse(read(`${DIR}/production-pool.live-2026-10-30.json`)) },
};

for (const [env, { id, live }] of Object.entries(POOLS)) {
  test(`${env}: the live pool allows self sign-up today`, () => {
    assert.equal(live.UserPool.Id, id);
    assert.equal(live.UserPool.AdminCreateUserConfig.AllowAdminCreateUserOnly, false);
  });

  test(`${env}: the request turns self sign-up off and carries every other mutable setting unchanged`, () => {
    const pool = live.UserPool;
    const request = buildAdminCreateOnlyUpdate(pool);
    assert.equal(request.UserPoolId, id);
    assert.equal(request.AdminCreateUserConfig.AllowAdminCreateUserOnly, true);
    assert.equal('UnusedAccountValidityDays' in request.AdminCreateUserConfig, false);
    assert.equal(request.PoolName, pool.Name);
    for (const [key, value] of Object.entries(pool)) {
      if (NOT_UPDATABLE.includes(key) || key === 'Name' || key === 'UserPoolTags' || key === 'AdminCreateUserConfig') continue;
      assert.deepEqual(request[key], value, key);
    }
    // MFA, passkeys and sign-in factors stay as they are.
    assert.equal(request.MfaConfiguration, pool.MfaConfiguration);
    assert.deepEqual(request.Policies.SignInPolicy, pool.Policies.SignInPolicy);
    assert.deepEqual(request.Policies.PasswordPolicy, pool.Policies.PasswordPolicy);
    assert.deepEqual(request.EmailConfiguration, pool.EmailConfiguration);
    assert.deepEqual(request.AccountRecoverySetting, pool.AccountRecoverySetting);
    assert.equal(request.DeletionProtection, pool.DeletionProtection);
    // Tags are never sent: UserPoolTags would replace the whole set, system tags included.
    assert.equal('UserPoolTags' in request, false);
    for (const key of NOT_UPDATABLE) assert.equal(key in request, false, key);
    // The input is not modified.
    assert.equal(pool.AdminCreateUserConfig.AllowAdminCreateUserOnly, false);
  });
}

test('a pool with aws:* system tags gets a request without UserPoolTags (the 2026-10-30 production refusal)', () => {
  const pool = POOLS.production.live.UserPool;
  assert.ok(Object.keys(pool.UserPoolTags).some((key) => key.startsWith('aws:cloudformation:')));
  const request = buildAdminCreateOnlyUpdate(pool);
  assert.equal('UserPoolTags' in request, false);
  assert.equal(request.AdminCreateUserConfig.AllowAdminCreateUserOnly, true);
});

test('the builder refuses a non-pool input and a deprecated-only invite expiry', () => {
  assert.throws(() => buildAdminCreateOnlyUpdate({}));
  assert.throws(() => buildAdminCreateOnlyUpdate({ Id: 'x', Policies: {}, AdminCreateUserConfig: { UnusedAccountValidityDays: 7 } }));
});

test('the runbook applies staging first, production on the owner\'s words, verifies and rolls back', () => {
  const readme = read(`${DIR}/README.md`);
  assert.match(readme, /staging[\s\S]*first/i);
  assert.match(readme, /us-east-1_vPmQ7cL1F[\s\S]*us-east-1_h00WorYMT/);
  assert.match(readme, /## Rollback/);
  assert.match(readme, /get_user_pool_mfa_config|GetUserPoolMfaConfig/);
  assert.match(readme, /0 `SignUp`/);
  assert.match(readme, /SignUp is not permitted for this user pool/);
  assert.match(readme, /TagResource/);
});

test('the applied record names both runs, their approvals and the refused SignUp after each', () => {
  const readme = read(`${DIR}/README.md`);
  const applied = readme.slice(readme.indexOf('## Applied (2026-10-30)'));
  assert.ok(applied.startsWith('## Applied (2026-10-30)'));
  assert.match(applied, /"apply sign-up off to staging"/);
  assert.match(applied, /"re-apply\s+sign-up off to production"/);
  assert.match(applied, /52a47e82-c283-40f4-a025-d0ea50dde684/);
  assert.match(applied, /fa434eae-815d-434f-8d74-2ef70848afb3/);
  assert.equal(applied.match(/SignUp is not permitted for this user pool/g).length, 2);
});
