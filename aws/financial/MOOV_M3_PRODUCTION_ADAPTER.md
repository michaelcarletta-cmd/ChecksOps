# Moov production readiness — Phase M3

**DARK AWS PRODUCTION ADAPTER + SERVER AUTHORIZATION + DURABLE IDEMPOTENCY**

**Status:** STOP FOR REVIEW. Code and fixture tests only. No production change. No money movement. No secret created. No flag enabled.

**Date:** 2026-09-09  
**Branch:** `cursor/moov-production-readiness-m3-a508`  
**M1 verdict (accepted):** NO-GO for production Moov **activation**.  
**M2 verdict (accepted):** GO for M3 dark implementation only.  
**M3 question:** GO/NO-GO for **M3b authorized read-only provider verification**.

This phase does **not** enable `AWS_MOOV_ENABLED`, `AWS_PROVIDER_EXECUTION_ENABLED`, or `AWS_FINANCIAL_PERMISSIONS_ACTIVATED`. It does **not** create production provider secrets, load Moov production credentials, copy sandbox into production, call Moov production HTTP, move money, redirect webhooks, disable Lovable Moov, apply `64_financial_activation_grants.sql`, or apply `72_moov_production_intent.sql`.

Companion files:

- `aws/financial/MOOV_PRODUCTION_SECRET_CONTRACT.md`
- `aws/financial/results/moov_m3_legacy_lovable_inventory.json`
- `aws/financial/results/moov_m3_live_probes.json`
- `aws/financial/results/moov_m3_financial_reconciliation.json`
- `aws/financial/sql/72_moov_production_intent.sql` (**DO NOT APPLY**)

---

## 1. Files created / modified

### Created

| Path | Role |
| --- | --- |
| `aws/functions/api/providers/production/moov-holds.mjs` | Fail-closed hold predicate |
| `aws/functions/api/providers/production/moov-secrets.mjs` | Production names only; refuse sandbox |
| `aws/functions/api/providers/production/moov-authz.mjs` | Server financial role + TOTP / dual-control |
| `aws/functions/api/providers/production/moov-idempotency.mjs` | Durable intent, CAS claim, provider key |
| `aws/functions/api/providers/production/moov-config.mjs` | Server-loaded production RDS rail |
| `aws/functions/api/providers/production/moov-client.mjs` | Isolated `https://api.moov.io` client |
| `aws/functions/api/providers/production/moov-read.mjs` | Dark GET readiness / status |
| `aws/functions/api/providers/production/moov-transfer.mjs` | Persist-before-HTTP create |
| `aws/functions/api/providers/production/moov-reconcile.mjs` | GET-only after possible POST |
| `aws/functions/api/providers/production/moov-webhook-apply.mjs` | Receipt / candidate; `applied=false` |
| `aws/functions/api/providers/production/moov-dispatch.mjs` | Dispatch slot before sandbox parity |
| `aws/functions/api/providers/production/moov-dual-control.mjs` | Record-only dual-control |
| `aws/financial/sql/72_moov_production_intent.sql` | Reserved columns; not applied |
| `aws/tests/api-moov-production.test.mjs` | A–E matrix |
| `aws/financial/results/moov_m3_legacy_lovable_inventory.json` | Legacy money-path inventory |

### Modified

| Path | Change |
| --- | --- |
| `aws/functions/api/providers.mjs` | `runProductionMoovHandler` before CheckAlt / hard-block |
| `aws/functions/api/providers/webhooks.mjs` | Production event → force `applied=false` |
| `aws/functions/api/provider-secrets.mjs` | Inventory `MOOV_PLATFORM_ACCOUNT_ID` + `MOOV_ALLOWED_ORIGIN`; drop `MOOV_ACCOUNT_ID` |
| `aws/functions/api/sandbox-credentials.mjs` | Same production name list |
| `aws/functions/api/financial.mjs` | `POST /financial/moov-dual-control` |
| `aws/functions/api/providers/catalog.mjs` | Dark production notes |
| `aws/providers/PROVIDER_INVENTORY.md` | Secret names corrected |

The production adapter does **not** import `parity/moov-*.mjs`, `loadSandboxCredentials`, or `MOOV_SANDBOX_*`.

---

## 2. Exact production Moov routes added

Dark handlers, unreachable while holds remain on (`runProductionMoovHandler` returns `null`):

