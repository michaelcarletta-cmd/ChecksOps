# Provider inventory (current `main`)

Authoritative tip when this inventory was written: merge of PR #95 (Tranche 2). Tranche 3 write-path files are **not** on `main`. This inventory is independent of T3.

Production ChecksOps remains on Lovable/Supabase. This document does not redirect webhooks or enable money movement.

Full Lovable → AWS function-by-function parity (GO/NO-GO, missing equivalents, sandbox/UAT config, NAT): `aws/providers/LOVABLE_AWS_PROVIDER_PARITY.md`.

## Classification

| # | Class |
| --- | --- |
| 1 | read/status-only |
| 2 | identity/KYC/KYB setup |
| 3 | bank/account connection |
| 4 | webhook ingestion |
| 5 | deposit submission |
| 6 | money movement |
| 7 | disbursement |
| 8 | provider configuration/admin |
| 9 | notification side effect |

AWS column: `db_status` = local RLS read allowed; `webhook` = signature + receipt + dry-run; `disabled` = `403 provider_disabled`; `interface_only` = config boundary, no live calls.

## Moov (39 Edge Functions)

| Function | Class | AWS | Notes |
| --- | --- | --- | --- |
| moov-account-create | 2 | disabled | Creates a real Moov account |
| moov-account-discover | 1 | disabled | Live Moov GET |
| moov-account-onboard | 2 | disabled | Creates/changes Moov account |
| moov-account-files | 2 | disabled | KYC file list/upload |
| moov-account-file-upload | 2 | disabled | Uploads KYC documents |
| moov-account-file-view | 1 | disabled | Fetches KYC bytes from Moov |
| moov-onboarding-link | 2 | disabled | Hosted onboarding session |
| moov-readiness | 1 | db_status | Local `payment_provider_accounts` snapshot + ported readiness math |
| moov-selftest | 8 | disabled | Uses platform Moov credentials |
| moov-sync | 2 | disabled | Writes local rows from Moov |
| moov-wallet-sync | 6 | disabled | Pulls live balances |
| moov-wallet-fund | 6 | disabled | Real funding transfer |
| moov-bank-account-add | 3 | disabled | Adds a bank at Moov |
| moov-bank-link-token | 3 | disabled | Bank-link token |
| moov-micro-deposit-initiate | 3 | disabled | Micro-deposits move money |
| moov-micro-deposit-confirm | 3 | disabled | Confirms micro-deposits |
| moov-plaid-bridge | 3 | disabled | Links Plaid into Moov |
| moov-platform-bank | 8 | disabled | Platform treasury bank |
| moov-tos-token | 2 | disabled | Platform Agreement token |
| moov-tos-accept | 2 | disabled | Records TOS at Moov |
| moov-underwriting | 2 | disabled | Submits underwriting |
| moov-recipient-create | 2 | disabled | Stakeholder Moov account |
| moov-recipient-session | 2 | disabled | Recipient hosted session |
| moov-recipient-tos-accept | 2 | disabled | Recipient Platform Agreement |
| moov-recipient-kyc-update | 2 | disabled | Mutates recipient KYC |
| moov-recipient-bank-add | 3 | disabled | Recipient bank |
| moov-recipient-disconnect | 2 | disabled | Disconnects recipient |
| moov-transfer-create | 6 | disabled | ACH/RTP/wallet transfer |
| moov-transfer-status | 1 | db_status | Local `payment_transfers` only |
| moov-transfer-group-create | 6 | disabled | Grouped transfers |
| moov-disburse | 7 | disabled | Disbursement execution |
| moov-tenant-fee-charge | 6 | disabled | Tenant fee charge |
| moov-fee-schedule-upsert | 8 | disabled | Fee schedule mutation |
| moov-fee-schedule-cancel | 8 | disabled | Fee schedule cancel |
| moov-fee-rollup | 8 | disabled | Provider fee reporting |
| moov-sweep-config | 8 | disabled | Sweep configuration |
| moov-invoice | 9 | disabled | Invoice send |
| moov-bulk-import-preview | 8 | disabled | May call Moov |
| moov-webhook | 4 | webhook | `POST /webhooks/moov` |

## CheckAlt (9)

| Function | Class | AWS | Notes |
| --- | --- | --- | --- |
| checkalt-submit-deposit | 5 | disabled | Live deposit. Integer-cents `userAmount` preserved in adapter only |
| checkalt-approve-deposit | 5 | disabled | Approves a pending deposit |
| checkalt-poll-status | 1* | disabled | Calls CheckAlt **and updates** `checkalt_deposits` |
| checkalt-deposit-history | 1 | db_status | Local `checkalt_deposits` |
| checkalt-account-status | 1 | db_status | Local `checkalt_tenant_accounts`; no FinCapture GET |
| checkalt-test-connection | 8 | disabled | Authenticates against CheckAlt |
| checkalt-register-account | 3 | disabled | Registers a depositor |
| checkalt-verify-account | 3 | disabled | Verifies a CheckAlt account |
| checkalt-prepare-image | 5 | disabled | Deposit-image helper; kept disabled |

