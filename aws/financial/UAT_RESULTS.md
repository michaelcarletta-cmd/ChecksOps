# Real provider UAT / sandbox validation results

Branch `cursor/real-provider-uat-validation-c48b` from current `main` `1b7559decb0a0bd95a3b717f543642bdb22a5fff` (merged PR #100).

**PR #101** targets `main`. Do not merge as a production cutover.

**Production was not touched. No production provider transaction occurred.**

This phase does **not** execute `PRODUCTION_ACTIVATION_RUNBOOK.md`.

## Live staging overlay

| Item | Value |
| --- | --- |
| Lambda | `checksops-staging-api` (in-place overlay, not a thin SAM deploy) |
| `CodeSha256` | `Fvl/HdBypU9qVdmpuUeXnXQz/0AYf90qslr0F/za39s=` |
| `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED` | `true` (staging-only) |
| `AWS_PROVIDER_EXECUTION_ENABLED` | `false` |
| `AWS_FINANCIAL_PERMISSIONS_ACTIVATED` | `false` |
| `AWS_MOOV_ENABLED` / `AWS_CHECKALT_ENABLED` / `AWS_PLAID_ENABLED` | `false` |
| Temporary oneshot | `checksops-staging-uat-agg-c48b` ran read-only aggregates and was **deleted** (function + IAM role) |
| Provider secret `checksops/staging/providers` | Exists as a placeholder. **No `AWSCURRENT` version.** `GetSecretValue` → `ResourceNotFoundException`. Zero key values present. |

## Isolation (before any provider HTTP)

| Check | Result |
| --- | --- |
| Production execution flags | all false |
| Isolation route | `200`, `stopHttpUnlessProven=true`, `productionIdOverlap=false` |
| Production provider environments | `["production"]` |
| Moov HTTP | **stopped** — `sandbox_keys_missing` |
| CheckAlt HTTP | **stopped** — `uat_keys_missing` |
| Approved CheckAlt host | `https://uatapi.checkalt.com` |
| Approved merchant | `lockbox5` |
| Browser amounts | `400 untrusted_amount` |
| Sandbox writes | `aws_provider_sandbox_*` only; cleanup deleted 2 fail-closed rows |

Environment classification could not be proven (no sandbox/UAT key values). Provider HTTP was refused. This is correct fail-closed behavior.

## Credential availability (no values)

| Key name | Present |
| --- | --- |
| `MOOV_SANDBOX_PUBLIC_KEY` | no |
| `MOOV_SANDBOX_SECRET_KEY` | no |
| `CHECKALT_UAT_BASE_URL` | no |
| `CHECKALT_UAT_USER_ID` | no |
| `CHECKALT_UAT_PASSWORD` | no |
| `CHECKALT_UAT_FI_KEY` | no |
| `CHECKALT_UAT_MERCHANT` | no |
| Production `MOOV_*` / `CHECKALT_*` on this secret | no |

Do not copy production keys. Do not write credentials into GitHub, Lambda env, logs, or docs.

## Moov API version (not changed)

| Item | Value |
| --- | --- |
| Current production pin | `x-moov-version: v2024.01.00` (`supabase/functions/_shared/moovClient.ts`) |
| Invoice exception only | `v2026.07.00` in `moov-invoice` |
| Sandbox-tested version | pin `v2024.01.00` (no live Moov HTTP this phase) |
| Moov docs default when header omitted | `v2024.01.00` |
| Moov docs current stable | `v2026.07.00` (`v2026.10.00` in development) |
| Compatibility | `amount.value` remains integer USD cents on both pins. Newer versions add `amount.valueDecimal` / `amountDetails` (tax, tip, surcharge). |
| Recommendation | **Keep `v2024.01.00`.** Any bump needs an explicit PR with tests. |

## CheckAlt `userAmount` unit

Authoritative evidence that `userAmount` is **integer cents** (not dollars):

1. Production `checkalt-submit-deposit` records CheckAlt support guidance: `$123.45 → 12345`. Sending dollars caused **RDC Amount Mismatch** against OCR cents.
2. ChecksOps `providers/amounts.mjs` and T6 certification use the same map.
3. Adapter conversion is 1:1: ChecksOps integer cents === CheckAlt `userAmount`.

Live UAT did not run, so unit is not re-proven against FinCapture UAT behavior this phase. Fixtures remain `$0.01 → 1`, `$1.00 → 100`, `$123.45 → 12345`.

Rejected: zero, negative, over configured maximum, more than 2 decimal precision, browser-supplied amounts.

UAT auth path for this phase: `POST /public/jwtauth/authenticate`. Same-host 404 fallback only: `/public/fincapture/authenticate`. Host never changes.

Images, if required later, are a synthetic 1×1 PNG labeled non-negotiable. No real check was submitted.

## Live HTTP results

| Provider case | Result |
| --- | --- |
| Moov auth / account / wallet / methods / capabilities | **Not executed.** `409 sandbox_credentials_unavailable` |
| Moov $0.01 transfer | Fail-closed persist; `sandboxHttpCalled=false`; no provider reference |
| Moov provider-side idempotency | Not proven against Moov sandbox ledger (zero provider objects) |
| Moov webhook | Unsigned/signed-without-secret → `401 sandbox_webhook_secret_unavailable`; `applied=false` |
| CheckAlt UAT authenticate | **Not executed.** `409` / `limitation=uat_keys_missing` |
| CheckAlt account / deposit / history / approve | **Not executed.** No negotiable check. `negotiableCheckSubmitted=false` |
| CheckAlt provider-side idempotency | Fail-closed ChecksOps replay only (same operation id). Zero UAT deposits |

Internal fail-closed operation ids (cleaned up):

- Moov `b8c9c784-4127-4bae-821e-214cde930de1` (replayed same id)
- CheckAlt `29530178-fb70-48cd-ae44-8a77e347cb6d` (replayed same id)
- Cleanup `deleted=2`

## Failure / reconciliation

| Case | Result |
| --- | --- |
| Live sandbox reconcile | `200`, `autoCorrected=false`, `findings=0` |
| T6 simulated provider 400 | Internal `provider_failed` + audit |
| T6 provider-accepted / DB-update-failed | Finding `internal_pending_provider_succeeded`; no second provider object |
| CheckAlt persist-before-HTTP recovery (unit) | Existing submitting row does **not** POST `/deposit/process` again |
| Real provider failure HTTP | Not available (no keys) |

## Tenant isolation

- C1C retrieve of Freedom Moov sandbox operation: **403 `cross_tenant_denied`**
- C1C retrieve of Freedom CheckAlt sandbox operation: **403 `cross_tenant_denied`**
- Browser `tenant_id` / `user_id` / amounts ignored
- Unauthenticated probe: **401**
- T1–T5 Freedom/C1C isolation unchanged

## Financial before/after (admin oneshot, then deleted)

Matches PR #100 / T6 baseline. Production/restored values did not change.

| Metric | Value |
| --- | --- |
| `homeowner_ledger_amount` | 2977337.23 |
| `check_intake_amount` | 1317000.53 |
| `checkalt_deposits_amount` | 380333.17 |
| `payment_transfers_amount_cents` | 0 |
| `deposit_items_amount` | 963972.98 |
| `deposit_batches_total_amount` | 964752.98 |
| `disbursement_splits_amount` | 822212.97 |
| `disbursement_batches_check_amount` | 829768.914 |
| `claim_payments_amount` | 66003.92 |

## Complete regression

| Suite | Result |
| --- | --- |
| Unit `aws/tests/*.test.mjs` | **153/153** |
| Sandbox / UAT live (isolation-first) | **24/24** |
| T1 writes / auth isolation | **20/20** |
| T2 writes / financial guards | **30/30** |
| T3 notes / storage | **27/27** |
| T4 providers / webhooks | **20/20** |
| T5 workflow | **26/26** |
| T6 financial certification | **22/22** |

No security regression.

## Cutover

| Provider | Status |
| --- | --- |
| Moov | **NO-GO** |
| CheckAlt | **NO-GO** |
| ChecksOps AWS overall | **NO-GO** |

A provider can remain NO-GO independently.

Must complete before any cutover:

1. User writes **sandbox/UAT-only** values into `checksops/staging/providers` (`MOOV_SANDBOX_*`, `CHECKALT_UAT_*`). Do not copy production keys.
2. Re-run isolation. Stop if host/merchant/production-ID checks fail.
3. Prove real Moov sandbox HTTP: auth, $0.01 transfer, retrieve, same-key retry, provider object count = 1.
4. Prove real CheckAlt UAT HTTP: jwtauth, account, synthetic-image deposits at 1 / 100 / 12345, history, no duplicate process.
5. Fill every checkbox in `PRODUCTION_ACTIVATION_RUNBOOK.md`.
6. Then a **separate** human-approved cutover (not this PR).

Exact next step while NO-GO: populate the staging provider secret with sandbox/UAT keys, then re-run this validation. Do not enable production flags.

## Production confirmation

- No production transaction occurred.
- Production flags remained false.
- Production webhooks, DNS, and frontend were not changed.
- Production provider credentials were not changed.
- Supabase production was not disabled.
- Production provider objects were not deleted or overwritten.
