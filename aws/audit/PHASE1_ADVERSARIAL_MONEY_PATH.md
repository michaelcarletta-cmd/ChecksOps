# Phase 1 adversarial money-path audit — AWS staging

**Date:** 2026-09-25  
**Target (original run):** `https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging`  
**Runtime:** AWS only. No Supabase reconnect. No production money movement.  
**Harness:** `scripts/aws-phase1-adversarial-money-path.mjs`  
**Original run id:** `P1ADV-1790299677228`  
**Auth:** Staging `/auth/login` is retired (`410 password_auth_disabled`). Tester JWTs were minted with Cognito `AdminInitiateAuth` for Freedom (`checksops-tester@freedomadj.com`) and C1C (`payments@condition1commercial.com`). Passwordless EMAIL_OTP / passkeys were not changed.

---

## PHASE 1 FINAL STATUS: COMPLETE / PASS

**Scenarios: 15/15 CLOSED**  
**Remaining acceptance tests: 0**  
**Acceptance blockers: 0**  
**Remediation safeguards: COMPLETE**  
**Additional formally defined acceptance phases: 0**

Accepted production Lambda: `zb7E5ptHPmRsBegkIFgNzq3rzBktHvpNCJ1QMTHM6l0=`  
Latest safeguard regression: **131/131 PASS**

The original overall verdict **PHASE 1 ADVERSARIAL MONEY-PATH AUDIT: FAIL** is **historical and superseded**. It recorded the first staging run, which found S2 MONEY-RISK and S5/S11/S14 workflow gaps. Those items were later remediated, promoted to production, and CI-safeguarded. They are no longer open Phase 1 acceptance work.

Authoritative scenario IDs remain **S1–S15**. Later notes that said S1–S14 were remediations-queue shorthand for the items that still needed product work. They did **not** remove S15 from the official matrix. S15 originally passed after a harness fix and never entered the remediations queue.

This document does **not** define a Phase 2 acceptance program and does not add new acceptance requirements.

---

## Closure record

| Item | Final |
| --- | --- |
| Phase 1 | COMPLETE / PASS |
| Official matrix | S1–S15 (15 scenarios) |
| S2 / S5 / S11 / S14 | CLOSED / PRODUCTION PASS / CI SAFEGUARDED |
| S1, S3, S4, S6, S7, S8, S9, S10, S12, S13, S15 | CLOSED / PASS (original run; no product remediations) |
| Production SHA | `zb7E5ptHPmRsBegkIFgNzq3rzBktHvpNCJ1QMTHM6l0=` |
| Safeguard regression | 131/131 PASS |
| Later formal acceptance phases | None defined |

Accepted remediations/promotion/safeguard records:

- S2: `S2_MATERIAL_ENDORSEMENT_INVALIDATION.md`, `S2_PRODUCTION_PROMOTION.md`, `S2_S5_PRODUCTION_SAFEGUARDS.md`
- S5: `S5_CLAIM_ASSOCIATION.md` (identify; stale FAIL), `S5_CLAIM_ASSOCIATION_REMEDIATIONS.md`, `S5_PRODUCTION_PROMOTION.md`, `S2_S5_PRODUCTION_SAFEGUARDS.md`
- S11: `S11_PARTIAL_DISBURSEMENT.md`, `S11_PARTIAL_DISBURSEMENT_REMEDIATIONS.md`, `S11_PRODUCTION_PROMOTION.md`; CI: `aws/tests/financial-remaining.test.mjs`, `aws/tests/api-financial.test.mjs`
- S14: `S14_DEPOSIT_PAYEE_LINE.md` (identify; stale FAIL), `S14_DEPOSIT_PAYEE_LINE_REMEDIATIONS.md`, `S14_PRODUCTION_PROMOTION.md`, `S14_PRODUCTION_SAFEGUARDS.md`

CI: `.github/workflows/aws-migration-ci.yml` → `bun run test:aws-api` → `aws/tests/*.test.mjs`.

---

## Scenario matrix (authoritative S1–S15)

