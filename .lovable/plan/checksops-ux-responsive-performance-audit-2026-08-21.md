# ChecksOps UX / Responsive / Performance Audit

Audit only — no code changed. Findings below come from reading the current repository.

## What I actually found

### The single biggest structural problem: `src/pages/CheckCommandCenter.tsx`
- **5,959 lines in one file**, 66 `useState`, 27 `useQuery`, 73 `invalidateQueries` calls, 36 `refetch` calls, 18 lazy imports, and 4 separate realtime channels (`check-command-center-${tenantId}`, `shared-checks-${tenantId}`, `checkops-realtime-${tenantId}`, `check-detail-rt-${checkId}`).
- The list, the detail panel, deposit ops, reports, mortgage companies, partners and homeowner uploads all live in the same component tree, so any state change anywhere re-renders the whole console.
- Two of the realtime channels subscribe to `check_intake_items` for the same tenant with `event: "*"`, so a single row update fans out into multiple invalidations of overlapping keys (`check-intake-items`, `check-dashboard-counts`, `check-stage-totals`, `check-review-queue`, `funds-released`, `deposit-items`…). That is the main reason a check "feels slow" moving between stages: the mutation resolves fast, then the UI does a broad refetch storm.
- Selected check is local state (`const [selectedCheck, setSelectedCheck] = useState`) with **no URL/searchParams state** in this file. Filters, tab, search and scroll position are not encoded anywhere, so back/refresh/deep-link loses the workspace.
- `@tanstack/react-virtual` is already a dependency and only used here — virtualization is partial.

### Responsive system
- No shared page shell. `max-w-*` is scattered: 63 `max-w-md`, 44 `max-w-2xl`, 35 `max-w-7xl`, 27 `max-w-3xl`, 20 `max-w-4xl`, 12 `max-w-6xl`, 12 `max-w-5xl`… Settings has `SettingsPageShell` (`max-w-7xl`) but nothing equivalent exists for operational pages.
- `useIsMobile` is used in only **9 files** out of 509 `.tsx` files, while 30+ files use raw `overflow-x-auto` tables. That means most tables just horizontally scroll on phones instead of switching to a card list. Confirmed offenders include `ClaimsTableConnected`, `AdminTenants`, `DepositReports`, `AdminCheckTracker`, `MortgageCompaniesDirectory`, `Payments`, `ClientDetail`, `InventoryTable`, `CheckAltSettings`, `TemplatesSettings`, networking tabs.
- Only 13 files use `hidden md:` / `md:hidden` dual-layout — so mobile card alternatives were built ad hoc for a handful of screens (Invoices being the most recent) and not systematized.
- Good foundations already exist in `src/index.css`: `px-fluid`, `gap-fluid`, `grid-fluid`, `truncate-flex`, `truncate-2/3`, `break-anywhere`, `text-fluid-*`, plus a `prefers-reduced-motion` block at line 245. They are barely adopted outside `AppLayout`.

### Design-token drift
- Hardcoded colors persist: `Endorse.tsx` (60 hits), `Settings.tsx` (26), `Sign.tsx` (15), `CheckCenterMarketing` (11), `CheckImagesViewer` (11), `PhotoReportDialog` (10), plus sidebar and branding components. Public-facing pages (Endorse, Sign) are the worst and are also the ones homeowners see on phones.

### Interaction quality
- 171 files use some `isPending`/`disabled={loading}` guard — decent coverage but inconsistent shape (no shared loading-button primitive), so feedback timing and spinner placement vary per module.
- Only **4 files use `onMutate`** (`DashboardNotepad`, `TenantBankAccountSettings`, `AIKnowledgeBaseSettings`, `ClaimFiles`). There is essentially **no optimistic UI in the check lifecycle** — every stage transition waits for the RPC round-trip plus a refetch storm.

### Query hygiene
- Widespread `select("*")` (e.g. `DepositManagerWorkflows`, `ClaimAccounting`, `DepositOperationsConsole`, `Sales`, several Darwin panels) on tables that include large JSON columns.
- Only 107 `.limit(` calls across the whole app; several list queries are unbounded.
- `src/lib/queryKeys.ts` exists but covers only loss draft / mortgage company / check — most call sites still hand-write key arrays, which is why invalidation is broad-brush.

### Bundle
- Heavy deps loaded in the app graph: `pdfjs-dist`, `react-pdf`, `pdf-lib`, `jspdf`, `xlsx`, `recharts`, `mapbox-gl-draw`. `App.tsx` lazy-loads routes well, but Darwin/estimate/photo tooling is where the weight is; check-only tenants should never download it.

---

## Proposed unified architecture

```text
src/components/shell/
  PageShell.tsx        width + px-fluid + vertical rhythm (one place)
  PageHeader.tsx       title, subtitle, actions, breadcrumb, mobile-collapsing
  SectionCard.tsx      (exists in settings — promote to shared)
  DataView.tsx         table on >=md, card list on mobile, one data definition
  FilterBar.tsx        URL-synced filters/search/sort
  DetailPane.tsx       side panel on desktop, full-screen sheet + Back on mobile
  ActionButton.tsx     pressed/loading/success states, double-submit guard
```

- One `columns`-style definition feeds both the desktop table and the mobile card renderer, so no screen has to hand-build two layouts again.
- `useListViewState()` hook stores tab/filters/search/sort/page/selected-id in `useSearchParams` + restores scroll — fixes back-navigation across every module at once.
- Truncation contract: containers get `min-w-0`, single-line identity fields use `truncate-flex` + tooltip with full value, addresses/notes use `truncate-2`, monetary and check numbers use `tabular-nums whitespace-nowrap` and never truncate.

