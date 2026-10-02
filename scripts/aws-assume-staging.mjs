#!/usr/bin/env node
/**
 * Assume ChecksOpsCursorCloudStaging and write Cognito tester passwords
 * to /tmp/cognito-login-passwords.json. Never prints secret values.
 */
import { spawn } from 'node:child_process';
import { writeFile, unlink, mkdir } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

const AWS = process.env.AWS_CLI || (await import('node:fs')).existsSync(`${process.env.HOME}/.local/bin/aws`)
  ? `${process.env.HOME}/.local/bin/aws`
  : 'aws';
const REGION = 'us-east-1';
const OUT = process.env.COGNITO_PASSWORD_FILE || '/tmp/cognito-login-passwords.json';
const HINT = /cognito|password|tester|t0|login|identity|master-uat/i;

const run = (cmd, args, env = process.env) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (d) => stdout.push(d));
  child.stderr.on('data', (d) => stderr.push(d));
  child.on('close', (code) => {
    const out = Buffer.concat(stdout).toString('utf8');
    const err = Buffer.concat(stderr).toString('utf8');
    if (code === 0) resolve(out);
    else reject(new Error(`${cmd} failed (${code}): ${(err || out).slice(0, 400)}`));
  });
});

const oidcToken = () => new Promise((resolve, reject) => {
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
      } catch (e) { reject(e); }
    });
  });
  req.on('error', reject);
  req.write(JSON.stringify({ aud: 'sts.amazonaws.com' }));
  req.end();
});

const main = async () => {
  const role = process.env.CURSOR_AWS_ASSUME_IAM_ROLE_ARN;
  if (!role) throw new Error('CURSOR_AWS_ASSUME_IAM_ROLE_ARN missing');
  const token = await oidcToken();
  const work = '/tmp/checksops-aws-assume';
  await mkdir(work, { recursive: true });
  const tokenFile = path.join(work, 'oidc.jwt');
  await writeFile(tokenFile, String(token), { mode: 0o600 });
  const assumed = JSON.parse(await run(AWS, [
    'sts', 'assume-role-with-web-identity',
    '--role-arn', role,
    '--role-session-name', 'phase1-money-path-audit',
    '--web-identity-token', String(token),
    '--duration-seconds', '3600',
    '--output', 'json',
  ]));
  await unlink(tokenFile).catch(() => {});
  const env = {
    ...process.env,
    AWS_ACCESS_KEY_ID: assumed.Credentials.AccessKeyId,
    AWS_SECRET_ACCESS_KEY: assumed.Credentials.SecretAccessKey,
    AWS_SESSION_TOKEN: assumed.Credentials.SessionToken,
    AWS_REGION: REGION,
    AWS_DEFAULT_REGION: REGION,
  };
  const credsFile = '/tmp/checksops-aws-creds.env';
  await writeFile(credsFile, [
    `export AWS_ACCESS_KEY_ID=${assumed.Credentials.AccessKeyId}`,
    `export AWS_SECRET_ACCESS_KEY=${assumed.Credentials.SecretAccessKey}`,
    `export AWS_SESSION_TOKEN=${assumed.Credentials.SessionToken}`,
    `export AWS_REGION=${REGION}`,
    `export AWS_DEFAULT_REGION=${REGION}`,
  ].join('\n') + '\n', { mode: 0o600 });

  const names = JSON.parse(await run(AWS, [
    'secretsmanager', 'list-secrets',
    '--query', 'SecretList[].Name',
    '--output', 'json',
  ], env));
  const hints = (names || []).filter((n) => HINT.test(String(n)));
  const passwords = {};
  const usedSecrets = [];
  for (const name of hints) {
    try {
      const raw = (await run(AWS, [
        'secretsmanager', 'get-secret-value',
        '--secret-id', name,
        '--query', 'SecretString',
        '--output', 'text',
      ], env)).trim();
      let parsed = raw;
      try { parsed = JSON.parse(raw); } catch { parsed = null; }
      if (parsed && typeof parsed === 'object') {
        let used = false;
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'string' && v.length >= 8) {
            passwords[k] = v;
            used = true;
          }
        }
        if (used) usedSecrets.push(name);
      }
    } catch {
      /* ignore inaccessible secrets */
    }
  }
  await writeFile(OUT, JSON.stringify(passwords, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({
    ok: true,
    credsFile,
    passwordFile: OUT,
    passwordKeys: Object.keys(passwords).sort(),
    secretHints: hints,
    usedSecrets,
    assumed: true,
  }, null, 2));
};

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