| Scenario | Purpose | 1. Original test result | 2. Subsequent remediations | 3. Production promotion | 4. Regression safeguard | 5. Final accepted status |
| --- | --- | --- | --- | --- | --- | --- |
| S1 Normal control path | Upload → Review → Endorsing → sign → Ready; live deposit denied | PASS | None required | n/a | Not required | CLOSED / PASS |
| S2 Admin rollback — material edit | Material `payee_name` / `payee_type` invalidates signatures | **FAIL / MONEY-RISK** (historical) | Staging overlay PASS | PASS (`hjz0G98YOSPT2vyE9+Qy+n8a7pr87e2+Dgodm4zzC2A=`; still in current SHA) | Required + present (`S2 Material Endorsement Invalidation`) | **CLOSED / PRODUCTION PASS / CI SAFEGUARDED** |
| S3 Admin rollback — non-material edit | Notes/address/carrier save; signatures stay | PASS | None required | n/a | Cross-regression only | CLOSED / PASS |
| S4 Partial endorsement then rollback | Incomplete endorsements block Ready | PASS | None required | n/a | Cross-regression only | CLOSED / PASS |
| S5 Wrong claim association | No silent `claim_id` move; audited admin set/correct/clear before deposit | **PASS with gap / WORKFLOW-RISK** (later identify FAIL; historical) | Staging RPC + DEFINER SQL PASS | PASS (SQL + `workflow-rpc.mjs` → `4nRr0xh9SelxDuMAzNmgbbpWAaiWmPOgtiN14DkDXgM=`; still in current SHA) | Required + present (`S5 Audited Claim Association`) | **CLOSED / PRODUCTION PASS / CI SAFEGUARDED** |
| S6 Late mortgage discovery | Adding mortgage after insured sign blocks Ready | PASS | None required | n/a | Not required | CLOSED / PASS |
| S7 Duplicate action / double submit | Invalid second transition; idempotent prepare/submit | PASS | None required | n/a | Not required | CLOSED / PASS |
| S8 Timeout / unknown result | Hung submit stays pending; retry replays; no auto-correct | PASS | None required | n/a | Not required | CLOSED / PASS |
| S9 Duplicate / out-of-order webhooks | First confirm applies once | PASS | None required | n/a | Not required | CLOSED / PASS |
| S10 Multiple checks | Independent ACV vs supplement; no cross-consumption | PASS | None required | n/a | Not required | CLOSED / PASS |
| S11 Partial disbursement | Remaining = confirmed in − confirmed out | **PASS with gap / WORKFLOW-RISK** (historical) | Staging remaining-balance PASS 18/18 | PASS (`dplSPx8YJoYbkolr2c6mKersDAV7OCzHt5y3UyIOdoc=`; still in current SHA) | Required + present (`financial-remaining` / `api-financial`) | **CLOSED / PRODUCTION PASS / CI SAFEGUARDED** |
| S12 Tenant isolation | C1C cannot use Freedom money paths | PASS | None required | n/a | Not required | CLOSED / PASS |
| S13 Readiness after previously ready | Prepare not ready while `uploaded`; live CheckAlt blocked | PASS | None required | n/a | Not required | CLOSED / PASS |
| S14 Admin edit after deposit | `payee_line` immutable after `deposited_at` or confirmed deposit | **PASS with gap / WORKFLOW-RISK** (historical) | Staging lock PASS 15/15 | PASS (current SHA `zb7E5ptHPmRsBegkIFgNzq3rzBktHvpNCJ1QMTHM6l0=`) | Required + present (`S14 Deposit Payee Line Protection`) | **CLOSED / PRODUCTION PASS / CI SAFEGUARDED** |
| S15 Delete / reupload / replacement | DELETE requires reason; replacement is a new id/prefix | PASS after harness fix | Harness-only (`reason`); no product remediations | n/a | Not required | CLOSED / PASS |

---

## Historical original run (superseded overall FAIL)

The following is the first staging run (`P1ADV-1790299677228`). It is evidence of what was found, not the current Phase 1 status.

### Original verdict (superseded)

**PHASE 1 ADVERSARIAL MONEY-PATH AUDIT: FAIL**

