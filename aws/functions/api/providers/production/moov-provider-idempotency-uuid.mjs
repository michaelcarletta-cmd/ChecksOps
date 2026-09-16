import { createHash } from 'node:crypto';

/**
 * RFC 4122 URL namespace UUID (6ba7b811-9dad-11d1-80b4-00c04fd430c8).
 * Moov requires X-Idempotency-Key to be a valid UUID. The business
 * payment_transfers.id stays unchanged; this derives a stable provider key.
 */
export const MOOV_PROVIDER_IDEMPOTENCY_NAMESPACE = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const uuidToBytes = (uuid) => {
  const hex = String(uuid || '').replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) {
    throw new Error('invalid_uuid_namespace');
  }
  return Buffer.from(hex, 'hex');
};

const formatUuid = (bytes) => {
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

/** RFC 4122 UUIDv5: SHA-1(namespace bytes + name), version 5, variant 10. */
export const uuidv5FromNamespace = (name, namespaceUuid) => {
  const digest = createHash('sha1')
    .update(uuidToBytes(namespaceUuid))
    .update(String(name), 'utf8')
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return formatUuid(bytes);
};

export const moovProviderIdempotencyName = (paymentTransferId) => (
  `https://checksops.com/moov/wallet-fund/${String(paymentTransferId || '').trim()}`
);

/**
 * Provider X-Idempotency-Key is derived only from payment_transfers.id.
 * Same id always yields the same UUID. Browser cannot override.
 * Not random per retry. Derivable for reconciliation (no extra persistence).
 */
export const providerFundIdempotencyKey = (paymentTransferId) => {
  const id = String(paymentTransferId || '').trim();
  if (!UUID_RE.test(id)) {
    throw new Error('provider_idempotency_requires_payment_transfer_uuid');
  }
  return uuidv5FromNamespace(
    moovProviderIdempotencyName(id),
    MOOV_PROVIDER_IDEMPOTENCY_NAMESPACE,
  );
};
