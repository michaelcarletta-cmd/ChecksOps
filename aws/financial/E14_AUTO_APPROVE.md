# E14 — $2,000 auto-approval threshold inspect

Recorded 2026-09-23T01:20Z. **Inspect only.** No threshold change. No `deposit.approve` fix. No FinCapture. No retry. Deposit `b6adc6a6-232f-4748-add3-edff3c4036d4` / reference `123733567` left at `pending_approval`.

Inspect oneshot restored to staging RDS.

## Verdict

**Missing runtime logic / production-cutover parity.** Freedom auto-approve is **on**, with **no stored ceiling**. CheckAlt returned process status `40` (`pending_approval`). AWS `checkalt-submit-deposit` persisted that status and returned. It never evaluated the threshold and never called `/fincapture/deposit/approve`.

This is not a units mismatch, not a reversed comparison, and not a missing tenant row. The $1,546.72 item stayed pending because the AWS rail does not consume `auto_approve_*`.

Do **not** approve reference `123733567` from this note.

## 1. Exact stored Freedom values

| Location | Field | Live production value |
| --- | --- | --- |
| `checkalt_tenant_accounts` Freedom `2eff5f1a-929d-4ce3-9a8b-cd96b98df42a` | `auto_approve_enabled` | **`true`** |
| same row | `auto_approve_max_cents` | **`null`** (no ceiling) |
| same row | `updated_at` | `2026-06-26T20:16:52.147Z` |
| `checkalt_config` singleton | `auto_approve_enabled` | `false` |
| same row | `auto_approve_max_cents` | `null` |
| same row | `updated_at` | `2026-09-04T15:55:51.343Z` |

No `$2,000` / `200000` cents value exists on either table. UI copy says leave the ceiling blank for no limit. Tenant last write is 2026-06-26; a later Settings save of `$2,000` did not land on isolated production RDS.

Legacy rule: tenant overrides global (`tenant.auto_approve_enabled ?? cfg.auto_approve_enabled`; `tenant.auto_approve_max_cents ?? cfg.auto_approve_max_cents`). Freedom tenant `true` + `null` ceiling means **every clean deposit should auto-approve**, including `$1,546.72` and amounts far above `$2,000`.

## 2. Intended rule

From Settings copy (`TenantAutoApproveCard`, platform `CheckAltSettings`) and the last live Lovable `checkalt-submit-deposit` (commit before `d8db05cb7`):

1. Operator Deposit + `deposit.submit` TOTP.
2. ChecksOps `POST /fincapture/deposit/process`.
3. CheckAlt commonly returns **status `40`**. That is **always** a park-for-approval state. CheckAlt does **not** read ChecksOps `auto_approve_*`. A second `POST /fincapture/deposit/approve` (`action: 1`) is required.
4. If tenant (else global) `auto_approve_enabled` and the item is **clean** and (`auto_approve_max_cents` is null **or** `amount_cents <= max`):
   ChecksOps automatically calls `/deposit/approve` (5 attempts, backoff for the post-process lock). On success, local status becomes `submitted` and `approved_at` is set.
5. If flagged (exceptions / warnings / riskFactors / status text matching duplicate, fraud, risk, exception, warning, hold, suspect, mismatch, unreadable) **or** `amount_cents > max`:
   leave `pending_approval` for Manager (`deposit.approve` / `checkalt-approve-deposit`).

At/below a `$2,000` ceiling would auto-approve **if that ceiling were stored**. Above `$2,000` would require Manager **only if** `auto_approve_max_cents = 200000`. Stored ceiling is `null`, so the live intended rule is **no amount gate**.

## 3. What this transaction did

```
deposit.submit TOTP 200
  → handleProductionCheckAltSubmit
  → POST /fincapture/deposit/process
  → CheckAlt HTTP 2xx, status 40, reference 123733567
  → persistProviderOutcome(status='pending_approval')
  → return 200 { status: pending_approval }
  → STOP
```

`handleProductionCheckAltSubmit` maps `apiStatus === 40` to `pending_approval` and returns. There is no auto-approve block after persist.

`loadProductionTenantAccount` SELECTs `auto_approve_enabled` and `auto_approve_max_cents` but **drops `auto_approve_max_cents`** from the returned object. Submit never reads `acct.auto_approve_enabled`.

This deposit:

| Field | Value |
| --- | --- |
| ID | `b6adc6a6-232f-4748-add3-edff3c4036d4` |
| Reference | `123733567` |
| Amount | `$1,546.72` / `154672` cents |
| Status | `pending_approval` |
| `approved_at` | null |
| `_auto_approve` audit | **absent** |
| CheckAlt approve POST | **0** (E14 post-deposit + this inspect) |

`last_status_payload` stores only keys (`status_code=40`, `response_keys` including `riskRating`, `amountDiscrepancyDetected`, `errors`, `messages`). Flag **values** were not persisted. Cleanliness cannot be re-proven without calling CheckAlt. Auto-approve was never attempted, so flags are not why it stayed pending.

## 4–7. Should ChecksOps have auto-called approve?

**Yes**, under the intended/legacy rule: tenant `auto_approve_enabled=true`, no ceiling, status `40` with a reference. The only legitimate skip is CheckAlt flags. That evaluation never ran.

`pending_approval` is a CheckAlt process response that **always** needs a second approve call. Auto-approval is ChecksOps-side, not a CheckAlt merchant threshold.

Why the configured setting did not approve this item: **AWS production submit never ported the Lovable auto-approve path.** `LEGACY_CHECKALT_MONEY_SHUTDOWN.md` already classified `auto_approve_enabled` as **INERT LEGACY CONFIG** after the Lovable money path was fail-closed. `checkalt-approve-cron` remains a disabled financial job.

Not: dollars-vs-cents (legacy compared `Math.round(amount * 100)` to `auto_approve_max_cents`), reversed `>` vs `<`, or a missing Freedom tenant row.

## 8. Previously working implementation

Last live Lovable submit (parent of `d8db05cb7`) auto-approved in-process after status `40`, wrote `last_status_payload._auto_approve`, and set `approved_at`.

Production history (all Freedom; 70 rows):

| Metric | Count |
| --- | --- |
| `_auto_approve.approved=true` | **22** |
| `_auto_approve` skip reasons | **0** |
| `approved_at` set | 52 |
| `pending_approval` | **1** (this E14 row) |

Recent Lovable rows still carry `_auto_approve.approved=true`, including `$9,747.77`, `$14,636.33`, `$10,710.78`, `$22,160.12`. A `$2,000` ceiling was not enforced on the working path. Those amounts would have been Manager-only **only if** `auto_approve_max_cents=200000` had been stored.

## Smallest general correction (not deployed)

Port the Lovable post-process auto-approve block into `handleProductionCheckAltSubmit` after a successful status-`40` persist:

1. Return `auto_approve_max_cents` from `loadProductionTenantAccount`.
2. Resolve tenant-over-global `auto_approve_enabled` / ceiling in integer cents.
3. Skip with `_auto_approve.skip_reason` when flagged or over ceiling.
4. Otherwise `POST /fincapture/deposit/approve` `{ action: 1 }` with the same lock retries.
5. On success: status `submitted`, set `approved_at`, write `_auto_approve` audit.
6. On skip/failure: leave `pending_approval` for Manager.

Do **not** apply that to reference `123733567` as a one-off from this inspect. Do **not** change the stored ceiling. Do **not** fix `deposit.approve` in the same change (separate Manager TOTP contract). Review before any deploy: a ported auto-approve is a live FinCapture approve POST.

Keep this transaction untouched at `pending_approval`.
