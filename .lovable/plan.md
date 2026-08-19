---
title: Fix Invoice Branding Discoverability and Email Log Visibility
description: Address the issue where invoice branding settings are blank/missing and improve email log visibility for tenants.
---

### Problem Analysis
1.  **Invoice Branding Missing**: The user is being redirected to branding settings, but "it does not show anything." This usually means either the tab selection is incorrect, or the `CompanyBrandingSettings` component is failing to load/render correctly in the context it's placed. In `InvoicesTab.tsx`, the navigation points to `/freedom/settings?tab=organization`, but `Settings.tsx` likely expects a specific tab ID to show the branding section.
2.  **Email Logs Count**: The user reports only seeing 8 emails despite sending many. This is likely due to the `email_send_log` table missing `tenant_id` on older records or RLS policies filtering out records where `tenant_id` was not correctly associated during the send process. The `TenantEmailHealthPanel` filters by `tenant_id`.

### Proposed Changes

#### 1. Invoice Branding Fix
*   Update `InvoicesTab.tsx` navigation to point to the correct tab in `Settings.tsx`.
*   Ensure `Settings.tsx` correctly handles the `organization` or `branding` tab and renders `CompanyBrandingSettings`.
*   Verify `CompanyBrandingSettings.tsx` correctly resolves the `tenant_id` and doesn't fail silently if branding data is missing (it uses `maybeSingle()`, which is good, but we should ensure it handles the "no data" state gracefully).

#### 2. Email Log Visibility Fix
*   Investigate why many emails aren't showing up. It's highly probable that many existing logs have a `null` `tenant_id`.
*   Update the `TenantEmailHealthPanel` to potentially include a broader fetch or ensure that all future emails are strictly tagged with `tenant_id`.
*   Add a migration to backfill `tenant_id` in `email_send_log` where possible (e.g., by matching `recipient_email` to users or using the `message_id` context if available).
*   Increase the limit in `TenantEmailHealthPanel` or add pagination if the user expects to see a long history.

#### 3. UI/UX Refinement
*   Ensure the "Invoice Branding" shortcut in the `InvoicesTab` actually lands the user on the "Branding" section, not just the general "Organization" settings.

### Technical Details
*   **Settings Tab Mapping**: Verify `Settings.tsx` tab triggers.
*   **Database**: Run a query to check `tenant_id` distribution in `email_send_log`.
*   **Edge Functions**: Check if the email-sending edge functions are correctly passing `tenant_id` to the log insertion logic.

### Verification Plan
*   Manually test navigation from `Invoices` to `Branding Settings`.
*   Check the email log count before and after potential backfill or query adjustment.
*   Verify new emails are logged with the correct `tenant_id`.
