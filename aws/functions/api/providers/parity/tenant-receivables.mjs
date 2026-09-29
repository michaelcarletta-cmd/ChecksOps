/**
 * ChecksOps tenant-fee receivables READ MODEL.
 *
 * Attribution is local-operation first:
 *   tenant_id → tenant_maintenance_payments / platform_fee_occurrences
 *   → provider transfer id → optional Moov GET enrichment
 *
 * Bank name, last4, and Moov description are display-only.
 * Does not POST/PATCH Moov, create transfers, or change billing calculation.
 */

export const PAYMENT_STATUS = Object.freeze({
  DUE: 'DUE',
  SCHEDULED: 'SCHEDULED',
  SUBMITTED: 'SUBMITTED',
  ORIGINATED: 'ORIGINATED',
  SETTLED: 'SETTLED',
  FAILED: 'FAILED',
  RETURNED: 'RETURNED',
  CANCELED: 'CANCELED',
});

export const EXCEPTION = Object.freeze({
  LOCAL_ONLY: 'LOCAL_ONLY',
  PROVIDER_ONLY: 'PROVIDER_ONLY',
  AMOUNT_MISMATCH: 'AMOUNT_MISMATCH',
  STATUS_MISMATCH: 'STATUS_MISMATCH',
  DUPLICATE: 'DUPLICATE',
  RETURNED: 'RETURNED',
});

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const MOOV_NOTE_RE = /\bmoov:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;
const LINE_ITEM_RE = /^(.+?)\s+\$(-?\d+(?:\.\d{1,2})?)\s*$/;

export const extractProviderTransferId = (notes, explicit = null) => {
  if (explicit && UUID_RE.test(String(explicit))) return String(explicit).toLowerCase();
  const match = String(notes || '').match(MOOV_NOTE_RE);
  return match ? match[1].toLowerCase() : null;
};

export const extractKind = (row = {}) => {
  const key = String(row.idempotence_key || row.idempotency_key || '');
  const notes = String(row.notes || '');
  const method = String(row.method || '');
  if (key.startsWith('billing_verification') || notes.includes('billing_verification')) {
    return 'billing_verification';
  }
  if (key.startsWith('consolidated') || method.includes('consolidated') || notes.includes('(consolidated)')) {
    return 'consolidated';
  }
  if (key.startsWith('maintenance') || method === 'moov_ach') return 'maintenance';
  if (row.fee_code) return String(row.fee_code);
  return method || 'fee';
};

export const feeTypeLabel = (kind) => {
  if (kind === 'billing_verification') return 'Billing verification';
  if (kind === 'consolidated') return 'Monthly tenant fees';
  if (kind === 'maintenance') return 'Monthly maintenance';
  return String(kind || 'Fee').replace(/[_-]/g, ' ');
};

export const billingMonthOf = (periodStart, fallbackIso = null) => {
  const src = periodStart || fallbackIso || '';
  const month = String(src).slice(0, 7);
  return /^\d{4}-\d{2}$/.test(month) ? month : null;
};

export const billingPeriodLabel = (month) => {
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return 'Unknown period';
  const [year, mo] = month.split('-');
  return new Date(Date.UTC(Number(year), Number(mo) - 1, 1))
    .toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
};

export const parseLineItemsFromNotes = (notes) => {
  const raw = String(notes || '').replace(/\s*·\s*moov:[0-9a-f-]+$/i, '');
  const colon = raw.indexOf(': ');
  const body = colon >= 0 ? raw.slice(colon + 2) : raw;
  const items = [];
  for (const part of body.split(/\s·\s/)) {
    const match = part.trim().match(LINE_ITEM_RE);
    if (!match) continue;
    items.push({
      label: match[1].trim(),
      amount_cents: Math.round(Number(match[2]) * 100),
    });
  }
  return items;
};

const providerSettled = (provider = {}) => {
  const status = String(provider.status || '').toLowerCase();
  return status === 'completed' || status === 'settled' || Boolean(provider.completedOn || provider.settled_at);
};

