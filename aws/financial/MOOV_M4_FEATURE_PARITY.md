# MOOV PRODUCTION READINESS — M4: FULL LOVABLE → AWS FEATURE PARITY

**Date:** 2026-09-10  
**Branch:** `cursor/moov-production-readiness-m4-a508`  
**STOP FOR REVIEW.** No production mutation. No webhook register. No money flags. No SQL72. No transfers. No onboard. Lovable remains live.

Companion JSON: `aws/financial/moov_m4_feature_parity.json`

## Scope

| Side | Ref | Notes |
|---|---|---|
| Legacy | `b53db94a2de69d68f22373669fbca1a4954847ee` (`2026-09-02`) | Last production-proven Moov OAuth client (`moovClient.ts` only in that commit). Tree at that commit already had **38** `moov-*` Edge functions. |
| Current AWS / main HEAD | this branch | Production GET-only + dark webhook. Sandbox parity ports exist; `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED=false`. |

**Post-legacy Edge delta:** `moov-recipient-kyc-update` landed in `dad34819` (same day, after `b53db94a`). Production recipient KYC now uses it. Still **C** on live product; sandbox port exists (**B**).

Do **not** treat `aws/providers/LOVABLE_AWS_PROVIDER_PARITY.md` “PARITY VERIFIED” as **A**. Those rows are **B** (sandbox/UAT ports; money/sandbox flags false).

## Classification

| Code | Meaning |
|---|---|
| **A** | Fully migrated to AWS **and production-ready** (holds-gated live path is a valid production source of truth) |
| **B** | Ported to AWS **sandbox/staging only** (`AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED`; currently **false**) |
| **C** | Still Lovable/Supabase Edge — **this is what checksops.com uses** (`VITE_AUTH_PROVIDER` is not `cognito`) |
| **D** | Frontend only (browser Moov.js Drop / UI; no AWS production route) |
| **E** | Missing, or AWS has receipt/code but not an authoritative production path |

Many rows are **A/C**: the AWS API can read live Moov, but the production SPA still invokes Supabase.

## Current verified production state (unchanged)

- AWS OAuth PASS; Freedom GET PASS; Freedom `READY_AS_SENDER`
- Business verified; ToS accepted `2026-08-28T18:36:52.907203Z`
- send-funds / collect-funds / wallet / transfers **enabled**
- Active wallet (available **0** cents); verified bank last4 `4573`; ACH credit/debit methods present
- Recipients **RECIPIENT_NOT_CONFIRMED** (`awaiting_bank`)
- AWS webhook handler ready in **dark mode**; webhook **not** registered; `MOOV_WEBHOOK_SECRET` absent
- `MOOV_PLATFORM_ACCOUNT_ID` absent (needed for facilitator transfer GET/POST, not for account readiness GET)
- All money execution flags **false**; SQL72 **NOT_APPLIED**; zero money movement

### AWS production surfaces that exist today

| Route | Behavior now |
|---|---|
| `POST /functions/v1/moov-readiness` | Live GET account/caps/wallets/banks/PMs when `AWS_PROVIDER_LIVE_READS_ENABLED=true` |
| `POST /functions/v1/moov-transfer-status` | Live GET facilitator transfer **if** `MOOV_PLATFORM_ACCOUNT_ID` is set; Freedom has **0** transfer rows |
| `POST /functions/v1/moov-transfer-create` | **403** `production_execution_blocked` |
| `POST /functions/v1/moov-disburse` | **403** `production_execution_blocked` |
| `POST /webhooks/moov` | HMAC verify + persist; `applied=false` |
| All other `/functions/v1/moov-*` | stubs / `provider_disabled` while sandbox flag is false |

---

## 1. Tenant / business onboarding

