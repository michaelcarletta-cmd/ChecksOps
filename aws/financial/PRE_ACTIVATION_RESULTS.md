# Financial pre-activation results

Branch `cursor/aws-financial-preactivation-c48b` from current `main` `2645d9c54a539ed6981597b3f575428553550b6b` (PR #98 / T5).

**PR #99** targets `main`. Do not merge until a human reviews.

**Production was not touched. No production provider transaction occurred.**

Master guard remains `AWS_PROVIDER_EXECUTION_ENABLED=false`. All production provider flags remain false. Financial permissions remain deactivated.

Staging Lambda `checksops-staging-api` overlay (not a thin SAM deploy):

- `CodeSha256` `aDe7oUoyk67+lPsEpOz5/ZKARZpUrOT+dB9NtZGn8Fw=`
- `AWS_FINANCIAL_SANDBOX_SIMULATION_ENABLED=true`
- `AWS_FINANCIAL_PERMISSIONS_ACTIVATED=false`

Temporary admin oneshot `checksops-staging-t6-financial-c48b` applied `60_financial_preactivation.sql`, captured aggregates, and was **deleted** (function + IAM role).

## Implementation

| Layer | Location |
| --- | --- |
| Flags | `aws/functions/api/financial-flags.mjs` |
| Auth gate | `aws/functions/api/financial-authz.mjs` |
| Amounts | `aws/functions/api/providers/amounts.mjs` |
| State machine | `aws/functions/api/financial-state.mjs` |
| Idempotency | `aws/functions/api/financial-idempotency.mjs` |
| Ownership | `aws/functions/api/financial-ownership.mjs` |
| Audit | `aws/functions/api/financial-audit.mjs` |
| Reconciliation | `aws/functions/api/financial-reconciliation.mjs` |
| Router | `aws/functions/api/financial.mjs` |
| SQL | `aws/financial/sql/60_financial_preactivation.sql` |

Routes: `GET /financial/status`, `POST /financial/prepare`, `/financial/simulate-submit`, `/financial/simulate-webhook`, `/financial/simulate-failure`, `/financial/reconcile`, `/financial/cleanup`.

## Historical regression update

`scripts/aws-write-tranche2-validate.mjs` now expects T3-approved `check_messages` INSERT (zero-amount `ops_note`). Financial table denials, spoof denials, and provider guards are unchanged.

## Amount / unit validation

| Provider | Unit | Example |
| --- | --- | --- |
| CheckAlt | integer cents `userAmount` | `123.45` → `12345` |
| Moov | `amount.value` integer USD cents (v2026.04.00 / v2026.07.00) | `{ currency: "USD", value: 12345 }` |

Rejected server-side: `$0`, negative, `> $1,000,000`, precision beyond cents, browser-supplied `amount` / `amount_cents`. Live prepare of a T5 synthetic check (null amount) used the server fixture `12345` cents, not the request body.

## Authorization

`has_permission()` remains CRUD only. Frontend step-up keys (`deposit.submit`, `disbursement.send`, …) are not activated on AWS.

Staging testers are authenticated tenant members (`staff`), not automatically `owner`/`admin`/`manager`. `roleOk` is recorded. `canSimulate` requires resource membership + sandbox flag. `canExecuteProduction` stays false.

C1C cannot prepare a Freedom check (`403 rls_denied`). Unauthenticated prepare is `401`.

## Unit tests

`node --test aws/tests/api-financial.test.mjs`: **14/14 PASS**  
Provider + workflow + write suites: **60/60 PASS** with financial tests included in a combined run  
Health/auth/identity/storage: **46/46 PASS**

## Live staging — financial certification

`scripts/aws-financial-preactivation-validate.mjs`: **22/22 PASS**

| Case | Result |
| --- | --- |
| `/financial/status` | execution flags false; sandbox sim true |
| Unauthenticated prepare | **401** |
| T5 create → review → `approved_for_deposit` | **200** |
| Browser amount | **400** `untrusted_amount` |
| C1C prepare Freedom check | **403** `rls_denied` |
| Freedom CheckAlt simulate prepare | **200**; `12345` cents; `sandbox_certification_fixture` |
| Repeat prepare | idempotent same id |
| Parallel submit | one operation; `provider_pending`; `liveProviderCalled=false` |
| Synthetic CheckAlt webhook | `provider_confirmed`; tenant mapped from operation (Freedom); payload tenant ignored |
| Duplicate webhook | `duplicate=true`, `applied=false` |
| Sandbox disbursement | prepare + submit + `transfer.completed` → `provider_confirmed` |
| Out-of-order webhook | ignored |
| Simulated provider 400 | `provider_failed` |
| Provider accepted / DB update failed | `submitting` + `provider_reference`; reconcile reports `internal_pending_provider_succeeded`; `autoCorrected=false` |
| Live CheckAlt/Moov functions | still **403** `provider_disabled` |
| Cleanup | simulated ops + synthetic check deleted |

No live CheckAlt or Moov HTTP. No sandbox provider credentials were used to create a real provider transaction.

## T1–T5 live regression

| Suite | Result |
| --- | --- |
| T1 writes | **20/20** |
| T2 writes (updated message INSERT) | **30/30** |
| T3 writes + storage | **27/27** |
| T4 providers + webhooks | **20/20** |
| T5 workflow | **26/26** |

## Financial aggregates (unchanged)

| Metric | Value |
| --- | --- |
| `homeowner_ledger_amount` | 2977337.23 |
| `check_intake_amount` | 1317000.53 |
| `checkalt_deposits_amount` | 380333.17 |
| `payment_transfers_amount_cents` | 0 |
| `payment_wallet_ledger_amount_cents` | 0 |
| `deposit_items_amount` | 963972.98 |
| `disbursement_splits_amount` | 822212.97 |
| `claim_payments_amount` | 66003.92 |

Money ledgers remain SELECT-only for `checksops`. Certification tables are the only new DML surface.

## Production activation

Runbook: `aws/financial/PRODUCTION_ACTIVATION_RUNBOOK.md`. **Not executed.**

## Unresolved blockers (intentional)

- Production financial permissions are not activated
- Live CheckAlt/Moov sandbox HTTP was not used (no safe sandbox execution credentials on the staging Lambda; simulation certified the architecture instead)
- Moov readiness remains a local snapshot (`AWS_PROVIDER_LIVE_READS_ENABLED=false`)
- Wire is documented, not a current primary production rail
- Actum has no Edge Function on current `main`
- Do not enable `AWS_PROVIDER_EXECUTION_ENABLED` until a later human-approved phase
