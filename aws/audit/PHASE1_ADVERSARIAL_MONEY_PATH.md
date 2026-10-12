# Phase 1 adversarial money-path audit — AWS staging

**Date:** 2026-09-25  
**Target:** `https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging`  
**Runtime:** AWS only. No Supabase reconnect. No production money movement.  
**Harness:** `scripts/aws-phase1-adversarial-money-path.mjs`  
**Run id:** `P1ADV-1790299677228`  
**Auth:** Staging `/auth/login` is retired (`410 password_auth_disabled`). Tester JWTs were minted with Cognito `AdminInitiateAuth` for Freedom (`checksops-tester@freedomadj.com`) and C1C (`payments@condition1commercial.com`). Passwordless EMAIL_OTP / passkeys were not changed.

## Verdict

**PHASE 1 ADVERSARIAL MONEY-PATH AUDIT: FAIL**

One unresolved **MONEY-RISK** remains on the current staging system. No **BLOCKER** (wrong/duplicate live money movement or cross-tenant money authority) was demonstrated. Live CheckAlt/Moov production posts stayed off.

A narrow AWS write-path fix for the MONEY-RISK is prepared in this branch and covered by unit tests. It is **not deployed** to staging or production.

## Staging safety baseline (proved)

| Flag | Observed |
| --- | --- |
| `AWS_APPLICATION_WORKFLOW_WRITES_ENABLED` | `true` |
| `AWS_PROVIDER_EXECUTION_ENABLED` | `false` |
| `AWS_MOOV_ENABLED` | `false` |
| `AWS_CHECKALT_ENABLED` | `false` |
| `AWS_MOOV_TRANSFER_POST_ENABLED` | `false` |
| `AWS_FINANCIAL_SANDBOX_SIMULATION_ENABLED` | `true` |
| `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED` | `true` |
| `AWS_FINANCIAL_PERMISSIONS_ACTIVATED` | `false` |
| `liveProviderTransactions` | `false` |
| Production webhooks redirected | `false` |

`POST /functions/v1/checkalt-submit-deposit` → `403 checkalt_mutation_blocked`.  
`POST /functions/v1/moov-transfer-create` without a recipient → `400 A recipient is required` from the sandbox parity handler (current-request validation). `AWS_MOOV_TRANSFER_POST_ENABLED=false` so it does not POST to Moov.

## Scenario matrix

