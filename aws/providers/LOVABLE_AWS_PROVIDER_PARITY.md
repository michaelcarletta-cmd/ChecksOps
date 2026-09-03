# Lovable / Supabase → AWS provider parity

Inspect-only audit of whether AWS currently preserves the known-working Lovable/Supabase Moov and CheckAlt workflows.

**This document does not authorize production cutover.** Production financial execution flags stay false. Provider implementations were not changed to make sandbox/UAT tests pass. Production Moov account IDs, CheckAlt depositor IDs, and bank numbers must not be copied into sandbox/UAT.

Authoritative production code: `supabase/functions/moov-*`, `supabase/functions/checkalt-*`, `supabase/functions/_shared/moovClient.ts`, `supabase/functions/_shared/checkalt.ts`, and the frontend `supabase.functions.invoke(...)` call sites under `src/`.

Authoritative AWS code: `aws/functions/api/providers.mjs`, `aws/functions/api/providers/*.mjs`, `aws/functions/api/sandbox.mjs`, `src/integrations/aws/client.ts`.

Live UAT evidence (auth-only sidecar, VPC NAT failure, classification of the two blockers): `aws/financial/UAT_RESULTS.md`.

## Verdict (independent of missing test-provider configuration)

AWS is **not** functionally equivalent to the working Lovable implementation.

The two sandbox/UAT blockers (Moov `GET /accounts` 401 and CheckAlt `ssoKey` / `account_unregistered`) are **missing non-production test configuration**, not proof that the production money path is rewritten incorrectly. Even if those test IDs existed and NAT were added, AWS still would not preserve production behavior:

1. Production Edge Function bodies are **not implemented** on AWS. `handleFunctionInvoke` returns `403 provider_disabled` with `tranche4HardBlock: true` even when provider flags are flipped. Comment in code: money movement is not implemented on AWS.
2. The four `db_status` routes are **local RDS snapshots**. Production `moov-readiness`, `moov-transfer-status`, `checkalt-deposit-history`, and `checkalt-account-status` call the live provider (and transfer-status / poll write back).
3. `/sandbox/*` is a **separate UAT harness**. It writes `aws_provider_sandbox_*` only. It is not the production function contract the frontend invokes.
4. Webhooks on AWS verify and persist isolated receipts with `applied: false`. Production `moov-webhook` updates `payment_transfers`, methods, stakeholders, and ledger.
5. The AWS frontend `functions.invoke` helper requires `body.ok === true`. Production functions return `{ success: true, ... }` without `ok`, so even a later port must preserve that envelope or the AWS client will treat a 200 as an error.

| Gate | Status |
| --- | --- |
| Moov | **NO-GO** |
| CheckAlt | **NO-GO** |
| ChecksOps AWS overall | **NO-GO** |

## Classification legend

| Status | Meaning |
| --- | --- |
| `PARITY VERIFIED` | AWS preserves the production helper or contract (same semantics). |
| `INTENTIONAL AWS IMPROVEMENT` | AWS is stricter or safer on purpose. Do not revert to match Lovable. |
| `NOT REQUIRED FOR CURRENT FLOW` | Exists in production; not on the deposit → disburse money path. Still inventoried. |
| `MISSING` | Production function has no AWS body that performs the same provider HTTP and DB writes. Fail-closed `403` is not an equivalent. |
| `BEHAVIORAL DIFFERENCE` | AWS has a handler, but it does not match production (local vs live, different identity, different envelope, or no apply). |
| `BLOCKED BY PROVIDER TEST ENVIRONMENT` | A sandbox/UAT adapter exists, but live HTTP cannot complete without non-production test IDs and/or NAT. Not a license to change working production semantics. |

Each production function gets **one** primary status. Cross-cutting helpers and the `/sandbox/*` harness are tabulated separately.

## Cross-cutting controls (keep false / dry-run)

| Flag / control | Required value | Notes |
| --- | --- | --- |
| `AWS_PROVIDER_EXECUTION_ENABLED` | `false` | Master kill switch |
| `AWS_FINANCIAL_PERMISSIONS_ACTIVATED` | `false` | Financial write IAM |
| `AWS_MOOV_ENABLED` / `AWS_CHECKALT_ENABLED` / `AWS_PLAID_ENABLED` | `false` | Per-provider |
| `AWS_PROVIDER_WEBHOOK_DRY_RUN` | `true` (default) | Receipts only |
| `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED` | may be `true` | UAT harness only |

Pinned Moov API version remains `v2024.01.00`. Do not migrate to `v2026.04.00` / `v2026.07.00` in this audit.

---

## Shared helpers

