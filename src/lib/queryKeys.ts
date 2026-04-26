/**
 * Centralized React Query key factory.
 *
 * Why a factory?
 * - One source of truth for cache keys -> no typo-driven cache misses
 * - Easy to invalidate "everything for a loss draft" in one call:
 *     qc.invalidateQueries({ queryKey: queryKeys.lossDraft.all(id) })
 * - Type-safe: keys are `as const` arrays
 *
 * Convention: each domain exports `lists()` / `detail(id)` / `all(id)` helpers.
 * `all(id)` returns the prefix to invalidate every sub-query for that record.
 */

export const queryKeys = {
  /* ---------- Loss draft tracking ---------- */
  lossDraft: {
    detail: (id: string) => ["loss-draft-detail", id] as const,
    releases: (id: string) => ["loss-draft-releases", id] as const,
    docs: (id: string) => ["loss-draft-docs", id] as const,
    audit: (id: string) => ["loss-draft-audit", id] as const,
    /** Prefix used for "invalidate everything for this draft". */
    all: (id: string) => ["loss-draft", id] as const,
    list: (filters?: Record<string, unknown>) =>
      filters ? (["loss-drafts", filters] as const) : (["loss-drafts"] as const),
    counts: () => ["loss-draft-counts"] as const,
  },

  /* ---------- Mortgage companies (directory) ---------- */
  mortgageCompany: {
    detail: (id: string) => ["mortgage-company", id] as const,
    list: () => ["mortgage-companies"] as const,
    suggestionForName: (name: string) =>
      ["mortgage-company-suggestion", name] as const,
  },

  /* ---------- Checks ---------- */
  check: {
    detail: (id: string) => ["check", id] as const,
    reviewQueue: () => ["check-review-queue"] as const,
    counts: () => ["check-counts"] as const,
    sharedTenants: (id: string) => ["check-shared-tenants", id] as const,
  },
} as const;
