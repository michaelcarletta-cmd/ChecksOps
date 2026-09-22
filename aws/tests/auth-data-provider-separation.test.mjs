import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  composeCognitoAuthWithSupabaseData,
  createDisabledSupabaseAuthStorage,
  resolveAuthProvider,
  resolveDataServiceProvider,
  resolveIntegrationSelection,
  supabaseDataClientAuthOptions,
} from '../../src/lib/providers.ts';
import { awsCheckAltProviderPathReady } from '../../src/lib/awsCheckAltMoneyPath.ts';
import { AUTH_ROUTES, PASSWORDLESS_AUTH } from '../functions/api/auth-cognito.mjs';
import { WEBAUTHN_AUTH_ROUTES, WEBAUTHN_STAGING } from '../functions/api/auth-webauthn.mjs';
import {
  IDENTITY_ENV_PRODUCTION,
  IDENTITY_ENV_STAGING,
  LOOKUP_MAPPING_SQL,
  LOOKUP_PRODUCTION_IDENTITY_SQL,
  PRODUCTION_COGNITO_USER_POOL_ID,
  PRODUCTION_IDENTITY_SOURCE,
  STAGING_COGNITO_USER_POOL_ID,
  STAGING_IDENTITY_SOURCE,
  resolveTrustedIdentityScope,
} from '../functions/api/identity-env.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('1. legacy empty env keeps Supabase auth + Supabase data', () => {
  const empty = resolveIntegrationSelection({});
  const production = resolveIntegrationSelection({
    VITE_SUPABASE_URL: 'https://nbcqwpysqgyxrrbgtmkw.supabase.co',
  });
  assert.deepEqual(empty, { auth: 'supabase', data: 'supabase', client: 'supabase' });
  assert.deepEqual(production, { auth: 'supabase', data: 'supabase', client: 'supabase' });
  assert.equal(resolveAuthProvider({}), 'supabase');
  assert.equal(resolveDataServiceProvider({}), 'supabase');
});

test('2. Cognito auth can be selected independently of the data plane', () => {
  const stagingDefault = resolveIntegrationSelection({ VITE_AUTH_PROVIDER: 'cognito' });
  const split = resolveIntegrationSelection({
    VITE_AUTH_PROVIDER: 'cognito',
    VITE_DATA_SERVICE_PROVIDER: 'supabase',
  });
  const explicitAws = resolveIntegrationSelection({
    VITE_AUTH_PROVIDER: 'cognito',
    VITE_DATA_SERVICE_PROVIDER: 'aws',
  });
  assert.deepEqual(stagingDefault, { auth: 'cognito', data: 'aws', client: 'aws-adapter' });
  assert.deepEqual(split, { auth: 'cognito', data: 'supabase', client: 'cognito-auth-supabase-data' });
  assert.deepEqual(explicitAws, { auth: 'cognito', data: 'aws', client: 'aws-adapter' });
  assert.equal(split.auth, 'cognito');
  assert.equal(split.data, 'supabase');
});

test('unsupported Supabase-auth + AWS-data fail-closes to the Supabase client', () => {
  const unsupported = resolveIntegrationSelection({
    VITE_DATA_SERVICE_PROVIDER: 'aws',
  });
  assert.deepEqual(unsupported, { auth: 'supabase', data: 'supabase', client: 'supabase' });
});