| Scenario | Result | Severity | Finding | Fix needed |
| --- | --- | --- | --- | --- |
| 1 Normal control path | PASS | — | Upload → Review → Endorsing → in-person sign → Ready. `mark_deposited` and live CheckAlt denied. | No |
| 2 Admin rollback — material edit | FAIL | MONEY-RISK | After return-to-review, amount/claim_id writes are denied. `payee_name` / `payee_line` / `funds_type` are writable. A signed endorsement **remains `signed`** after payee rename. Ready was blocked by `endorsement_state_ambiguous` (duplicate rows), not by invalidation. | Yes — prepared, not deployed |
| 3 Admin rollback — non-material edit | PASS | — | `review_notes`, `property_address`, `carrier_name` save. Harmless edits do not need to wipe signatures. | No |
| 4 Partial endorsement then rollback | PASS | — | Insured signed + mortgage pending + insured rename → Ready `403 endorsements_incomplete` / `required_payee_unsigned`. | No |
| 5 Wrong claim association | PASS with gap | WORKFLOW-RISK | `claim_id` write is `column_not_allowlisted`. Synthetic checks stay unlinked. Admin cannot correct a wrong claim on AWS. | Narrow admin RPC later |
| 6 Late mortgage discovery | PASS | — | Adding `mortgage_company` after an insured signature blocks Ready. Loss Draft is not auto-opened; deposit is still gated. | Optional Phase 2 auto-route |
| 7 Duplicate action / double submit | PASS | — | Second `start_review` is `invalid_transition`. Repeat prepare/submit/disbursement prepare are idempotent. Parallel submit is one operation. | No |
| 8 Timeout / unknown result | PASS | — | `db_after_provider` stays `submitting` with `provider_reference`. Retry replays the same id. Reconcile reports `internal_pending_provider_succeeded` and does not auto-correct. | No |
| 9 Duplicate / out-of-order webhooks | PASS | — | First `deposit.cleared` applied once. Duplicate `applied=false`. Out-of-order ignored. Confirmed state did not regress. | No |
| 10 Multiple checks | PASS | — | $100 ACV and $50 supplement created independent ops. Disbursement B cannot consume A. Claim linkage was not creatable (see S5). | Phase 2 on a real multi-check claim |
| 11 Partial disbursement | PASS with gap | WORKFLOW-RISK | Browser partial amount rejected. Sandbox disbursement is always the full check amount. Failed ops do not confirm money out. | Phase 2 remaining-balance source |
| 12 Tenant isolation | PASS | — | C1C cannot read/transition/prepare/payee-write/message Freedom checks. Spoofed C1C tenant is ignored. Freedom wallets are not listed to C1C. | No |
| 13 Readiness after previously ready | PASS | — | Prepare records `readyForProvider=false` when the check is still `uploaded`. Live CheckAlt blocked. Moov sandbox handler evaluates current request/account fields. Production posts remain off. | No |
| 14 Admin edit after deposit | PASS with gap | WORKFLOW-RISK | Amount locked. Sandbox financial history not rewritten. `payee_line` still writable because sandbox confirm does not set `deposited_at`. | Lock material fields after confirmed provider op |
| 15 Delete / reupload / replacement | PASS after harness fix | — | Live DELETE requires `reason` (min 3 chars) and refuses rows with `check_billing_events`. Replacement gets a new id and `checks/{id}/` prefix. Obsolete id is not transitionable once deleted. | Harness now sends `reason` |

## Findings

### MONEY-RISK — S2-STALE-SIGNATURE-AFTER-PAYEE-CHANGE

**Scenario:** 2 (mandatory admin rollback + material edit)

**Reproduction (staging, 2026-09-25):**

1. Create Freedom check with amount `250`, payee `Original Payee`.
2. Insert `check_payees` insured row (trigger also inserts `check_endorsements`).
3. `start_review` → `start_endorsing`.
4. `POST /functions/v1/check-endorsement` `sign_in_person` with a drawn PNG. Status becomes `signed`.
5. `return_to_review` → `needs_review`. Audit row written (`aws_workflow_transition`).
6. `POST /data/write` `check_intake_items.amount=999.99` → `403 column_not_allowlisted`.
7. `POST /data/write` `claim_id=…` → `403 column_not_allowlisted`.
8. `POST /data/write` `funds_type=supplement` → `200`.
9. `POST /data/write` `payee_line=CHANGED PAYEE LLC` → `200`.
10. `POST /data/write` `check_payees.payee_name=CHANGED PAYEE LLC` → `200`.
11. Inspect endorsements: **prior row still `signed`**, now associated with the renamed payee id. Trigger also inserts a second pending row → Ready is `403 endorsement_state_ambiguous`.

**Expected:** A signature collected for a different named payee is invalidated, official rear fingerprint cleared, and Ready/CheckAlt eligibility fail until a new signature exists. Audit records actor, prior name, new name.

**Actual:** `tg_mirror_payee_to_endorsement` (staging SQL) **intentionally keeps signed/waived rows** on rename and inserts a new pending row for the new name. `evaluateEndorsementEligibility` fingerprints ids/types/statuses/`signed_at` and **never payee names**. Ready failed only because two rows for one `payee_id` are ambiguous. If the extra pending row is later removed or force-completed, the stale signed row can satisfy Ready.

**Affected:**

- Staging DB trigger `public.tg_mirror_payee_to_endorsement`
- `POST /data/write` `check_payees` update (`aws/functions/api/write-check-workflow.mjs`)
- `evaluateEndorsementEligibility` / `endorsementStateFingerprint` in `checkalt-eligibility.mjs`
- `check_endorsements.status`, `signed_at`, official rear `checkalt_rear_fingerprint`

