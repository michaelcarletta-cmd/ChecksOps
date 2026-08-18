# Moov & Money-Movement Audit — ChecksOps

Read-only inspection of every payment surface, plus a build sequence to reach a multi-rail Moov payout hub.

## 1. Already built and working

**Provider abstraction (frontend)**
- `src/lib/payments/types.ts` — provider-neutral domain model: `PaymentProviderId` (actum | plaid | moov), `PaymentSpeed` (standard | same_day | instant), `PaymentStatus`, `PaymentProvider` interface, status label maps.
- `src/lib/payments/featureFlags.ts` — `PAYMENT_FLAGS` (USE_ACTUM/USE_PLAID/USE_MOOV/SHOW_PAYMENT_SETTINGS/SHOW_PAYMENT_ADMIN), `isMoovAllowedForTenant()`, `resolveProvider()` with legacy `payment_rail` fallback.
- `src/lib/payments/paymentService.ts` + `providers/{actumProvider,plaidProvider,moovProvider,tenantAccount}.ts` + `providers/index.ts` registry.
- Hooks: `usePaymentAccount`, `usePaymentProviderEligibility` (`tenants.moov_allowlisted`, `moov_environment`), `usePaymentRail`, `useWallet`, `usePlatformFees`.
- UI: `components/payments/{PaymentAccountPanel,WalletPanel,SendPaymentPanel,PlatformFeeSchedulePanel,PaymentProviderAdmin,FundsTab,ClaimLedgerCard}`, `pages/payments/PaymentSettingsTab.tsx`, `settings/TenantPaymentAccountPanel.tsx`, `pages/RecipientPaymentSetup.tsx`, `payroll/RunPayrollDialog.tsx`.

**Moov backend (19 edge functions)**
- Onboarding/account: `moov-account-create`, `moov-onboarding-link`, `moov-sync`, `moov-selftest`.
- Bank linking: `moov-bank-link-token`, `moov-plaid-bridge` (Plaid processor token → Moov), `moov-micro-deposit-initiate` / `-confirm`.
- Recipients: `moov-recipient-create` (issues `external_payment_recipients.secure_token`), `moov-recipient-session` (token-scoped recipient onboarding).
- Money movement: `moov-transfer-create`, `moov-transfer-group-create` (multi-leg + facilitator fee), `moov-disburse` (batch payout), `moov-wallet-fund`, `moov-wallet-sync`, `wallet-fund-on-clear`.
- Platform revenue: `moov-fee-schedule-upsert`, `-cancel`, `moov-fee-rollup`.
- Lifecycle: `moov-webhook` — HMAC over `id.timestamp.body`, 5-minute replay window, idempotent via unique `payment_webhook_events(provider, external_event_id)`, updates transfer status and writes wallet ledger entries.
- Shared: `_shared/moovClient.ts` (OAuth scope-cached token, `moovFetch`, `normalizeTransferStatus`, `capabilityFlags`), `_shared/moovGuard.ts` (`requireMoovCaller`, `logPaymentEvent`, `sanitize`), `_shared/moovWallet.ts`.

**Schema (verified in the live database)**
- `payment_provider_accounts`, `payment_provider_methods`, `payment_transfers` (incl. `transfer_group_id`, `leg_role`, `is_facilitator_fee`, `wallet_id`, `platform_fee_cents`, `speed`), `payment_wallets`, `payment_webhook_events`, `platform_fee_schedules`, `external_payment_recipients`.
- `disbursement_batches` carries `rail`, `delivery_speed`, `moov_transfer_group_id`; `disbursement_splits` carries `rail`, `moov_transfer_id`, `moov_status`, `moov_failure_reason` alongside the Actum and Plaid columns.
- `stakeholder_accounts` holds Actum (`chk_aba`, `consumer_unique`, Authentecheck fields), Plaid (`plaid_*`) and Moov (`provider`, `provider_account_id`, `provider_bank_account_id`) linkage in one row.

**Routing that works today**
`DisbursementConsole.tsx` tries `moov-disburse` first; on a recoverable 409 (`recipient_setup_required`, `payer_setup_required`, `insufficient_balance`) it falls back to `actum-disburse` or `plaid-disburse` for the **whole batch**, never partially. `moov-disburse` resolves every destination before moving any money.

## 2. Partial or planned but incomplete

