import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  EXPECTED_EIGHT,
  LIFECYCLE_EMAILS,
  NINTH_ID,
  PROBE_EMAIL,
  PROBE_SUB,
  TESTER_ID,
  jwtClaimsSafe,
  redactSecrets,
} from '../identity/expected-mappings.mjs';
import { NINTH_ID as ONESHOT_NINTH, PROBE_SUB as ONESHOT_PROBE } from '../identity/oneshot/onboard.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('activation targets only Freedom tester and C1C payments admin', () => {
  assert.equal(LIFECYCLE_EMAILS.freedom, 'checksops-tester@freedomadj.com');
  assert.equal(LIFECYCLE_EMAILS.c1c, 'payments@condition1commercial.com');
  assert.equal(EXPECTED_EIGHT.length, 8);
  assert.ok(!EXPECTED_EIGHT.some((row) => row.applicationUserId === NINTH_ID));
  assert.ok(!EXPECTED_EIGHT.some((row) => row.cognitoSub === PROBE_SUB));
  assert.ok(!Object.values(LIFECYCLE_EMAILS).includes(PROBE_EMAIL));
});

test('Freedom admin and tester Cognito subs stay distinct application UUIDs', () => {
  const admin = EXPECTED_EIGHT.find((row) => row.applicationUserId === '7dbb3009-f059-4767-b5dc-1c5c72379330');
  const tester = EXPECTED_EIGHT.find((row) => row.applicationUserId === TESTER_ID);
  assert.equal(admin.email, 'mcarletta@freedomadj.com');
  assert.equal(admin.cognitoSub, 'c4386408-60e1-70e2-abb6-e6194e8e635f');
  assert.equal(admin.appRole, 'admin');
  assert.equal(admin.tenantSlug, 'freedom');
  assert.equal(tester.email, 'checksops-tester@freedomadj.com');
  assert.equal(tester.cognitoSub, '04d85458-1041-7017-a8e8-b2f3f0a5b75b');
  assert.notEqual(admin.cognitoSub, tester.cognitoSub);
  assert.notEqual(admin.applicationUserId, tester.applicationUserId);
  assert.notEqual(admin.applicationUserId, admin.cognitoSub);
});

test('oneshot ninth and probe constants stay aligned', () => {
  assert.equal(ONESHOT_NINTH, NINTH_ID);
  assert.equal(ONESHOT_PROBE, PROBE_SUB);
});

test('login verify SQL is read-only', () => {
  const sql = fs.readFileSync(path.join(ROOT, 'identity/sql/10_login_verify.sql'), 'utf8');
  assert.doesNotMatch(sql, /^INSERT |^UPDATE |^DELETE /im);
  assert.match(sql, /FROM public\.identity_accounts/);
});

test('web client template enables USER_PASSWORD_AUTH without dropping SRP', () => {
  const yaml = fs.readFileSync(path.join(ROOT, 'template.yaml'), 'utf8');
  assert.match(yaml, /ALLOW_USER_PASSWORD_AUTH/);
  assert.match(yaml, /ALLOW_USER_SRP_AUTH/);
  assert.match(yaml, /ALLOW_REFRESH_TOKEN_AUTH/);
  assert.match(yaml, /ALLOW_ADMIN_USER_PASSWORD_AUTH/);
});

test('redactSecrets strips passwords, codes, and JWTs', () => {
  const redacted = redactSecrets({
    email: 'checksops-tester@freedomadj.com',
    password: 'SuperSecret1!',
    confirmationCode: '123456',
    AuthenticationResult: {
      IdToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.sig',
      AccessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIyIn0.sig',
      RefreshToken: 'secret-refresh',
    },
  });
  assert.equal(redacted.password, '[redacted]');
  assert.equal(redacted.confirmationCode, '[redacted]');
  assert.equal(redacted.AuthenticationResult.IdToken, '[redacted]');
  assert.equal(redacted.AuthenticationResult.RefreshToken, '[redacted]');
  assert.equal(redacted.email, 'checksops-tester@freedomadj.com');
  assert.equal(
    redactSecrets({ note: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.sig' }).note,
    '[redacted-jwt]',
  );
});

test('jwtClaimsSafe extracts sub without returning the raw token', () => {
  const payload = Buffer.from(JSON.stringify({
    sub: 'c4386408-60e1-70e2-abb6-e6194e8e635f',
    aud: '71bb7a192cbl6o6s8m259tl589',
    iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_vPmQ7cL1F',
    token_use: 'id',
    email: 'checksops-tester@freedomadj.com',
    exp: 1,
  })).toString('base64url');
  const claims = jwtClaimsSafe(`eyJhbGciOiJub25lIn0.${payload}.x`);
  assert.equal(claims.sub, 'c4386408-60e1-70e2-abb6-e6194e8e635f');
  assert.equal(claims.tokenUse, 'id');
  assert.equal(claims.aud, '71bb7a192cbl6o6s8m259tl589');
  assert.ok(!JSON.stringify(claims).includes('eyJhbGciOiJub25lIn0'));
});
