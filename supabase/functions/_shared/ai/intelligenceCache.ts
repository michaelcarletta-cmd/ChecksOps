/**
 * Intelligence Cache — DB-backed, version-aware cache for Darwin's
 * heavy intelligence outputs (knowledge bundles, contradictions,
 * repairability decisions, document-type classifications).
 *
 * Design: each claim has an integer `version` in claim_intelligence_version
 * that DB triggers bump whenever a relevant fact changes (new file, new
 * dismantler, new argument map entry, declared-position change). Cache
 * entries snapshot the version at write time; reads return null when the
 * stored version is older than the current claim version.
 *
 * NON-BREAKING: all callers use it through the `withClaimCache` helper
 * which transparently falls through to the producer on miss/stale.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.39.3";

export type CacheType =
  | "knowledge_bundle"
  | "contradictions"
  | "repairability"
  | "document_type"
  | "dispute_classification";

export async function getCurrentClaimVersion(
  supabase: SupabaseClient,
  claimId: string,
): Promise<number> {
  try {
    const { data } = await supabase
      .from("claim_intelligence_version")
      .select("version")
      .eq("claim_id", claimId)
      .maybeSingle();
    return data?.version ?? 0;
  } catch {
    return 0;
  }
}

export async function readClaimCache<T>(
  supabase: SupabaseClient,
  claimId: string,
  cacheType: CacheType,
  subkey: string,
): Promise<{ payload: T; version: number } | null> {
  try {
    const [versionRes, cacheRes] = await Promise.all([
      supabase.from("claim_intelligence_version").select("version").eq("claim_id", claimId).maybeSingle(),
      supabase.from("claim_intelligence_cache")
        .select("payload, version")
        .eq("claim_id", claimId)
        .eq("cache_type", cacheType)
        .eq("subkey", subkey)
        .maybeSingle(),
    ]);
    const currentVersion = versionRes.data?.version ?? 0;
    const cached = cacheRes.data;
    if (!cached) return null;
    // Stale if current version is greater than cached
    if (currentVersion > 0 && (cached.version ?? 0) < currentVersion) {
      console.log(`[IntelCache] STALE ${cacheType}:${subkey || "_"} cached@${cached.version} < current@${currentVersion}`);
      return null;
    }
    return { payload: cached.payload as T, version: cached.version ?? 0 };
  } catch (e) {
    console.error("[IntelCache] read error:", (e as Error).message);
    return null;
  }
}

export async function writeClaimCache(
  supabase: SupabaseClient,
  claimId: string,
  cacheType: CacheType,
  subkey: string,
  payload: unknown,
): Promise<void> {
  try {
    const version = await getCurrentClaimVersion(supabase, claimId);
    await supabase.from("claim_intelligence_cache").upsert(
      {
        claim_id: claimId,
        cache_type: cacheType,
        subkey,
        version: version || 1,
        payload: payload as any,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "claim_id,cache_type,subkey" },
    );
  } catch (e) {
    console.error("[IntelCache] write error:", (e as Error).message);
  }
}

/**
 * withClaimCache — transparent cache wrapper.
 * Returns cached payload if fresh; otherwise runs producer and stores result.
 */
export async function withClaimCache<T>(
  supabase: SupabaseClient,
  claimId: string,
  cacheType: CacheType,
  subkey: string,
  producer: () => Promise<T>,
): Promise<T> {
  const hit = await readClaimCache<T>(supabase, claimId, cacheType, subkey);
  if (hit) {
    console.log(`[IntelCache] HIT ${cacheType}:${subkey || "_"} v${hit.version}`);
    return hit.payload;
  }
  console.log(`[IntelCache] MISS ${cacheType}:${subkey || "_"} → producing`);
  const fresh = await producer();
  // Don't cache nullish/empty array results (we want to retry next time)
  if (fresh != null && !(Array.isArray(fresh) && fresh.length === 0)) {
    await writeClaimCache(supabase, claimId, cacheType, subkey, fresh);
  }
  return fresh;
}
