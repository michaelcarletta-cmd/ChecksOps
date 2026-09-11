import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  FINANCIAL_TOTP_ISSUER,
  FINANCIAL_TOTP_PREP,
  assertNoSecretLeak,
  bindFinancialStepUp,
  consumeFinancialTotpRateLimit,
  decryptSecret,
  encryptSecret,
  enrollmentResponseWithoutSecret,
  evaluateFinancialTotpEnrollment,
  generateTotpSecret,
  hotp,
  otpauthUri,
  timestepOf,
  totpAt,
  verifyFinancialTotp,
  wrapKeyFromHex,
} from '../functions/api/financial-totp.mjs';
import { CHECKALT_TOTP_ACTION, TOTP_STEPUP_TTL_MS } from '../functions/api/providers/production/checkalt-authz.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const USER = '7dbb3009-f059-4767-b5dc-1c5c72379330';
const TENANT = '11111111-1111-4111-8111-111111111111';
const CHECK = 'a3a4a153-46e1-4c28-a273-79a9bd04f3a6';

test('RFC 6238 SHA-1 8-digit vector at T=59', () => {
  const seed = Buffer.from('12345678901234567890');
  assert.equal(hotp(seed, 1, 8), '94287082');
});

test('AES-256-GCM uses a fresh nonce and rejects a tampered ciphertext', () => {
  const secret = generateTotpSecret();
  const key = wrapKeyFromHex('cd'.repeat(32));
  const first = encryptSecret(secret, key);
  const second = encryptSecret(secret, key);
  assert.equal(first.alg, 'aes-256-gcm');
  assert.equal(first.nonce.equals(second.nonce), false);
  assert.equal(first.ciphertext.equals(second.ciphertext), false);
  const tampered = Buffer.from(first.ciphertext);
  tampered[0] ^= 0xff;
  assert.throws(() => decryptSecret({ ciphertext: tampered, nonce: first.nonce, key }));
});

test('generated TOTP secrets are 160-bit base32 values', () => {
  const seen = new Set();
  for (let i = 0; i < 8; i += 1) {
    const secret = generateTotpSecret();
    assert.match(secret, /^[A-Z2-7]{32}$/);
    seen.add(secret);
  }
  assert.equal(seen.size, 8);
});

