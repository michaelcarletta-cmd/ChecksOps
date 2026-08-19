# Plan: Improve Discoverability for Invoice Customization and Email Logs

## Problem
The user was unable to find:
1. **Invoice Customization**: Currently located deep in `Settings > Organization > Company Branding`.
2. **Email Deliverability**: Currently in `Settings > Email`.
The user also reported that "nothing is showing there" in email deliverability, suggesting potential RLS issues or missing data for their specific tenant.

## Proposed Changes

### 1. Invoice Customization Accessibility
- Add an "Invoice Settings" shortcut/link directly within the **Invoices** tab of the **Payments** page. This will allow users to jump straight to the branding settings without digging through the organization menu.
- Add a "Company Branding" shortcut in the **Organization** tab of settings that is more prominent.

### 2. Email Deliverability & Logs
- **Fix Data Visibility**: Investigate and fix RLS policies for `email_send_log` and `suppressed_emails`. Currently, they are restricted to `service_role`. We need to allow `authenticated` users to see logs *scoped to their tenant_id*.
- **Add Deliverability to Payments**: Add a new "Email Logs" or "Deliverability" tab to the main **Payments** page (or as a sub-tab) to make it easier for financial users to track payment-related notifications.

### 3. Technical Implementation
- **Migrations**: Add RLS policies for `email_send_log` and `suppressed_emails` to allow `SELECT` for authenticated users where `tenant_id = current_setting('app.current_tenant_id')::uuid` (or equivalent tenant scoping).
- **Frontend**: 
    - Update `src/pages/payments/InvoicesTab.tsx` to include a "Customize Invoice Branding" button.
    - Update `src/pages/Payments.tsx` to include an "Email Deliverability" tab.

## User Review Required
> [!IMPORTANT]
> - Should "Email Deliverability" be accessible to all organization members or just Admins?
> - Do you want the invoice branding settings to remain in the central branding section, or should we move the invoice-specific fields to the Payments page entirely?