One unresolved **MONEY-RISK** remained on staging at that time. No **BLOCKER** (wrong/duplicate live money movement or cross-tenant money authority) was demonstrated. Live CheckAlt/Moov production posts stayed off.

A narrow AWS write-path fix for the MONEY-RISK was prepared in the original branch and covered by unit tests. **At the time of that run it was not deployed** to staging or production. It was later accepted on staging, promoted, and safeguarded (see S2 closure records).

### Staging safety baseline (original run)

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

### Original scenario matrix (first run only)

| Scenario | Original result | Severity | Original finding | Original “fix needed” |
| --- | --- | --- | --- | --- |
| 1 Normal control path | PASS | — | Upload → Review → Endorsing → in-person sign → Ready. `mark_deposited` and live CheckAlt denied. | No |
| 2 Admin rollback — material edit | FAIL | MONEY-RISK | After return-to-review, amount/claim_id writes are denied. `payee_name` / `payee_line` / `funds_type` are writable. A signed endorsement **remains `signed`** after payee rename. Ready was blocked by `endorsement_state_ambiguous` (duplicate rows), not by invalidation. | Yes — prepared, not deployed |
| 3 Admin rollback — non-material edit | PASS | — | `review_notes`, `property_address`, `carrier_name` save. Harmless edits do not need to wipe signatures. | No |
| 4 Partial endorsement then rollback | PASS | — | Insured signed + mortgage pending + insured rename → Ready `403 endorsements_incomplete` / `required_payee_unsigned`. | No |
| 5 Wrong claim association | PASS with gap | WORKFLOW-RISK | `claim_id` write is `column_not_allowlisted`. Synthetic checks stay unlinked. Admin cannot correct a wrong claim on AWS. | Narrow admin RPC later |
| 6 Late mortgage discovery | PASS | — | Adding `mortgage_company` after an insured signature blocks Ready. Loss Draft is not auto-opened; deposit is still gated. | Optional later auto-route |
| 7 Duplicate action / double submit | PASS | — | Second `start_review` is `invalid_transition`. Repeat prepare/submit/disbursement prepare are idempotent. Parallel submit is one operation. | No |
| 8 Timeout / unknown result | PASS | — | `db_after_provider` stays `submitting` with `provider_reference`. Retry replays the same id. Reconcile reports `internal_pending_provider_succeeded` and does not auto-correct. | No |
| 9 Duplicate / out-of-order webhooks | PASS | — | First `deposit.cleared` applied once. Duplicate `applied=false`. Out-of-order ignored. Confirmed state did not regress. | No |
| 10 Multiple checks | PASS | — | $100 ACV and $50 supplement created independent ops. Disbursement B cannot consume A. Claim linkage was not creatable (see S5). | Optional later rerun on a real multi-check claim |
| 11 Partial disbursement | PASS with gap | WORKFLOW-RISK | Browser partial amount rejected. Sandbox disbursement is always the full check amount. Failed ops do not confirm money out. | Remaining-balance source |
| 12 Tenant isolation | PASS | — | C1C cannot read/transition/prepare/payee-write/message Freedom checks. Spoofed C1C tenant is ignored. Freedom wallets are not listed to C1C. | No |
| 13 Readiness after previously ready | PASS | — | Prepare records `readyForProvider=false` when the check is still `uploaded`. Live CheckAlt blocked. Moov sandbox handler evaluates current request/account fields. Production posts remain off. | No |
| 14 Admin edit after deposit | PASS with gap | WORKFLOW-RISK | Amount locked. Sandbox financial history not rewritten. `payee_line` still writable because sandbox confirm does not set `deposited_at`. | Lock material fields after confirmed provider op |
| 15 Delete / reupload / replacement | PASS after harness fix | — | Live DELETE requires `reason` (min 3 chars) and refuses rows with `check_billing_events`. Replacement gets a new id and `checks/{id}/` prefix. Obsolete id is not transitionable once deleted. | Harness now sends `reason` |

---

## Historical original findings (superseded by accepted remediations)

