#!/usr/bin/env node
/**
 * Build the Cognito production SPA and publish it to the unused production
 * CloudFront bucket. Does not change DNS. Attaches the issued ACM cert and
 * apex/www aliases only when --attach-aliases is passed.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const BUCKET = 'checksops-production-frontend-806168576068';
const DIST = 'E1B0ZWWO5559U5';
const ACM = 'arn:aws:acm:us-east-1:806168576068:certificate/5cdde8e7-49fb-4b42-ba36-9aaa9d9b1aa3';
const API = 'https://kiqojucc02.execute-api.us-east-1.amazonaws.com/prep';

if (!process.argv.includes('--confirm-t0-spa')) {
  console.error(JSON.stringify({ error: 'refusing_spa_deploy' }));
  process.exit(2);
}

const awsJson = (args) => JSON.parse(execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], { encoding: 'utf8' }) || '{}');

const workspaceEnv = '/workspace/.env.aws';
const backupEnv = join(tmpdir(), 'checksops-staging.env.aws.bak');
if (existsSync(workspaceEnv)) copyFileSync(workspaceEnv, backupEnv);
writeFileSync(workspaceEnv, [
  'VITE_AUTH_PROVIDER=cognito',
  'VITE_APP_URL=https://checksops.com',
  `VITE_CHECKSOPS_API_URL=${API}`,
  'VITE_AWS_REGION=us-east-1',
  'VITE_COGNITO_USER_POOL_ID=us-east-1_h00WorYMT',
  'VITE_COGNITO_USER_POOL_CLIENT_ID=3ja9fqaq2fjkv3i6up2varcqpe',
  '',
].join('\n'));
try {
  execFileSync('npm', ['run', 'build:aws'], {
    cwd: '/workspace',
    env: {
      ...process.env,
      VITE_AUTH_PROVIDER: 'cognito',
      VITE_APP_URL: 'https://checksops.com',
      VITE_CHECKSOPS_API_URL: API,
      VITE_AWS_REGION: 'us-east-1',
      VITE_COGNITO_USER_POOL_ID: 'us-east-1_h00WorYMT',
      VITE_COGNITO_USER_POOL_CLIENT_ID: '3ja9fqaq2fjkv3i6up2varcqpe',
    },
    stdio: 'inherit',
  });
} finally {
  if (existsSync(backupEnv)) copyFileSync(backupEnv, workspaceEnv);
}

execFileSync(AWS, ['--region', REGION, 's3', 'sync', '/workspace/dist', `s3://${BUCKET}/`, '--delete'], { stdio: 'inherit' });
awsJson(['cloudfront', 'create-invalidation', '--distribution-id', DIST, '--paths', '/*']);

let aliases = { attached: false };
if (process.argv.includes('--attach-aliases')) {
  const current = awsJson(['cloudfront', 'get-distribution-config', '--id', DIST]);
  const etag = current.ETag;
  const cfg = current.DistributionConfig;
  cfg.Aliases = { Quantity: 2, Items: ['checksops.com', 'www.checksops.com'] };
  cfg.ViewerCertificate = {
    ACMCertificateArn: ACM,
    SSLSupportMethod: 'sni-only',
    MinimumProtocolVersion: 'TLSv1.2_2021',
    Certificate: ACM,
    CertificateSource: 'acm',
    CloudFrontDefaultCertificate: false,
  };
  mkdirSync('/tmp/t0', { recursive: true });
  writeFileSync('/tmp/t0/cf-config.json', JSON.stringify(cfg));
  awsJson(['cloudfront', 'update-distribution', '--id', DIST, '--if-match', etag, '--distribution-config', 'file:///tmp/t0/cf-config.json']);
  aliases = { attached: true, items: ['checksops.com', 'www.checksops.com'], certificate: ACM };
}

const dist = awsJson(['cloudfront', 'get-distribution', '--id', DIST]).Distribution || {};
const report = {
  ok: true,
  bucket: BUCKET,
  distribution: DIST,
  domain: dist.DomainName,
  aliases: dist.DistributionConfig?.Aliases?.Items || [],
  cert: dist.DistributionConfig?.ViewerCertificate?.ACMCertificateArn || null,
  aliasUpdate: aliases,
  dnsChanged: false,
};
console.log(JSON.stringify(report, null, 2));
process.exit(0);
