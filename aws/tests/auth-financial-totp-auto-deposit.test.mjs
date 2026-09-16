import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const totp = fs.readFileSync(new URL('../functions/api/auth-financial-totp.mjs', import.meta.url), 'utf8');

test('configure is recognized before action_mismatch; Moov wallet binding stays first-class', () => {
  const configureIdx = totp.indexOf("actionKey === 'checkalt.auto_deposit.configure'");
  const moovIdx = totp.indexOf('isMoovWalletTotpAction(actionKey)');
  const mismatchIdx = totp.indexOf("error: 'action_mismatch'");
  assert.ok(configureIdx > 0, 'configure action must be recognized');
  assert.ok(moovIdx > 0, 'Moov wallet TOTP recognition must remain');
  assert.ok(configureIdx < moovIdx, 'configure must be handled without displacing Moov');
  assert.ok(moovIdx < mismatchIdx, 'Moov actions must still be recognized before action_mismatch');
  assert.match(totp, /resolveMoovWalletStepUpBinding/);
  assert.match(totp, /autoDepositBound/);
  assert.doesNotMatch(totp.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''), /isMoovWalletTotpAction\s*=\s*\(\s*\)\s*=>\s*false/);
});
