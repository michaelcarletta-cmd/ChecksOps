/**
 * Faithful port of supabase/functions/_shared/moovRails.ts
 */
import { moovFetch, scopes } from './moov-client.mjs';

export const CREDIT_RAIL_TYPES = [
  'ach-credit-standard',
  'ach-credit-same-day',
  'rtp-credit',
  'instant-bank-credit',
  'push-to-card',
];

export const FUNDING_RAIL_TYPES = ['ach-debit-fund'];

const STALE_MS = 24 * 60 * 60 * 1000;

export function isRailCacheStale(syncedAt) {
  if (!syncedAt) return true;
  const t = Date.parse(syncedAt);
  return !Number.isFinite(t) || Date.now() - t > STALE_MS;
}

export async function fetchRailMethodIds(accountId, bankAccountId, fetchImpl) {
  const methods = await moovFetch(`/accounts/${accountId}/payment-methods`, {
    scopes: scopes.paymentMethodsRead(accountId),
    fetchImpl,
  }).catch(() => []);

  const out = {};
  for (const m of (Array.isArray(methods) ? methods : [])) {
    const type = String(m?.paymentMethodType ?? '');
    if (!CREDIT_RAIL_TYPES.includes(type) && !FUNDING_RAIL_TYPES.includes(type) && type !== 'ach-debit-collect') continue;
    const id = m?.paymentMethodID ?? m?.paymentMethodId;
    if (!id) continue;
    const owner = m?.bankAccount?.bankAccountID ?? m?.bankAccount?.bankAccountId ?? null;
    if (bankAccountId && owner && owner !== bankAccountId) continue;
    out[type] = id;
  }
  return out;
}

export async function saveMethodRails(client, methodRowId, rails) {
  await client.query(
    `UPDATE public.payment_provider_methods
     SET supported_rails = $2::text[],
         rail_payment_method_ids = $3::jsonb,
         rtp_eligible = $4,
         rails_synced_at = now()
     WHERE id = $1::uuid`,
    [methodRowId, Object.keys(rails), JSON.stringify(rails), Boolean(rails['rtp-credit'])],
  );
}

export async function saveStakeholderRails(client, stakeholderAccountId, rails) {
  await client.query(
    `UPDATE public.stakeholder_accounts
     SET moov_supported_rails = $2::text[],
         moov_rail_payment_method_ids = $3::jsonb,
         moov_rtp_eligible = $4,
         moov_rails_synced_at = now()
     WHERE id = $1::uuid`,
    [stakeholderAccountId, Object.keys(rails), JSON.stringify(rails), Boolean(rails['rtp-credit'])],
  );
}

export async function resolveRails({ cached, syncedAt, accountId, bankAccountId, persist, fetchImpl }) {
  const cache = (cached && typeof cached === 'object' ? cached : {});
  if (Object.keys(cache).length > 0 && !isRailCacheStale(syncedAt)) return cache;
  if (!accountId) return cache;
  const fresh = await fetchRailMethodIds(accountId, bankAccountId, fetchImpl);
  if (Object.keys(fresh).length === 0) return cache;
  if (persist) await persist(fresh).catch(() => {});
  return fresh;
}

export async function resolveDebitSourceMethodId(client, source, accountId, fetchImpl) {
  const pick = (rails) => rails['ach-debit-fund'] ?? rails['ach-debit-collect'] ?? null;
  const cached = (source.rail_payment_method_ids && typeof source.rail_payment_method_ids === 'object'
    ? source.rail_payment_method_ids
    : {});
  const fromCache = pick(cached);
  if (fromCache) return fromCache;

  const methods = await moovFetch(`/accounts/${accountId}/payment-methods`, {
    scopes: scopes.paymentMethodsRead(accountId),
    fetchImpl,
  }).catch(() => []);

  const fresh = { ...cached };
  for (const m of (Array.isArray(methods) ? methods : [])) {
    const type = String(m?.paymentMethodType ?? '');
    const id = m?.paymentMethodID ?? m?.paymentMethodId;
    if (!id) continue;
    const owner = m?.bankAccount?.bankAccountID ?? m?.bankAccount?.bankAccountId ?? null;
    if (source.provider_bank_account_id && owner && owner !== source.provider_bank_account_id) continue;
    if (CREDIT_RAIL_TYPES.includes(type) || FUNDING_RAIL_TYPES.includes(type) || type === 'ach-debit-collect') {
      fresh[type] = id;
    }
  }
  const resolved = pick(fresh);
  if (resolved) await saveMethodRails(client, source.id, fresh).catch(() => {});
  return resolved ?? source.provider_payment_method_id ?? null;
}