| Method / path | Handler | HTTP to Moov when holds eventually lift |
| --- | --- | --- |
| `POST /functions/v1/moov-transfer-create` | persist-before-HTTP create | POST `/accounts/{facilitator}/transfers` only after CAS claim |
| `POST /functions/v1/moov-disburse` | alias of transfer-create | same |
| `POST /functions/v1/moov-transfer-status` | poll / reconcile | GET transfer; never POST |
| `POST /functions/v1/moov-readiness` | account / capabilities / banks GET | GET only; refuses `create_account` / `accept_tos` / `add_bank` / `request_capability` |
| `POST /webhooks/moov` (existing) | receipt + dark production apply | none |
| `POST /financial/moov-dual-control` | record approval | none |

Sandbox/UAT parity continues to own these names when production holds are off.

---

## 3. Secret contract correction

Inventory now matches current production Edge code. **The secret was not created.**

| Name | Inventory (M2) | Inventory (M3) |
| --- | --- | --- |
| `MOOV_PUBLIC_KEY` | listed | required |
| `MOOV_SECRET_KEY` | listed | required |
| `MOOV_PLATFORM_ACCOUNT_ID` | **missing** | **required facilitator** |
| `MOOV_WEBHOOK_SECRET` | listed | required |
| `MOOV_ENVIRONMENT` | listed | must equal `production` |
| `MOOV_ALLOWED_ORIGIN` | **missing** | **required** `https://checksops.com` |
| `MOOV_ACCOUNT_ID` | wrongly inventoried | **removed**; refused as facilitator |

`MOOV_SANDBOX_*` and `AWS_MOOV_WEBHOOK_SECRET` cannot satisfy production. Equal values across sandbox and production names → `sandbox_credential_contamination` before HTTP. Tenant Moov account IDs continue to come from `payment_provider_accounts.provider_account_id`.

Live deployed Lambda still reports `MOOV_ACCOUNT_ID_configured` until this branch is deployed. After deploy the boolean names change; values stay **false / MISSING**.

---

## 4. Execution hold implementation

Authoritative predicate in `productionMoovExecutionAllowed()`:

```
executionAllowed('moov')
AND financialPermissionsActivated()
AND NOT providerSandboxExecutionEnabled()
```

That is `AWS_PROVIDER_EXECUTION_ENABLED && AWS_MOOV_ENABLED && AWS_FINANCIAL_PERMISSIONS_ACTIVATED` and sandbox off.

| Combination | Result |
| --- | --- |
| all false | handler returns `null`; no provider HTTP |
| provider on, financial false | no HTTP |
| financial on, provider false | no HTTP |
| production holds + sandbox both on | `409 ambiguous_execution_mode` |
| missing production secret | `503 production_secret_missing` before HTTP |
| sandbox credential contamination | `503` before HTTP |

All production provider HTTP goes through `productionMoovFetch` after this gate. `moov-disburse` is the same handler as transfer-create; there is no bypass.

Current flag **values were not changed**.

---

## 5. Server authz implementation

Port of CheckAlt: Cognito `sub` → `identity_accounts.application_user_id` → `tenant_users` membership of the **transfer tenant** → owner/admin/manager (`FINANCIAL_ROLES`) → server-loaded `payment_transfers` → server-loaded recipient / payment methods / amount_cents → TOTP or dual-control → holds → HTTP.

Browser may supply `payment_transfer_id` as a lookup only. Rejected as authority:

- `tenant_id` / `user_id`
- `amount_cents` and other amount fields
- recipient / destination bank / payment method ids
- `moov_account_id` / `platform_account_id` / provider account ids

Cross-tenant resource IDs fail `403 cross_tenant_denied`. `canExecuteProduction` stays **false**; execution uses `canExecuteProductionMoov` only.

---

## 6. TOTP / step-up implementation

Action key: `disbursement.send`  
Bound to: `application_user_id`, `tenant_id`, `payment_transfers.id`, `amount_cents`

Load from `financial_stepup_log` with `succeeded IS TRUE`, TTL 30 minutes, metadata `payment_transfer_id`/`resource_id` and `amount_cents`. A TOTP for another transfer or a different amount does not authorize. Dual-control (`moov.dual_control`) is a distinct owner/admin/manager, same binding; recording it does not POST. RLS / step-up log writes were not weakened.

---

## 7. Durable transfer-intent design

Required lifecycle:

