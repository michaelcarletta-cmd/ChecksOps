# Real provider UAT / sandbox validation results

Branch `cursor/real-provider-uat-validation-c48b`. PR #101 merged to `main` at `06f1307f` before this HTTP run. This document is the follow-up (PR #102).

**Production was not touched. No production provider transaction occurred.**

This phase does **not** execute `PRODUCTION_ACTIVATION_RUNBOOK.md`.

## Live staging overlay

| Item | Value |
| --- | --- |
| Lambda | `checksops-staging-api` (in-place overlay, not a thin SAM deploy) |
| `CodeSha256` | `YDhfhFDGgf+a8aKyPZKd+KThsDtjPJW6lMNJAKRp6MI=` |
| `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED` | `true` (staging-only) |
| `AWS_PROVIDER_EXECUTION_ENABLED` | `false` |
| `AWS_FINANCIAL_PERMISSIONS_ACTIVATED` | `false` |
| `AWS_MOOV_ENABLED` / `AWS_CHECKALT_ENABLED` / `AWS_PLAID_ENABLED` | `false` |
| `AWS_PROVIDER_WEBHOOK_DRY_RUN` | `true` |
| Temporary VPC oneshot | `checksops-staging-uat-agg-c48b` captured aggregates + production provider IDs, then **deleted** (function + IAM role) |
| Temporary no-VPC sidecar | `checksops-staging-provider-http-c48b` ran real Moov/CheckAlt HTTPS, then **deleted** (function + IAM role) |

The staging API Lambda remains in VPC subnets without a NAT gateway. Lambda ENIs have no public IPs. SG egress includes `tcp/443 0.0.0.0/0`, which is insufficient without NAT. Live `/sandbox/*` provider HTTP from the API therefore returns `503 provider_egress_failed`. Real provider HTTPS was executed only from the no-VPC sidecar, which read `checksops/staging/providers` in-process and never returned secret values.

## Secret presence (no values)

`checksops/staging/providers` has an `AWSCURRENT` version.

| Key name | Present |
| --- | --- |
| `MOOV_SANDBOX_PUBLIC_KEY` | yes |
| `MOOV_SANDBOX_SECRET_KEY` | yes |
| `CHECKALT_UAT_BASE_URL` | yes (host is exactly `https://uatapi.checkalt.com`) |
| `CHECKALT_UAT_USER_ID` | yes |
| `CHECKALT_UAT_PASSWORD` | yes |
| `CHECKALT_UAT_FI_KEY` | yes |
| `CHECKALT_UAT_MERCHANT` | yes (length 19, labeled value contains `lockbox5`, does not contain `prod`; HTTP header sent is `lockbox5`) |
| `MOOV_SANDBOX_PLATFORM_ACCOUNT_ID` | no |
| `MOOV_SANDBOX_WEBHOOK_SECRET` | no |
| `MOOV_SANDBOX_ALLOWED_ORIGIN` | no |
| `CHECKALT_SANDBOX_WEBHOOK_SECRET` | no |
| Production `MOOV_*` / `CHECKALT_*` on this secret | no |

Do not copy production keys. Do not write credentials into GitHub, Lambda env, logs, or docs.

## Isolation (before any money movement)

| Check | Result |
| --- | --- |
| Production execution flags | all false |
| Isolation route | `200`, `stopHttpUnlessProven=true`, `productionIdOverlap=false`, `moovHttp=true`, `checkaltHttp=true`, environments `["production"]` |
| Production RDS provider rows | 3 Moov accounts, 1 Moov wallet, environment `production` only |
| Approved CheckAlt host | `https://uatapi.checkalt.com` |
| Approved merchant header | `lockbox5` |
| Browser amounts | `400 untrusted_amount` |
| C1C vs Freedom | `403 cross_tenant_denied` |

Production Moov mappings in RDS were not overwritten.

## Moov sandbox identity / isolation

Sidecar used **only** `MOOV_SANDBOX_*`. Pin remains `x-moov-version: v2024.01.00` (not changed).

