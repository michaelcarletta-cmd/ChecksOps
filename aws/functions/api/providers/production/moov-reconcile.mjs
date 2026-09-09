import { persistPollOutcome, providerIdempotencyKeyFromIntent, replayTransferResponse } from './moov-idempotency.mjs';
import { productionMoovFetch, normalizeProductionTransferStatus, transferIdOf } from './moov-client.mjs';

const fail = (error, statusCode, extra = {}) => ({
  ok: false,
  statusCode,
  error,
  provider: 'moov',
  liveProviderCalled: extra.liveProviderCalled === true,
  productionExecution: extra.productionExecution === true,
  ...extra,
});

/**
 * Once provider HTTP may have occurred, never POST again.
 * Prefer GET by provider_transfer_id. If that id is missing, GET is still
 * a read — this function never POSTs.
 */
export async function reconcileProductionMoovTransfer({
  client,
  mapping,
  row,
  credentials,
  fetchImpl = fetch,
} = {}) {
  const providerKey = providerIdempotencyKeyFromIntent(row);
  if (row?.provider_transfer_id) {
    const facilitator = credentials.platformAccountId;
    try {
      const got = await productionMoovFetch({
        credentials,
        path: `/accounts/${facilitator}/transfers/${row.provider_transfer_id}`,
        scopes: [`/accounts/${facilitator}/transfers.read`],
        fetchImpl,
      });
      const status = normalizeProductionTransferStatus(got.json?.status);
      const saved = await persistPollOutcome(client, {
        rowId: row.id,
        status,
        providerTransferId: transferIdOf(got.json) || row.provider_transfer_id,
        providerPayload: got.json,
      });
      return {
        ...replayTransferResponse(saved, {
          reconciled: true,
          liveProviderCalled: true,
          productionExecution: true,
          message: 'Reconciled existing Moov transfer. A second POST was not sent.',
        }),
        provider_idempotency_key: providerKey,
        applicationUserId: mapping?.application_user_id,
      };
    } catch (error) {
      return fail('reconciliation_required', 503, {
        payment_transfer_id: row.id,
        provider_transfer_id: row.provider_transfer_id,
        provider_idempotency_key: providerKey,
        liveProviderCalled: true,
        productionExecution: true,
        message: 'Provider GET failed after a possible POST. Do not POST again.',
        errorDetail: String(error.message || '').slice(0, 200),
      });
    }
  }

  return {
    ...replayTransferResponse(row, {
      reconciled: false,
      uncertain: true,
      error: 'reconciliation_required',
      message: 'Provider HTTP may have occurred but no provider_transfer_id is stored. Reconcile manually. A second Moov POST was not sent.',
    }),
    ok: true,
    statusCode: 200,
    success: false,
    provider_idempotency_key: providerKey,
    applicationUserId: mapping?.application_user_id,
  };
}
