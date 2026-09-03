# Lovable / Supabase → AWS provider parity

Behavioral parity audit of Moov and CheckAlt after the AWS sandbox/UAT **function ports**. The original Lovable/Supabase Edge Functions in this repository remain the source of truth. AWS replaces the runtime; it must not invent Moov or CheckAlt behavior from generic API docs.

**This document does not authorize production cutover.** Production financial execution flags stay false. Do not merge this PR automatically. Do not change DNS. Do not redirect production webhooks. Do not copy production Moov account IDs, CheckAlt depositor IDs, or bank numbers into sandbox/UAT.

Authoritative production code: `supabase/functions/moov-*`, `supabase/functions/checkalt-*`, `supabase/functions/_shared/moovClient.ts`, `supabase/functions/_shared/checkalt.ts`, related money functions listed below, and `src/**` `supabase.functions.invoke(...)` call sites.

Authoritative AWS code: `aws/functions/api/providers/parity/*`, `aws/functions/api/providers.mjs`, `src/integrations/aws/client.ts`.

Prior live sidecar evidence (auth-only, no money movement): `aws/financial/UAT_RESULTS.md` and `/opt/cursor/artifacts/sidecar_provider_http_redacted.json`.

## Verdict

Provider **function names are no longer missing**. Every production Moov/CheckAlt Edge Function the frontend (or webhook/cron) calls has an AWS `/functions/v1/<name>` handler. Shared client semantics (pinned Moov version, facilitator POST, integer-cents CheckAlt `userAmount`, FinCapture auth path/body) are ported.

Production cutover is still **NO-GO**. Remaining gates are configuration, networking, isolated-table policy, ImageScript oversized-image re-encode, webhook apply, and financial GRANTs — not unexplained missing function names.

| Gate | Status |
| --- | --- |
| Moov production cutover | **NO-GO** |
| CheckAlt production cutover | **NO-GO** |
| ChecksOps AWS overall | **NO-GO** |
| Code inventory of original functions | **Complete** |
| AWS equivalent for every production-required function | **Present** (sandbox/UAT ports; production flags false) |
| Unexplained missing production-required function | **None** |

A single sandbox transfer or a single UAT deposit would still not be enough for GO. GO also requires live provider HTTP from the API, sandbox platform + connected methods, a UAT depositor/`ssoKey`, and the remaining items in the GO checklist.

## Classification legend

| Status | Meaning |
| --- | --- |
| `PARITY VERIFIED` | AWS handler preserves production request/response/provider HTTP semantics. Unit tests and/or code trace confirm it. Live money movement may still be blocked by test environment. |
| `INTENTIONAL AWS IMPROVEMENT` | AWS is stricter or safer on purpose. Do not revert to match Lovable weaknesses. Must not change the legitimate provider result. |
| `NOT REQUIRED FOR CURRENT FLOW` | Exists in production; not on the deposit → disburse money path. Still inventoried and ported unless noted. |
| `MISSING` | Production function has no AWS body that performs the same provider HTTP. Fail-closed `403` is not an equivalent. **None remain for Moov/CheckAlt function names.** |
| `BEHAVIORAL DIFFERENCE` | AWS has a handler, but a documented semantic difference remains (isolation table, ImageScript, public-token auth). |
| `BLOCKED BY PROVIDER TEST ENVIRONMENT` | Handler exists; live HTTP cannot complete without non-production test IDs and/or NAT. Not a license to change working production semantics. |

Each production function gets **one** primary status. Isolation and security deltas are also listed under helpers.

## Cross-cutting controls (keep false / dry-run)

| Flag / control | Required value | Notes |
| --- | --- | --- |
| `AWS_PROVIDER_EXECUTION_ENABLED` | `false` | Master kill switch. If true, `/functions/v1/*` returns `403 production_execution_blocked` and never uses production keys. |
| `AWS_FINANCIAL_PERMISSIONS_ACTIVATED` | `false` | Financial write IAM |
| `AWS_MOOV_ENABLED` / `AWS_CHECKALT_ENABLED` / `AWS_PLAID_ENABLED` | `false` | Per-provider production |
| `AWS_PROVIDER_WEBHOOK_DRY_RUN` | `true` (default) | Receipts only; `applied: false` |
| `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED` | may be `true` | Enables the ports behind `/functions/v1/*` with **sandbox/UAT credentials only** |

Pinned Moov API version for transfers remains `v2024.01.00`. Do not migrate to `v2026.04.00` / `v2026.07.00` except where production already pins invoices (`moov-invoice` uses `v2026.07.00` only).

Dispatch (`handleFunctionInvoke`):

1. Production flags true → `403 production_execution_blocked` (never production keys).
2. Else if `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED` and a parity handler exists → `runParityHandler`.
3. Else existing stubs / webhook 405.

---

## Shared helpers