export const classifyPaymentStatus = ({
  localStatus = null,
  providerStatus = null,
  achStatus = null,
  settledAt = null,
} = {}) => {
  const local = String(localStatus || '').toLowerCase();
  const provider = String(providerStatus || '').toLowerCase();
  const ach = String(achStatus || '').toLowerCase();

  if (local === 'returned' || provider === 'returned' || ach === 'returned') {
    return PAYMENT_STATUS.RETURNED;
  }
  if (['failed', 'failure'].includes(local) || provider === 'failed' || ach === 'failed') {
    return PAYMENT_STATUS.FAILED;
  }
  if (['canceled', 'cancelled'].includes(local) || ['canceled', 'cancelled'].includes(provider)) {
    return PAYMENT_STATUS.CANCELED;
  }
  if (providerSettled({ status: provider, completedOn: settledAt, settled_at: settledAt })) {
    return PAYMENT_STATUS.SETTLED;
  }
  if (['originated', 'originating'].includes(ach)) return PAYMENT_STATUS.ORIGINATED;
  if (provider === 'pending' || local === 'submitted') return PAYMENT_STATUS.SUBMITTED;
  if (local === 'pending' || local === 'scheduled' || provider === 'queued') return PAYMENT_STATUS.SCHEDULED;
  if (local === 'recorded' || local === 'due' || !local) return PAYMENT_STATUS.DUE;
  return PAYMENT_STATUS.DUE;
};

export const receivedCentsFor = (paymentStatus, amountCents) => (
  paymentStatus === PAYMENT_STATUS.SETTLED ? Number(amountCents || 0) : 0
);

export const reconcileExceptions = ({
  localRow,
  provider,
  providerTransferId,
  seenProviderIds,
}) => {
  const flags = [];
  if (!providerTransferId) flags.push(EXCEPTION.LOCAL_ONLY);
  if (!localRow && provider) flags.push(EXCEPTION.PROVIDER_ONLY);
  if (providerTransferId && seenProviderIds?.has(providerTransferId)) flags.push(EXCEPTION.DUPLICATE);
  if (localRow && provider && Number(localRow.amount_cents) !== Number(provider.amount_cents ?? provider.amount?.value)) {
    flags.push(EXCEPTION.AMOUNT_MISMATCH);
  }
  if (localRow && provider) {
    const localSettled = ['cleared', 'recorded'].includes(String(localRow.status || '').toLowerCase());
    const provSettled = providerSettled(provider);
    if (localSettled !== provSettled && (localSettled || provSettled)) {
      flags.push(EXCEPTION.STATUS_MISMATCH);
    }
  }
  if (String(provider?.status || localRow?.status || '').toLowerCase() === 'returned') {
    flags.push(EXCEPTION.RETURNED);
  }
  return flags;
};

const tenantNameOf = (tenants, tenantId) => {
  const row = tenants?.get?.(tenantId) || tenants?.[tenantId];
  return row?.name || row || 'Unknown tenant';
};

