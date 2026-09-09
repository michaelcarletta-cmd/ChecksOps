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
  const display = fs.readFileSync(path.join(ROOT, 'src/components/auth/TotpQrDisplay.tsx'), 'utf8');
  assert.match(display, /Authenticator setup QR code/);
});

test('AWS step-up enroll no longer leaves QR null', () => {
  const dialog = fs.readFileSync(path.join(ROOT, 'src/components/auth/StepUpDialog.tsx'), 'utf8');
  assert.match(dialog, /totpQrDataUrl/);
  assert.doesNotMatch(dialog, /setQr\(null\);\s*\n\s*setMode\("enroll"\)/);
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