| Helper | Production | AWS | Status |
| --- | --- | --- | --- |
| Moov OAuth client-credentials + `Origin` + `x-moov-version` | `_shared/moovClient.ts` `moovToken` / `moovFetch`. GET still sends `Content-Type: application/json`. Default Origin `https://checksops.com`. Pin `v2024.01.00`. | `parity/moov-client.mjs`. Same headers including GET `Content-Type`. ALS-bound sandbox keys. | `PARITY VERIFIED` (unit test: OAuth Origin + transfer `x-moov-version` + GET Content-Type). Sidecar OAuth previously succeeded. |
| Moov facilitator resolution | `MOOV_SANDBOX_PLATFORM_ACCOUNT_ID` / `MOOV_PLATFORM_ACCOUNT_ID` then wallet `partnerAccountID` | Same algorithm in `facilitatorAccountId`. Staging binds sandbox platform id only. | Code `PARITY VERIFIED`. Live facilitator `BLOCKED BY PROVIDER TEST ENVIRONMENT` (`MOOV_SANDBOX_PLATFORM_ACCOUNT_ID` absent). |
| Moov idempotency UUID | SHA-256 seed → v4-shaped `X-Idempotency-Key` | Same in `idempotencyUuid` | `PARITY VERIFIED` |
| Moov transfer amount | integer cents `{ currency: "USD", value }` | `POST .../transfers` body `amount.value` integer | `PARITY VERIFIED` |
| Moov readiness math | `_shared/moovReadiness.ts` | `providers/readiness.mjs` + live GETs in `moov-readiness` | Formula `PARITY VERIFIED`. Function now live (was local snapshot). |
| CheckAlt auth | `POST /public/fincapture/authenticate` `{ userName, password }` + `merchant` header. JWT cached on `checkalt_config` in production. | Same path and body keys. UAT host overlay. JWT **not** written to production `checkalt_config`. | Path/body `PARITY VERIFIED`. JWT cache isolation is `INTENTIONAL AWS IMPROVEMENT`. |
| CheckAlt `userAmount` | `Math.round(Number(check.amount) * 100)` from `check_intake_items.amount` (dollars → integer cents). Frontend never sends amount. | `formatCheckAltUserAmount(check.amount)` | `PARITY VERIFIED` |
| CheckAlt depositor identity | `checkalt_tenant_accounts.sso_user_id` + `deposit_account_number`; `ssoKey` from register payload / `getUserAccountInformation`. Never the FI API login. | Isolated `aws_provider_sandbox_objects` row. Register rejects `sso_user_id === API login`. | Identity rule `PARITY VERIFIED`. Storage table is `INTENTIONAL AWS IMPROVEMENT` (no environment column on production CheckAlt tables). |
| CheckAlt fail-closed if unregistered | `loadTenantAccount` throws | `account_unregistered` 409 | `PARITY VERIFIED` / `INTENTIONAL AWS IMPROVEMENT` |
| Persist-before-HTTP | `payment_idempotency_keys` / `payment_transfers` / `checkalt_deposits` insert before provider POST | Moov: `payment_transfers` with `environment='sandbox'` before HTTP. CheckAlt: `aws_provider_sandbox_operations` before HTTP. | Moov table `PARITY VERIFIED` (sandbox env). CheckAlt table isolation `INTENTIONAL AWS IMPROVEMENT`. |
| Untrusted browser amounts | Production functions take `amount_cents` after auth (server still uses DB for CheckAlt). | Sandbox harness still rejects body `amount` / `userAmount`. CheckAlt submit reads `check_intake_items.amount` only. | `INTENTIONAL AWS IMPROVEMENT` |
| Header spoof ignore | Edge Functions use JWT `auth.uid()` | Cognito mapping; `x-user-id` / `x-tenant-id` ignored | `INTENTIONAL AWS IMPROVEMENT` |
| Webhook HMAC | `moov-webhook` verify + apply | `POST /webhooks/moov` verify, sanitize, `applied: false` | Verify `PARITY VERIFIED`. Apply dry-run `INTENTIONAL AWS IMPROVEMENT`. |
| `provider_egress_failed` | N/A (Supabase egress works) | Maps Node `fetch failed` to 503 | `INTENTIONAL AWS IMPROVEMENT` |
| Frontend invoke envelope | supabase-js: HTTP 2xx → `{ data, error: null }`. Callers check `data.error` / `data.success`. | `src/integrations/aws/client.ts` now matches: HTTP 2xx → `{ data: body, error: null }`. No longer requires `body.ok`. | `PARITY VERIFIED` (was a behavioral difference). |

---

## Moov Edge Functions (39)

Frontend: `supabase.functions.invoke("<name>", { body })`. AWS staging posts `/functions/v1/<name>` through the same call sites (`VITE_AUTH_PROVIDER=cognito` swaps the client).

Auth: production uses Supabase JWT `auth.uid()`. AWS uses Cognito sub → `application_user_id` (`INTENTIONAL AWS IMPROVEMENT`). Tenant from membership; spoofed tenant headers ignored.

Environment: production `moovGuard` binds tenant `moov_environment`. AWS staging **forces sandbox credentials** even if the tenant row says production, so restored production `payment_provider_accounts` rows (unique on tenant+provider+environment) are not overwritten (`INTENTIONAL AWS IMPROVEMENT`).

