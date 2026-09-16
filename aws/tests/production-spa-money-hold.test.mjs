import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import {
  assertProductionSpaApplyAllowed,
  loadProductionSpaLock,
} from '../../scripts/production-spa-lock.mjs';
import { scanProductionSpaArtifact } from '../../scripts/validate-production-spa-artifact.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('M7.5C production SPA money-test hold', () => {
  test('lock refuses the CheckAlt cutover unlock token', () => {
    const lock = loadProductionSpaLock();
    assert.equal(lock.hold, 'm75b7_money_test');
    assert.equal(lock.knownGood.gitCommit, 'a49069322624e88fe57ace2d0dedc245407a7919');
    assert.equal(lock.knownGood.spaBundle, 'index-C_NPDCdc.js');
    assert.equal(lock.unlockValue, 'M75_MONEY_TEST_HOLD_RELEASE');
    assert.equal(lock.cutoverUnlockValueNoLongerHonored, 'RELEASE_CUTOVER_LOCK');
    assert.throws(
      () => assertProductionSpaApplyAllowed({
        env: { CHECKSOPS_PRODUCTION_SPA_UNLOCK: 'RELEASE_CUTOVER_LOCK' },
      }),
      (err) => err.code === 'production_spa_money_test_locked',
    );
    assert.throws(
      () => assertProductionSpaApplyAllowed({ env: {} }),
      (err) => err.code === 'production_spa_money_test_locked',
    );
    const allowed = assertProductionSpaApplyAllowed({
      env: { CHECKSOPS_PRODUCTION_SPA_UNLOCK: 'M75_MONEY_TEST_HOLD_RELEASE' },
    });
    assert.equal(allowed.hold, 'm75b7_money_test');
  });

  test('money-path scan rejects moov-transfer-create and requires wallet.fund', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm75c-spa-'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<script src="/assets/index.js"></script>');
    fs.writeFileSync(path.join(dir, 'index.js'), [
      '"cognito"',
      'us-east-1_h00WorYMT',
      '3ja9fqaq2fjkv3i6up2varcqpe',
      '/prep',
      'Ic("moov-transfer-create",{amount_cents:1})',
    ].join('\n'));
    const rejected = scanProductionSpaArtifact(dir);
    assert.equal(rejected.ok, false);
    assert.ok(rejected.forbidden.includes('moov-transfer-create'));
    assert.ok(rejected.missing.includes('moov-wallet-fund'));
    assert.ok(rejected.missing.includes('wallet.fund'));

    fs.writeFileSync(path.join(dir, 'index.js'), [
      '"cognito"',
      'us-east-1_h00WorYMT',
      '3ja9fqaq2fjkv3i6up2varcqpe',
      '/prep',
      'wallet.fund',
      'wallet.disburse',
      'moov-wallet-fund',
      'moov-disburse',
      'Authorize held $0.01 fund',
      'Email me a verification code',
      'Sign in with a passkey',
    ].join('\n'));
    const ok = scanProductionSpaArtifact(dir);
    assert.equal(ok.ok, true);
    assert.equal(ok.userPoolId, 'us-east-1_h00WorYMT');
    assert.equal(ok.clientId, '3ja9fqaq2fjkv3i6up2varcqpe');
    assert.equal(ok.bootableLogin, true);
    assert.equal(ok.moneyCounts['moov-transfer-create'], 0);
    assert.ok(ok.moneyCounts['moov-wallet-fund'] >= 1);
    assert.ok(ok.moneyCounts['Authorize held $0.01 fund'] >= 1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('hardened gate rejects missing Cognito ids and blank Supabase client', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm75c-spa-hard-'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<script src="/assets/index.js"></script>');
    fs.writeFileSync(path.join(dir, 'index.js'), [
      '"cognito"',
      '/prep',
      'wallet.fund',
      'wallet.disburse',
      'moov-wallet-fund',
      'moov-disburse',
      'Authorize held $0.01 fund',
      'createClient("", "")',
    ].join('\n'));
    const rejected = scanProductionSpaArtifact(dir);
    assert.equal(rejected.ok, false);
    assert.ok(rejected.missing.includes('production_cognito_pool'));
    assert.ok(rejected.missing.includes('production_cognito_client'));
    assert.ok(rejected.missing.includes('bootable_freedom_login'));
    assert.ok(rejected.forbidden.includes('blank_supabase_client'));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('deploy script uses aws mode and does not honor RELEASE_CUTOVER_LOCK', () => {
    const deploy = fs.readFileSync(path.join(ROOT, 'scripts/deploy-production-spa.mjs'), 'utf8');
    assert.match(deploy, /vite build --mode aws/);
    assert.match(deploy, /M75_MONEY_TEST_HOLD_RELEASE/);
    assert.match(deploy, /RELEASE_CUTOVER_LOCK is no longer accepted/);
    assert.match(deploy, /ChecksOpsProductionSpaDeploy/);
    assert.match(deploy, /--rollback-known-good/);
    assert.match(deploy, /index-C_NPDCdc\.js/);
    assert.doesNotMatch(deploy, /--delete/);
    assert.match(deploy, /if \(!ROLLBACK_KNOWN_GOOD\)/);
    assert.match(deploy, /VITE_AUTH_PROVIDER: 'cognito'/);
    assert.match(deploy, /VITE_CHECKSOPS_API_URL: '\/prep'/);
    assert.match(deploy, /assertHardenedProductionAuthArtifact/);
  });

  test('awsMode vite define bakes env-provided Cognito and /prep without production defaults', () => {
    const vite = fs.readFileSync(path.join(ROOT, 'vite.config.ts'), 'utf8');
    assert.match(vite, /import\.meta\.env\.VITE_AUTH_PROVIDER/);
    assert.match(vite, /import\.meta\.env\.VITE_CHECKSOPS_API_URL/);
    assert.match(vite, /import\.meta\.env\.VITE_COGNITO_USER_POOL_ID/);
    assert.match(vite, /import\.meta\.env\.VITE_COGNITO_USER_POOL_CLIENT_ID/);
    assert.match(vite, /process\.env\.VITE_COGNITO_USER_POOL_ID \|\| env\.VITE_COGNITO_USER_POOL_ID/);
    assert.match(vite, /Do not default pool\/client to production IDs/);
    assert.doesNotMatch(vite, /us-east-1_h00WorYMT/);
    assert.doesNotMatch(vite, /3ja9fqaq2fjkv3i6up2varcqpe/);
  });
});
