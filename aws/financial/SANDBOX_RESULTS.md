# Provider sandbox validation results

Branch `cursor/provider-sandbox-validation-c48b` from current `main` `8b53297672aec5ee80617675b702ab8c617dbc95` (merged PR #99).

**PR #100** targets `main`. Do not merge automatically.

**Production was not touched. No production provider transaction occurred.**

## Live staging overlay

| Item | Value |
| --- | --- |
| Lambda | `checksops-staging-api` (in-place overlay, not a thin SAM deploy) |
| `CodeSha256` | `gEk3jKNSHwtU9uuMtIaAEIAX68PhOUSl35fBQJ6vVU0=` |
| `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED` | `true` (staging-only; independent of production master) |
| `AWS_PROVIDER_EXECUTION_ENABLED` | `false` |
| `AWS_FINANCIAL_PERMISSIONS_ACTIVATED` | `false` |
| `AWS_MOOV_ENABLED` / `AWS_CHECKALT_ENABLED` / `AWS_PLAID_ENABLED` | `false` |
| Temporary oneshot | `checksops-staging-t7-sandbox-c48b` applied `70_provider_sandbox.sql` and was **deleted** (function + IAM role) |
| Provider secret `checksops/staging/providers` | No `AWSCURRENT` version (empty placeholder) |

## 1–2. PR / SHA

- PR: **#100**
- Branch: `cursor/provider-sandbox-validation-c48b`
- Base: `main` @ `8b53297672aec5ee80617675b702ab8c617dbc95`

## 3. Moov sandbox availability

**Not available on AWS staging.**

- Production Edge Functions use separate `MOOV_SANDBOX_*` keys; those values were not copied to AWS and were not extracted.
- Moov sandbox and production share `https://api.moov.io`. Keys select the ledger.
- RDS Freedom/C1C `payment_provider_accounts` are `environment=production`. Those IDs were not used and were not overwritten.
- Adapter refuses `MOOV_PUBLIC_KEY` / `MOOV_SECRET_KEY`.

## 4. Moov real HTTP test results

**Not executed.** Fail-closed live probes only.

| Case | Result |
| --- | --- |
| Auth / readiness / wallet / methods / capabilities | `409 sandbox_credentials_unavailable` |
| Create $0.01 transfer | Fail-closed; persisted staging row; `sandboxHttpCalled=false` |
| Retrieve / cancel / return / reverse | Skipped (no sandbox transfer exists) |
| API version | Adapter pin `v2024.01.00`; amount unit integer cents (`amount.value`) |

## 5. CheckAlt sandbox availability

**No genuine FinCapture sandbox/UAT is configured for ChecksOps.**

- No `CHECKALT_SANDBOX_*` keys.
- Staging `checkalt_config.base_url` is null.
- Production `CHECKALT_*` keys were not used.
- Documented cutover limitation. Production CheckAlt stays disabled.

## 6. CheckAlt real HTTP test results

**Not executed.** No negotiable check was submitted.

Live probe: `409 sandbox_credentials_unavailable`, `limitation=no_sandbox_fincapture_environment`.
Deposit route: fail-closed persist + idempotent replay. `negotiableCheckSubmitted=false`.

## 7. Plaid sandbox

**Not applicable to the money path, and no sandbox keys on AWS.**

Plaid Link is account-connection, not deposit→disburse. Live probe: `409 sandbox_credentials_unavailable`. No transfers.

## 8. Sandbox transaction IDs

No provider sandbox transaction IDs exist (no HTTP). Internal fail-closed operation ids (redacted after cleanup):

- Moov fail-closed op `b574…c3b3` (replayed same id)
- CheckAlt fail-closed op `e0dd…717f` (replayed same id)
- Cleanup deleted both (`deleted=2`)

## 9. Idempotency

| Case | Result |
| --- | --- |
| Unit: mocked Moov HTTP create + retry | One POST `/transfers`; second request `duplicate=true` |
| Live: missing-credential transfer twice | Same ChecksOps operation id; `sandboxHttpCalled=false` |
| Live: missing-credential CheckAlt deposit twice | Same ChecksOps operation id |
| Rapid double-click / timeout retry | Same stable key (`tenant\|operation\|resource\|1\|USD` → Moov UUID) |

One ChecksOps financial operation = one provider object. With no sandbox HTTP, provider object count is **zero**.

## 10. Webhooks

| Case | Result |
| --- | --- |
| Unit: signed sandbox webhook | Signature ok; tenant mapped from `aws_provider_sandbox_objects`; payload `tenant_id` ignored; `applied=false`; `productionRecordsMutated=false` |
| Unit: duplicate event | `duplicate=true`, no second row |
| Live: unsigned `/sandbox/webhooks/moov` | `401 sandbox_webhook_secret_unavailable` |
| Production webhook URLs | Unchanged (still Supabase) |

## 11. Failure / reconciliation

| Case | Result |
| --- | --- |
| Live sandbox reconcile | `200`, `autoCorrected=false`, `findings=0` |
| T6 simulated provider 400 | Internal `provider_failed` + audit |
| T6 provider-accepted / DB-update-failed | Reconcile finding `internal_pending_provider_succeeded`; no second provider object |
| Real provider failure HTTP | Not available (no sandbox keys) |

## 12. Tenant isolation

- C1C retrieve of Freedom sandbox operation: **403 `cross_tenant_denied`**
- Browser `tenant_id` / `user_id` / amounts ignored
- Unauthenticated probe: **401**

## 13. Complete regression

| Suite | Result |
| --- | --- |
| Unit `aws/tests/*.test.mjs` | **147/147** |
| Sandbox live | **18/18** |
| T1 writes / auth isolation | **20/20** |
| T2 writes / financial guards | **30/30** |
| T3 notes / storage | **27/27** |
| T4 providers / webhooks | **20/20** |
| T5 workflow | **26/26** |
| T6 financial certification | **22/22** |

No regressions.

## 14. Financial reconciliation

Oneshot aggregates **unchanged** vs T6 / PR #99:

| Metric | Value |
| --- | --- |
| `homeowner_ledger_amount` | 2977337.23 |
| `check_intake_amount` | 1317000.53 |
| `checkalt_deposits_amount` | 380333.17 |
| `payment_transfers_amount_cents` | 0 |

`moneyLedgersWritable=false`. Sandbox tables granted to `checksops` only under `request.provider_sandbox=1`.

## 15. Remaining provider limitations

1. No `MOOV_SANDBOX_*` on AWS — real Moov HTTP not proven.
2. No CheckAlt FinCapture sandbox — deposits cannot be safely certified.
3. No Plaid sandbox keys — Link not certified (and not required for money movement).
4. Production Moov account IDs in RDS must stay isolated from any future sandbox objects.
5. Live provider idempotency against a real sandbox ledger is still outstanding.

## 16–18. Cutover

**NO-GO** for controlled production cutover.

Must complete before cutover:

- Load **sandbox-only** Moov keys into staging Secrets Manager
- Map sandbox payment methods into `aws_provider_sandbox_objects` (never production IDs)
- Prove real HTTP: auth, 1-cent transfer, retrieve, idempotent retry, webhook, failure
- Decide CheckAlt: obtain FinCapture UAT **or** keep production CheckAlt disabled with a signed exception
- Fill every checkbox in `PRODUCTION_ACTIVATION_RUNBOOK.md`
- Then a **separate** human-approved cutover (not this PR)

## 19–20. Production confirmation

- No production transaction occurred.
- Production was untouched: no DNS change, no frontend cutover, no webhook redirect, no production flag flip, no production secret write.