1. Validate resource / authz / step-up / secrets / rail  
2. Locate existing `payment_transfers` intent (`id` lookup; unique `(tenant_id, idempotency_key)`)  
3. Derive stable ChecksOps idempotency key from tenant + transfer id + amount + destination method  
4. Persist queued intent (`environment='production'`)  
5. `COMMIT`  
6. CAS claim `provider_http_attempted_at`  
7. Only the claimant POSTs  
8. Persist `provider_transfer_id`  
9. Retry → reconcile, never a second POST

Reserved schema (`72_moov_production_intent.sql`, **not applied**): `provider_http_attempted_at`, `failure_class`, `last_error`. Existing unique keys are reused. No GRANTs.

---

## 8. CAS / one-claimant behavior

```
UPDATE payment_transfers
   SET status = 'submitting', provider_http_attempted_at = now()
 WHERE id = $1
   AND environment = 'production'
   AND provider = 'moov'
   AND provider_http_attempted_at IS NULL
   AND provider_transfer_id IS NULL
   AND status IN ('queued', 'draft', 'submitting')
```

Double-click and simultaneous Lambda requests: one `RETURNING` row. The loser reconciles or returns `409 duplicate_in_flight`. No second POST.

---

## 9. Unknown-outcome behavior

Once `provider_http_attempted_at` is set, retry **never POSTs**.

| Case | Behavior |
| --- | --- |
| Moov accepts, Lambda times out | `failure_class=provider_timeout`; retry GET/reconcile |
| Moov accepts, RDS update fails | `failure_class=db_after_provider`; retry reconciles |
| HTTP may have occurred, no `provider_transfer_id` | `reconciliation_required`; **do not POST** unless a future GET can prove no transfer exists |
| Webhook before API response | receipt only; `applied=false`; cannot create a transfer |
| Poll before provider id persistence | local status only; no POST |

Prefer duplicate-money avoidance over a second create.

---

## 10. Provider idempotency behavior

Moov `X-Idempotency-Key` = durable `payment_transfers.id` UUID (`providerIdempotencyKeyFromIntent`). It is not regenerated on retry. Fixture tests prove the same intent always produces the same key. No production Moov HTTP.

---

## 11. Webhook dark-mode behavior

`PRODUCTION_MOOV_WEBHOOK_APPLY_ENABLED = false`.

On `POST /webhooks/moov`: verify HMAC, parse, persist idempotent receipt, derive identifiers, log a reconciliation candidate. If the mapped transfer/account `environment` is **exactly** `production`, overwrite apply to `applied=false`. Missing environment is **not** treated as production (sandbox apply tests keep `applied: true` when sandbox execution is on). Invalid signature → 401. Duplicate `external_event_id` → no second apply. Out-of-order incoming status is recorded, not applied. Webhook cannot create a transfer.

---

## 12. Legacy Lovable inventory

Machine-readable: `aws/financial/results/moov_m3_legacy_lovable_inventory.json`. **No Lovable mutations.**

| Path | Money capable | `MOOV_ENABLED` | Internal bypass | Severity |
| --- | --- | --- | --- | --- |
| `moov-transfer-create` | yes | yes | no | HIGH |
| **`moov-disburse`** | yes | skipped when internal | **`x-checksops-internal` = service role** | **CRITICAL** |
| `initiate-wallet-funding` | yes | yes | no | HIGH |
| `calculate-payment-funding` | no | no | no | LOW |
| `process-funded-payment` | yes | n/a | calls disburse internal | CRITICAL |
| `moov-webhook` | yes | no | no | HIGH |
| fee / sweep / wallet-fund / homeowner-deductible-pay | yes | yes | no | MEDIUM–HIGH |
| recipient / onboarding | onboarding HTTP | yes | no | MEDIUM |

Lovable remains the live production money path. Do not disable it in M3.

---

## 13. Test results

| Suite | Result |
| --- | --- |
| `api-moov-production.test.mjs` + CheckAlt / providers / sandbox / financial / provider-gates | **119 / 119 pass** |
| Full `aws/tests/*.test.mjs` | 476 pass, 3 skip, **1 fail unrelated**: `frontend-totp-enroll.test.mjs` missing package `qrcode` |

Matrix covered:

