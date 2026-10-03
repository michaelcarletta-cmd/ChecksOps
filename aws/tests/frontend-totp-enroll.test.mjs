import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  buildTotpOtpauthUri,
  resolveTotpOtpauthUri,
  totpQrDataUrl,
} from '../../src/lib/totpQr.ts';
import { awsTotpEnrollmentDisplay } from '../../src/lib/totpEnrollment.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RFC_TEST_SECRET = 'GEZDGNBVGY3TQOJQ';

test('Account Security AWS enroll is wired to associate + local QR + verify', () => {
  const card = fs.readFileSync(path.join(ROOT, 'src/components/auth/TotpManagerCard.tsx'), 'utf8');
  const mfa = fs.readFileSync(path.join(ROOT, 'src/lib/awsMfa.ts'), 'utf8');
  assert.match(mfa, /\/auth\/mfa\/associate/);
  assert.match(mfa, /accessToken: session\.accessToken/);
  assert.match(mfa, /otpauth_uri/);
  assert.match(card, /associateAwsTotp/);
  assert.match(card, /totpQrDataUrl/);
  assert.match(card, /TotpQrDisplay/);
  assert.match(card, /verifyAwsTotp/);
  assert.match(card, /awsTotpEnrollmentDisplay/);
  assert.match(card, /getAwsMfaStatus/);
  assert.match(card, /useEffect\(\(\) => \{\s*void load\(\);/);
  assert.match(card, /enrolled === false && !awsQr && !awsSecret/);
  assert.doesNotMatch(card, /localStorage|sessionStorage/);
  assert.doesNotMatch(mfa, /localStorage\.setItem/);
  assert.doesNotMatch(card, /gtag|posthog|mixpanel|analytics/);
  assert.doesNotMatch(card, /catch \{[\s\S]{0,80}setEnrolled\(false\)/);
  const display = fs.readFileSync(path.join(ROOT, 'src/components/auth/TotpQrDisplay.tsx'), 'utf8');
  assert.match(display, /ChecksOps Financial authenticator setup QR code/);
  assert.match(card, /ChecksOps Financial authenticator/);
  assert.match(card, /Login still uses email OTP or a passkey/);
  assert.match(card, /Add ChecksOps Financial/);
  assert.doesNotMatch(card, /SOFTWARE_TOKEN_MFA/);
  assert.doesNotMatch(card, /Optional at login/);
  assert.doesNotMatch(card, /from Cognito/);
  assert.doesNotMatch(card, /AWS Cognito TOTP/);
});

test('refresh display uses totpEnrolled and ignores PreferredMfaSetting', () => {
  assert.equal(awsTotpEnrollmentDisplay({ totpEnrolled: true, preferredMfa: null }), 'enrolled');
  assert.equal(awsTotpEnrollmentDisplay({ totpEnrolled: true, preferredMfa: 'SOFTWARE_TOKEN_MFA' }), 'enrolled');
  assert.equal(awsTotpEnrollmentDisplay({ totpEnrolled: false, preferredMfa: null }), 'setup');
  assert.equal(awsTotpEnrollmentDisplay({ totpEnrolled: false, preferredMfa: 'SOFTWARE_TOKEN_MFA' }), 'setup');
  assert.equal(awsTotpEnrollmentDisplay({ totpEnrolled: null, preferredMfa: 'SOFTWARE_TOKEN_MFA' }), 'setup');
});

test('AWS step-up enroll no longer leaves QR null', () => {
  const dialog = fs.readFileSync(path.join(ROOT, 'src/components/auth/StepUpDialog.tsx'), 'utf8');
  assert.match(dialog, /totpQrDataUrl/);
  assert.doesNotMatch(dialog, /setQr\(null\);\s*\n\s*setMode\("enroll"\)/);
});

test('AWS step-up dialog copy is financial authenticator, not login MFA', () => {
  const dialog = fs.readFileSync(path.join(ROOT, 'src/components/auth/StepUpDialog.tsx'), 'utf8');
  assert.match(dialog, /ChecksOps Financial authenticator/);
  assert.match(dialog, /not a login MFA prompt/);
  assert.match(dialog, /setFactorId\("financial-totp"\)/);
  assert.doesNotMatch(dialog, /setFactorId\("software-token"\)/);
});

test('AWS client does not require Cognito MFA for financial step-up', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/integrations/aws/client.ts'), 'utf8');
  assert.doesNotMatch(src, /until Cognito MFA is enabled/);
  assert.match(src, /ChecksOps Financial authenticator for step-up/);
  assert.match(src, /Login stays EMAIL_OTP or passkey/);
});

test('otpauth issuer is ChecksOps Financial', () => {
  const uri = buildTotpOtpauthUri(RFC_TEST_SECRET, 'totp-test@example.com');
  assert.match(uri, /ChecksOps%20Financial/);
  assert.match(uri, /issuer=ChecksOps%20Financial/);
});

test('local QR is generated from otpauth without printing the secret', async () => {
  const uri = buildTotpOtpauthUri(RFC_TEST_SECRET, 'totp-test@example.com');
  assert.match(uri, /^otpauth:\/\/totp\//);
  const resolved = resolveTotpOtpauthUri({ otpauthUri: uri, secret: 'IGNORED' });
  assert.equal(resolved, uri);
  const dataUrl = await totpQrDataUrl(uri);
  assert.match(dataUrl, /^data:image\/png;base64,/);
  assert.ok(dataUrl.length > 500);
});