These findings are preserved as evidence of the first run. They are **not** current Phase 1 acceptance blockers.

### MONEY-RISK — S2-STALE-SIGNATURE-AFTER-PAYEE-CHANGE (historical)

**Final status:** CLOSED / PRODUCTION PASS / CI SAFEGUARDED.  
**Original status:** FAIL / MONEY-RISK on the first staging run.

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

**Actual (original run):** `tg_mirror_payee_to_endorsement` (staging SQL) **intentionally keeps signed/waived rows** on rename and inserts a new pending row for the new name. `evaluateEndorsementEligibility` fingerprints ids/types/statuses/`signed_at` and **never payee names**. Ready failed only because two rows for one `payee_id` are ambiguous. If the extra pending row is later removed or force-completed, the stale signed row can satisfy Ready.

**Affected (original run):**

- Staging DB trigger `public.tg_mirror_payee_to_endorsement`
- `POST /data/write` `check_payees` update (`aws/functions/api/write-check-workflow.mjs`)
- `evaluateEndorsementEligibility` / `endorsementStateFingerprint` in `checkalt-eligibility.mjs`
- `check_endorsements.status`, `signed_at`, official rear `checkalt_rear_fingerprint`

**Risk (original run):** Incorrect endorsement state. A deposit-eligible check can carry a signature that was not collected for the current payee. No live CheckAlt post occurred in this run (Ready blocked + provider mutation blocked).

**Subsequent remediations (accepted):** AWS write path on `payee_name` / `payee_type` change resets that payee’s endorsements to `pending`, drops duplicate rows, clears payee `endorsed_at`, clears official rear fingerprint, and writes `endorsement_invalidated_material_edit`. Implemented in `endorsement-material-invalidation.mjs` and `executePayees`. Staging rerun PASS; production overlay PASS; CI safeguard PASS.

A follow-up SQL rewrite of `tg_mirror_payee_to_endorsement` and an optional payee-name eligibility fingerprint were **not** required to close S2. They remain optional / deferred and are **NOT PHASE 1 ACCEPTANCE BLOCKERS**.

S2 was stopped after Ready was denied on the original run. No deposit/disbursement was attempted on that check.

### WORKFLOW-RISK — S5 claim reassignment locked (historical)

**Final status:** CLOSED / PRODUCTION PASS / CI SAFEGUARDED.  
**Original status:** PASS with gap / WORKFLOW-RISK (later identify FAIL).

On the original run, admin could not set or change `claim_id` on AWS (`column_not_allowlisted`). Workflow transitions refuse claim-linked checks. That prevented the adversarial “move from Claim A to Claim B” case and also prevented a live AWS admin correction. Audit history for a would-be reassignment could not be created.

**Subsequent remediations (accepted):** audited `admin_set_check_claim` RPC + `SECURITY DEFINER` SQL. Generic `/data/write` of `claim_id` stays denied. Staging 10-case accept PASS; production SQL + `workflow-rpc.mjs` overlay PASS; CI safeguard PASS.

### WORKFLOW-RISK — S11-NO-PARTIAL-AMOUNT-API (historical)

**Final status:** CLOSED / PRODUCTION PASS / CI SAFEGUARDED.  
**Original status:** PASS with gap / WORKFLOW-RISK.

On the original run, sandbox financial amounts came only from `check_intake_items.amount` (or the $123.45 fixture). Browser `amount_cents` is `untrusted_amount`. Idempotency was `sha256(tenant|operation|check|amount|USD)`, so a second disbursement prepare replayed the first. Failed ops stayed `provider_failed` and did not confirm money out.

Two successful partials could not be proved on staging sandbox at that time. No incorrect double disbursement was observed.

**Subsequent remediations (accepted):** server-derived remaining = `max(0, confirmed_in − confirmed_out)`, `requested_partial_cents`, sequence idempotency `seq:N`. Staging 18/18 PASS; production overlay PASS; CI tests in `test:aws-api`.

### WORKFLOW-RISK — S14-PAYEE-EDITABLE-AFTER-SIMULATED-DEPOSIT (historical)