| Check | Result |
| --- | --- |
| OAuth `POST /oauth2/token` | **Succeeded.** `tokenType=Bearer`, granted scope `/accounts.read` |
| `GET /accounts` | **401** `moov_sandbox_http_failed`. Zero listed sandbox accounts |
| `GET /accounts/{productionId}` for each of 3 production RDS Moov IDs | **401**, `visible=false`. Production accounts are not readable with sandbox keys |
| Production ID overlap | **false** (not visible; also no listed sandbox IDs to compare) |
| Sandbox identity proven for transfers | **false** — cannot list or select an isolated sandbox account/payment-method |
| Transfer / retrieve / duplicate / cancel | **Not executed** (stopped after isolation) |

Sandbox vs production isolation is only partially proven: sandbox keys cannot read production account IDs. They also cannot read any sandbox account, so a $0.01 transfer was refused.

Likely causes of GET 401 after a successful token with `/accounts.read`: Moov origin allowlist on API calls, or these keys are not a platform application with account access. `MOOV_SANDBOX_PLATFORM_ACCOUNT_ID` and `MOOV_SANDBOX_ALLOWED_ORIGIN` are not on the secret.

## CheckAlt UAT HTTP

Host allowlist enforced. Merchant header `lockbox5`. No negotiable check. No real customer. No invented bank numbers.

| Check | Result |
| --- | --- |
| Authenticate | **Succeeded** via `/public/fincapture/authenticate` (HTTP 200, token present). `/public/jwtauth/authenticate` was tried first. |
| `getUserAccountInformation` | **200**. `isValidUser=true`. `accountDataList` length 2. Object keys: `accountNumber`, `availableDepositLimit`, `dailyDepositLimit`. **No `ssoKey`.** |
| `getDepositAccountInformation` | **200** after supplying the UAT list `accountNumber` in-process (not returned). Still no `ssoKey`. |
| Register TEST account | **Not executed.** FinCapture process requires a registered depositor `ssoKey`. Registration needs a deposit account number. Inventing bank numbers is refused. |
| Synthetic deposits at 1 / 100 / 12345 | **Not executed** (`account_unregistered`) |
| History / approve / item | **Not executed** |
| Provider-side deposit count | **0** (history was not queried after stop; earlier unregistered process attempts from the first sidecar pass returned 400 “Complete the Register event” and history delta 0) |
| Negotiable check submitted | **false** |

First sidecar pass (before the ssoKey gate) called `/deposit/process` four times and received HTTP 400: `The User does not exist or is not authorized for deposit. Complete the Register event then resubmit capture transaction.` History before/after counts were 0. No provider reference was issued. The ssoKey gate now prevents that process call.

## CheckAlt `userAmount` unit

Live UAT did not echo `userAmount` because no deposit was accepted.

Still documented from production CheckAlt support + T6, **not re-proven against UAT behavior**:

- ChecksOps 1 cent → send `userAmount` 1 → `$0.01`
- ChecksOps 100 cents → send `userAmount` 100 → `$1.00`
- ChecksOps 12345 cents → send `userAmount` 12345 → `$123.45`

Live UAT scale: `not_echoed_or_unconfirmed`.

## Idempotency

| Provider | Result |
| --- | --- |
| Moov provider-side | **Not proven.** No sandbox transfer object exists. Staging API idempotency with `ref=null` is ChecksOps-side fail-closed only. |
| CheckAlt provider-side | **Not proven.** Zero UAT deposits. Unit tests still prove persist-before-HTTP recovery does not POST `/deposit/process` again. |

## Webhooks

| Check | Result |
| --- | --- |
| `MOOV_SANDBOX_WEBHOOK_SECRET` | missing |
| `CHECKALT_SANDBOX_WEBHOOK_SECRET` | missing |
| Unsigned / signed-without-secret | `401 sandbox_webhook_secret_unavailable`, `applied=false` |
| Production webhooks | **not redirected** |
| Duplicate / signature / spoofed tenant | Covered by unit tests + T4 synthetic webhooks (`dry_run=true`). Live signed sandbox webhooks cannot run without secrets. |

## Failure + reconciliation

| Case | Result |
| --- | --- |
| Live sandbox reconcile | `200`, `autoCorrected=false`, `findings=0` |
| T6 simulated provider 400 | Internal `provider_failed` + audit |
| T6 provider-accepted / DB-update-failed | Finding `internal_pending_provider_succeeded`; no second provider object; report-only |
| Real Moov provider failure HTTP | Not reached (stopped before transfer) |
| Real CheckAlt provider failure HTTP | 400 register-required on the first unregistered process; no ledger write |
| Staging API provider HTTPS | `503 provider_egress_failed` (no NAT) |