| Feature | Legacy (`b53db94a` / HEAD) | AWS production | AWS sandbox | Class |
|---|---|---|---|---|
| Create Moov connected account | `moov-account-create` | none | `moov-account-create` | **B** / **C** |
| Business account creation | `moov-account-onboard` (KYB profile, controller, owners) | none | `moov-account-onboard` | **B** / **C** |
| Individual account creation | same onboard + `moov-account-create` | none | same | **B** / **C** |
| Hosted onboarding session | `moov-onboarding-link` | none | `moov-onboarding-link` | **B** / **C** |
| KYC | `moov-account-onboard` + files + `moov-recipient-kyc-update` (post-legacy) | none | both ported | **B** / **C** |
| KYB | `moov-account-onboard` representatives / owners | none | ported | **B** / **C** |
| Control officers / representatives | `moov-account-onboard` | none | ported | **B** / **C** |
| Beneficial owners | `moov-account-onboard` | none | ported | **B** / **C** |
| Verification requirements | `moov-readiness` + `moov-sync` | **GET `moov-readiness`** live `requirements` / verification | `moov-readiness` + `moov-sync` | **A** read / **C** persist+UI |
| Document upload / requests | `moov-account-files`, `moov-account-file-upload`, `moov-account-file-view` | none | all three ported; file-view returns path not signed URL | **B** / **C** (view **E** gap on signed URL) |
| Status polling / sync | `moov-sync`, `moov-wallet-sync` | live GET snapshot, **no RDS write-back** | `moov-sync` | **A** live GET / **C** persist |
| Disabled / restricted | Edge + `PaymentReadinessPanel` | GET readiness | same | **A** read / **C** operator UX |

**Onboarding verdict:** Freedom is already onboarded in Moov. AWS cannot **create or update** tenant accounts in production. New tenants still depend on Lovable (**C**). Document upload exists in Lovable and sandbox, not on the production AWS write path.

---

## 2. Terms of Service

| Feature | Legacy | AWS production | AWS sandbox | Class |
|---|---|---|---|---|
| Server-side ToS status | `GET /accounts/{id}` via `moov-readiness` / `moov-sync` | GET `moov-readiness` `tos.accepted` / `accepted_at` | `moov-readiness` | **A** account-level read |
| ToS acceptance (server) | `moov-tos-accept` | none | `moov-tos-accept` | **B** / **C** |
| Moov.js ToS token | `moov-tos-token` then Drop | none | `moov-tos-token` (does **not** return public key — intentional) | **D** + **C** / **B** |
| Account-level ToS | tenant Platform Agreement | readiness read only | accept ported | **A** read / **C** accept |
| Stakeholder / payee ToS | `moov-recipient-tos-accept` | none | `moov-recipient-tos-accept` | **B** / **C** |
| Reacceptance / version changes | no dedicated flow | none | none | **E** |

**ToS verdict:** Freedom ToS is already accepted. AWS can **read** it. AWS cannot **accept** ToS in production.

---

## 3. Capabilities / underwriting

| Feature | Legacy | AWS production | Class |
|---|---|---|---|
| Capability reads | `moov-readiness` / `moov-sync` live `GET /capabilities` | GET `moov-readiness` (parent rows only: send-funds, collect-funds, wallet, transfers) | **A** |
| Capability requests | requested during `moov-account-create` / onboard / sync — **no** standalone `moov-request-capabilities` function on this tree | none in production | **C** (embedded in onboard/sync) / **B** sandbox onboard |
| Requirements | account.requirements + capability disabledReason | GET readiness | **A** read |
| Underwriting state | `moov-underwriting` GET/PUT `/underwriting` | none | **B** / **C** |
| send-funds / collect-funds / wallet / transfers | request during onboard; poll via sync | **read only** | **A** read / **C** request |
| `account.action_required` | `PaymentReadinessPanel` | readiness `verification` + `requirements` | **A** read / **D** UI (SPA still Lovable) |
| pending / errored / disconnected | `moov-sync` + webhook apply | GET snapshot; webhook persist without apply | **A** read / **E** apply |

**Read vs request:** AWS production can **READ** capabilities safely. It **cannot** REQUEST or UPDATE capabilities or underwriting. Sandbox `moov-underwriting` and onboard exist (**B**) and are unreachable while the sandbox flag is false.

---

## 4. Bank account linking / verification

| Feature | Legacy | AWS production | AWS sandbox | Class |
|---|---|---|---|---|
| Bank-link token | `moov-bank-link-token` | none | ported; does not leak public key | **B** / **C** |
| Moov.js bank Drop | `moovProvider.connectBank` + Security page script | none | none | **D** + **C** token |
| Manual bank add | `moov-bank-account-add` (`MoovBankLink`) | none | `moov-bank-account-add` | **B** / **C** |
| Micro-deposit initiate | `moov-micro-deposit-initiate` | none | ported | **B** / **C** / **D** |
| Micro-deposit confirm | `moov-micro-deposit-confirm` | none | ported | **B** / **C** / **D** |
| Plaid → Moov | `moov-plaid-bridge` | none | ported | **B** / **C** |
| Bank status sync | `moov-sync` | GET `moov-readiness` lists tenant banks + PMs | `moov-sync` | **A** tenant GET / **C** persist |
| Payment-method generation | Moov after verified bank; listed by readiness | GET readiness PMs | observe via readiness | **A** observe / **C** trigger |
| Bank replacement / disconnect | tenant: re-add; recipient: `moov-recipient-disconnect` | none | recipient disconnect ported | **B** / **C** |
| Account ownership verification | Plaid/Drop + micro-deposits | GET bank status only | same | **A** status / **C** verify |
| Platform treasury bank | `moov-platform-bank` | none | ported | **B** / **C** |