| Helper | Production | AWS | Status |
| --- | --- | --- | --- |
| Moov OAuth client-credentials + `Origin` + `x-moov-version` | `_shared/moovClient.ts` `moovToken` / `moovFetch` | `moov-sandbox.mjs` | `PARITY VERIFIED` (sidecar OAuth succeeded). Small untested diffs: GET omits `Content-Type`; token reused on list vs reminted per request. **Do not change** to chase the 401. |
| Moov facilitator resolution | `MOOV_PLATFORM_ACCOUNT_ID` / `MOOV_SANDBOX_PLATFORM_ACCOUNT_ID` then wallet `partnerAccountID` | Reads `MOOV_SANDBOX_PLATFORM_ACCOUNT_ID` only; falls back to listed/probe objects | `BLOCKED BY PROVIDER TEST ENVIRONMENT` (secret absent). Production money path never lists `/accounts`. |
| Moov idempotency UUID | SHA-256 seed → v4-shaped `X-Idempotency-Key` | Same algorithm in `idempotencyUuid` | `PARITY VERIFIED` |
| Moov transfer amount | integer cents `{ currency: "USD", value }` | `formatMoovTransferAmount` | `PARITY VERIFIED` |
| Moov readiness math | `_shared/moovReadiness.ts` | `providers/readiness.mjs` port | `PARITY VERIFIED` for the formula. The **function** that feeds it is not (see `moov-readiness`). |
| CheckAlt auth | `POST /public/fincapture/authenticate` `{ userName, password }` + `merchant` | Tries `/public/jwtauth/authenticate` then production path | `PARITY VERIFIED` for the path that succeeded. Extra first try is unused when 404. |
| CheckAlt `userAmount` | integer cents, no decimal (`$123.45` → `12345`) | `formatCheckAltUserAmount` / sandbox converter | `PARITY VERIFIED` |
| CheckAlt depositor identity | `checkalt_tenant_accounts.sso_user_id` + `deposit_account_number`; `ssoKey` from register payload / `getUserAccountInformation` | Sandbox lookup uses `CHECKALT_UAT_USER_ID` (API login) | `BEHAVIORAL DIFFERENCE` in the UAT harness. Production never uses the API login as FinCapture `userId`. **Do not invent UAT bank numbers or copy production registrations.** |
| CheckAlt fail-closed if unregistered | `loadTenantAccount` throws; does not invent bank numbers | `account_unregistered` if no deposit account or no `ssoKey` | `INTENTIONAL AWS IMPROVEMENT` (and matches the production product rule). |
| Webhook HMAC / Moov signature | `moov-webhook` | `providers/hmac.mjs` + `webhooks.mjs` | `PARITY VERIFIED` for verify. Apply path is dry-run (see `moov-webhook`). |
| Untrusted browser amounts | Production functions take `amount_cents` from the caller after auth | Sandbox rejects `amount` / `userAmount` / `value` from the body | `INTENTIONAL AWS IMPROVEMENT` |
| Persist-before-HTTP | Production inserts `payment_idempotency_keys` / `checkalt_deposits` before provider POST | Sandbox inserts `aws_provider_sandbox_operations` before HTTP | `INTENTIONAL AWS IMPROVEMENT` for the harness. Production table writes are still `MISSING`. |
| Production ID isolation | Environment-scoped rows (`environment = sandbox` vs `production`) | Refuses listed/sandbox IDs that overlap production RDS provider IDs | `INTENTIONAL AWS IMPROVEMENT` |
| CheckAlt UAT host / merchant allowlist | `checkalt_config.base_url` / `merchant` | Only `https://uatapi.checkalt.com` + merchant `lockbox5` | `INTENTIONAL AWS IMPROVEMENT` |
| Header spoof ignore | Edge Functions use JWT `auth.uid()` | Cognito mapping; `x-user-id` / `x-tenant-id` ignored | `INTENTIONAL AWS IMPROVEMENT` |
| `provider_egress_failed` | N/A (Supabase egress works) | Maps Node `fetch failed` to 503 | `INTENTIONAL AWS IMPROVEMENT` (does not hide NAT as a generic 500). Does not add NAT. |

---

## Moov Edge Functions (39)

Frontend contract: production UI calls `supabase.functions.invoke("<name>", { body })`. AWS staging client posts `/functions/v1/<name>` and only treats `HTTP 200` + `body.ok === true` as success.

AWS production-path column: what `/functions/v1/<name>` does today.

