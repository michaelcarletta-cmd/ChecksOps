import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('AWS passkey login hydrates Cognito session into useAuth (not localStorage-only)', () => {
  const passkeys = fs.readFileSync(path.join(ROOT, 'src/lib/awsPasskeys.ts'), 'utf8');
  const login = fs.readFileSync(path.join(ROOT, 'src/pages/checkops/CheckOpsLogin.tsx'), 'utf8');
  const client = fs.readFileSync(path.join(ROOT, 'src/integrations/aws/client.ts'), 'utf8');

  assert.match(client, /establishCognitoSession/);
  assert.match(client, /emit\("SIGNED_IN"/);
  assert.match(passkeys, /establishCognitoSession/);
  // Hard reload after passkey success — same handoff pattern as EMAIL_OTP verify.
  assert.match(login, /signInWithAwsPasskey/);
  assert.match(login, /window\.location\.assign\("\/login"\)/);
});

test('passkey authenticate routes remain Origin fail-closed to staging HTTPS', () => {
  const webauthn = fs.readFileSync(path.join(ROOT, 'aws/functions/api/auth-webauthn.mjs'), 'utf8');
  assert.match(webauthn, /https:\/\/staging\.checksops\.com/);
  assert.match(webauthn, /staging_https_origin_required/);
  assert.match(webauthn, /\/auth\/passkey\/authenticate\/verify/);
});
