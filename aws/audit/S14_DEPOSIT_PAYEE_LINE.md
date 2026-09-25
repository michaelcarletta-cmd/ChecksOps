# S14 Deposit payee_line protection — Phase 1 determination

**Date:** 2026-09-25  
**S2/S3/S4/S5/S11:** CLOSED / PRODUCTION PASS. Not reopened.  
**Production Lambda:** unchanged `dplSPx8YJoYbkolr2c6mKersDAV7OCzHt5y3UyIOdoc=`  
**Staging Lambda:** unchanged `jSjcGOr9efEuixUEKSU3WSdHsc+Nmd7P21cRaRi0zBk=` (post-S11 overlay). No overlay this turn.  
**Target:** AWS staging `https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging`  
**Harness:** `scripts/aws-s14-deposit-payee-line-identify.mjs`  
**Run:** `S14ID-1790341657464`  
**Check:** `8803c760-045a-4d21-8109-5bcd16690974` (deleted after evidence)

No remediation was implemented.

## Exact S14 requirement

After a check is deposited — meaning `check_intake_items.deposited_at` is set **or** a confirmed provider deposit operation exists — `payee_line` must be immutable.

Denied attempts must leave structured payees, endorsement state, amount, deposit state, and financial history unchanged. Pre-deposit descriptive correction of `payee_line` may remain allowed. The lock must fail closed.

The adversarial scenario from `aws/audit/PHASE1_ADVERSARIAL_MONEY_PATH.md` (`S14-PAYEE-EDITABLE-AFTER-SIMULATED-DEPOSIT`) is: sandbox-confirm a deposit, then rewrite `payee_line` through generic `/data/write` or any other persist path.

## What `payee_line` is

`payee_line` is a free-text descriptive column on `check_intake_items` (and a descriptive mirror on `claim_checks`). It is what OCR and intake UIs show as the printed pay-to line.

Structured payee records live in `check_payees` (`payee_name`, `payee_type`, contacts). Endorsement state lives in `check_endorsements` keyed by `payee_id`. S2 material invalidation watches `check_payees.payee_name` / `payee_type` only. Eligibility fingerprinting does not use `payee_line`.

Changing `payee_line` does not rename `check_payees` and does not invalidate signatures.

## Exact write paths

| Path | File | Can persist `payee_line`? | Deposit lock today? |
| --- | --- | --- | --- |
| `POST /workflow/checks` create | `workflow.mjs` `handleCreateCheck` | Insert only, new row | n/a |
| `POST /data/write` `check_intake_items` update | `write-allowlist.mjs` `INTAKE_SAFE_COLUMNS`; `write-check-workflow.mjs` `intakeCoerce` + `executeIntakeUpdate` | Yes | **No.** `WHERE id = $n`. `deposited_at` is prohibited as a write column, not used as a gate. |
| `POST /data/write` `claim_checks` update | `write-allowlist.mjs` `claim_checks.columns`; `executeClaimChecks` | Mirror only | **No.** |
| `POST /functions/v1/check-ocr-intake` | `ocr.mjs` descriptive `COALESCE` update; `ocr-descriptive-persist.mjs` `persistOcrDescriptiveHandoff` | Yes | **No.** Both updates are `WHERE id = $1`. |
| `POST /functions/v1/ingest-shared-check` | `ingest-shared-check.mjs` update-existing branch | Yes, if bridge secret matches an existing ingest row | **No.** |
| `POST /data/rpc` `admin_set_check_claim` | live staging overlay (S5) | No | Does not touch `payee_line` |
| `POST /data/rpc` `admin_override_check_status` | `workflow-rpc.mjs` | No | `rpc_disabled` / `financial_sensitive` |
| `POST /data/rpc` `deposit_action` money actions | `workflow-rpc.mjs` | No | `rpc_financial_disabled` except `prepare_deposit` / `assign_provider` |
| `POST /workflow/transition` `mark_deposited` | `workflow-transitions.mjs` | No | `403 financial_or_provider` |
| Generic write of `amount` / `status` / `deposited_at` | `INTAKE_PROHIBITED_COLUMNS` | No | Fail closed |

No AWS application writer `SET deposited_at`. The only setter in-repo is SQL trigger `tg_set_deposited_metadata` (`supabase/migrations/20260527171651_*.sql`), which stamps `deposited_at` when `status` changes to `deposited` / `cleared` / `submitted_for_deposit` / `deposit_submitted`. AWS staging cannot take those status transitions: `status` is not allowlisted, `mark_deposited` is denied, and `admin_override_check_status` is disabled.

Sandbox `POST /financial/simulate-webhook` `deposit.cleared` confirms `aws_financial_operations` only. It does not stamp `deposited_at` or change check status.

## Staging adversarial test

Synthetic Freedom check only. Flags: `AWS_PROVIDER_EXECUTION_ENABLED=false`, `AWS_CHECKALT_ENABLED=false`, `AWS_MOOV_TRANSFER_POST_ENABLED=false`, `AWS_FINANCIAL_SANDBOX_SIMULATION_ENABLED=true`, `liveProviderTransactions=false`.

Known original: `payee_line='S14 Original Payee Line'`, amount `123.45`, structured payee `S14 Structured Insured` (`38ec10a7-e169-48ae-b5c1-a9e23a50b0e2`). No live CheckAlt.

