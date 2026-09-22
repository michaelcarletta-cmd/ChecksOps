import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  AUTH_ROUTES,
  PASSWORDLESS_AUTH,
  handleAuthChallenge,
  handleAuthLogin,
  handleAuthPasswordlessStart,
  handleAuthPasswordlessVerify,
} from '../functions/api/auth-cognito.mjs';
import { WEBAUTHN_AUTH_ROUTES, WEBAUTHN_STAGING } from '../functions/api/auth-webauthn.mjs';
import {
  EXPECTED_DUAL_ENV_IDENTITIES,
} from '../identity/expected-mappings.mjs';
import {
  LOOKUP_MAPPING_SQL,
  LOOKUP_PRODUCTION_IDENTITY_SQL,
  resolveIdentitySession,
} from '../functions/api/identity.mjs';
import {
  IDENTITY_ENV_STAGING,
  STAGING_IDENTITY_SOURCE,
  lookupIdentityMapping,
  resolveTrustedIdentityScope,
} from '../functions/api/identity-env.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.join(ROOT, '..');
const MICHAEL = EXPECTED_DUAL_ENV_IDENTITIES[0];
const UNKNOWN_SUB = '00000000-0000-4000-8000-000000000099';

const loginUi = () => fs.readFileSync(path.join(REPO, 'src/pages/checkops/CheckOpsLogin.tsx'), 'utf8');
const template = () => fs.readFileSync(path.join(ROOT, 'template.yaml'), 'utf8');
const productionPrep = () => fs.readFileSync(path.join(ROOT, 'production/prep-stack.yaml'), 'utf8');
const authSource = () => fs.readFileSync(path.join(ROOT, 'functions/api/auth-cognito.mjs'), 'utf8');

test('EMAIL_OTP start and verify routes remain wired and do not accept a password', () => {
  assert.equal(AUTH_ROUTES['/auth/passwordless/start'], handleAuthPasswordlessStart);
  assert.equal(AUTH_ROUTES['/auth/passwordless/verify'], handleAuthPasswordlessVerify);
  assert.equal(AUTH_ROUTES['/auth/email/start'], handleAuthPasswordlessStart);
  assert.equal(AUTH_ROUTES['/auth/email/verify'], handleAuthPasswordlessVerify);
  assert.equal(PASSWORDLESS_AUTH.authFlow, 'USER_AUTH');
  assert.equal(PASSWORDLESS_AUTH.preferredChallenge, 'EMAIL_OTP');
  assert.equal(PASSWORDLESS_AUTH.passwordAcceptedByPasswordlessRoutes, false);
  assert.equal(PASSWORDLESS_AUTH.passwordLoginEnabled, false);
  assert.deepEqual(PASSWORDLESS_AUTH.allowedFirstFactors, ['EMAIL_OTP', 'WEB_AUTHN']);
  assert.match(authSource(), /PREFERRED_CHALLENGE: 'EMAIL_OTP'/);
  assert.match(authSource(), /ChallengeName: 'EMAIL_OTP'/);
  assert.doesNotMatch(
    authSource().slice(authSource().indexOf('handleAuthPasswordlessStart'), authSource().indexOf('passwordAuthDisabled')),
    /PASSWORD:\s/,
  );
});

test('WebAuthn/passkey routes remain available on staging HTTPS', () => {
  for (const route of Object.keys(WEBAUTHN_AUTH_ROUTES)) {
    assert.equal(AUTH_ROUTES[route], WEBAUTHN_AUTH_ROUTES[route]);
  }
  assert.ok(AUTH_ROUTES['/auth/passkey/authenticate/start']);
  assert.equal(PASSWORDLESS_AUTH.webAuthn.rpId, 'staging.checksops.com');
  assert.equal(WEBAUTHN_STAGING.requiredOrigin, 'https://staging.checksops.com');
  assert.equal(WEBAUTHN_STAGING.emailOtpFallback, true);
});

test('password and master/UAT password authentication are unavailable and never call Cognito', async () => {
  let fetchCalled = false;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error('Cognito must not be called for retired password login');
  };
  try {
    const login = await handleAuthLogin({
      body: JSON.stringify({
        email: 'staging-master@checksops.invalid',
        password: 'any-password',
      }),
    });
    const challenge = await handleAuthChallenge({
      body: JSON.stringify({
        email: 'staging-master@checksops.invalid',
        session: 'session',
        newPassword: 'any-password',
      }),
    });
    for (const result of [login, challenge]) {
      assert.equal(result.ok, false);
      assert.equal(result.statusCode, 410);
      assert.equal(result.error, 'password_auth_disabled');
      assert.equal(result.authentication, undefined);
    }
    assert.equal(AUTH_ROUTES['/auth/login'], handleAuthLogin);
    assert.equal(AUTH_ROUTES['/auth/challenge'], handleAuthChallenge);
    assert.equal(PASSWORDLESS_AUTH.masterUatPasswordLoginEnabled, false);
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = original;
  }
});