**Final status:** CLOSED / PRODUCTION PASS / CI SAFEGUARDED.  
**Original status:** PASS with gap / WORKFLOW-RISK.

On the original run, after sandbox `deposit.cleared`, `amount` stayed locked and `aws_financial_operations.amount_cents` was unchanged (idempotent replay). `payee_line` remained writable because sandbox confirm does not set `deposited_at`.

**Subsequent remediations (accepted):** `isCheckDeposited` locks `payee_line` when `deposited_at IS NOT NULL` **or** a confirmed `checkalt_deposit` exists. Staging 15/15 PASS; production overlay PASS; CI safeguard PASS.

---

## Material vs non-material fields

### Original-run observation (superseded where noted)

| Field | Writable on AWS write path? (original) | Treated as material for endorsement invalidation (original) |
| --- | --- | --- |
| `amount` | No (`column_not_allowlisted`) | Locked |
| `claim_id` | No | Locked (no audited correction path yet) |
| `status` / `check_stage` | No (workflow transition or disabled admin RPC) | Workflow only |
| `routing_number` / `account_number` | No | Locked |
| `deposited_at` | No | Locked |
| `payee_name` (`check_payees`) | Yes | **Should be; was not on live staging** |
| `payee_type` | Yes | **Should be; was not on live staging** |
| `payee_line` | Yes | Descriptive; not used by eligibility fingerprint |
| `funds_type` | Yes | Workflow/reporting material; does not reset signatures |
| `carrier_name`, `check_number`, `issue_date` | Yes | Non-material |
| `review_notes`, `property_address`, `payee_address` | Yes | Non-material |
| `contact_email` / `contact_phone` | Yes | Non-material |

`admin_override_check_status` remains `rpc_disabled` / `financial_sensitive`.

### Accepted current state (not a new requirement)

- `payee_name` / `payee_type` changes invalidate endorsements on the AWS write path (S2).
- `claim_id` stays off generic `/data/write`; audited `admin_set_check_claim` is the pre-deposit correction path (S5).
- `payee_line` stays pre-deposit writable and locks after `deposited_at` or confirmed provider deposit (S14).
- Remaining-balance partials use `requested_partial_cents` and `seq:N` (S11).

---

## Financial reconciliation (original sandbox run)

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

Later S11 remediations proved two successful partials plus remainder against remaining balance on staging (18/18). That does not erase this original-run table.

## Tenant isolation

Freedom tester cannot be overridden to C1C by body/header spoof. C1C cannot read, transition, write payees/messages, list Freedom wallets, or prepare Freedom financial ops (`403 rls_denied`). Sharing/partner visibility was not granted money authority in these tests.

## Idempotency

Prepare, parallel simulate-submit, retry after `db_after_provider`, duplicate webhook, and repeat disbursement prepare all replayed the same `aws_financial_operations.id`. Out-of-order webhook did not apply. S11 later added sequence identity for legitimate distinct partials; same-sequence retry still replays.

## Rollback / material-edit / stale endorsement (original run)

These bullets describe the **first run**, not current accepted behavior:

- Return-to-review works and is audited (`aws_workflow_transition`, actor + from/to status).
- Amount/claim/status cannot be rewritten on the AWS write path.
- Payee identity **could** be rewritten and **did not** invalidate signatures on live staging at that time.
- Ready did not accept the stale signature in that run only because the trigger left a duplicate pending row (`endorsement_state_ambiguous`).

Accepted S2 behavior: material payee rename invalidates, collapses duplicates, clears the official rear fingerprint, and writes `endorsement_invalidated_material_edit`. Ready without a new signature fails as `endorsements_incomplete` / `required_payee_unsigned`.

## Audit trail

Workflow create/transition inserts `check_audit_log` with actor, timestamp, prior status, new status, and action. Admin override RPC is disabled.

On the original run, material payee rename did **not** write an invalidation audit on live staging. The accepted S2 remediations adds `endorsement_invalidated_material_edit`. Accepted S5 writes `admin_set_check_claim` audit rows for real claim changes (same-value is a no-op).

