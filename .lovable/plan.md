# Check Command Center — Performance Overhaul + Workflow Tweaks

This is a large, multi-phase refactor. `CheckCommandCenter.tsx` is currently ~3,000+ lines and touches locked flows (endorsement, CheckAlt, deposit, auto-approve). I'll do this in phases so each ships behind verified behavior and nothing locked breaks.

## Phase 0 — Small workflow tweaks (ship first, low risk)

1. **Move DTP (Direction to Pay) into the Files tab.** Today the signed DTP appears in its own section; `CheckFilesSection` already renders DTPs (badge "signed DTP"). I'll remove the standalone DTP block in the detail pane and rely on `CheckFilesSection` only.
2. **Allow image uploads at any status.** Remove status gating on `ReuploadCheckImageButton` and the file uploader in the detail pane so front/back re-uploads work in every stage (deposited included).
3. **Mortgage-ops invoicing → tenant usage.** Stop generating a per-request contractor invoice. Instead:
   - Add `mortgage_ops_usage_events` (tenant_id, request_id, shipping_cost_cents, services_cost_cents=1000, occurred_at). RLS tenant-scoped, GRANTs for authenticated + service_role.
   - Write one row per completed mortgage-ops request (trigger on `mortgage_handling_requests` status → completed).
   - Surface the running month total in the existing `TenantUsageTracker` card.
   - Hide/disable the "Invoice Contractor" button in `MortgageOpsRequestDetail`, replace with a read-only "Billed to tenant usage" line.
   - No Stripe change here — end-of-month sweep is a later manual step.

## Phase 1 — Measurement + queue query slim-down

- Add `src/lib/perf/measure.ts` with dev-only `mark/measure` helpers and named marks: `check_row_clicked`, `detail_shell_rendered`, `primary_detail_ready`, `check_images_ready`, `secondary_panels_ready`, `tab_switch_started`, `tab_switch_completed`. No-op in production.
- Replace the current `select("*")` on the queue with an explicit `CHECK_QUEUE_FIELDS` projection (as spec'd). Verify no downstream code reads a stripped field from the queue row — anything missing must move to `useCheckDetail`.
- Add DB indexes only where missing:
  - `check_intake_items(tenant_id, check_stage)`
  - `check_intake_items(tenant_id, status)`
  - `check_payees(check_id)`, `check_endorsements(check_id, status)`, `checkalt_deposits(check_id, updated_at desc)`
  - Skip the ones already added recently (`tenant_id, created_at desc`).

## Phase 2 — Extract hooks + shell/detail split

- New hooks:
  - `useCheckQueue.ts` — realtime-aware queue query + one-pass `bucketChecks` with `useDeferredValue(search)`, memoized `checksById` map, per-tab lists.
  - `useCheckDetail.ts` — `["check-detail", id]` with `staleTime 5m`, `gcTime 30m`, `placeholderData` from queue row.
  - `useCheckImageUrls.ts` — `["check-image-url", id, side, path]` cached signed URLs (45m stale).
- New components (thin wrappers over existing JSX, no logic changes):
  - `CheckCommandToolbar`, `CheckTabs`, `CheckQueuePane`, `CheckQueueTable`, `CheckQueueRow` (`React.memo`), `CheckDetailPane`, `CheckDetailShell`, `CheckPrimarySummary`, `CheckDetailSections`, `CheckCommandDialogs`.
- `CheckDetailShell` renders immediately from queue row while `useCheckDetail` hydrates. No blanking on switch. Stable `key={checkId}`.
- `startTransition` for tab/filter changes; selection stays synchronous.

## Phase 3 — Prefetch, optimistic updates, section-scoped queries

- Row hover/focus → `prefetchQuery(["check-detail", id])` after ~120ms; cancel on pointer leave. Also prefetch neighbors (prev/next visible row) after selection.
- Mutations: `setQueryData(["check-detail", id], updater)` + narrow invalidations. Kill any `invalidateQueries({queryKey:["check-detail"]})` broad calls.
- Secondary sections (Messages, Audit, Files, Deposit packet, Homeowner ledger, Payments, CheckAlt history, Loss prevention, Shared threads) → `React.lazy` + `Suspense` per section, `enabled: sectionOpen && !!checkId` on their queries.
- Realtime: scope invalidations to the changed `check_id` only.

## Phase 4 — Thumbnails, virtualization, layout stability

- Add `front_thumbnail_path` / `back_thumbnail_path` columns; generate 800px WebP thumbnails in the existing upload path via `compressCheckImage` (add a `generateThumbnail` variant). Backfill lazily on read: if thumbnail missing, use original but enqueue a background thumbnail job.
- Queue rows + inline preview use thumbnails; endorsement editor and viewer still use originals (locked flows untouched).
- Virtualize queue with `@tanstack/react-virtual` when a bucket > 60 rows. Preserve group headers, keyboard nav, hover prefetch.
- Replace animated width transition with `grid-template-columns: minmax(360px, 40%) minmax(0, 1fr)` on desktop. Mobile keeps the current stacked pattern.
- Store per-tab scroll offsets in a `useRef` map.

## Phase 5 — Verification

- Add React Profiler dev overlay (behind `?perf=1`) reporting the marks above.
- Manual test matrix from the spec (10 → 1000 rows, rapid switching, expired URLs, realtime bursts, endorsement + deposit dialogs open, mobile + desktop). Confirm all acceptance criteria.

## Locked-flow guardrails

I will **not** touch:
- `check-endorsement`, `submit-signature`, `composite-endorsement-signatures`, `checkalt-*`, `submit_check_review_decision` RPC, auto-approve, disbursement console internals, homeowner ledger send functions.
- The reissue tab, bulk action bar, or the endorsement adjuster's split-save flow.
- Endorsement token expiry, tenant resolution, or any RLS/tenant scoping.

Any change near these gets a read-only pass — hooks are added around them, not inside them.

## Deliverable order

1. Phase 0 tweaks (DTP move, upload-anytime, mortgage-ops usage) — 1 batch of edits + 1 migration.
2. Phase 1 (marks + queue projection + missing indexes) — 1 migration + edits.
3. Phase 2 (hooks + shell split, no visual change).
4. Phase 3 (prefetch/optimistic/lazy sections).
5. Phase 4 (thumbnails + virtualization + grid layout).
6. Phase 5 (profiling pass + fixes).

Each phase leaves the app fully working; you can stop me between any two phases.

## Technical notes

- Query key canonicalization: settle on `["check-detail", id]`, `["check-queue", tenantId]`, `["check-images", id]`, `["check-endorsements", id]`, `["check-payments", id]`, `["check-messages", id]`, `["check-audit", id]`, `["check-files", id]`, `["check-deposit", id]`. Migrate stragglers.
- `placeholderData` uses previous data on ID change to prevent flicker.
- `useDeferredValue` on the search string; input stays controlled and instant.
- No new deps except `@tanstack/react-virtual` (Phase 4).
- Thumbnail column adds are additive; nothing reads them until Phase 4 lands.

Approve and I'll start with Phase 0 (the three workflow tweaks) in the next turn.