Recipient bank: `moov-recipient-bank-add` — **B** sandbox / **C** production. AWS production GET does **not** live-GET recipient banks.

---

## 5. Wallet operations

| Feature | Legacy | AWS production | AWS sandbox | Class |
|---|---|---|---|---|
| Wallet creation | `moov-wallet-sync` / `syncWallet` (`POST /wallets` if missing) | none | `moov-wallet-sync` | **B** / **C** |
| Wallet discovery | `moov-wallet-sync`, `moov-readiness` | GET `moov-readiness` wallets | both | **A** |
| `wallet.balance` capability | not a separate Moov row; parent `wallet` enabled | GET readiness | yes | **A** read |
| Available balance | `moov-wallet-sync` / readiness | GET readiness `available_cents` | `moov-wallet-sync` | **A** |
| Pending balance | same | GET readiness `pending_cents` (null if Moov omits) | yes | **A** |
| Wallet activity / ledger | `moov-wallet-sync` returns ledger + sub-ledgers | none | `moov-wallet-sync` | **B** / **C** |
| Bank → wallet funding | `initiate-wallet-funding`, `moov-wallet-fund` **CRITICAL** | create **403 blocked**; `moov-wallet-fund` `provider_disabled` | both ported | **C** live / **B** sandbox |
| Wallet → bank | sweep + credit transfer | none | sweep-config + transfers | **B** / **C** |
| Wallet → recipient | `process-funded-payment` → `moov-disburse` **CRITICAL** | `moov-disburse` blocked | ported | **C** / blocked prod |
| Wallet-to-wallet | `moov-transfer-create` | blocked | ported | **C** / blocked |
| Funding status | `moov-transfer-status` + webhook | GET `moov-transfer-status` (needs platform id + a row; Freedom has 0) | sandbox | **A** API unused / **C** live |
| Failures / returns | webhook apply + ledger | persist `applied=false` | sandbox apply when dry-run off | **E** AWS apply / **C** Lovable |
| Sweep configuration | `moov-sweep-config` | none | ported | **B** / **C** |
| Minimum-balance sweep | `minBalance` in sweep-config | none | same | **B** / **C** |
| Dashboard sweep UI | `src/lib/payments/sweeps.ts` + WalletOps | none | none | **D** + **C** |

**Wallet verdict:** AWS production can **discover and read** Freedom’s wallet. It cannot create wallets, fund, sweep, or pay in production. Funding/payout remain Lovable **CRITICAL**.

---

## 6. Stakeholder / payee onboarding

### Legacy / current production flow

```
invite (app)
  → moov-recipient-create  (AddExternalStakeholderDialog)
  → moov-recipient-session  (public token → RecipientPaymentSetup)
  → moov-recipient-kyc-update
  → moov-recipient-tos-accept
  → moov-recipient-bank-add  (manual routing/account; not Drop in this page)
  → webhook bankAccount.*  OR  remaining awaiting_bank until verified
  → eligible (onboarding_status = ready)
  → calculate-payment-funding → initiate-wallet-funding → process-funded-payment / moov-disburse
```

| Step | AWS production | AWS sandbox | Class |
|---|---|---|---|
| Invite | app | app | **D** |
| Recipient account | none | `moov-recipient-create` | **B** / **C** |
| Secure/public token | none | `moov-recipient-session` (Cognito wrap — **not** public-token equivalent) | **C**; AWS **E** for unauthenticated public token |
| KYC | none | `moov-recipient-kyc-update` | **B** / **C** |
| ToS | none | `moov-recipient-tos-accept` | **B** / **C** |
| Bank linking | none | `moov-recipient-bank-add` | **B** / **C** |
| Capability / readiness | GET `moov-readiness` classifies **RDS only**; no recipient Moov GET | `moov-sync` tenant-scoped | **A** RDS classify / **E** live recipient GET |
| Disconnect | none | `moov-recipient-disconnect` | **B** / **C** |
| Payment | blocked | ported | **C** CRITICAL |

