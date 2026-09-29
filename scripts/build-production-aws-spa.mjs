#!/usr/bin/env node
/**
 * Production AWS SPA build. Does not use `vite --mode aws` (.env.aws is staging).
 * Matches the last accepted production frontend contract:
 *   vite build --mode production
 *   VITE_AUTH_PROVIDER=cognito
 *   VITE_APP_URL=https://checksops.com
 *   VITE_CHECKSOPS_API_URL=/prep
 *   VITE_COGNITO_USER_POOL_ID=us-east-1_h00WorYMT
 *   VITE_COGNITO_USER_POOL_CLIENT_ID=3ja9fqaq2fjkv3i6up2varcqpe
 *
 * Writes an ephemeral .env.production.local (gitignored) and removes it after build.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.CHECKSOPS_SPA_OUTDIR || path.join(ROOT, 'dist');
const PROD_POOL = 'us-east-1_h00WorYMT';
const PROD_CLIENT = '3ja9fqaq2fjkv3i6up2varcqpe';
const localEnv = path.join(ROOT, '.env.production.local');

const envLines = [
  'VITE_AUTH_PROVIDER=cognito',
  'VITE_APP_URL=https://checksops.com',
  'VITE_CHECKSOPS_API_URL=/prep',
  'VITE_AWS_REGION=us-east-1',
  `VITE_COGNITO_USER_POOL_ID=${PROD_POOL}`,
  `VITE_COGNITO_USER_POOL_CLIENT_ID=${PROD_CLIENT}`,
  '',
];

fs.writeFileSync(localEnv, envLines.join('\n'));
const built = spawnSync('npx', ['vite', 'build', '--mode', 'production', '--outDir', OUT], {
  cwd: ROOT,
  env: {
    ...process.env,
    VITE_AUTH_PROVIDER: 'cognito',
    VITE_APP_URL: 'https://checksops.com',
    VITE_CHECKSOPS_API_URL: '/prep',
    VITE_AWS_REGION: 'us-east-1',
    VITE_COGNITO_USER_POOL_ID: PROD_POOL,
    VITE_COGNITO_USER_POOL_CLIENT_ID: PROD_CLIENT,
  },
  encoding: 'utf8',
  timeout: 180000,
});
fs.rmSync(localEnv, { force: true });
if (built.status !== 0) {
  console.error(built.stdout);
  console.error(built.stderr);
  process.exit(built.status || 1);
}

const indexHtml = fs.readFileSync(path.join(OUT, 'index.html'), 'utf8');
const entry = (indexHtml.match(/src="(\/assets\/index-[^"]+\.js)"/) || [])[1];
if (!entry) {
  console.error('no entry in index.html');
  process.exit(2);
}
const entryPath = path.join(OUT, entry.slice(1));
const entryJs = fs.readFileSync(entryPath, 'utf8');
const indexSha = createHash('sha256').update(fs.readFileSync(path.join(OUT, 'index.html'))).digest('hex');
const errors = [];
if (entryJs.includes('psr19uhop4')) errors.push('staging execute-api present');
if (entryJs.includes('us-east-1_vPmQ7cL1F')) errors.push('staging Cognito pool present');
if (entryJs.includes('71bb7a192cbl6o6s8m259tl589')) errors.push('staging Cognito client present');
if (!entryJs.includes('function Nn(){const e="/prep"') && !entryJs.includes('const e="/prep"')) {
  // fallback: require the baked awsApiBaseUrl token
  if (!/function Nn\(\)\{const e="\/prep"/.test(entryJs) && !entryJs.includes('e="/prep"')) {
    errors.push('production /prep API token not found in entry');
  }
}
if (!entryJs.includes('QA("https://checksops.com")') && !entryJs.includes('"https://checksops.com"')) {
  errors.push('production VITE_APP_URL not found');
}
if (entryJs.includes('QA("https://staging.checksops.com")')) {
  errors.push('staging VITE_APP_URL still baked');
}
const ccc = fs.readdirSync(path.join(OUT, 'assets')).find((n) => n.startsWith('CheckCommandCenter-')) || null;
const report = {
  ok: errors.length === 0,
  errors,
  command: 'npx vite build --mode production --outDir dist',
  env: {
    VITE_AUTH_PROVIDER: 'cognito',
    VITE_APP_URL: 'https://checksops.com',
    VITE_CHECKSOPS_API_URL: '/prep',
    VITE_COGNITO_USER_POOL_ID: PROD_POOL,
    VITE_COGNITO_USER_POOL_CLIENT_ID: PROD_CLIENT,
  },
  index_sha256: indexSha,
  entry,
  claim_check: ccc ? `assets/${ccc}` : null,
};
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exit(2);
