# Tranche 4 results

Branch `cursor/aws-provider-tranche-4-c48b`. **PR #97** targets `main`. Do not merge until a human reviews.

Production ChecksOps, production DNS, production frontend, production Supabase provider functions, and production Moov/CheckAlt/Plaid webhook URLs were **not** touched.

Live staging API: `https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging`  
Lambda `checksops-staging-api` updated in place (`UpdateFunctionCode` + env). Existing Tranche 3 storage/write routes on the live package were preserved (overlay, not a thin SAM deploy).

Temporary admin oneshot `checksops-staging-tranche4-providers-c48b` applied `40_tranche4_webhook_receipts.sql` and captured financial aggregates, then the function and IAM role were **deleted**.

## Implementation

| Layer | Location |
| --- | --- |
| Flags | `aws/functions/api/provider-flags.mjs` |
| Secrets | `aws/functions/api/provider-secrets.mjs` (`PROVIDER_SECRETS_ARN`, booleans only) |
| Execution auth (documented, not activated) | `aws/functions/api/provider-authz.mjs` |
| Catalog | `aws/functions/api/providers/catalog.mjs` |
| Adapters | `providers/moov.mjs`, `checkalt.mjs`, `plaid.mjs`, `actum.mjs`, `quickbooks.mjs` |
| Webhooks | `providers/webhooks.mjs` + `POST /webhooks/{moov,checkalt,plaid}` |
| Router | `aws/functions/api/providers.mjs` |
| Frontend | `src/integrations/aws/client.ts` `functions.invoke` → `/functions/v1/:name` |

## Flags on live Lambda (all execution false)

`AWS_PROVIDER_EXECUTION_ENABLED=false`  
`AWS_MOOV_ENABLED=false`  
`AWS_CHECKALT_ENABLED=false`  
`AWS_PLAID_ENABLED=false`  
`AWS_ACTUM_ENABLED=false`  
`AWS_QUICKBOOKS_ENABLED=false`  
`AWS_PROVIDER_LIVE_READS_ENABLED=false`  
`AWS_PROVIDER_WEBHOOK_DRY_RUN=true`

T1–T3 write flags unchanged: `AWS_WRITES_ENABLED=true`, `AWS_CHECK_WORKFLOW_WRITES_ENABLED=true`, `AWS_STORAGE_WRITES_ENABLED=true`.

Tranche 4 also hard-blocks execution **even if a provider flag is flipped**. Money movement is not implemented on AWS.

## Unit tests

`node --test aws/tests/api-providers.test.mjs`: **17/17 PASS**  
Existing write/health/authorization: **31/31 PASS**

## Live validation

`scripts/aws-provider-tranche4-validate.mjs`: **20/20 PASS**

| Case | Result |
| --- | --- |
| `GET /providers/status` | 200; all execution flags false; webhook secret not in body |
| Unauthenticated `/providers/moov/status` | **401** `missing_cognito_token` |
| Freedom Moov local status | **200**; account `60922058-7eca-4889-81dd-5720d7b9de96`; readiness `pending` from local snapshot; `liveProviderCalled=false` |
| C1C Moov local status | **200**; account `817e1bf0-e1f7-4e9e-95a8-ce15bfa31708`; `liveProviderCalled=false` |
| Freedom `tenant_id=C1C` | **403** `cross_tenant_denied` |
| C1C `tenant_id=Freedom` | **403** `cross_tenant_denied` |
| Freedom spoofed `provider_account_id` | **403** `spoofed_provider_id` |
| Freedom CheckAlt local status | **200**; 20 visible deposits; no FinCapture call |
| C1C CheckAlt local status | **200**; **0** deposits (tenant isolation) |
| Freedom Plaid / Actum / QB status | **200**; interface/local only; no live calls |
| `POST /functions/v1/moov-readiness` | **200**; local snapshot |
| `moov-transfer-create` / `checkalt-submit-deposit` / `plaid-disburse` / `quickbooks-payment` / unknown `actum-charge` | **403** `provider_disabled` |
| Malformed webhook | **400** `malformed_webhook` |
| Invalid signature | **401** `invalid_signature` |
| Valid synthetic Moov webhook | **200** accepted once; `dry_run=true`; `applied=false`; mapped tenant = Freedom from provider account id |
| Duplicate webhook | **200** `duplicate=true`; receipts table still **1** row |
| Payload `tenant_id` / `account_number` | ignored / redacted |
| T3 `POST /storage/upload-url` | still routed (empty body → `bucket_not_allowed`, not 404) |