### Why Freedom’s four recipients remain `awaiting_bank`

From M3b.8 RDS (no Moov mutation this phase):

| Environment | Count | `onboarding_status` | Bank linked | Last4 |
|---|---|---|---|---|
| production | 3 | `awaiting_bank` | yes | `1506` |
| sandbox | 1 | `awaiting_bank` | no | none |

This is **not** because AWS lacks tenant GET. Freedom-as-sender already works. Recipients stay unconfirmed because:

1. **`moov-recipient-bank-add` only sets `ready` when Moov bank `status === "verified"`.** Otherwise it stores last4 / `bank_linked_at` and leaves **`awaiting_bank`**. Last4 `1506` with `awaiting_bank` means a bank was submitted and **not yet verified** (pending verification, micro-deposits, or payment methods not enabled).
2. **Lovable `moov-webhook` is the status promoter.** On `bankAccount.*` it sets `external_payment_recipients.onboarding_status` to `ready` only if `status === "verified"`, else `awaiting_bank`. If Moov never emitted verified — or the production webhook did not apply that event — RDS stays `awaiting_bank`.
3. **AWS production GET does not live-GET recipient accounts, banks, or payment methods.** It only classifies RDS `onboarding_status`. `RECIPIENT_NOT_CONFIRMED` is therefore a **local** verdict.
4. **The sandbox recipient has no bank at all.**
5. **AWS has no production recipient write/apply path.** Sandbox `moov-recipient-bank-add` even uses a different status (`awaiting_verification`) than Lovable (`awaiting_bank`) — a behavioral difference if sandbox were ever enabled.
6. Live UI (`RecipientPaymentSetup`) still calls Supabase, not AWS.

Do **not** onboard or PATCH these rows this phase. Next diagnostic (later GO) is GET-only recipient account/bank/PM on Moov, still without mutation.

---

## 7. ACH / money movement

| Feature | Legacy | AWS production | Class |
|---|---|---|---|
| ACH credit standard | `moov-transfer-create` / `moov-disburse` | handler **403 blocked** | **C** live / blocked AWS write |
| ACH credit same-day | same (`speed` / PM `ach-credit-same-day`) | blocked | same |
| ACH debit fund | `initiate-wallet-funding`, `moov-wallet-fund` | blocked / `provider_disabled` | **C** |
| ACH debit collect | collect-funds + `ach-debit-collect` PM | observe via GET readiness | **A** observe / **C** execute |
| Transfer create | `moov-transfer-create` **CRITICAL** | `POST /functions/v1/moov-transfer-create` blocked | blocked until SQL72 + flags + platform id |
| Transfer groups | `moov-transfer-group-create` | none (not in production money set) | **B** / **C** |
| Disbursement | `moov-disburse` **CRITICAL** | `POST .../moov-disburse` blocked | **C** |
| Funding plan | `calculate-payment-funding` | none | **B** / **C** |
| Funding execute | `initiate-wallet-funding` **CRITICAL** | none | **C** |
| Auto-fund on clear | `wallet-fund-on-clear` **CRITICAL** | none | **B** / **C** |
| Status | `moov-transfer-status` + webhook | GET `moov-transfer-status` (platform id missing; 0 rows) | **A** API gated / **C** |
| Cancellation | `cancel-wallet-funding` (funding request, not Moov ACH cancel) | none | **B** / **C** |
| Moov transfer cancel / reverse API | **E** (no dedicated cancel-transfer function) | none | **E** |
| Return / reversal | webhook apply + ledger | persist, `applied=false` | **E** AWS / **C** Lovable |
| Reconciliation | webhook + `payment_transfers` | unique event id + GET status; 0 rows | **A** schema / **E** live apply |
| Idempotency | Edge `X-Idempotency-Key` + `payment_idempotency_keys` | AWS key + unique `(tenant, idempotency_key)` **SQL72 NOT_APPLIED** | **E** until SQL72 |
| Fees / invoices / deductible | `moov-tenant-fee-charge`, `moov-invoice`, `homeowner-deductible-pay` | none | **B** / **C** **CRITICAL** if used |

**First-transfer vs full rollout**

