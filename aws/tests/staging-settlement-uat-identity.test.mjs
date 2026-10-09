import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { EXPECTED_DUAL_ENV_IDENTITIES, EXPECTED_EIGHT, TESTER_ID } from '../identity/expected-mappings.mjs';
import { LOOKUP_MAPPING_SQL } from '../functions/api/identity-env.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PIN = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/staging-settlement-uat-identity.json'), 'utf8'));

test('identity investigation is read-only NO-GO for Freedom settlement UAT', () => {
  assert.equal(PIN.id, 'staging-settlement-uat-identity');
  assert.equal(PIN.verdict, 'NO-GO');
  assert.equal(PIN.freedom_only_uat_can_proceed, false);
  assert.equal(PIN.writes_attempted, false);
  assert.equal(PIN.cognito_user_changes, false);
  assert.equal(PIN.mapping_changes, false);
  assert.deepEqual(PIN.mutations, []);
  assert.equal(PIN.c1c_gated_separately, true);
});

test('verified claims@ identity is not a safe settlement UAT actor', () => {
  assert.equal(PIN.verified_identity.email, 'claims@freedomadj.com');
  assert.equal(PIN.verified_identity.application_user_id, 'b100f05d-9e81-4a7b-b9cc-9baf173131d9');
  assert.equal(PIN.verified_identity.is_master_owner, false);
  assert.deepEqual(PIN.verified_identity.roles, ['mortgage_agent']);
  assert.deepEqual(PIN.verified_identity.tenants, []);
  assert.equal(PIN.verified_identity.safe_for_settlement_uat, false);
  const historicalClaims = EXPECTED_EIGHT.find((row) => row.email === 'claims@freedomadj.com');
  assert.equal(historicalClaims.applicationUserId, PIN.verified_identity.application_user_id);
  assert.notEqual(historicalClaims.cognitoSub, PIN.verified_identity.cognito_sub);
});

test('historical tester sub now belongs to mcarletta@ and lookup is by sub', () => {
  assert.equal(PIN.correct_uat_actor.application_user_id, TESTER_ID);
  assert.equal(PIN.correct_uat_actor.live_verified_this_turn, false);
  assert.equal(PIN.live_cognito['mcarletta@freedomadj.com'].sub, 'c4386408-60e1-70e2-abb6-e6194e8e635f');
  assert.equal(PIN.live_cognito['checksops-tester@freedomadj.com'].sub, '04d85458-1041-7017-a8e8-b2f3f0a5b75b');
  const historicalTester = EXPECTED_EIGHT.find((row) => row.email === 'checksops-tester@freedomadj.com');
  assert.equal(historicalTester.cognitoSub, 'c4386408-60e1-70e2-abb6-e6194e8e635f');
  assert.equal(EXPECTED_DUAL_ENV_IDENTITIES[0].email, 'mcarletta@freedomadj.com');
  assert.equal(EXPECTED_DUAL_ENV_IDENTITIES[0].stagingCognitoSub, 'c4386408-60e1-70e2-abb6-e6194e8e635f');
  assert.match(LOOKUP_MAPPING_SQL, /WHERE cognito_sub = \$1/);
  assert.doesNotMatch(LOOKUP_MAPPING_SQL, /WHERE[\s\S]*\bemail\b/i);
  assert.ok(PIN.safe_auth_procedure[0].includes('/auth/passwordless'));
  assert.ok(PIN.safe_auth_procedure.some((row) => row.includes('Do not use staging-master@checksops.invalid')));
});
