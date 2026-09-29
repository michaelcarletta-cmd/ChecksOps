#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';

const OUT = '/opt/cursor/artifacts/moov-monthly-billing-preprod';
const API = 'https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging';

const sessionFor = async (name) => {
  const tokens = JSON.parse(await readFile(`${OUT}/.staging-${name}.jwt.json`, 'utf8'));
  const res = await fetch(`${API}/identity/me`, { headers: { authorization: `Bearer ${tokens.idToken}` } });
  const identity = await res.json();
  const email = identity.profile?.email || tokens.email;
  const now = new Date().toISOString();
  const expiresAt = Math.floor(Date.now() / 1000) + Number(tokens.expiresIn || 3600);
  const user = {
    id: identity.applicationUserId,
    aud: 'authenticated',
    role: 'authenticated',
    email,
    email_confirmed_at: now,
    phone: '',
    confirmed_at: now,
    last_sign_in_at: now,
    app_metadata: {
      provider: 'cognito',
      providers: ['cognito'],
      roles: identity.roles || [],
      tenant_roles: (identity.tenants || []).map((row) => row.role).filter(Boolean),
    },
    user_metadata: {
      email,
      full_name: identity.profile?.fullName || null,
      application_user_id: identity.applicationUserId,
    },
    identities: [],
    created_at: now,
    updated_at: now,
    is_anonymous: false,
  };
  return {
    tokens: {
      idToken: tokens.idToken,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
    },
    user,
    expiresAt,
  };
};

const owner = await sessionFor('owner');
const tester = await sessionFor('tester');
await writeFile(`${OUT}/.ui-owner-session.json`, JSON.stringify(owner));
await writeFile(`${OUT}/.ui-tester-session.json`, JSON.stringify(tester));
console.log(JSON.stringify({
  ownerId: owner.user.id,
  ownerEmail: owner.user.email,
  testerId: tester.user.id,
  testerEmail: tester.user.email,
  expiresAt: owner.expiresAt,
}, null, 2));