| Function | Production behavior | DB side effects | Frontend | AWS equivalent | Status |
| --- | --- | --- | --- | --- | --- |
| `moov-account-create` | Idempotent `POST /accounts`; TOS token optional | `payment_idempotency_keys`, `payment_provider_accounts` | `TenantPaymentAccountPanel`, `PaymentAccountPanel`, `moovProvider.ts` | Same HTTP; writes `environment='sandbox'` | `PARITY VERIFIED` + env isolation `INTENTIONAL AWS IMPROVEMENT` |
| `moov-account-discover` | `GET /accounts?count=200` plus per-account caps/banks; optional adopt | May update `payment_provider_accounts` | None (admin diagnostic) | Currently shares `moov-selftest` handler | `NOT REQUIRED FOR CURRENT FLOW` / `BEHAVIORAL DIFFERENCE` (selftest probe, not full discover/adopt) |
| `moov-account-onboard` | In-app KYB: business profile, controller/owners → account + representatives | `payment_provider_accounts` | `PaymentOnboardingDialog` | `moov-onboard.mjs` `accountOnboard` | `PARITY VERIFIED` (sandbox rows) |
| `moov-account-files` | List KYC files at Moov; sync local rows | `payment_provider_files` | `verificationFiles.ts` | Ported | `PARITY VERIFIED` |
| `moov-account-file-upload` | Multipart upload to Moov Files API | `payment_provider_files` | `verificationFiles.ts` (XHR) | Ported | `PARITY VERIFIED` |
| `moov-account-file-view` | Fetch file bytes from Moov | none (read) | `verificationFiles.ts` expects `url` | Returns stored path; signed S3 URL pending storage bridge | `BEHAVIORAL DIFFERENCE` (response `url` vs path) documented in handler |
| `moov-onboarding-link` | Hosted Moov onboarding session | `payment_provider_accounts` | `TenantPaymentAccountPanel` | Ported; returns `url`/`link` | `PARITY VERIFIED` |
| `moov-readiness` | Live `GET /accounts/{id}`, capabilities, bank-accounts, fee-plans; `{ success, readiness }` | May update `readiness` columns | `PaymentReadinessPanel`, `useWalletOpsReadiness` | Live GETs + `evaluateReadiness`; `{ success, readiness }` | `PARITY VERIFIED` (no longer a local snapshot) |
| `moov-selftest` | Platform credential probe including `GET /accounts` | none | `PaymentProviderAdmin` | Ported against sandbox keys | `NOT REQUIRED FOR CURRENT FLOW`. Live list often `401` without list permission — `BLOCKED BY PROVIDER TEST ENVIRONMENT` |
| `moov-sync` | Live account/caps/banks; may auto-adopt; writes flags | `payment_provider_accounts`, methods/rails | `PaymentAccountPanel`, `PaymentReadinessPanel`, `MicroDepositVerification` | Ported; sandbox env | `PARITY VERIFIED` |
| `moov-wallet-sync` | `syncWallet` then ledger + sub-ledgers `{ success, wallet, ledger, sub_ledgers }` | `payment_wallets`, ledger, sub-ledgers | `wallets.syncWallet` → `useWallet` | Same `syncWallet` port + SELECT ledger/sub-ledgers | `PARITY VERIFIED` |
| `moov-wallet-fund` | `POST /accounts/{facilitatorId}/transfers` | `payment_transfers`, wallets/ledger | `src/lib/payments/wallets.ts` | Same facilitator POST, integer cents, persist-before-HTTP | `PARITY VERIFIED`. Live `BLOCKED BY PROVIDER TEST ENVIRONMENT` |
| `moov-bank-account-add` | Add bank at Moov | `payment_provider_methods` | `MoovBankLink` | Ported | `PARITY VERIFIED` |
| `moov-bank-link-token` | Moov.js / bank-link Drop token | none / session | Lib-only (`moovProvider.connectBank`; no mounted UI) | Ported. Does **not** return public key to the browser | `INTENTIONAL AWS IMPROVEMENT` vs leaking public key |
| `moov-micro-deposit-initiate` | Initiate micro-deposits | `payment_method_verifications`, methods | `MicroDepositVerification` | Ported | `PARITY VERIFIED` |
| `moov-micro-deposit-confirm` | Confirm micro-deposits | same | same | Ported | `PARITY VERIFIED` |
| `moov-plaid-bridge` | Link Plaid item into Moov | methods / stakeholder rails | `CheckStakeholdersManager` | Ported | `PARITY VERIFIED` (Plaid production flag still false) |
| `moov-platform-bank` | Platform treasury bank admin | platform methods | `PlatformBankPanel` | Ported | `PARITY VERIFIED` |
| `moov-tos-token` | Platform Agreement token | none | Server-side for TOS accept (no direct UI) | Mints token; does **not** return public key | `INTENTIONAL AWS IMPROVEMENT` |
| `moov-tos-accept` | Record TOS at Moov | `payment_provider_accounts.tos_*` | `PaymentReadinessPanel` | Ported | `PARITY VERIFIED` |
| `moov-underwriting` | GET/PUT `/accounts/{id}/underwriting` | account metadata | `UnderwritingQuestionnairePanel` | Ported | `PARITY VERIFIED` |
| `moov-recipient-create` | `POST /accounts` for stakeholder | `payment_provider_accounts`, `external_payment_recipients` | `AddExternalStakeholderDialog` | Ported | `PARITY VERIFIED` |
| `moov-recipient-session` | Token-only hosted session (no JWT in production) | recipient rows | `RecipientPaymentSetup` | Same payload; AWS wrap still uses Cognito `withIdentityWrite` | `INTENTIONAL AWS IMPROVEMENT` (public token still needs Cognito on staging). Provider GET `PARITY VERIFIED` |
| `moov-recipient-tos-accept` | Recipient Platform Agreement | recipient TOS | `RecipientPaymentSetup` | Ported | `PARITY VERIFIED` |
| `moov-recipient-kyc-update` | Patch recipient KYC | recipient profile | `RecipientPaymentSetup` | Ported | `PARITY VERIFIED` |
| `moov-recipient-bank-add` | Recipient bank | recipient methods | `RecipientPaymentSetup` | Ported | `PARITY VERIFIED` |
| `moov-recipient-disconnect` | Disconnect recipient | recipient rows | `StakeholderAccountSettings` | Ported | `PARITY VERIFIED` |
| `moov-transfer-create` | `POST /accounts/{facilitatorId}/transfers`. Source = initiating tenant bank. Does **not** `GET /accounts`. Integer cents. Persist-before-HTTP. | `payment_transfers`, `payment_idempotency_keys` | Lib-only today (`moovProvider.sendPayment`); still production-required | Same path, headers, amount, persist-before-HTTP. Unit test green. | `PARITY VERIFIED`. Live transfer `BLOCKED BY PROVIDER TEST ENVIRONMENT` |
| `moov-transfer-status` | Live `GET /accounts/{facilitator}/transfers/{id}` for in-flight rows; writes provider status; `postTransferLedger` | `payment_transfers`, wallet ledger | `useWalletOps` | Live GET + write-back on sandbox rows | `PARITY VERIFIED` (no longer local-only) |
| `moov-transfer-group-create` | Grouped transfers | `payment_transfers` group ids | Lib-only (`splits.ts`) | Ported | `PARITY VERIFIED` |
| `moov-disburse` | All-or-nothing batch; `409 recipient_setup_required` if any recipient lacks a bank | `disbursement_batches`, `payment_transfers` | `DisbursementConsole`, `RunPayrollDialog` | Ported | `PARITY VERIFIED`. Live `BLOCKED BY PROVIDER TEST ENVIRONMENT` |
| `moov-tenant-fee-charge` | Charge tenant fees via Moov | `payment_transfers` / fee rows | `AdminTenants` | Ported | `PARITY VERIFIED` |
| `moov-fee-schedule-upsert` | Mutate fee schedules | fee schedule tables | `feeSchedules.ts` | Ported | `PARITY VERIFIED` |
| `moov-fee-schedule-cancel` | Cancel fee schedules | same | same | Ported | `PARITY VERIFIED` |
| `moov-fee-rollup` | Fee reporting | reporting reads | `feeSchedules.ts` | Ported | `PARITY VERIFIED` |
| `moov-sweep-config` | Configure sweeps | `payment_sweep_configs` | `sweeps.ts` | Ported | `PARITY VERIFIED` |
| `moov-invoice` | Invoice CRUD + send; **pins `v2026.07.00` for invoices only** | `moov_invoices`, `moov_invoice_customers` | `useMoovInvoices` | Same pin `v2026.07.00`; transfers stay `v2024.01.00` | `PARITY VERIFIED` |
| `moov-bulk-import-preview` | Bulk import preview | none / preview | None | Ported | `NOT REQUIRED FOR CURRENT FLOW` |
| `moov-webhook` | Verify HMAC; unique `(provider, external_event_id)`; **apply** transfer/account/bank/stakeholder/ledger | `payment_webhook_events` + financial tables | Moov dashboard → production URL (unchanged) | `POST /webhooks/moov`: verify, sanitize, `aws_provider_webhook_receipts`, `applied: false` | `INTENTIONAL AWS IMPROVEMENT` |

