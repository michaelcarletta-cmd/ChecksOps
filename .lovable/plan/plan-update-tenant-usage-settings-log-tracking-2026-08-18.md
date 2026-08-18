# Plan: Update Tenant Usage Settings & Log Tracking

The user reported that the usage settings for the tenant did not update correctly in the frontend. Based on the previous task, I modified the categorization of usage (Check Processing, MortgageOps, Disbursement) and added a trigger for MortgageOps tracking. The user's screenshot shows the updated categories are visible, but the log below is empty and the "Mortgage Ops Usage" shows 0 even after I claimed to have implemented it. I need to ensure the frontend queries and the database trigger are correctly synced and that the log displays the categorized events correctly.

## Proposed Changes

### Database & Backend
- Verify `tg_record_mortgage_handling_billing` trigger: Ensure it correctly identifies the tenant and claim from `claim_checks` when a `check_intake_item` stage changes.
- Verify `get_tenant_check_usage` RPC: Ensure it includes the `mortgage_handling` and `moov_*` event types in its result set.

### Frontend
- **src/components/settings/TenantUsageTracker.tsx**
    - Update the top summary cards to use the same categorization as `AdminTenants.tsx` and the user's screenshot.
    - Ensure the "Estimated fees" logic for MortgageOps uses the tiered pricing ($10/$5) recorded in the `check_billing_events` table rather than calculating locally.
    - Update the "Funding & Deposit Log" to show all billing events, not just payments, so users can track monthly usage as requested.
- **src/components/settings/TenantUsageDashboard.tsx** (and other usage components)
    - Standardize the event categorization (check_processing, mortgage_handling, moov_same_day, moov_instant).
    - Ensure the "Detailed Log" at the bottom displays the `event_type` clearly.

### Verification Plan
- Use `lovable supabase query` to check for existing `check_billing_events` records for a test tenant.
- Manually trigger a status change on a test check via `lovable supabase query` to verify the trigger inserts a `reported` billing event.
- Check browser console logs for any RPC errors.