Ninth UUID: not an onboarded Cognito user. Unauthenticated is 401. Spoofed ninth/`x-user-id` headers are ignored (`spoofFieldsIgnored`). Fail-closed identity mapping is unchanged.

## Moov

Ported: account mapping, KYC/KYB/TOS/capability/bank/wallet status **reads** from `payment_provider_accounts` + `payment_wallets` + `payment_transfers`, readiness math (no network), webhook HMAC-SHA512 + legacy body signature, idempotent receipts.

Not executed: account create/onboard, TOS accept, recipient/KYC mutations, bank add, micro-deposits, transfers, disbursements, fee charges, syncs that write provider rows.

Live readiness is **local snapshot** (`pending` for Freedom). A live Moov GET would be required for current provider state and remains disabled.

## CheckAlt

Ported: token/config boundary, deposit/account **DB** status, integer-cents `userAmount` (`123.45` → `12345`), status code map, webhook HMAC fixture.

Not executed: submit, approve, poll-that-updates, register/verify, test-connection, prepare-image, live FinCapture.

## Plaid

Ported: interface + webhook verification architecture (staging HMAC fixture). Status reads local `disbursement_splits.plaid_transfer_id` under RLS.

Not executed: Link tokens, item exchange, transfers. No isolated Plaid sandbox is wired.

## Actum / QuickBooks

Interface + secrets-configured booleans only. No `actum-*` Edge Function exists on `main`. No live charges or QuickBooks payments.

## Webhooks

Staging routes exist. Production URLs were **not** redirected.

Dry-run writes only `aws_provider_webhook_receipts`. Lookup uses SECURITY DEFINER `aws_lookup_provider_account` / `aws_lookup_checkalt_deposit`. Payload tenant ids are discarded.

## Financial reconciliation

Owner-level `28_financial_aggregates.sql` **before GRANT/receipts = after validation**. Identical to the Tranche 2 baseline.

| Metric | Before = after |
| --- | --- |
| check_intake_amount | 1317000.53 |
| check_intake_pa_fee_amount | 5393.27 |
| deposit_items_amount | 963972.98 |
| deposit_batches_total_amount | 964752.98 |
| checkalt_deposits_amount | 380333.17 |
| disbursement_splits_amount | 822212.97 |
| disbursement_batches_check_amount | 829768.914 |
| disbursement_batches_amount_reserved_cents | 0 |
| claim_check_payments_* | 0 |
| claim_payments_amount | 66003.92 |
| endorsed_check_intake_amount | 3924356.85 |
| payment_transfers_amount_cents | 0 |
| payment_wallet_ledger_amount_cents | 0 |
| homeowner_ledger_amount | 2977337.23 |

Only non-financial change: one dry-run row in `aws_provider_webhook_receipts`.

## Still hard-disabled

Deposit submission, CheckAlt approve/poll-mutate, Moov/Plaid/Actum/QuickBooks money movement, ACH/RTP/wire, disbursement execution, wallet funding, stakeholder KYC mutations, bank linking, provider configuration, provider-event email.

## Production cutover

See `PRODUCTION_CUTOVER_CHECKLIST.md`. Nothing on that list was switched.

## Safety

- Real provider transaction: **no**
- Production touched: **no**
- Production webhooks redirected: **no**
- Secrets in browser/status payload: **no**