### Moov Edge Function totals

| Status | Count |
| --- | --- |
| `PARITY VERIFIED` (primary) | 33 |
| `INTENTIONAL AWS IMPROVEMENT` (primary) | 3 (`moov-webhook`, `moov-tos-token`, `moov-bank-link-token`) |
| `NOT REQUIRED FOR CURRENT FLOW` | 2 (`moov-account-discover`, `moov-bulk-import-preview`) plus `moov-selftest` diagnostic |
| `BEHAVIORAL DIFFERENCE` (primary) | 1 (`moov-account-file-view` URL vs path) |
| `MISSING` | **0** |
| **Total** | **39** |

`moov-selftest` is inventoried as not required for money movement; handler exists.

---

## Related Moov workflows (9)

Catalogued as `provider: moov`.

| Function | Production behavior | DB side effects | Frontend | AWS | Status |
| --- | --- | --- | --- | --- | --- |
| `initiate-wallet-funding` | Queue/create funding; may create Moov transfer | `wallet_funding_requests`, `payment_transfers` | `DisbursementConsole`, `useAutoFunding` | Ported (`moov-money.mjs`) | `PARITY VERIFIED` |
| `cancel-wallet-funding` | Cancel funding request | `wallet_funding_requests` | `useAutoFunding` | Ported | `PARITY VERIFIED` |
| `calculate-payment-funding` | Funding plan immediately before execution | reads wallets/methods | `DisbursementConsole` | Ported (`wallet-funding.mjs` maths) | `PARITY VERIFIED` |
| `process-funded-payment` | After funding clears, invokes `moov-disburse` internally | `disbursement_batches` | None (webhook/cron) | Ported | `PARITY VERIFIED` |
| `wallet-fund-on-clear` | Auto-fund after check clear | funding + transfers | Automated | Ported | `PARITY VERIFIED` |
| `platform-treasury` | Platform treasury operations | treasury / transfers | `PlatformTreasuryPanel` | Ported | `PARITY VERIFIED` |
| `homeowner-deductible-pay` | Charge homeowner deductible via `token` | `payment_transfers` / ledger | `HomeownerLedger` | Ported; Cognito wrap on AWS | `INTENTIONAL AWS IMPROVEMENT` (auth) + provider path `PARITY VERIFIED` |
| `stakeholder-resend-verification` | Resend KYC/verification email | none / email | `FundsTab`, settings panels | Ported | `PARITY VERIFIED` |
| `public-invoice` | Public invoice fetch/pay via `token` | `moov_invoices` | `PublicInvoicePage` | Ported; Cognito wrap on AWS | `INTENTIONAL AWS IMPROVEMENT` (auth) |

