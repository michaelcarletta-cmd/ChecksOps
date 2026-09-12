/**
 * M5 authoritative production Moov webhook apply.
 * Default applied=false. Never POSTs. Never creates a transfer.
 * awaiting_bank → ready only when the full live READY predicate succeeds.
 */
import { moovWebhookApplyEnabled } from './moov-holds.mjs';
import { evaluateRecipientReady } from './moov-recipient-readiness.mjs';

const dataOf = (payload) => payload?.data ?? payload;

export const productionMoovWebhookIdentifiers = (payload = {}) => {
  const data = dataOf(payload);
  return {
    eventType: String(payload?.type ?? payload?.eventType ?? 'unknown'),
    eventId: payload?.eventID || payload?.event_id || payload?.id || null,
    accountId: payload?.accountID || payload?.data?.accountID || payload?.accountId || null,
    transferId: data?.transferID || data?.transferId || payload?.transferID || null,
    bankAccountId: data?.bankAccountID || data?.bankAccountId || null,
    paymentMethodId: data?.paymentMethodID || data?.paymentMethodId || null,
  };
};

export const transferStatusRank = (status) => {
  const order = ['queued', 'draft', 'submitting', 'submitted', 'pending', 'processing', 'completed', 'failed', 'returned', 'canceled', 'cancelled'];
  return order.indexOf(String(status || '').toLowerCase());
};

export const eventCreatesTransfer = (payload = {}) => {
  const type = String(payload?.type || payload?.eventType || '');
  return type === 'transfer.create' || payload?.create_transfer === true;
};

export const intendedWebhookMutations = (payload = {}, { transfer = null, recipient = null, liveReadiness = null } = {}) => {
  const ids = productionMoovWebhookIdentifiers(payload);
  const type = ids.eventType;
  const incomingStatus = String(dataOf(payload)?.status || payload?.status || '').toLowerCase() || null;
  const mutations = [];

  if (eventCreatesTransfer(payload) || /createTransfer|create_transfer/i.test(JSON.stringify(payload?.action || ''))) {
    return {
      mutations: [],
      refused: 'webhook_cannot_create_transfer',
      incomingStatus,
    };
  }

  if (type.startsWith('transfer.') && transfer) {
    const currentRank = transferStatusRank(transfer.status);
    const incomingRank = transferStatusRank(incomingStatus);
    const outOfOrder = currentRank >= 0 && incomingRank >= 0 && currentRank > incomingRank;
    mutations.push({
      table: 'payment_transfers',
      op: 'update_status',
      id: transfer.id,
      incomingStatus,
      out_of_order: outOfOrder,
      skip: outOfOrder,
    });
  }

  if (type.startsWith('bankAccount.') && recipient) {
    const bankVerified = String(dataOf(payload)?.status || '').toLowerCase() === 'verified';
    const ready = Boolean(liveReadiness?.ready === true && evaluateRecipientReady(liveReadiness).ready);
    mutations.push({
      table: 'external_payment_recipients',
      op: 'status',
      id: recipient.id,
      from: recipient.onboarding_status,
      to: ready ? 'ready' : 'awaiting_bank',
      bank_verified_insufficient: bankVerified && !ready,
      requires_full_predicate: true,
    });
  }

  if (type.startsWith('account.') || type.startsWith('capability.') || type.startsWith('paymentMethod.')) {
    mutations.push({
      table: 'payment_provider_accounts',
      op: 'webhook_touch',
      accountId: ids.accountId,
      event_type: type,
    });
  }

  return { mutations, refused: null, incomingStatus };
};

export async function applyProductionMoovWebhook(client, payload, extra = {}) {
  const ids = productionMoovWebhookIdentifiers(payload);
  if (eventCreatesTransfer(payload)) {
    return {
      applied: false,
      applyEnabled: moovWebhookApplyEnabled(),
      financialTablesMutated: false,
      createdTransfer: false,
      productionEvent: true,
      mutations: [],
      skipped: 'webhook_cannot_create_transfer',
      environment: 'production',
    };
  }

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

  let recipient = extra.recipient || null;
  if (!recipient && ids.accountId) {
    recipient = (await client.query(
      `SELECT id, tenant_id, onboarding_status, environment, provider_account_id
       FROM public.external_payment_recipients
       WHERE provider = 'moov' AND environment = 'production' AND provider_account_id = $1
       LIMIT 1`,
      [String(ids.accountId)],
    )).rows[0] || null;
  }

  const productionEvent = Boolean(transfer || productionAccount || recipient);
  const planned = intendedWebhookMutations(payload, {
    transfer,
    recipient,
    liveReadiness: extra.liveReadiness || null,
  });
  const outOfOrder = Boolean(planned.mutations.some((row) => row.out_of_order));
  const applyEnabled = moovWebhookApplyEnabled();
  const shouldApply = applyEnabled && productionEvent && !planned.refused;

  let appliedMutations = [];
  if (shouldApply) {
    for (const mutation of planned.mutations) {
      if (mutation.skip || mutation.out_of_order) continue;
      if (mutation.table === 'payment_transfers' && mutation.op === 'update_status' && mutation.id) {
        await client.query(
          `UPDATE public.payment_transfers SET status = $2, provider_status = $2
           WHERE id = $1::uuid AND environment = 'production'`,
          [mutation.id, mutation.incomingStatus],
        );
        appliedMutations.push(mutation);
      }
      if (mutation.table === 'external_payment_recipients' && mutation.to === 'ready' && mutation.id) {
        await client.query(
          `UPDATE public.external_payment_recipients SET onboarding_status = 'ready'
           WHERE id = $1::uuid AND environment = 'production'`,
          [mutation.id],
        );
        appliedMutations.push(mutation);
      }
    }
  }

  return {
    applied: shouldApply && appliedMutations.length > 0,
    applyEnabled,
    financialTablesMutated: appliedMutations.length > 0,
    createdTransfer: false,
    productionEvent,
    mutations: shouldApply ? appliedMutations : planned.mutations,
    skipped: applyEnabled
      ? (planned.refused || (outOfOrder ? 'out_of_order' : null))
      : 'm5_dark_webhook_apply_disabled',
    reconciliationCandidate: {
      payment_transfer_id: transfer?.id || null,
      provider_transfer_id: ids.transferId,
      tenant_id: transfer?.tenant_id || productionAccount?.tenant_id || recipient?.tenant_id || extra.mappedTenantId || null,
      current_status: transfer?.status || null,
      event_type: ids.eventType,
      out_of_order: outOfOrder,
      recipient_id: recipient?.id || null,
    },
    environment: 'production',
  };
}
