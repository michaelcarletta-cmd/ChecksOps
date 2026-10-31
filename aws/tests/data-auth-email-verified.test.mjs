// Security audit finding 17: auth.email() (request.jwt.claim.email) must not come from an
// unverified Cognito email. withIdentity sets it from the identity mapping's email, and falls back
// to the token email only when Cognito marks it verified.
import test from 'node:test';
import assert from 'node:assert/strict';
import { APP_USER_EMAIL_GUC, APP_USER_ID_GUC } from '../functions/api/cognito.mjs';
import { resolveTrustedIdentityScope } from '../functions/api/identity.mjs';
import {
  appUserEmailForGuc,
  isVerifiedEmailClaim,
  resolveClaims,
  withIdentity,
} from '../functions/api/data.mjs';

const SUB = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const USER = '11111111-1111-4111-8111-111111111111';

const runWithIdentity = async ({ jwtClaims, mappingEmail }) => {
  const queries = [];
  const result = await withIdentity({
    requestContext: { authorizer: { jwt: { claims: { sub: SUB, ...jwtClaims } } } },
  }, async () => ({ ok: true, statusCode: 200 }), {
    identityScope: resolveTrustedIdentityScope({ checksopsEnv: 'staging', userPoolId: '' }),
    loadDatabaseCredentials: async () => ({ host: 'db.invalid', port: 5432, username: 'u', password: 'p', dbname: 'd' }),
    createClient: () => ({
      connect: async () => {},
      end: async () => {},
      on: () => {},
      query: async (sql, params = []) => {
        queries.push({ sql, params });
        if (params[0] === SUB) {
          return { rows: [{ application_user_id: USER, cognito_sub: SUB, email: mappingEmail, status: 'active' }] };
        }
        return { rows: [] };
      },
    }),
  });
  const guc = (name) => queries.find((q) => /set_config/.test(q.sql) && q.params[0] === name)?.params[1];
  return { result, emailGuc: guc(APP_USER_EMAIL_GUC), userGuc: guc(APP_USER_ID_GUC) };
};

test('email_verified: only boolean true or the string "true" count as verified', () => {
  assert.equal(isVerifiedEmailClaim(true), true);
  assert.equal(isVerifiedEmailClaim('true'), true);
  for (const value of [false, 'false', undefined, null, '', 'TRUE', 1, '1', 'yes']) {
    assert.equal(isVerifiedEmailClaim(value), false, String(value));
  }
});

test('appUserEmailForGuc: the mapped email wins; the token email only when verified', () => {
  assert.equal(appUserEmailForGuc({ email: 'mapped@example.com' }, { email: 'token@example.com', email_verified: true }), 'mapped@example.com');
  assert.equal(appUserEmailForGuc({ email: 'mapped@example.com' }, { email: 'token@example.com', email_verified: false }), 'mapped@example.com');
  assert.equal(appUserEmailForGuc({ email: null }, { email: 'token@example.com', email_verified: true }), 'token@example.com');
  assert.equal(appUserEmailForGuc({ email: null }, { email: 'token@example.com', email_verified: false }), '');
  assert.equal(appUserEmailForGuc({ email: '' }, { email: 'token@example.com' }), '');
  assert.equal(appUserEmailForGuc({ email: null }, { email: null, email_verified: true }), '');
  assert.equal(appUserEmailForGuc(null, null), '');
});

test('withIdentity: an unverified token email is never set as request.jwt.claim.email', async () => {
  for (const emailVerified of [undefined, false, 'false']) {
    const jwtClaims = { email: 'victim-homeowner@example.com' };
    if (emailVerified !== undefined) jwtClaims.email_verified = emailVerified;
    const { result, emailGuc, userGuc } = await runWithIdentity({ jwtClaims, mappingEmail: null });
    assert.equal(result.ok, true);
    assert.equal(userGuc, USER);
    assert.equal(emailGuc, '', String(emailVerified));
  }
});

test('withIdentity: a mapped user keeps the mapped email whatever the token says', async () => {
  for (const jwtClaims of [
    { email: 'mapped@example.com', email_verified: 'true' },
    { email: 'changed-unverified@example.com', email_verified: 'false' },
    { email: 'changed-unverified@example.com' },
    {},
  ]) {
    const { emailGuc } = await runWithIdentity({ jwtClaims, mappingEmail: 'mapped@example.com' });
    assert.equal(emailGuc, 'mapped@example.com', JSON.stringify(jwtClaims));
  }
});

test('withIdentity: a verified token email is used when the mapping records none', async () => {
  for (const verified of ['true', true]) {
    const { emailGuc } = await runWithIdentity({
      jwtClaims: { email: 'homeowner@example.com', email_verified: verified },
      mappingEmail: null,
    });
    assert.equal(emailGuc, 'homeowner@example.com');
  }
});

test('resolveClaims: authorizer claims carry email_verified as a boolean', async () => {
  const verified = await resolveClaims({ requestContext: { authorizer: { jwt: { claims: { sub: SUB, email: 'a@example.com', email_verified: 'true' } } } } });
  assert.equal(verified.ok, true);
  assert.equal(verified.claims.email, 'a@example.com');
  assert.equal(verified.claims.email_verified, true);
  const unverified = await resolveClaims({ requestContext: { authorizer: { jwt: { claims: { sub: SUB, email: 'a@example.com', email_verified: 'false' } } } } });
  assert.equal(unverified.claims.email_verified, false);
  const absent = await resolveClaims({ requestContext: { authorizer: { jwt: { claims: { sub: SUB, email: 'a@example.com' } } } } });
  assert.equal(absent.claims.email_verified, false);
});

test('resolveClaims: an unverifiable bearer token is refused before any email is read', async () => {
  const savedPool = process.env.COGNITO_USER_POOL_ID;
  const savedClient = process.env.COGNITO_CLIENT_ID;
  delete process.env.COGNITO_USER_POOL_ID;
  delete process.env.COGNITO_CLIENT_ID;
  try {
    const payload = Buffer.from(JSON.stringify({ sub: SUB, email: 'a@example.com', email_verified: true })).toString('base64url');
    const refused = await resolveClaims({ headers: { authorization: `Bearer e30.${payload}.sig` } });
    assert.equal(refused.ok, false);
    assert.equal(refused.statusCode, 401);
    assert.equal(refused.error, 'invalid_cognito_token');
  } finally {
    if (savedPool !== undefined) process.env.COGNITO_USER_POOL_ID = savedPool;
    if (savedClient !== undefined) process.env.COGNITO_CLIENT_ID = savedClient;
  }
});