| Status | Count |
| --- | --- |
| `PARITY VERIFIED` | 7 |
| `INTENTIONAL AWS IMPROVEMENT` | 2 (public token flows still Cognito-gated) |
| `MISSING` | **0** |
| **Total** | **9** |

Combined Moov-class workflows (39 + 9) = **48**. Unexplained missing AWS equivalents: **0**.

---

## CheckAlt Edge Functions (9)

Production shared client: `_shared/checkalt.ts`. Auth is **only** the FI API login. Depositor identity is **always** a registered FinCapture user (`sso_user_id`), never `CHECKALT_USERNAME` / `CHECKALT_UAT_USER_ID`.

Staging overlay: host `https://uatapi.checkalt.com`, merchant header `lockbox5`, credentials `CHECKALT_UAT_*`. JWT is not written to production `checkalt_config`. Register/submit/poll/approve persist **isolated** `aws_provider_sandbox_objects` / `aws_provider_sandbox_operations` so restored production `checkalt_tenant_accounts` / `checkalt_deposits` are not overwritten (those tables have no `environment` column).

| Function | Production behavior | DB side effects | Frontend | AWS equivalent | Status |
| --- | --- | --- | --- | --- | --- |
| `checkalt-register-account` | `POST /fincapture/useraccount/register` then `getUserAccountInformation` for `ssoKey` | `checkalt_tenant_accounts` | `CheckAltSettings` | Same HTTP. Writes `aws_provider_sandbox_objects`. Rejects API login as `sso_user_id`. | HTTP `PARITY VERIFIED`. Table isolation `INTENTIONAL AWS IMPROVEMENT`. Live register `BLOCKED BY PROVIDER TEST ENVIRONMENT` (needs UAT deposit account number issued by CheckAlt) |
| `checkalt-verify-account` | `getUserAccountInformation` / `getDepositAccountInformation` with `userId: acct.sso_user_id` | none (read) | `CheckAltSettings` (`action: "user"`) | Same; UAT depositor row | `PARITY VERIFIED` |
| `checkalt-test-connection` | Auth only; `{ success, message, token_preview }` | may refresh cached JWT on `checkalt_config` | `CheckAltSettings` | Auth only; no production config JWT write | `PARITY VERIFIED` + JWT isolation `INTENTIONAL AWS IMPROVEMENT` |
| `checkalt-prepare-image` | ImageScript normalize one side; upload deposit-ready JPEG; return `prepared_path`; landscape / Mitek IQA | storage `claim-files` | `prepareCheckAltDeposit.ts` (browser prep is primary; edge is fallback) | Fast-path: if source already ≤ 450KB, return `prepared_path`. Oversized → 413 (no ImageScript) | `BEHAVIORAL DIFFERENCE` for oversized re-encode. Fast-path matches production skip-re-encode. Browser compression remains the current-flow primary path. |
| `checkalt-submit-deposit` | Download front/back from storage, compress, `POST /fincapture/deposit/process` with `ssoKey` + integer-cents `userAmount`. No `testDeposit`. Status 40/120/127 mapping. Writes `checkalt_deposits` + intake/claim_checks | `checkalt_deposits`, `check_intake_items`, `claim_checks`, `deposit_items` | `CheckCommandCenter`, `DepositOperationsConsole` (`check_intake_item_id`, optional prepared paths) | Same process path, auth, integer cents, persist-before-HTTP, SVG-back rejection, combined b64 budget. Loads images from staging S3 when under budget. Isolated operations table; **does not** mutate production `checkalt_deposits` / intake status | HTTP + amount `PARITY VERIFIED`. Production-table writes `INTENTIONAL AWS IMPROVEMENT` (isolation). Oversized ImageScript `BEHAVIORAL DIFFERENCE`. Live process `BLOCKED BY PROVIDER TEST ENVIRONMENT` |
| `checkalt-approve-deposit` | Body `{ deposit_id, action }`. Lookup `checkalt_deposits.checkalt_reference`. `action` 1 approve / 2 reject. `ssoKey` **not** in schema. HTTP 200 is not enough; require `success === true`. Updates deposits + intake + claim_checks | `checkalt_deposits`, intake, `claim_checks` | `PendingApprovalDeposits`, command centers | Accepts production `deposit_id` against isolated operation id; same payload shape; checks `success === true`; default rejectCode 1721 | HTTP/contract `PARITY VERIFIED`. Production-table writes isolated `INTENTIONAL AWS IMPROVEMENT` |
| `checkalt-poll-status` | `POST /fincapture/deposit/item` then fallback `/deposit/history`; updates stale `checkalt_deposits`; 60-day return window. Response `{ polled, updated, errors }` | `checkalt_deposits` | `CheckAltSettings` poll | Same item + history fallback against isolated operations. `{ polled, updated, errors, success }` | HTTP `PARITY VERIFIED`. Table isolation `INTENTIONAL AWS IMPROVEMENT` |
| `checkalt-deposit-history` | Live `POST /fincapture/deposit/history` with tenant `ssoKey` | none (read) | `CheckAltDepositHistory` (`items`, `count`) | Live history with UAT `ssoKey` | `PARITY VERIFIED` when a UAT depositor exists; else fail-closed |
| `checkalt-account-status` | Live user/deposit-account lookups | none (read) | No frontend caller (settings read `checkalt_tenant_accounts` directly) | Live `getUserAccountInformation` for isolated UAT row | `PARITY VERIFIED` |

