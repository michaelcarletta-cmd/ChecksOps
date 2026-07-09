
# Contractor Directory

A network-wide, browsable list of verified "Pro" contractors that any tenant can search and invite to a claim in one click. Exclusivity stays intact because only sponsored + verified contractors appear.

## What tenants see

New route: `/networking/contractors` (or a new "Directory" tab inside the existing Networking page).

```text
┌────────────────────────────────────────────────────────┐
│ Contractor Directory                                   │
│ [Trade ▾] [Region ▾] [Min rating ▾]  [Search…]         │
├────────────────────────────────────────────────────────┤
│  ▣ Acme Roofing            ★ 4.9 (23)   Roofing        │
│    Dallas, TX · Verified · 47 jobs paid                │
│    [View]  [Invite to claim ▾]                         │
├────────────────────────────────────────────────────────┤
│  ▣ BrightWorks Restoration  ★ 4.8 (11)  Water/Fire     │
│    Houston, TX · Verified · 22 jobs paid               │
│    [View]  [Invite to claim ▾]                         │
└────────────────────────────────────────────────────────┘
```

Filters: trade (multi), state/metro, minimum rating, "paid by me before" toggle.

Contractor detail drawer: bio, trades, service area, license #, COI on file, total jobs completed on ChecksOps, per-tenant reviews, tier badge.

"Invite to claim" opens a small popover: pick one of the tenant's active claims → sends invite. On accept, the contractor is added to that claim's contractor list and can receive payments immediately (already Verified, no Plaid re-verification).

## Who can appear in the directory

Only contractors flagged `is_directory_listed = true` AND `tier = 'pro'`. Contractor sets a `directory_opt_in` flag in their portal; admin flips `is_directory_listed` when they hit the Pro bar (sponsored + KYC + W-9 + COI + N paid jobs).

For this first build we ship the directory UI and the schema. The Pro tier gate and the contractor-side opt-in toggle land in the same phase so the directory is not empty at launch (we can also mark specific existing contractors as directory-listed manually via admin).

## Database

New tables (all RLS scoped, GRANTs included):

- `contractor_profiles`
  - user_id, display_name, bio, trades (text[]), service_states (text[]), service_metros (text[]), license_number, coi_expires_at, avatar_url, is_directory_listed (bool, admin-controlled), directory_opt_in (bool, contractor-controlled), tier ('guest'|'verified'|'pro'), created_at, updated_at.
- `contractor_reviews`
  - contractor_id, tenant_id, rating (1–5), comment, claim_id (nullable), created_at.
- `contractor_claim_invites`
  - contractor_id, tenant_id, claim_id, invited_by, status ('pending'|'accepted'|'declined'|'expired'), token, created_at, responded_at.

Derived stats (jobs_paid_count, avg_rating) served via a SQL view `contractor_directory_view` that joins `claim_check_payments` counts + reviews aggregate. Directory query hits this view only when `is_directory_listed = true`.

RLS:
- `contractor_profiles` SELECT allowed to any authenticated tenant user when `is_directory_listed = true AND directory_opt_in = true`; full row access to the owning contractor and service_role.
- `contractor_reviews` SELECT allowed to any authenticated tenant user for directory-listed contractors; INSERT restricted to tenant users whose tenant has a settled `claim_check_payments` row with that contractor (prevents fake reviews).
- `contractor_claim_invites` SELECT/INSERT restricted to the inviting tenant's users; SELECT also to the invited contractor.

## Edge functions

- `contractor-directory-search` — parameterized search (trade, state, min rating, text) hitting `contractor_directory_view`, returns paginated results. Server-side so filters/sorts stay consistent and RLS is enforced.
- `contractor-invite-to-claim` — creates a `contractor_claim_invites` row, sends the invite email/notification to the contractor, no-ops if a pending invite already exists for the same claim.
- `contractor-invite-respond` — accept/decline handler used from the contractor portal / email link. On accept, adds the contractor to `claim_contractors` for that claim.

Fee logic and Pro-tier auto-promotion are out of scope for this ticket — the directory reads whatever tier is already set. Admin can manually set `tier = 'pro'` + `is_directory_listed = true` on seed contractors.

## Frontend files

- `src/pages/ContractorDirectory.tsx` — new page, wired into the Networking route.
- `src/components/networking/ContractorDirectoryFilters.tsx` — filter bar (shadcn Select + Input, lucide icons).
- `src/components/networking/ContractorDirectoryCard.tsx` — one result row with tier/rating badges.
- `src/components/networking/ContractorDetailDrawer.tsx` — shadcn Sheet with full profile, reviews, invite CTA.
- `src/components/networking/InviteToClaimPopover.tsx` — claim picker + submit, uses TanStack Query mutation → `contractor-invite-to-claim`.
- Sidebar entry added under Networking, gated to tenant users (not contractor portal).

Dark theme, existing tokens, shadcn Card/Badge/Sheet/Select/Popover, lucide icons only, no new libraries.

## Rollout order

1. Schema + view + RLS + GRANTs (migration).
2. `contractor-directory-search` + `contractor-invite-to-claim` + `contractor-invite-respond` edge functions.
3. Directory page, filter bar, cards, detail drawer, invite popover.
4. Manual admin seed of initial Pro contractors so the directory has content on day one.

Confirm and I'll start with the migration.
