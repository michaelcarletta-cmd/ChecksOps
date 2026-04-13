/**
 * Simple in-memory response cache keyed by (taskType, claimId, model, searchMode, promptHash).
 * TTL: 24 hours. Bounded to 200 entries (LRU eviction).
 *
 * Also provides:
 * - CLAIM_MEMORY: per-claim extracted-facts cache (claimId:dataType → data)
 * - SEARCH_COOLDOWN: per-claim Tavily throttle (30 min cooldown)
 */

import type { SearchMode, DarwinTaskType } from "./modelRouter.ts";

interface CacheEntry {
  value: unknown;
  expiresAt: number;
  key: string;
}

const MAX_ENTRIES = 200;
const TTL_MS = 1000 * 60 * 60 * 24; // 24 hours
const cache = new Map<string, CacheEntry>();

// ── Claim memory cache ──────────────────────────────────────────────
// Stores extracted facts, estimate summaries, photo findings per claim
// so repeated calls for the same claim data return instantly.
const CLAIM_MEMORY = new Map<string, CacheEntry>();
const CLAIM_MEMORY_MAX = 500;
const CLAIM_MEMORY_TTL = 1000 * 60 * 60 * 4; // 4 hours

export function claimMemoryKey(claimId: string, dataType: string): string {
  return `${claimId}:${dataType}`;
}

export function getClaimMemory<T>(claimId: string, dataType: string): T | null {
  const key = claimMemoryKey(claimId, dataType);
  const entry = CLAIM_MEMORY.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    CLAIM_MEMORY.delete(key);
    return null;
  }
  // LRU bump
  CLAIM_MEMORY.delete(key);
  CLAIM_MEMORY.set(key, entry);
  return entry.value as T;
}

export function setClaimMemory(claimId: string, dataType: string, value: unknown): void {
  if (CLAIM_MEMORY.size >= CLAIM_MEMORY_MAX) {
    const oldest = CLAIM_MEMORY.keys().next().value;
    if (oldest) CLAIM_MEMORY.delete(oldest);
  }
  const key = claimMemoryKey(claimId, dataType);
  CLAIM_MEMORY.set(key, { value, expiresAt: Date.now() + CLAIM_MEMORY_TTL, key });
}

// ── Search cooldown per claim ───────────────────────────────────────
// Prevents Tavily from being called more than once per 30 min per claim.
const SEARCH_COOLDOWN = new Map<string, number>(); // claimId → last-search timestamp
const SEARCH_COOLDOWN_MS = 1000 * 60 * 30; // 30 minutes

export function isSearchOnCooldown(claimId: string): boolean {
  const last = SEARCH_COOLDOWN.get(claimId);
  if (!last) return false;
  return Date.now() - last < SEARCH_COOLDOWN_MS;
}

export function markSearchUsed(claimId: string): void {
  SEARCH_COOLDOWN.set(claimId, Date.now());
  // Prune old entries to prevent unbounded growth
  if (SEARCH_COOLDOWN.size > 1000) {
    const cutoff = Date.now() - SEARCH_COOLDOWN_MS;
    for (const [k, v] of SEARCH_COOLDOWN) {
      if (v < cutoff) SEARCH_COOLDOWN.delete(k);
    }
  }
}

// ── Response cache ──────────────────────────────────────────────────

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
  cache.set(key, {
    value,
    expiresAt: Date.now() + TTL_MS,
    key,
  });
}