| First controlled live transfer needs | Full rollout needs |
|---|---|
| SQL72 applied | Recipient pipeline on AWS **or** remaining Lovable until neutralized |
| `MOOV_PLATFORM_ACCOUNT_ID` | Authoritative webhook apply |
| Money flags still **false** until explicit GO | Recipient PM confirmation (not `awaiting_bank`) |
| Dark webhook registered + secret loaded | Broad tenant onboarding on AWS |
| One **verified** eligible recipient + funded source | Neutralize Lovable money functions |
| Lovable webhook still on **or** AWS apply enabled | Sweeps / min-balance (later) |

---

## 8. Webhooks

Legend: receipt / verify / persist / apply / idempotency / out-of-order / UI refresh.

| Event | Lovable (`moov-webhook`) | AWS dark handler | Class |
|---|---|---|---|
| `transfer.created` | apply → `payment_transfers` + ledger + funding sync | persist, `applied=false` | receipt **A**; apply **E** |
| `transfer.updated` | same | persist, `applied=false` | same |
| `account.updated` | last_webhook_* on `payment_provider_accounts` | persist, no apply | **E** apply |
| `capability.updated` | same family as account | persist, no apply | **E** apply |
| `bankAccount.created` | method verification + **recipient `ready` iff verified** | persist, no apply | **E** apply |
| `bankAccount.updated` | same | persist, no apply | **E** apply |
| `paymentMethod.enabled` | not a dedicated branch (falls through unless transfer id present) | persist, no apply | **E** apply |
| `paymentMethod.disabled` | same | persist, no apply | **E** apply |

| Concern | AWS today |
|---|---|
| Receipt | **A** (`POST /webhooks/moov`) |
| Signature verify | **A** code (HMAC-SHA512 `timestamp\|nonce\|webhookID`); secret **not loaded** |
| Persistence | **A** `webhook_receipts` / provider receipts table |
| Authoritative apply | **E** (`PRODUCTION_MOOV_WEBHOOK_APPLY_ENABLED=false`; always `applied=false`) |
| Idempotency | **A** unique `(provider, external_event_id)` |
| Out-of-order | rank computed on the dark apply stub, **not used** to write status | **E** |
| UI / status refresh | **C** Lovable panels; AWS GET readiness is pull-only |

**Apply logic still to migrate before webhook cutover** (from `supabase/functions/moov-webhook/index.ts`; do not port this phase):

- `transfer.created` / `transfer.updated` → upsert `payment_transfers` by `provider_transfer_id`; map status; **do not** move a terminal funding row backwards; `postTransferLedger`; `syncFundingRequest` → `process-funded-payment`
- `bankAccount.*` → `payment_provider_methods` verification; **recipient** `onboarding_status` `ready` vs `awaiting_bank`; stakeholder last4/verification
- `account.*` / `capability.*` / verification / representative → `last_webhook_event_*` (full capability cache is still mostly `moov-sync`, not webhook)
- `paymentMethod.enabled` / `disabled` → **not fully implemented on Lovable either** (gap on both; **E**). Cutover should add this rather than copy a hole.
- Dispute events → `failure_reason` on transfer

Until apply exists **and** has been dual-run, **do not** disable the Lovable webhook.

---

## 9. Sweeps / minimum balance

| Feature | Legacy | Current Moov | AWS | Class |
|---|---|---|---|---|
| Minimum wallet balance | `moov-sweep-config` `minBalance` | Moov wallet sweep-config API | sandbox port only | **B** / **C** |
| Sweep destination | bank payment method id | same | sandbox | **B** / **C** |
| Sweep frequency | provider-side daily; client does not schedule | same | sandbox | **B** / **C** |
| Tenant configuration | Edge PUT + `src/lib/payments/sweeps.ts` | none in prod | **C** / **D** |
| Dashboard / API management | WalletOps + Edge | none | **C** / **D** |
| Disable / change sweeps | Edge PUT | none | **C** |
| Reconciliation | webhook + ledger, not a sweep-specific job | — | **E** |

Do **not** configure any sweep. Sweeps are **P2** after first transfer and webhook apply. They move money automatically.

---

## 10. Frontend parity

Production SPA: `src/lib/awsStaging.ts` — `VITE_AUTH_PROVIDER=cognito` is **never** set on ChecksOps.com. All `supabase.functions.invoke` calls hit Lovable.

