# E14 post-deposit inspect — WAITING FOR CHECKALT

Recorded 2026-09-23T01:06Z. **Inspect only.** Flags were not changed. No FinCapture retry. No poll/approve. No deposit mutation.

## Verdict

**E14 SUBMISSION CONFIRMED — WAITING FOR CHECKALT**

Exactly one operator Deposit produced exactly one `checkalt_deposits` row and exactly one ChecksOps `checkalt-submit-deposit` POST. CheckAlt accepted the item (`referenceNumber` `123733567`, API status `40` → `pending_approval`). No signed production webhook for this reference has arrived yet. Do **not** retry.

## Selected check (unchanged by this inspect)

| Field | Live value |
| --- | --- |
| ID | `a3a4a153-46e1-4c28-a273-79a9bd04f3a6` |
| Number | `#0121319295` |
| Tenant | Freedom `2eff5f1a-929d-4ce3-9a8b-cd96b98df42a` |
| Amount | `$1,546.72` / `154672` cents |
| ChecksOps status / stage / reco | `approved_for_deposit` / `ready_for_deposit` / `ready_for_deposit` |
| Official front | `…/front-1790116385272.checkalt.jpg` |
| Official rear | `…/endorsed_deposit_kp9u.checkalt.jpg` |
| Check `updated_at` | `2026-09-22T23:49:28.965Z` (before submit; images not rewritten) |

Submit loads official `.checkalt.jpg` paths from this row. Those paths are still the approved front and `kp9u` rear.

## Deposit row (exactly one)

| Field | Value |
| --- | --- |
| Deposit ID | `b6adc6a6-232f-4748-add3-edff3c4036d4` |
| CheckAlt reference | `123733567` |
| Amount | `1546.72` / `154672` cents |
| Status | `pending_approval` |
| Created | `2026-09-23T01:01:03.798Z` |
| `provider_http_attempted_at` | `2026-09-23T01:01:04.184Z` |
| Submitted / updated | `2026-09-23T01:01:04.223Z` |
| `failure_class` / `last_error` | none |
| Last poll / cleared / returned | none |
| Idempotency key | present (64-hex) |
| Payload `status_code` | `40` (CheckAlt process status, not HTTP 40) |
| Payload keys include | `success`, `referenceNumber`, `processDate`, `riskRating` |

`persistProviderOutcome` writes `pending_approval` only when FinCapture HTTP `resp.ok` and API status `40`. HTTP to CheckAlt was therefore 2xx.

## Exactly one provider operation

API Gateway `/aws/apigateway/checksops-production-prep-http` since `2026-09-23T00:00Z`:

| Path | Count | Result |
| --- | --- | --- |
| `POST /prep/functions/v1/checkalt-submit-deposit` | **1** at `01:01:02.602Z` | HTTP **200**, integration 200, no error |
| `checkalt-poll*` | 0 | |
| `checkalt-approve*` | 0 | |
| `webhooks/checkalt` | 0 | |

No second `checkalt_deposits` row. No other row shares reference `123733567`. JWT authenticate is a login prelude, not a second deposit process POST.

## Webhooks

No `aws_provider_webhook_receipts` or `checkalt_webhook_events` for this deposit/reference. One older Freedom `deposit.updated` receipt at `2026-09-22T21:27:56Z` maps to a **different** deposit and is unrelated.

Because no webhook has arrived for `123733567`, dry-run “recorded but not applied” cannot be proven for this item yet. `AWS_PROVIDER_WEBHOOK_DRY_RUN` is still `true`; apply is also disabled while production execution is on (`sandboxWebhookApplyEnabled` is false). When a genuine signed webhook arrives it should be receipted and not mutate deposit status.

## Historical totals

Was 69 / 58 referenced / `453990.48` / `2026-09-04`. Now 70 / 59 / `455537.20` / `2026-09-23T01:01:04.223Z`. Delta is this one row (`+1546.72`).

## Flags (left exactly as found)

`checksops-production-prep-api` LastModified still `2026-09-22T23:52:59Z`. CodeSha `fG/MT+D3Zolft+W94i/eW/uf1uEWIF3YaM4KtuorRCQ=`.

- `AWS_FINANCIAL_PERMISSIONS_ACTIVATED=true`
- `AWS_CHECKALT_ENABLED=true`
- `AWS_PROVIDER_EXECUTION_ENABLED=true`
- `AWS_PROVIDER_WEBHOOK_DRY_RUN=true`
- Reconcile / Moov / sandbox / Plaid = `false`

Inspect oneshot restored to staging RDS.

## Operator

Do **not** click Deposit again. Do not poll/approve/reconcile from this agent. Wait for CheckAlt (webhook or later status inspect).
