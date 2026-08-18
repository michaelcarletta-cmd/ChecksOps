/**
 * Rail eligibility discovery for Moov destinations.
 *
 * Moov exposes one payment method per (bank account, rail):
 *   GET /accounts/{accountID}/payment-methods
 *     -> [{ paymentMethodID, paymentMethodType, bankAccount: { bankAccountID } }]
 *
 * `paymentMethodType` IS the rail: `ach-credit-standard`, `ach-credit-same-day`,
 * `rtp-credit`, `push-to-card`, plus the debit/funding types used as a source.
 * We cache the credit-side map so the router can pick a rail without an extra
 * round trip on every payout, and refresh it when it is missing or stale.
 */

import { moovFetch, scopes } from "./moovClient.ts";

/** Rails money can be PUSHED out on. Debit/funding types are excluded. */
export const CREDIT_RAIL_TYPES = [
  "ach-credit-standard",
  "ach-credit-same-day",
  "rtp-credit",
  "push-to-card",
];

export type RailMethodIds = Record<string, string>;

const STALE_MS = 24 * 60 * 60 * 1000;

export function isRailCacheStale(syncedAt: string | null | undefined): boolean {
  if (!syncedAt) return true;
  const t = Date.parse(syncedAt);
  return !Number.isFinite(t) || Date.now() - t > STALE_MS;
}

/**
 * Lists the credit rails available for one bank account on a Moov account.
 * Never throws: an unavailable list simply means "no rail metadata", and the
 * router falls back to today's standard-ACH behaviour.
 */
export async function fetchRailMethodIds(
  accountId: string,
  bankAccountId: string | null,
): Promise<RailMethodIds> {
  const methods = await moovFetch<any[]>(`/accounts/${accountId}/payment-methods`, {
    scopes: scopes.paymentMethodsRead(accountId),
  }).catch((e) => {
    console.warn("[moovRails] payment-methods unavailable", accountId, (e as Error).message);
    return [] as any[];
  });

  const out: RailMethodIds = {};
  for (const m of methods ?? []) {
    const type = String(m?.paymentMethodType ?? "");
    if (!CREDIT_RAIL_TYPES.includes(type)) continue;
    const id = m?.paymentMethodID ?? m?.paymentMethodId;
    if (!id) continue;
    const owner = m?.bankAccount?.bankAccountID ?? m?.bankAccount?.bankAccountId ?? null;
    if (bankAccountId && owner && owner !== bankAccountId) continue;
    out[type] = id;
  }
  return out;
}

/** Persists rail metadata on a `payment_provider_methods` row. */
export async function saveMethodRails(
  supabase: any,
  methodRowId: string,
  rails: RailMethodIds,
): Promise<void> {
  await supabase
    .from("payment_provider_methods")
    .update({
      supported_rails: Object.keys(rails),
      rail_payment_method_ids: rails,
      rtp_eligible: !!rails["rtp-credit"],
      rails_synced_at: new Date().toISOString(),
    })
    .eq("id", methodRowId);
}

/** Persists rail metadata on a `stakeholder_accounts` row. */
export async function saveStakeholderRails(
  supabase: any,
  stakeholderAccountId: string,
  rails: RailMethodIds,
): Promise<void> {
  await supabase
    .from("stakeholder_accounts")
    .update({
      moov_supported_rails: Object.keys(rails),
      moov_rail_payment_method_ids: rails,
      moov_rtp_eligible: !!rails["rtp-credit"],
      moov_rails_synced_at: new Date().toISOString(),
    })
    .eq("id", stakeholderAccountId);
}

/**
 * Returns the cached rail map when fresh, otherwise refreshes it from Moov.
 * `persist` is invoked only when a live refresh produced something.
 */
export async function resolveRails(opts: {
  cached: unknown;
  syncedAt: string | null | undefined;
  accountId: string | null;
  bankAccountId: string | null;
  persist?: (rails: RailMethodIds) => Promise<void>;
}): Promise<RailMethodIds> {
  const cached = (opts.cached && typeof opts.cached === "object" ? opts.cached : {}) as RailMethodIds;
  if (Object.keys(cached).length > 0 && !isRailCacheStale(opts.syncedAt)) return cached;
  if (!opts.accountId) return cached;

  const fresh = await fetchRailMethodIds(opts.accountId, opts.bankAccountId);
  if (Object.keys(fresh).length === 0) return cached;
  if (opts.persist) await opts.persist(fresh).catch(() => {/* cache write is best-effort */});
  return fresh;
}