| Surface | Component / page | AWS API | Lovable | State |
|---|---|---|---|---|
| Tenant onboarding | `PaymentOnboardingDialog.tsx` | no | `moov-account-onboard` | **C** + **D** |
| Security / Compliance | `ComplianceSettings.tsx`, `Security.tsx` (Moov.js) | no | ToS/bank tokens | **C** + **D** |
| Underwriting | `UnderwritingQuestionnairePanel.tsx` | no | `moov-underwriting` | **C** |
| WalletOps | `WalletOps.tsx`, `useWalletOps.ts` | GET readiness unused by prod SPA | `moov-readiness`, `moov-transfer-status` | **A** API / **C** UI |
| Stakeholder setup | `RecipientPaymentSetup.tsx`, `AddExternalStakeholderDialog.tsx` | no | `moov-recipient-*` | **C** |
| Bank connection | `MoovBankLink.tsx`, `MicroDepositVerification.tsx` | no | bank-add + micro-deposits + `moov-sync` | **C** + **D** |
| Wallet / balance | WalletOps + `PaymentReadinessPanel` | GET readiness | `moov-wallet-sync`, readiness | **A** API / **C** UI |
| Funding | `useAutoFunding.ts`, `DisbursementConsole` | blocked | `initiate-wallet-funding` | **C** |
| Payment / disbursement | `DisbursementConsole.tsx`, `RunPayrollDialog.tsx` | blocked | `moov-disburse` | **C** |
| Capability / action-required | `PaymentReadinessPanel.tsx` | GET readiness unused by SPA | `moov-readiness` | **A** API / **C** UI |
| Account settings | `TenantPaymentAccountPanel.tsx`, `PaymentAccountPanel.tsx` | no | `moov-account-create`, `moov-sync`, onboarding-link | **C** |
| Sweep settings | `src/lib/payments/sweeps.ts` | no | `moov-sweep-config` | **C** |
| Transfer history | WalletOps | GET transfer-status unused | Edge + webhook | **A** API unused / **C** |
| Verification files | `verificationFiles.ts` | no | `moov-account-file-*` | **C** |
| Platform bank / treasury | `PlatformBankPanel`, `PlatformTreasuryPanel` | no | `moov-platform-bank`, `platform-treasury` | **C** |
| Invoices | `useMoovInvoices.ts` | no | `moov-invoice` | **C** |
| Fees | `feeSchedules.ts`, `AdminTenants` | no | fee-* + `moov-tenant-fee-charge` | **C** |

No production page is AWS-API-backed today.

---

## 11. Legacy Lovable dependencies (production Moov)

Live product requires these until AWS production writes + apply + SPA swap exist. **CRITICAL** = can create a Moov transfer or otherwise move money.

### Tenant onboarding / KYC / KYB

| Function | Required for | CRITICAL |
|---|---|---|
| `moov-account-create` | onboarding | |
| `moov-account-onboard` | onboarding / KYB | |
| `moov-onboarding-link` | onboarding | |
| `moov-account-files` | onboarding / KYC docs | |
| `moov-account-file-upload` | onboarding / KYC docs | |
| `moov-account-file-view` | onboarding / KYC docs | |
| `moov-underwriting` | onboarding / underwriting | |
| `moov-selftest` | admin | |
| `moov-account-discover` | admin diagnostic | |

### ToS

| Function | Required for | CRITICAL |
|---|---|---|
| `moov-tos-token` | ToS Drop | |
| `moov-tos-accept` | ToS | |

### Bank

| Function | Required for | CRITICAL |
|---|---|---|
| `moov-bank-link-token` | bank Drop | |
| `moov-bank-account-add` | bank | |
| `moov-micro-deposit-initiate` | bank | |
| `moov-micro-deposit-confirm` | bank | |
| `moov-plaid-bridge` | bank / recipient | |
| `moov-platform-bank` | admin / platform bank | |
| `moov-sync` | bank / admin / readiness persist | |

### Wallet / admin reads

| Function | Required for | CRITICAL |
|---|---|---|
| `moov-readiness` | admin / readiness (prod SPA) | |
| `moov-wallet-sync` | wallet | |
| `moov-transfer-status` | money movement / admin | |
| `moov-sweep-config` | sweep | |

### Recipient

| Function | Required for | CRITICAL |
|---|---|---|
| `moov-recipient-create` | recipient | |
| `moov-recipient-session` | recipient | |
| `moov-recipient-kyc-update` | recipient | |
| `moov-recipient-tos-accept` | recipient | |
| `moov-recipient-bank-add` | recipient | |
| `moov-recipient-disconnect` | recipient | |
| `stakeholder-resend-verification` | recipient / admin | |