test('app-level TOTP encrypts at rest and never returns the secret after enrollment', () => {
  const secret = generateTotpSecret();
  const key = wrapKeyFromHex('ab'.repeat(32));
  const wrapped = encryptSecret(secret, key);
  assert.equal(wrapped.ciphertext.includes(Buffer.from(secret)), false);
  const plain = decryptSecret({ ciphertext: wrapped.ciphertext, nonce: wrapped.nonce, key });
  assert.equal(plain, secret);

  const status = enrollmentResponseWithoutSecret({ verifiedAt: new Date().toISOString() });
  assert.equal(status.totpEnrolled, true);
  assert.equal(status.issuer, FINANCIAL_TOTP_ISSUER);
  assert.doesNotMatch(JSON.stringify(status), new RegExp(secret));
  assert.equal(Object.prototype.hasOwnProperty.call(status, 'secret'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(status, 'ciphertext'), false);
  assertNoSecretLeak(status, secret);
});

test('verification is server-side, replay-resistant, and independent of Cognito login MFA', () => {
  const secret = generateTotpSecret();
  const now = Date.UTC(2026, 8, 11, 1, 0, 0);
  const step = timestepOf(now);
  const code = totpAt(secret, step);
  const first = verifyFinancialTotp({ secret, code, nowMs: now });
  assert.equal(first.ok, true);
  const replay = verifyFinancialTotp({
    secret,
    code,
    nowMs: now,
    lastUsedTimestep: first.timestep,
  });
  assert.equal(replay.ok, false);
  assert.equal(replay.error, 'totp_mismatch');

  const enrolled = evaluateFinancialTotpEnrollment({
    verifiedAt: '2026-09-11T00:00:00Z',
    userMfaSettingList: [],
    preferredMfaSetting: null,
  });
  const cognitoOnly = evaluateFinancialTotpEnrollment({
    verifiedAt: null,
    userMfaSettingList: ['SOFTWARE_TOKEN_MFA'],
    preferredMfaSetting: 'SOFTWARE_TOKEN_MFA',
  });
  assert.equal(enrolled.totpEnrolled, true);
  assert.equal(cognitoOnly.totpEnrolled, false);
  assert.equal(enrolled.source, 'financial_totp_enrollments');
});

test('invalid and expired-window codes fail closed without logging the secret', () => {
  const secret = generateTotpSecret();
  const now = Date.UTC(2026, 8, 11, 1, 0, 0);
  const far = verifyFinancialTotp({ secret, code: totpAt(secret, timestepOf(now) + 5), nowMs: now });
  assert.equal(far.ok, false);
  const bad = verifyFinancialTotp({ secret, code: '000000', nowMs: now });
  assert.equal(bad.ok, false);
  const payload = { error: bad.error, ok: false };
  assertNoSecretLeak(payload, secret);
});

test('successful step-up binds application user, tenant, action, resource, amount, and TTL', () => {
  const bound = bindFinancialStepUp({
    applicationUserId: USER,
    tenantId: TENANT,
    action: CHECKALT_TOTP_ACTION,
    resourceId: CHECK,
    amountCents: 1234,
  });
  assert.equal(bound.ok, true);
  assert.equal(bound.application_user_id, USER);
  assert.equal(bound.tenant_id, TENANT);
  assert.equal(bound.action_key, CHECKALT_TOTP_ACTION);
  assert.equal(bound.metadata.check_id, CHECK);
  assert.equal(bound.metadata.amount_cents, 1234);
  assert.equal(bound.ttl_ms, TOTP_STEPUP_TTL_MS);
  assert.equal(bound.metadata.source, 'app_financial_totp');
  assert.equal(bindFinancialStepUp({ applicationUserId: USER }).ok, false);
});

test('financial TOTP verify is rate limited', () => {
  const store = new Map();
  const now = 1_000_000;
  for (let i = 0; i < 5; i += 1) {
    const allowed = consumeFinancialTotpRateLimit(store, { userId: USER, action: 'step_up', nowMs: now });
    assert.equal(allowed.allowed, true);
  }
  const denied = consumeFinancialTotpRateLimit(store, { userId: USER, action: 'step_up', nowMs: now });
  assert.equal(denied.allowed, false);
  assert.equal(denied.error, 'rate_limited');
});

test('otpauth URI uses ChecksOps Financial issuer and is only for enroll-start', () => {
  const secret = generateTotpSecret();
  const uri = otpauthUri(secret, 'mcarletta@freedomadj.com');
  assert.match(uri, /^otpauth:\/\/totp\//);
  assert.match(uri, /ChecksOps%20Financial/);
  assert.match(uri, new RegExp(secret));
});

test('Cognito cannot export the software-token secret; app module never enables login MFA', () => {
  assert.equal(FINANCIAL_TOTP_PREP.secretExportableFromCognito, false);
  assert.equal(FINANCIAL_TOTP_PREP.cognitoLoginMfa, false);
  const source = fs.readFileSync(path.join(ROOT, 'aws/functions/api/financial-totp.mjs'), 'utf8');
  assert.doesNotMatch(source, /AWSCognitoIdentityProviderService|cognitoJson\(|cognito-idp\.us-east-1/);
  const mfa = fs.readFileSync(path.join(ROOT, 'aws/functions/api/auth-mfa.mjs'), 'utf8');
  const handlers = fs.readFileSync(path.join(ROOT, 'aws/functions/api/auth-financial-totp.mjs'), 'utf8');
  assert.doesNotMatch(mfa, /SetUserMFAPreference|AdminSetUserMFAPreference|AssociateSoftwareToken|VerifySoftwareToken/);
  assert.doesNotMatch(handlers, /SetUserMFAPreference|AdminSetUserMFAPreference|AssociateSoftwareToken|VerifySoftwareToken/);
  assert.match(handlers, /FINANCIAL_TOTP_WRAP_KEY_ARN/);
  assert.match(handlers, /encryptSecret/);
});

test('proposed financial TOTP SQL is not applied and keeps ciphertext off the generic data API', () => {
  const proposed = fs.readFileSync(
    path.join(ROOT, 'aws/migrations/proposed/NOT_APPLIED_20260911_financial_totp_enrollment.sql'),
    'utf8',
  );
  assert.match(proposed, /NOT APPLIED/);
  assert.match(proposed, /^BEGIN;/m);
  assert.match(proposed, /^COMMIT;/m);
  assert.match(proposed, /financial_totp_enrollments/);
  assert.match(proposed, /consume_financial_totp_rate_limit/);
  assert.match(proposed, /financial_totp_status/);
  assert.match(proposed, /RETURNS TABLE\(enrolled_at timestamptz, verified_at timestamptz\)/);
  assert.match(proposed, /SECURITY DEFINER/);
  assert.match(proposed, /OWNER TO checksops_admin/);
  assert.match(proposed, /REVOKE ALL ON TABLE public\.financial_totp_enrollments FROM checksops/);
  assert.match(proposed, /REVOKE ALL ON TABLE public\.financial_totp_enrollments FROM authenticated/);
  assert.doesNotMatch(proposed, /GRANT (SELECT|INSERT|UPDATE|DELETE) ON TABLE public\.financial_totp_enrollments/);
  assert.doesNotMatch(proposed, /GRANT ALL/);
  assert.doesNotMatch(proposed, /DROP TABLE/);
  assert.doesNotMatch(proposed, /DELETE FROM/);
  assert.doesNotMatch(proposed, /CREATE POLICY/);
  assert.match(proposed, /Never returns ciphertext/);
  assert.match(proposed, /verified_at IS NULL/);
  assert.match(proposed, /last_used_timestep IS DISTINCT FROM p_timestep/);
  assert.match(proposed, /SET search_path = public, pg_temp/);
  assert.match(proposed, /ALTER FUNCTION public\.financial_totp_status\(uuid\) OWNER TO checksops_admin/);
  const allowedTables = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'aws/functions/api/allowed-tables.json'),
    'utf8',
  ));
  assert.equal(allowedTables.includes('financial_totp_enrollments'), false);
  assert.equal(allowedTables.includes('financial_totp_rate_limits'), false);
  const allowlist = fs.readFileSync(path.join(ROOT, 'aws/functions/api/write-allowlist.mjs'), 'utf8');
  assert.doesNotMatch(allowlist, /financial_totp_enrollments/);
  assert.doesNotMatch(allowlist, /financial_totp_rate_limits/);
  const dataApi = fs.readFileSync(path.join(ROOT, 'aws/functions/api/data.mjs'), 'utf8');
  const workflowRpc = fs.readFileSync(path.join(ROOT, 'aws/functions/api/workflow-rpc.mjs'), 'utf8');
  assert.doesNotMatch(dataApi, /financial_totp_/);
  assert.doesNotMatch(workflowRpc, /financial_totp_/);
});