**Risk:** Incorrect endorsement state. A deposit-eligible check can carry a signature that was not collected for the current payee. No live CheckAlt post occurred in this run (Ready blocked + provider mutation blocked).

**Recommended narrow fix (prepared, not deployed):**

1. AWS write path: on `payee_name` / `payee_type` change, reset that payee’s endorsements to `pending`, drop duplicate rows, clear payee `endorsed_at`, clear official rear fingerprint, write `endorsement_invalidated_material_edit` audit. Implemented in `aws/functions/api/endorsement-material-invalidation.mjs`.
2. Follow-up SQL (do not apply to production in this audit): on rename, reset signed rows instead of preserving them.
3. Optional: include normalized `payee_name` in the CheckAlt eligibility fingerprint.

S2 was stopped after Ready was denied. No deposit/disbursement was attempted on that check.

### WORKFLOW-RISK — S5 claim reassignment locked

Admin cannot set or change `claim_id` on AWS (`column_not_allowlisted`). Workflow transitions refuse claim-linked checks. This prevents the adversarial “move from Claim A to Claim B” case and also prevents a live AWS admin correction. Audit history for a would-be reassignment cannot be created.

**Narrow fix later:** an audited admin RPC that sets/clears `claim_id` only when `deposited_at IS NULL`, writing prior/new claim ids to `check_audit_log`. Do not open generic `claim_id` writes.

### WORKFLOW-RISK — S11-NO-PARTIAL-AMOUNT-API

Sandbox financial amounts come only from `check_intake_items.amount` (or the $123.45 fixture). Browser `amount_cents` is `untrusted_amount`. Idempotency is `sha256(tenant|operation|check|amount|USD)`, so a second disbursement prepare replays the first. Failed ops stay `provider_failed` and do not confirm money out.

Cannot prove two successful partials on staging sandbox. No incorrect double disbursement was observed.

### WORKFLOW-RISK — S14-PAYEE-EDITABLE-AFTER-SIMULATED-DEPOSIT

After sandbox `deposit.cleared`, `amount` stays locked and `aws_financial_operations.amount_cents` is unchanged (idempotent replay). `payee_line` remains writable because sandbox confirm does not set `deposited_at`.

## Material vs non-material fields (current AWS staging)

| Field | Writable on AWS write path? | Treated as material for endorsement invalidation today? |
| --- | --- | --- |
| `amount` | No (`column_not_allowlisted`) | Locked |
| `claim_id` | No | Locked |
| `status` / `check_stage` | No (workflow transition or disabled admin RPC) | Workflow only |
| `routing_number` / `account_number` | No | Locked |
| `deposited_at` | No | Locked |
| `payee_name` (`check_payees`) | Yes | **Should be; currently not on live staging** |
| `payee_type` | Yes | **Should be; currently not on live staging** |
| `payee_line` | Yes | Descriptive; not used by eligibility fingerprint |
| `funds_type` | Yes | Workflow/reporting material; does not reset signatures |
| `carrier_name`, `check_number`, `issue_date` | Yes | Non-material |
| `review_notes`, `property_address`, `payee_address` | Yes | Non-material |
| `contact_email` / `contact_phone` | Yes | Non-material |

`admin_override_check_status` remains `rpc_disabled` / `financial_sensitive`.

## Financial reconciliation

Sandbox only. Units are integer cents.

| Case | Money in | Successful money out | Remaining / result |
| --- | --- | --- | --- |
| S7 deposit + disbursement prepare | 12345 | 0 confirmed (submit pending / replay) | One deposit op, one disbursement op, both idempotent |
| S8 hung submit | n/a | 0 | Same operation id; recon report only |
| S9 confirmed deposit | 12345 | 0 | Duplicate webhook did not add a second confirm |
| S10 check A vs B | 10000 and 5000 | Independent | No cross-consumption |
| S11 $200 deposit confirmed, failed pay_homeowner | 20000 | 0 | `20000 - 0 = 20000`. Failed op did not reduce balance |
| Browser amount | rejected | — | `untrusted_amount` |