---

## Phased plan

### Phase 1 — Quick wins, presentation only (low risk)
1. Introduce `PageShell` / `PageHeader` and adopt on the top 10 operational pages (widths, gutters, rhythm) without touching data code.
2. Global truncation pass on the identity fields (insured name, address, bank, filename, email) using existing utilities; add tooltips for truncated values.
3. Replace hardcoded colors in `Endorse.tsx`, `Sign.tsx`, `Settings.tsx`, `CheckImagesViewer`, `PhotoReportDialog` with tokens.
4. Shared `ActionButton` with pressed/loading/disabled states + double-submit guard; swap in on check stage actions, deposit approve, disbursement send.
5. Skeletons instead of spinners on the check list, detail panel, funds tabs; 150–200ms transitions honoring reduced motion.
6. Touch targets: minimum 40px on all interactive rows/menu items on mobile; safe-area padding on sticky bars (bulk action bar, mobile detail header).

Regression check: visual pass at 390 / 768 / 1280 / 1920; no horizontal scroll; endorsement and signing pages render identically for homeowners.

### Phase 2 — Responsive data views (low/medium risk)
7. Build `DataView` and migrate the tables that currently horizontally scroll: check list, deposit history, deposit reports, admin tenants, mortgage companies, claims table, networking tabs.
8. Mobile detail behavior: list → full-screen detail with ← Back, per the mobile-layout rules; desktop keeps the split pane.
9. `FilterBar` + `useListViewState` URL sync on Check Command Center first, then Payments/Claims/Deposit Ops.

Regression check: each migrated table shows identical rows/counts to before; filters produce identical result sets; deep links restore state; RLS-scoped data unchanged (no query edits in this phase).

### Phase 3 — Query & render performance (medium risk)
10. Split `CheckCommandCenter.tsx` into `CheckListPanel`, `CheckDetailPanel`, `DepositOpsPanel`, `ReportsPanel`, `PartnersPanel`, `HomeownerUploadsPanel`, each lazy and each owning its own queries.
11. Consolidate the 3 tenant-level realtime channels into **one** subscription that dispatches targeted invalidations; drop `event: "*"` where only UPDATE matters.
12. Extend `src/lib/queryKeys.ts` to cover every check/deposit/funds key and replace hand-written arrays; convert broad invalidations to `setQueryData` on the affected row where the payload is known.
13. Narrow `select("*")` to explicit columns on the heaviest reads; add `.limit()`/pagination to unbounded lists; virtualize the check list and deposit history with the already-installed `@tanstack/react-virtual`.
14. Debounce search inputs (250ms), prefetch check detail on row hover/focus.

Regression check: counts on every tab match pre-change values for a fixed tenant; realtime still updates within ~1s on stage change from another session; Freedom-embedded mode (`embeddedClaimId`/`embeddedMode`) still works; shared-check thread still live.

### Phase 4 — Workflow optimism (medium risk, carefully scoped)
15. Optimistic UI **only for workflow state**: needs_review → endorsements_in_progress → approved_for_deposit, assignment, tagging, notes, bulk stage moves. Implemented as `onMutate` + rollback on `onError`, still via `submit_check_review_decision` RPC — no direct table writes.
16. **Explicitly NOT optimistic**: deposit submission to CheckAlt, Moov disbursements/transfers, wallet balances, micro-deposit verification, invoice payment status, loss-draft release of funds. These stay confirmation-driven with a clear "submitting → confirmed by provider" two-stage indicator so a pending state is never mistaken for a completed money movement.

Regression check: force RPC failures and confirm rollback; verify no duplicate submits under rapid double-tap; audit history rows unchanged in count and content; webhook-driven states still win over local optimistic state.

### Phase 5 — Bundle & accessibility
17. Route-group split so Darwin/estimate/photo/PDF/xlsx/mapbox chunks never load for check-only tenants; dynamic-import `xlsx` and `jspdf` at export time only.
18. Keyboard/focus pass: visible focus rings, modal focus trap and restore, labels on all inputs, contrast check on badges and muted text.

---

## Measurable targets
- LCP < 2.0s, INP < 200ms, CLS < 0.05 on the check list route (mid-tier Android, throttled 4G).
- Stage-change perceived response < 100ms (optimistic paint), server confirmation < 1.5s.
- Route transition to check detail < 250ms with prefetch.
- Initial JS for `/:slug/checks` under 400KB gzipped after Phase 5.
- Zero horizontal scroll at 320/390/768/1024/1440/1920.
- Verification: Lighthouse CI on the three main routes, React Profiler render counts before/after on the check list, a network-call counter per stage transition (target: 1 mutation + ≤2 targeted invalidations, down from the current fan-out).

## Bundle together vs keep separate
- Bundle: Phase 1 items 1–6 (pure presentation, one review pass).
- Bundle: Phase 2 items 7–9 per module (one module per PR so counts can be diffed).
- Keep separate: item 11 (realtime consolidation) and item 15 (optimism) — each alone, each with its own verification session.

## Do NOT touch yet
- Everything on the public-launch freeze list unless explicitly unlocked: CheckAlt flow, Mortgage Ops, Homeowner Ledger/signing, per-tenant auto-approve, disbursement console internals, invoicing backend.
- `src/integrations/supabase/client.ts`, `types.ts`, `.env`, `supabase/config.toml`.
- Any RLS policy, RPC signature, or webhook handler — this program is frontend-only.
- The endorsement token flow and `/endorse` page logic (styling only, no behavior).
- Actum/Plaid code paths that are hidden but must remain intact.
