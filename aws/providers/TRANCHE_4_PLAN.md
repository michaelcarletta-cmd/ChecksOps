# AWS provider layer — Tranche 4 plan

## Goal

Port the **server-side provider architecture** from Supabase Edge Functions to AWS staging with a **hard execution block**.

This tranche is **not** approval to move real money. It does **not** redirect production webhooks.

```
React/Vite (Cognito)
  -> API Gateway
  -> Lambda provider adapter
  -> (blocked) provider API
```

Browser never sees provider credentials. Tenant/user/provider/wallet/bank/payment IDs from the browser are untrusted.

## Kill switches (default FALSE)

| Flag | Default | Effect |
| --- | --- | --- |
| `AWS_PROVIDER_EXECUTION_ENABLED` | false | Master execution kill switch |
| `AWS_MOOV_ENABLED` | false | Moov mutations |
| `AWS_CHECKALT_ENABLED` | false | CheckAlt mutations |
| `AWS_PLAID_ENABLED` | false | Plaid mutations |
| `AWS_ACTUM_ENABLED` | false | Actum mutations |
| `AWS_QUICKBOOKS_ENABLED` | false | QuickBooks mutations |
| `AWS_PROVIDER_LIVE_READS_ENABLED` | false | Unused in T4; adapters never call providers |
| `AWS_PROVIDER_WEBHOOK_DRY_RUN` | true (unset = true) | Verify + receipt only; no payment-table apply |

A disabled provider returns `403 provider_disabled`.

Tranche 4 also hard-blocks execution **even if flags are flipped to true**. Money movement is not implemented on AWS.

## What is allowed

Local read/status under RLS, when the handler cannot create, mutate, submit, transfer, deposit, or authorize anything externally:

- `POST /providers/moov/status` and `POST /functions/v1/moov-readiness` / `moov-transfer-status`
- `POST /providers/checkalt/status` and CheckAlt history/account **DB** reads
- `POST /providers/plaid/status`
- `POST /providers/actum/status` and `/providers/quickbooks/status` (interface only)
- `GET /providers/status` flag/permission/secret-configured snapshot
- `POST /webhooks/{moov,checkalt,plaid}` signature verify + idempotent dry-run receipt

## What stays disabled

Every class 2–3 and 5–9 operation in `PROVIDER_INVENTORY.md`, including stakeholder KYC mutations that would create or change a real Moov account.

## Authorization split

Application login ≠ provider execution authority.

Documented, **not activated**: deposit submission, disbursement, ACH, RTP, wallet transfer, stakeholder payment, provider configuration. See `provider-authz.mjs`.

## Identity / RLS

Same as T1–T2:

Cognito sub → `identity_accounts.application_user_id` → `request.app_user_id` → `auth.uid()`.

Spoofed `user_id` / `tenant_id` / `x-user-id` / `x-tenant-id` ignored. Ninth UUID fail-closed. Cross-tenant provider-id lookup → `403 spoofed_provider_id` or `403 cross_tenant_denied`.

Webhook tenant mapping uses SECURITY DEFINER lookups keyed by **provider** identifiers. Payload `tenant_id` is discarded.

## Webhooks

- Verify Moov HMAC-SHA512 (`timestamp|nonce|webhookID`) + legacy body signature
- CheckAlt/Plaid staging fixtures use HMAC-SHA256 over `id.timestamp.body`
- 5-minute timestamp window (replay rejection)
- Idempotent unique `(provider, external_event_id)`
- Dry-run: no writes to `payment_transfers`, wallets, `checkalt_deposits`, or other financial tables
- Safe logs: no secrets, routing, or account numbers

Do not point production Moov/CheckAlt/Plaid webhook URLs at these routes.

## Database

`aws/providers/sql/40_tranche4_webhook_receipts.sql` adds `aws_provider_webhook_receipts` plus lookup functions. It does not grant DML on financial tables.

## Financial reconciliation

Owner-level `aws/rls/sql/28_financial_aggregates.sql` before and after. Expect identical totals. No live provider transactions.

## Production boundaries

Do not change production DNS, frontend, Supabase functions, live payment credentials, or production webhook URLs.

## Deploy

Update `checksops-staging-api` in place (`UpdateFunctionCode` + env). Do not SAM-deploy thin `aws/template.yaml`.
