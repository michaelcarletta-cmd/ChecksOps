# M7.1 — Align money movement with Moov wallet + sweeps

**STOP FOR REVIEW.** Audit + design only. Do not fund a wallet. Do not
create or modify a Sweep. Do not create a transfer. Do not enable money
execution. Do not apply SQL72. Do not submit Financial TOTP.

Primary ChecksOps flow is **not** tenant-bank → recipient bank.

Intended production flow:

```
TENANT BANK  →  Moov ACH funding (manual, then Sweep pull only as designed)
             →  TENANT MOOV WALLET
             →  recipient Moov wallet  OR  recipient verified external bank
```

## 1. Freedom live GET (provider HTTP GET only)

| Field | Live value |
|---|---|
| Freedom Moov account | `60922058-7eca-4889-81dd-5720d7b9de96` |
| Freedom wallet | `3e6286ca-a19c-45f6-aad9-f73dac5f0358` (`moov-wallet` PM `744ea734-f5e3-4b31-bb92-38f85fd29b91`, partner/facilitator `41cb5d67-4911-4bef-aad5-d8ee9c582208`) |
| Wallet balance | **available 0** (USD), status `active` |
| Wells Fargo ••••4573 bank id | `61062c38-a79e-4f62-bb64-32ddecf3d37c` **verified** checking |
| Payment methods on ••••4573 | `ach-debit-collect`, `ach-credit-standard`, `ach-credit-same-day`, **`ach-debit-fund`** |
| `ach-debit-fund` | **available** `a02c1c81-9ca6-434d-accc-ea4471a70ef2` |
| Capabilities | `collect-funds`, `send-funds`, `transfers`, `wallet` all **enabled** |
| Live `can_ach_debit` | **true** (`collect-funds=enabled`) |

### Why M7.0 said `can_ach_debit=false`

`payment_provider_accounts.can_ach_debit` is a **stale local snapshot**.
ChecksOps sets it from `collect-funds === enabled` in `capabilityFlags`
(`supabase/functions/_shared/moovClient.ts`). Live Moov GET shows
`collect-funds` enabled. The DB row still says `false`. **No capability is
missing on Moov.** `moov-wallet-fund` / `initiate-wallet-funding` would
still 409 on the stale flag until a later **sync-only** (no money) refresh.

`ach-debit-fund` on the live payment-method list does **not** conflict with
live capabilities. It conflicted only with the unsynced DB boolean.

**BANK→WALLET provider-ready:** YES (verified bank + `ach-debit-fund` +
wallet + `collect-funds`). **ChecksOps-ready:** NO (stale debit flag, no AWS
writer, enabled Sweep with `$0` minimum — see below).

Recipient (complete, unchanged): account `ee8c608e-dc2d-45d3-95e9-3c992f3dfc5f`,
bank `72eb66c1-d9a9-4f85-ab50-8871db9ceeea` Chase ••••1506, wallet
`1c58bbea-8f55-42b2-b794-25c30eecdadc` ($0). Dest PMs include
`ach-credit-standard` `15b6185b-ec16-4e9d-97b4-555a54d326b9`. No
`payment_provider_methods` row for this recipient.

Money flags remain all **false**. `payment_transfers=0`.

## 2. Sweeps (GET only — not created/modified)

Freedom **already has** a Moov sweep config:

| Field | Value |
|---|---|
| Sweep config id | `2d2c900d-6efb-43a2-ba90-2fd77e22afdd` |
| Status | **`enabled`** (updated 2026-09-08) |
| Wallet | Freedom `3e6286ca-…` |
| Push (WALLET→BANK) | `7a78a544-340d-46fd-a4a4-228661374da7` = WF ••••4573 `ach-credit-standard` |
| Pull (BANK→WALLET) | `a02c1c81-9ca6-434d-accc-ea4471a70ef2` = WF ••••4573 `ach-debit-fund` |
| Minimum balance | **`0.00`** |
| Executions | one row, status **`accruing`**, `accruedAmount=0.00` (wallet empty) |

Moov production contract (`docs.moov.io` sweeps): daily, Moov-owned schedule.

- **Push** surplus above `minimumBalance` to a credit PM (wallet → bank).
- **Pull** via `ach-debit-fund` remediates **negative** wallet balance
  (bank → wallet). Pull is **not** a general “fund for disbursement” pump.
- ChecksOps must **never** POST a transfer to implement a sweep.

Legacy: `supabase/functions/moov-sweep-config` + SPA WalletOps. AWS:
sandbox-only `sweepConfig` in `parity/moov-onboard.mjs`. Live
`payment_sweep_configs` **count = 0** — DB did not persist the enabled Moov
config.

