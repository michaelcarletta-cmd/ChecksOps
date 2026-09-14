import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  PRODUCTION_SPA_LOCK,
  assertProductionSpaApplyAllowed,
  isValidatedAwsCognitoFingerprint,
} from '../../scripts/production-spa-lock.mjs';
import { scanProductionSpaArtifact } from '../../scripts/validate-production-spa-artifact.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('lock file matches the known-good production SPA', () => {
  assert.equal(PRODUCTION_SPA_LOCK.locked, true);
  assert.equal(PRODUCTION_SPA_LOCK.knownGood.gitCommit, '868e69387d63af511f4c185775b611dea2c8fc47');
  assert.equal(PRODUCTION_SPA_LOCK.knownGood.spaBundle, 'index-CiOVNYWh.js');
  assert.equal(PRODUCTION_SPA_LOCK.knownGood.cognitoPoolId, 'us-east-1_h00WorYMT');
  assert.equal(PRODUCTION_SPA_LOCK.knownGood.cognitoClientId, '3ja9fqaq2fjkv3i6up2varcqpe');
  assert.equal(PRODUCTION_SPA_LOCK.knownGood.apiTarget, '/prep');
  const fp = JSON.parse(read(PRODUCTION_SPA_LOCK.knownGood.fingerprint));
  assert.equal(isValidatedAwsCognitoFingerprint(fp), true);
});

test('unlocked --apply is refused before any S3 upload', () => {
  const applied = spawnSync(process.execPath, [path.join(ROOT, 'scripts/deploy-production-spa.mjs'), '--apply'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, CHECKSOPS_PRODUCTION_SPA_UNLOCK: '' },
  });
  assert.equal(applied.status, 2);
  assert.match(applied.stderr, /production_spa_cutover_locked/);
  assert.doesNotMatch(applied.stderr, /production_spa_s3_sync_failed/);
});

test('unlock without a validated fingerprint cannot deploy', () => {
  assert.throws(
    () => assertProductionSpaApplyAllowed({
      env: { CHECKSOPS_PRODUCTION_SPA_UNLOCK: 'RELEASE_CUTOVER_LOCK' },
      argv: ['node', 'deploy', '--apply'],
    }),
    /production_spa_rollback_fingerprint_required/,
  );
});

test('supabase-mode artifact cannot be used as production rollback', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spa-lock-'));
  const fake = path.join(tmp, 'supabase-fingerprint.json');
  fs.writeFileSync(fake, JSON.stringify({
    gitCommit: 'deadbeef',
    authProvider: 'supabase',
    cognito: { userPoolId: null, clientId: null },
    apiTarget: 'https://nbcqwpysqgyxrrbgtmkw.supabase.co',
    artifactValidation: { ok: false },
    bundle: { assets: { 'assets/index-ByTwb1fQ.js': '00' } },
  }));
  assert.throws(
    () => assertProductionSpaApplyAllowed({
      env: { CHECKSOPS_PRODUCTION_SPA_UNLOCK: 'RELEASE_CUTOVER_LOCK' },
      argv: ['node', 'deploy', '--apply', '--from-fingerprint', fake],
    }),
    /supabase_or_unvalidated_fingerprint_forbidden/,
  );
  const dir = path.join(tmp, 'dist');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'index.html'), '<html>legacy</html>');
  fs.writeFileSync(path.join(dir, 'app.js'), 'https://nbcqwpysqgyxrrbgtmkw.supabase.co\n');
  const scanned = scanProductionSpaArtifact(dir);
  assert.equal(scanned.ok, false);
  assert.ok(scanned.forbidden.includes('supabase_host'));
});

test('CI and npm scripts cannot directly deploy production', () => {
  const ci = read('.github/workflows/aws-migration-ci.yml');
  assert.match(ci, /contents:\s*read/);
  assert.doesNotMatch(ci, /aws s3 sync/);
  assert.doesNotMatch(ci, /aws s3 cp/);
  assert.match(ci, /apply must stay locked/);
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['deploy:production-spa'], 'node scripts/deploy-production-spa.mjs');
  assert.ok(!String(pkg.scripts['deploy:production-spa']).includes('--apply'));
});

test('bucket policy denies staging/rehearsal writes and keeps CloudFront OAC reads', () => {
  const policy = JSON.parse(read('aws/production/production-frontend-bucket-lock-policy.json'));
  const sids = policy.Statement.map((row) => row.Sid);
  assert.deepEqual(sids, [
    'AllowCloudFrontOAC',
    'DenyProductionSpaWritesExceptApprovedDeployRole',
    'DenyProductionSpaBucketPolicyChangesExceptRoot',
  ]);
  const deny = policy.Statement[1];
  assert.equal(deny.Effect, 'Deny');
  assert.ok(deny.Action.includes('s3:PutObject'));
  assert.ok(deny.Action.includes('s3:DeleteObject'));
  const allowed = deny.Condition.ArnNotLike['aws:PrincipalArn'];
  assert.ok(allowed.includes('arn:aws:iam::806168576068:root'));
  assert.ok(allowed.includes('arn:aws:iam::806168576068:role/ChecksOpsProductionSpaDeploy'));
  assert.ok(!allowed.some((arn) => arn.includes('ChecksOpsCursorCloudStaging')));
  const role = read('aws/production/production-spa-deploy-role.yaml');
  assert.match(role, /Default: "false"/);
  assert.match(role, /ChecksOpsProductionSpaDeploy/);
});

test('CloudFront Step 1 apply stays refused after cutover lock', () => {
  const locked = spawnSync(process.execPath, [path.join(ROOT, 'aws/cloudfront/apply-step1.mjs')], {
    encoding: 'utf8',
    env: { ...process.env, CHECKSOPS_APPLY_CF_STEP1: 'APPLY_GATE1' },
  });
  assert.equal(locked.status, 2);
  assert.match(locked.stderr, /production_cloudfront_cutover_locked/);
});
