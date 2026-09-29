#!/usr/bin/env node
/**
 * Staging-only: mint a Cognito JWT for a known UAT user without using /auth/login.
 * Prints token presence only when used as a library. Does not log secrets.
 */
import { execFileSync } from 'node:child_process';
import http from 'node:http';

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const POOL = 'us-east-1_vPmQ7cL1F';
const CLIENT = '71bb7a192cbl6o6s8m259tl589';

export const oidcToken = () => new Promise((resolve, reject) => {
  const req = http.request({
    socketPath: '/run/cursor/api.sock',
    path: '/v1/tokens/oidc',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  }, (res) => {
    const chunks = [];
    res.on('data', (d) => chunks.push(d));
    res.on('end', () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed.token || parsed.oidcToken || parsed);
      } catch (error) { reject(error); }
    });
  });
  req.on('error', reject);
  req.write(JSON.stringify({ aud: 'sts.amazonaws.com' }));
  req.end();
});

export const assumeCursorRole = async (session = 'moov-billing-cognito-token') => {
  const creds = JSON.parse(execFileSync(AWS, [
    'sts', 'assume-role-with-web-identity',
    '--role-arn', process.env.CURSOR_AWS_ASSUME_IAM_ROLE_ARN,
    '--role-session-name', session,
    '--web-identity-token', String(await oidcToken()),
    '--duration-seconds', '3600',
    '--output', 'json',
  ], { encoding: 'utf8' })).Credentials;
  process.env.AWS_ACCESS_KEY_ID = creds.AccessKeyId;
  process.env.AWS_SECRET_ACCESS_KEY = creds.SecretAccessKey;
  process.env.AWS_SESSION_TOKEN = creds.SessionToken;
  process.env.AWS_REGION = REGION;
};

const awsJson = (args) => {
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], { encoding: 'utf8' });
  return out.trim() ? JSON.parse(out) : {};
};

export const secretString = (id) => {
  const secret = awsJson(['secretsmanager', 'get-secret-value', '--secret-id', id]);
  const raw = secret.SecretString || '';
  try {
    const parsed = JSON.parse(raw);
    return parsed.password || parsed.PASSWORD || parsed.value || parsed.token || raw;
  } catch {
    return raw;
  }
};

const cognitoJson = async (target, payload) => {
  const res = await fetch('https://cognito-idp.us-east-1.amazonaws.com/', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-target': `AWSCognitoIdentityProviderService.${target}`,
    },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
};

export const masterToken = async () => {
  const password = secretString('checksops/staging/master-uat-password');
  const user = 'staging-master@checksops.invalid';
  const userPass = await cognitoJson('InitiateAuth', {
    AuthFlow: 'USER_PASSWORD_AUTH',
    ClientId: CLIENT,
    AuthParameters: { USERNAME: user, PASSWORD: password },
  });
  if (userPass.body?.AuthenticationResult?.IdToken) {
    return { ok: true, source: 'USER_PASSWORD_AUTH', authentication: userPass.body.AuthenticationResult };
  }
  try {
    const admin = awsJson([
      'cognito-idp', 'admin-initiate-auth',
      '--user-pool-id', POOL,
      '--client-id', CLIENT,
      '--auth-flow', 'ADMIN_USER_PASSWORD_AUTH',
      '--auth-parameters', `USERNAME=${user},PASSWORD=${password}`,
    ]);
    if (admin.AuthenticationResult?.IdToken) {
      return { ok: true, source: 'ADMIN_USER_PASSWORD_AUTH', authentication: admin.AuthenticationResult };
    }
    return { ok: false, source: 'ADMIN_USER_PASSWORD_AUTH', error: admin };
  } catch (error) {
    return {
      ok: false,
      userPassword: { status: userPass.status, error: userPass.body?.__type || userPass.body?.message || null },
      admin: String(error.stderr || error.message || error).slice(0, 400),
    };
  }
};