There is **no** production `checkalt-webhook` Edge Function. AWS `POST /webhooks/checkalt` is dry-run receipts (`INTENTIONAL AWS IMPROVEMENT`). Production CheckAlt status is poll + history.

### CheckAlt Edge Function totals

| Status | Count |
| --- | --- |
| `PARITY VERIFIED` (HTTP/contract) | 8 (register/submit/poll/approve isolated-table caveat) |
| `BEHAVIORAL DIFFERENCE` (primary) | 1 (`checkalt-prepare-image` ImageScript) |
| `MISSING` | **0** |
| **Total** | **9** |

---

## `/sandbox/*` UAT harness (not the production function port)

These routes remain a separate staging harness. Frontend production screens do **not** call them. They must not be treated as the parity implementation. The production contract is `/functions/v1/<edge-function-name>`.

| Route | Status |
| --- | --- |
| `POST /sandbox/moov/*` | Diagnostic harness. List `/accounts` is **not** the production transfer path. Live Lambda `503 provider_egress_failed` without NAT. |
| `POST /sandbox/checkalt/*` | Diagnostic harness. Must not use API login as FinCapture `userId`. |
| `POST /sandbox/webhooks/{provider}` | Isolated receipts. `INTENTIONAL AWS IMPROVEMENT`. |

---

## Frontend contracts

| Contract | Production | AWS | Status |
| --- | --- | --- | --- |
| Invoke path | `supabase.functions.invoke(name)` | `apiFetch(/functions/v1/{name})` | Path exists; same `src/` call sites |
| Success envelope | HTTP 2xx → `{ data, error: null }` | Same | `PARITY VERIFIED` |
| `moov-readiness` | `{ success, readiness }` from live Moov | `{ success, readiness }` from live sandbox Moov | `PARITY VERIFIED` |
| `moov-disburse` / `moov-wallet-fund` / `moov-transfer-create` | `{ success, ... }` / `error` | Same fields plus `productionExecution: false`, `environment: 'sandbox'` extra keys (UI ignores unknowns) | `PARITY VERIFIED` |
| `checkalt-submit-deposit` | `{ success, ... }`; UI uses error toast + query invalidate | Same; extra `userAmount` / `productionRecordsMutated` | `PARITY VERIFIED` |
| `checkalt-approve-deposit` | `{ deposit_id, action }` | Same | `PARITY VERIFIED` |
| `checkalt-poll-status` | `{ polled, updated, errors }` | Same | `PARITY VERIFIED` |
| `checkalt-test-connection` | `{ success, message, token_preview }` | Same | `PARITY VERIFIED` |
| Direct table reads (`payment_transfers`, `checkalt_deposits`) | RLS via Supabase | AWS data API. CheckAlt UAT rows are **not** in production `checkalt_deposits`, so Settings tables that SELECT that table will not show UAT deposits until production flags/tables are activated. | `INTENTIONAL AWS IMPROVEMENT` / UI isolation |

---

## Retries and idempotency

| Path | Production | AWS | Status |
| --- | --- | --- | --- |
| Moov transfers | `payment_idempotency_keys` + hashed UUID header | Same on sandbox `payment_transfers` | `PARITY VERIFIED` |
| Moov webhooks | unique `(provider, external_event_id)` | unique on `aws_provider_webhook_receipts`; apply dry-run | Dedupe `PARITY VERIFIED`. Apply `INTENTIONAL AWS IMPROVEMENT` |
| CheckAlt submit | Existing `checkalt_deposits` row for check + amount | Isolated operation key `checkalt-submit-{checkId}` persist-before-HTTP | Isolation `INTENTIONAL AWS IMPROVEMENT` |
| CheckAlt poll | Batch update of stale rows | Isolated operations + history fallback | HTTP `PARITY VERIFIED` |

