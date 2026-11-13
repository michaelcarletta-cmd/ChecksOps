# One-time transfer from wallet to bank (design)

Status: **design, owner decisions recorded 2026-11-13 (§9)**. Nothing here is built, applied or deployed. Each later step is its own reviewed PR and its own owner approval (CLAUDE.md, "How ChecksOps ships").

Owner request (2026-11-12): "Wallet & Treasury – we should add a one time transfer TO bank FROM wallet." The owner chose "Design first".

## 1. Why, and how it relates to sweeps

- Today money moves into the tenant's Moov wallet ("Add funds from bank", `moov-wallet-fund`) and out of it to recipients ("Send", `moov-disburse` → `moov-send.mjs`). Nothing lets a tenant move its own balance back to its own bank.
- Sweeps ("automatic payouts") would do that on a schedule. They are not used (`docs/MOOV_PAYMENTS_RULES.md:77-78`), production refuses every sweep-configuration write (`aws/functions/api/providers.mjs:413-421`, `production_execution_blocked`), and the UI hides them (`PAYMENT_FLAGS.SHOW_AUTOMATIC_PAYOUTS = false`, PR #1834).
- This feature is the **manual, one-time** alternative: one click, one amount, one transfer to the tenant's own settlement bank. It configures nothing recurring and does not touch sweep configuration.

## 2. User flow (Wallet & Treasury)

1. A **"Transfer to bank"** button next to "Add funds". It shows only when:
   - the **operating** wallet is active (the trust wallet is excluded);
   - available balance > 0;
   - a settlement bank exists, verified and connected, with an ACH-credit payment method in Moov;
   - the user is a member of the tenant. Any member may transfer, as with funding.
2. Dialog:
   - **Amount**: any amount up to the available balance, in dollars with two decimals. The default is empty, and a "Transfer all available" shortcut fills it. It is capped at the wallet's **available** balance read from Moov at submit time, and at the tenant's own limits if it set any (§5a). Pending funds are never transferable.
   - **To**: the tenant's own settlement bank, shown as name ••last4. It is the same row the Settlement bank tile shows (`payment_provider_methods`, default first; `aws/functions/api/providers/parity/sweep-read.mjs:227-237`). The bank cannot be changed in this dialog, and there is no free-text destination.
   - **Speed**: same-day ACH (`ach-credit-same-day`). Before the ACH same-day cutoff the credit arrives the same banking day. After the cutoff, or on a weekend or bank holiday, it settles the next banking day. The dialog says which applies before confirming, using the wording the sweep rails already use (`src/lib/payments/sweeps.ts:31`): "Arrives today" before the cutoff, otherwise "Arrives next banking day (sent after today's same-day cutoff)". The server, not the browser clock, decides the expected date and returns it.
   - If the bank has no same-day ACH-credit method, the button is disabled with "Your bank does not accept same-day transfers yet." There is no fallback to standard ACH.
   - **Fee**: none. The dialog says "No fee".
3. **Confirm** screen: "Send $X from your ChecksOps balance to BANK ••1234 by same-day ACH. Expected: <date>. No fee. This cannot be cancelled once sent."
4. **Two-factor step-up**: the same pattern as funding (§4). If no fresh step-up exists, the server answers `totp_required`. The app asks for the code and retries with the same idempotency key.
5. **Result**: "Transfer started. Expected at your bank <date>." The row then appears in **Recent Wallet Activity** as **"Transfer to bank"**, with status Pending, then Completed, or Failed / Returned.

## 3. API: new production handler `moov-wallet-withdraw`

A new file, `aws/functions/api/providers/production/moov-wallet-withdraw.mjs`, modelled line by line on `moov-wallet-fund.mjs`.

- **Routing**: one branch in `providers.mjs` next to the funding branch (`providers.mjs:378-381`), behind `executionAllowed('moov')`. Without that branch the call falls into the production hard block (`providers.mjs:413-421`). That is the safe default until the API ships.
- **Gates** (the same as funding, `moov-wallet-fund.mjs:431-458`):
  - `financialPermissionsActivated()` is on and sandbox execution is off;
  - the caller is a member of the tenant (platform roles never move a tenant's money, `:447`);
  - `AWS_MOOV_TRANSFER_POST_ENABLED` holds new posts (`transferPostEnabled`, `:44`, `:241-243`).
- **Wallet type**: `operating` only. Any other `wallet_type`, including `trust`, is refused with 400 (funding accepts both, `:220-221`).
- **Amount**: whole positive cents (`parseFundAmountCents`, `:47`). Then re-read the wallet from Moov (`syncWalletReadOnly`, as at `:259-266`) and refuse `insufficient_available_balance` if amount > available. Funding has "no business limit" (`:4`, `:46`); withdrawal must check the balance. There is no platform cap. If the tenant has set a per-transfer or daily limit (§5a), refuse `tenant_limit_exceeded` above it. The daily total is the sum of the tenant's non-failed `wallet_withdrawal` rows that banking day, counted in the same transaction.
- **Fee**: none. `platform_fee_cents = 0` and `net_amount_cents = amount_cents`.
- **Who**: any member of the tenant, with no second-admin approval.
- **Destination**:
  - the tenant's own connected, verified bank with an `ach-credit-same-day` payment method from `/accounts/{id}/payment-methods`. If none exists, refuse `same_day_unavailable`;
  - the counterpart of `selectDebitMethod` (`:159`), as a `selectCreditMethod`;
  - more than one bank means `bank_choice_required`, the same rule as funding (`:276-281`);
  - never a recipient or `external_recipient_id` method.
- **Source**: the wallet's `moov-wallet` payment method (`wallet.provider_payment_method_id`).
- **Idempotency** (the same contract as funding, `:1-16`):
  - The browser sends a UUID per click, and the key is `wallet-withdraw:<uuid>`.
  - The `payment_transfers` row is committed **before** Moov is called and claimed ready → submitting, so two racing requests cannot both POST (`:300-345`).
  - Moov's `X-Idempotency-Key` is the transfer row id (`:358`).
  - A replay with the same key and a different amount, bank or wallet is `idempotency_key_reused` (`:246-249`, `:291-297`).
  - An error that does not prove Moov refused is recorded as `unknown` and never retried automatically (`:370`).
- **Row**:
  - `leg_role = 'wallet_withdrawal'`;
  - `source_*` = the wallet, `destination_*` = the tenant's bank;
  - `provider_metadata` holds the source and destination Moov method ids, the rail, `stepup_id`, and `checksops_leg: 'wallet_withdrawal'`;
  - `created_by`;
  - plus a `payment_event_log` row (as at `:84-100`).
- **Moov call**: `POST /accounts/{facilitator}/transfers`, with source = the wallet payment method, destination = the bank's ACH-credit payment method, and amount in USD cents. The metadata carries the ChecksOps transfer and tenant ids, as funding does at `:360-366`.
- **GUCs**: the same `request.financial_execution` and user bindings as `bindRequestGucs` (`:60-68`), plus `setMoneyWriteFlag(client)` before every money-table write (`aws/functions/api/money-write-flag.mjs:33`). Writes then keep working once SQL 136's restrictive policy is in force.
- **Step-up**:
  - Reuse `loadSessionFundStepUp` and `WALLET_FUND_TOTP_ACTION` (`providers/production/moov-fund-authz.mjs:12`, `:56`). The verification must be at most 15 minutes old (`:19`, owner decision 2026-10-31, finding 7) and bound to this login.
  - If no such verification exists, return `totp_required` with `actionKey: 'wallet.fund'`, so the existing code-entry flow in `auth-financial-totp.mjs:716-719` works unchanged.
  - One code covers funding, sends and withdrawals in the same login (owner decision 7).
- **Errors**: always say "Nothing was sent" when nothing was sent, as the funding handler does.

## 4. Status updates (webhooks and catch-up)

- Moov `transfer.updated` webhooks are applied by the SQL 109 writer. It refuses rows whose `leg_role` is not in `('wallet_funding', 'send_wallet', 'send_bank')` and returns `not_owned` (`aws/workflows/sql/109_moov_transfer_webhook_status.sql:194`). The status catch-up writer (SQL 146) has the same list (`146_moov_status_catch_up_writes.sql:251`).
- Without a change, a `wallet_withdrawal` row would stay `pending` forever. So the leg must be added to both writers in a new numbered migration. That covers completed, failed, returned (ACH R-codes) and NOC recording, the same as funding.
- On **failure or return** the money comes back to the wallet in Moov. The UI shows Failed or Returned with the reason, and the event log keeps the R-code. Nothing is retried automatically, and the tenant can start a new transfer.

## 5. Data

- `payment_transfers.leg_role` has no CHECK constraint, so no enum change is needed. **A new numbered migration is still needed** to:
  1. add `'wallet_withdrawal'` to the leg list in the SQL 109 webhook writer and the SQL 146 catch-up writer (new function versions, append-only; the old migrations are not edited);
  2. confirm the existing `payment_transfers` and `payment_event_log` RLS and grants allow the API's insert and update for this leg under the money-write flag. If the SQL 136 restrictive policy enumerates legs, extend it in the same migration;
  3. add the tenant limit columns (§5a);
  4. optionally add a partial index on `(tenant_id, leg_role, created_at)` for the daily-limit sum and Recent Wallet Activity. This is to be measured, not assumed.
- No new table. No production data is migrated.

### 5a. Tenant-configurable limits

- **No platform default cap.** A tenant may set its own limits, and both are empty by default (no limit):
  - `wallet_withdraw_max_per_transfer_cents` (bigint, null = none);
  - `wallet_withdraw_max_per_day_cents` (bigint, null = none).
- **Where:** next to the existing funding-bank setting, in `public.tenant_wallet_funding_settings` (read by `moov-wallet-fund.mjs:128-143`). Both are new nullable columns, positive when set, added in the new numbered migration. The existing RLS and grants on that table apply; the migration checks that a tenant member can update only their own tenant's row.
- **UI:** Payment Settings gets "Transfer to bank limits" (per transfer, per day), blank meaning no limit. Changing them needs the same `wallet.fund` step-up, so a hijacked session cannot raise a limit and withdraw without a code.

## 6. Website

- `src/lib/payments/wallets.ts`: add a `withdrawToBank({ tenantId, amountCents, idempotencyKey })` call to `moov-wallet-withdraw`.
- `src/pages/WalletOps.tsx`: the button, dialog, confirm step and step-up retry, reusing the "Add funds" dialog's step-up handling.
- `src/lib/payments/walletRelativeTransfers.ts`: label the leg **"Transfer to bank"** in `purposeOfTransfer` (`:244`). It is wallet-source, so it reads as money out.
- Hidden behind a reviewed constant (`PAYMENT_FLAGS.SHOW_WALLET_WITHDRAW`, false until the API and SQL are live in production), like `SHOW_AUTOMATIC_PAYOUTS`.

## 7. Risks and controls

| Risk | Control |
|---|---|
| Account takeover drains the wallet | Fresh TOTP step-up per login (≤ 15 min); destination fixed to the tenant's own verified bank; no new bank can be added in the same dialog; optional tenant limits (§5a). No email notice (owner decision 8); every withdrawal is visible in Recent Wallet Activity |
| Double submit / retry sends twice | Per-click idempotency key, committed row before POST, Moov idempotency = row id, `unknown` never auto-retried |
| Amount above balance | Server re-reads Moov available balance; refuses above it; Moov also refuses |
| Money needed for pending sends is withdrawn | Available (not pending) balance only; a tenant may set its own limits (§5a) |
| Status never updates | New migration adds the leg to SQL 109 / 146 writers; catch-up job covers missed webhooks |
| Return after completion | Recorded with R-code; shown as Returned; funds back in wallet per Moov |
| Sent after the same-day cutoff | Server computes and shows the expected banking day before confirm; activity shows the expected date |
| Unclear audit | `payment_transfers` row + `payment_event_log` + `financial_stepup_log` id in metadata + `created_by` |
| Dual control | None (owner decision 6), consistent with funding and sends |

## 8. Guarded rollout (each step a reviewed PR and an owner approval)

1. **Tooling PR**:
   - the new migration (next free number at that time; SQL 161 and 162 are taken), its spec, staging and production pins, one-shot tool, runbook and tests;
   - the API handler, the `providers.mjs` route and tests (idempotency, step-up, balance cap, tenant limits, operating-only, same-day method and cutoff date, bank selection, `unknown` handling);
   - website behind `SHOW_WALLET_WITHDRAW = false`;
   - nothing applied.
2. **Staging**:
   - SQL read-live, then apply (`guarded-staging-sql-executor.yml`);
   - staging Lambda rebuild with the handler;
   - an end-to-end sandbox withdrawal on a test tenant, accepted by the owner.
3. **Production SQL**: inspect, then the pin PR, then apply with the owner's exact words, then the record PR.
4. **Production API**: rebuild inspect, then the rebuild-plan PR, then "DEPLOY FULL API PACKAGE TO PRODUCTION" for that run. The route stays unreachable from the UI while the flag is false.
5. **Website**: a PR sets `SHOW_WALLET_WITHDRAW = true`; staging upload; then "DEPLOY WEBSITE TO PRODUCTION"; then the lock record PR.
6. **First production use**: owner-chosen tenant and small amount, confirmed in Moov and in Recent Wallet Activity.

## 9. Decisions (owner, 2026-11-13)

Verbatim: "1. No fee 2. Up to tenant 3 any member 4 same day 5 any amount up to balance 6no admin approval 7yes same two factor 8 no 9 operating wallet".

1. **Fee**: none.
2. **Limits**: up to the tenant. There is no platform cap; a tenant may set a per-transfer and/or daily limit (§5a).
3. **Who**: any member of the tenant.
4. **Speed**: same-day ACH (`ach-credit-same-day`). After the cutoff it settles the next banking day, and the UI says so before confirming (§2).
5. **Amount**: any amount up to the available balance (and the tenant's own limits, if set).
6. **Approval**: no second-admin approval.
7. **Two-factor**: the same `wallet.fund` step-up as funding and sends.
8. **Notifications**: no email to admins.
9. **Wallet**: the operating wallet only; the trust wallet is excluded.