| Function | Production behavior | DB side effects | Frontend | AWS production path | Status |
| --- | --- | --- | --- | --- | --- |
| `moov-account-create` | Idempotent `POST /accounts`; TOS token optional | `payment_provider_accounts`, `payment_idempotency_keys` | `TenantPaymentAccountPanel`, `PaymentAccountPanel`, `moovProvider.ts` | `403` hard-block | `MISSING` |
| `moov-account-discover` | `GET /accounts?count=200` plus per-account caps/banks; optional adopt | May update `payment_provider_accounts` | Admin diagnostic (not money movement) | `403` hard-block | `NOT REQUIRED FOR CURRENT FLOW` |
| `moov-account-onboard` | In-app KYB: business profile, controller/owners → Moov account + representatives | `payment_provider_accounts` | `PaymentOnboardingDialog` | `403` hard-block | `MISSING` |
| `moov-account-files` | List KYC files at Moov; sync local rows | `payment_provider_files` | `verificationFiles.ts` | `403` hard-block | `MISSING` |
| `moov-account-file-upload` | Multipart upload to Moov Files API | `payment_provider_files` | `verificationFiles.ts` | `403` hard-block | `MISSING` |
| `moov-account-file-view` | Fetch file bytes from Moov | none (read) | `verificationFiles.ts` | `403` hard-block | `MISSING` |
| `moov-onboarding-link` | Hosted Moov onboarding session | `payment_provider_accounts` | `TenantPaymentAccountPanel` | `403` hard-block | `MISSING` |
| `moov-readiness` | **Live** `GET /accounts/{id}`, capabilities, bank-accounts, fee-plans; comment: never trust a stale local column | none (read) | `PaymentReadinessPanel`, `useWalletOpsReadiness` expect `data.readiness` | Local snapshot via `handleMoovStatus`; `readiness_source: local_snapshot`; envelope `{ ok, readiness }` vs production `{ success, readiness }` | `BEHAVIORAL DIFFERENCE` |
| `moov-selftest` | Platform credential probe including `GET /accounts` (needs `/accounts.write` on the **application key**) and `GET /accounts/{platformId}` | none | `PaymentProviderAdmin` | `403` hard-block | `NOT REQUIRED FOR CURRENT FLOW` |
| `moov-sync` | Live account/caps/banks; may auto-adopt another Moov account; writes flags | `payment_provider_accounts`, methods/rails | `PaymentAccountPanel`, `PaymentReadinessPanel`, `MicroDepositVerification` | `403` hard-block | `MISSING` |
| `moov-wallet-sync` | Pull Moov wallets/balances | `payment_wallets`, `payment_wallet_ledger`, `payment_wallet_sub_ledgers` | Wallet UI via hooks | `403` hard-block | `MISSING` |
| `moov-wallet-fund` | `POST /accounts/{facilitatorId}/transfers` | `payment_transfers`, wallets/ledger | `src/lib/payments/wallets.ts` | `403` hard-block | `MISSING` |
| `moov-bank-account-add` | Add bank at Moov | `payment_provider_methods`, account flags | `MoovBankLink` | `403` hard-block | `MISSING` |
| `moov-bank-link-token` | Moov.js / bank-link Drop token | none / session | Bank-link UI | `403` hard-block | `MISSING` |
| `moov-micro-deposit-initiate` | Initiate micro-deposits (money movement) | `payment_method_verifications`, `payment_provider_methods` | `MicroDepositVerification`, `verification.ts` | `403` hard-block | `MISSING` |
| `moov-micro-deposit-confirm` | Confirm micro-deposits | same | same | `403` hard-block | `MISSING` |
| `moov-plaid-bridge` | Link Plaid item into Moov | methods / stakeholder rails | `CheckStakeholdersManager` | `403` hard-block | `MISSING` |
| `moov-platform-bank` | Platform treasury bank admin | platform methods | `PlatformBankPanel` | `403` hard-block | `MISSING` |
| `moov-tos-token` | Platform Agreement token | none | Onboarding | `403` hard-block | `MISSING` |
| `moov-tos-accept` | Record TOS at Moov | `payment_provider_accounts.tos_*` | `PaymentReadinessPanel` | `403` hard-block | `MISSING` |
| `moov-underwriting` | GET/PUT `/accounts/{id}/underwriting` | account metadata | `UnderwritingQuestionnairePanel` | `403` hard-block | `MISSING` |
| `moov-recipient-create` | `POST /accounts` for stakeholder | `payment_provider_accounts`, `external_payment_recipients` / stakeholders | `AddExternalStakeholderDialog` | `403` hard-block | `MISSING` |
| `moov-recipient-session` | Hosted recipient session | recipient rows | `RecipientPaymentSetup` | `403` hard-block | `MISSING` |
| `moov-recipient-tos-accept` | Recipient Platform Agreement | recipient TOS | `RecipientPaymentSetup` | `403` hard-block | `MISSING` |
| `moov-recipient-kyc-update` | Patch recipient KYC | recipient profile | `RecipientPaymentSetup` | `403` hard-block | `MISSING` |
| `moov-recipient-bank-add` | Recipient bank | recipient methods | `RecipientPaymentSetup` | `403` hard-block | `MISSING` |
| `moov-recipient-disconnect` | Disconnect recipient | recipient rows | `StakeholderAccountSettings` | `403` hard-block | `MISSING` |
| `moov-transfer-create` | `POST /accounts/{facilitatorId}/transfers` (ACH/RTP/wallet). Source is the **initiating tenant** bank. Does **not** `GET /accounts`. | `payment_transfers`, `payment_idempotency_keys` | Disbursement / payment rails | `403` hard-block | `MISSING` |
| `moov-transfer-status` | Live `GET /accounts/{facilitator}/transfers/{id}` for in-flight rows; writes provider status; `postTransferLedger` | `payment_transfers`, wallet ledger | `useWalletOps` (also reads `payment_transfers` directly) | Local `payment_transfers` read only; no live GET; no write-back | `BEHAVIORAL DIFFERENCE` |
| `moov-transfer-group-create` | Grouped transfers | `payment_transfers` group ids | Payment ops | `403` hard-block | `MISSING` |
| `moov-disburse` | All-or-nothing batch; `409 recipient_setup_required` if any recipient lacks a bank; `POST .../transfers` per split | `disbursement_batches`, `payment_transfers` | `DisbursementConsole`, `RunPayrollDialog` | `403` hard-block | `MISSING` |
| `moov-tenant-fee-charge` | Charge tenant fees via Moov | `payment_transfers` / fee rows | `AdminTenants` | `403` hard-block | `MISSING` |
| `moov-fee-schedule-upsert` | Mutate fee schedules | fee schedule tables | `feeSchedules.ts` | `403` hard-block | `MISSING` |
| `moov-fee-schedule-cancel` | Cancel fee schedules | same | same | `403` hard-block | `MISSING` |
| `moov-fee-rollup` | Fee reporting against provider state | reporting reads | `feeSchedules.ts` | `403` hard-block | `MISSING` |
| `moov-sweep-config` | Configure sweeps | `payment_sweep_configs` | `src/lib/payments/sweeps.ts` | `403` hard-block | `MISSING` |
| `moov-invoice` | Invoice CRUD + Moov invoice send | `moov_invoices`, `moov_invoice_customers` | `useMoovInvoices` | `403` hard-block | `MISSING` |
| `moov-bulk-import-preview` | Bulk import preview; may call Moov | none / preview | Admin import | `403` hard-block | `NOT REQUIRED FOR CURRENT FLOW` |
| `moov-webhook` | Verify HMAC; unique `(provider, external_event_id)`; **apply** transfer/account/bank/stakeholder/ledger | `payment_webhook_events`, `payment_transfers`, `payment_provider_methods`, `external_payment_recipients`, `stakeholder_accounts`, `payment_event_log`, ledger | Provider dashboard → Supabase URL (unchanged) | `POST /webhooks/moov`: verify, sanitize, insert `aws_provider_webhook_receipts`, `applied: false`, `financialTablesMutated: false` | `INTENTIONAL AWS IMPROVEMENT` |