List-executions path in ChecksOps (`GET /accounts/{id}/sweeps?walletID=`)
returns **403**. Working GET is
`/accounts/{accountID}/wallets/{walletID}/sweeps`.

**Do not disable this sweep in this phase** (could change production treasury
behavior). A later reviewed step **must** pause or raise `minimumBalance`
before Test 1, or Test 1’s 1¢ can be **pushed back** to Wells Fargo the same
day.

## 3. Two distinct operations (design — not built)

### A. WALLET FUNDING (BANK → WALLET)

Freedom WF ••••4573 `ach-debit-fund` → Freedom `moov-wallet`.

Server-authoritative amount (ignore browser). Durable **funding intent** row
before provider POST. Idempotency key from **intent id**, not
`wallet-fund:tenant:type:amount` (that key collides on repeat $0.01).
CAS `provider_http_attempted_at`. Unknown/timeout → reconcile existing intent,
never a second POST. Financial TOTP bound to user/tenant/`wallet.fund`/
intent/amount. First-test cap **1 cent**. Persist Moov transfer id; webhook
only updates that intent.

### B. WALLET DISBURSEMENT (WALLET → RECIPIENT)

Freedom wallet PM → Chase ••••1506 `ach-credit-standard` (or recipient
wallet, later). Separate **disbursement intent**. Server recipient, dest PM,
amount. **Refuse if available wallet < amount**. Same CAS / unknown-outcome /
TOTP (`wallet.disburse`) / 1-cent cap. Do **not** auto-send after funding
(`initiate-wallet-funding` today defaults `auto_send_after_funding=true`).

Do not combine A and B into one opaque transfer.

## 4. Legacy rails vs this architecture

| Path | Classification | Bypass / containment |
|---|---|---|
| `moov-wallet-fund` | **BANK→WALLET** | `requireMoovCaller`; blocked by stale `can_ach_debit` |
| `initiate-wallet-funding` | **BANK→WALLET** | User caller; default **auto-send after funding** couples A+B |
| `wallet-fund-on-clear` | **BANK→WALLET** automated | Cron; no user TOTP |
| `process-funded-payment` | orchestrates B after A | **internal header** → `moov-disburse` |
| `moov-disburse` | **WALLET→BANK/recipient**; **falls back to BANK→recipient** if wallet short | **internal bypass still exists** |
| `moov-webhook` | status; on funding complete **originates B** | **YES originates money** via internal chain |
| `moov-transfer-create` | often **BANK→recipient direct** | Not the target architecture |
| group-create | multi-leg, can be direct | Contain |
| `moov-sweep-config` | **SWEEP CONFIG** (Moov executes) | Writes config, not transfers; SPA still live |
| `moov-tenant-fee-charge` | platform fee debit | Separate; contain |
| `homeowner-deductible-pay` | homeowner ACH debit | Not Freedom wallet path |

**Do not neutralize `moov-disburse` / sweep-config in this phase** — an
enabled Sweep and historical disbursement console still exist. Containment
is a later reviewed phase: stop webhook from originating B; stop disburse
bank fallback; require AWS TOTP for A and B.

## 5. Target AWS control plane

Distinct records:

1. **BANK FUNDING INTENT** (A)
2. **WALLET DISBURSEMENT INTENT** (B)
3. **SWEEP CONFIGURATION** (mirror of Moov; ChecksOps cannot be bypassed by
   enabling Sweep in the SPA)
4. **PROVIDER TRANSFER** (one Moov id per intent)
5. **WEBHOOK/RECONCILIATION** (update only)

Webhook **never** creates a new payment. Retries **never** blindly POST
again. Sweeps stay **off/paused** until Test 1 is proven; then Sweep pull
may top up **negative** balances only, with ChecksOps audit of config
changes and a non-zero retained minimum so disbursement float is not pushed
out.

## 6. First real tests (DO NOT EXECUTE)

**Before Test 1 (later reviewed):** pause or raise Freedom Sweep minimum so
1¢ is not pushed back to WF. Sync `can_ach_debit` from live caps (no money).
Persist recipient dest PM for Test 2. Do none of that in M7.1.

**TEST 1 — BANK→WALLET:** 1 cent, WF `ach-debit-fund` → Freedom wallet.
Prove one funding transfer, provider ref, status, wallet +1¢, webhook
updates that intent, no duplicate. **STOP.**

**TEST 2 — only after Test 1:** Freedom wallet → Chase ••••1506
`ach-credit-standard`, 1 cent. Prove one disbursement, recipient binding,
wallet −1¢, webhook, no duplicate. **STOP.**

Sweeps stay inactive for automation until Test 1 is proven.

## Holds

Money flags stay false. No wallet fund. No Sweep create/update. No transfer.
