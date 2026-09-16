import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  FAILED_WRONG_AUTH_BUNDLE,
  assertAwsSpaBuildEnv,
  guardProductionSpaRelease,
  scanProductionSpaArtifact,
  smokeArtifactHttpServer,
  validateProductionSpaAuthApi,
} from '../../scripts/lib/production-spa-auth-api-gate.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURES = path.join(ROOT, 'aws/tests/fixtures/spa-auth-api-gate');

const weakScanWouldPass = (text) => (
  text.includes('cognito')
  && text.includes('/prep')
  && text.includes('moov-wallet-fund')
  && text.includes('moov-disburse')
);

test('index-AfZ8zj4L.js wrong-auth build is rejected before S3/CloudFront mutation', async () => {
  const distDir = path.join(FIXTURES, 'index-AfZ8zj4L');
  const text = fs.readFileSync(path.join(distDir, 'assets', FAILED_WRONG_AUTH_BUNDLE), 'utf8');
  assert.equal(weakScanWouldPass(text), true, 'the previous scanner treated source literals + money UI as proof');
  const mutations = [];
  const result = guardProductionSpaRelease({
    distDir,
    apply: false,
    s3Upload: async () => { mutations.push('s3'); },
    cloudfrontInvalidate: async () => { mutations.push('cloudfront'); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.uploaded, false);
  assert.equal(result.cloudfrontInvalidated, false);
  assert.equal(result.error, 'production_spa_auth_api_gate_rejected');
  assert.equal(result.validation.failedBundle, true);
  assert.ok(result.validation.missing.includes('cognito_auth_mode'));
  assert.ok(result.validation.missing.includes('production_cognito_pool'));
  assert.ok(result.validation.missing.includes('production_api_prep'));
  assert.ok(result.validation.forbidden.includes('blank_supabase_init'));
  assert.equal(result.validation.smoke.stuckOnLoadingShell, true);
  assert.equal(result.validation.smoke.canMount, false);
  assert.deepEqual(mutations, []);

  const applyBad = guardProductionSpaRelease({
    distDir,
    apply: true,
    s3Upload: async () => { mutations.push('s3-apply'); },
    cloudfrontInvalidate: async () => { mutations.push('cf-apply'); },
  });
  assert.equal(applyBad.ok, false);
  assert.equal(applyBad.uploaded, false);
  assert.equal(applyBad.cloudfrontInvalidated, false);
  assert.deepEqual(mutations, []);

  const deployFacing = scanProductionSpaArtifact(distDir);
  assert.equal(deployFacing.ok, false);
  assert.ok(deployFacing.forbidden.includes('blank_supabase_init'));
  assert.ok(deployFacing.moneyCounts['moov-wallet-fund'] >= 1);
});

test('known-good Cognito /prep artifact passes the auth/API gate and can mount /freedom/login', async () => {
  const distDir = path.join(FIXTURES, 'index-C_NPDCdc');
  const validation = validateProductionSpaAuthApi(distDir, { requireProof: true });
  assert.equal(validation.ok, true, JSON.stringify(validation, null, 2));
  assert.equal(validation.proof.auth, 'cognito');
  assert.equal(validation.proof.api, '/prep');
  assert.equal(validation.smoke.canMount, true);
  assert.equal(validation.smoke.stuckOnLoadingShell, false);
  const httpSmoke = await smokeArtifactHttpServer(distDir, { pathName: '/freedom/login' });
  assert.equal(httpSmoke.ok, true);
  assert.equal(httpSmoke.servedIndex, true);
  const gated = guardProductionSpaRelease({ distDir });
  assert.equal(gated.ok, true);
  assert.equal(gated.uploaded, false);
  assert.equal(gated.cloudfrontInvalidated, false);
  const deployFacing = scanProductionSpaArtifact(distDir, { requireProof: true });
  assert.equal(deployFacing.ok, true, JSON.stringify(deployFacing, null, 2));
});

test('known-good rollback without spa.proof still passes when production pool/client are inlined', () => {
  const distDir = path.join(FIXTURES, 'index-C_NPDCdc-rollback');
  const validation = validateProductionSpaAuthApi(distDir, { requireProof: false });
  assert.equal(validation.ok, true, JSON.stringify(validation, null, 2));
  assert.equal(validation.proof, null);
  assert.equal(validation.userPoolId, 'us-east-1_h00WorYMT');
  assert.equal(validation.apiTarget, '/prep');
  assert.equal(validation.smoke.canMount, true);
  const requireProof = validateProductionSpaAuthApi(distDir, { requireProof: true });
  assert.equal(requireProof.ok, false);
  assert.ok(requireProof.missing.includes('spa_release_proof'));
});

test('staging Cognito/API artifact cannot pass the production release gate', () => {
  const distDir = path.join(FIXTURES, 'staging-cognito');
  const validation = validateProductionSpaAuthApi(distDir);
  assert.equal(validation.ok, false);
  assert.ok(validation.forbidden.includes('staging_cognito_pool'));
  assert.ok(validation.forbidden.includes('staging_api'));
  assert.ok(validation.missing.includes('production_api_prep'));
});

test('vite build --mode aws without production Cognito/API env fails closed', () => {
  assert.throws(
    () => assertAwsSpaBuildEnv({ mode: 'aws', env: {} }),
    /VITE_AUTH_PROVIDER=cognito/,
  );
  assert.throws(
    () => assertAwsSpaBuildEnv({
      mode: 'aws',
      env: { VITE_AUTH_PROVIDER: 'cognito' },
    }),
    /VITE_CHECKSOPS_API_URL/,
  );
  assert.throws(
    () => assertAwsSpaBuildEnv({
      mode: 'aws',
      env: {
        VITE_AUTH_PROVIDER: 'cognito',
        VITE_CHECKSOPS_API_URL: '/prep',
      },
      processEnv: { CHECKSOPS_PRODUCTION_SPA: '1' },
    }),
    /VITE_COGNITO_USER_POOL_ID/,
  );
  const staging = assertAwsSpaBuildEnv({
    mode: 'aws',
    env: {
      VITE_AUTH_PROVIDER: 'cognito',
      VITE_CHECKSOPS_API_URL: 'https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging',
      VITE_COGNITO_USER_POOL_ID: 'us-east-1_vPmQ7cL1F',
      VITE_COGNITO_USER_POOL_CLIENT_ID: '71bb7a192cbl6o6s8m259tl589',
    },
  });
  assert.equal(staging.ok, true);
  assert.equal(staging.production, false);
  const production = assertAwsSpaBuildEnv({
    mode: 'aws',
    env: {
      VITE_AUTH_PROVIDER: 'cognito',
      VITE_CHECKSOPS_API_URL: '/prep',
      VITE_COGNITO_USER_POOL_ID: 'us-east-1_h00WorYMT',
      VITE_COGNITO_USER_POOL_CLIENT_ID: '3ja9fqaq2fjkv3i6up2varcqpe',
    },
    processEnv: { CHECKSOPS_PRODUCTION_SPA: '1' },
  });
  assert.equal(production.ok, true);
  assert.equal(production.production, true);
});

test('non-aws vite modes are not blocked by the production SPA gate', () => {
  const result = assertAwsSpaBuildEnv({
    mode: 'production',
    env: { VITE_SUPABASE_URL: 'https://nbcqwpysqgyxrrbgtmkw.supabase.co' },
  });
  assert.equal(result.ok, true);
});

test('apply path never mutates S3/CloudFront from the guard module', () => {
  const distDir = path.join(FIXTURES, 'index-C_NPDCdc');
  assert.throws(
    () => guardProductionSpaRelease({
      distDir,
      apply: true,
      s3Upload: async () => {},
      cloudfrontInvalidate: async () => {},
    }),
    /production_spa_apply_refused_in_guard/,
  );
});

test('vite build --mode aws without required env fails during build', () => {
  const viteBin = path.join(ROOT, 'node_modules', '.bin', 'vite');
  assert.equal(fs.existsSync(viteBin), true, 'vite binary must exist');
  const result = spawnSync(viteBin, ['build', '--mode', 'aws'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      VITE_AUTH_PROVIDER: '',
      VITE_CHECKSOPS_API_URL: '',
      CHECKSOPS_PRODUCTION_SPA: '',
    },
  });
  assert.notEqual(result.status, 0);
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  assert.match(output, /VITE_AUTH_PROVIDER=cognito|aws_spa_build_env_rejected/);
});

test('guard CLI rejects AfZ8zj4L and refuses --apply', () => {
  const guard = path.join(ROOT, 'scripts/guard-production-spa-release.mjs');
  const rejected = spawnSync(process.execPath, [guard, '--dir', path.join(FIXTURES, 'index-AfZ8zj4L')], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(rejected.status, 1);
  const payload = JSON.parse(rejected.stderr || rejected.stdout);
  assert.equal(payload.uploaded, false);
  assert.equal(payload.cloudfrontInvalidated, false);
  assert.equal(payload.error, 'production_spa_auth_api_gate_rejected');

  const apply = spawnSync(process.execPath, [
    guard,
    '--dir', path.join(FIXTURES, 'index-C_NPDCdc'),
    '--apply',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.notEqual(apply.status, 0);
  const applyOut = `${apply.stdout || ''}\n${apply.stderr || ''}`;
  assert.match(applyOut, /production_spa_apply_refused/);
  assert.doesNotMatch(applyOut, /s3Uploaded": true/);
});
