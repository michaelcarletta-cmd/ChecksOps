# Provider / webhook cutover — 2026-09-14

Continuation from **RECONCILIATION PASS — READY FOR PROVIDER/WEBHOOK CUTOVER**.
Baseline preserved:
`aws/db-copy/reconciliation-20260914/apply/POST_RECONCILIATION_AWS_FINGERPRINT.json`.

**No full DB copy. No Cognito mapping overwrite. No SPA deploy. No Moov or
CheckAlt destination change. No real deposit, transfer, cancel, or replay.**

## Verdict

**NO GO — PROVIDER/WEBHOOK BLOCKER**

STOP. Production Moov webhooks remain on Supabase. CheckAlt remains poll-based
and AWS-dark. The SPA was not deployed.

## Why destination change was refused

AWS can *reach* a CloudFront webhook URL, but it cannot **safely own** the
production money/event path:

1. **No production webhook signing secrets on AWS.**
   `moovWebhookSecretConfigured=false`,
   `checkaltWebhookSecretConfigured=false`. Lambda env has no
   `AWS_*_WEBHOOK_SECRET` fallback. A real Moov callback to
   `https://checksops.com/prep/webhooks/moov` would be rejected (`401`).
2. **No production apply path.** `AWS_PROVIDER_WEBHOOK_DRY_RUN=true`. Sandbox
   apply is off. `applyMoovWebhook()` explicitly skips
   `environment='production'` rows (`production_environment_row`). Receipts
   only; `productionRecordsMutated: false`.
3. **Moving the Moov destination off Supabase would drop live apply.**
   Supabase `moov-webhook` is still the only path that writes
   `payment_webhook_events` and related financial/onboarding state.
4. **Cannot verify or change Moov destinations from this environment.**
   `GET https://api.moov.io/oauth2/token` returned Cloudflare `1010`. No
   dashboard write was attempted.
5. **CheckAlt is not a webhook cutover.** Production status is poll/reconcile.
   Live Supabase `checkalt-*` functions return
   `403 legacy_checkalt_provider_path_disabled`. AWS
   `AWS_CHECKALT_ENABLED=false`. The reconciled $9,984.11 check has **no**
   `checkalt_deposits` row, so it cannot be used for read-only status poll.

Dual delivery cannot be proven: AWS would 401 (missing secret) or, if a secret
were installed, only store dry-run receipts. That is not “AWS receives and
correctly processes production events.”

---

## Phase 1 — Provider / webhook inventory

In-scope money/check server-to-server paths only.

### 1. Moov webhook (primary live financial callback)

| Field | Production today | AWS equivalent |
|---|---|---|
| URL | `https://nbcqwpysqgyxrrbgtmkw.supabase.co/functions/v1/moov-webhook` | `https://checksops.com/prep/webhooks/moov` (CloudFront → `checksops-production-prep-api`) |
| Terminates at Supabase? | **Yes.** Live unsigned POST returns `401 Invalid signature`. 19 FA events since 2026-09-12 are in `payment_webhook_events`. Latest `2026-09-13T18:25:18.120Z`. AWS receipts: 7 **dry-run** Moov rows, latest **2026-09-03** (old staging tests). | Handler exists. Unsigned CloudFront POST: `401 invalid_signature`. Raw execute-api: **403** (`ORIGIN_VERIFY_REQUIRE=true`). |
| Lambda / route | Edge Function `moov-webhook` | `POST /webhooks/moov` → `aws/functions/api/providers/webhooks.mjs` |
| Auth | HMAC-SHA512 `timestamp\|nonce\|webhookID` + legacy body HMAC. Headers `x-webhook-id` / `x-timestamp` / `x-nonce` / `x-signature`. 5-minute skew. | Same algorithms in `hmac.mjs`. Secret from `PROVIDER_SECRETS_ARN` `MOOV_WEBHOOK_SECRET` or `AWS_MOOV_WEBHOOK_SECRET`. **Neither is configured.** |
| Secret source | Supabase `MOOV_WEBHOOK_SECRET` | `checksops/production/provider` (Moov API keys only; **no webhook secret**) |
| Event types (recent live) | `account.updated`, `capability.updated`/`requested`, `paymentMethod.enabled`, `bankAccount.updated`, `walletTransaction.updated`, `balance.updated`, `wallet.created` | Same parser; not applied on production rows |
| Idempotency | `UNIQUE (provider, external_event_id)` on `payment_webhook_events`; duplicate → 200 `{duplicate:true}` | `UNIQUE (provider, external_event_id)` on `aws_provider_webhook_receipts`; `ON CONFLICT DO NOTHING` |
| Retry | 401 bad sig; 500 processing → Moov retries | 401 reject; 500 persist fail |
| DB writes | `payment_webhook_events`, provider/method/recipient/stakeholder, transfers, funding, disbursement, `payment_event_log`, wallet ledger | Receipts only unless sandbox apply (off). Production rows skipped. |
| Tenant resolution | `payment_provider_accounts.provider_account_id` + environment | `aws_lookup_provider_account('moov', accountID)`; payload `tenant_id` ignored |
| Failure / DLQ | `processing_error` column; no queue | Receipt insert in a transaction; rollback on persist fail; no DLQ |
| Downstream | May POST `process-funded-payment` (internal) | None |

