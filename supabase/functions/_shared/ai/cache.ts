/**
 * In-memory caches for AI response deduplication and claim-level memoization.
 *
 * Three layers:
 * 1. Response cache  – keyed by (task, claim, model, search, promptHash), 24h TTL
 * 2. Claim memory    – nested Map<claimId, Map<dataType, SlimMemo>>, 4h TTL
 * 3. Search cooldown – per-claim 30-min Tavily throttle
 */

import type { SearchMode, DarwinTaskType } from "./modelRouter.ts";

// ── Types ────────────────────────────────────────────────────────────

interface CacheEntry {
  value: unknown;
  expiresAt: number;
  key: string;
}

/** Slim payload stored in claim memory — only what's needed to rebuild a response */
export interface SlimMemo {
  text: string;
  model: string;
  promptHash: string;
  expiresAt: number;
}

// ── Response cache ───────────────────────────────────────────────────

const MAX_ENTRIES = 200;
const TTL_MS = 1000 * 60 * 60 * 24; // 24 hours
const cache = new Map<string, CacheEntry>();

export function buildCacheKey(
  taskType: DarwinTaskType,
  claimId: string,
  model: string,
  searchMode: SearchMode,
  promptHash: string,
): string {
  return `${taskType}:${claimId}:${model}:${searchMode}:${promptHash}`;
}

export async function hashPrompt(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

export function getCache<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, entry);
  return entry.value as T;
}

export function setCache(key: string, value: unknown): void {
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, { value, expiresAt: Date.now() + TTL_MS, key });
}

// ── Claim memory cache ───────────────────────────────────────────────
// Nested Map: claimId → (dataType → SlimMemo)
// Stores only { text, model, promptHash } to minimise memory footprint.

const CLAIM_MEMORY = new Map<string, Map<string, SlimMemo>>();
const CLAIM_MEMORY_TTL = 1000 * 60 * 60 * 4; // 4 hours
const CLAIM_MEMORY_MAX_CLAIMS = 500;

export function getClaimMemory(claimId: string, dataType: string): SlimMemo | null {
  const inner = CLAIM_MEMORY.get(claimId);
  if (!inner) return null;
  const entry = inner.get(dataType);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    inner.delete(dataType);
    if (inner.size === 0) CLAIM_MEMORY.delete(claimId);
    return null;
  }
  return entry;
}

export function setClaimMemory(claimId: string, dataType: string, text: string, model: string, promptHash: string): void {
  // Evict oldest claim if at capacity
  if (!CLAIM_MEMORY.has(claimId) && CLAIM_MEMORY.size >= CLAIM_MEMORY_MAX_CLAIMS) {
    const oldest = CLAIM_MEMORY.keys().next().value;
    if (oldest) CLAIM_MEMORY.delete(oldest);
  }
  let inner = CLAIM_MEMORY.get(claimId);
  if (!inner) {
    inner = new Map();
    CLAIM_MEMORY.set(claimId, inner);
  }
  inner.set(dataType, { text, model, promptHash, expiresAt: Date.now() + CLAIM_MEMORY_TTL });
}

/** Clear all cached data for a claim (call when claim is modified) */
export function clearClaimMemory(claimId: string): void {
  CLAIM_MEMORY.delete(claimId);
}

// ── Search cooldown per claim ────────────────────────────────────────

const SEARCH_COOLDOWN = new Map<string, number>();
const SEARCH_COOLDOWN_MS = 1000 * 60 * 30; // 30 minutes

export function isSearchOnCooldown(claimId: string): boolean {
  const last = SEARCH_COOLDOWN.get(claimId);
  if (!last) return false;
  return Date.now() - last < SEARCH_COOLDOWN_MS;
}

export function markSearchUsed(claimId: string): void {
  SEARCH_COOLDOWN.set(claimId, Date.now());
  if (SEARCH_COOLDOWN.size > 1000) {
    const cutoff = Date.now() - SEARCH_COOLDOWN_MS;
    for (const [k, v] of SEARCH_COOLDOWN) {
      if (v < cutoff) SEARCH_COOLDOWN.delete(k);
    }
  }
}