test('3-4. Cognito composition never reads, writes, or restores a Supabase Auth session', async () => {
  const storage = createDisabledSupabaseAuthStorage();
  const staleKey = 'sb-nbcqwpysqgyxrrbgtmkw-auth-token';
  const staleSession = JSON.stringify({
    user: { id: 'stale-supabase-auth-user', email: 'stale@example.com' },
    access_token: 'stale-supabase-jwt',
  });
  storage.setItem(staleKey, staleSession);
  assert.equal(storage.getItem(staleKey), null);

  const options = supabaseDataClientAuthOptions();
  assert.equal(options.persistSession, false);
  assert.equal(options.autoRefreshToken, false);
  assert.equal(options.detectSessionInUrl, false);
  assert.equal(options.storage.getItem(staleKey), null);
  options.storage.setItem(staleKey, staleSession);
  assert.equal(options.storage.getItem(staleKey), null);

  let dataAuthCalled = false;
  const cognitoUser = { id: '7dbb3009-f059-4767-b5dc-1c5c72379330', email: 'mapped@checksops.com' };
  const composed = composeCognitoAuthWithSupabaseData(
    {
      auth: {
        getSession: async () => ({ data: { session: { user: cognitoUser } }, error: null }),
        getUser: async () => ({ data: { user: cognitoUser }, error: null }),
      },
    },
    {
      auth: {
        getSession: async () => {
          dataAuthCalled = true;
          return { data: { session: { user: { id: 'stale-supabase-auth-user' } } }, error: null };
        },
      },
      from: (table) => ({ table, plane: 'supabase' }),
      rpc: (name) => ({ name, plane: 'supabase' }),
      storage: { plane: 'supabase-storage' },
      functions: { plane: 'supabase-functions' },
      channel: () => ({ plane: 'supabase-realtime' }),
      removeChannel: () => ({ plane: 'supabase-realtime' }),
      getChannels: () => [],
    },
  );

  const session = await composed.auth.getSession();
  const user = await composed.auth.getUser();
  assert.equal(session.data.session.user.id, cognitoUser.id);
  assert.equal(user.data.user.id, cognitoUser.id);
  assert.notEqual(session.data.session.user.id, 'stale-supabase-auth-user');
  assert.equal(dataAuthCalled, false);
  assert.equal(composed.from('claim_checks').plane, 'supabase');
  assert.equal(composed.storage.plane, 'supabase-storage');
  assert.equal(composed.functions.plane, 'supabase-functions');
  assert.equal(composed.rpc('submit_check_review_decision').plane, 'supabase');
  assert.equal('auth' in Object.getPrototypeOf(composed) ? composed.auth.getSession : composed.auth.getSession, composed.auth.getSession);
});

test('5-7. EMAIL_OTP and WebAuthn stay available; password login stays retired', () => {
  assert.ok(AUTH_ROUTES['/auth/passwordless/start']);
  assert.ok(AUTH_ROUTES['/auth/passwordless/verify']);
  assert.ok(AUTH_ROUTES['/auth/passkey/authenticate/start']);
  assert.equal(AUTH_ROUTES['/auth/passkey/authenticate/start'], WEBAUTHN_AUTH_ROUTES['/auth/passkey/authenticate/start']);
  assert.equal(PASSWORDLESS_AUTH.preferredChallenge, 'EMAIL_OTP');
  assert.equal(PASSWORDLESS_AUTH.passwordAcceptedByPasswordlessRoutes, false);
  assert.equal(PASSWORDLESS_AUTH.passwordLoginEnabled, false);
  assert.deepEqual(PASSWORDLESS_AUTH.allowedFirstFactors, ['EMAIL_OTP', 'WEB_AUTHN']);
  assert.equal(WEBAUTHN_STAGING.emailOtpFallback, true);

  const login = read('src/pages/checkops/CheckOpsLogin.tsx');
  assert.match(login, /isCognitoAuth/);
  assert.match(login, /startAwsEmailOtp/);
  assert.match(login, /verifyAwsEmailOtp/);
  assert.match(login, /signInWithAwsPasskey/);
  assert.doesNotMatch(login, /signInWithPassword/);
  assert.doesNotMatch(login, /type="password"/);
});

test('8. split selection keeps Supabase data/storage/functions off the AWS adapter', () => {
  const client = read('src/integrations/supabase/client.ts');
  const mortgage = read('src/integrations/supabase/mortgageClient.ts');
  for (const src of [client, mortgage]) {
    assert.match(src, /composeCognitoAuthWithSupabaseData/);
    assert.match(src, /createSupabaseDataOnlyClient|supabaseDataClientAuthOptions/);
    assert.match(src, /isCognitoAuth/);
    assert.match(src, /isAwsDataPlane/);
    assert.match(src, /createAwsStagingClient/);
  }
  assert.match(read('src/lib/publicWorkflowApi.ts'), /isAwsDataPlane/);
  assert.match(read('src/pages/CheckCommandCenter.tsx'), /isAwsDataPlane/);
  assert.match(read('src/pages/checkops/CheckOpsLogin.tsx'), /isCognitoAuth/);
  assert.equal(awsCheckAltProviderPathReady({
    authProvider: 'cognito',
    dataServiceProvider: 'supabase',
    apiBaseUrl: '/prep',
    functionName: 'checkalt-submit-deposit',
  }).ok, false);
  assert.equal(awsCheckAltProviderPathReady({
    authProvider: 'cognito',
    apiBaseUrl: '/prep',
    functionName: 'checkalt-submit-deposit',
  }).ok, true);
});