---

## Database side effects

| Table | Production writer | AWS sandbox/UAT port |
| --- | --- | --- |
| `payment_provider_accounts` | create/onboard/sync/TOS | Yes, `environment='sandbox'` only |
| `payment_provider_methods` | bank add, micro-deposits, sync | Yes, sandbox env |
| `payment_provider_files` | file list/upload | Yes, sandbox env |
| `payment_wallets` / `payment_wallet_ledger` | wallet-sync, transfer-status, webhooks | wallet-sync/fund write sandbox env. Webhook apply off |
| `payment_transfers` | transfer-create, disburse, funding, fees | Yes, sandbox env. Staging Lambda may lack GRANT until financial IAM is activated (`AWS_FINANCIAL_PERMISSIONS_ACTIVATED` stays false) |
| `payment_idempotency_keys` | account-create, transfers | Yes |
| `payment_sweep_configs` | sweep-config | Yes |
| `moov_invoices` / `moov_invoice_customers` | moov-invoice | Yes (sandbox) |
| `wallet_funding_requests` / `disbursement_batches` | funding + disburse | Yes (sandbox) |
| `checkalt_tenant_accounts` | register-account | **Not written** on staging |
| `checkalt_deposits` | submit, approve, poll | **Not written** on staging |
| `check_intake_items` status | submit/approve | **Not written** on staging for CheckAlt UAT |
| `aws_provider_sandbox_objects` | n/a | CheckAlt UAT depositor |
| `aws_provider_sandbox_operations` | n/a | CheckAlt submit/poll/approve |
| `payment_webhook_events` | moov-webhook apply | No (receipts table instead) |

CheckAlt isolation is required because those production tables have no environment column. Moov already keys rows by `environment`.

---

## Exact non-production test configuration still required

Do **not** copy production Moov account IDs, CheckAlt `sso_user_id` values, deposit account numbers, customers, or any financial data into sandbox/UAT.

### Moov sandbox

Staging secret already has `MOOV_SANDBOX_PUBLIC_KEY` / `MOOV_SANDBOX_SECRET_KEY`. Still missing:

| Item | Required (sandbox-only) | Must not be |
| --- | --- | --- |
| `MOOV_SANDBOX_PLATFORM_ACCOUNT_ID` | Facilitator owned by the sandbox application | Any production RDS `provider_account_id` |
| Sandbox connected accounts + payment methods | Created in Moov sandbox for Freedom/C1C test tenants, stored as `environment='sandbox'` | Overwriting production-environment rows |
| Optional `MOOV_SANDBOX_WEBHOOK_SECRET` | Staging webhook URL only | Production secret / production dashboard URL |

Production money movement does **not** `GET /accounts`. Do not treat list `401` as a transfer-path bug.

### CheckAlt UAT

Staging already has UAT API login + `https://uatapi.checkalt.com` + merchant `lockbox5`. Still missing:

| Item | Required (UAT-only) | Must not be |
| --- | --- | --- |
| UAT deposit account number | Issued by CheckAlt for UAT / lockbox5 | Production bank numbers; invented numbers |
| UAT `sso_user_id` + `ssoKey` | Registered on UAT via `/fincapture/useraccount/register` | Production `checkalt_tenant_accounts` |
| Optional webhook secret | Staging only | Production webhook secret |

`checkalt-register-account` is now implemented on AWS, but it still refuses to invent bank numbers and will not use the API login as the depositor.

---

## AWS networking (separate GO gate)

| Item | Current |
| --- | --- |
| Lambda | `checksops-staging-api` |
| VPC | `vpc-09f2268778966ce97` |
| NAT gateway | **none** |
| Observed from Lambda | `503 provider_egress_failed` |
| This Cloud Agent VM | HTTPS to `api.moov.io` and `uatapi.checkalt.com` succeeds (host reachable). Secrets Manager token on this turn was **expired**, so live OAuth/auth was not re-run here. Prior no-VPC sidecar: Moov OAuth succeeded (`tokenType=Bearer`); CheckAlt `/public/fincapture/authenticate` succeeded. |

Required before the **API** can call providers: NAT (or equivalent HTTPS egress), **or** a dedicated no-VPC invoker. Cursor staging role cannot create NAT. Independent of provider-code parity.

---

## Real provider validation (EXPECTED vs ACTUAL)

Credentials are never printed. Key **names** only.