\* Poll is not a pure read.

Existing table `deposit_webhook_events` is the historical CheckAlt/deposit webhook log. AWS staging uses `aws_provider_webhook_receipts` so financial tables stay unchanged.

## Plaid (5)

| Function | Class | AWS | Notes |
| --- | --- | --- | --- |
| plaid-link-token-create | 3 | disabled | Link token |
| plaid-link-token-create-public | 3 | disabled | Public/homeowner Link |
| plaid-exchange | 3 | disabled | Public-token exchange |
| plaid-disburse | 7 | disabled | Plaid Transfer disbursement |
| plaid-transfer-webhook | 4 | webhook | `POST /webhooks/plaid` |

No isolated Plaid sandbox is wired on AWS staging. Account connection stays off.

## QuickBooks (2)

| Function | Class | AWS | Notes |
| --- | --- | --- | --- |
| quickbooks-auth | 8 | disabled | OAuth connect/refresh |
| quickbooks-payment | 6 | disabled | Creates QuickBooks payments |

## Actum

No `actum-*` Edge Function exists on current `main`. Frontend/`actum_transactions` remnants only. AWS exposes `POST /providers/actum/status` as an interface/secrets boundary. No live charges.

## Related payment / notification functions

| Function | Class | AWS | Notes |
| --- | --- | --- | --- |
| initiate-wallet-funding | 6 | disabled | |
| cancel-wallet-funding | 6 | disabled | |
| calculate-payment-funding | 6 | disabled | Used immediately before execution |
| process-funded-payment | 6 | disabled | |
| wallet-fund-on-clear | 6 | disabled | |
| platform-treasury | 8 | disabled | |
| homeowner-deductible-pay | 6 | disabled | |
| homeowner-bank-link-send | 9 | disabled | Email + bank link |
| stakeholder-resend-verification | 9 | disabled | KYC/verification email |
| public-invoice | 9 | disabled | |

Email/SMS (`send-email`, `send-transactional-email`, `resend-webhook`, endorsement request) are notification side effects. They stay disabled. Provider-event emails are not sent from AWS.

## Idempotency (preserved model)

- Moov transfers: `payment_transfers.idempotency_key` + `payment_idempotency_keys`
- Moov webhooks: unique `(provider, external_event_id)` on `payment_webhook_events` (production). AWS staging receipts: unique `(provider, external_event_id)` on `aws_provider_webhook_receipts`
- CheckAlt: check + integer-cents amount + reference number
- Plaid Transfer: cursor on `plaid_webhook_cursors` + `event_id` upsert
- Disbursement splits: `idempotence_key`

## Secrets / config

Secrets belong in AWS Secrets Manager (`PROVIDER_SECRETS_ARN`). Browser never receives provider credentials. Status/health endpoints return `*_configured` booleans only.

Expected secret keys (not all must be present in staging):

- Moov: `MOOV_PUBLIC_KEY`, `MOOV_SECRET_KEY`, `MOOV_PLATFORM_ACCOUNT_ID`, `MOOV_WEBHOOK_SECRET`, `MOOV_ENVIRONMENT`, `MOOV_ALLOWED_ORIGIN`. Do not use `MOOV_ACCOUNT_ID` as facilitator. Tenant ids live in `payment_provider_accounts.provider_account_id`.
- CheckAlt: `CHECKALT_FI_KEY`, `CHECKALT_USERNAME`, `CHECKALT_PASSWORD`, `CHECKALT_WEBHOOK_SECRET`, `CHECKALT_BASE_URL`
- Plaid: `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_WEBHOOK_SECRET`, `PLAID_ENV`
- Actum: `ACTUM_USERNAME`, `ACTUM_PASSWORD`, `ACTUM_PARENT_ID`
- QuickBooks: `QUICKBOOKS_CLIENT_ID`, `QUICKBOOKS_CLIENT_SECRET`, `QUICKBOOKS_REDIRECT_URI`

Staging webhook fixture tests may use `AWS_MOOV_WEBHOOK_SECRET` / `AWS_CHECKALT_WEBHOOK_SECRET` / `AWS_PLAID_WEBHOOK_SECRET` on the Lambda. These are **not** production webhook secrets and must not be installed on production provider dashboards.

## Stakeholder / KYC semantics to preserve later

Do not regress when execution is eventually enabled in sandbox:

- Reuse existing `payment_provider_accounts.provider_account_id` (do not create a second Moov account for the same tenant)
- Platform Agreement / TOS (`tos_accepted_at`, `tos_source`)
- KYC/KYB `verification_status` and capability requirements
- Bank setup gating before send-funds
- Recipient onboarding (`moov-recipient-*`) as a separate mapped account owned by the tenant

Tranche 4 ports the read model and keeps every mutation disabled.