export const rowFromMaintenancePayment = (payment, {
  tenants = new Map(),
  provider = null,
} = {}) => {
  const providerTransferId = extractProviderTransferId(payment.notes, payment.provider_transfer_id);
  const kind = extractKind(payment);
  const month = billingMonthOf(payment.period_start, payment.submitted_at || payment.created_at);
  const paymentStatus = classifyPaymentStatus({
    localStatus: payment.status,
    providerStatus: provider?.status,
    achStatus: provider?.achStatus || provider?.rail?.status,
    settledAt: provider?.completedOn || payment.settled_at,
  });
  const billed = Number(payment.amount_cents || 0);
  const received = receivedCentsFor(paymentStatus, billed);
  let lineItems = parseLineItemsFromNotes(payment.notes);
  if (!lineItems.length && kind === 'billing_verification') {
    lineItems = [{ label: 'Billing verification', amount_cents: billed }];
  }
  const gross = lineItems.filter((item) => item.amount_cents > 0).reduce((sum, item) => sum + item.amount_cents, 0);
  const discounts = lineItems.filter((item) => item.amount_cents < 0).reduce((sum, item) => sum + item.amount_cents, 0);
  return {
    tenant_id: payment.tenant_id,
    tenant_name: tenantNameOf(tenants, payment.tenant_id),
    billing_month: month,
    billing_period_label: billingPeriodLabel(month),
    fee_type: feeTypeLabel(kind),
    kind,
    amount_billed_cents: billed,
    amount_received_cents: received,
    balance_cents: billed - received,
    payment_status: paymentStatus,
    ach_status: provider?.achStatus || provider?.rail?.status || null,
    initiated_at: payment.submitted_at || payment.created_at || null,
    received_at: paymentStatus === PAYMENT_STATUS.SETTLED
      ? (provider?.completedOn || payment.settled_at || payment.received_at || null)
      : null,
    provider_transfer_id: providerTransferId,
    local_operation_id: payment.id,
    source: 'tenant_maintenance_payments',
    line_items: lineItems,
    gross_fees_cents: gross || billed,
    discounts_cents: discounts,
    net_amount_due_cents: billed,
    local_status: payment.status || null,
    provider_status: provider?.status || null,
    created_at: payment.created_at || null,
    originated_at: paymentStatus === PAYMENT_STATUS.ORIGINATED || paymentStatus === PAYMENT_STATUS.SUBMITTED
      ? (payment.submitted_at || null)
      : null,
    settled_at: paymentStatus === PAYMENT_STATUS.SETTLED
      ? (provider?.completedOn || payment.settled_at || null)
      : null,
    exceptions: [],
  };
};

export const rowFromFeeOccurrence = (occurrence, {
  tenants = new Map(),
  provider = null,
} = {}) => {
  const providerTransferId = extractProviderTransferId(null, occurrence.provider_transfer_id);
  const month = billingMonthOf(occurrence.period_start, occurrence.run_at || occurrence.created_at);
  const paymentStatus = classifyPaymentStatus({
    localStatus: occurrence.status,
    providerStatus: provider?.status,
    achStatus: provider?.achStatus,
    settledAt: provider?.completedOn,
  });
  const billed = Number(occurrence.amount_cents || 0);
  const received = receivedCentsFor(paymentStatus, billed);
  return {
    tenant_id: occurrence.tenant_id,
    tenant_name: tenantNameOf(tenants, occurrence.tenant_id),
    billing_month: month,
    billing_period_label: billingPeriodLabel(month),
    fee_type: feeTypeLabel(occurrence.fee_code || 'scheduled_fee'),
    kind: occurrence.fee_code || 'scheduled_fee',
    amount_billed_cents: billed,
    amount_received_cents: received,
    balance_cents: billed - received,
    payment_status: paymentStatus,
    ach_status: provider?.achStatus || null,
    initiated_at: occurrence.run_at || occurrence.created_at || null,
    received_at: paymentStatus === PAYMENT_STATUS.SETTLED ? (provider?.completedOn || null) : null,
    provider_transfer_id: providerTransferId,
    local_operation_id: occurrence.id,
    source: 'platform_fee_occurrences',
    line_items: [],
    gross_fees_cents: billed,
    discounts_cents: 0,
    net_amount_due_cents: billed,
    local_status: occurrence.status || null,
    provider_status: provider?.status || null,
    created_at: occurrence.created_at || null,
    originated_at: occurrence.run_at || null,
    settled_at: paymentStatus === PAYMENT_STATUS.SETTLED ? (provider?.completedOn || null) : null,
    exceptions: [],
  };
};