### Moov Edge Function totals

| Status | Count |
| --- | --- |
| `PARITY VERIFIED` | 0 |
| `INTENTIONAL AWS IMPROVEMENT` | 1 (`moov-webhook` dry-run receipts) |
| `NOT REQUIRED FOR CURRENT FLOW` | 3 (`moov-account-discover`, `moov-selftest`, `moov-bulk-import-preview`) |
| `MISSING` | 33 |
| `BEHAVIORAL DIFFERENCE` | 2 (`moov-readiness`, `moov-transfer-status`) |
| `BLOCKED BY PROVIDER TEST ENVIRONMENT` | 0 (see sandbox harness below) |
| **Total** | **39** |

---

## Related Moov workflows (9)

These are production Edge Functions that call Moov or Moov-adjacent tables. Catalogued in `providers/catalog.mjs` as `provider: moov`.

| Function | Production behavior | DB side effects | Frontend | AWS | Status |
| --- | --- | --- | --- | --- | --- |
| `initiate-wallet-funding` | Queue/create funding; may create Moov transfer | `wallet_funding_requests`, `payment_transfers`, `disbursement_batches` | `useAutoFunding.ts` | `403` hard-block | `MISSING` |
| `cancel-wallet-funding` | Cancel funding request | `wallet_funding_requests` | `useAutoFunding.ts` | `403` hard-block | `MISSING` |
| `calculate-payment-funding` | Funding plan immediately before execution | reads wallets/methods | `DisbursementConsole` | `403` hard-block | `MISSING` |
| `process-funded-payment` | After funding clears, invokes `moov-disburse` internally | `disbursement_batches` | Internal / funding clear | `403` hard-block | `MISSING` |
| `wallet-fund-on-clear` | Auto-fund after check clear | funding + transfers | Automated | `403` hard-block | `MISSING` |
| `platform-treasury` | Platform treasury operations | treasury / transfers | `PlatformTreasuryPanel` | `403` hard-block | `MISSING` |
| `homeowner-deductible-pay` | Charge homeowner deductible | `payment_transfers` / ledger | `HomeownerLedger` | `403` hard-block | `MISSING` |
| `stakeholder-resend-verification` | Resend KYC/verification email | none / email | `FundsTab`, `TenantBankAccountSettings`, `StakeholderAccountSettings` | `403` hard-block | `MISSING` |
| `public-invoice` | Public invoice fetch/pay | `moov_invoices` | `PublicInvoicePage` | `403` hard-block | `MISSING` |

| Status | Count |
| --- | --- |
| `MISSING` | 9 |
| **Total** | **9** |

Combined Moov-class workflows (39 + 9) = **48**. Missing AWS equivalents: **42**.

---

## CheckAlt Edge Functions (9)

Production shared client: `_shared/checkalt.ts`. Auth is **only** the FI API login. Depositor identity is **always** `checkalt_tenant_accounts` (`sso_user_id`, `deposit_account_number`, cached `last_register_payload.sso_key`).

