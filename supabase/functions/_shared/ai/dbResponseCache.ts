/**
 * DB-backed response cache for AI generation results.
 *
 * Layers on top of the in-memory `_shared/ai/cache.ts`:
 *   - In-memory: hottest-of-hot, per function instance, ~200 entries
 *   - DB: 24h TTL across all instances, survives cold starts, shared by every function
 *
 * Writes are best-effort (a DB write failure never blocks the AI response).
 * Reads return null on any error so callers transparently fall through to AI.
 *
 * Schema: see migration `ai_response_cache` table.
 */
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

let _client: SupabaseClient | null = null;
function getClient(): SupabaseClient | null {
  if (_client) return _client;
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return null;
  _client = createClient(url, key, { auth: { persistSession: false } });
  return _client;
}

export interface DbCacheRecord<T = unknown> {
  payload: T;
  cached: true;
}

/** Read a cached response by key. Returns null on miss / expired / error. */
export async function readDbResponseCache<T>(cacheKey: string): Promise<T | null> {
  try {
    const client = getClient();
    if (!client) return null;
    const { data, error } = await client
      .from("ai_response_cache")
      .select("payload, expires_at")
      .eq("cache_key", cacheKey)
      .maybeSingle();
    if (error || !data) return null;
    if (new Date(data.expires_at).getTime() < Date.now()) return null;
    // Fire-and-forget hit counter
    client.from("ai_response_cache")
      .update({ hits: 1 })
      .eq("cache_key", cacheKey)
      .then(() => {})
      .catch(() => {});
    return data.payload as T;
  } catch (e) {
    console.warn("[dbResponseCache] read failed:", (e as Error).message);
    return null;
  }
}

/** Write a response to the cache. Best-effort: errors are logged but never thrown. */
export async function writeDbResponseCache(
  cacheKey: string,
  meta: {
    task: string;
    claimId?: string | null;
    model: string;
    searchMode: string;
    promptHash: string;
  },
  payload: unknown,
  ttlSeconds = 60 * 60 * 24,
): Promise<void> {
  try {
    const client = getClient();
    if (!client) return;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const { error } = await client.from("ai_response_cache").upsert(
      {
        cache_key: cacheKey,
        task: meta.task,
        claim_id: meta.claimId || "_global",
        model: meta.model,
        search_mode: meta.searchMode,
        prompt_hash: meta.promptHash,
        payload: payload as Record<string, unknown>,
        expires_at: expiresAt,
      },
      { onConflict: "cache_key" },
    );
    if (error) console.warn("[dbResponseCache] write error:", error.message);
  } catch (e) {
    console.warn("[dbResponseCache] write failed:", (e as Error).message);
  }
}