### Money movement

| Function | Required for | CRITICAL |
|---|---|---|
| `moov-transfer-create` | money movement | **CRITICAL** |
| `moov-transfer-group-create` | money movement | **CRITICAL** |
| `moov-disburse` | money movement | **CRITICAL** |
| `moov-wallet-fund` | wallet / money movement | **CRITICAL** |
| `initiate-wallet-funding` | wallet / money movement | **CRITICAL** |
| `cancel-wallet-funding` | wallet | |
| `calculate-payment-funding` | money movement | |
| `process-funded-payment` | money movement | **CRITICAL** |
| `wallet-fund-on-clear` | money movement | **CRITICAL** |
| `platform-treasury` | money movement / admin | **CRITICAL** |
| `homeowner-deductible-pay` | money movement | **CRITICAL** |
| `moov-tenant-fee-charge` | money movement / admin | **CRITICAL** |
| `moov-invoice` / `public-invoice` | money movement if send/pay used | **CRITICAL** if send/pay |
| `moov-fee-schedule-upsert` | admin | |
| `moov-fee-schedule-cancel` | admin | |
| `moov-fee-rollup` | admin | |
| `moov-bulk-import-preview` | admin (not money path) | |

### Webhook

| Function | Required for | CRITICAL |
|---|---|---|
| `moov-webhook` | webhook (authoritative apply + funding kick) | **CRITICAL** (state, not create) |

Freedom-as-sender GET does **not** remove any of these from the live product.

---

## 12. AWS build gaps (do not build this phase)

### Already on AWS (not gaps)

- GET `moov-readiness` (live tenant account, ToS read, capabilities, wallets, banks, payment methods, RDS recipient classify)
- GET `moov-transfer-status` (live facilitator GET **blocked** until platform id)
- POST `/webhooks/moov` dark receipt + HMAC verify + persist + unique event id
- POST `moov-transfer-create` / `moov-disburse` **code**, unreachable
- Sandbox ports of essentially every Lovable Moov function name (**B**, flag off)

### Still required for 100% production parity

See P0 / P1 / P2. “Parity verified” sandbox ports are **not** production modules.

---

## 13. P0 / P1 / P2

### P0 — required before first real Moov transfer

**Ops (no code in this phase):**

1. Human: register **new** AWS Dashboard webhook → `https://checksops.com/prep/webhooks/moov` (M3b.9). Do not edit Lovable.
2. Load `MOOV_WEBHOOK_SECRET` into `checksops/production/provider` (never print).
3. Add `MOOV_PLATFORM_ACCOUNT_ID` (fingerprint `41cb5d67…2208`) to the same secret.
4. Apply SQL72 (`payment_transfers.idempotency_key` UNIQUE / `provider_http_attempted_at`) — **after** review, not this phase.
5. Confirm **one** eligible recipient (Moov bank **verified**, RDS not `awaiting_bank`) via GET-only diagnose, then Lovable or a later AWS path.

**P0 code still missing (do not build now):**

- GET-only **recipient** live inventory (account / banks / payment methods) so `awaiting_bank` is explained from Moov, not RDS alone.
- Production `moov-wallet-fund` / `initiate-wallet-funding` holds-gated handlers (today only transfer-create/disburse are in the production money set). First transfer may use `moov-transfer-create` from a **bank** source at $0 wallet — still needs an eligible destination.

Money flags stay **false** during any P0 build.

### P1 — required before broad tenant / recipient rollout

1. Holds-gated production ports of tenant writes: `moov-account-create`, `moov-account-onboard`, `moov-tos-accept`, `moov-tos-token`, `moov-underwriting`, files, `moov-sync` persist.
2. Production bank writes: bank-link token, bank-add, micro-deposits, plaid-bridge.
3. Production **recipient** pipeline including **public** `moov-recipient-session` (no Cognito requirement).
4. Authoritative webhook apply behind `PRODUCTION_MOOV_WEBHOOK_APPLY_ENABLED=false` until dual-run.
5. Out-of-order / status-monotonic apply + funding kick without double-pay.
6. `paymentMethod.enabled` / `disabled` apply (missing on Lovable too).
7. Wire production SPA to AWS GET readiness without disabling Lovable.
8. Production wallet-sync / funding handlers holds-gated.

### P2 — operational / admin