| Function | Production behavior | DB side effects | Frontend | AWS production path | Status |
| --- | --- | --- | --- | --- | --- |
| `checkalt-register-account` | `POST /fincapture/useraccount/register` then `getUserAccountInformation` for `ssoKey` | `checkalt_tenant_accounts` (`sso_user_id`, deposit account, `last_register_payload`) | `CheckAltSettings` Integration Settings | `403` hard-block | `MISSING` |
| `checkalt-verify-account` | `getUserAccountInformation` / `getDepositAccountInformation` with `userId: acct.sso_user_id` | none (read) | `CheckAltSettings` Verify buttons | `403` hard-block | `MISSING` |
| `checkalt-test-connection` | Auth only; returns `success` + token preview | may refresh cached JWT on `checkalt_config` | `CheckAltSettings` | `403` hard-block | `MISSING` |
| `checkalt-prepare-image` | Normalize one check side to FinCapture byte budget; upload deposit-ready JPEG; landscape / Mitek IQA | storage `claim-files` | `prepareCheckAltDeposit.ts` | `403` hard-block | `MISSING` |
| `checkalt-submit-deposit` | Pull front/back images, compress, `POST /fincapture/deposit/process` with `ssoKey` + integer-cents `userAmount` | `checkalt_deposits`, `check_intake_items` | `CheckCommandCenter`, `DepositOperationsConsole` | `403` hard-block | `MISSING` |
| `checkalt-approve-deposit` | `POST /fincapture/deposit/approve` (`action` 1/2). `ssoKey` is **not** in this schema. Checks `success` not just HTTP 200. | `checkalt_deposits` | Admin / deposit ops | `403` hard-block | `MISSING` |
| `checkalt-poll-status` | `POST /fincapture/deposit/item` then fallback `/deposit/history`; **updates** stale `checkalt_deposits`; 60-day return window | `checkalt_deposits` | `CheckAltSettings` poll | `403` hard-block (not `db_status`; poll is a write) | `MISSING` |
| `checkalt-deposit-history` | Live `POST /fincapture/deposit/history` with tenant `ssoKey` | none (read) | Settings / ops | Local `checkalt_deposits` only | `BEHAVIORAL DIFFERENCE` |
| `checkalt-account-status` | Live user/deposit-account/item lookups using `loadTenantAccount` | none (read) | Settings | Local `checkalt_tenant_accounts` snapshot (`has_sso_user` boolean, no FinCapture GET) | `BEHAVIORAL DIFFERENCE` |

### CheckAlt Edge Function totals

| Status | Count |
| --- | --- |
| `PARITY VERIFIED` | 0 |
| `INTENTIONAL AWS IMPROVEMENT` | 0 (see helpers: unregistered fail-closed, UAT allowlist) |
| `NOT REQUIRED FOR CURRENT FLOW` | 0 |
| `MISSING` | 7 |
| `BEHAVIORAL DIFFERENCE` | 2 (`checkalt-deposit-history`, `checkalt-account-status`) |
| `BLOCKED BY PROVIDER TEST ENVIRONMENT` | 0 (see sandbox harness) |
| **Total** | **9** |

There is **no** production `checkalt-webhook` Edge Function. Historical log is `deposit_webhook_events`. AWS exposes `POST /webhooks/checkalt` as dry-run receipts (`INTENTIONAL AWS IMPROVEMENT`, same pattern as Moov). Production CheckAlt status is poll + history, not webhook apply.

---

## `/sandbox/*` UAT harness (not a production function port)

These routes exist only on AWS staging. Frontend production screens do not call them. They must not mutate `payment_*` / `checkalt_deposits` / `check_intake_items`.

| Route | Intended production analogue | What it actually does | Status |
| --- | --- | --- | --- |
| `POST /sandbox/moov/probe` | `moov-selftest` / discover (diagnostic) | OAuth `/accounts.read`, **lists** `/accounts`, then optional GET account/wallets/methods/caps | `BLOCKED BY PROVIDER TEST ENVIRONMENT` (Lambda NAT `provider_egress_failed`; sidecar list 401 without sandbox platform/list permission). Diagnostic list is **not** the production transfer path. |
| `POST /sandbox/moov/transfer` | `moov-transfer-create` | Persist sandbox op, `POST /accounts/{facilitator}/transfers` $0.01 using probed payment methods | `BLOCKED BY PROVIDER TEST ENVIRONMENT` (no sandbox facilitator/payment-method IDs; NAT). Would still not write `payment_transfers`. |
| `POST /sandbox/moov/retrieve` | `moov-transfer-status` | GET sandbox transfer by stored sandbox reference | `BLOCKED BY PROVIDER TEST ENVIRONMENT` (depends on transfer) |
| `POST /sandbox/checkalt/probe` | `checkalt-test-connection` | UAT auth | `BLOCKED BY PROVIDER TEST ENVIRONMENT` on the API Lambda (NAT). Sidecar auth **succeeded**. |
| `POST /sandbox/checkalt/account` | `checkalt-verify-account` / account-status | `getUserAccountInformation` with **API login** as `userId` | `BEHAVIORAL DIFFERENCE` + `BLOCKED BY PROVIDER TEST ENVIRONMENT` (no UAT depositor; FI view has no `ssoKey`) |
| `POST /sandbox/checkalt/deposit` | `checkalt-submit-deposit` | Synthetic 1×1 PNG, integer cents, persist-before-HTTP, fail-closed without `ssoKey` | `BLOCKED BY PROVIDER TEST ENVIRONMENT`. Image pipeline is not production `checkalt-prepare-image`. |
| `POST /sandbox/checkalt/status` | `checkalt-poll-status` / history | UAT item/history against sandbox reference | `BLOCKED BY PROVIDER TEST ENVIRONMENT` |
| `POST /sandbox/checkalt/approve` | `checkalt-approve-deposit` | UAT approve against sandbox reference | `BLOCKED BY PROVIDER TEST ENVIRONMENT` |
| `POST /sandbox/webhooks/{provider}` | production webhooks | Isolated `aws_provider_sandbox_webhooks`; no production ledger | `INTENTIONAL AWS IMPROVEMENT`. Secrets `MOOV_SANDBOX_WEBHOOK_SECRET` / `CHECKALT_SANDBOX_WEBHOOK_SECRET` still absent. |

