import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { spawn } from 'node:child_process';

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;

const oidcToken = () => new Promise((resolve, reject) => {
  const req = http.request({
    socketPath: '/run/cursor/api.sock', path: '/v1/tokens/oidc', method: 'POST',
    headers: { 'content-type': 'application/json' },
  }, (res) => {
    const chunks = [];
    res.on('data', (d) => chunks.push(d));
    res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString()).token));
  });
  req.on('error', reject);
  req.write(JSON.stringify({ aud: 'sts.amazonaws.com' }));
  req.end();
});

const token = await oidcToken();
const cwlogsRole = process.env.CURSOR_AWS_CLOUDTRAIL_CWLOGS_ROLE_ARN;
const hardeningRole = process.env.CURSOR_AWS_SECURITY_HARDENING_ROLE_ARN;
const roleArn = cwlogsRole || hardeningRole || process.env.CURSOR_AWS_ASSUME_IAM_ROLE_ARN;
if (!roleArn) {
  console.error('Set CURSOR_AWS_ASSUME_IAM_ROLE_ARN, CURSOR_AWS_SECURITY_HARDENING_ROLE_ARN, or CURSOR_AWS_CLOUDTRAIL_CWLOGS_ROLE_ARN');
  process.exit(1);
}
const sessionName = cwlogsRole
  ? 'checksops-ct-cwlogs'
  : hardeningRole
    ? 'checksops-sec-hard'
    : 'checksops-t0-run';
const creds = JSON.parse(execFileSync(AWS, [
  'sts', 'assume-role-with-web-identity',
  '--role-arn', roleArn,
  '--role-session-name', sessionName,
  '--web-identity-token', String(token),
  '--duration-seconds', '3600',
  '--output', 'json',
], { encoding: 'utf8' })).Credentials;
process.env.AWS_ACCESS_KEY_ID = creds.AccessKeyId;
process.env.AWS_SECRET_ACCESS_KEY = creds.SecretAccessKey;
process.env.AWS_SESSION_TOKEN = creds.SessionToken;
process.env.AWS_REGION = 'us-east-1';
const child = spawn(process.execPath, process.argv.slice(2), { stdio: 'inherit', env: process.env });
child.on('exit', (code) => process.exit(code || 0));
