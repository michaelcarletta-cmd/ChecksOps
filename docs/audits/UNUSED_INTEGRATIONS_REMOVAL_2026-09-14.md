# Unused integrations — Phase 1 removal

**Date:** 2026-09-14  
**Owner decision:** Zapier, Telnyx, Stripe, Make.com = REMOVE / LEGACY_UNUSED.  
**Do not migrate or repair them.**

## Shared-workflow proof (must not remove if shared)

| Surface | Zapier | Telnyx | Stripe | Make.com | Shared with active workflow? |
|---|---|---|---|---|---|
| Moov / wallet / KYC / transfers | No | No | No | No | Keep Moov |
| CheckAlt / Ready for Deposit | No | No | No | No | Keep CheckAlt |
| Resend / transactional email | No | No | No | No | Keep Resend |
| Cognito login / identity | No | No | No | No | Keep Cognito |
| Check intake / Review / OCR / Textract | No | No | No | No | Keep |
| Endorsements / public sign links | No | No | No | No | Keep |
| Payees / mortgage / loss-draft | No | No | No | No | Keep |
| Payments / disbursements / funding | No | No | No (Stripe was tenant SaaS billing, not the money rail) | No | Keep Moov/CheckAlt |
| Documents / S3 storage | No | No | No | No | Keep S3 |
| Historical financial columns (`stripe_*`, `telnyx_message_id`, `zapier_webhook_url`) | Column only | Column only | Column only | — | **Kept.** No DROP. |

## What was removed (application code / UI only)

### Zapier

- Deleted unmounted `src/components/settings/ZapierIntegrationSettings.tsx` (never imported into App / WhiteLabelApp).
- Inventory `A4-225`–`A4-227` reclassified **N/A — LEGACY_UNUSED**.
- Kept generated `tenants.zapier_webhook_url` and write-allowlist `clientIgnored` entry.

### Stripe

- Deleted unused `src/components/billing/BillingConfigPanel.tsx` (imported in WhiteLabelSettings but never rendered; Stripe meter + “Report now to Stripe”).
- Deleted unmounted `src/components/white-label/TenantCreditManager.tsx` (Stripe Checkout top-up / customer portal). Inventory `CC-228`–`CC-232` → **N/A — LEGACY_UNUSED**.
- Removed dead `report-check-usage-to-stripe` invoke from `CheckUsageCard` (mutation was never rendered). Usage counters stay; they read RDS `get_tenant_check_usage` and mention Moov fees.
- Removed unused CheckUsageCard / BillingConfigPanel imports from WhiteLabelSettings.
- **Kept** `MaintenancePaymentsTracker` method option `Stripe` — that is a historical payment-method label, not the Stripe integration.
- **Kept** `stripe_*` columns, fail-closed AWS stubs, and `aws/tests/stripe-quickbooks-failclosed.test.mjs`.
- **Did not** delete AWS secrets or enable Stripe on Lambda.

### Telnyx

- No SPA UI or `src/` invoke of `send-sms` / Telnyx HTTP.
- AWS `send-sms` / `telnyx-sms-status` remain Class A **sink / dry-run ack**. They do not call `api.telnyx.com`.
- Left handlers in place so app-services routing and payment-direction (`telnyxCalled: false`) stay intact.
- **Did not** delete SMS secrets or `telnyx_message_id`.
- No inventory UI IDs to reclassify.

### Make.com

- No application code, UI, env, webhook, or dependency (`make.com`, `integromat`, `MAKE_WEBHOOK`). Already gone.

## Intentionally not deleted

- Historical billing / SMS / zapier columns and rows.
- `supabase/functions/tenant-*stripe*`, `send-sms`, `telnyx-sms-status`, `report-check-usage-to-stripe` (legacy project; Phase 2 classify only).
- AWS secrets / SSM / Secrets Manager entries whose ownership is not unambiguous.
- Production SPA lock, Cognito mappings, Moov webhook, Resend.

## Orphaned infrastructure (uncertain — report only)

| Item | Why not deleted |
|---|---|
| Any `STRIPE_*` / `TELNYX_*` / Zapier secrets in AWS or Supabase | Ownership not proven exclusive; unused-secret deletion can still break a forgotten webhook or rollback path |
| Hosted Stripe webhook / customer objects | Historical billing; do not mutate financial provider objects from this branch |
| Hosted Telnyx messaging profile | No live AWS caller; leave until an operator confirms no inbound SMS webhook |
| `zapier_webhook_url` values in RDS | Business-config history |

## Conflict check

Removal of the four UIs does **not** risk current production check processing, Moov, CheckAlt, Cognito, Resend, OCR, or disbursements. Stripe tenant-billing checkout was already unmounted / fail-closed. No STOP conflict.
