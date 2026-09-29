# Freedom → ChecksOps production funding path — freeze evidence

Read-only safeguard. This file does **not** authorize a transfer, Lambda
overlay, SQL apply, or monthly-billing activation.

## Live production baseline (2026-09-29T15:14:59Z)

| Field | Value |
|---|---|
| Lambda | `checksops-production-prep-api` |
| CodeSha256 | `nJup1+WVcsX99QzhmLvEpG+CRurINFAXLn+3osQBeQc=` |
| RevisionId | `cea215e3-649b-477a-bcfc-e907bf670b87` |
| LastModified | `2026-09-29T14:52:05.000+0000` |
| Last known before this freeze | `aU5OCyV4qm6057bFWDF2T9KEkZPVvmav4qoiFczpaCM=` |
| Rollback performed? | **NO** |

SPA names at freeze: `index-DJNHggvS.js` / `index-D9SwIqYu.css`.

## Financial env flags at freeze

| Flag | Value |
|---|---|
| `AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST` | `false` |
| `AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED` | `false` |
| `AWS_MOOV_MONTHLY_BILLING_ENABLED` | `true` |
| `AWS_MOOV_TRANSFER_POST_ENABLED` | `true` |
| `AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED` | `false` |
| `AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID` | `41cb5d67-4911-4bef-aad5-d8ee9c582208` |
| `AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID` | `c70a90f2-9bcc-4084-8263-d5a0fb5d806c` |
| `CHECKSOPS_ENV` | `production-prep` |

Funding-path success is **not** permission to activate monthly automated billing.

## Known-good transfer (GET 2026-09-29T15:14:59Z)

| Field | Value |
|---|---|
| Provider transfer ID | `367c5353-ed20-430b-b767-c3e5d47f28ad` |
| Local payment ID | `414d81a2-186b-4e42-8ea1-47077d77a85c` |
| Amount | `100` cents `USD` |
| Provider status | `pending` |
| ACH status | `originated` |
| Created | `2026-09-25T20:46:55Z` |
| Completed | `null` |
| Local status | `submitted` (`settled_at` null) |
| Idempotency key | `billing_verification:2eff5f1a-929d-4ce3-9a8b-cd96b98df42a:f0ff0dbf-f5e5-4924-a060-811e7e568c8c` |

Source: Freedom tenant `2eff5f1a-929d-4ce3-9a8b-cd96b98df42a`, Moov
`60922058-7eca-4889-81dd-5720d7b9de96`, Wells Fargo last4 `4573`,
`ach-debit-fund` `a02c1c81-9ca6-434d-accc-ea4471a70ef2`.

Destination: ChecksOps merchant `41cb5d67-4911-4bef-aad5-d8ee9c582208`,
wallet `72630a70-4954-4761-b652-e8beff1ad02c`, wallet method
`c70a90f2-9bcc-4084-8263-d5a0fb5d806c`.

## Duplicate check

- Exactly one local `billing_verification` row.
- Exactly one local row with provider transfer `367c5353-…`.
- `payment_transfers` and `wallet_funding_requests` have zero Freedom rows.
- One unrelated sandbox `$0.01` legacy maintenance row (`72198307-…`) is not this path.
- `payment_event_log` has no row for `367c5353-…`.

No cleanup was attempted.

## What this lock owns

Contract, helper, adversarial tests, and this proof. Shared runtime files such
as `moov-money.mjs` are watched by the deploy guard, not whole-file locked.

This lock does **not** pin the whole production Lambda SHA. Current live
production remains authoritative for future overlays.
