# E14 Manager approval TOTP — inspect only

Recorded 2026-09-23T01:12Z. **No TOTP reset. No step-up bypass. No SQL approve. No FinCapture. No deploy.**

## Verdict

**Exact failure:** `POST /prep/auth/mfa/step-up` returned **HTTP 409** twice (`01:04:12.765Z`, `01:04:39.392Z`).

**Root cause (proven):** frontend/API contract mismatch. Manager sends `action_key=deposit.approve`. Production `resolveFinancialStepUpBinding` accepts **only** `deposit.submit` (`CHECKALT_TOTP_ACTION`). Any other action is `action_mismatch` **before** the TOTP code is checked.

This is **Manager-specific**. The same authenticator and enrollment already succeeded on `deposit.submit` at `01:01:01.706Z` (HTTP 200). Do not reset enrollment.

## Path

1. Manager → Pending Approvals (`PendingApprovalDeposits` in `src/components/settings/CheckAltSettings.tsx`)
2. Approve → `useFinancialGuard("deposit.approve", { checkId })`
3. `StepUpDialog` → `stepUpAwsTotp` → `POST /prep/auth/mfa/step-up` with `{ code, action_key, check_intake_item_id }`
4. Same production financial-TOTP route as Deposit (`handleMfaStepUp` / `financial_totp_enrollments`)
5. Binding rejects `deposit.approve` with 409 `action_mismatch`
6. UI maps that to the generic “verification code could not be confirmed” message (`totpUserFailureMessage`)
7. `checkalt-approve-deposit` was **never** called

## Why it is not a bad authenticator

| Time (UTC) | Request | HTTP |
| --- | --- | --- |
| 01:00:21 | `/auth/mfa/verify` (enroll confirm / existing) | 200 |
| 01:01:01 | `/auth/mfa/step-up` `deposit.submit` | **200** |
| 01:01:02 | `checkalt-submit-deposit` | 200 |
| 01:03:43–01:03:59 | `/auth/mfa/status` (dialog open) | 200 |
| 01:04:12 | `/auth/mfa/step-up` Manager | **409** |
| 01:04:39 | `/auth/mfa/step-up` retry | **409** |

`financial_stepup_log` has **one** succeeded row: `deposit.submit` / check `a3a4a153-…` / `154672` / user `7dbb3009-f059-4767-b5dc-1c5c72379330` at `01:01:01.866Z`. Failed 409s do not insert a log (reject is before verify). `failed_attempts` is not incremented.

Principal: `mcarletta@freedomadj.com` → Cognito `a45884b8-d051-70b3-b19d-ca704964c6e8` → application `7dbb3009-f059-4767-b5dc-1c5c72379330` (Freedom). Same user as the working submit.

TOTP field/format: string 6-digit (`normalizeTotpCode`). Same as submit. Encryption/decrypt of the stored secret succeeded on the 01:01:01 submit.

Not: invalid TOTP, clock window, wrong user, wrap-key failure, replay (replay is skipped because verify never ran), missing step-up state, or role failure.

RDS `now()` / `clock_timestamp()` = `2026-09-23T01:11:49Z` timezone `UTC`. Matches wall clock. Not a window problem.

## CheckAlt safety (unchanged)

Exactly one `checkalt_deposits` row `b6adc6a6-232f-4748-add3-edff3c4036d4`, reference `123733567`, `$1,546.72`, `pending_approval`. No approve/poll POST. Check still `approved_for_deposit` / `ready_for_deposit`.

## Smallest safe correction (not deployed)

Accept `deposit.approve` as a second **check-bound** action in `resolveFinancialStepUpBinding` (same server check + amount binding; still strip client-authored fingerprints/amounts). Record `financial_stepup_log.action_key=deposit.approve`. Do not call CheckAlt from the TOTP route.

**Not deployed.** After that change, the next successful Manager Verify would proceed into `checkalt-approve-deposit` and POST FinCapture `/deposit/approve`. That is a financial transaction. Review first.

Also: `checkalt-approve` currently uses `requireStepUp: false` (role only). A later hardening should require a recent `deposit.approve` (or dual-control) log before provider HTTP. Separate from this 409.

Replay note: even after the contract fix, a code already consumed by `deposit.submit` in the same 30s window would then fail `last_used_timestep`. Operator must wait for the next authenticator number.

## Operator

Do not retry Approve until the contract is reviewed. Do not reset the authenticator. Do not click Deposit again.