No case showed two financial business effects from one intended operation.

## Tenant isolation

Freedom tester cannot be overridden to C1C by body/header spoof. C1C cannot read, transition, write payees/messages, list Freedom wallets, or prepare Freedom financial ops (`403 rls_denied`). Sharing/partner visibility was not granted money authority in these tests.

## Idempotency

Prepare, parallel simulate-submit, retry after `db_after_provider`, duplicate webhook, and repeat disbursement prepare all replayed the same `aws_financial_operations.id`. Out-of-order webhook did not apply.

## Rollback / material-edit / stale endorsement

- Return-to-review works and is audited (`aws_workflow_transition`, actor + from/to status).
- Amount/claim/status cannot be rewritten on the AWS write path.
- Payee identity **can** be rewritten and **does not** invalidate signatures on live staging.
- Ready did not accept the stale signature in this run only because the trigger left a duplicate pending row (`endorsement_state_ambiguous`).

## Audit trail

Workflow create/transition inserts `check_audit_log` with actor, timestamp, prior status, new status, and action. Admin override RPC is disabled. Material payee rename currently does **not** write an invalidation audit on live staging; the prepared fix adds `endorsement_invalidated_material_edit`.

`DELETE /workflow/checks/:id` deletes child audit rows for synthetic unlinked checks. That is cleanup, not an admin correction path. Live DELETE also requires `reason` and refuses checks with `check_billing_events`.

## Synthetic staging records

Marker: `AWS P1 ADV P1ADV-1790299677228`

| Record | Status |
| --- | --- |
| Freedom workflow checks created in the run | Most deleted after evidence with `reason=P1ADV synthetic cleanup` |
| Sandbox `aws_financial_operations` | Cleaned via `POST /financial/cleanup` by marker |
| Retained (delete blocked by `check_billing_events`) | `b887bd62-1bb0-4d8b-bfc2-9e63d79e77bd`, `710c9494-04f1-4ff2-8bd3-da9cd8f4658c`, `1068ac20-08c2-4adb-a6cd-51437efaed73`, `ed194599-fe40-4dee-ae9c-015fec8674d4` — review notes marked leftover; not live-depositable |

No production records were written.

## Scenarios not fully completed

| Gap | Why |
| --- | --- |
| Reassign check from Claim A to Claim B | `claim_id` is not writable; transitions refuse claim-linked rows |
| Two successful partial disbursements against one remaining balance | Sandbox amount source is the full check amount |
| Production deposited_at lock | Sandbox confirm does not set `deposited_at` |
| Live CheckAlt/Moov money | Intentionally blocked; not used |
| EMAIL_OTP / passkey UI login | Password login retired; operator AdminInitiateAuth used for API tests only |

## Recommended Phase 2

1. Deploy the prepared payee-rename invalidation to **staging only** and re-run S2 until Ready stays denied *because* signatures were reset, not because of duplicate-row ambiguity.
2. Staging-only SQL change to `tg_mirror_payee_to_endorsement`: on rename, reset signed rows instead of preserving them. Do not apply to production in the same change.
3. Audited pre-deposit `claim_id` correction RPC; then repeat S5/S10 on a real Freedom claim with ACV + supplement.
4. Server-derived remaining-balance disbursement (not browser amount) and remainder math.
5. Lock `payee_line` / payee identity after `deposited_at` or a confirmed provider operation.
6. Optional: include payee name in the CheckAlt eligibility fingerprint.
7. Optional: late mortgage payee automatically opens Mortgage Ops / Loss Draft in addition to blocking Ready.
8. Confirm `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED` + `AWS_MOOV_TRANSFER_POST_ENABLED=false` remains the staging contract after Moov GA in production.

## Prepared code (not deployed)

- `aws/functions/api/endorsement-material-invalidation.mjs`
- `executePayees` update path in `write-check-workflow.mjs`
- `aws/tests/endorsement-material-invalidation.test.mjs`

These do not change CheckAlt, Cognito policy, tenant isolation, or production money flags.
