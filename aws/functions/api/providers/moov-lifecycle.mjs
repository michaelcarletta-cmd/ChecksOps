/**
 * Forward-only Moov transfer lifecycle. Shared by webhooks and GET reconciliation.
 * Never creates transfers. Never POSTs to Moov.
 */
import { normalizeTransferStatus } from './parity/moov-client.mjs';

export const FUNDING_TERMINAL = ['completed', 'failed', 'returned', 'canceled'];

const RANK = {
  created: 1,
  queued: 1,
  submitted: 1,
  pending: 2,
  processing: 2,
  completed: 3,
  failed: 3,
  canceled: 3,
  returned: 4,
};

export const eventTypeToStatus = (eventType) => {
  const t = String(eventType || '');
  if (t.includes('completed')) return 'completed';
  if (t.includes('failed')) return 'failed';
  if (t.includes('reversed') || t.includes('returned')) return 'returned';
  if (t.includes('canceled') || t.includes('cancelled')) return 'canceled';
  return 'pending';
};

export const normalizeMoovStatus = (providerStatus, eventType) => (
  normalizeTransferStatus(providerStatus || eventTypeToStatus(eventType))
);

export const canTransition = (fromStatus, toStatus) => {
  const from = String(fromStatus || '').toLowerCase();
  const to = String(toStatus || '').toLowerCase();
  if (!to) return { ok: false, reason: 'missing_status' };
  if (from === to) return { ok: true, noop: true };
  if (from === 'returned' || from === 'failed' || from === 'canceled' || from === 'cancelled') {
    return { ok: false, reason: 'terminal_regression' };
  }
  if (from === 'completed') {
    if (to === 'returned') return { ok: true, noop: false };
    return { ok: false, reason: 'terminal_regression' };
  }
  const fromRank = RANK[from] ?? 0;
  const toRank = RANK[to] ?? 0;
  if (toRank < fromRank) return { ok: false, reason: 'order_regression' };
  return { ok: true, noop: false };
};

export const completedAtFor = ({ nextStatus, providerCompletedAt, existingCompletedAt }) => {
  if (nextStatus !== 'completed') return existingCompletedAt || null;
  if (providerCompletedAt) return providerCompletedAt;
  if (existingCompletedAt) return existingCompletedAt;
  return null;
};

export const inferSweepActivity = (payload = {}) => {
  const data = payload.data ?? payload;
  const metadata = data?.metadata || payload?.metadata || {};
  const sweepID = metadata.sweepID || metadata.sweepId || data?.sweepID || null;
  const sourceType = data?.source?.paymentMethodType || null;
  const destType = data?.destination?.paymentMethodType || null;
  if (sweepID) {
    const kind = String(sourceType || '').includes('wallet') ? 'sweep_push' : 'sweep_pull';
    return { isSweep: true, sweepID, kind, sourceType, destType };
  }
  if (String(sourceType) === 'moov-wallet' && String(destType || '').includes('ach-credit')) {
    return { isSweep: true, sweepID: null, kind: 'sweep_push', sourceType, destType };
  }
  return { isSweep: false, sweepID: null, kind: 'transfer', sourceType, destType };
};

export const extractTransferEvent = (payload = {}) => {
  const data = payload.data ?? payload;
  const transferId = data?.transferID ?? data?.transferId ?? payload?.transferID ?? null;
  const eventType = payload?.type ?? payload?.eventType ?? 'unknown';
  const providerStatus = data?.status ?? eventTypeToStatus(eventType);
  const amount = data?.amount;
  let amountCents = null;
  if (amount && typeof amount === 'object') {
    if (amount.valueDecimal != null) amountCents = Math.round(Number(amount.valueDecimal) * 100);
    else if (amount.value != null) amountCents = Math.round(Number(amount.value));
  }
  return {
    transferId: transferId ? String(transferId) : null,
    eventType: String(eventType),
    providerStatus: String(providerStatus || ''),
    status: normalizeMoovStatus(providerStatus, eventType),
    completedOn: data?.completedOn || data?.completedAt || null,
    createdOn: data?.createdOn || payload?.createdOn || null,
    amountCents: Number.isFinite(amountCents) ? amountCents : null,
    accountId: payload?.accountID ?? data?.accountID ?? payload?.accountId ?? null,
    metadata: data?.metadata || {},
    sweep: inferSweepActivity(payload),
  };
};