test('9. no service-role key reaches browser env or Vite sources', () => {
  const files = [
    '.env.production',
    '.env.aws.example',
    '.env.production.aws.example',
    'vite.config.ts',
    'src/integrations/supabase/client.ts',
    'src/integrations/supabase/mortgageClient.ts',
    'src/lib/providers.ts',
    'src/lib/publicWorkflowApi.ts',
  ];
  for (const rel of files) {
    const src = read(rel);
    assert.doesNotMatch(src, /SERVICE_ROLE/i);
    assert.doesNotMatch(src, /service_role/);
    assert.doesNotMatch(src, /SUPABASE_SERVICE/);
  }
  const prod = read('.env.production');
  assert.doesNotMatch(prod, /VITE_AUTH_PROVIDER=/);
  assert.doesNotMatch(prod, /VITE_DATA_SERVICE_PROVIDER=/);
  assert.doesNotMatch(prod, /VITE_COGNITO_USER_POOL_ID=/);
});

test('10-11. identity resolver and production/staging maps stay isolated and unchanged', () => {
  assert.equal(STAGING_COGNITO_USER_POOL_ID, 'us-east-1_vPmQ7cL1F');
  assert.equal(PRODUCTION_COGNITO_USER_POOL_ID, 'us-east-1_h00WorYMT');
  assert.equal(STAGING_IDENTITY_SOURCE, 'identity_accounts');
  assert.equal(PRODUCTION_IDENTITY_SOURCE, 'identity_production_cognito_locks');
  assert.match(LOOKUP_MAPPING_SQL, /FROM public\.identity_accounts/);
  assert.match(LOOKUP_PRODUCTION_IDENTITY_SQL, /FROM public\.identity_production_cognito_locks/);
  assert.doesNotMatch(LOOKUP_PRODUCTION_IDENTITY_SQL, /WHERE\s+lock\.email/);
  assert.doesNotMatch(LOOKUP_MAPPING_SQL, /WHERE\s+email/);

  const staging = resolveTrustedIdentityScope({
    checksopsEnv: 'staging',
    userPoolId: STAGING_COGNITO_USER_POOL_ID,
  });
  const production = resolveTrustedIdentityScope({
    checksopsEnv: 'production-prep',
    userPoolId: PRODUCTION_COGNITO_USER_POOL_ID,
  });
  const crossed = resolveTrustedIdentityScope({
    checksopsEnv: 'staging',
    userPoolId: PRODUCTION_COGNITO_USER_POOL_ID,
  });
  assert.equal(staging.ok, true);
  assert.equal(staging.identityEnv, IDENTITY_ENV_STAGING);
  assert.equal(staging.mappingSource, STAGING_IDENTITY_SOURCE);
  assert.equal(production.ok, true);
  assert.equal(production.identityEnv, IDENTITY_ENV_PRODUCTION);
  assert.equal(production.mappingSource, PRODUCTION_IDENTITY_SOURCE);
  assert.equal(crossed.ok, false);
  assert.equal(crossed.error, 'identity_pool_mismatch');

  const identityEnvSrc = read('aws/functions/api/identity-env.mjs');
  const identitySrc = read('aws/functions/api/identity.mjs');
  assert.doesNotMatch(identityEnvSrc, /INSERT INTO public\.identity_/);
  assert.doesNotMatch(identitySrc, /INSERT INTO public\.identity_/);
});

test('isAwsStaging remains the combined Cognito+AWS switch and is not inverted', () => {
  const src = read('src/lib/awsStaging.ts');
  assert.match(src, /export function isAwsStaging\(\): boolean/);
  assert.match(src, /client === "aws-adapter"/);
  assert.match(src, /Do not rename or invert it/);
  assert.match(read('aws/cutover/API_BEHIND_CLOUDFRONT_STEP3_DESIGN.md'), /Do \*\*not\*\* rename or invert `isAwsStaging\(\)`/);
});