- **Speed is cosmetic.** `payment_transfers.speed` and `disbursement_batches.delivery_speed` are stored, and the console prices Next Day $0.75 / Same Day $1.00, but `moov-transfer-create` and `moov-disburse` never send a rail/`ach-same-day` preference in the Moov `/transfers` body. Every payout is standard ACH regardless of what the user paid for.
- **`instant` exists in `PaymentSpeed`** but no RTP/FedNow code path anywhere.
- **Wallet is fund + sync only.** `moov-wallet-fund` and `wallet-fund-on-clear` credit the balance; `moov-disburse` accepts `source_kind: "wallet"` but there is no user-visible "pay from balance vs. bank" decision surface beyond the funding-source selector, and no auto-sweep or low-balance guard.
- **Recipient links are setup-only.** `moov-recipient-create` / `-session` / `RecipientPaymentSetup.tsx` collect a bank account; the recipient never chooses a payout method or speed.
- **Reconciliation is per-transfer.** `payment_webhook_events` and `logPaymentEvent` capture events, but there is no return/NOC (R01/R02/R03) handling path on the Moov side, no reconciliation view, and no retry queue.
- **Actum/Plaid overlap.** Three disbursement functions and three verification widgets (`AuthentecheckVerification`, `PlaidVerification`, `BankVerification`) with per-rail columns on the same tables. Intentional (do not delete), but the split fields make routing logic duplicated.
- **`moovProvider.receivePayment`** throws by design; inbound stays on CheckAlt.

## 3. End-to-end architecture today

```text
Check deposited (CheckAlt) → clears → wallet-fund-on-clear → moov-wallet-fund
                                                              → payment_wallets

Funds tab → CheckStakeholdersManager → disbursement_batches + disbursement_splits
   → DisbursementConsole
       ├─ moov-disburse ──► resolve all stakeholder_accounts.provider='moov'
       │      all ready → Moov /transfers (standard ACH) → payment_transfers
       │      any unready → 409 recipient_setup_required
       └─ fallback → actum-disburse | plaid-disburse (whole batch)

moov-webhook → payment_webhook_events → payment_transfers.status
             → wallet ledger → disbursement_splits.moov_status
             → recompute_check_release_stage → Funds Released / Received

Platform revenue: platform_fee_schedules → moov-fee-schedule-upsert → moov-fee-rollup
```

## 4. Gaps vs. a multi-rail Moov payout hub

| Capability | State | Gap |
|---|---|---|
| Standard ACH | Working | — |
| Same-day ACH | Priced, not requested | Send `ach-same-day` rail + cutoff-time validation |
| Instant / RTP / FedNow | Absent | Rail eligibility per bank, `rtp-credit` transfer, amount caps |
| Push-to-card | Absent | No card payment methods, no `card-payment` scope, no PAN capture flow |
| Moov wallet payouts | Partial | No balance-first routing policy, no auto top-up, no low-balance block |
| Recipient choice links | Partial | Setup only — no method/speed election by recipient |
| Smart routing / fallback | Batch-level only | No per-recipient rail scoring, no downgrade instant→same-day→standard, no per-split fallback |
| Lifecycle tracking | Partial | No returns/NOC handling, no reconciliation dashboard, no retry queue |

## 5. Prioritized implementation sequence (reuses existing code)

1. **Make speed real.** Map `PaymentSpeed` → Moov rail inside `_shared/moovClient.ts` and pass it from `moov-transfer-create` and `moov-disburse`. No schema change — `speed` / `delivery_speed` already exist.
2. **Rail eligibility per payment method.** Add `supported_rails jsonb` + `rtp_eligible boolean` to `payment_provider_methods` and `stakeholder_accounts`; populate during `moov-sync` and `moov-plaid-bridge`.
3. **Routing engine.** New `_shared/railRouter.ts` returning the best rail per split from requested speed, eligibility, amount caps and cutoff time, with an automatic downgrade chain. `moov-disburse` calls it per split instead of assuming standard ACH.
4. **Per-split fallback.** Relax `moov-disburse`'s all-or-nothing rule to per-recipient routing, leaving only truly unready recipients on the legacy rail; keep the current 409 shape so `DisbursementConsole` still works.
5. **Returns / NOC.** Extend `moov-webhook`'s `handleEvent` for `transfer.failed`, return codes and NOC updates → reverse wallet ledger entries, set `disbursement_splits.moov_failure_reason`, surface in a Reconciliation panel next to the existing Loss Prevention tab.
6. **Wallet-first routing.** Policy on the tenant row (`payout_funding_preference`) consumed by `moov-disburse`'s existing `source_kind`; add auto top-up through `moov-wallet-fund`.
7. **Recipient choice links.** Extend `moov-recipient-session` and `RecipientPaymentSetup.tsx` so the recipient picks method and speed; persist election on `external_payment_recipients` / `stakeholder_accounts`.
8. **Push-to-card.** Last — new card scope, card payment method rows reusing `payment_provider_methods`, fee schedule entry, and card as the top rail in the router.
9. **Payout hub view.** One transfer-lifecycle screen over `payment_transfers` + `payment_events` + `payment_webhook_events`, reusing `PAYMENT_TRANSFER_STATUS_LABEL`.

Actum, Authentecheck and Plaid code stays untouched throughout — the router only ever chooses among rails, never removes one.
