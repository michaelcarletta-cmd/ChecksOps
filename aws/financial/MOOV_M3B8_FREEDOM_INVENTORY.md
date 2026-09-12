# Moov M3b.8 — GET-only Freedom readiness inventory

**Status:** STOP FOR REVIEW.  
**Date:** 2026-09-10  
**Branch:** `cursor/moov-production-readiness-m3b-8-a508`

GET-only. No secret values, Basic headers, or access tokens are printed. Ids are fingerprints (`first8…last4`).

Server derived the Moov account from RDS `payment_provider_accounts`. Browser-supplied Moov account ids were rejected (`400 untrusted_provider_config`). C1C was not used (`403 cross_tenant_denied`).

---

## ACCOUNT

| Field | Live Moov |
| --- | --- |
| Account id | `60922058…de96` (matches expected Freedom id) |
| Display name | Freedom Adjustment LLC |
| Type | **business** |
| Verification | **verified** |
| Disabled | **false** |
| Restricted | **false** |
| Mode | **production** |
| Top-level `status` | not present on the live account object |
| Requirements / `action_required` | **none** (`requirements.present=false`) |

---

## TOS

| Field | Live Moov |
| --- | --- |
| Accepted | **yes** |
| Accepted at | `2026-08-28T18:36:52.907203Z` |

Source: live `termsOfService` on `GET /accounts/{id}`. RDS ToS was not used as live truth.

---

## CAPABILITIES

Live `GET /accounts/{id}/capabilities` returned **four parent capabilities**. It did **not** return child rows named `send-funds.ach`, `collect-funds.ach`, or `wallet.balance`.

| Capability | Status |
| --- | --- |
| `send-funds` | **enabled** (no separate `send-funds.ach` row) |
| `collect-funds` | **enabled** (no separate `collect-funds.ach` row) |
| `wallet` | **enabled** (no separate `wallet.balance` row) |
| `transfers` | **enabled** |
| Same-day ACH as a capability id | **not returned** |
| Pending | none |
| Disabled | none |
| Errored | none |

Same-day ACH **is** exposed as a payment method (`ach-credit-same-day`). See BANK/PAYMENT METHOD.

---

## WALLET

| Field | Live Moov |
| --- | --- |
| Exists | **yes** |
| Status | **active** |
| Available balance | **0 cents** (`$0.00`) |
| Pending balance | **not present** on the live wallet payload |

---

## BANK / PAYMENT METHOD

Freedom’s own production bank (live GET):

| Field | Live Moov |
| --- | --- |
| Exists | **yes** |
| Status | **verified** |
| Last4 | **4573** (from `lastFour*` only; full account number not used) |
| Holder name | present (value not printed) |

Live payment methods:

| Type | ACH send | ACH collect |
| --- | --- | --- |
| `ach-credit-standard` | yes | no |
| `ach-credit-same-day` | yes | no |
| `ach-debit-fund` | no | yes |
| `ach-debit-collect` | no | yes |
| `moov-wallet` | no | no |

RDS `payment_provider_methods` for Freedom (local snapshot, not live truth): one production row, `verified` / `connected`, `can_send=true`, `can_receive=true`, last4 `4573`, not linked to an external recipient.

---

## Sender readiness

**READY_AS_SENDER**

Why:

- Live account GET **200** for server-derived Freedom id `60922058…de96`
- `mode=production`, type `business`, verification **verified**, not disabled/restricted
- ToS **accepted**; no currently-due requirements
- `send-funds`, `collect-funds`, `transfers`, and `wallet` are **enabled** with no pending/disabled/errored rows
- Active wallet exists (available **$0.00**; that does not block ACH credit from the verified bank)
- Verified bank last4 `4573` with ACH send (`ach-credit-standard`, `ach-credit-same-day`) and ACH collect (`ach-debit-fund`, `ach-debit-collect`) methods

Nuance: Moov did not return a distinct `send-funds.ach` capability. ACH send eligibility is from parent `send-funds=enabled` plus live `ach-credit-*` payment methods.

Wallet-sourced sends cannot go out at `$0.00` until a later funded state. This phase must not fund the wallet.

---

## Recipients (Freedom-controlled, RDS read-only)

**RECIPIENT_NOT_CONFIRMED**

C1C was not queried as a destination and was not onboarded.

| Environment | Count | `onboarding_status` | Bank linked | Last4 |
| --- | --- | --- | --- | --- |
| production | 3 | `awaiting_bank` | yes | `1506` |
| sandbox | 1 | `awaiting_bank` | no | none |

Production recipients have a stored last4 and `bank_linked_at`, but stored onboarding remains **`awaiting_bank`**. That is not a ready/verified/connected destination status. No recipient Moov account GET was performed. Nobody was onboarded.

---

## Safety recheck

| Check | Result |
| --- | --- |
| `AWS_PROVIDER_LIVE_READS_ENABLED` | **true** |
| `AWS_MOOV_ENABLED` | **false** |
| `AWS_PROVIDER_EXECUTION_ENABLED` | **false** |
| `AWS_FINANCIAL_PERMISSIONS_ACTIVATED` | **false** |
| `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED` | **false** |
| `moov-transfer-create` | **403** `production_execution_blocked`, `liveProviderCalled=false` |
| `moov-disburse` | **403** `production_execution_blocked`, `liveProviderCalled=false` |
| `moov-wallet-fund` | **403** `provider_disabled` |
| Production money POST count | **0** |
| Moov mutations | **0** (OAuth token POST + GETs only) |
| Database financial mutations | **0** (SELECT-only `data/query`) |
| Freedom Moov `payment_transfers` rows | **0**; amount sum **0** |
| SQL 72 | **NOT_APPLIED** (`provider_http_attempted_at` column does not exist) |
| `MOOV_PLATFORM_ACCOUNT_ID` | **not added** (`platform_account_id_configured=false`) |
| Lovable | **unchanged** (`productionSupabaseChanged=false`) |
| Webhook | **unchanged** (`productionWebhooksRedirected=false`) |
| Money movement | **$0.00** |

Lambda overlay (`UpdateFunctionCode` only, Environment blob **not** sent): CodeSha256 `ItJiyRVnWJZ2DIUce3ZhalFn3LrZrkKMSXdpP6MJo50=`, last modified `2026-09-10T10:45:47Z`.

OAuth for the inventory: HTTP **200**, Origin `https://checksops.com`, `aid` `694a303b…3878`, `caid` `41cb5d67…2208`.

---

## Returns

| Item | Result |
| --- | --- |
| SENDER | **READY_AS_SENDER** |
| RECIPIENT | **RECIPIENT_NOT_CONFIRMED** |
| MONEY FLAGS | unchanged (execution still false) |
| SQL72 | **NOT_APPLIED** |
| PROVIDER MUTATIONS | **0** |
| MONEY MOVED | **$0.00** |

**STOP FOR REVIEW.** Do not register webhooks. Do not add `MOOV_PLATFORM_ACCOUNT_ID`. Do not enable money execution. Do not apply SQL 72. Do not move money.