Reconciliation remains report-only.

## Tenant isolation

- C1C retrieve of Freedom Moov sandbox operation: **403 `cross_tenant_denied`**
- C1C retrieve of Freedom CheckAlt sandbox operation: **404 / 403** (no CheckAlt op to steal)
- Browser `tenant_id` / `user_id` / amounts ignored
- Unauthenticated probe: **401**
- T1–T5 Freedom/C1C isolation unchanged
- Spoofed provider IDs: T4 **403 `spoofed_provider_id`**

## Financial before/after (admin oneshot, then deleted)

Unchanged vs PR #100 / T6 baseline. Sandbox/UAT testing did not alter production/restored money ledgers.

| Metric | Before | After |
| --- | --- | --- |
| `homeowner_ledger_amount` | 2977337.23 | 2977337.23 |
| `check_intake_amount` | 1317000.53 | 1317000.53 |
| `checkalt_deposits_amount` | 380333.17 | 380333.17 |
| `payment_transfers_amount_cents` | 0 | 0 |
| `deposit_items_amount` | 963972.98 | 963972.98 |
| `deposit_batches_total_amount` | 964752.98 | 964752.98 |
| `disbursement_splits_amount` | 822212.97 | 822212.97 |
| `disbursement_batches_check_amount` | 829768.914 | 829768.914 |
| `claim_payments_amount` | 66003.92 | 66003.92 |

## Complete regression

| Suite | Result |
| --- | --- |
| Unit `aws/tests/*.test.mjs` | **158/158** |
| Sandbox / UAT live (isolation-first) | **18/27** (9 fails are API-Lambda egress / missing sandbox account mapping) |
| T1 writes / auth isolation | **20/20** |
| T2 writes / financial guards | **30/30** |
| T3 notes / storage | **27/27** |
| T4 providers / webhooks | **20/20** |
| T5 workflow | **26/26** |
| T6 financial certification | **22/22** |
| Cognito/auth | covered by T1 login + unauthenticated 401s |
| Tenant isolation | T1–T5 + sandbox C1C deny |
| RLS | T1–T3 `rls_denied` on cross-tenant writes |
| Storage | T3 authorized PUT/sign/move/delete; C1C 403 |
| Financial reconciliation | T6 report-only + live sandbox reconcile findings=0 |

No security regression. Production provider execution remains disabled (`provider_disabled` / production flags false).

## Cutover

| Provider | Status |
| --- | --- |
| Moov | **NO-GO** |
| CheckAlt | **NO-GO** |
| ChecksOps AWS overall | **NO-GO** |

A provider remains NO-GO independently. Sidecar Moov OAuth success and CheckAlt UAT auth success do **not** produce overall GO: there is no proven sandbox transfer, no proven UAT deposit, and the staging API Lambda cannot reach either provider.

Must complete before any cutover:

1. Add NAT (or equivalent HTTPS egress) for `checksops-staging-api`, **or** keep provider HTTP on a dedicated no-VPC function that the API can invoke. SG `443/0.0.0.0/0` alone is not enough.
2. Make Moov sandbox keys able to `GET /accounts` (and/or set `MOOV_SANDBOX_PLATFORM_ACCOUNT_ID` + `MOOV_SANDBOX_ALLOWED_ORIGIN`). Stop if listed IDs overlap production RDS.
3. Prove $0.01 sandbox transfer, retrieve, same-key retry, provider object count = 1.
4. Register a CheckAlt UAT TEST depositor using a CheckAlt-provided test account number. Do not invent bank numbers. Then synthetic deposits at 1 / 100 / 12345 and prove `userAmount` scale from UAT echo/errors.
5. Add sandbox/UAT webhook secrets and prove signature + duplicate ignore on staging endpoints only.
6. Fill every checkbox in `PRODUCTION_ACTIVATION_RUNBOOK.md`.
7. Then a **separate** human-approved cutover (not this PR).

Exact next step while NO-GO: fix staging API egress (NAT) and Moov account access / CheckAlt UAT registration. Do not enable production flags.

## Production confirmation

- No production transaction occurred.
- Production flags remained false.
- Production webhooks, DNS, and frontend were not changed.
- Production provider credentials were not changed.
- Supabase production was not disabled.
- Production provider objects were not deleted or overwritten.
- Temporary sidecar and oneshot Lambdas/roles were deleted after the run.
