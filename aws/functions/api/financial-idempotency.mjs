import { createHash } from 'node:crypto';

export const stableIdempotencyKey = ({
  tenantId,
  operationType,
  resourceId,
  amountCents,
  currency = 'USD',
  disbursementSequence,
} = {}) => {
  const distinguisher = disbursementSequence != null && disbursementSequence !== ''
    ? `seq:${disbursementSequence}`
    : String(amountCents ?? '');
  const material = [
    String(tenantId || ''),
    String(operationType || ''),
    String(resourceId || ''),
    distinguisher,
    String(currency || 'USD'),
  ].join('|');
  return createHash('sha256').update(material).digest('hex');
};

export const webhookEventKey = ({ provider, externalEventId } = {}) => (
  `${String(provider || '')}:${String(externalEventId || '')}`
);

export const isInFlight = (status) => (
  status === 'submitting' || status === 'provider_pending'
);

export const replaySafeResponse = (operation, extra = {}) => ({
  ok: true,
  statusCode: 200,
  duplicate: true,
  replayed: true,
  liveProviderCalled: false,
  operation,
  ...extra,
});
