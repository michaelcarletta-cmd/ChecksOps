import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('MortgageOps AWS session key is isolated from CheckOps/WhiteLabel', () => {
  const staging = fs.readFileSync(path.join(ROOT, 'src/lib/awsStaging.ts'), 'utf8');
  const mortgageClient = fs.readFileSync(path.join(ROOT, 'src/integrations/supabase/mortgageClient.ts'), 'utf8');
  const mainClient = fs.readFileSync(path.join(ROOT, 'src/integrations/supabase/client.ts'), 'utf8');
  const awsClient = fs.readFileSync(path.join(ROOT, 'src/integrations/aws/client.ts'), 'utf8');
  const mopsLogin = fs.readFileSync(path.join(ROOT, 'src/pages/mortgage-ops/MortgageOpsLogin.tsx'), 'utf8');
  const passwordless = fs.readFileSync(path.join(ROOT, 'src/lib/awsPasswordless.ts'), 'utf8');
  const passkeys = fs.readFileSync(path.join(ROOT, 'src/lib/awsPasskeys.ts'), 'utf8');

  assert.match(staging, /AWS_STAGING_AUTH_SESSION_KEY\s*=\s*"checksops\.aws\.staging\.auth"/);
  assert.match(
    staging,
    /AWS_STAGING_MORTGAGE_AUTH_SESSION_KEY\s*=\s*"checksops\.aws\.staging\.auth\.mortgage-ops"/,
  );
  assert.match(mortgageClient, /sessionKey:\s*AWS_STAGING_MORTGAGE_AUTH_SESSION_KEY/);
  assert.match(mortgageClient, /sb-mortgage-ops-auth/);
  // Main CheckOps client must not pass the mortgage session key.
  assert.doesNotMatch(mainClient, /MORTGAGE_AUTH_SESSION_KEY/);
  assert.match(awsClient, /createAwsSessionStore/);
  assert.match(awsClient, /options\.sessionKey/);
  // Mortgage login must write Cognito tokens into the mortgage portal store.
  assert.match(mopsLogin, /portal:\s*"mortgage-ops"/);
  assert.match(mopsLogin, /AWS_STAGING_MORTGAGE_AUTH_SESSION_KEY/);
  assert.match(mopsLogin, /authClient:\s*supabase/);
  assert.match(passwordless, /portal\s*===\s*"mortgage-ops"/);
  assert.match(passkeys, /authClient/);
  assert.match(passkeys, /sessionKey/);
});

test('AWS staging auth client stubs MFA and keeps identity mapping guard', () => {
  const awsClient = fs.readFileSync(path.join(ROOT, 'src/integrations/aws/client.ts'), 'utf8');
  assert.match(awsClient, /mfa:\s*\{/);
  assert.match(awsClient, /listFactors/);
  assert.match(awsClient, /application_user_id equals cognito_sub/);
  assert.match(awsClient, /establishCognitoSession/);
  assert.match(awsClient, /\/identity\/me/);
});

test('WhiteLabel and CheckOps OTP verify hand off via establishCognitoSession', () => {
  const wl = fs.readFileSync(path.join(ROOT, 'src/components/white-label/WhiteLabelLogin.tsx'), 'utf8');
  const checkops = fs.readFileSync(path.join(ROOT, 'src/pages/checkops/CheckOpsLogin.tsx'), 'utf8');
  for (const src of [wl, checkops]) {
    assert.match(src, /verifyAwsEmailOtp/);
    assert.match(src, /authClient:\s*supabase/);
  }
});
