# CheckAlt first-deposit runbook (after E13)

**Do not execute this runbook in E13.** E13 stops at dry-run proof. This is the exact later sequence for one controlled production CheckAlt deposit.

Money flags stay false until the named step. No Moov. No ACH/RTP/wire. No DNS. No #428. No staging credential copy.

## Current E13 holds (must still be true before starting)

| Flag | Required value |
| --- | --- |
| `AWS_PROVIDER_EXECUTION_ENABLED` | `false` |
| `AWS_CHECKALT_ENABLED` | `false` |
| `AWS_FINANCIAL_PERMISSIONS_ACTIVATED` | `false` |
| `AWS_PROVIDER_WEBHOOK_DRY_RUN` | `true` |
| `AWS_MOOV_ENABLED` | `false` |
| `AWS_MOOV_TRANSFER_POST_ENABLED` | `false` |
| `AWS_CHECKALT_STATUS_RECONCILE_ENABLED` | `false` |
| `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED` | `false` |

Production webhook URL (already implemented, do not change DNS):

`https://checksops.com/prep/webhooks/checkalt`

HMAC (AWS production verifier):

- Headers: `x-webhook-id`, `x-timestamp`, `x-signature`
- `x-signature` = lowercase hex of `HMAC-SHA256(CHECKALT_WEBHOOK_SECRET, "${webhookId}.${timestamp}.${rawBody}")`
- Event id: `eventID` / `event_id` / `id` / `x-webhook-id`
- Deposit correlation: `referenceNumber` or `checkalt_reference` → `aws_lookup_checkalt_deposit`. Payload `tenant_id` is ignored.

Secret location (never print the value):

- Secrets Manager object loaded by production Lambda `PROVIDER_SECRETS_ARN`
- JSON name: `CHECKALT_WEBHOOK_SECRET`
- Must not equal staging/UAT `CHECKALT_SANDBOX_WEBHOOK_SECRET`

## STOP if any of these are true

- Isolated production RDS is not `checksops-production`
- SQL 65 writer is still `NOT_APPLIED` when you intend to submit
- Freedom/C1C `checkalt_tenant_accounts` mapping is missing SSO or deposit account
- `CHECKALT_WEBHOOK_SECRET_configured` is false
- Dry-run proof failed (unsigned accepted, signed rejected, or a signed dry-run mutated `checkalt_deposits`)
- Any Moov / ACH / RTP / wire flag is true
- Sandbox execution is true on production

## Flag and SQL order (exact)

Do these in this order. Do not skip ahead.

1. Confirm E13 dry-run proof and production apply overlay are live. Leave dry-run **true**.
2. Enter the CheckAlt production dashboard webhook destination:
   - URL: `https://checksops.com/prep/webhooks/checkalt`
   - Method: `POST`
   - Secret: production `CHECKALT_WEBHOOK_SECRET` (copy from Secrets Manager; do not paste into git/chat)
   - Signature scheme: HMAC-SHA256 hex over `${webhookId}.${timestamp}.${rawBody}` with the headers above
   - If the dashboard cannot emit that scheme, STOP and adapt the verifier before any deposit.
3. SQL 65 writer objects are **already present** on isolated production RDS (columns, GUC function, financial insert/update policies, `checksops` SELECT/INSERT/UPDATE). Do **not** re-apply `65_checkalt_production_writer.sql` unless a reviewed drift check shows they are missing.
4. Confirm those objects still exist and `FORCE ROW LEVEL SECURITY` on `checkalt_deposits` is still off (E13: off). If FORCE RLS is later enabled, add a webhook-apply policy before disabling dry-run.
5. Confirm webhook apply can still UPDATE when dry-run is later false:
   - `request.provider_webhook='1'`
   - `request.provider_webhook_apply='1'`
   - financial execution GUCs remain `0`
   - If SQL 65's financial-execution UPDATE policy would block webhook apply, add the reviewed webhook-apply policy **before** disabling dry-run. Do not use a broad provider-execution bypass.
6. `AWS_PROVIDER_WEBHOOK_DRY_RUN` stays `true` through the first submit unless a live CheckAlt callback must apply status. Preferred: first submit under dry-run, then disable dry-run after the first signed receipt maps to the new reference.
7. `AWS_FINANCIAL_PERMISSIONS_ACTIVATED=true` on `checksops-production-prep-api` only.
8. `AWS_CHECKALT_ENABLED=true` on that Lambda only.
9. `AWS_PROVIDER_EXECUTION_ENABLED=true` **last**.
10. Leave `AWS_MOOV_ENABLED=false`, `AWS_MOOV_TRANSFER_POST_ENABLED=false`, `AWS_CHECKALT_STATUS_RECONCILE_ENABLED=false`.

## Tenant / check prerequisites

