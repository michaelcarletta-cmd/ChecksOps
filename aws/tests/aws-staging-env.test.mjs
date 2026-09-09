import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  awsPasskeyOriginRequiredMessage,
  detectAwsStagingEnvironment,
  hostnameFromAppUrl,
  isAwsCognitoAuthProvider,
  isAwsProductionPublicHostname,
  isAwsStagingHostname,
} from '../../src/lib/awsEnvDetect.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('Cognito SPA detection is independent of hostname', () => {
  assert.equal(isAwsCognitoAuthProvider('cognito'), true);
  assert.equal(isAwsCognitoAuthProvider('COGNITO'), true);
  assert.equal(isAwsCognitoAuthProvider('supabase'), false);
  assert.equal(isAwsCognitoAuthProvider(''), false);
  assert.equal(isAwsCognitoAuthProvider(undefined), false);
});

test('staging hostname is only staging.checksops.com', () => {
  assert.equal(isAwsStagingHostname('staging.checksops.com'), true);
  assert.equal(isAwsStagingHostname('STAGING.CHECKSOPS.COM'), true);
  assert.equal(isAwsStagingHostname('checksops.com'), false);
  assert.equal(isAwsStagingHostname('www.checksops.com'), false);
  assert.equal(isAwsStagingHostname('d111111abcdef8.cloudfront.net'), false);
  assert.equal(isAwsProductionPublicHostname('checksops.com'), true);
  assert.equal(isAwsProductionPublicHostname('www.checksops.com'), true);
  assert.equal(isAwsProductionPublicHostname('staging.checksops.com'), false);
});

test('staging environment chrome requires Cognito plus staging host', () => {
  assert.equal(detectAwsStagingEnvironment({
    authProvider: 'cognito',
    hostname: 'staging.checksops.com',
  }), true);
  assert.equal(detectAwsStagingEnvironment({
    authProvider: 'cognito',
    hostname: 'checksops.com',
  }), false);
  assert.equal(detectAwsStagingEnvironment({
    authProvider: 'cognito',
    hostname: 'www.checksops.com',
  }), false);
  assert.equal(detectAwsStagingEnvironment({
    authProvider: 'supabase',
    hostname: 'staging.checksops.com',
  }), false);
  assert.equal(hostnameFromAppUrl('https://checksops.com'), 'checksops.com');
  assert.equal(hostnameFromAppUrl('https://staging.checksops.com/'), 'staging.checksops.com');
});

test('passkey origin message uses the configured origin, not a hardcoded staging host', () => {
  assert.equal(
    awsPasskeyOriginRequiredMessage('https://checksops.com'),
    'Passkeys require https://checksops.com. Use email verification on this origin.',
  );
  assert.match(
    awsPasskeyOriginRequiredMessage('https://staging.checksops.com'),
    /staging\.checksops\.com/,
  );
});

test('production login chrome hides banner and master-UAT toggle', () => {
  const banner = read('src/components/AwsStagingBanner.tsx');
  const login = read('src/pages/checkops/CheckOpsLogin.tsx');
  const awsStaging = read('src/lib/awsStaging.ts');
  const wl = read('src/components/white-label/WhiteLabelLogin.tsx');
  const passkeys = read('src/components/auth/PasskeyManagerCard.tsx');

  assert.match(awsStaging, /export function isAwsStaging\(\)/);
  assert.match(awsStaging, /isAwsCognitoSpa/);
  assert.match(awsStaging, /Do not invert/);
  assert.match(banner, /isAwsStagingEnvironment/);
  assert.doesNotMatch(banner, /if \(!isAwsStaging\(\)\)/);
  assert.match(login, /isAwsStagingEnvironment/);
  assert.match(login, /awsStagingHost &&/);
  assert.match(login, /Use staging password \(master UAT\)/);
  assert.doesNotMatch(login, /Passkeys require https:\/\/staging\.checksops\.com/);
  assert.doesNotMatch(wl, /Passkeys require https:\/\/staging\.checksops\.com/);
  assert.doesNotMatch(passkeys, /Passkey management is available only at https:\/\/staging\.checksops\.com/);
  assert.match(passkeys, /AWS_STAGING_HTTPS_ORIGIN/);
});