### 2. CheckAlt (poll / reconcile — not a live webhook)

| Field | Production today | AWS equivalent |
|---|---|---|
| Inbound webhook URL | **None.** UI: “CheckAlt does not require a webhook.” `checkalt_webhook_events` has 2 historical rows only. | `POST /webhooks/checkalt` exists for HMAC receipt / sandbox apply |
| Status path | Was `checkalt-poll-status` + UI Reconcile. Cron unscheduled. **Live functions return 403 shutdown.** | `POST /functions/v1/checkalt-poll-status` + production `checkalt-poll.mjs` |
| Submit | Live `checkalt-submit-deposit` → **403 shutdown** | Production `checkalt-submit.mjs` behind `AWS_CHECKALT_ENABLED` |
| Auth | Legacy JWT `POST /public/fincapture/authenticate` (shut down on SB) | Same; production names in `checksops/production/provider` (`CHECKALT_USERNAME`/`PASSWORD`/`FI_KEY`/`BASE_URL`). Base URL is HTTPS CheckAlt production, not UAT. |
| Idempotency | Designed persist-before-HTTP | `checkalt-idempotency.mjs`; SQL 65 columns **are present** on `checkalt_deposits` |
| Tenant | `checkalt_tenant_accounts` | FA account `f65727f0…` enabled, has `sso_user_id` + deposit account |
| Callback apply | N/A (poll) | `applyCheckAltWebhook()` updates **sandbox ops only**, not `checkalt_deposits` |

### 3. Other discovered paths (not cut over)

| Path | Production | AWS | In this cutover? |
|---|---|---|---|
| Plaid transfer webhook | Dormant Edge Function; plan **N/A** | `/webhooks/plaid` dry-run; no apply | **Out** — unused |
| Stripe `tenant-billing-webhook` | Live on Supabase | **None** (fail-closed) | **Out** — billing |
| Telnyx SMS / Resend / signature | Live on Supabase | Dry-run stubs or absent | **Out** — not money/check |
| Partner `sync-check-status` | Bridge secret | Partial | **Out** — partner, not provider |
| Actum / QuickBooks inbound | No handler | Status-only / fail-closed | **Out** |

### Live AWS flag snapshot (production-prep Lambda)

Documented templates still say all execution flags `false`. **Live Lambda is different:**