export const assembleReceivables = ({
  payments = [],
  occurrences = [],
  tenants = new Map(),
  providerByTransferId = new Map(),
} = {}) => {
  const seenProviderIds = new Set();
  const rows = [];

  for (const payment of payments) {
    const providerId = extractProviderTransferId(payment.notes, payment.provider_transfer_id);
    const provider = providerId ? providerByTransferId.get(providerId) || null : null;
    const row = rowFromMaintenancePayment(payment, { tenants, provider });
    row.exceptions = reconcileExceptions({
      localRow: payment,
      provider,
      providerTransferId: providerId,
      seenProviderIds,
    });
    if (providerId) seenProviderIds.add(providerId);
    rows.push(row);
  }

  for (const occurrence of occurrences) {
    const providerId = extractProviderTransferId(null, occurrence.provider_transfer_id);
    if (providerId && seenProviderIds.has(providerId)) continue;
    const provider = providerId ? providerByTransferId.get(providerId) || null : null;
    const row = rowFromFeeOccurrence(occurrence, { tenants, provider });
    row.exceptions = reconcileExceptions({
      localRow: occurrence,
      provider,
      providerTransferId: providerId,
      seenProviderIds,
    });
    if (providerId) seenProviderIds.add(providerId);
    rows.push(row);
  }

  rows.sort((a, b) => String(b.initiated_at || b.created_at || '').localeCompare(String(a.initiated_at || a.created_at || '')));
  return rows;
};

export const filterReceivables = (rows, {
  billingMonth = null,
  tenantId = null,
  paymentStatus = null,
} = {}) => rows.filter((row) => {
  if (tenantId && row.tenant_id !== tenantId) return false;
  if (billingMonth && row.billing_month !== billingMonth) return false;
  if (paymentStatus && row.payment_status !== paymentStatus) return false;
  return true;
});

