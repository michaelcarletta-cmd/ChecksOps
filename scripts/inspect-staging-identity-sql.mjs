#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assumeCursorRole } from './cognito-staging-token.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const NAME = 'checksops-staging-identity-inspect-2d41';
const OUT = '/opt/cursor/artifacts/moov-monthly-billing-preprod';

const awsJson = (args) => {
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], { encoding: 'utf8' });
  return out.trim() ? JSON.parse(out) : {};
};
const waitFn = (name) => {
  try { execFileSync(AWS, ['--region', REGION, 'lambda', 'wait', 'function-updated', '--function-name', name]); } catch { /* ok */ }
  try { execFileSync(AWS, ['--region', REGION, 'lambda', 'wait', 'function-active', '--function-name', name]); } catch { /* ok */ }
};

const handler = `import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
const { Client } = pg;
const CA_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'rds-global-bundle.pem');
export const handler = async () => {
  const sm = new SecretsManagerClient({});
  const secret = await sm.send(new GetSecretValueCommand({ SecretId: process.env.ADMIN_SECRET_ARN }));
  const parsed = JSON.parse(secret.SecretString);
  const host = parsed.host && parsed.host !== 'localhost' ? parsed.host : process.env.RDS_HOST;
  const client = new Client({
    host, port: Number(parsed.port || 5432), user: parsed.username, password: parsed.password,
    database: 'checksops',
    ssl: { rejectUnauthorized: true, ca: fs.readFileSync(CA_PATH, 'utf8') },
    connectionTimeoutMillis: 8000, query_timeout: 20000,
  });
  await client.connect();
  try {
    const identity = (await client.query(\`
      SELECT application_user_id, cognito_sub, email, status
      FROM public.identity_accounts
      WHERE email ILIKE '%checksopsadmin%'
         OR email ILIKE '%staging-master%'
         OR email ILIKE '%checksops-tester%'
         OR email ILIKE '%mcarletta%'
         OR application_user_id = '7dbb3009-f059-4767-b5dc-1c5c72379330'
         OR application_user_id = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91'
         OR cognito_sub = '54a8b4c8-60d1-7028-cfbb-0eb2baee5592'
         OR cognito_sub = 'c4386408-60e1-70e2-abb6-e6194e8e635f'
      ORDER BY email
    \`)).rows;
    const profiles = (await client.query(\`
      SELECT id, email, full_name
      FROM public.profiles
      WHERE id IN (
        '7dbb3009-f059-4767-b5dc-1c5c72379330',
        'abd3c2a0-6dc0-4680-92dd-a013e1141c91'
      ) OR email ILIKE '%checksopsadmin%'
    \`)).rows;
    const methodCols = (await client.query(\`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'payment_provider_methods'
      ORDER BY 1
    \`)).rows.map((row) => row.column_name);
    const methods = (await client.query(\`
      SELECT tenant_id, provider_payment_method_id, last_four, connection_status, environment
      FROM public.payment_provider_methods
      WHERE tenant_id IN (
        '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a',
        '4f172140-f57a-4744-8050-95f4f07b13b4'
      )
    \`)).rows;
    const tenantAdmins = (await client.query(\`
      SELECT tu.tenant_id, t.slug, tu.user_id, tu.role, p.email
      FROM public.tenant_users tu
      JOIN public.tenants t ON t.id = tu.tenant_id
      LEFT JOIN public.profiles p ON p.id = tu.user_id
      WHERE tu.tenant_id IN (
        '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a',
        '4f172140-f57a-4744-8050-95f4f07b13b4'
      )
      ORDER BY t.slug, tu.role
    \`)).rows;
    return { ok: true, identity, profiles, methodCols, methods, tenantAdmins };
  } finally {
    await client.end();
  }
};
`;

const main = async () => {
  await assumeCursorRole('moov-billing-identity-sql');
  const rehearsal = awsJson(['lambda', 'get-function-configuration', '--function-name', 'checksops-staging-rehearsal-oneshot']);
  const api = awsJson(['lambda', 'get-function-configuration', '--function-name', 'checksops-staging-api']);
  const staging = path.join(os.tmpdir(), 'checksops-identity-inspect');
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  await writeFile(path.join(staging, 'index.mjs'), handler);
  await writeFile(path.join(staging, 'package.json'), JSON.stringify({
    type: 'module',
    dependencies: { '@aws-sdk/client-secrets-manager': '3.1124.0', pg: '8.23.0' },
  }));
  await copyFile(path.join(ROOT, 'aws/rls/oneshot/rds-global-bundle.pem'), path.join(staging, 'rds-global-bundle.pem'));
  execFileSync('npm', ['install', '--omit=dev'], { cwd: staging, stdio: 'ignore' });
  const zip = path.join(os.tmpdir(), 'checksops-identity-inspect.zip');
  await rm(zip, { force: true });
  execFileSync('zip', ['-qr', zip, '.'], { cwd: staging });
  const env = {
    Variables: {
      ADMIN_SECRET_ARN: rehearsal.Environment.Variables.ADMIN_SECRET_ARN,
      RDS_HOST: rehearsal.Environment.Variables.RDS_HOST,
    },
  };
  try {
    awsJson(['lambda', 'get-function', '--function-name', NAME]);
    awsJson(['lambda', 'update-function-code', '--function-name', NAME, '--zip-file', `fileb://${zip}`]);
    waitFn(NAME);
    awsJson(['lambda', 'update-function-configuration', '--function-name', NAME, '--timeout', '60', '--environment', JSON.stringify(env)]);
  } catch {
    const vpc = api.VpcConfig || {};
    awsJson([
      'lambda', 'create-function', '--function-name', NAME, '--runtime', 'nodejs20.x',
      '--role', rehearsal.Role, '--handler', 'index.handler', '--timeout', '60',
      '--memory-size', '256', '--zip-file', `fileb://${zip}`,
      '--environment', JSON.stringify(env),
      '--vpc-config', `SubnetIds=${vpc.SubnetIds.join(',')},SecurityGroupIds=${vpc.SecurityGroupIds.join(',')}`,
    ]);
  }
  waitFn(NAME);
  const outFile = path.join(os.tmpdir(), `identity-inspect-${Date.now()}.json`);
  execFileSync(AWS, ['--region', REGION, 'lambda', 'invoke', '--function-name', NAME, outFile]);
  const payload = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  await mkdir(OUT, { recursive: true });
  await writeFile(path.join(OUT, 'staging-identity.json'), JSON.stringify(payload, null, 2));
  console.log(JSON.stringify(payload, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