| # | Attempt | Result |
| --- | --- | --- |
| 1 | `/data/write` `payee_line` **before** deposit | `200`. Became `S14 Pre-Deposit Rewrite`. Restored. |
| 2 | Sandbox prepare + `deposit.cleared` | Op `4fc7763a-dd80-4f22-b74d-37b6e61e1756` `provider_confirmed`, `liveProviderCalled=false`. `deposited_at` stayed `null`. |
| 2 | `/data/write` `amount=1.00` after confirm | `403 column_not_allowlisted`. Amount stayed `123.45`. |
| 2 | `/data/write` `deposited_at=now()` | `403 column_not_allowlisted`. |
| 2 | `/data/write` `payee_line` **after** confirmed sandbox deposit | **`200`.** Became `S14 Rewritten After Deposit`. Structured payee, endorsements, amount, status, and `deposited_at` unchanged. |
| 3 | `mark_deposited` | `403 financial_or_provider`. No stamp. |
| 3 | `admin_override_check_status` → `deposited` | `403 rpc_disabled`. |
| 3 | `admin_set_check_claim` clear | `200`. `payee_line` unchanged. |
| 3 | `deposit_action` `submit_checkalt` | `403 rpc_financial_disabled`. |
| 4 | `/data/write` `claim_checks.payee_line` | `403 rls_denied` (no mirror row on this unlinked synthetic). Intake `payee_line` unchanged. |
| 5 | `check-ocr-intake` | `200` with S3 `The specified key does not exist.` No extracted line; `COALESCE` left original. Persist SQL still has no deposit predicate. |
| 5 | `ingest-shared-check` without bridge secret | `401 unauthorized`. |
| — | Replay deposit prepare | Same op id, `12345` cents, `duplicate=true`. |
| — | Live `checkalt-submit-deposit` | `403 checkalt_mutation_blocked`. |

A follow-up attempt to `SET deposited_at` on a second synthetic row via the staging RDS endpoint timed out (`ETIMEDOUT 172.31.77.237:5432`) from this Cloud Agent network. That leftover (`1fd7a05e-…`) was deleted through `DELETE /workflow/checks`. The rehearsal oneshot was not invoked: it refuses arbitrary `checksops` DML.

So the **post-`deposited_at`** case cannot be stamped by any legitimate/reachable AWS application path, and could not be stamped synthetically from this network. Writer-side code has no `deposited_at` predicate, so the lock would not engage even if the column were set.

## Observed behavior

| Question | Observed |
| --- | --- |
| Can `payee_line` change before deposit? | **Yes.** Generic write `200`. |
| Can it change after confirmed sandbox deposit? | **Yes.** Generic write `200` while `deposited_at` is still null. |
| Can it change after `deposited_at` is set? | **No reachable AWS path sets `deposited_at`.** Application writers do not check it. Runtime after a stamped `deposited_at` was not exercised. |
| Do `/data/write`, intake/update RPCs, admin overrides, or OCR bypass a lock? | There is **no lock to bypass** on `payee_line`. Amount / `deposited_at` / status / live CheckAlt fail closed. OCR/ingest did not rewrite this run; their SQL would if they had a value. |
| Disagreement risk? | **Yes.** Descriptive line can diverge from the deposited instrument, `check_payees` / endorsements, `claim_checks` mirror, and audit/history. Generic intake update does not write `check_audit_log`. Financial cents were not rewritten. |
| Do existing protections fail closed? | **For `payee_line`: no. They fail open.** Amount, `deposited_at`, status, `mark_deposited`, and live CheckAlt fail closed. |

## Security / workflow impact

WORKFLOW-RISK, not a demonstrated live-money BLOCKER. Staging cannot post CheckAlt. A confirmed sandbox deposit still leaves the printed pay-to line editable, so intake/UI/history can describe a different payee than the instrument that was deposited and the structured endorsement records that authorized Ready.

If production later stamps `deposited_at` (SQL trigger on a real deposited status) without a writer-side gate, the same `/data/write` path remains open.

## S14 status: FAIL

FAIL / WORKFLOW-RISK. Finding id remains `S14-PAYEE-EDITABLE-AFTER-SIMULATED-DEPOSIT`.

Not BLOCKED: the required lock after a **confirmed provider operation** was exercised and failed. The extra `deposited_at`-stamped case is unreachable on AWS staging application paths and was not required to close the determination.

## Smallest required remediation (not implemented)

Reject `payee_line` changes when `deposited_at IS NOT NULL` **or** a confirmed provider deposit operation exists for that check. Fail closed if that lookup fails.

Apply the same predicate on every persist path:

1. `executeIntakeUpdate` in `write-check-workflow.mjs` (generic `/data/write`)
2. Descriptive `COALESCE` update in `ocr.mjs`
3. `persistOcrDescriptiveHandoff` in `ocr-descriptive-persist.mjs`
4. `executeClaimChecks` when `payee_line` is present
5. `ingest-shared-check` update of an existing row’s `payee_line`

Keep pre-deposit generic `payee_line` writes. Do not add `payee_line` to `INTAKE_PROHIBITED_COLUMNS` unconditionally. Do not stamp `deposited_at` from sandbox confirm as part of this fix (that would engage unrelated terminal-financial locks). Do not redesign `check_payees` / S2. Do not change production in the same change.

## Production remained untouched

| Check | Value |
| --- | --- |
| Production SHA before | `dplSPx8YJoYbkolr2c6mKersDAV7OCzHt5y3UyIOdoc=` |
| Production SHA after | `dplSPx8YJoYbkolr2c6mKersDAV7OCzHt5y3UyIOdoc=` |
| Staging overlay this turn | None |
| Live CheckAlt / Moov | Not called |
| Synthetic cleanup | `8803c760-…` and `1fd7a05e-…` deleted; sandbox ops cleaned by marker |

## S14 DEPOSIT PAYEE_LINE PROTECTION: FAIL
