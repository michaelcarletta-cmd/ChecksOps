import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  COLLECT_ACH_CAPABILITIES,
  LEGACY_CAPABILITY_IDS,
  MERCHANT_CAPABILITIES,
  MOOV_CAPABILITIES_API_VERSION,
  RECIPIENT_CAPABILITIES,
  capabilityEnabled,
  capabilityFlags,
  missingRequestedCapabilities,
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

function requestsLegacyCapability(src, code) {
  const escaped = String(code).replace(/\./g, '\\.');
  return new RegExp(`capabilities\\s*:\\s*\\[[^\\]]*[\\'"\`]${escaped}[\\'"\`]`).test(src);
}

test('merchant set is the granular ACH collect/send + wallet.balance IDs', () => {
  assert.deepEqual([...MERCHANT_CAPABILITIES], [
    'transfers',
    'collect-funds.ach',
    'send-funds.ach',
    'wallet.balance',
  ]);
  assert.deepEqual([...RECIPIENT_CAPABILITIES], ['transfers']);
  assert.deepEqual([...COLLECT_ACH_CAPABILITIES], ['transfers', 'collect-funds.ach']);
  assert.equal(MOOV_CAPABILITIES_API_VERSION, 'v2025.07.00');
  assert.deepEqual([...LEGACY_CAPABILITY_IDS], ['send-funds', 'collect-funds', 'wallet']);
});

test('capabilityFlags accepts both legacy and granular enabled IDs', () => {
  const legacy = capabilityFlags([
    { capability: 'transfers', status: 'enabled' },
    { capability: 'send-funds', status: 'enabled' },
    { capability: 'collect-funds', status: 'enabled' },
    { capability: 'wallet', status: 'enabled' },
  ]);
  const granular = capabilityFlags([
    { capability: 'transfers', status: 'enabled' },
    { capability: 'send-funds.ach', status: 'enabled' },
    { capability: 'collect-funds.ach', status: 'enabled' },
    { capability: 'wallet.balance', status: 'enabled' },
  ]);
  assert.equal(legacy.can_ach_credit, true);
  assert.equal(legacy.can_ach_debit, true);
  assert.equal(granular.can_ach_credit, true);
  assert.equal(granular.can_ach_debit, true);
  assert.equal(capabilityEnabled([
    { capability: 'send-funds.ach', status: 'enabled' },
  ], 'send-funds'), true);
  assert.equal(capabilityEnabled([
    { capability: 'send-funds', status: 'pending' },
  ], 'send-funds'), false);
});

test('missingRequestedCapabilities ignores legacy family IDs', () => {
  assert.deepEqual(
    missingRequestedCapabilities([
      { capability: 'transfers', status: 'enabled' },
      { capability: 'send-funds', status: 'enabled' },
      { capability: 'wallet', status: 'enabled' },
    ]),
    ['collect-funds.ach', 'send-funds.ach', 'wallet.balance'],
  );
  assert.deepEqual(
    missingRequestedCapabilities([
      { capability: 'transfers', status: 'enabled' },
      { capability: 'collect-funds.ach', status: 'enabled' },
      { capability: 'send-funds.ach', status: 'enabled' },
      { capability: 'wallet.balance', status: 'pending' },
    ]),
    [],
  );
});

test('request sites do not send deprecated family IDs', () => {
  for (const rel of REQUEST_SITES) {
    const src = readFileSync(rel, 'utf8');
    for (const code of LEGACY_CAPABILITY_IDS) {
      assert.equal(requestsLegacyCapability(src, code), false, `${rel} still requests ${code}`);
    }
  }
});