---

## Frontend contracts

| Contract | Production | AWS | Status |
| --- | --- | --- | --- |
| Invoke path | `supabase.functions.invoke(name)` → Edge Function | `apiFetch(/functions/v1/{name})` | Path exists |
| Success envelope | Typically `{ success: true, ... }` or domain fields (`readiness`, `polled`) | Client requires `body.ok === true` | `BEHAVIORAL DIFFERENCE` |
| `moov-readiness` | `{ success, readiness }` from **live** Moov | `{ ok, readiness, account, wallets, transfers }` from **local** snapshot | `BEHAVIORAL DIFFERENCE` |
| `moov-tos-accept` then `moov-sync` | Mutates Moov + local TOS/flags | Both `403` | `MISSING` |
| `checkalt-poll-status` | `{ polled, updated, errors }` after live poll + UPDATE | `403` | `MISSING` |
| `checkalt-test-connection` | `{ success, message, token_preview }` | `403` | `MISSING` |
| `checkalt-register-account` | Register + persist tenant row | `403` | `MISSING` |
| Disburse / submit-deposit / micro-deposits / recipients / invoices / sweeps | Live provider + production tables | `403` | `MISSING` |
| Direct table reads (`payment_transfers`, `payment_wallets`, `checkalt_deposits`) | RLS via Supabase | AWS PostgREST-compatible data API (separate from provider HTTP) | Out of scope of this provider-HTTP matrix; financial aggregates were unchanged in UAT |

---

## Retries and idempotency

| Path | Production | AWS | Status |
| --- | --- | --- | --- |
| Moov transfers | `payment_idempotency_keys` + `payment_transfers.idempotency_key` + hashed UUID header | Not implemented on `/functions/v1/moov-transfer-create`. Sandbox uses `aws_provider_sandbox_operations` unique key and replays without a second HTTP | Production path `MISSING`. Harness replay `INTENTIONAL AWS IMPROVEMENT` |
| Moov webhooks | unique `(provider, external_event_id)` on `payment_webhook_events`; redelivery skipped | unique `(provider, external_event_id)` on `aws_provider_webhook_receipts`; duplicate returns `duplicate: true` | `PARITY VERIFIED` for dedupe. Apply still dry-run |
| CheckAlt submit | Existing `checkalt_deposits` row for the check + amount | Sandbox operation key; production table not written | Production path `MISSING` |
| CheckAlt poll | Batch update of stale rows | Not implemented | `MISSING` |

---

## Database side effects (production tables)

AWS staging must not write these for UAT:

| Table | Written by production | Written by AWS production path today |
| --- | --- | --- |
| `payment_provider_accounts` | create/onboard/sync/TOS | no |
| `payment_provider_methods` | bank add, micro-deposits, webhook, sync | no |
| `payment_provider_files` | file list/upload | no |
| `payment_wallets` / `payment_wallet_ledger` | wallet-sync, transfer-status, webhooks | no |
| `payment_transfers` | transfer-create, disburse, funding, fees | no |
| `payment_idempotency_keys` | account-create, transfers | no |
| `payment_sweep_configs` | sweep-config | no |
| `moov_invoices` / `moov_invoice_customers` | moov-invoice | no |
| `wallet_funding_requests` / `disbursement_batches` | funding + disburse | no |
| `checkalt_tenant_accounts` | register-account | no |
| `checkalt_deposits` | submit, approve, poll | no |
| `check_intake_items` | submit-deposit status | no |
| `payment_webhook_events` | moov-webhook apply | no (AWS uses `aws_provider_webhook_receipts`) |

Sandbox UAT writes only `aws_provider_sandbox_operations`, `aws_provider_sandbox_objects`, `aws_provider_sandbox_audit`, `aws_provider_sandbox_webhooks`. That isolation is an `INTENTIONAL AWS IMPROVEMENT`.

---

## Exact non-production test configuration still required

Do **not** copy production Moov account IDs, CheckAlt `sso_user_id` values, deposit account numbers, customers, or any financial data into sandbox/UAT.

### Moov sandbox (equivalent *role*, new IDs)

Production money movement uses:

1. Application key pair for that environment.
2. Stored `payment_provider_accounts.provider_account_id` (tenant connected account).
3. Facilitator / platform account: `MOOV_PLATFORM_ACCOUNT_ID` (or `MOOV_SANDBOX_PLATFORM_ACCOUNT_ID` when `MOOV_ENVIRONMENT=sandbox`), else wallet `partnerAccountID`.
4. `GET /accounts/{id}` with `/accounts/{id}/profile.read` and `POST /accounts/{facilitatorId}/transfers`.

Staging secret `checksops/staging/providers` already has `MOOV_SANDBOX_PUBLIC_KEY` / `MOOV_SANDBOX_SECRET_KEY`. Still missing:

