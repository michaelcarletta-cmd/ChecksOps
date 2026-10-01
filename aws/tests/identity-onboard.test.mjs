import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { NINTH_ID, PROBE_SUB, TESTER_ID } from '../identity/oneshot/onboard.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'identity');

test('clear-isolated-test SQL only unlinks the Tester mapping', () => {
  const sql = fs.readFileSync(path.join(ROOT, 'sql/09_clear_isolated_test.sql'), 'utf8');
  assert.match(sql, /status = 'isolated_test'/);
  assert.match(sql, new RegExp(TESTER_ID));
  assert.doesNotMatch(sql, /DELETE FROM public\.(profiles|tenant_users|user_roles)/i);
  assert.doesNotMatch(sql, new RegExp(NINTH_ID));
});

test('reconcile SQL does not invent emails and excludes writes', () => {
  const sql = fs.readFileSync(path.join(ROOT, 'sql/08_reconcile_known_users.sql'), 'utf8');
  assert.match(sql, /FROM public\.profiles/);
  assert.doesNotMatch(sql, /^INSERT |^UPDATE |^DELETE /im);
  assert.doesNotMatch(sql, new RegExp(NINTH_ID));
});

test('probe sub is not treated as an application UUID', () => {
  assert.notEqual(PROBE_SUB, TESTER_ID);
  assert.notEqual(PROBE_SUB, NINTH_ID);
});

test('isolated staging test-tenant onboarding uses tenant-invite-user, not Freedom remaps', () => {
  const invite = fs.readFileSync(path.join(ROOT, '../functions/api/tenant-admin.mjs'), 'utf8');
  const lookup = fs.readFileSync(path.join(ROOT, '../functions/api/identity-env.mjs'), 'utf8');
  const expected = fs.readFileSync(path.join(ROOT, 'expected-mappings.mjs'), 'utf8');
  assert.match(invite, /export const runTenantInviteUser/);
  assert.match(invite, /AdminCreateUser/);
  assert.match(invite, /INSERT INTO public\.identity_accounts/);
  assert.match(invite, /INSERT INTO public\.tenant_users/);
  assert.match(invite, /refusing identity mapping where application_user_id equals cognito_sub|unsafe_or_missing_cognito_sub/);
  assert.match(lookup, /status IN \('active', 'isolated_test'\)/);
  assert.match(expected, /EXPECTED_DUAL_ENV_IDENTITIES/);
  assert.doesNotMatch(invite, /FREEDOM_TENANT = '2eff5f1a/);
});
