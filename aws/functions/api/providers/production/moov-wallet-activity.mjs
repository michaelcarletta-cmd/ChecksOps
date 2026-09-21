/**
 * Server-side Recent Wallet Activity union.
 * GET-only. Never POSTs. Never inserts money records.
 *
 * Dedupe key: provider:<provider_transfer_id> else transfer:<payment_transfer_id>
 * Priority: payment_transfers > payment_provider_activity > keyed ledger rows.
 */
export const WALLET_ACTIVITY_SOURCE_PRIORITY = {
  payment_transfer: 0,
  provider_activity: 1,
  wallet_ledger: 2,
};

export const WALLET_ACTIVITY_LABEL = {
  money_in: 'Money In',
  money_out: 'Money Out',
  sweep_out: 'Sweep Out',
  sweep_in: 'Sweep In',
  fee: 'Processing fee',
  other: 'Wallet transfer',
};

const lower = (value) => String(value || '').toLowerCase();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const providerTransferKey = (value) => {
  const id = String(value || '').trim().toLowerCase();
  return id ? `provider:${id}` : null;
};

export const paymentTransferKey = (value) => {
  const id = String(value || '').trim().toLowerCase();
  return UUID_RE.test(id) ? `transfer:${id}` : null;
};

const kindFromTransfer = (row = {}) => {
  if (row.is_facilitator_fee) return 'fee';
  const role = lower(row.leg_role);
  if (role === 'wallet_funding' || role === 'funding') return 'money_in';
  if (role === 'wallet_disbursement' || role === 'payout' || role === 'disbursement') return 'money_out';
  return 'other';
};

const isSweepActivity = (row = {}) => (
  lower(row.origin) === 'provider_sweep' || lower(row.activity_kind).startsWith('sweep')
);

const kindFromActivity = (row = {}) => {
  const kind = lower(row.activity_kind);
  const dest = lower(row.destination_rail);
  const source = lower(row.source_rail);
  if (isSweepActivity(row)) {
    if (kind === 'sweep_pull' || (dest.includes('wallet') && !source.includes('wallet'))) return 'sweep_in';
    return 'sweep_out';
  }
  if (dest.includes('wallet') && !source.includes('wallet')) return 'money_in';
  if (source.includes('wallet') && !dest.includes('wallet')) return 'money_out';
  return 'other';
};

const kindFromLedger = (row = {}) => {
  const entry = lower(row.entry_type);
  if (entry === 'fee') return 'fee';
  if (entry === 'sweep') return lower(row.direction) === 'credit' ? 'sweep_in' : 'sweep_out';
  if (entry === 'funding' || entry === 'settlement_received') return 'money_in';
  if (entry === 'payout') return 'money_out';
  return lower(row.direction) === 'credit' ? 'money_in' : 'money_out';
};

const transferStatus = (row = {}) => {
  const provider = String(row.provider_status || '');
  if (provider.toLowerCase().includes('originated')) return 'originated';
  return String(row.status || provider || 'unknown');
};

const toItem = ({ id, source, kind, amount_cents, status, timestamp, provider_transfer_id, environment }) => ({
  id,
  source,
  kind,
  label: WALLET_ACTIVITY_LABEL[kind],
  amount_cents: Number(amount_cents || 0),
  direction: kind === 'money_in' || kind === 'sweep_in' ? 'in' : 'out',
  status,
  timestamp: timestamp || '',
  provider_transfer_id: provider_transfer_id ? String(provider_transfer_id) : null,
  environment: environment || null,
});

export const transferToActivityItem = (row = {}) => ({
  item: toItem({
    id: String(row.id || ''),
    source: 'payment_transfer',
    kind: kindFromTransfer(row),
    amount_cents: Number(row.amount_cents || 0),
    status: transferStatus(row),
    timestamp: String(row.completed_at || row.created_at || ''),
    provider_transfer_id: row.provider_transfer_id ? String(row.provider_transfer_id) : null,
    environment: row.environment || null,
  }),
  keys: [providerTransferKey(row.provider_transfer_id), paymentTransferKey(row.id)].filter(Boolean),
});

export const providerActivityToItem = (row = {}) => ({
  item: toItem({
    id: String(row.id || ''),
    source: 'provider_activity',
    kind: kindFromActivity(row),
    amount_cents: Number(row.amount_cents || 0),
    status: String(row.status || 'unknown'),
    timestamp: String(row.provider_completed_at || row.provider_created_at || row.observed_at || ''),
    provider_transfer_id: row.provider_transfer_id ? String(row.provider_transfer_id) : null,
    environment: row.environment || null,
  }),
  keys: [providerTransferKey(row.provider_transfer_id), paymentTransferKey(row.payment_transfer_id)].filter(Boolean),
});

export const ledgerToActivityItem = (row = {}) => {
  const providerId = row.provider_transfer_id || row.reference;
  return {
    item: toItem({
      id: String(row.id || ''),
      source: 'wallet_ledger',
      kind: kindFromLedger(row),
      amount_cents: Number(row.amount_cents || 0),
      status: 'completed',
      timestamp: String(row.created_at || ''),
      provider_transfer_id: providerId ? String(providerId) : null,
      environment: row.environment || null,
    }),
    keys: [providerTransferKey(providerId), paymentTransferKey(row.transfer_id)].filter(Boolean),
  };
};

const takeByPriority = (existing, next) => {
  const priority = WALLET_ACTIVITY_SOURCE_PRIORITY[next.source];
  if (!existing || priority < existing.priority) return { item: next, priority };
  return existing;
};

export const buildWalletActivityFeed = ({
  transfers = [],
  providerActivity = [],
  ledger = [],
  limit = 25,
  environment = null,
} = {}) => {
  const env = environment ? lower(environment) : null;
  const scoped = (rows) => (env ? rows.filter((row) => !row.environment || lower(row.environment) === env) : rows);
  const chosen = new Map();
  const claim = (mapped) => {
    if (!mapped.item.id) return;
    const keys = mapped.keys.length ? mapped.keys : [`source:${mapped.item.source}:${mapped.item.id}`];
    const overlapping = keys.map((key) => chosen.get(key)).filter(Boolean);
    const winner = overlapping.reduce(
      (best, cur) => takeByPriority(best, cur.item),
      takeByPriority(undefined, mapped.item),
    );
    const extraKeys = [...chosen.entries()]
      .filter(([, value]) => overlapping.includes(value))
      .map(([key]) => key);
    for (const key of [...keys, ...extraKeys]) chosen.set(key, winner);
  };

  for (const row of scoped(transfers)) claim(transferToActivityItem(row));
  for (const row of scoped(providerActivity)) claim(providerActivityToItem(row));
  const hasPrimary = scoped(transfers).length > 0 || scoped(providerActivity).length > 0;
  for (const row of scoped(ledger)) {
    const mapped = ledgerToActivityItem(row);
    if (hasPrimary && mapped.keys.length === 0) continue;
    claim(mapped);
  }

  const unique = new Map();
  for (const { item } of chosen.values()) unique.set(`${item.source}:${item.id}`, item);
  return [...unique.values()]
    .sort((a, b) => {
      const byTime = Date.parse(b.timestamp || '') - Date.parse(a.timestamp || '');
      if (Number.isFinite(byTime) && byTime !== 0) return byTime;
      return WALLET_ACTIVITY_SOURCE_PRIORITY[a.source] - WALLET_ACTIVITY_SOURCE_PRIORITY[b.source];
    })
    .slice(0, Math.min(Number(limit) || 25, 200));
};
