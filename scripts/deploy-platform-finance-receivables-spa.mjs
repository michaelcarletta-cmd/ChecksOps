#!/usr/bin/env node
/**
 * Deploy Platform Finance receivables SPA to staging only.
 */
import { execFileSync } from 'node:child_process';
import { assumeCursorRole } from './lib/assume-cursor-role.mjs';

const AWS = process.env.AWS_CLI || '/usr/local/bin/aws';
const REGION = 'us-east-1';
const BUCKET = 'checksops-staging-frontend-c48b';
const DIST = 'E1CG52WRQZI7X1';
const TARGET = process.argv[2] || 'staging';

const main = async () => {
  if (TARGET === 'production') throw new Error('This SPA deploy refuses production.');
  await assumeCursorRole('platform-finance-receivables-spa');
  execFileSync('npm', ['run', 'build:aws'], { stdio: 'inherit', cwd: '/workspace' });
  execFileSync(AWS, ['--region', REGION, 's3', 'sync', 'dist/', `s3://${BUCKET}/`, '--delete'], {
    stdio: 'inherit',
    cwd: '/workspace',
  });
  execFileSync(AWS, [
    '--region', REGION, 'cloudfront', 'create-invalidation',
    '--distribution-id', DIST,
    '--paths', '/*',
  ], { stdio: 'inherit' });
  console.log(JSON.stringify({ bucket: BUCKET, distribution: DIST, productionTouched: false }));
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