- Tenant is Freedom (`2eff5f1a-929d-4ce3-9a8b-cd96b98df42a`) unless a later written exception names another production tenant. E13: Freedom is the only registered production CheckAlt tenant. C1C is not mapped.
- `checkalt_tenant_accounts` for that tenant: `enabled`, `sso_user_id`, `deposit_account_number` present. Do not copy UAT rows.
- One production check in `approved_for_deposit` (or the documented ready-for-deposit stage) with both front and back deposit images in production S3.
- No existing `checkalt_deposits` row for that check with `checkalt_reference`, `provider_http_attempted_at`, or a submitted/pending/cleared/error status. If one exists, reconcile — do not POST again.
- Operator is a mapped production Cognito user with tenant membership. Browser amounts and `tenant_id` are not authority.

## Expected CheckAlt request

`POST {CHECKALT_BASE_URL}/public/fincapture/deposit/process`

- Auth: production `CHECKALT_USERNAME` / `CHECKALT_PASSWORD` / `CHECKALT_FI_KEY` from `PROVIDER_SECRETS_ARN`
- Host: approved production FinCapture host (`api.checkalt.com` / `api2.checkalt.com`). Never `uatapi.checkalt.com`.
- `ssoKey` from `checkalt_tenant_accounts.sso_user_id` for the check's tenant
- `userAmount` = integer cents from `check_intake_items.amount` (`123.45` → `12345`)
- Front/back JPEGs already prepared; no `testDeposit`

## First money-execution point

**The first successful production `POST /public/fincapture/deposit/process` issued by `checkalt-submit-deposit` after step 9.**

Flag lifts make that call possible. They do not themselves move money. Approve, poll, webhook apply, and reconcile are not the first money-execution point.

## Expected provider identifier

- RDS `checkalt_deposits.checkalt_reference` = FinCapture `referenceNumber`
- Persist that reference **before** treating the deposit as submitted
- Idempotency key `sha256(tenant_id|checkalt_deposit|check_id|amount_cents|USD)` inserted before HTTP

## Expected AWS DB transitions

| Phase | `checkalt_deposits.status` | Other |
| --- | --- | --- |
| Before HTTP | `queued` | `idempotency_key` set; `provider_http_attempted_at` null |
| HTTP claimed | `submitting` | `provider_http_attempted_at` set |
| Process accepted | `submitted` or `pending_approval` | `checkalt_reference` set; `submitted_at` set |
| Provider 40 | `pending_approval` | |
| Provider 127 | `submitted` | not cleared |
| Provider 200 + `depositDate` | `cleared` | `cleared_at` = FinCapture `depositDate` |
| Return | `returned` | `returned_at` set |
| Reject 120 | `rejected` | |

Webhook apply (only after dry-run is `false`) updates status / `last_status_payload` / `cleared_at` / `returned_at` on that same row. It does not INSERT a deposit or call CheckAlt HTTP.

## Expected webhook / callback

1. CheckAlt POST to `https://checksops.com/prep/webhooks/checkalt`
2. Signature verified; unsigned / malformed → 401 / 400; no receipt
3. Receipt inserted into `aws_provider_webhook_receipts` (`provider='checkalt'`, unique `external_event_id`)
4. Lookup by `referenceNumber` → Freedom (or named) tenant + deposit id
5. While dry-run is true: `applied=false`, `apply_skipped=webhook_dry_run`, `productionRecordsMutated=false`
6. After dry-run is false: one status apply; replay of the same event id → `duplicate`, no second UPDATE

## Expected UI status

Command center / deposit console for that check shows the mapped `checkalt_deposits.status` (submitted / pending approval / cleared / returned). Bank Deposits uses `cleared_at` = provider `depositDate`, not poll time.

## Reconciliation proof

Keep `AWS_CHECKALT_STATUS_RECONCILE_ENABLED=false` until after the first deposit has a `checkalt_reference` and at least one signed webhook receipt (or an explicit poll). Enabling it earlier issues live CheckAlt HTTP and can UPDATE historical `checkalt_deposits` rows.

After the first deposit, one authorized poll/reconcile should match the same reference and must not POST `deposit/process` again.

## Duplicate / idempotency proof

- Replay the same webhook `external_event_id` → receipt conflict, `applied=false`
- Retry submit for the same check + cents → existing row reused; no second FinCapture POST
- A second browser submit with a spoofed amount is rejected

## Rollback / STOP

Trip any one:

- Unexpected production CheckAlt object that is not the named check
- Amount mismatch (cents vs check amount)
- Duplicate FinCapture POST
- Webhook signature failures after dashboard config
- Tenant mismatch / unmapped reference
- Historical deposit amounts or counts drift
- Any Moov / ACH / RTP / wire attempt
- Sandbox/UAT host or secret used

Rollback:

1. `AWS_PROVIDER_EXECUTION_ENABLED=false` immediately
2. `AWS_CHECKALT_ENABLED=false`
3. `AWS_FINANCIAL_PERMISSIONS_ACTIVATED=false`
4. `AWS_PROVIDER_WEBHOOK_DRY_RUN=true`
5. Leave SQL 65 in place unless a reviewed revert is written
6. Do not delete historical `checkalt_deposits` rows
7. Remove or disable the CheckAlt dashboard AWS destination only if it is emitting unexpected events