| Secret / row | Required value (sandbox-only) | Must not be |
| --- | --- | --- |
| `MOOV_SANDBOX_PLATFORM_ACCOUNT_ID` | Facilitator account ID **owned by the sandbox application** (same role as production `MOOV_PLATFORM_ACCOUNT_ID`) | Any production RDS `provider_account_id` |
| Optional `MOOV_SANDBOX_ALLOWED_ORIGIN` | Origin allowlisted on the **sandbox** Moov app if it is not `https://checksops.com` | A guess that changes working OAuth (sidecar token already succeeded with the default Origin) |
| Optional `MOOV_SANDBOX_WEBHOOK_SECRET` | Sandbox webhook signing secret pointed at **staging** `/webhooks/moov` or `/sandbox/webhooks/moov` | Production `MOOV_WEBHOOK_SECRET` or production dashboard URL |
| Sandbox `payment_provider_accounts` (environment `sandbox`) | New connected accounts created **in Moov sandbox** for Freedom/C1C test tenants, with sandbox payment methods/wallets | Overwriting production-environment rows; copying production IDs |
| Application list permission | Only if operators still want `GET /accounts` for diagnostics (`moov-selftest`). **Not required for transfers.** | Treating list 401 as a transfer-path bug |

After those exist, the production-shaped probe is `GET /accounts/{sandboxPlatformId}` with `/accounts/{id}/profile.read`, then transfer under the facilitator — **not** listing all accounts. Isolation must still stop if a sandbox ID overlaps a production RDS ID.

### CheckAlt UAT (equivalent *relationship*, new depositor)

Production deposit uses:

1. FI API login `CHECKALT_USERNAME` / `CHECKALT_PASSWORD` at `/public/fincapture/authenticate`.
2. Tenant row `checkalt_tenant_accounts.sso_user_id` + `deposit_account_number` created by Integration Settings → `checkalt-register-account`.
3. `ssoKey` from `last_register_payload.sso_key`, else `getUserAccountInformation`, else fallback `sso_user_id`.
4. Process/history/approve against **that** FinCapture host.

Staging already has UAT API login + `https://uatapi.checkalt.com` + merchant `lockbox5`. Still missing:

| Item | Required (UAT-only) | Must not be |
| --- | --- | --- |
| UAT test deposit account number | Issued by CheckAlt for UAT / lockbox5 | Production bank / lockbox numbers; invented numbers |
| UAT `sso_user_id` | A new FinCapture user registered on **UAT** via `/fincapture/useraccount/register` (same payload shape as production) | Production `checkalt_tenant_accounts.sso_user_id` |
| UAT `ssoKey` | Returned by UAT `getUserAccountInformation` after register; stored in a **UAT-scoped** tenant-account row | Assuming FI login `CHECKALT_UAT_USER_ID` is a depositor |
| Webhook secret | `CHECKALT_SANDBOX_WEBHOOK_SECRET` on staging only | Production webhook secret / production URL |

`checkalt-register-account` is `MISSING` on AWS, so UAT registration cannot be performed through the AWS frontend today. Registration must happen in CheckAlt UAT (or a later, explicit AWS port of register) and then be stored as a UAT row — not by copying restored production FinCapture IDs.

---

## AWS networking (separate from provider semantics)

Document only. Do not perform production cutover. Do not treat NAT as a provider-code fix.

| Item | Current |
| --- | --- |
| Lambda | `checksops-staging-api` |
| VPC | `vpc-09f2268778966ce97` |
| Subnets | `subnet-0df2518070c5b9ff0`, `subnet-092e4e41821fba6c4` |
| Security group | `sg-0fe2698f236959353` (egress `tcp/443 0.0.0.0/0` is **not** sufficient) |
| NAT gateway | **none** |
| Public IPs on ENIs | **none** |
| Observed | `POST /sandbox/*` → `503 provider_egress_failed` |
| Sidecar evidence | No-VPC function could reach `api.moov.io` and `uatapi.checkalt.com` (auth only). Sidecar deleted after the run. |

Required before the **API** can call providers: NAT (or equivalent HTTPS egress) for those subnets, **or** a dedicated no-VPC invoker that the API can call without copying production credentials into the browser. Cursor staging role cannot create NAT (`ec2:CreateSubnet` / `AllocateAddress` / `CreateRouteTable` denied). This remains an independent AWS cutover blocker.

---

## Missing AWS equivalents (production functions)

### Moov (42)

`moov-account-create`, `moov-account-onboard`, `moov-account-files`, `moov-account-file-upload`, `moov-account-file-view`, `moov-onboarding-link`, `moov-sync`, `moov-wallet-sync`, `moov-wallet-fund`, `moov-bank-account-add`, `moov-bank-link-token`, `moov-micro-deposit-initiate`, `moov-micro-deposit-confirm`, `moov-plaid-bridge`, `moov-platform-bank`, `moov-tos-token`, `moov-tos-accept`, `moov-underwriting`, `moov-recipient-create`, `moov-recipient-session`, `moov-recipient-tos-accept`, `moov-recipient-kyc-update`, `moov-recipient-bank-add`, `moov-recipient-disconnect`, `moov-transfer-create`, `moov-transfer-group-create`, `moov-disburse`, `moov-tenant-fee-charge`, `moov-fee-schedule-upsert`, `moov-fee-schedule-cancel`, `moov-fee-rollup`, `moov-sweep-config`, `moov-invoice`, `initiate-wallet-funding`, `cancel-wallet-funding`, `calculate-payment-funding`, `process-funded-payment`, `wallet-fund-on-clear`, `platform-treasury`, `homeowner-deductible-pay`, `stakeholder-resend-verification`, `public-invoice`.

