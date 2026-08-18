# Plan - Moov Sync & MortgageOps Usage Billing Integration

Improve compliance workflows by reinforcing the sync between vetting documents and Moov, and implement comprehensive usage tracking and billing visibility for MortgageOps.

## User Review Required

> [!IMPORTANT]
> The MortgageOps usage will be billed at a flat fee (default $15.00) per completed request. This fee will be visible in the "Usage & Payments" tab for admins to review before pulling the monthly consolidated payment.

- **Vetting Document Sync**: Confirm that the "Compliance & Docs" tab in Admin/Settings meets the expectation of streaming all KYC/KYB records directly to Moov.
- **MortgageOps Billing**: Confirm the flat fee per request is correct, or if a different pricing model is needed.

## Proposed Changes

### Backend - Database & Edge Functions

#### [Database] Billing Events Expansion
- Update `check_billing_events` or create a new `mortgage_billing_events` table to track MortgageOps fees.
- Update `get_tenant_check_usage` RPC to include these events in the consolidated usage report.

#### [Edge Function] `bill-mortgage-handling`
- Ensure it records a billing event in the database when a request is marked as 'completed' and billed via Stripe.
- Add metadata to link the billing event to the specific `mortgage_handling_request`.

#### [Edge Function] `moov-sync` & `moov-account-file-upload`
- Audit to ensure vetting documents uploaded via the frontend are correctly mapped to Moov document purposes (business_verification, etc.).
- Ensure `moov-readiness` reflects the status of these specific document submissions.

### Frontend - Admin & Settings

#### [Admin] Tenant Usage Dashboard
- Update `TenantUsageInlinePanel` in `src/pages/admin/AdminTenants.tsx` to:
    - Display "MortgageOps Handling" as a line item.
    - Calculate the total MortgageOps fees for the selected period.
    - Include MortgageOps fees in the "Pull Consolidated" calculation.
- Update `TenantUsageDashboard.tsx` to reflect the same information for tenant-side visibility.

#### [Settings] Compliance & Vetting
- Enhance `ComplianceSettings.tsx` to explicitly state that identity/vetting documents are synced with Moov.
- Ensure the `VerificationDocumentsPanel` correctly reflects the status of "Action Required" items from Moov.

## Technical Details

- **RPC Update**: Modify `public.get_tenant_check_usage` to join with `mortgage_handling_requests` where `billing_status = 'billed'`.
- **Fee Configuration**: Use the `default_flat_fee_cents` from `mortgage_desk_config` (currently $15.00) for usage calculations.
- **Moov Mapping**: Map `tenant_documents` or `verification_files` to Moov's `files` API using the `moov-account-file-upload` edge function.

## Measurement of Success
- Admins can see the exact number of MortgageOps requests completed and the total amount due in the Tenant Management usage panel.
- Tenants can see their MortgageOps usage in their own billing settings.
- Vetting documents uploaded by tenants are visible as "Pending" or "Approved" in both the tenant settings and admin compliance view, synced with Moov status.
