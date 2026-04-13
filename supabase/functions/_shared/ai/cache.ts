/**
 * Simple in-memory response cache keyed by (taskType, claimId, model, searchMode, promptHash).
 * TTL: 24 hours. Bounded to 200 entries (LRU eviction).
 */

import type { SearchMode, DarwinTaskType } from "./modelRouter.ts";

interface CacheEntry {
  value: unknown;
  expiresAt: number;
  key: string;
}

const MAX_ENTRIES = 200;
const TTL_MS = 1000 * 60 * 60 * 24; // 24 hours — claim data doesn't change frequently
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
  // Move to end for LRU
  cache.delete(key);
  cache.set(key, entry);
  return entry.value as T;
}

export function setCache(key: string, value: unknown): void {
  // Evict oldest if at capacity
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
