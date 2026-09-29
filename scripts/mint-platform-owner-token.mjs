#!/usr/bin/env node
/**
 * Staging-only: ensure the existing ChecksOps platform-owner Cognito user can
 * mint a JWT. Uses the already-stored staging UAT password. Does not change
 * production identity or remap application UUIDs.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { assumeCursorRole, secretString } from './cognito-staging-token.mjs';

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const POOL = 'us-east-1_vPmQ7cL1F';
const CLIENT = '71bb7a192cbl6o6s8m259tl589';
const OWNER_EMAIL = 'checksopsadmin@gmail.com';
const TESTER_EMAIL = 'checksops-tester@freedomadj.com';
const API = 'https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging';
const OUT = '/opt/cursor/artifacts/moov-monthly-billing-preprod';

const awsTry = (args) => {
  try {
    const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], { encoding: 'utf8' });
    return { ok: true, data: out.trim() ? JSON.parse(out) : {} };
  } catch (error) {
    return { ok: false, error: String(error.stderr || error.message || error).slice(0, 500) };
  }
};

const claimsOf = (token) => {
  const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
  return { sub: payload.sub || null, email: payload.email || null, token_use: payload.token_use || null };
};

const mint = async (email, password) => {
  const set = awsTry([
    'cognito-idp', 'admin-set-user-password',
    '--user-pool-id', POOL,
    '--username', email,
    '--password', password,
    '--permanent',
  ]);
  const auth = awsTry([
    'cognito-idp', 'admin-initiate-auth',
    '--user-pool-id', POOL,
    '--client-id', CLIENT,
    '--auth-flow', 'ADMIN_USER_PASSWORD_AUTH',
    '--auth-parameters', `USERNAME=${email},PASSWORD=${password}`,
  ]);
  const token = auth.data?.AuthenticationResult?.IdToken || null;
  let identity = null;
  if (token) {
    const res = await fetch(`${API}/identity/me`, { headers: { authorization: `Bearer ${token}` } });
    identity = { http: res.status, ...(await res.json().catch(() => ({}))) };
  }
  return {
    email,
    setPassword: { ok: set.ok, error: set.ok ? null : set.error },
    auth: { ok: Boolean(token), error: auth.ok ? null : auth.error },
    claims: token ? claimsOf(token) : null,
    identity: identity && {
      ok: identity.ok === true,
      http: identity.http,
      error: identity.error || null,
      applicationUserId: identity.applicationUserId || null,
      isMasterOwner: identity.isMasterOwner ?? null,
      profileEmail: identity.profile?.email || null,
    },
    token,
    accessToken: auth.data?.AuthenticationResult?.AccessToken || null,
    refreshToken: auth.data?.AuthenticationResult?.RefreshToken || null,
    expiresIn: auth.data?.AuthenticationResult?.ExpiresIn || null,
  };
};

const main = async () => {
  await assumeCursorRole('moov-billing-owner-token');
  const password = secretString('checksops/staging/master-uat-password');
  const owner = await mint(OWNER_EMAIL, password);
  const tester = await mint(TESTER_EMAIL, password);
  const report = {
    generatedAt: new Date().toISOString(),
    owner: { ...owner, token: Boolean(owner.token) },
    tester: { ...tester, token: Boolean(tester.token) },
  };
  await mkdir(OUT, { recursive: true });
  await writeFile(`${OUT}/staging-owner-token.json`, JSON.stringify(report, null, 2));
  if (owner.token) {
    await writeFile(`${OUT}/.staging-owner.jwt.json`, JSON.stringify({
      idToken: owner.token,
      accessToken: owner.accessToken,
      refreshToken: owner.refreshToken,
      expiresIn: owner.expiresIn,
      email: OWNER_EMAIL,
    }));
  }
  if (tester.token) {
    await writeFile(`${OUT}/.staging-tester.jwt.json`, JSON.stringify({
      idToken: tester.token,
      accessToken: tester.accessToken,
      refreshToken: tester.refreshToken,
      expiresIn: tester.expiresIn,
      email: TESTER_EMAIL,
    }));
  }
  console.log(JSON.stringify(report, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
