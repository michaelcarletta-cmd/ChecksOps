import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { EXPECTED_DUAL_ENV_IDENTITIES, TESTER_ID } from '../identity/expected-mappings.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PIN = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/staging-freedom-identity-verify.json'), 'utf8'));

test('mcarletta EMAIL_OTP identity is BLOCKED for settlement UAT', () => {
  assert.equal(PIN.id, 'staging-freedom-identity-verify');
  assert.equal(PIN.verdict, 'BLOCKED');
  assert.equal(PIN.accepted_for_settlement_uat, false);
  assert.equal(PIN.auth_method, 'EMAIL_OTP');
  assert.equal(PIN.password_used, false);
  assert.equal(PIN.writes_attempted, false);
  assert.deepEqual(PIN.mutations, []);
});

test('required tester UUID does not match the live mapped user', () => {
  assert.equal(PIN.required.application_user_id, TESTER_ID);
  assert.equal(PIN.required.tenant_id, '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a');
  assert.equal(PIN.required.is_master_owner, false);
  assert.equal(PIN.actual.application_user_id, '7dbb3009-f059-4767-b5dc-1c5c72379330');
  assert.equal(PIN.match.application_user_id, false);
  assert.equal(PIN.match.freedom_tenant, true);
  assert.equal(PIN.match.is_master_owner_false, true);
  assert.equal(PIN.actual.cognito_sub, EXPECTED_DUAL_ENV_IDENTITIES[0].stagingCognitoSub);
  assert.equal(PIN.actual.application_user_id, EXPECTED_DUAL_ENV_IDENTITIES[0].applicationUserId);
  assert.notEqual(PIN.actual.application_user_id, TESTER_ID);
});
