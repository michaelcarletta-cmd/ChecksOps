

# Cross-Tenant Check Sharing

## Overview
Add the ability to selectively share individual checks between tenants so contractors and public adjusters working together on specific claims can track shared checks without exposing their entire check portfolio.

## How It Works
- A tenant admin can "share" a specific check with another tenant
- The receiving tenant sees a read-only copy of the shared check in their Check Command Center, visually tagged as "Shared"
- The originating tenant controls which checks are shared and can revoke access at any time
- Shared checks update in real-time -- when the owner updates status, amount, or endorsement info, the partner tenant sees the latest data

## Database Changes

**New table: `shared_checks`**
- `id` (UUID, PK)
- `check_id` (UUID, FK to check_intake_items)
- `source_tenant_id` (UUID, FK to tenants -- the owner)
- `target_tenant_id` (UUID, FK to tenants -- the recipient)
- `shared_by` (UUID, FK to auth.users)
- `access_level` (text, default 'read_only' -- future-proof for edit access)
- `created_at`, `revoked_at` (nullable, soft-revoke)
- RLS: source tenant members can insert/update/delete; target tenant members can select active (non-revoked) shares

**No data duplication** -- shared checks are not copied. The target tenant queries `check_intake_items` joined through `shared_checks` to see the originating check data.

## UI Changes

### Check Command Center (both system and white-label)
1. **Share button** on each check row (kebab menu or action column) -- opens a dialog to pick a target tenant
2. **"Shared with you" tab or filter** -- lets tenants toggle between "My Checks" and "Shared with Me"
3. **Visual badge** -- shared checks display a small "Shared" or partner name tag
4. **Manage Shares panel** -- source tenant can see who they've shared each check with and revoke access

### Share Dialog
- Dropdown of available tenants (fetched from `tenants` table, excluding self and system)
- Confirm button to create the share record

## Query Changes
- `CheckCommandCenter` adds a secondary query joining `shared_checks` + `check_intake_items` where `target_tenant_id = current tenant` and `revoked_at IS NULL`
- Results merged into the check list with a `shared: true` flag for UI differentiation
- Shared checks are read-only in the target tenant's view (no edit/delete actions)

## Technical Details

| Area | Detail |
|------|--------|
| Migration | Create `shared_checks` table with RLS, indexes on `check_id`, `source_tenant_id`, `target_tenant_id` |
| Realtime | Enable realtime on `shared_checks` so partner sees new shares immediately |
| RLS | Source tenant: full CRUD on own shares. Target tenant: SELECT only on active shares. Check data visibility via join (existing check RLS bypassed by `source_tenant_id` ownership proof) |
| Files touched | `CheckCommandCenter.tsx`, `useTenantFilter.ts` (add shared-check merge), new `ShareCheckDialog.tsx`, new `SharedChecksBadge.tsx`, migration SQL |

