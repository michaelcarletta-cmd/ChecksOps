/**
 * M3 dark production Moov webhook apply.
 * Always applied=false. Never mutates payment_transfers status, never POSTs,
 * never creates a transfer. Receipts are persisted by handleProviderWebhook.
 */
export const PRODUCTION_MOOV_WEBHOOK_APPLY_ENABLED = false;

const dataOf = (payload) => payload?.data ?? payload;

export const productionMoovWebhookIdentifiers = (payload = {}) => {
  const data = dataOf(payload);
  return {
    eventType: String(payload?.type ?? payload?.eventType ?? 'unknown'),
    eventId: payload?.eventID || payload?.event_id || payload?.id || null,
    accountId: payload?.accountID || payload?.data?.accountID || payload?.accountId || null,
    transferId: data?.transferID || data?.transferId || payload?.transferID || null,
  };
};

const statusRank = (status) => {
  const order = ['queued', 'draft', 'submitting', 'submitted', 'pending', 'processing', 'completed', 'failed', 'returned', 'canceled'];
  return order.indexOf(String(status || ''));
};

export async function applyProductionMoovWebhook(client, payload, extra = {}) {
  const ids = productionMoovWebhookIdentifiers(payload);
  let transfer = null;
  if (ids.transferId) {
    transfer = (await client.query(
      `SELECT id, tenant_id, status, amount_cents, provider_transfer_id, environment
       FROM public.payment_transfers
       WHERE provider = 'moov' AND environment = 'production' AND provider_transfer_id = $1
       LIMIT 1`,
      [String(ids.transferId)],
    )).rows[0] || null;
    if (String(transfer?.environment || '').toLowerCase() !== 'production') transfer = null;
  }
  let productionAccount = null;
  if (ids.accountId) {
    productionAccount = (await client.query(
      `SELECT id, tenant_id, environment FROM public.payment_provider_accounts
       WHERE provider = 'moov' AND environment = 'production' AND provider_account_id = $1
       LIMIT 1`,
      [String(ids.accountId)],
    )).rows[0] || null;
    if (String(productionAccount?.environment || '').toLowerCase() !== 'production') {
      productionAccount = null;
    }
  }

  const productionEvent = Boolean(transfer || productionAccount);
  const outOfOrder = Boolean(
    transfer
    && extra.incomingStatus
    && statusRank(transfer.status) >= 0
    && statusRank(extra.incomingStatus) >= 0
    && statusRank(transfer.status) > statusRank(extra.incomingStatus),
  );

  return {
    applied: false,
    applyEnabled: PRODUCTION_MOOV_WEBHOOK_APPLY_ENABLED,
    financialTablesMutated: false,
    createdTransfer: false,
    productionEvent,
    mutations: [],
    skipped: PRODUCTION_MOOV_WEBHOOK_APPLY_ENABLED ? null : 'm3_dark_webhook_apply_disabled',
    reconciliationCandidate: {
      payment_transfer_id: transfer?.id || null,
      provider_transfer_id: ids.transferId,
      tenant_id: transfer?.tenant_id || productionAccount?.tenant_id || extra.mappedTenantId || null,
      current_status: transfer?.status || null,
      event_type: ids.eventType,
      out_of_order: outOfOrder,
    },
    environment: 'production',
  };
}
