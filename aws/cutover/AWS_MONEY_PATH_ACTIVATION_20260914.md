# AWS money-path activation — 2026-09-14

Continuation from **NO GO — PROVIDER/WEBHOOK BLOCKER** and the completed
production reconciliation.

Baseline preserved:
`aws/db-copy/reconciliation-20260914/apply/POST_RECONCILIATION_AWS_FINGERPRINT.json`.

**No full DB copy. No Cognito mapping overwrite. No SPA deploy. No change to
the existing Lovable/Supabase Moov webhook. No real Moov transfer or CheckAlt
deposit solely for testing. Stripe, Telnyx, and Resend are excluded.**

## Verdict

**NO GO — AWS MOOV WEBHOOK FAILED**

A Moov Dashboard test POST reached
`https://checksops.com/prep/webhooks/moov` at `2026-09-14T12:55:28.910Z`
and was rejected (`401 invalid_signature`). Nothing was recorded. Keep the
existing Lovable/Supabase webhook. See
`aws/cutover/money-path-20260914/AWS_MOOV_WEBHOOK_DASHBOARD_TEST_20260914.md`.

## What this phase changed

### 1. AWS Moov webhook receiver

| Item | Value |
|---|---|
| Endpoint | `https://checksops.com/prep/webhooks/moov` |
| Dedicated secret | `checksops/production/moov-webhook` via `MOOV_WEBHOOK_SECRET_ARN` |
| Load order | dedicated ARN → `PROVIDER_SECRETS_ARN` `MOOV_WEBHOOK_SECRET` → `AWS_MOOV_WEBHOOK_SECRET` |
| Empty secret | fail-closed (`401`, `moovWebhookSecretConfigured=false`) |
| Production apply | on when dry-run is `false` and Moov + execution + financial are on and sandbox is off |
| Idempotency | `aws_provider_webhook_receipts` **and** `payment_webhook_events` `UNIQUE (provider, external_event_id)` |
| Tenant | `aws_lookup_provider_account`; payload `tenant_id` ignored |
| Invalid signature | `401` |
| Funding completed | queues internal `process-funded-payment` after commit (duplicate-safe lock) |
| Existing Lovable webhook | **untouched** |

Do **not** paste the new secret into Cursor/chat or logs. Place it only in
Secrets Manager.

### 2. CheckAlt on AWS

`AWS_CHECKALT_ENABLED=true` is the live production-prep flag lift. The
implementation and 27/27 unit tests were already present. Production dispatch
is `checkalt-submit-deposit` + `checkalt-poll-status`. SQL 65 **file** stays
`DO NOT APPLY`; live `checkalt_deposits` columns are already present.

The reconciled $9,984.11 check was **not** submitted.

### 3. Production Moov money dispatch

AWS now dispatches these functions on production rows when money-path gates
are lifted (before the old `production_execution_blocked` hard stop):

- `moov-wallet-fund`
- `initiate-wallet-funding`
- `cancel-wallet-funding`
- `calculate-payment-funding`
- `moov-wallet-sync`
- `moov-transfer-create`
- `moov-transfer-group-create`
- `moov-transfer-status`
- `moov-disburse`
- `process-funded-payment`

Handlers use `ctx.environment` (`production` on this path, `sandbox` on the
existing parity path). No real transfer was created.

### 4. Remaining check/payment Edge Function equivalents

| Path | AWS equivalent | Status |
|---|---|---|
| Check intake/upload | `POST /workflow/checks` + storage-write | Operational |
| Check images/OCR | Class A `check-ocr-intake` + S3/Textract | Operational (descriptive persist; amounts not overwritten) |
| Endorsement | Class A `check-endorsement` + `/public/endorsement` | Operational |
| Deposit approval | `POST /workflow/transition` `mark_ready_for_deposit` | Operational |
| CheckAlt | production dispatch | Executable when flag is on |
| Moov wallet/payment/disburse | production dispatch | Executable when flags are on |
| Moov webhook | `POST /webhooks/moov` | Ready for **new** webhook + secret |