| Flag | Live |
|---|---|
| `AWS_MOOV_ENABLED` | **true** |
| `AWS_PROVIDER_EXECUTION_ENABLED` | **true** |
| `AWS_FINANCIAL_PERMISSIONS_ACTIVATED` | **true** |
| `AWS_PROVIDER_LIVE_READS_ENABLED` | **true** |
| `AWS_CHECKALT_ENABLED` | **false** |
| `AWS_PROVIDER_WEBHOOK_DRY_RUN` | **true** |
| `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED` | **false** |
| `ORIGIN_VERIFY_REQUIRE` (authorizer) | **true** |

`/prep/ops/readiness` `holds.ok=false` because those four flags are true.
`/prep/financial/status` still reports `productionExecution=false` and money
permissions `activated: false` (SQL activation / operation gates, not the
env flags alone). `/prep/providers/status` `liveProviderTransactions=false`.

These flags were **not** changed by this task.

---

## Phase 2 — CheckAlt AWS readiness

**Not merely an unapplied flag.** Submit + poll + image + auth + idempotency
**code exists and unit-tests pass** (`aws/tests/api-checkalt-production.test.mjs`
27/27). Execution is still dark.

| Gate | Live evidence |
|---|---|
| `AWS_CHECKALT_ENABLED` | `false` |
| Production CheckAlt HTTP secrets | Present (non-UAT host) |
| SQL 65 writer columns | **Present** (`idempotency_key`, `amount_cents`, `provider_http_attempted_at`, `failure_class`) |
| `checksops/production/providers` | Marked for deletion; live ARN is `checksops/production/provider` |
| Production approve-deposit | **Not** in production dispatch (parity/sandbox only) |
| Webhook → `checkalt_deposits` | **Not implemented** |
| Legacy SB path | **Dead** (403 deployed) |

### $9,984.11 check (`623442f0-a408-4db5-85be-14bae231a722`)

Read-only on AWS and Supabase:

- Tenant Freedom Adjustment. Status `approved_for_deposit`, stage
  `ready_for_deposit`, amount `9984.11`.
- CheckAlt rear/deposit image path present
  (`…/endorsed_deposit_18vd.checkalt.jpg`).
- **Zero** `checkalt_deposits` rows for this check id or amount on **both**
  sides (69/69 table parity, $453,990.48 aggregate unchanged).
- Therefore it **cannot** be used for a read-only CheckAlt status poll.
  No provider reference exists. No new check was submitted.

FA `checkalt_tenant_accounts` is enabled with SSO + deposit account — config
is present; a deposit was never persisted for this check.

---

## Phase 3 — AWS webhook preflight

Proved **without** changing destinations or writing financial rows.

| Check | Result |
|---|---|
| CloudFront `POST /prep/webhooks/moov` unsigned | **401** handler ran (origin header injected) |
| CloudFront `POST /prep/webhooks/checkalt` unsigned | **401** handler ran |
| Raw execute-api `/prep/webhooks/moov` | **403 Forbidden** — cannot be the production URL |
| Supabase `moov-webhook` unsigned | **401 Invalid signature** — still live |
| Tenant ignore / sanitizer | Unit: payload `tenant_id` dropped |
| Duplicate event id | Unit: accepted once, second `duplicate` / no second apply (`api-providers` test 51) |
| Bad signature / malformed | Unit + live 401 |
| Production apply skipped | Code + dry-run + sandbox apply disabled |
| Historical payload replay to live AWS | **Not done.** No webhook secret; would 401. Replaying real event IDs without apply proof is not useful. |

Tests: `api-providers.test.mjs` 54/54, `api-provider-gates.test.mjs` 10/10,
`api-checkalt-production.test.mjs` 27/27.

**Not proven:** AWS can verify a **real production Moov signature** or apply
a production event to Freedom Adjustment rows.

---

## Phase 4 — Controlled cutover

**Not started.** One-path-at-a-time destination change requires AWS readiness
PASS. It did not.

Supabase endpoints were left in place. No Moov subscriber was added, updated,
or removed. No CheckAlt vendor URL was changed (none is required).

---

## Phase 5 — Post-attempt reconciliation (no destination change)

Compared to
`POST_RECONCILIATION_AWS_FINGERPRINT.json` immediately after inventory:

