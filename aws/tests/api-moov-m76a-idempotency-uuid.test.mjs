import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { isUuid } from '../functions/api/financial-ownership.mjs';
import {
  MOOV_PROVIDER_IDEMPOTENCY_NAMESPACE,
  moovProviderIdempotencyName,
  providerFundIdempotencyKey,
  uuidv5FromNamespace,
} from '../functions/api/providers/production/moov-provider-idempotency-uuid.mjs';
import { handleProductionMoovWalletFundContinue } from '../functions/api/providers/production/moov-wallet-fund-continue.mjs';

const HELD_INTENT_ID = '257b6033-eac0-4555-877e-a8cb4f801c8f';
const OTHER_INTENT_ID = '11111111-2222-4333-8444-555555555555';
const DERIVED_HELD = '6dac013b-d4c1-50a5-8863-5bbfa881cc6f';
const RFC4122_DNS_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const UUID_V5_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('M7.6A Moov provider idempotency UUID', { concurrency: 1 }, () => {
  test('RFC 4122 UUIDv5 helper matches the DNS/www.example.com vector', () => {
    assert.equal(
      uuidv5FromNamespace('www.example.com', RFC4122_DNS_NAMESPACE),
      '2ed6657d-e927-568b-95e1-2665a8aea6a2',
    );
  });

  test('same payment_transfer_id always yields the same UUIDv5', () => {
    const first = providerFundIdempotencyKey(HELD_INTENT_ID);
    const second = providerFundIdempotencyKey(HELD_INTENT_ID);
    assert.equal(first, DERIVED_HELD);
    assert.equal(second, DERIVED_HELD);
    assert.equal(first, second);
  });

  test('different payment_transfer_id values yield different UUIDs', () => {
    const held = providerFundIdempotencyKey(HELD_INTENT_ID);
    const other = providerFundIdempotencyKey(OTHER_INTENT_ID);
    assert.equal(held, DERIVED_HELD);
    assert.notEqual(other, held);
    assert.equal(isUuid(other), true);
    assert.match(other, UUID_V5_RE);
  });

  test('derived key is a valid RFC 4122 version-5 UUID accepted by Moov', () => {
    const key = providerFundIdempotencyKey(HELD_INTENT_ID);
    assert.equal(isUuid(key), true);
    assert.match(key, UUID_V5_RE);
    assert.notEqual(key, HELD_INTENT_ID);
    assert.doesNotMatch(key, /checksops-wallet-fund-/);
    assert.equal(MOOV_PROVIDER_IDEMPOTENCY_NAMESPACE, '6ba7b811-9dad-11d1-80b4-00c04fd430c8');
    assert.equal(
      moovProviderIdempotencyName(HELD_INTENT_ID),
      `https://checksops.com/moov/wallet-fund/${HELD_INTENT_ID}`,
    );
    assert.equal(
      key,
      uuidv5FromNamespace(
        moovProviderIdempotencyName(HELD_INTENT_ID),
        MOOV_PROVIDER_IDEMPOTENCY_NAMESPACE,
      ),
    );
  });

  test('browser-supplied idempotency is not an input to the derivation', () => {
    const fromBrowser = 'browser-must-not-win';
    const derived = providerFundIdempotencyKey(HELD_INTENT_ID);
    assert.notEqual(derived, fromBrowser);
    assert.equal(derived, providerFundIdempotencyKey(HELD_INTENT_ID));
  });

  test('continue handler never reads body.idempotency_key', async () => {
    const source = await import('node:fs').then((fs) => (
      fs.readFileSync(
        new URL('../functions/api/providers/production/moov-wallet-fund-continue.mjs', import.meta.url),
        'utf8',
      )
    ));
    assert.match(source, /providerFundIdempotencyKey/);
    assert.match(source, /continuePaymentTransferIdFromBody/);
    assert.doesNotMatch(source, /body\?\.idempotency_key/);
    assert.doesNotMatch(source, /insertProductionTransferDraft/);
    assert.equal(typeof handleProductionMoovWalletFundContinue, 'function');
  });

  test('invalid payment_transfer_id is refused instead of emitting a non-UUID key', () => {
    assert.throws(
      () => providerFundIdempotencyKey('checksops-wallet-fund-257b6033-eac0-4555-877e-a8cb4f801c8f'),
      /provider_idempotency_requires_payment_transfer_uuid/,
    );
    assert.throws(
      () => providerFundIdempotencyKey(''),
      /provider_idempotency_requires_payment_transfer_uuid/,
    );
  });
});
