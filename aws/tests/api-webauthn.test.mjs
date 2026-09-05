import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  configuredWebAuthnOrigin,
  configuredWebAuthnRpId,
  handleAuthPasskeyAuthenticateStart,
  handleAuthPasskeyList,
  handleAuthPasskeyRegisterOptions,
  isAllowedWebAuthnOrigin,
  WEBAUTHN_AUTH_ROUTES,
  WEBAUTHN_STAGING,
} from '../functions/api/auth-webauthn.mjs';
import { AUTH_ROUTES, PASSWORDLESS_AUTH } from '../functions/api/auth-cognito.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const eventOf = ({ origin, authorization, body } = {}) => ({
  headers: {
    ...(origin ? { origin } : {}),
    ...(authorization ? { authorization } : {}),
  },
  body: body ? JSON.stringify(body) : undefined,
});

test('WebAuthn routes are wired into AUTH_ROUTES', () => {
  for (const route of Object.keys(WEBAUTHN_AUTH_ROUTES)) {
    assert.equal(AUTH_ROUTES[route], WEBAUTHN_AUTH_ROUTES[route]);
  }
  assert.equal(PASSWORDLESS_AUTH.webAuthn.rpId, 'staging.checksops.com');
  assert.equal(WEBAUTHN_STAGING.requiredOrigin, 'https://staging.checksops.com');
  assert.equal(WEBAUTHN_STAGING.registrationRequiresAuthenticatedSession, true);
  assert.equal(WEBAUTHN_STAGING.emailOtpFallback, true);
});

test('passkey routes fail closed without https://staging.checksops.com Origin', async () => {
  const cases = [
    undefined,
    'http://checksops-staging-frontend-c48b.s3-website-us-east-1.amazonaws.com',
    'http://staging.checksops.com',
    'https://checksops.com',
    'https://www.checksops.com',
    'https://evil.example',
  ];
  for (const origin of cases) {
    const blocked = await handleAuthPasskeyRegisterOptions(eventOf({
      origin,
      authorization: 'Bearer access-token',
    }));
    assert.equal(blocked.ok, false);
    assert.equal(blocked.statusCode, 403);
    assert.equal(blocked.error, 'staging_https_origin_required');
  }
});

test('passkey list fails closed on unexpected Origin even with a bearer token', async () => {
  const blocked = await handleAuthPasskeyList(eventOf({
    origin: 'https://checksops.com',
    authorization: 'Bearer access-token',
  }));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.statusCode, 403);
  assert.equal(blocked.error, 'staging_https_origin_required');
});

test('authenticate/start requires staging HTTPS Origin before Cognito is called', async () => {
  const blocked = await handleAuthPasskeyAuthenticateStart(eventOf({
    origin: 'http://localhost:5173',
    body: { email: 'checksops-tester@freedomadj.com' },
  }));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.statusCode, 403);
  assert.equal(blocked.error, 'staging_https_origin_required');
});

test('template SignInPolicy includes WEB_AUTHN alongside EMAIL_OTP', () => {
  const yaml = fs.readFileSync(path.join(ROOT, 'template.yaml'), 'utf8');
  assert.match(yaml, /SignInPolicy:/);
  assert.match(yaml, /EMAIL_OTP/);
  assert.match(yaml, /WEB_AUTHN/);
});

test('default WebAuthn origin is staging and rejects production/apex hosts', () => {
  assert.equal(configuredWebAuthnOrigin(), 'https://staging.checksops.com');
  assert.equal(configuredWebAuthnRpId(), 'staging.checksops.com');
  assert.equal(isAllowedWebAuthnOrigin('https://staging.checksops.com'), true);
  assert.equal(isAllowedWebAuthnOrigin('https://checksops.com'), false);
  assert.equal(isAllowedWebAuthnOrigin('https://www.checksops.com'), false);
  assert.equal(isAllowedWebAuthnOrigin('https://checksops.com', 'https://checksops.com'), true);
});

test('CloudFront HTTPS template is staging-only and targets staging.checksops.com', () => {
  const yaml = fs.readFileSync(path.join(ROOT, 'frontend/https-cloudfront.yaml'), 'utf8');
  assert.match(yaml, /Default: staging\.checksops\.com/);
  assert.match(yaml, /AWS::CloudFront::Distribution/);
  assert.match(yaml, /ExistingCertificateArn/);
  assert.match(yaml, /OriginAccessControl/);
  // Distribution aliases come only from StagingHostname — never hard-coded apex/www.
  const aliasesBlock = yaml.match(/Aliases:\n(?:[ \t]+-[^\n]*\n)+/);
  assert.ok(aliasesBlock, 'Aliases block missing');
  assert.match(aliasesBlock[0], /!Ref StagingHostname/);
  assert.doesNotMatch(aliasesBlock[0], /www\.checksops\.com/);
  assert.doesNotMatch(aliasesBlock[0], /-\s*checksops\.com\s*$/m);
  assert.doesNotMatch(yaml, /Default: (www\.)?checksops\.com\s*$/m);
});
