/**
 * WalletOps candidate must keep PR #598 granular capability source
 * and WalletOps sweep-history hunks in the same request sites.
 * Never restore the CTqMys28-era mixed legacy array.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  COLLECT_ACH_CAPABILITIES,
  LEGACY_CAPABILITY_IDS,
  MERCHANT_CAPABILITIES,
  RECIPIENT_CAPABILITIES,
  capabilityFlags,
} from '../functions/api/providers/parity/moov-capabilities.mjs';

const REQUEST_SITES = [
  'aws/functions/api/providers/parity/moov-functions.mjs',
  'aws/functions/api/providers/parity/moov-onboard.mjs',
  'supabase/functions/moov-account-create/index.ts',
  'supabase/functions/moov-account-onboard/index.ts',
  'supabase/functions/moov-onboarding-link/index.ts',
  'supabase/functions/moov-sync/index.ts',
  'supabase/functions/moov-recipient-create/index.ts',
  'supabase/functions/moov-recipient-bank-add/index.ts',
  'supabase/functions/_shared/moovPlaidBridge.ts',
  'supabase/functions/homeowner-deductible-pay/index.ts',
];

const MIXED_LEGACY = "['transfers', 'send-funds', 'wallet', 'send-funds.ach']";

function read(rel) {
  return readFileSync(rel, 'utf8');
}

function requestsLegacyCapability(src, code) {
  const escaped = String(code).replace(/\./g, '\\.');
  return new RegExp(`capabilities\\s*:\\s*\\[[^\\]]*[\\'"\`]${escaped}[\\'"\`]`).test(src);
}

test('PR #598 merchant set is the candidate capability source', () => {
  assert.deepEqual([...MERCHANT_CAPABILITIES], [
    'transfers',
    'collect-funds.ach',
    'send-funds.ach',
    'wallet.balance',
  ]);
  assert.deepEqual([...RECIPIENT_CAPABILITIES], ['transfers']);
  assert.deepEqual([...COLLECT_ACH_CAPABILITIES], ['transfers', 'collect-funds.ach']);
  const caps = read('aws/functions/api/providers/parity/moov-capabilities.mjs');
  assert.match(caps, /export function capabilityEnabled/);
  assert.match(caps, /name\.startsWith\(`\$\{target\}\.`\)/);
  assert.doesNotMatch(caps, /byName\.get\(name\) === 'enabled'/);
});

test('capabilityFlags still reads both legacy and granular enabled IDs', () => {
  const legacy = capabilityFlags([
    { capability: 'send-funds', status: 'enabled' },
    { capability: 'collect-funds', status: 'enabled' },
  ]);
  const granular = capabilityFlags([
    { capability: 'send-funds.ach', status: 'enabled' },
    { capability: 'collect-funds.ach', status: 'enabled' },
  ]);
  assert.equal(legacy.can_ach_credit, true);
  assert.equal(legacy.can_ach_debit, true);
  assert.equal(granular.can_ach_credit, true);
  assert.equal(granular.can_ach_debit, true);
});

test('no request site restores the 57a04ea mixed legacy array or family IDs', () => {
  for (const rel of REQUEST_SITES) {
    const src = read(rel);
    assert.equal(src.includes(MIXED_LEGACY), false, `${rel} restored ${MIXED_LEGACY}`);
    for (const code of LEGACY_CAPABILITY_IDS) {
      assert.equal(requestsLegacyCapability(src, code), false, `${rel} still requests ${code}`);
    }
  }
});

test('moov-onboard keeps #598 granular requests and WalletOps sweep history', () => {
  const onboard = read('aws/functions/api/providers/parity/moov-onboard.mjs');
  assert.match(onboard, /MERCHANT_CAPABILITIES/);
  assert.match(onboard, /RECIPIENT_CAPABILITIES/);
  assert.match(onboard, /MOOV_CAPABILITIES_API_VERSION/);
  assert.match(onboard, /capabilities: \[\.\.\.MERCHANT_CAPABILITIES\]/);
  assert.match(onboard, /from '\.\/sweep-read\.mjs'/);
  assert.match(onboard, /readSweepHistory/);
  assert.match(onboard, /readSweepSnapshot/);
  assert.doesNotMatch(onboard, /\/accounts\/\$\{accountId\}\/sweeps\?walletID=/);
  assert.doesNotMatch(onboard, /capabilities: \['transfers', 'send-funds', 'wallet', 'send-funds\.ach'\]/);
});

test('moov-functions keeps #598 merchant requests and missing-cap sync', () => {
  const fn = read('aws/functions/api/providers/parity/moov-functions.mjs');
  assert.match(fn, /MERCHANT_CAPABILITIES/);
  assert.match(fn, /missingRequestedCapabilities/);
  assert.match(fn, /capabilities: \[\.\.\.MERCHANT_CAPABILITIES\]/);
  assert.match(fn, /apiVersion: MOOV_CAPABILITIES_API_VERSION/);
  assert.doesNotMatch(fn, /capabilities: \['transfers', 'send-funds', 'wallet', 'send-funds\.ach'\]/);
});

test('moov-client re-exports #598 capabilityFlags', () => {
  const client = read('aws/functions/api/providers/parity/moov-client.mjs');
  assert.match(client, /export \{ capabilityFlags \} from '\.\/moov-capabilities\.mjs'/);
  assert.doesNotMatch(client, /const byName = new Map/);
});