test('login UI offers passkey and email verification and has no password entry path', () => {
  const ui = loginUi();
  assert.match(ui, /Sign in with a passkey/);
  assert.match(ui, /Email me a verification code/);
  assert.match(ui, /startAwsEmailOtp/);
  assert.match(ui, /verifyAwsEmailOtp/);
  assert.match(ui, /signInWithAwsPasskey/);
  assert.doesNotMatch(ui, /signInWithPassword/);
  assert.doesNotMatch(ui, /handlePasswordLogin/);
  assert.doesNotMatch(ui, /showPassword/);
  assert.doesNotMatch(ui, /STAGING_MASTER_LOGIN_EMAIL/);
  assert.doesNotMatch(ui, /Sign in with password/);
  assert.doesNotMatch(ui, /Use staging password/);
  assert.doesNotMatch(ui, /master UAT/);
  assert.doesNotMatch(ui, /htmlFor="password"/);
  assert.doesNotMatch(ui, /id="password"/);
  assert.doesNotMatch(ui, /type="password"/);
  assert.doesNotMatch(ui, /\/auth\/login/);
  assert.doesNotMatch(ui, /\/auth\/challenge/);
});

test('identity resolver, tenant roles, and fail-closed unknown identities are unchanged', async () => {
  const writes = [];
  const queries = [];
  const store = {
    connect: async () => {},
    end: async () => {},
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (/^\s*(INSERT|UPDATE|DELETE|MERGE)\b/i.test(sql)) {
        writes.push({ sql, params });
        throw new Error('identity resolution must not write');
      }
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
      if (sql.includes('auth.uid()')) return { rows: [{ auth_uid: MICHAEL.applicationUserId }] };
      if (sql === LOOKUP_MAPPING_SQL) {
        return {
          rows: params[0] === MICHAEL.stagingCognitoSub ? [{
            application_user_id: MICHAEL.applicationUserId,
            cognito_sub: MICHAEL.stagingCognitoSub,
            email: MICHAEL.email,
            status: 'active',
          }] : [],
        };
      }
      if (sql === LOOKUP_PRODUCTION_IDENTITY_SQL) return { rows: [] };
      if (sql.includes('FROM public.profiles')) {
        return { rows: [{ id: MICHAEL.applicationUserId, email: MICHAEL.email, full_name: 'M. Carletta', approval_status: 'approved' }] };
      }
      if (sql.includes('FROM public.tenant_users')) {
        assert.equal(params[0], MICHAEL.applicationUserId);
        return { rows: [{
          tenant_id: '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a',
          role: 'admin',
          tenant_name: 'Freedom Adjustment',
          tenant_slug: 'freedom',
        }] };
      }
      if (sql.includes('FROM public.user_roles')) {
        assert.equal(params[0], MICHAEL.applicationUserId);
        return { rows: [{ role: 'admin' }] };
      }
      if (sql.includes('is_master_owner()')) return { rows: [{ is_master_owner: false }] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };

  const scope = resolveTrustedIdentityScope({
    checksopsEnv: 'staging',
    userPoolId: 'us-east-1_vPmQ7cL1F',
  });
  assert.equal(scope.ok, true);
  assert.equal(scope.identityEnv, IDENTITY_ENV_STAGING);
  assert.equal(scope.mappingSource, STAGING_IDENTITY_SOURCE);

  const mapped = await lookupIdentityMapping(store, MICHAEL.stagingCognitoSub, scope);
  const resolved = await resolveIdentitySession({
    cognitoSub: MICHAEL.stagingCognitoSub,
    email: MICHAEL.email,
    identityScope: scope,
    loadCredentials: async () => ({
      username: 'checksops',
      password: 'unit-test-only-not-a-real-secret',
      host: 'db.example.internal',
      database: 'checksops',
    }),
    createClient: () => store,
  });
  const unknown = await resolveIdentitySession({
    cognitoSub: UNKNOWN_SUB,
    email: MICHAEL.email,
    identityScope: scope,
    loadCredentials: async () => ({
      username: 'checksops',
      password: 'unit-test-only-not-a-real-secret',
      host: 'db.example.internal',
      database: 'checksops',
    }),
    createClient: () => store,
  });

  assert.equal(mapped.mapping.application_user_id, MICHAEL.applicationUserId);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.applicationUserId, MICHAEL.applicationUserId);
  assert.equal(resolved.cognitoSub, MICHAEL.stagingCognitoSub);
  assert.deepEqual(resolved.roles, ['admin']);
  assert.equal(resolved.tenants[0].tenant_slug, 'freedom');
  assert.equal(resolved.authorizationSource, 'user_roles_and_tenant_users');
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error, 'identity_not_linked');
  assert.equal(writes.length, 0);
  assert.ok(queries.every((row) => !/^\s*(INSERT|UPDATE|DELETE|MERGE)\b/i.test(row.sql)));
  assert.equal(MICHAEL.stagingCognitoSub, 'c4386408-60e1-70e2-abb6-e6194e8e635f');
  assert.equal(MICHAEL.applicationUserId, '7dbb3009-f059-4767-b5dc-1c5c72379330');
});

test('staging SAM template and production prep-stack stay untouched by this password-path removal', () => {
  const yaml = template();
  const factors = yaml.match(/AllowedFirstAuthFactors:\n((?:\s+-\s+\w+\n)+)/);
  assert.ok(factors);
  assert.match(factors[1], /EMAIL_OTP/);
  assert.match(factors[1], /WEB_AUTHN/);
  assert.match(yaml, /ALLOW_USER_AUTH/);
  assert.match(productionPrep(), /ALLOW_USER_PASSWORD_AUTH/);
  assert.match(authSource(), /password_auth_disabled/);
  assert.match(authSource(), /handleAuthLogin = async \(\) => passwordAuthDisabled/);
  assert.match(authSource(), /handleAuthChallenge = async \(\) => passwordAuthDisabled/);
});