- **A** unauthenticated, unmapped Cognito, unresolved UUID, cross-tenant, unauthorized role, spoofed tenant/amount/recipient/Moov account, stale/missing TOTP, TOTP for another transfer/amount  
- **B** all flags false, incomplete combinations, 409 ambiguity, missing secret, sandbox contamination  
- **C** double submit, simultaneous claim, timeout after possible POST, RDS-after-provider, poll before provider id, stable provider key  
- **D** Freedom ↛ C1C and C1C ↛ Freedom  
- **E** invalid signature, duplicate event, out-of-order, webhook cannot create, `applied=false`

Logs: `/opt/cursor/artifacts/m3_related_api_tests.log`, `/opt/cursor/artifacts/m3_aws_api_tests.log`.

---

## 14. Financial before / after reconciliation

M3 tests did not write live RDS. Isolated fixture rows only.

| Metric | Before | After |
| --- | --- | --- |
| `payment_transfers` | 0 | 0 |
| `payment_transfers_amount_cents` | 0 | 0 |
| `disbursement_splits` / amount | 108 / 822212.97 | unchanged |
| `disbursement_batches` / check amount | 109 / 829768.914 | unchanged |
| `check_intake_items` / amount | 182 / 1317000.53 | unchanged |
| `checkalt_deposits` / amount | 58 / 380333.17 | unchanged |
| `homeowner_ledger_events` / amount | 657 / 2977337.23 | unchanged |

Delta: **zero**. `64_financial_activation_grants.sql` not applied. Production provider objects not altered.

---

## 15. Production flags before / after

| Flag | M2 live | M3 live |
| --- | --- | --- |
| `AWS_PROVIDER_EXECUTION_ENABLED` | false | **false** |
| `AWS_MOOV_ENABLED` | false | **false** |
| `AWS_FINANCIAL_PERMISSIONS_ACTIVATED` | false | **false** |
| `AWS_PROVIDER_LIVE_READS_ENABLED` | false | **false** |
| `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED` | staging true / prod-prep n/a | **unchanged** |
| `AWS_PROVIDER_WEBHOOK_DRY_RUN` | true | **true** |

Templates (`aws/template.yaml`, `aws/production/api-cfn.yaml`) still `"false"`.

---

## 16. Production secret before / after

| Surface | Before | After |
| --- | --- | --- |
| Production-prep `PROVIDER_SECRETS_ARN` | unset | **unset** |
| Production Moov names | MISSING | **MISSING** (not created) |
| Staging production names | MISSING | **MISSING** |
| Staging `MOOV_SANDBOX_*` | PRESENT | **PRESENT** (untouched) |

No sandbox value was copied into a production name.

---

## 17. Provider HTTP call count

| Kind | Count |
| --- | --- |
| Live Moov production HTTP | **0** |
| Live Moov sandbox HTTP (this phase) | **0** |
| Fixture/mock POST inside tests (holds lifted in-process only) | used for idempotency proofs only |

---

## 18. Money movement

**Zero.** No real transfer. No ACH. No wallet fund. No fee/sweep. Webhook not redirected.

---

## 19. Remaining blockers for M3b

M3b is **authorized read-only live Freedom GET** (still no POST, no secret creation by the agent, no flag flip for money).

1. Production secret `checksops/production/providers` **does not exist**. A human must create names only; do not copy `MOOV_SANDBOX_*`.  
2. Production-prep `PROVIDER_SECRETS_ARN` remains unset.  
3. Dark read handlers share `productionMoovExecutionAllowed()`. A GET-only gate (`AWS_PROVIDER_LIVE_READS_ENABLED` without money flags) is **not** wired — live GET cannot run without lifting money holds (forbidden) or adding that split.  
4. Freedom live KYC / wallet / bank / ACH capability remains **UNKNOWN** (M2).  
5. `72_moov_production_intent.sql` is not applied (needed before first POST, not for GET).  
6. Legacy Lovable `moov-disburse` internal bypass remains **CRITICAL**.  
7. Unknown outcome without `provider_transfer_id` cannot yet GET-by-idempotency-key to prove “no transfer exists”.  
8. Do not use C1C as first-test destination.

---

## 20. GO / NO-GO

| Decision | Verdict |
| --- | --- |
| M3 dark implementation | **PASS / GO for review** |
| M3b authorized read-only provider verification | **NO-GO** until a human creates the production secret **and** authorizes a GET-only path that cannot POST |
| Production activation / first transfer / webhook redirect / Lovable shutdown | **NO-GO** |

**STOP. Do not proceed automatically to M3b. Do not create secrets. Do not activate production. Do not move money.**
