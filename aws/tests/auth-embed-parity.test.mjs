import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('WhiteLabelLogin and MortgageOpsLogin use Cognito passkey + EMAIL_OTP on AWS staging', () => {
  const wl = fs.readFileSync(path.join(ROOT, 'src/components/white-label/WhiteLabelLogin.tsx'), 'utf8');
  const mops = fs.readFileSync(path.join(ROOT, 'src/pages/mortgage-ops/MortgageOpsLogin.tsx'), 'utf8');
  const checkops = fs.readFileSync(path.join(ROOT, 'src/pages/checkops/CheckOpsLogin.tsx'), 'utf8');

  for (const src of [wl, mops]) {
    assert.match(src, /isAwsStaging/);
    assert.match(src, /signInWithAwsPasskey/);
    assert.match(src, /startAwsEmailOtp/);
    assert.match(src, /verifyAwsEmailOtp/);
    assert.match(src, /window\.location\.assign/);
  }
  // Production paths preserved.
  assert.match(wl, /signInWithPasskey/);
  assert.match(wl, /sendMagicLink/);
  assert.match(mops, /signInWithPasskey/);
  assert.match(mops, /sendMagicLink/);
  // CheckOpsLogin Cognito path untouched.
  assert.match(checkops, /signInWithAwsPasskey/);
  assert.match(checkops, /verifyAwsEmailOtp/);
});

test('SELECT allowlist includes the nine audit-missing read relations', () => {
  const allowed = JSON.parse(fs.readFileSync(path.join(ROOT, 'aws/functions/api/allowed-tables.json'), 'utf8'));
  const set = new Set(allowed);
  for (const name of [
    'deposit_aging_dashboard',
    'deposit_owner_performance',
    'deposit_queue_scored',
    'deposit_reminder_queue',
    'financial_stepup_log',
    'loss_draft_dashboard',
    'organization_members',
    'organizations',
    'user_passkeys',
  ]) {
    assert.equal(set.has(name), true, `missing allowlist entry: ${name}`);
  }
});

test('named FK embed helpers are exported from data.mjs', () => {
  const src = fs.readFileSync(path.join(ROOT, 'aws/functions/api/data.mjs'), 'utf8');
  assert.match(src, /export const fkColumnFromHint/);
  assert.match(src, /fkHint/);
  assert.match(src, /embed\.alias/);
});
