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
    assert.equal(lock.knownGood.gitCommit, '8e155985b103d2fea0251737889a8e6e3687bfed');
    assert.equal(lock.knownGood.spaBundle, 'index-C-KblQPy.js');
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
    ].join('\n'));
    const ok = scanProductionSpaArtifact(dir);
    assert.equal(ok.ok, true);
    assert.equal(ok.moneyCounts['moov-transfer-create'], 0);
    assert.ok(ok.moneyCounts['moov-wallet-fund'] >= 1);
    assert.ok(ok.moneyCounts['Authorize held $0.01 fund'] >= 1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('deploy script uses aws mode and does not honor RELEASE_CUTOVER_LOCK', () => {
    const deploy = fs.readFileSync(path.join(ROOT, 'scripts/deploy-production-spa.mjs'), 'utf8');
    assert.match(deploy, /vite build --mode aws/);
    assert.match(deploy, /M75_MONEY_TEST_HOLD_RELEASE/);
    assert.match(deploy, /RELEASE_CUTOVER_LOCK is no longer accepted/);
    assert.match(deploy, /ChecksOpsProductionSpaDeploy/);
    assert.doesNotMatch(deploy, /--delete/);
  });
});