| Check | Result |
|---|---|
| Financial aggregates | **Unchanged** (intake `1428955.65`, deposits `1037630.29`, CheckAlt `453990.48`, splits `880702.79`, claim payments `114621.50`, ledger `3169779.99`) |
| Identity / Cognito | 11 rows; 8 production subs match 10:07 UTC repair; `tenant_users` 7; `user_roles` 10 |
| C1C UAT | 37 AWS-only intake checks intact |
| FA Moov account | `26c2dbb1…` → `60922058-7eca-4889-81dd-5720d7b9de96` production, unchanged |
| Storage objects | Not modified |
| New Moov events on AWS apply tables | None since recon (`payment_webhook_events` still 276 / 19 since Sep 12) |
| Dual-run AWS receipts of live events | None (last receipt 2026-09-03) |
| Unintended tenant writes | None (read-only inventory Lambda deleted) |

Temporary Lambda `checksops-cursor-webhook-cutover-ro-temp` deleted
(`ResourceNotFoundException`). Rehearsal Lambda
`checksops-staging-rehearsal-oneshot` `CodeSha256` unchanged
`Uuqs/fRkCulPrdKUj72FJTlHdTkfhVXc+mttZljUzwk=`.

---

## Remaining Supabase dependencies in the check / payment path

If the SPA were switched to AWS **right now**, production check/payment
operations would still require Supabase for:

1. **Moov webhook apply** — only live consumer of real Moov callbacks.
2. **Moov money Edge Functions** still used by the live Supabase-mode SPA
   (onboarding, transfers, funding, disburse, invoice, readiness). AWS Moov
   flags are on, but the browser bundle still calls Supabase.
3. **Check / endorsement / OCR / deposit-prep Edge Functions**
   (`check-endorsement`, `check-ocr-intake`, `submit-signature`,
   `generate-endorsement-packet`, etc.).
4. **CheckAlt submit/poll** — dead on Supabase **and** gated off on AWS.
   A Cognito SPA deposit would hit `/prep` and be refused until
   `AWS_CHECKALT_ENABLED` and the remaining operational gates are lifted.
5. **Stripe billing, Telnyx, Resend, signature webhooks** — no AWS production
   apply.
6. **Partner check-status bridges** — still Supabase functions.

**Explicit answer:** Yes. Switching the SPA to AWS now would **not** make
check/payment processing independent of Supabase. Moov events would still
need the Supabase webhook. CheckAlt deposits would fail on both sides.
Most check workflow writes would still be the live Supabase-mode functions
until the SPA is actually cut over — which this task did not do.

---

## What would unblock a later cutover (not done here)

1. Install **production** `MOOV_WEBHOOK_SECRET` on the prep Lambda secret
   (never staging). Confirm CloudFront
   `https://checksops.com/prep/webhooks/moov` accepts a signed **ping**
   (receipt only, dry-run).
2. Add AWS as an **additional** Moov subscriber; keep Supabase. Prove a
   live event lands in `aws_provider_webhook_receipts` with mapped FA tenant
   and `applied=false`.
3. Implement and prove a **production** apply path (or keep Supabase apply
   until that exists). Do not flip dry-run false until apply is tenant-safe
   and idempotent against the fingerprint.
4. Only then remove the Supabase Moov URL.
5. CheckAlt: keep poll model. Enable `AWS_CHECKALT_ENABLED` only after
   signed exception + SPA on AWS. Do not invent a CheckAlt webhook cutover.

---

## Evidence

- `aws/cutover/webhook-cutover-20260914/ops_readiness.json`
- `aws/cutover/webhook-cutover-20260914/financial_status.json`
- `aws/cutover/webhook-cutover-20260914/providers_status.json`
- `aws/cutover/webhook-cutover-20260914/live_probes.json`
- `aws/cutover/webhook-cutover-20260914/aws_db_inventory.json`
- `aws/cutover/webhook-cutover-20260914/aws_financial_aggregates.json`