1. Sweep config production route + dashboard AWS client.
2. Signed file-view URLs.
3. Moov transfer cancel if product requires it.
4. ToS reacceptance / version change.
5. Recipient `awaiting_bank` repair/reconcile tooling.
6. Fee / invoice / platform-treasury production ports.
7. Neutralize / stub Lovable money functions after dual-run.

---

## 14. Recommended migration sequence

| # | Step | Why this order | Depends on |
|---|---|---|---|
| 1 | Onboarding parity (P1 writes, flags-off) | New tenants cannot be created on AWS; Freedom is already done | GET readiness **A** already |
| 2 | Recipient readiness | First transfer needs a verified payee; four Freedom rows are `awaiting_bank`; production AWS has **no** recipient writes | GET-only recipient Moov diagnose; then port or keep Lovable until eligible |
| 3 | Wallet / bank parity | Funding and replacement still Lovable CRITICAL | Tenant bank already verified for Freedom |
| 4 | Webhook dark registration | Need events in receipts before apply | M3b.9 human Dashboard + secret |
| 5 | Authoritative webhook apply | Cannot cut over or trust AWS status without apply | Dark receipts proving verify; feature flag |
| 6 | Legacy Lovable neutralization | Only after AWS writes + apply + UI swap match Edge | Dual-run; money flags still false |
| 7 | SQL72 / idempotent transfer activation | Unique key before first POST | Schema apply; still no money until GO |
| 8 | First controlled live transfer | Single small ACH after flags GO | P0 ops + eligible recipient + apply **or** Lovable webhook still on |
| 9 | Broad production rollout | Other tenants / recipients | P1 complete |
| 10 | Sweeps / minimum balance | Moves money automatically; last | Stable transfers + apply + reconcile |

---

## 15. Phases remaining (not calendar time)

| Phase | Content |
|---|---|
| **M4** | This audit — **STOP FOR REVIEW** |
| **M5** | P0 ops: webhook dark register + secret + `MOOV_PLATFORM_ACCOUNT_ID` (no money) |
| **M6** | Recipient GET-diagnose + eligibility repair plan (no onboard unless GO) |
| **M7** | Authoritative apply module behind flag=false; dual-run receipts |
| **M8** | P1 production write ports (onboarding, bank, recipient, public session) still holds-gated |
| **M9** | SQL72 + transfer idempotency proof without live money |
| **M10** | First controlled live transfer (explicit GO) |
| **M11** | Neutralize Lovable; SPA AWS wiring |
| **M12** | Sweeps / min-balance |

≈ **8 phases after M4** to full parity. **First live transfer is not the next phase.**

---

## 16. GO / NO-GO for beginning the first missing P0 build

**NO-GO.**

Reasons:

- This phase is audit-only (**STOP FOR REVIEW**).
- First missing P0 is **operational** (Dashboard webhook + secrets), and M3b.9 already forbade agent registration.
- SQL72 and money flags remain forbidden.
- Recipients are not confirmed ready (RDS `awaiting_bank` despite last4 on three production rows).
- Authoritative apply is a stub (`applied=false`).
- Reviewer must accept this matrix before any P0 ops.

When review passes, the first allowed P0 action is **human webhook registration + secret load + platform account id** — still **zero money movement**.

---

## Evidence

- Legacy tree: `git ls-tree b53db94a:supabase/functions` — 38 `moov-*` plus `initiate-wallet-funding` / `process-funded-payment`.
- HEAD adds `moov-recipient-kyc-update` only (among `moov-*`).
- AWS production: `aws/functions/api/providers/production/moov-read.mjs`, `moov-transfer.mjs`, `moov-webhook-apply.mjs`, `moov-dispatch.mjs`, `moov-holds.mjs`.
- AWS sandbox: `aws/functions/api/providers/parity/moov-functions.mjs` (includes `moov-recipient-*`).
- Dispatch: production money flags true → `403 production_execution_blocked`; else sandbox flag → parity; else stubs.
- Frontend: `src/lib/awsStaging.ts` default off; `src/lib/payments/providers/moovProvider.ts` always `supabase.functions.invoke`.
- Prior: M3b.8 inventory, M3b.9 webhook dark setup, `LOVABLE_AWS_PROVIDER_PARITY.md` (sandbox, not A).
- Recipient status rule: `supabase/functions/moov-recipient-bank-add/index.ts` and `moov-webhook` `bankAccount.*` handler.