export const summarizeReceivables = (rows) => {
  const seen = new Set();
  const totals = {
    amount_billed_cents: 0,
    amount_collected_cents: 0,
    outstanding_cents: 0,
    pending_cents: 0,
    failed_returned_cents: 0,
    row_count: 0,
  };
  for (const row of rows) {
    const key = row.provider_transfer_id || `local:${row.local_operation_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    totals.amount_billed_cents += Number(row.amount_billed_cents || 0);
    totals.amount_collected_cents += Number(row.amount_received_cents || 0);
    totals.outstanding_cents += Number(row.balance_cents || 0);
    if ([PAYMENT_STATUS.DUE, PAYMENT_STATUS.SCHEDULED, PAYMENT_STATUS.SUBMITTED, PAYMENT_STATUS.ORIGINATED].includes(row.payment_status)) {
      totals.pending_cents += Number(row.amount_billed_cents || 0);
    }
    if ([PAYMENT_STATUS.FAILED, PAYMENT_STATUS.RETURNED].includes(row.payment_status)) {
      totals.failed_returned_cents += Number(row.amount_billed_cents || 0);
    }
    totals.row_count += 1;
  }
  return totals;
};

export const tenantBillingSummary = (rows, { now = new Date() } = {}) => {
  const currentMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const current = rows.filter((row) => row.billing_month === currentMonth);
  const lastSettled = rows.find((row) => row.payment_status === PAYMENT_STATUS.SETTLED) || null;
  const outstanding = rows.reduce((sum, row) => sum + Number(row.balance_cents || 0), 0);
  const currentDue = current.reduce((sum, row) => sum + Number(row.balance_cents || 0), 0);
  const currentStatus = current[0]?.payment_status || (currentDue > 0 ? PAYMENT_STATUS.DUE : null);
  const months = new Map();
  for (const row of rows) {
    const key = row.billing_month || 'unknown';
    if (!months.has(key)) {
      months.set(key, {
        billing_month: key,
        billing_period_label: billingPeriodLabel(key),
        amount_due_cents: 0,
        amount_paid_cents: 0,
        payment_status: row.payment_status,
        payment_date: row.received_at,
        rows: [],
      });
    }
    const bucket = months.get(key);
    bucket.amount_due_cents += Number(row.amount_billed_cents || 0);
    bucket.amount_paid_cents += Number(row.amount_received_cents || 0);
    bucket.rows.push(row);
    if (row.payment_status === PAYMENT_STATUS.SETTLED) {
      bucket.payment_status = PAYMENT_STATUS.SETTLED;
      bucket.payment_date = row.received_at;
    } else if (bucket.payment_status !== PAYMENT_STATUS.SETTLED) {
      bucket.payment_status = row.payment_status;
    }
  }
  return {
    current_month: currentMonth,
    current_month_amount_due_cents: currentDue,
    current_payment_status: currentStatus,
    last_successful_payment: lastSettled ? {
      billing_month: lastSettled.billing_month,
      amount_cents: lastSettled.amount_received_cents,
      received_at: lastSettled.received_at,
      provider_transfer_id: lastSettled.provider_transfer_id,
    } : null,
    outstanding_balance_cents: outstanding,
    months: [...months.values()].sort((a, b) => String(b.billing_month).localeCompare(String(a.billing_month))),
  };
};

export const enrichWalletTransactions = (transactions, receivables) => {
  const byProvider = new Map();
  for (const row of receivables) {
    if (row.provider_transfer_id) byProvider.set(row.provider_transfer_id, row);
  }
  return (transactions || []).map((txn) => {
    const transferId = txn.transferID || txn.transferId || txn.sourceTransferID || txn.id || null;
    const match = transferId ? byProvider.get(String(transferId).toLowerCase()) : null;
    if (!match) {
      return {
        ...txn,
        tenant_id: null,
        tenant_name: null,
        attribution: null,
      };
    }
    return {
      ...txn,
      tenant_id: match.tenant_id,
      tenant_name: match.tenant_name,
      attribution: {
        tenant_id: match.tenant_id,
        tenant_name: match.tenant_name,
        billing_month: match.billing_month,
        kind: match.kind,
        local_operation_id: match.local_operation_id,
        provider_transfer_id: match.provider_transfer_id,
      },
    };
  });
};

export const loadTenantReceivables = async (client, {
  billingMonth = null,
  tenantId = null,
  paymentStatus = null,
  providerByTransferId = new Map(),
} = {}) => {
  const paymentSql = tenantId
    ? `SELECT id, tenant_id, amount_cents, period_start, period_end, method, status,
              notes, idempotence_key, submitted_at, received_at, created_at, failure_reason
       FROM public.tenant_maintenance_payments
       WHERE tenant_id = $1::uuid
       ORDER BY COALESCE(submitted_at, created_at) DESC
       LIMIT 500`
    : `SELECT id, tenant_id, amount_cents, period_start, period_end, method, status,
              notes, idempotence_key, submitted_at, received_at, created_at, failure_reason
       FROM public.tenant_maintenance_payments
       ORDER BY COALESCE(submitted_at, created_at) DESC
       LIMIT 500`;
  const occurrenceSql = tenantId
    ? `SELECT id, tenant_id, schedule_id, provider_transfer_id, period_start, period_end,
              amount_cents, status, run_at, created_at
       FROM public.platform_fee_occurrences
       WHERE tenant_id = $1::uuid
       ORDER BY COALESCE(run_at, created_at) DESC
       LIMIT 500`
    : `SELECT id, tenant_id, schedule_id, provider_transfer_id, period_start, period_end,
              amount_cents, status, run_at, created_at
       FROM public.platform_fee_occurrences
       ORDER BY COALESCE(run_at, created_at) DESC
       LIMIT 500`;
  const params = tenantId ? [tenantId] : [];
  const [payments, occurrences, tenants] = await Promise.all([
    client.query(paymentSql, params).then((r) => r.rows).catch(() => []),
    client.query(occurrenceSql, params).then((r) => r.rows).catch(() => []),
    client.query('SELECT id::text AS id, name FROM public.tenants').then((r) => r.rows).catch(() => []),
  ]);
  const tenantMap = new Map(tenants.map((row) => [row.id, row]));
  const assembled = assembleReceivables({
    payments,
    occurrences,
    tenants: tenantMap,
    providerByTransferId,
  });
  const filtered = filterReceivables(assembled, { billingMonth, tenantId, paymentStatus });
  return {
    rows: filtered,
    totals: summarizeReceivables(filtered),
    summary: tenantId ? tenantBillingSummary(filtered) : null,
  };
};
