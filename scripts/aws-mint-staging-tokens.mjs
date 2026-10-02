#!/usr/bin/env node
/**
 * Mint staging Cognito IdTokens for Freedom + C1C testers via
 * AdminSetUserPassword + AdminInitiateAuth. Does not use retired
 * /auth/login. Never prints passwords or tokens.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const AWS = process.env.AWS_CLI || 'aws';
const REGION = process.env.AWS_REGION || 'us-east-1';
const POOL = process.env.COGNITO_USER_POOL_ID || 'us-east-1_vPmQ7cL1F';
const CLIENT = process.env.COGNITO_CLIENT_ID || '71bb7a192cbl6o6s8m259tl589';
const OUT = process.env.STAGING_TOKEN_FILE || '/tmp/checksops-staging-tokens.json';
const USERS = [
  { label: 'freedom', email: 'checksops-tester@freedomadj.com' },
  { label: 'c1c', email: 'payments@condition1commercial.com' },
];

const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(AWS, ['--region', REGION, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (d) => stdout.push(d));
  child.stderr.on('data', (d) => stderr.push(d));
  child.on('close', (code) => {
    const out = Buffer.concat(stdout).toString('utf8');
    const err = Buffer.concat(stderr).toString('utf8');
    if (code === 0) resolve(out);
    else reject(new Error(`${args[0]} failed (${code}): ${(err || out).slice(0, 300)}`));
  });
});

const main = async () => {
  const minted = [];
  const tokens = {};
  for (const user of USERS) {
    const password = `P1-${randomBytes(24).toString('base64url')}!aA1`;
    await run([
      'cognito-idp', 'admin-set-user-password',
      '--user-pool-id', POOL,
      '--username', user.email,
      '--password', password,
      '--permanent',
    ]);
    const auth = JSON.parse(await run([
      'cognito-idp', 'admin-initiate-auth',
      '--user-pool-id', POOL,
      '--client-id', CLIENT,
      '--auth-flow', 'ADMIN_USER_PASSWORD_AUTH',
      '--auth-parameters', `USERNAME=${user.email},PASSWORD=${password}`,
      '--output', 'json',
    ]));
    const idToken = auth.AuthenticationResult?.IdToken;
    if (!idToken) throw new Error(`no id token for ${user.label} challenge=${auth.ChallengeName || 'none'}`);
    tokens[user.label] = idToken;
    tokens[user.email] = idToken;
    minted.push({ label: user.label, challenge: auth.ChallengeName || null, tokenChars: idToken.length });
  }
  await writeFile(OUT, JSON.stringify(tokens), { mode: 0o600 });
  console.log(JSON.stringify({
    ok: true,
    tokenFile: OUT,
    pool: POOL,
    client: CLIENT,
    minted,
    passwordLoginApiUnused: true,
  }, null, 2));
};

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