Excluded: Stripe, Telnyx, Resend, billing, general email, partnerships, UI
polish, Plaid, unrelated audit holds.

### 5. Readiness classification

`GET /prep/ops/money-path-readiness` reports only money-path items.
`/prep/ops/readiness` `holds.ok=false` because live execution flags are true.
Those holds are **classified separately** and do not fail this phase.

## Operator webhook (created; waiting for a signed event)

The new production webhook and Secrets Manager value are in place. Keep the
existing Lovable/Supabase destination until a Moov-signed event is proven on
AWS:

`https://nbcqwpysqgyxrrbgtmkw.supabase.co/functions/v1/moov-webhook`

Create a **new** Moov **production** webhook (do not edit the old one):

1. In the Moov dashboard, add a new production webhook.
2. URL: `https://checksops.com/prep/webhooks/moov`
3. Subscribe to the same production event types already used live
   (`account.*`, `capability.*`, `bankAccount.*`, `paymentMethod.*`,
   `transfer.*`, `wallet.*`, `balance.*`, disputes).
4. Copy the **new** signing secret in the Moov UI only.
5. In AWS Secrets Manager (account `806168576068`, `us-east-1`), open
   `checksops/production/moov-webhook`.
6. Set JSON `{"MOOV_WEBHOOK_SECRET":"<new secret>"}`. Do not put the
   Lovable/Supabase secret here. Do not paste it into chat or logs.
7. Confirm Lambda `checksops-production-prep-api` has
   `MOOV_WEBHOOK_SECRET_ARN` pointing at that secret.
8. Do not change the old webhook until a signed test event is accepted on
   AWS (`applied: true`, `dry_run: false`, `productionRecordsMutated: true`)
   and the old destination is still receiving events (dual-subscribe).

After that secret is stored, no further code change is required for AWS to
verify genuine signatures, reject invalid ones, apply production events,
resolve tenant, and enforce idempotency.

## SPA question

If the AWS/Cognito SPA were deployed now, would processing a check or
sending a payment still require Supabase?

**YES** — only because inbound Moov events still terminate on the existing
Lovable/Supabase webhook until the operator creates the new AWS webhook and
stores the new secret. Outbound check intake, images/OCR, endorsement,
deposit approval, CheckAlt submit/poll, and Moov wallet/payment/disburse are
implemented on AWS. Nothing was deployed to answer this question.

## Live production-prep activation (this run)

Lambda `checksops-production-prep-api` code + env updated. Staging templates
were not changed.

| Item | Live |
|---|---|
| CodeSha256 | `7Jzn63Xc1TUfQhTtn7Vn+b2oSbvhd53vstqUiVkct7s=` |
| `AWS_CHECKALT_ENABLED` | true |
| `AWS_PROVIDER_WEBHOOK_DRY_RUN` | false |
| `MOOV_WEBHOOK_SECRET_ARN` | set (`checksops/production/moov-webhook`) |
| Secret value | nonempty `MOOV_WEBHOOK_SECRET` (never printed); resource policy grants Lambda `GetSecretValue` |
| `GET /prep/ops/money-path-readiness` | 200, `moovWebhookSecretConfigured=true` |
| Unsigned `POST /prep/webhooks/moov` | 401 `missing_signature_headers` |
| Forged signature | 401 `invalid_signature` |
| Genuine Moov-signed event on AWS | Dashboard test `401 invalid_signature` at 12:55:28Z; not persisted |
| Lovable webhook unsigned | still 401 `Invalid signature` (untouched) |
| Identity | 11 rows; 8 repaired production Cognito subs unchanged |
| Financial aggregates | match fingerprint exactly |
| $9,984.11 check | still `approved_for_deposit`, 0 CheckAlt deposit rows |
| C1C UAT intake | 37 (intact) |
| SQL 66 | applied: webhook + money-path grants to `checksops` |
| Fingerprint file | unchanged `ccb9a1144d46f607f542aa61e765098177eb8a15d318e0a081d6b762ccd021b3` |
| SPA | not deployed |

Unrelated `/prep/ops/readiness` holds remain (`flags=true`). They do not fail
this phase.