`DELETE /workflow/checks/:id` deletes child audit rows for synthetic unlinked checks. That is cleanup, not an admin correction path. Live DELETE also requires `reason` and refuses checks with `check_billing_events`.

## Synthetic staging records

Marker: `AWS P1 ADV P1ADV-1790299677228`

| Record | Status |
| --- | --- |
| Freedom workflow checks created in the run | Most deleted after evidence with `reason=P1ADV synthetic cleanup` |
| Sandbox `aws_financial_operations` | Cleaned via `POST /financial/cleanup` by marker |
| Retained (delete blocked by `check_billing_events`) | `b887bd62-1bb0-4d8b-bfc2-9e63d79e77bd`, `710c9494-04f1-4ff2-8bd3-da9cd8f4658c`, `1068ac20-08c2-4adb-a6cd-51437efaed73`, `ed194599-fe40-4dee-ae9c-015fec8674d4` — review notes marked leftover; not live-depositable |

No production records were written. The four billing-protected leftovers were deliberately retained. That is **NOT a Phase 1 acceptance blocker**.

## Original gaps that Phase 1 remediations later closed

The original “scenarios not fully completed” table is historical. Current status:

| Original gap | Why it existed then | Final |
| --- | --- | --- |
| Reassign check from Claim A to Claim B | `claim_id` not writable; transitions refuse claim-linked rows | Closed by S5 |
| Two successful partial disbursements against one remaining balance | Sandbox amount source was the full check amount | Closed by S11 |
| Production / confirmed-deposit `payee_line` lock | Sandbox confirm does not set `deposited_at`; no writer lock | Closed by S14 |
| Live CheckAlt/Moov money | Intentionally blocked; not used | Not a Phase 1 acceptance test |
| EMAIL_OTP / passkey UI login | Password login retired; operator AdminInitiateAuth used for API tests only | **NOT a Phase 1 acceptance blocker** |

---

## NOT PHASE 1 ACCEPTANCE BLOCKERS

These items remain optional, deferred, historical, or unrelated. They are **not** Phase 1 acceptance tests and do **not** create a Phase 2 program.

- Historical `503 data_query_failed` / claims-list issue (also seen on some S2 ready-path 503s; documented as pre-existing / non-fatal; S2 was not reopened)
- Deliberately retained billing-protected staging artifacts (`b887bd62-…`, `710c9494-…`, `1068ac20-…`, `ed194599-…`)
- Optional `tg_mirror_payee_to_endorsement` SQL rewrite (S2 closed on the AWS write path)
- Optional payee-name CheckAlt eligibility fingerprint
- Optional late-mortgage Loss Draft / Mortgage Ops auto-route (S6 already blocks Ready)
- Optional rerun of S10 on a real multi-check Freedom claim now that S5 exists (S10 itself PASSed)
- Future confirmation that staging keeps `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED` and `AWS_MOOV_TRANSFER_POST_ENABLED=false` after Moov GA in production
- Unrelated repo/production leftovers already identified (tenants allowlist insert/slug; ingest production tenant INSERT columns)
- EMAIL_OTP / passkey UI login vs operator API `AdminInitiateAuth` used for this program
- Live CheckAlt / Moov money movement (intentionally out of Phase 1)

The original run listed several of these as “Recommended Phase 2.” That list was follow-up ideas, not a formally defined acceptance phase. Items that were actual Phase 1 gaps (S2 deploy, S5 RPC, S11 remaining-balance, S14 lock) were completed inside Phase 1. No Phase 2 acceptance program is defined here.

---

## Prepared code at the original FAIL (historical)

At the time of the first FAIL, only S2 helper code existed and was **not deployed**:

- `aws/functions/api/endorsement-material-invalidation.mjs`
- `executePayees` update path in `write-check-workflow.mjs`
- `aws/tests/endorsement-material-invalidation.test.mjs`

Those files were later accepted on staging and promoted. S5, S11, and S14 remediations followed. Current accepted production remains `zb7E5ptHPmRsBegkIFgNzq3rzBktHvpNCJ1QMTHM6l0=`.
