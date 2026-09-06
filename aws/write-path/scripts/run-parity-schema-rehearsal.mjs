/**
 * Isolated RDS inspect + optional 38_*.sql apply.
 * Never mutates live checksops. Never recreates checksops_rehearsal_20260906.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateParitySql } from './validate-parity-schema.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..', '..');
const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = process.env.AWS_REGION || 'us-east-1';
const LAMBDA_NAME = process.env.REHEARSAL_LAMBDA_NAME || 'checksops-staging-rehearsal-oneshot';
const TIMED_DB = 'checksops_rehearsal_20260906';
const APPLY_DB = process.env.PARITY_REHEARSAL_DB || TIMED_DB;

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
      const body = Buffer.concat(chunks).toString('utf8');
      try {
        const parsed = JSON.parse(body);
        resolve(parsed.token || parsed.oidcToken || parsed);
      } catch {
        reject(new Error('oidc parse failed'));
      }
    });
  });
  req.on('error', reject);
  req.write(JSON.stringify({ aud: 'sts.amazonaws.com' }));
  req.end();
});

const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' });

const assumeRole = async () => {
  const role = process.env.CURSOR_AWS_ASSUME_IAM_ROLE_ARN;
  if (!role) throw new Error('CURSOR_AWS_ASSUME_IAM_ROLE_ARN missing');
  const token = await oidcToken();
  const out = run(AWS, [
    'sts', 'assume-role-with-web-identity',
    '--role-arn', role,
    '--role-session-name', 'checksops-parity-schema',
    '--web-identity-token', String(token),
    '--duration-seconds', '3600',
    '--output', 'json',
  ]);
  const creds = JSON.parse(out).Credentials;
  process.env.AWS_ACCESS_KEY_ID = creds.AccessKeyId;
  process.env.AWS_SECRET_ACCESS_KEY = creds.SecretAccessKey;
  process.env.AWS_SESSION_TOKEN = creds.SessionToken;
  process.env.AWS_REGION = REGION;
  process.env.AWS_DEFAULT_REGION = REGION;
};

const invokeLambda = (payload) => {
  const outFile = path.join(os.tmpdir(), `parity-oneshot-${Date.now()}.json`);
  run(AWS, [
    'lambda', 'invoke',
    '--function-name', LAMBDA_NAME,
    '--cli-binary-format', 'raw-in-base64-out',
    '--payload', JSON.stringify(payload),
    outFile,
  ]);
  const raw = fs.readFileSync(outFile, 'utf8');
  return JSON.parse(raw);
};

const main = async () => {
  const local = validateParitySql();
  if (!local.ok) {
    console.error(JSON.stringify({ step: 'local_sql', ...local }, null, 2));
    process.exit(1);
  }
  if (process.argv.includes('--local-only')) {
    console.log(JSON.stringify({ ok: true, local }, null, 2));
    return;
  }
  await assumeRole();
  const inspect = invokeLambda({ step: 'inspect_return_columns', database: 'checksops' });
  let apply = null;
  if (process.argv.includes('--apply')) {
    if (APPLY_DB === 'checksops') {
      throw new Error('refusing apply to checksops');
    }
    apply = invokeLambda({ step: 'apply_parity_ddl', database: APPLY_DB });
  }
  const report = {
    ok: inspect.ok !== false && (apply ? apply.ok !== false : true),
    productionSupabaseChanged: false,
    liveChecksopsMutated: false,
    timedRehearsalRecreated: false,
    local,
    inspect,
    apply,
    applyDatabase: apply ? APPLY_DB : null,
    root: ROOT,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(1);
};

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error.message || error).slice(0, 400) }, null, 2));
  process.exit(1);
});