Plus live apply for `moov-webhook` (receipts exist; ledger apply is intentionally off).

### CheckAlt (7)

`checkalt-register-account`, `checkalt-verify-account`, `checkalt-test-connection`, `checkalt-prepare-image`, `checkalt-submit-deposit`, `checkalt-approve-deposit`, `checkalt-poll-status`.

---

## Behavioral differences (not “fix the 401 / ssoKey”)

Do not change working provider semantics solely to make sandbox tests pass.

1. **`moov-readiness`**: production live Moov GETs vs AWS local snapshot.
2. **`moov-transfer-status`**: production live retrieve + ledger write-back vs AWS local `payment_transfers` read.
3. **`checkalt-deposit-history`**: production live FinCapture history vs AWS local `checkalt_deposits`.
4. **`checkalt-account-status`**: production live FinCapture vs AWS local tenant-account booleans.
5. **Frontend invoke envelope**: production `{ success }` vs AWS client requiring `{ ok: true }`.
6. **Sandbox CheckAlt `userId`**: API login instead of `checkalt_tenant_accounts.sso_user_id`.
7. **Sandbox Moov account selection**: list `/accounts` instead of stored tenant + platform IDs.
8. **Small untested Moov header diffs**: GET without `Content-Type`; token reuse on list. Not proven as the 401 cause; **not changed**.
9. **CheckAlt auth body** extra `userId` on authenticate; `fi_key` sent as a later HTTP header. Auth still succeeded; **not changed**.
10. **Sandbox CheckAlt images**: synthetic 1×1 PNG vs production `checkalt-prepare-image` JPEG pipeline.
11. **Webhooks**: AWS `applied: false` vs production ledger/method/stakeholder updates.

---

## Intentional AWS security / isolation improvements

Do not revert these to “match Lovable.”

1. Fail-closed provider execution even if flags are flipped (`tranche4HardBlock`).
2. No substitution of production `MOOV_*` / `CHECKALT_*` into sandbox/UAT HTTP.
3. CheckAlt UAT host allowlist (`https://uatapi.checkalt.com` only) and merchant `lockbox5`.
4. Refuse sandbox objects whose IDs overlap production RDS provider IDs.
5. Persist sandbox operations before provider HTTP; replay same idempotency key without a second call.
6. Reject untrusted browser amount fields.
7. Fail-closed `account_unregistered` without inventing bank numbers.
8. Webhook dry-run into `aws_provider_webhook_receipts` (not `payment_webhook_events` / financial tables).
9. Cognito → `application_user_id` mapping; spoofed `x-user-id` / `x-tenant-id` ignored; cross-tenant `tenant_id` denied.
10. Payload sanitization (account numbers, secrets, SSN) on webhook responses.
11. Map VPC `fetch failed` to `provider_egress_failed` instead of an opaque 500.

---

## GO / NO-GO

| Question | Answer |
| --- | --- |
| Total original Moov functions/workflows | **48** (39 Edge Functions + 9 related). Status: 33+9 `MISSING`, 2 `BEHAVIORAL DIFFERENCE`, 3 `NOT REQUIRED FOR CURRENT FLOW`, 1 `INTENTIONAL AWS IMPROVEMENT` (webhook dry-run). Shared OAuth/amount/idempotency helpers: `PARITY VERIFIED`. |
| Total original CheckAlt functions/workflows | **9**. Status: 7 `MISSING`, 2 `BEHAVIORAL DIFFERENCE`. Auth + integer-cents helpers: `PARITY VERIFIED`. |
| Functionally equivalent to Lovable, independent of missing test-provider configuration? | **No.** Production function bodies, live readiness/status/history, KYC/onboarding, banks/micro-deposits, wallets/sweeps, ACH/RTP/disburse, invoices, CheckAlt register/submit/images/poll, and webhook apply are not on AWS. |
| Sandbox/UAT config still required | Moov sandbox platform/facilitator + sandbox connected accounts/payment methods; CheckAlt UAT-registered depositor (`sso_user_id` + deposit account + `ssoKey`) on `uatapi.checkalt.com` / `lockbox5`. Never production IDs. |
| NAT / egress | Required for `checksops-staging-api`. Independent blocker. Not performed here. |
| Production flags | Remain **false**. No merge, no cutover. |
| **Moov** | **NO-GO** |
| **CheckAlt** | **NO-GO** |
| **Overall AWS** | **NO-GO** |

Next implementation work (separate, explicit PRs — not this audit): port production function bodies behind the existing fail-closed flags; add NAT; provision sandbox/UAT IDs as specified above. Do not “fix” Origin, list permissions, or UAT register inside the money-path adapters merely to green a sandbox probe.