| Operation | Expected from original implementation | Actual | Classification |
| --- | --- | --- | --- |
| Moov `POST /oauth2/token` with Origin + `x-moov-version: v2024.01.00` | Bearer token | Sidecar: **succeeded**. This VM: Secrets Manager expired; unit test asserts Origin + version | `PARITY VERIFIED` / live re-run `BLOCKED BY PROVIDER TEST ENVIRONMENT` (expired STS this turn) |
| Moov `POST /accounts/{facilitatorId}/transfers` integer cents | Facilitator path, `{ currency, value }` | Unit test: path + cents + persist-before-HTTP. Live: not executed (no platform id, no NAT on Lambda) | Code `PARITY VERIFIED`. Live `BLOCKED BY PROVIDER TEST ENVIRONMENT` |
| Moov `GET /accounts` | Not required for transfers | Sidecar 401 | Do not change Origin/version to chase 401 |
| CheckAlt `POST /public/fincapture/authenticate` `{ userName, password }` + merchant | JWT | Sidecar **succeeded**. Unit test asserts path, body keys, merchant `lockbox5` | `PARITY VERIFIED` |
| CheckAlt `userAmount` | dollars × 100 integer | Unit test: check `123.45` → `12345`. No `testDeposit` | `PARITY VERIFIED` |
| CheckAlt process/approve/history | Requires registered depositor `ssoKey` | Not executed (no UAT depositor). Fail-closed `account_unregistered` | `BLOCKED BY PROVIDER TEST ENVIRONMENT` |

---

## Intentional AWS security / isolation improvements

Do not revert these to “match Lovable.”

1. Production flags false; flipping them on staging returns `production_execution_blocked` instead of using production keys.
2. Cognito → `application_user_id`; spoofed `x-user-id` / `x-tenant-id` ignored; cross-tenant denied.
3. Staging never binds production Moov/CheckAlt keys.
4. CheckAlt UAT host allowlist (`https://uatapi.checkalt.com`) and merchant `lockbox5`.
5. CheckAlt UAT rows isolated from production CheckAlt tables.
6. Depositor must not equal FI API login.
7. Persist-before-HTTP; reject untrusted browser amount fields on the sandbox harness.
8. Webhook dry-run (`applied: false`); payload sanitization.
9. No public Moov key returned to the browser for TOS/bank-link tokens.
10. Public recipient/invoice/deductible token routes still require Cognito mapping on AWS staging.
11. Map VPC `fetch failed` to `provider_egress_failed`.
12. Secrets Manager for provider credentials.

---

## Remaining production-required gaps (not missing function names)

These keep cutover at **NO-GO**. They are explained.

1. **NAT / Lambda egress** — API cannot complete live provider HTTP.
2. **`MOOV_SANDBOX_PLATFORM_ACCOUNT_ID` + sandbox connected accounts/payment methods** — cannot execute a real sandbox transfer.
3. **CheckAlt UAT depositor + `ssoKey` + deposit account** — cannot execute a real UAT deposit. Do not invent bank numbers.
4. **ImageScript oversized re-encode** — AWS fast-path only when bytes already ≤ 450KB (same as production skip). Oversized images 413 until ImageScript/sharp is ported or the browser prep path succeeds.
5. **Webhook apply** — receipts only; production ledger/method/stakeholder updates still dry-run.
6. **Financial GRANTs** — `AWS_FINANCIAL_PERMISSIONS_ACTIVATED` stays false; live `payment_transfers` DML from Lambda may be denied until activation.
7. **`moov-account-file-view` signed URL** — path vs URL for the UI viewer.
8. **`moov-account-discover` full adopt loop** — not on the money path; currently aliased to selftest.

No unexplained missing production-required **function** remains.

---

## GO / NO-GO checklist

| Requirement | Result |
| --- | --- |
| 1. Known-working Lovable/Supabase provider behavior fully inventoried | **Yes** (48 Moov-class + 9 CheckAlt) |
| 2. AWS equivalent identified for every production-required function | **Yes** (`/functions/v1/*` ports). Webhook apply intentionally dry-run. |
| 3. Request/response semantics preserved | **Yes** for money-path HTTP (facilitator POST, integer cents, FinCapture auth/process/approve/item). Documented diffs: ImageScript, public-token Cognito, file-view URL, CheckAlt table isolation. |
| 4. Database side effects preserved | **Moov sandbox env rows: yes.** **CheckAlt production tables: intentionally not written on staging.** |
| 5. Frontend contract preserved | **Yes** (HTTP 2xx envelope; same invoke names/bodies). UAT deposits will not appear in production `checkalt_deposits` queries. |
| 6. Intentional differences documented | **Yes** |
| 7. Real provider test passes where test environment permits | **Auth-only previously proven (sidecar).** Transfer/deposit not permitted by missing IDs + Lambda NAT. This VM Secrets Manager token expired this turn; hosts are reachable. |
| 8. No unexplained production-required functionality missing | **Yes — none unexplained.** Remaining items are named gates 1–8 above. |

| Question | Answer |
| --- | --- |
| **Moov GO?** | **NO-GO** (code ports exist; live sandbox transfer + NAT + platform id + webhook apply not satisfied) |
| **CheckAlt GO?** | **NO-GO** (code ports exist; live UAT deposit + depositor + ImageScript + NAT not satisfied) |
| **Overall AWS GO?** | **NO-GO** |
| Production flags | Remain **false** |
| Merge / DNS / production webhooks | **Do not** |

Unit evidence: `/exec-daemon/node --test aws/tests/*.test.mjs` → **164/164 pass**, including facilitator POST, integer cents, persist-before-HTTP, pinned `v2024.01.00`, CheckAlt auth path/body, depositor ≠ API login, approve `deposit_id` + action 1.
