# Phase 2 continuation — no shared-staging deploy

**Date:** 2026-09-13
**Inventory branch:** `cursor/phase2-inventory-awaiting-3bce` (PR #279)
**App tip:** `cursor/p11-mobile-check-center-clip-3bce` (PR #278)
**New app PRs:** #276 (P8), #280 (P9), #277 (P10), #278 (P11)
**Handoff:** `docs/audits/INTEGRATION_HANDOFF_2026-09-13.md`

Shared staging deployments are owned by Integration & Release. This workstream did not overlay, restore, or reconfigure `checksops-staging-api` or the shared SPA. Controls that need those Git fixes on staging are `AWAITING_INTEGRATION_DEPLOYMENT`, not product FAIL.

Git-fixed FAIL → AWAITING (11): A1-066, A1-067, A1-068, A5-088, A5-099, A5-114, A5-220, CC-219, CC-361, CC-368, P3-MOB-006.

Git-fixed BLOCKED → AWAITING (23): A4-013–A4-031 (`owner_isAdmin_false` view gate), A5-201–A5-204 (claim settlement write path).

Still FAIL (1): A8-035 Freedom identity (out of scope).

Phase 1 PASSes (CC-117, CC-047, CC-367, A4-043–046, X-021, X-029) are unchanged. Overlay-time physical evidence stands; Integration owns redeploy.

Readiness: **674 PASS / 1,136 live = 59.3%**. FAIL 1 (0.1%). AWAITING 34. BLOCKED 427 (254 internal + 173 external). BLOCKED → PASS this continuation: 0.

New app PRs stacked on P3b: P8 endorsement invalid-link, P9 owner CheckAlt view, P10 claim settlement writes, P11 mobile clip.

---

# Phase 1 internal-blocker remediation — inventory update

**Date:** 2026-09-12  
**Application branches:** `cursor/p1-endorsed-on-check-3bce` … `cursor/p7-branding-isolation-3bce` plus `cursor/p3b-claim-number-grant-3bce`  
**Inventory branch:** `cursor/phase1-inventory-update-3bce`  
**Staging API SHA after overlay:** `ei+nNC2uAykoe4liskuXS5uZgzho/PERcyG1Cwc8X6Y=`  
**Production:** unchanged (`checksops-production-prep-api` SHA `nkn7FhOZnRUHyzC6YwbyCEaZExtJDEM8YiRFczws+G0=` at 2026-09-12T18:09:50Z). Provider execution remained off. SES production sending was not involved.

Converted FAIL → PASS only with physical browser + API/DB evidence:

| ID | Defect | Evidence |
|---|---|---|
| CC-117 | Endorsed on Check false success | `/opt/cursor/artifacts/cc117_endorsed_on_check_success.mp4` |
| CC-047 | Review claim number persist | `/opt/cursor/artifacts/cc047_claim_success_toast.webp` |
| CC-367 | Status override dead RPC | `/opt/cursor/artifacts/cc367_override_public_links_c1c_branding.mp4` |
| A4-043–046 | C1C branding Freedom placeholders | `/opt/cursor/artifacts/p7_c1c_branding_condition_one.webp` |
| X-021 | Invoice token Cognito/SQL error | `/opt/cursor/artifacts/p5_invoice_invalid_link.webp` |
| X-029 | Pay-setup missing_cognito_token | `/opt/cursor/artifacts/p5_pay_setup_invalid_link.webp` |

Not converted (no physical UI evidence this phase, or out of scope): A1-066/067/068 (API toggle+restore only), CC-368 Skip Endorsements (API only), CC-219/CC-361 S3 image UI, A5-088/099/114/220 negatives UI, A8-035 Freedom identity, P3-MOB-006.

Readiness after this inventory update: **674 PASS / 1136 live = 59.3%**. FAIL 12 (1.1%). BLOCKED 450 (39.6%) of which internal 277 and external 173. BLOCKED → PASS this phase: 0. Starting internal BLOCKED 277 remains 277.

Do not begin Phase 2 automatically.

---

# ChecksOps complete functional audit

This file contains seven passes on 2026-09-11 / 2026-09-12:

1. **Blocked-Control Verification Pass (Pass 7, this continuation)** — reduce the 494 BLOCKED controls using staging fixtures and supported workflows. Results are at the top.
2. **Pass 6** — coverage closure on the exact remaining 76 unclicked IDs.
3. **Pass 5** — coverage expansion on remaining live unclicked controls.
4. **Pass 4** — field-level coverage expansion after Pass 3.
5. **Pass 3** — coverage expansion after Pass 2.
6. **Pass 2** — inventory reconciliation plus first physical staging interaction.
7. **Pass 1 (baseline)** — original 412-control audit preserved below.

**Verdict: CONDITIONAL GO** for C1C tenant-admin and platform-owner staging workflows. **NO-GO** for Freedom admin identity (`identity_not_linked`) and for treating production `checksops.com` as a clean production SPA (Pass 1 P0 banner still unreleased).

Inventory classification is **100%** (1,421 / 1,421). That is not an operational certification. The primary readiness metric is **proven operational: 665 / 1,136 live non-N/A = 58.5%** (was 55.1% before this verification pass). Do not use the stale Pass 6 executable denominator (576 / 1,283 = 44.9%). Do not treat 100% classification as a go-live for SES, CheckAlt, ACH, Freedom identity, or money movement.

---

# Blocked-Control Verification Pass — metric reconciliation and taxonomy

**Date:** 2026-09-12  
**Auditor:** Cursor Cloud Agent  
**Branch:** `cursor/blocked-control-verification-3bce`  
**Scope:** Do not recrawl. Do not change production or application code. Do not enable real ACH, Moov, CheckAlt, Plaid, or other provider execution. Do not modify SES. Unlock BLOCKED controls only with synthetic staging fixtures and supported workflows.

## Coverage-math reconciliation (do this before testing)

Pass 6 module totals reconcile:

| Bucket | Count |
|---|---|
| PASS | 626 |
| FAIL | 16 |
| BLOCKED | 494 |
| N/A | 285 |
| **Total** | **1,421** |

Pass 6 also reported `executable IDs = 1,283` and `executable operational PASS = 576 / 1,283 (44.9%)`. That denominator is **stale/misleading**. It is `safety ∈ {executable, executable_or_ui}` from the original crawl, not live/non-N/A controls.

Why 576 / 1,283 is wrong as an operational rate:

* 1,283 safety-executable rows include **271 N/A** controls (dead JSX / never-mounted). Those inflate the denominator.
* **50 PASS** rows have `safety=provider_blocked` (48) or `safety=email_blocked` (2). Those were excluded from 576 even though `result=PASS`.
* Operational readiness is PASS among controls that still matter, i.e. live/non-N/A.

Correct Pass 6 / pre-verification metrics (authoritative going forward):

| # | Metric | Formula | Value |
|---|---|---|---|
| 1 | Total live/non-N/A controls | 1,421 − 285 | **1,136** |
| 2 | PASS rate among live | 626 / 1,136 | **55.1%** |
| 3 | FAIL rate among live | 16 / 1,136 | **1.4%** |
| 4 | BLOCKED rate among live | 494 / 1,136 | **43.5%** |
| 5 | Proven-operational rate | PASS / live non-N/A | **55.1%** |

Classification coverage remains **1,421 / 1,421 = 100%**. It is no longer the primary readiness metric.

## Pre-verification blocker taxonomy (all 494 tagged)

Every BLOCKED control now has exactly one PRIMARY `blocker_category` and a `blocker_root_cause`. Optional `blocker_secondary` records a second dependency.

| Category | Controls | Distinct root causes (pre-test) |
|---|---|---|
| BLOCKED_FIXTURE | 170 | empty review queue, tokens, invoices, settlements, share-thread, class options |
| BLOCKED_PROVIDER | 110 | provider_execution, payment_account_already_active, funds lanes, CheckAlt deposit |
| BLOCKED_UNSAFE_IRREVERSIBLE | 102 | previously withheld persistence (re-evaluate on synthetics) |
| BLOCKED_EMAIL_EXTERNAL | 37 | SES send / invite / invoice / tracking email |
| BLOCKED_EMAIL_OTP | 24 | MortgageOps / Sign queue OTP |
| BLOCKED_MISSING_FEATURE | 24 | custom domain, never-mounted live UI |
| BLOCKED_AUTH_DEFECT | 19 | owner `isAdmin=false` |
| BLOCKED_STATUS | 4 | CC-363–CC-366 deposit/undo/force-move |
| BLOCKED_IDENTITY | 2 | Freedom admin `identity_not_linked` (CheckAlt Manager) |
| BLOCKED_STAGING_INFRA | 2 | S3 authorized object missing; admin override RPC |
| BLOCKED_OTHER | 0 | — |
| **Total** | **494** | **see JSON `pass7_blocker_taxonomy_pre_verification`** |

Top pre-test root causes (control count):

* 57 `empty_review_queue` (56 CheckReviewConsole + DepositPacketGenerator)
* 50 `provider_execution`
* 45 `payment_account_already_active`
* 28 `accepted_claim_portal_token_unavailable`
* 24 `email_otp_required`
* 19 `owner_isAdmin_false`
* 19 `valid_paysetup_token_unavailable`

Control-level blocked: **494**. Root-cause-level: these are not 494 unique problems.

---

## Physical verification results

No application code was patched. No SQL inserts. No provider flags. No Cognito identity linking. No SES. No production authenticated workflows. Branding Save was not clicked. Provider execution stayed OFF. No ACH / Moov transfer / wallet funding / CheckAlt execution. PASS is never inferred from source inspection.

### Corrected operational metrics

| Metric | Before (Pass 6, corrected) | After this pass |
|---|---|---|
| Inventory classified | 1,421 / 1,421 (100%) | **1,421 / 1,421 (100%)** |
| Live / non-N/A | 1,136 | **1,136** |
| PASS | 626 | **665** |
| FAIL | 16 | **21** |
| BLOCKED | 494 | **450** |
| N/A | 285 | **285** |
| Proven operational | 626 / 1,136 = **55.1%** | 665 / 1,136 = **58.5%** |
| Known failing | 16 / 1,136 = 1.4% | 21 / 1,136 = **1.8%** |
| Still unproven | 494 / 1,136 = 43.5% | 450 / 1,136 = **39.6%** |

Stale Pass 6 `576 / 1,283 (44.9%)` is retired. Do not use it.

### Blocked reduction

| Conversion | Count |
|---|---|
| BLOCKED → PASS | **39** |
| BLOCKED → FAIL | **5** |
| Remaining BLOCKED | **450** |

The 39 PASSes are almost entirely CheckReviewConsole children that were blocked as `empty_review_queue` even though Pass 6 already had a Review card. This pass created dedicated synthetic `BCV-1789231254420-REV` (`needs_review`) and physically operated the queue + decision panel.

The 5 new FAILs:

| ID | Defect | What happened |
|---|---|---|
| `CC-047` | `P2-review-claim-number-column-not-allowlisted` | Save claim # → `column_not_allowlisted`. `detected_claim_number` is not on the AWS intake write allowlist. DB stayed null. |
| `CC-117` | `P1-endorsed-on-check-toast-without-persist` | **P1.** UI toasted “marked endorsed on the check”. `check_payees.endorsement_status` still `pending`. Public `/endorse?token=` then says the link was already used or replaced. |
| `CC-361` | `P2-staging-s3-authorized-object-missing` | Supported upload / placeholder `pending_front.jpg` → `/storage/sign` **404 `object_not_in_s3`**. `back_image_path` stayed null. Not patched. |
| `CC-367` | `P2-admin-override-rpc-not-enabled-ui` | UI RPC `admin_override_check_status` is `rpc_disabled`. **HTTP `POST /workflow/override` works** (200, `needs_review`, then restored to endorsing). UI does not call that path. |
| `CC-368` | `P2-skip-endorsements-allowlist` | Skip Endorsements → `Move failed / column_not_allowlisted`. Writes `endorsement_status`, which is not allowlisted. |

`A1-066` `A1-067` `A1-068` were already FAIL. Reproduced on Pipeline Test only. Not reclassified.

### Blocker taxonomy after verification

| Category | Controls | Distinct root causes (examples) |
|---|---|---|
| BLOCKED_FIXTURE | 128 | claim-portal token, pay-setup token, invoices, settlements, CRC payee row |
| BLOCKED_PROVIDER | 110 | ACH/wallet/Moov/CheckAlt/Plaid; funds released/received lanes |
| BLOCKED_UNSAFE_IRREVERSIBLE | 100 | remaining withheld persistence (config, Sign, returned-check, etc.) |
| BLOCKED_EMAIL_EXTERNAL | 37 | SES send / invite / invoice / tracking |
| BLOCKED_EMAIL_OTP | 24 | MortgageOps / Sign queue OTP |
| BLOCKED_MISSING_FEATURE | 24 | custom domain, never-mounted live UI |
| BLOCKED_AUTH_DEFECT | 19 | owner `isMasterOwner=true` but `roles=[]` / `isAdmin=false` |
| BLOCKED_STATUS | 4 | CC-363–CC-366; Ready for Deposit still 0 |
| BLOCKED_STAGING_INFRA | 2 | remaining S3 viewer/reupload children |
| BLOCKED_IDENTITY | 2 | Freedom admin `identity_not_linked` (CheckAlt Manager) |
| BLOCKED_OTHER | 0 | — |
| **Total** | **450** | **95 distinct `blocker_root_cause` values** |

Control-level blocked: **450**. Root-cause-level: **95** distinct blockers, not 450 unique problems. The largest clusters:

| Controls | Root cause |
|---|---|
| 50 | `provider_execution` |
| 45 | `payment_account_already_active` |
| 28 | `accepted_claim_portal_token_unavailable` |
| 24 | `email_otp_required` |
| 19 | `owner_isAdmin_false` |
| 19 | `valid_paysetup_token_unavailable` |
| 16 | `unsafe_persist_checkcommandcenter` |
| 14 | `ses_email` |
| 14 | `control_not_in_live_ui` |
| 13 | `empty_settled_payments` |

`empty_review_queue` is **gone** (0 remaining). That was 57 controls → 1 root cause, and it was unlockable with a synthetic review check.

### Proven operational rate

**665 / 1,136 = 58.5%**

### Remaining internal vs external blockers

| Bucket | Count | Meaning |
|---|---|---|
| Externally blocked (provider / email / OTP / identity) | **173** | Legitimate to leave untested without real providers, SES, OTP, or Freedom identity linking |
| Internally blocked (fixture / status / staging-infra / auth-defect / unsafe / missing-feature) | **277** | Next remediation candidates inside staging |

Internal next (highest leverage):

* CRC payee persist (`crc_payee_add_did_not_persist` / `no_crc_payee_row`) so merge/edit/remove and Submit Review Decision can be clicked enabled
* Allowlist `detected_claim_number` and `endorsement_status` **or** point UI at `/workflow` + `/functions/v1/check-endorsement` that already exist
* Point StatusOverride at `POST /workflow/override` (already 200 in staging)
* Staging S3 objects for the supported upload path (do not patch during audit)
* `claim_settlements` write allowlist + a C1C claim row so ledger math can be reconciled
* Mint pay-setup / invoice / claim-portal tokens without SES

External remainder is mostly wallet/ACH/CheckAlt/Plaid, SES sends, MortgageOps OTP, and Freedom admin identity.

### Synthetic fixtures

| Fixture | ID / number | How created | Disposition |
|---|---|---|---|
| Review check | `b6cfd8d3-…` `BCV-1789231254420-REV` | `POST /workflow/checks` + `start_review` | **Retained.** `needs_review`. Issue date `2026-09-01` persisted. Property address restored to `101 BCV Review Lane`. |
| Endorsing check | `73c74836-…` `BCV-1789231254420-END` | create + `start_endorsing` + allowlisted payee insert | **Retained.** Payee `BCV Synthetic Insured` still `pending` after false endorsed toast. HTTP override probed then restored to endorsing. |
| Ready-attempt check | `80c13d6f-…` `BCV-1789231254420-RDY` | create + endorsing; `mark_ready_for_deposit` 403 | **Retained.** Cannot reach Ready for Deposit without completed endorsements. |
| Image check | `b714c247-…` `BCV-1789231254420-IMG` | `POST /workflow/checks` | **Retained.** Placeholder `pending_front.jpg` is **not** in S3. |
| Persist check | `9782cb06-…` `BCV-1789231254420-SAV` | create + `start_endorsing` | **Retained.** Safe `property_address` write verified 200. |
| PR235 ledger tokens | claim `266e1ae8-…` | pre-existing synthetic | **Retained / reused.** `/ledger/:token` valid. `/h/claim/:sameToken` invalid (different token type). |
| Pipeline Test switches | tenant `/pipeline-test-68d1b910` | n/a | **Not mutated.** Allowlist rejected the write. |

Cleaned: review property address restored after the persist probe. No SQL rows inserted. No real customer tokens used (Pam Daugherty Freedom tokens were not opened).

### Public tokens

* Valid endorsement token on the synthetic payee: `/endorse?token=` → “already been used or replaced” after the false CC-117 toast (token consumed without a signed row).
* Invalid endorsement token: same error (not a clean “malformed” message).
* Valid PR235 synthetic ledger token: homeowner ledger mounts. Received $1,500 / Deposited $1,500 / Released $0 / Remaining $1,500. No admin chrome. No `tenant_id` UUID leak.
* Same token on `/h/claim/:token`: invalid/expired — claim-portal tokens are a different mint.
* `/invoice/not-a-token`: still `missing_cognito_token` (existing P2).
* `/pay-setup/not-a-token`: setup chrome still mounts (no valid token; not converted to PASS).
* No supported SES-free mint for invoice, pay-setup, or claim-portal tokens. Those stay `BLOCKED_FIXTURE` + `BLOCKED_EMAIL_EXTERNAL`.

### New defects

| ID | Sev | Summary | Status |
|---|---|---|---|
| `P1-endorsed-on-check-toast-without-persist` | **P1** | Endorsed on Check toasts success; payee/endorsement rows stay pending; public token is spent | NEW |
| `P2-review-claim-number-column-not-allowlisted` | P2 | CRC Save claim # writes a prohibited column | NEW |
| `P2-skip-endorsements-allowlist` | P2 | Skip Endorsements writes non-allowlisted `endorsement_status` | NEW |
| `P2-admin-override-rpc-not-enabled-ui` | P2 | UI RPC disabled; HTTP `/workflow/override` already works | NEW (narrowed from BLOCKED) |
| `P2-claim-settlements-table-not-allowlisted` | P2 | Supported ClaimSettlementEditor save cannot insert; table not on write allowlist; C1C has 0 claims | NEW (observed via API; editor did not mount without `claim_id`) |

### Existing defects

| Defect | This pass |
|---|---|
| P0 production banner | NOT RETESTED |
| P0 Freedom `identity_not_linked` | NOT RETESTED (controls kept `BLOCKED_IDENTITY`; not substituted with C1C) |
| P1 four inconsistent status/stage rows (incl. PR235 UI uploaded vs API deposited) | NOT MODIFIED |
| P2 C1C Freedom branding placeholders | NOT RETESTED (Save not clicked) |
| P2 owner CheckAlt `isAdmin=false` | CONFIRMED via `/identity/me` (`isMasterOwner=true`, `roles=[]`) — kept `BLOCKED_AUTH_DEFECT` |
| P2 invoice/pay-setup `missing_cognito_token` | REPRODUCED on `/invoice/not-a-token` |
| P2 staging S3 authorized objects | REPRODUCED (`object_not_in_s3`) |
| P2 dynamic import 404 | NOT RETESTED |
| P2 `P2-tenant-switch-column-not-allowlisted` | **REPRODUCED** on Pipeline Test Active / Founding / Test |
| P3 negative amounts | NOT RETESTED |

### Answer to the phase question

Of the original **494** blocked controls:

* **173** are blocked by legitimate external boundaries (provider, SES, OTP, Freedom identity).
* **277** are still internal (fixtures, allowlists, S3, UI-vs-HTTP mismatch, withheld persistence, missing live features).
* **39** were safely proven PASS with synthetic fixtures and supported workflows.
* **5** were proven FAIL rather than left as generic BLOCKED.

The 494 were not 494 unique problems. `empty_review_queue` alone had been 57 controls → 1 root cause, and it unlocked once a review fixture existed.

---

# Pass 6 — Coverage closure (physical interaction)


# Pass 6 — Coverage closure (physical interaction)

**Date:** 2026-09-12  
**Auditor:** Cursor Cloud Agent  
**Branch:** `cursor/full-staging-e2e-audit-3bce`  
**PR:** https://github.com/michaelcarletta-cmd/ChecksOps/pull/237  
**Scope:** Resolve the exact remaining 76 UNTESTED inventory IDs. Work from the Pass 5 remainder list, not a new crawl. Create synthetic staging fixtures through supported UI when required to mount child controls. Do not fix defects. Do not reopen the 475 already-classified BLOCKED controls except to mount one of these 76 IDs. Email/SES remains out of scope. Provider execution stays OFF.

## Coverage

| Metric | Pass 5 | Pass 6 |
|---|---|---|
| Discovered | 1421 | **1421** |
| Previously classified | 1345 | **1345** |
| Newly physically executed / classified this pass | — | **76** (every worklist ID) |
| Newly PASS | — | **40** (`pass=6`) |
| Newly FAIL | — | **3** (`A1-066` `A1-067` `A1-068`) |
| Newly BLOCKED | — | **19** |
| Newly N/A | — | **14** (dead `PayeeManager` / `EditablePayeeCard` / `PayeeCard` / `RerunOcrButton`) |
| Cumulative classified | 1345 | **1421** |
| PASS | 586 | **626** |
| FAIL | 13 | **16** |
| BLOCKED | 475 | **494** |
| N/A | 271 | **285** |
| Untested / unclicked | 76 | **0** |
| Raw classification coverage | 94.7% | **100%** (1421 / 1421) |
| Executable IDs | 1283 | **1283** |
| Executable classified | 1207 | **1283** |
| Executable classification coverage | 94.1% | **100%** (1283 / 1283) |
| Executable operational PASS | — | **44.9%** (576 / 1283) |

A BLOCKED control is classified, not proven operational. 100% inventory classification does **not** mean the product is operationally certified.

Machine-readable inventory: `docs/audits/inventory-2026-09-11.json`, `.csv`.

## Exact 76-ID disposition

ID | Control | Action performed | Result | Evidence/Blocker
---|---|---|---|---
CC-315 | Back to funds released | Mobile 390px Funds Released lane; confirmed 0 checks | BLOCKED | `empty_fixture`
CC-316 | Back to funds received | Mobile Funds Received lane; confirmed 0 checks | BLOCKED | `empty_fixture`
CC-317 | Back to queue | Selected Review `#Pending` card on mobile; clicked Back to queue | PASS | `pass6_micro_mobile_review_detail.png`
CC-333 | Share check with partner | List/detail share icon; Escape | PASS | `pass6_retry_e2e_detail.png`
CC-334 | Mark check returned by bank | Deposited-list icon; Cancel; not confirmed | PASS | `pass6_retry_mark_returned.png`
CC-337 | Back to checks | Mobile E2E detail | PASS | `pass6_retry_mobile_e2e.png`
CC-351 | Re-run OCR | Admin tools mount-check; function never referenced in JSX | N/A | `function_not_rendered_in_live_route_tree`
CC-361 | Upload Back of Check (Overview) | E2E + AUDIT Overview; prompt did not mount (View Check Images only) | BLOCKED | `staging_s3_or_image_urls_unavailable`
CC-362 | CheckAlt Deposit | Not mounted on incomplete E2E | BLOCKED | `control_not_in_live_ui` (would be `provider_execution` if mounted)
CC-363 | Open for Mobile Deposit | Requires complete endorsements + CheckAlt off | BLOCKED | `control_not_in_live_ui`
CC-364 | Undo Decision | `canUndo` false | BLOCKED | `control_not_in_live_ui`
CC-365 | Move to Deposited | Needs `branch_deposit_required` | BLOCKED | `control_not_in_live_ui`
CC-366 | Force Move to Deposited | Needs stalled branch approval | BLOCKED | `control_not_in_live_ui`
CC-367 | Mark as Deposited | Override to Ready for Deposit saved; AWS RPC rejected | BLOCKED | `staging_rpc_not_enabled`
CC-368 | Skip Endorsements — Already Signed | Visible on E2E Payee Endorsements; not clicked | BLOCKED | `unsafe_persist`
CC-369 | Adjust Received Endorsement | No `back_image_path` | BLOCKED | `missing_fixture`
CC-370 | Add/Remove Pay to Order Text | Requires back image | BLOCKED | `missing_fixture`
CC-371 | Retry Loading | Adjuster not opened | BLOCKED | `missing_fixture`
CC-372 | Close adjuster | Adjuster not opened | BLOCKED | `missing_fixture`
CC-373 | Generate Endorsement Packet | Audit tab Generate | PASS | `pass6_focus_audit.png`
CC-374 | Preview packet | Preview clicked | PASS | packet chrome present
CC-375 | Download packet | Not clicked | BLOCKED | `unsafe_persist`
CC-380 | Multi-Payee SelectTrigger | Overview pencil → boolean select | PASS | `pass6_retry_overview.png`
CC-381 | SelectItem Yes | Mounted in Multi-Payee editor | PASS | SelectContent opened
CC-382 | SelectItem No | Mounted in Multi-Payee editor | PASS | SelectContent opened
CC-383 | Edit Check # input | Opened; cancelled | PASS | edit=true
CC-384 | Save field | Withheld | BLOCKED | `unsafe_persist`
CC-385 | Cancel editing | Clicked | PASS | aria Cancel editing
CC-386 | Edit ${label} pencil | Multi-Payee / Check # / Carrier | PASS | opacity forced
CC-392 | PayeeManager SelectItem | No JSX consumer | N/A | dead source
CC-393 | PayeeManager SelectItem | No JSX consumer | N/A | dead source
CC-395 | PayeeManager Mortgage Company | No JSX consumer | N/A | dead source
CC-396 | PayeeManager Contractor | No JSX consumer | N/A | dead source
CC-400 | EditablePayeeCard name | No JSX consumer | N/A | dead source
CC-401 | EditablePayeeCard type trigger | No JSX consumer | N/A | dead source
CC-402 | EditablePayeeCard type item | No JSX consumer | N/A | dead source
CC-403 | EditablePayeeCard type item | No JSX consumer | N/A | dead source
CC-404 | EditablePayeeCard Insured | No JSX consumer | N/A | dead source
CC-405 | EditablePayeeCard Mortgage Company | No JSX consumer | N/A | dead source
CC-406 | EditablePayeeCard Contractor | No JSX consumer | N/A | dead source
CC-407 | EditablePayeeCard Save | No JSX consumer | N/A | dead source
CC-413 | PayeeCard Email | Never rendered; live Email is CC-113 | N/A | dead source
CC-099 | Payee name | P6 Synthetic Payee | PASS | persisted then removed
CC-100 | Email (optional) | p6-payee@example.test | PASS | form
CC-101 | Payee type SelectTrigger | Opened | PASS | five type options
CC-102 | Public Adjuster | Observed in type list | PASS | listed
CC-103 | Other | Observed in type list | PASS | listed
CC-104 | Insured | Observed in type list | PASS | listed
CC-105 | Mortgage Company | Observed in type list | PASS | listed
CC-106 | Contractor | Selected for synthetic payee | PASS | Contractor
CC-107 | Add | Persisted P6 Synthetic Payee | PASS | later removed
CC-109 | Add Payee | Opened dashed form | PASS | `pass6_focus_payee.png`
CC-110 | Mark All Endorsements Received | Opened; Confirm not clicked | PASS | `pass6_focus_mark_all.png`
CC-112 | Mortgage Upload Back of Check | P6 Synthetic Mortgage persisted; chooser; payee removed | PASS | `pass6_micro_mortgage.png`
CC-113 | Endorsement Email | p6-endorse@example.test | PASS | filled
CC-114 | CC contractor | Checkbox + contractor email | PASS | filled
CC-115 | Send Endorsement Request | Withheld | BLOCKED | `ses_email`
CC-116 | Sign in Person | Dialog opened | PASS | `pass6_focus_inperson.png`
CC-117 | Endorsed on Check | Visible; not clicked | BLOCKED | `unsafe_persist`
CC-118 | Clear | Canvas clear | PASS | in-person dialog
CC-119 | Consent checkbox | Checked | PASS | then cancelled
CC-120 | Cancel | Closed without capture | PASS | no e-sign
CC-121 | Capture signature | Withheld | BLOCKED | `unsafe_persist`
CC-148 | Auto-detect | Local `/tmp/pass6-front.png` | PASS | `pass6_cropper.png`
CC-149 | Reset | Cropper Reset | PASS | cropper
CC-150 | Use this crop | Local confirm; later upload Failed to fetch | PASS | no provider
CC-151 | Cancel | Closed cropper | PASS | then re-selected file
CC-218 | Replace Front | Admin tools; file not confirmed | PASS | `pass6_retry_admin_tools.png`
A1-037 | Replace logo | C1C Branding & Email; chooser; no Save Branding | PASS | `pass6_micro_branding.png`
A1-066 | Active switch | Pipeline Test toggle | FAIL | `column_not_allowlisted`
A1-067 | Founding switch | Pipeline Test toggle | FAIL | `column_not_allowlisted`
A1-068 | Test switch | Pipeline Test toggle | FAIL | `column_not_allowlisted`
A7-117 | Homeowner name | `#hlink-name` P6 Homeowner; Cancel; Send not clicked | PASS | `pass6_micro_tracking.png`
A7-118 | Email | `#hlink-email` | PASS | p6-ho@example.test
A7-119 | Phone | `#hlink-phone` | PASS | 5550199
A2-020 | Scenario name | Client Savings; P6-SCENARIO then restored Current Plan | PASS | `pass6_micro_savings.png`

`CC-400`–`CC-407` are eight IDs, all N/A. Every original Pass 6 worklist ID appears above.

## Module totals

| Module | Discovered | PASS | FAIL | BLOCKED | N/A | Unclassified |
|---|---|---|---|---|---|---|
| admin | 152 | 116 | 3 | 25 | 8 | **0** |
| settings | 231 | 47 | 4 | 45 | 135 | **0** |
| payments_wallet | 312 | 147 | 4 | 148 | 13 | **0** |
| mortgage_ops | 21 | 6 | 0 | 15 | 0 | **0** |
| homeowner | 171 | 62 | 0 | 101 | 8 | **0** |
| public | 107 | 83 | 1 | 9 | 14 | **0** |
| check_center | 390 | 164 | 2 | 130 | 94 | **0** |
| extra_public_or_auth | 37 | 1 | 2 | 21 | 13 | **0** |
| **Total** | **1421** | **626** | **16** | **494** | **285** | **0** |

Executable classification is 100% in every module (denominator unchanged at 1,283). Operational PASS among executable IDs is 576 / 1,283 (**44.9%**).

## New defects

### P0

None this pass.

### P1

None newly opened. Four inconsistent status/stage rows were not modified. E2E was not left in Review: `admin_override_check_status` is not enabled for AWS staging writes (`This RPC is not enabled for AWS staging reads, or it is a write/provider operation`).

### P2

| ID | Summary | Status |
|---|---|---|
| `P2-tenant-switch-column-not-allowlisted` | Platform-owner Active / Founding / Test switches on `ChecksOps Pipeline Test` toast **Update failed / `column_not_allowlisted`**. Controls mounted and were trusted-clicked. C1C and Freedom were not toggled. Founding did not rewrite `monthly_rate_cents`. Test did not rewrite `moov_environment`. | **NEW this pass** (`A1-066` `A1-067` `A1-068` FAIL) |

### P3

None newly opened. Negative-amount FAILs were not retested this pass.

## Existing defects

| Defect | This pass |
|---|---|
| P0 production `checksops.com` staging-banner / environment presentation | **NOT RETESTED** |
| P0 Freedom admin `identity_not_linked` (`A8-035`) | **NOT RETESTED** (not retried) |
| P1 four inconsistent status/stage rows | **NOT RETESTED** / not modified |
| P2 C1C Freedom branding placeholders | **NOT RETESTED** (Save still not clicked) |
| P2 platform owner `isAdmin=false` CheckAlt | **NOT RETESTED** |
| P2 invalid invoice route missing `payment_invoices` relation | **NOT RETESTED**; still **not marked resolved** |
| P2 staging S3 “Authorized object is not present” | **REPRODUCED** as missing Overview back-upload chrome on E2E/AUDIT (`CC-361` BLOCKED) |
| P2 intermittent dynamic import 404 | **NOT RETESTED** |
| P3 New Invoice −1 / cash-job negatives | **NOT RETESTED** |
| P3 mobile clipping / override reason | **NOT RETESTED** |
| `claim_settlements` 200 empty | **NOT RETESTED**; no inserts |

No existing defect was silently dropped. None **RESOLVED BY EXTERNAL CHANGE**. Override RPC rejection is a **different error** than a successful status move; it does not resolve the P1 status/stage rows.

## Synthetic fixtures

| Fixture | Purpose | Records modified | Cleanup | Retained |
|---|---|---|---|---|
| `/tmp/pass6-front.png` `/tmp/pass6-back.png` | Local cropper | None persisted (Upload for Manual Entry **Failed to fetch**) | Local files only | No DB row from this upload |
| `P6 Synthetic Payee` (Contractor) on `#E2E-1789149838411` | Mount Add Payee / type list / in-person / email / CC | `check_payees` insert | Removed via Remove payee | Not present after cleanup |
| `P6 Synthetic Mortgage` on E2E | Mount mortgage Upload Back of Check (`CC-112`) | `check_payees` insert | Removed (`P6 Synthetic Mortgage removed` toast) | Not present; E2E Test Payee intact (1 pending) |
| Admin override E2E → Ready for Deposit | Mount Mark as Deposited | **No persist** (RPC not enabled) | N/A; E2E remained Endorsing | E2E `#E2E-1789149838411` still endorsing $2,345.67 |
| Tracking dialog fills on `#PR235-1001` | A7-117–119 | Local dialog state only; Send not clicked | Cancel | PR235 unchanged |
| PricingOptimizer Scenario name | A2-020 | Local only; restored to `Current Plan` | Restored | No DB write (page copy: nothing saved to DB) |
| C1C Replace logo chooser | A1-037 | File chooser only | No upload / no Save Branding | C1C logo unchanged |
| Pipeline Test Active/Founding/Test switches | A1-066–068 | Attempted update **rejected** | State unchanged | Pipeline Test still inactive / test account |
| Review `#Pending` Unknown insured $0 | Used for `CC-317` only | None | Not deleted (may be leftover from failed manual-entry upload) | **Intentionally retained** — Review queue still shows 1 check Awaiting routing |

C1C and Freedom Active/Founding/Test switches were never toggled. PR235 was not overridden. The four inconsistent status/stage rows were not touched.

## Remaining blockers (grouped)

Pass 6 added 19 BLOCKED IDs. Cumulative BLOCKED is **494**. Groups below are what would need to be unlocked to *test* them — not a request to unlock production money movement.

| Dependency | What it unlocks | Pass 6 examples | Safe staging unlock? |
|---|---|---|---|
| SES/email | Send Endorsement Request; tracking **Send link**; remaining homeowner emails | `CC-115` | SES sandbox + synthetic recipients only |
| EMAIL_OTP | Login OTP / verify-account | (prior; not reopened) | Staging OTP inbox for UAT users |
| Freedom identity | Freedom admin Check Center | (prior `identity_not_linked`) | Link `mcarletta@freedomadj.com` in staging only |
| Provider execution | CheckAlt Deposit, ACH, Moov send | `CC-362` if endorsements complete | Keep off for real money; optional sandbox CheckAlt on a synthetic check |
| Missing fixture/data | Funds Released/Received back buttons; endorsement adjuster; packet download after generate | `CC-315` `CC-316` `CC-369`–`CC-372` | Seed synthetic deposited/released checks; upload a synthetic back image on E2E |
| Authorization defect | Owner CheckAlt `isAdmin=false` | (prior) | Separate identity fix |
| Staging infrastructure/data | S3 authorized objects; `admin_override_check_status` RPC; tenant update allowlist | `CC-361` `CC-367`; related `A1-066`–`068` FAIL | Allowlist synthetic-check RPC + test-tenant columns; fix staging S3 objects |
| Unsafe configuration mutation | Save field, skip endorsements, waive, capture signature, packet download | `CC-368` `CC-117` `CC-121` `CC-375` `CC-384` | Allowed on synthetic checks with restore |
| Other / unmounted in current state | Deposit/undo/force-move until status matches | `CC-363`–`CC-366` | Unlocked by staging RPC + synthetic status moves |

## NEXT-PHASE RECOMMENDATION

After classification closure, a **Blocked-Control Verification Pass** can safely unlock, **in staging only** and **without real production money movement**:

1. Enable `admin_override_check_status` for synthetic C1C checks so Review / Ready for Deposit / branch-deposit children can be mounted and then restored.
2. Allowlist tenant `subscription_status` / `is_founding_partner` / `is_test_account` updates **only** for `ChecksOps Pipeline Test` (already inactive + test).
3. Put a synthetic back image on `#E2E-1789149838411` (or a new manual-entry check once upload fetch is fixed) to open Adjust Received Endorsement / Pay to Order / Retry Loading.
4. Seed one synthetic Funds Released and one Funds Received check for the mobile back buttons.
5. Point SES at a sandbox/sink for endorsement-request and tracking-link **Send** on synthetic payees/emails (`p6-*@example.test`).
6. Do **not** enable live CheckAlt/ACH/Moov execution against real bank accounts. If a sandbox CheckAlt deposit is required, use only the synthetic E2E/AUDIT checks.

Do **not** implement those changes in Pass 6. This pass is audit closure only.

---


# Pass 5 — Coverage expansion (physical interaction)

**Date:** 2026-09-12  
**Auditor:** Cursor Cloud Agent  
**Branch:** `cursor/full-staging-e2e-audit-3bce`  
**PR:** https://github.com/michaelcarletta-cmd/ChecksOps/pull/237  
**Scope:** Continue Pass 4. Physically operate remaining live, mounted controls on `https://staging.checksops.com`. Do not restart the audit. Do not fix defects. Do not revisit the 258 unmounted N/A source screens except where the live tree proved they are now mounted (none were). Email/SES remains a separate workstream. Provider execution stays OFF.

## Coverage

| Metric | Pass 4 | Pass 5 |
|---|---|---|
| Discovered | 1421 | **1421** |
| Previously classified | 270 | **692** |
| Newly classified this pass | 422 | **653** (657 inventory rows touched, including force-updates of already-classified IDs) |
| Newly PASS | — | **251** (`pass=5`) |
| Newly FAIL | — | **7** (`pass=5`, includes 2 reclassifications) |
| Newly BLOCKED | — | **387** (`pass=5`) |
| Newly N/A | 258 unmounted | **12** (live tree: BrandingSettings never rendered; LossPreventionPanel imported but never mounted) |
| Cumulative tested/classified | 692 | **1345** |
| PASS | 337 | **586** |
| FAIL | 8 | **13** |
| BLOCKED | 88 | **475** |
| N/A | 259 | **271** |
| Untested / unclicked | 729 | **76** |
| Raw coverage | 48.7% | **94.7%** (1345 / 1421) |
| Executable IDs | 1283 | **1283** |
| Executable tested | 643 | **1207** |
| Executable coverage | 50.1% | **94.1%** (1207 / 1283) |

Do **not** claim ≥95% executable coverage. 94.1% is the evidence-backed executable figure. The 76 remaining IDs are live unlabeled/conditional Check Center and EndorsementChecklist children that this pass could not mount without persisting payees, images, share threads, or an override-to-Review status change.

Machine-readable inventory: `docs/audits/inventory-2026-09-11.json`, `.csv`.

## Module matrix

| Module | Discovered | Tested/Classified | PASS | FAIL | BLOCKED | N/A | Remaining | Executable Coverage |
|---|---|---|---|---|---|---|---|---|
| payments_wallet | 312 | 312 | 147 | 4 | 148 | 13 | **0** | **100%** (229/229) |
| settings | 231 | 231 | 47 | 4 | 45 | 135 | **0** | **100%** (198/198) |
| public | 107 | 107 | 83 | 1 | 9 | 14 | **0** | **100%** (102/102) |
| extra_public_or_auth | 37 | 37 | 1 | 2 | 21 | 13 | **0** | **100%** (37/37) |
| mortgage_ops | 21 | 21 | 6 | 0 | 15 | 0 | **0** | **100%** (20/20) |
| admin | 152 | 147 | 114 | 0 | 25 | 8 | **5** | **96.6%** (140/145) |
| homeowner | 171 | 151 | 44 | 0 | 99 | 8 | **20** | **87.7%** (143/163) |
| check_center | 390 | 339 | 144 | 2 | 113 | 80 | **51** | **86.9%** (338/389) |
| **Total** | **1421** | **1345** | **586** | **13** | **475** | **271** | **76** | **94.1%** (1207/1283) |

N/A is included in Tested/Classified. Executable coverage uses only `safety` `executable` / `executable_or_ui` (1,283 IDs). Settings/public N/A rows from Pass 4 unmounted screens remain N/A.

## Remaining unclicked (76)

| Module / component | Remaining IDs |
|---|---|
| check_center / CheckCommandCenter | **42** — `CC-315` `CC-316` `CC-317` `CC-333` `CC-334` `CC-337` `CC-351` `CC-361`–`CC-375` `CC-380`–`CC-386` `CC-392` `CC-393` `CC-395` `CC-396` `CC-400`–`CC-407` `CC-413` (unlabeled detail chrome, image-viewer children, inline payee editor, packet Preview/Download/Generate) |
| homeowner / EndorsementChecklist | **17** — `CC-099`–`CC-107` `CC-109` `CC-110` `CC-112`–`CC-117` (Add Payee form did not mount after clicking the E2E check row; Payee Endorsements tab click missed this pass) |
| check_center / InPersonSignatureDialog | **4** — `CC-118`–`CC-121` |
| check_center / CheckImageCropper | **4** — `CC-148`–`CC-151` (cropper mounts only after a local file is chosen; file was not chosen) |
| admin / AdminTenants | **4** — `A1-037` Replace (logo Replace click missed; dashed upload shown when no logo), `A1-066` `A1-067` `A1-068` unlabeled billing switches (evaluate click did not change `aria-checked`) |
| homeowner / SendCheckTrackingLinkButton | **3** — `A7-117` `A7-118` `A7-119` (dialog opened and Cancel `A7-120` PASS; label-based fill missed because name/phone have no placeholder) |
| admin / PricingOptimizer | **1** — `A2-020` Scenario name (Client Savings tab did not mount the `aria-label` input in the owner session) |
| check_center / ReuploadCheckImageButton | **1** — `CC-218` |

Priority-bucket remainder vs Pass 4 target list: Settings **0** (was 42). Payments/Financials + Wallet/Moov **0** inventory remaining in `payments_wallet` (was ~242). Public/token **0** (was 52). Admin **5** (was 33). Check Center + Manager-integrated still hold most of the 76.

## High-density components (final)

| Component | n | PASS | FAIL | BLOCKED | N/A | Remaining |
|---|---|---|---|---|---|---|
| **PaymentOnboardingDialog** | 27 | 0 | 0 | **27** | 0 | 0 |
| **FundsTab** | 18 | **13** | **1** (`A5-220` amount −1) | **4** | 0 | 0 |
| **CheckReviewConsole** | 56 | 0 | 0 | **56** | 0 | 0 |
| **CashJobForm** | 23 | **20** | **2** (`A5-099` `A5-114`) | **1** (`A5-117` Save) | 0 | 0 |
| **RecipientPaymentSetup** | 20 | 0 | **1** (`X-029`) | **19** | 0 | 0 |
| **HomeownerClaimPortal** | 30 | **2** | 0 | **28** | 0 | 0 |

### PaymentOnboardingDialog

C1C Compliance: Identity verified, **Set Up Payment Account `disabled=true`**. Re-entering KYC would mutate a live payment account. `A5-246`–`A5-272` **BLOCKED** `payment_account_already_active`. Connect Bank was clicked; native `MoovBankLink` holder/routing/account fields did **not** mount (`A5-228`–`A5-233` **BLOCKED** `connect_bank_hosted_or_form_not_native`, not FAILs). Integrations page was not collapsed into one blocker.

### FundsTab

Trusted Puppeteer click on the detail **Funds** tab (not the Funds Released queue tile) on `#PR235-1001`. Available for disbursement **$1,500.00**. UI shows uploaded / Not yet deposited / Deposit in Progress while API `check_stage` is `deposited` (related to the known P1 status/stage mismatch; row not rewritten).

Physically operated: Send Homeowner Payment Link open + Cancel (`A5-153`–`A5-157`); Disburse Outside recipient/type/check#/notes; Disburse to Stakeholders opened; PA fee `%`/`$` local fill; ProjectPlanCard dates/status/note; tracking dialog chrome. Send / Record Payment / Save PA fee / Send $N **BLOCKED** at the irreversible boundary. Recurring recipient select not shown. ClaimSettlementEditor category grid did **not** mount after Enter amounts (`claim_settlements` 200 empty).

### CheckReviewConsole

`Review0` tile → **Manual Review Queue: No checks pending review**. Filter bar and CRC detail fields render only when `reviewChecks.length > 0`. Override status opened on `#E2E-1789149838411`; selecting the **Review** `SelectItem` still collides with the Review queue tile. Save withheld (`admin_override_check_status` would persist). All 56 CRC IDs **BLOCKED** `empty_review_queue` / persist. Child PASSes were **not** inferred.

### CashJobForm

New job opened. Synthetic fields filled. Add/remove line. Cancel PASS. Save **BLOCKED** `no_delete_cleanup` (Cash Jobs UI has no delete). **P3:** contract amount **−1** accepted; line Unit $ **−5** accepted. Existing Smith Roof: Record payment amount **−1** accepted; submit withheld.

### RecipientPaymentSetup

No valid public pay-setup token. `recipient_payment_setup_tokens` is not queryable. Minting a token is SES/provider. Bank-form IDs **BLOCKED** `valid_paysetup_token_unavailable`. Invalid `/pay-setup/not-a-real-token` **FAIL** `X-029` (see defects).

### HomeownerClaimPortal

Valid pending intro token (synthetic; PII not logged): status `new`. UI: Waiting for Condition One Commercial / nothing to sign or upload. Internals `A7-014`–`A7-041` **BLOCKED** `accepted_claim_portal_token_unavailable` — accepting would email the homeowner (SES). Invalid/malformed/missing tokens: “This link isn't valid.” No `tenant_id`, admin chrome, or other-claim leak. `A7-013` / `A7-042` PASS. Do not accept the pending token.

## Priority results

### 1. Payments / Financials

Exhausted `payments_wallet` inventory (312/312 classified).

- New Invoice: Amount **−1** → Invoice total **−$1.00** **REPRODUCED**. Native `min="0"` does not stop it. Save draft correctly disabled (`canSubmit` requires `unit_price > 0`). Save/send **BLOCKED**. Do not save/send a negative invoice.
- Same missing positive-amount validation also exists on: CashJobForm contract amount, CashJobForm line Unit $, Cash job Record payment Amount, FundsTab Disburse Outside Amount. None of those persist actions were clicked.
- Recipients search/filter/export PASS; edit dialog **BLOCKED** empty rows. Tax year/type/month PASS; 1099 editor **BLOCKED** “No settled payments found.” Ledger remaining filter PASS. New Payroll **BLOCKED** provider.
- Invoice action menu `A5-030`–`A5-036` **BLOCKED** (`moov_invoices` empty). No valid public invoice token without the `moov-invoice` provider. Do not create DB schema to make that test pass.

### 2. Check Center

- Class filter All classes / Unclassified / Clear PASS on the endorsing queue.
- Upload Check dialog + 1st/2nd mortgagee add/remove PASS; Upload & Analyze **BLOCKED**.
- `#E2E-1789149838411` detail mounted. Edit amount opened + Cancel (Save withheld). Share opened; company select empty. Files tab opened.
- View Check Images on `#PR235-1001` (DB path `checks/pr235/front.jpg`): **Authorized object is not present in staging S3**. Not limited to the synthetic E2E check. `CC-219` FAIL **REPRODUCED**. Not fixed.
- Manager → Mortgage Cos → Add Company: all editor fields filled locally, Cancel PASS, Save withheld.
- `LossPreventionPanel` is lazy-imported in `CheckCommandCenter` and **never rendered**. Live Manager subtabs have no Loss Prevention Center. `CC-122`–`CC-126` **N/A** `function_not_rendered_in_live_route_tree`.
- WhiteLabel header Cash Jobs / WalletOps / Payments / Settings PASS. Sign Out **BLOCKED** `session_needed`.

### 3. Homeowner Ops

Pending claim portal internals unreachable without Accept (SES). Valid ledger token `/ledger/f2947f6588b20eaa…`: Received/Deposited/Remaining **$1,500.00**. `claim_settlements` still empty. ACH pay **BLOCKED** provider. Numeric formula review stays **BLOCKED**. Tracking dialog opened on PR235 Funds tab; Cancel PASS; Preview is post-send (**BLOCKED** SES).

### 4. Cash Job Form

See high-density. Lifecycle create+delete not performed: no supported delete/cleanup. Synthetic clutter not left.

### 5. Settings

Remaining 42 finished. `A4-055` Save Company Settings stays **BLOCKED** (Freedom address/phone placeholders). BrandingSettings color controls in `WhiteLabelSettings.tsx` (`CC-291`–`CC-296`, `CC-288`) **N/A** — never rendered; live tab is `CompanyBrandingSettings` + `EmailSenderSettings`. Unrelated Branding controls were not blanket-blocked.

Platform owner `isMasterOwner=true` / `usePermissions().isAdmin=false`: CheckAlt `A4-013`–`A4-031` remain **BLOCKED** `owner_isAdmin_false`. C1C admin `isAdmin` Poll/Refresh on Pending Approvals / Deposit History PASS. Approve/Reject **BLOCKED** provider. Integrations page was not turned into one blocker.

### 6. Admin

Owner leftovers: Referral Dashboard search `c1c` PASS; P&L slider PASS; Platform Finance Add bank + Cancel PASS. Replace logo and unlabeled billing switches remain unclicked (5 admin IDs). Freedom-admin-specific controls remain BLOCKED. Cognito identity mappings not modified.

### 7. Manager

C1C Bank Deposits empty state not retested as empty-only. Freedom date-with-deposits still **BLOCKED** on Freedom admin identity. Mortgage Cos editor exhausted (safe path). CheckAlt Approve/Reject **BLOCKED** provider. Loss Prevention unmounted (N/A).

### 8. Wallet / Moov

`/c1c/wallet-ops`: Automatic Funding switch toggle+restore PASS; bank/strategy/max single/max day local fill PASS; Target wallet not in this UI **BLOCKED**; Accept and save / Open Payment Account / daily payouts **BLOCKED** provider. Microdeposit UI not in this state.

### 9. Public / token

| Route | Pass 4 | Pass 5 |
|---|---|---|
| `/invoice/not-a-real-token` | FAIL relation `public.payment_invoices` does not exist | **Invoice unavailable / `missing_cognito_token`**. Relation leak **NOT REPRODUCED**. Keep P2. Do not mark resolved. No valid public invoice token (`moov_invoices` empty). |
| `/pay-setup/not-a-real-token` | PASS “This link is not valid” | **FAIL** Secure payment setup shell + `missing_cognito_token` (regression) |
| `/unsubscribe` | missing token copy | PASS; no tenant leak |
| `/terms` `/security` `/find-a-pro` | — | Workflow/Pricing/Security/About ChecksOps PASS. Browse verified pros submit **BLOCKED**. |
| `/h/claim/:token` invalid | PASS invalid copy | PASS; no `tenant_id` leak |
| `/h/claim/:token` valid pending | — | pending waiting copy; internals not mounted |
| `/ledger/:token` valid | $1,500 UI | REPRODUCED; settlements empty |

## New defects

### P0

None this pass. Production banner and Freedom `identity_not_linked` are carried, not newly opened.

### P1

None newly opened. Four inconsistent status/stage rows were not modified. PR235 UI uploaded-vs-API deposited is the same class of mismatch; no fifth row was rewritten.

### P2

| ID | Summary | Status |
|---|---|---|
| `P2-pay-setup-missing-cognito-token` | Invalid `/pay-setup/:token` now shows `missing_cognito_token` instead of Pass 4’s clean “This link is not valid” (`X-029` PASS→FAIL) | **NEW this pass** (regression vs Pass 4) |
| `P2-invoice-token-error-changed` | Invalid `/invoice/:token` no longer exposes `relation "public.payment_invoices" does not exist`; now `missing_cognito_token` / Invoice unavailable | Observation on existing P2; **not resolved** |

### P3

| ID | Summary |
|---|---|
| `P3-invoice-negative-amount` | New Invoice accepts −1 and shows total −$1.00 (carried; **REPRODUCED**) |
| `P3-cashjob-negative-amount` | CashJobForm contract amount accepts −1 |
| `P3-cashjob-negative-line` | CashJobForm line Unit $ accepts −5 |
| `P3-cash-payment-negative` | Record payment Amount accepts −1 |
| `P3-external-disburse-negative` | Disburse Outside Amount accepts −1 |

None of the negative values were saved/sent/recorded.

## Existing defects

| Defect | This pass |
|---|---|
| P0 production `checksops.com` staging-banner / environment presentation | **NOT RETESTED** (no production authenticated session) |
| P0 Freedom admin `identity_not_linked` (`A8-035`) | **NOT RETESTED** (not retried, per instructions) |
| P1 four inconsistent status/stage rows | **NOT RETESTED** / not modified |
| P2 C1C Freedom branding placeholders (`A4-043`–`A4-046`) | **REPRODUCED** (Pass 4 + earlier Pass 5 branding dumps: 123 Main Street / (555) 123-4567). Save not clicked |
| P2 platform owner `isMasterOwner` / `isAdmin=false` CheckAlt | **NOT RETESTED** (already classified `A4-013`–`A4-031`) |
| P2 invalid invoice route missing `payment_invoices` relation | **NOT REPRODUCED** (error text changed to `missing_cognito_token`). **Not marked resolved** |
| P2 staging S3 “Authorized object is not present” | **REPRODUCED** on `#PR235-1001` and previously on E2E |
| P2 intermittent `Failed to fetch dynamically imported module` | **REPRODUCED** as 404 on `/c1c/checks` at `2026-09-12T12:21:03Z` (console). Earlier Pass 5 branding tab 404. Hard-refresh recovery remains the operational response. Not fixed |
| P3 New Invoice −1 / −$1.00 | **REPRODUCED** |
| P3 mobile clipping | **NOT RETESTED** |
| P3 override reason positioning | **NOT RETESTED** |
| `claim_settlements` 200 empty | **REPRODUCED**; numeric ledger math stays BLOCKED. No DB inserts |

No existing defect was silently dropped. None **RESOLVED BY EXTERNAL CHANGE**.

## Blockers (inventory IDs)

Grouped by dependency. Exact IDs are in `docs/audits/inventory-2026-09-11.json` (`result=BLOCKED`). High-count buckets:

**Freedom admin identity**

`P3-BD-001` (C1C empty Bank Deposits day-expand; Freedom days exist but Manager is admin-only and Freedom admin is `identity_not_linked`). `A8-035` remains FAIL, not BLOCKED.

**SES / email**

`A1-049` `A1-051` `A1-057` `A1-058` `A1-059` `A1-064` `A1-112` `A3-004` `A3-006` `A3-016` `A4-060` `A4-063` `A4-065` `A4-136` `A4-216` `A5-029` `A5-134` `A5-158` `A5-166` `A5-168` `A5-170` `A5-211` `A7-051` `A7-101` `A7-114` `A7-115` `A7-121` `A7-125` `A8-021` `A8-084` `CC-240` `CC-242` `CC-244` `CC-411` `CC-412` `CC-414`

**EMAIL_OTP**

`A3-015` `A6-001`–`A6-014` `A6-021` `A7-001` `A7-005` `A7-011` `A8-028` `A8-029` `A8-030` `X-042` `X-043`

**Provider execution**

Includes CheckAlt Approve/Reject, payroll, invoice create/send, ACH / Open Payment Account / daily payouts / microdeposits, Send $N, PaymentOnboardingDialog (account already active), hosted Connect Bank fields, wallet funding: `A4-035`–`A4-039` `A5-013` `A5-014` `A5-028` `A5-030`–`A5-036` `A5-124` `A5-141` `A5-146`–`A5-148` `A5-185` `A5-223`–`A5-234` `A5-239`–`A5-243` `A5-246`–`A5-277` `A5-286`–`A5-293` plus owner CheckAlt `A4-013`–`A4-031` (`owner_isAdmin_false`).

**Empty fixture / data**

`empty_review_queue` CRC `CC-041`–`CC-096` `CC-098`; `empty_moov_invoices` `A5-030`–`A5-036`; `empty_payment_recipients` `A5-048`–`A5-052`; `empty_settled_payments` `A5-061`–`A5-073`; `empty_claim_settlements` `A5-201`–`A5-204`; `accepted_claim_portal_token_unavailable` `A7-014`–`A7-041`; `valid_paysetup_token_unavailable` `X-022`–`X-041`; share-thread children `CC-128` `CC-129` `CC-131`–`CC-145`; `empty_class_option` `CC-299` `CC-330`.

**Unsafe configuration mutation / persist**

`A4-055` Save Company Settings (placeholders). `A4-137` `A4-150` `A4-194` `A4-195` `A4-198`–`A4-203` `A5-012` `A5-123` `A5-169` `A5-173`–`A5-175` `A5-278`–`A5-285` `A7-128` `CC-225` `CC-227` plus CashJobForm save `A5-117` (`no_delete_cleanup`), amount/packet/payee/check deletes, upload submit.

**Other**

`session_needed` Sign Out `CC-254` `CC-260` `CC-265`. `connect_bank_hosted_or_form_not_native` `A5-228`–`A5-233`. `control_not_in_live_ui` EndorsementAdjuster `CC-178`–`CC-189`, Autofunding target wallet `A5-188`. `custom_domain_host_not_in_session` `CC-220`–`CC-223`. `function_not_rendered_in_live_route_tree` / settings tree: Pass 4 258 N/A plus Pass 5 `CC-122`–`CC-126` `CC-288` `CC-291`–`CC-296`.

## Browser failure monitoring

`Failed to fetch dynamically imported module` / 404:

| Route | Timestamp | Notes |
|---|---|---|
| `/c1c/checks` | 2026-09-12T12:21:03Z | Console: Failed to load resource 404. Session continued after navigation. Not fixed. |
| `/c1c/settings?tab=branding` | earlier Pass 5 | Dynamic-import 404; hard-refresh recovered. Not fixed. |

Failed asset URL was not always present in the console line (generic 404). Repeat navigation did not always reproduce. Do not treat as a hard blocker of coverage.

## Evidence (Pass 5)

<img src="/opt/cursor/artifacts/pass5_inv_unit_neg.png" alt="New invoice unit price -1 totals -$1.00; Save draft disabled" />

<img src="/opt/cursor/artifacts/pass5_cash_amount_neg.png" alt="CashJobForm contract amount accepted -1" />

<img src="/opt/cursor/artifacts/pass5_ext_children.png" alt="Disburse Outside ChecksOps amount accepted -1" />

<img src="/opt/cursor/artifacts/pass5_pr235_images.png" alt="PR235-1001 View Check Images: Authorized object is not present in staging S3" />

<img src="/opt/cursor/artifacts/pass5_pub_invoice2.png" alt="Invalid invoice token: Invoice unavailable / missing_cognito_token" />

<img src="/opt/cursor/artifacts/pass5_pub_paysetup2.png" alt="Invalid pay-setup token: missing_cognito_token regression" />

<img src="/opt/cursor/artifacts/pass5_pub_claim_pending.png" alt="Valid pending homeowner claim token: waiting, nothing to sign or upload" />

<img src="/opt/cursor/artifacts/pass5_focus2_review.png" alt="Manual Review Queue: No checks pending review" />

<img src="/opt/cursor/artifacts/pass5_focus2_upload.png" alt="Upload Check dialog with 1st/2nd mortgagee fields" />

<img src="/opt/cursor/artifacts/pass5_wallet_ops_filled.png" alt="Wallet-ops Automatic Funding local fill; save withheld" />

<img src="/opt/cursor/artifacts/pass5_platform_disburse.png" alt="PR235 Funds tab Disburse to Stakeholders opened; Send withheld" />

<img src="/opt/cursor/artifacts/pass5_remain_mortgage_filled.png" alt="Manager Mortgage Cos Add Company filled then cancelled" />

---

# Pass 4 — Field-level coverage expansion (physical interaction)

**Date:** 2026-09-12  
**Auditor:** Cursor Cloud Agent  
**Branch:** `cursor/full-staging-e2e-audit-3bce`  
**PR:** https://github.com/michaelcarletta-cmd/ChecksOps/pull/237  
**Scope:** Continue Pass 3. Physically operate remaining safe controls on `https://staging.checksops.com`. Do not restart the audit. Do not fix defects. Email/SES remains a separate workstream. Provider execution stays OFF.

## Coverage

| Metric | Pass 3 | Pass 4 |
|---|---|---|
| Discovered | 1421 | **1421** |
| Newly physically classified this pass | — | **422** (164 operated + 258 unmounted N/A) |
| Cumulative tested | 270 | **692** |
| PASS | 231 | **337** |
| FAIL | 8 | **8** |
| BLOCKED | 30 | **88** |
| N/A | 1 | **259** |
| Untested / unclicked | 1151 | **729** |
| Raw coverage | 19.0% | **48.7%** |
| Executable IDs | 1283 | **1283** |
| Executable tested | 262 | **643** |
| Executable coverage | 20.4% | **50.1%** |

Do **not** claim ≥95% executable coverage. The 258 new N/A rows are unmounted source screens (never imported into the live route tree). They are classified, not clicked. Physical clicks this pass are the 164 PASS/FAIL/BLOCKED updates.

Machine-readable inventory: `docs/audits/inventory-2026-09-11.json`, `.csv`.

## By module

| Module | Discovered | Tested | PASS | FAIL | BLOCKED | Remaining | Coverage |
|---|---|---|---|---|---|---|---|
| check_center | 390 | 167 | 89 | 2 | 8 | 223 | 42.8% |
| settings | 231 | 189 | 22 | 4 | 28 | 42 | 81.8% |
| payments_wallet | 312 | 62 | 44 | 0 | 5 | 250 | 19.9% |
| homeowner | 171 | 42 | 27 | 0 | 7 | 129 | 24.6% |
| admin | 152 | 119 | 88 | 0 | 23 | 33 | 78.3% |
| public | 107 | 77 | 60 | 1 | 2 | 30 | 72.0% |
| extra_public_or_auth | 37 | 15 | 1 | 1 | 0 | 22 | 40.5% |
| mortgage_ops | 21 | 21 | 6 | 0 | 15 | 0 | 100% |
| **Total** | **1421** | **692** | **337** | **8** | **88** | **729** | **48.7%** |

N/A (259) is included in Tested. Coverage = tested/discovered including FAIL+BLOCKED+N/A.

## Remaining unclicked (priority buckets)

| Bucket | Remaining |
|---|---|
| Settings | 42 |
| Payments / Financials | 207 |
| Check Center | 199 |
| Homeowner Ops | 129 |
| Admin | 33 |
| Manager-integrated | 32 |
| Wallet / Moov | 35 |
| Public / token | 52 |
| Mortgage Ops | **0** |
| Mobile explicit IDs | **0** (`CC-390` was a desktop Payee name control, also TAP'd at 390px) |

Payments_wallet inventory remaining is 250 = financials 207 + wallet/Moov 35 + a few adjacent. Check Center inventory remaining is 223 = 199 + manager-integrated overlap.

## 1. Settings

C1C `/c1c/settings` field-level (role `c1c_admin` via `/login` password toggle):

| Control | Result | Notes |
|---|---|---|
| Users email `e2e-invite@example.invalid` | **PASS** `CC-237` | |
| Role select Admin | **PASS** `CC-238` `CC-241` | |
| Reset 2FA → Cancel | **PASS** `CC-243` | |
| Invite / Resend | **BLOCKED** `CC-242` `CC-244` | email/SES |
| Remove user | **BLOCKED** `CC-245` | destructive |
| Bank add form Chase/routing/account/Checking then Cancel | **PASS** `CC-280` `CC-282`–`CC-287` `CC-290` | Save **BLOCKED** `CC-289` |
| Email sender From / Reply-To | **PASS** `A4-058` `A4-059` | Condition One Commercial / payments@condition1commercial.com |
| Save branding / Start domain verification / Disable custom sending | **BLOCKED** `A4-060` `A4-063` `A4-065` | SES |
| Save Company Settings | **BLOCKED** `A4-055` (already) | Freedom address/phone placeholders still on the form. Company Name now shows Condition One Commercial. **Do not Save.** |
| Document library W-9 / E2E-DOC / Auto-share / tabs | **PASS** `A4-143` `A4-144` `A4-145` `A4-149` | Upload/Delete **BLOCKED** |
| ChecksOps Guide open/close | **PASS** `CC-261` `CC-262` | |
| Directory custom trade `e2e-trade` typed; Add not clicked | typed; Publish showed **Live** | Pass 3 recorded OFF. Not flipped this pass after the Live screenshot. |

135 Settings IDs are **N/A** unmounted (`OrganizationSettings`, `SignaturePresetsSettings`, `TenantManagement.tsx` vs live `AdminTenants` table, `UserManagementSettings`, `ChangePasswordCard`, `AuditLogSettings`, `ImportSettings`, `Zapier`, `QuickBooks`, `TeamCaps`, `MaintenancePaymentsTracker`, plus child `TenantUserManagement` / `TenantPaymentAccountPanel`).

## 2. Payments / Financials

| Control | Result | Notes |
|---|---|---|
| New invoice Business / due 12/31/2026 / Add+Remove line / 0 / 0.01 / 999999.99 / **−1** | **PASS** `A5-020` `A5-021` `A5-022` `A5-026` `A5-027` | Closed without Save draft / Send. Negative **−1 accepted** (total **−$1.00**). |
| Invoice Branding open | **PASS** `A5-015` | no save |
| Send invoice | already **BLOCKED** | |
| Tax Export for accountant | **PASS** `A5-054` | CSV download |
| Month tile / search `test` | **PASS** `A5-056` `A5-058` | Generate 1099s already **BLOCKED** |
| Cash job Smith Roof Edit→Back; Record payment 0/0.01 Cancel | **PASS** `A5-083` `A5-084` `A5-087` `A5-088` `A5-094` | submit not clicked |

Deep remaining density: `PaymentOnboardingDialog` (27), `FundsTab` (18), `TaxSummary` edit dialogs, `CashJobForm` (23), `StakeholderAccountSettings`, `InvoicesTab` action menu (no invoices to open).

## 3. Check Center

| Control | Result | Notes |
|---|---|---|
| `CC-390` Payee name + Insured + Cancel | **PASS** | Desktop and 390×924 TAP. This was the “mobile remaining ID” — it is a desktop input whose ID contains `390`. |
| Class filter + Clear | **PASS** `CC-328` `CC-332` | |
| Share open/cancel | **PASS** `CC-352` | |
| View Check Images | **FAIL** `CC-219` | Toast: `Authorized object is not present in staging S3` |
| Send endorsement emails | **BLOCKED** `CC-411` `CC-412` | SES |
| Loss Draft `AUDIT-1789138441112` opened | physical | queue navigation |

Unmounted N/A: `CheckMortgageMonitoring` (26), `AdminCheckTracker` (20) + child `CheckAdminEditDialog` (15), `TenantCreditManager` (5), `CheckStatusWorkflow` (1).

Golden path not re-run. Four known inconsistent status/stage rows not modified.

## 4. Homeowner Ops

Valid C1C ledger token `f2947f6588b20eaa…` (PR235 Synthetic Homeowner):

- Ledger UI shows Received $1,500 / Deposited $1,500 / Remaining $1,500. `claim_settlements` still **200 empty**. Numeric formula review stays **BLOCKED**. Do not mark PASS.
- Sign now opened `/endorse?token=…` (Clear already PASS; Endorse/Reject already PASS from Pass 2). Legal checkbox not ticked. Endorse not clicked this pass.
- New check / Production doc / amount / note / file areas **PASS** `A7-044`–`A7-050` `A7-052`. Send securely **BLOCKED** `A7-051`. Pay **BLOCKED** `A7-053` `A7-060`.
- Expired ledger: “This link has expired.” No tenant_id leak.
- Revoked ledger: “Your claim team has ended access to this link.”
- Preclaim `/start-claim/982b5e…`: upload form; Send securely not clicked.
- Revoked `/h/claim/…`: invalid link; **PASS** `A7-013` Back to Find a Pro. No admin chrome.

## 5. Admin (platform owner `checksopsadmin@gmail.com`)

Cognito + `/identity/me` 200, `isMasterOwner=true`, UUID `233c588f-…`.

Physically operated C1C tenant details (Company, Branding & Email, Compliance, Integrations, Billing, OPS Badge, Users), tenant search `c1c`, Actions, Preview portal (`/c1c/checks` as current owner user — not Freedom-admin impersonation), New Tenant fill+cancel, Announcements fill+no publish, Platform Finance Add bank fill+cancel, Referral Dashboard, Mortgage Ops Manage+Close, Financial Model number-field local change.

CheckAlt on Integrations: **“CheckAlt settings are restricted to administrators.”** Owner is master but `usePermissions().isAdmin` is false (Pass 2). `A4-013`–`A4-031` **BLOCKED** `owner_isAdmin_false`. Do not transfer C1C admin coverage here.

Invite / billing pull / Connect bank / Publish announcement / Hire Agent **BLOCKED** at the irreversible control only.

## 6. Manager

C1C Bank Deposits remain empty — not retried as empty-state-only. Freedom date-with-deposits still **BLOCKED** on Freedom admin identity. Remaining manager-integrated untested: 32.

## 7. Wallet / Moov

Add-funds 0 + cancel and sweeps open/close operated in Pass 3/4 UI sessions. `A5-313` Add funds from bank stays **BLOCKED** provider. Remaining wallet/Moov untested: 35 (`PaymentOnboardingDialog`, `MoovBankLink`, `AutoFundingPanel`, etc.).

## 8. Public / token

| Route | Result |
|---|---|
| `/invoice/not-a-real-token` | **FAIL** `X-021` — `relation "public.payment_invoices" does not exist` (schema leak; worse than Pass 2 `missing_cognito_token`) |
| `/pay-setup/not-a-real-token` | **PASS** `X-029` — “This link is not valid.” Pass 2 `missing_cognito_token` **did not reproduce** |
| `/unsubscribe` | missing token copy shown |
| `/reset-password` | fields viewed; not submitted |
| `/c1c/login` while a C1C session cookie existed | redirected to `/c1c/checks` — **session reuse, not an unauthenticated bypass**. Not a P0. |

RecipientPaymentSetup bank-form IDs remain untested (form does not render without a valid token).

## 9. Mortgage Ops

All 4 remaining IDs classified:

- `A6-018` `A6-020` **PASS** (typed work email)
- `A6-014` `A6-021` **BLOCKED** `EMAIL_OTP`

Module coverage **21/21 tested**. Queue/hire still blocked on OTP/email as before.

## 10. Mobile

`CC-390` completed (desktop + 390px TAP). No new mobile-only inventory IDs added. Duplicated desktop controls were not added to the denominator.

## 11. Dynamic import failure

Not reproduced on the owner/public/C1C Pass 4 sessions after the earlier shallow Pass 4 batch. Still recorded as intermittent P2 from Pass 3. Hard-refresh recovery remains the operational response. Not fixed.

## 12. Freedom admin

`mcarletta@freedomadj.com` **not retried**. Remains Cognito success → `identity_not_linked`.

## 13. Claim ledger

`claim_settlements` **200 empty**. UI still paints $1,500 received/deposited/remaining on the synthetic ledger. Formula review stays **BLOCKED**. No DB inserts.

## New defects

### P0

None. `/c1c/login` auto-land on Check Center was a leftover authenticated Incognito session (`payments@condition1commercial.com` in the header), not a public bypass.

### P1

None confirmed.

### P2

| ID | Summary |
|---|---|
| `P4-invoice-relation-missing` | `/invoice/:token` exposes Postgres `relation "public.payment_invoices" does not exist` |
| `P4-staging-s3-authorized-object` | View Check Images on `#E2E-1789149838411` → “Authorized object is not present in staging S3” |
| Pass 2 branding placeholders | Reproduced on C1C Branding: address/phone still Freedom Philadelphia / (555) 123-4567. Company Name/Email now look like C1C. Save not clicked. |
| Pass 2 owner `isAdmin` | Reproduced: CheckAlt restricted for platform owner |

### P3

Invoice New Invoice accepts **−1** and shows total **−$1.00** (closed without save).

## Reproduced defects

- C1C Branding Freedom **address/phone placeholders** (display; `company_branding` still empty — do not Save)
- Platform owner `isMasterOwner` but `isAdmin` false → CheckAlt settings hidden
- Freedom admin `identity_not_linked` (not retried)
- Production banner (Pass 1 P0) — not re-authenticated on production this pass; still recorded
- Four inconsistent status/stage rows — not modified; still recorded

## Non-reproduced defects

- `/pay-setup/:token` `missing_cognito_token` — now clean “This link is not valid” (`X-029` FAIL→PASS)
- `claim_settlements` 503 — still 200 empty
- Intermittent `Failed to fetch dynamically imported module` — not hit on the main Pass 4 owner/public/C1C sessions

## Remaining blockers

| Dependency | Effect |
|---|---|
| Freedom admin identity | Manager Bank Deposits day-expand on Freedom data; any Freedom-admin-only control |
| Email / SES | Invite, Resend, Send invoice, Send securely, endorsement emails, Hire Agent, Publish-if-emailed |
| EMAIL_OTP | Mortgage Ops queue (`A6-014` `A6-021`); `/h/upload` send code |
| Provider execution OFF | Connect bank, Add funds from bank, ACH, CheckAlt Poll/Approve, micro-deposits |
| Empty datasets | C1C `checkalt_deposits` / Bank Deposits expand; invoice action menus (0 invoices); `claim_settlements` math |
| Unsafe external / persist | Save Company Settings while placeholders remain; Save CheckAlt; Create Tenant; Save Notes; Generate 1099s |
| Unmounted source | 258 N/A — cannot click |
| Owner `isAdmin` false | CheckAlt credential fields |

## Evidence (Pass 4)

<img src="/opt/cursor/artifacts/pass4_owner_04_c1c_company_tab.webp" alt="Platform owner C1C Company tab partner code copied" />

<img src="/opt/cursor/artifacts/pass4_owner_07_c1c_integrations_tab.webp" alt="CheckAlt settings restricted to administrators for platform owner" />

<img src="/opt/cursor/artifacts/pass4_owner_fin_04_bank_form_filled.webp" alt="Platform Finance add-bank form filled then cancelled" />

<img src="/opt/cursor/artifacts/pass4_invoice_invalid_token.webp" alt="Invalid invoice token exposes missing payment_invoices relation" />

<img src="/opt/cursor/artifacts/pass4_c1c3_15_invoice_negative_amount.webp" alt="New invoice accepts negative amount totaling -$1.00" />

<img src="/opt/cursor/artifacts/pass4_pub2_02_new_check_form.webp" alt="Valid homeowner ledger New check form without Send" />

<img src="/opt/cursor/artifacts/pass4_mobile_390_payee.webp" alt="390px Payee name form on E2E check cancelled" />

<img src="/opt/cursor/artifacts/pass4_doc_library.webp" alt="C1C Document Library E2E-DOC W-9 typed" />

---


# Pass 3 — Coverage expansion (physical interaction)

**Date:** 2026-09-11 → 2026-09-12  
**Auditor:** Cursor Cloud Agent  
**Branch:** `cursor/full-staging-e2e-audit-3bce`  
**PR:** https://github.com/michaelcarletta-cmd/ChecksOps/pull/237  
**Scope:** Physically operate remaining executable controls on `https://staging.checksops.com` using the Pass 2 inventory as the working checklist. Email/SES another workstream. Provider execution stays OFF.

**Environments (unchanged)**

| Surface | Host | Backend | Auth |
|---|---|---|---|
| AWS staging UI | `https://staging.checksops.com` | `environment: staging` API `psr19uhop4…/staging` | Cognito pool `us-east-1_vPmQ7cL1F` |
| Production UI | `https://checksops.com` | not authenticated this pass | Pass 1 P0 banner remains recorded |

## Coverage

| Metric | Count |
|---|---|
| Pass 2 reconciled JSX inventory | 1399 |
| Pass 3 newly enumerated (Manager subtabs + Bank Deposit inner + 390px shells) | **+22** |
| **Reconciled controls discovered** | **1421** |
| Previously tested (Pass 2 published) | 168 |
| Previously tested (after Pass 2 IDs seeded onto inventory) | 183 |
| **Newly physically tested in Pass 3** (inventory `pass=3`) | **93** |
| First-time IDs (UNTESTED after seed → tested this pass) | **~87** |
| **Cumulative physically tested** | **270** |
| PASS | **231** |
| FAIL | **8** |
| BLOCKED | **30** |
| N/A | **1** |
| Untested | **1151** |
| **Raw coverage (270 / 1421)** | **19.0%** |
| Safety-class executable IDs | 1283 |
| Executable IDs tested | 262 |
| **Executable coverage (262 / 1283)** | **20.4%** |

Do **not** claim ≥95% executable coverage. Pass 3 raised raw coverage from 12.0% to 19.0% and executable coverage from 13.3% to 20.4%. Source inspection is never PASS.

Machine-readable inventory: `docs/audits/inventory-2026-09-11.json`, `.csv`.

## By module

| Module | Discovered | Tested | PASS | FAIL | BLOCKED | Coverage |
|---|---|---|---|---|---|---|
| check_center | 390 | 70 | 66 | 1 | 2 | 17.9% |
| settings | 231 | 24 | 16 | 4 | 4 | 10.4% |
| payments_wallet | 312 | 35 | 30 | 0 | 5 | 11.2% |
| homeowner | 171 | 23 | 19 | 0 | 4 | 13.5% |
| admin | 152 | 36 | 36 | 0 | 0 | 23.7% |
| public | 107 | 63 | 60 | 1 | 2 | 58.9% |
| extra_public_or_auth | 37 | 2 | 0 | 2 | 0 | 5.4% |
| mortgage_ops | 21 | 17 | 4 | 0 | 13 | 81.0% |
| **Total** | **1421** | **270** | **231** | **8** | **30** | **19.0%** |

N/A (1) is `P3-BD-006` (no independent Bank Deposits date picker). Coverage column is tested/discovered including FAIL+BLOCKED+N/A.

## Freedom identity (do not retry)

`mcarletta@freedomadj.com` remains **NO-GO** (`identity_not_linked`). Not retried this pass. Freedom-admin coverage is **not** transferred from C1C-admin.

Freedom **staff** (`checksops-tester@freedomadj.com`, operator) logged in via `/login` + staging password (not `/freedom/login`). Check Center queues work. **Manager card is correctly absent** for operator (`canAccessManager` requires tenant admin/owner). Screenshot: `pass3_freedom_staff_no_manager.webp`.

`/c1c/login` and `/freedom/login` are `WhiteLabelLogin` (passkey/OTP). Staging password toggle exists only on `/login` (`CheckOpsLogin`). Not a missing A8-036 regression.

## Settings — deep pass

| Control | Result | Notes |
|---|---|---|
| Profile Company Name persist/revert | **PASS** | Condition One Commercial → `E2E-AUDIT-TEMP` → restore. API `tenants.name` still Condition One Commercial. Mobile 390 still shows restored name. |
| In-App Notifications off/save/restore | **PASS** | |
| Email/SMS notification switches | **PASS** | viewed; not mutated |
| Branding Company Name / Address / Phone / Email | **FAIL** | Freedom Claims Adjusting placeholders. See defect. |
| Branding uploads / invoice theme | **PASS** | viewed; no upload |
| Save Company Settings | **BLOCKED** | would write `company_branding` while Freedom placeholders are displayed |
| Partners copy | **PASS** | `41A7C8AB` |
| Users invite | **BLOCKED** | would email |
| AI Key | **PASS** | view-only; no key configured; not saved |
| Referrals copy | **PASS** | copy toast; Apply Discount not clicked |
| Compliance | **BLOCKED** (save) | Identity verified viewed; Save KYC not clicked |
| Banking | view-only | verified C1C payment account; Connect/ACH not used |
| Directory | **PASS** (open) | publish toggle off; trades listed; not saved |

### C1C “Freedom Claims Adjusting” — stored vs display

**Display contamination, not stored C1C tenant configuration.**

- Profile / `tenants.name` = **Condition One Commercial** (confirmed after persist/revert).
- `POST /data/query` `company_branding` returns **0 rows** for C1C and for Freedom staff.
- Branding form `value` state is empty (`useState("")`). The visible strings match hardcoded **placeholders** in `CompanyBrandingSettings.tsx`: `Freedom Claims Adjusting`, `123 Main Street / Suite 100 / Philadelphia, PA 19103`, `(555) 123-4567`, `claims@freedomclaims.com`.
- Sidebar chrome shows CONDITION ONE, not Freedom.
- Save was **not** clicked (would insert a `company_branding` row).

Do not treat this as C1C’s stored company name. It is still a tenant-isolation FAIL: Freedom-specific placeholders render on C1C.

## Manager — inner controls

C1C admin **can** open Manager. All 10 subtabs physically clicked this pass (Pass 2 only opened them):

Deposit Ops, Pending Approvals, Bank Deposits, Deposit History, Returned (“No returned checks”; one earlier chunk-load recovered on retry), Reports (Daily Deposit Log), Mortgage Cos (Add Company → Cancel), Partners, Homeowner Uploads, Reissue (empty).

Freedom staff **cannot** open Manager. That is authorization, not a missing C1C bug.

### Bank Deposit

UI groups `checkalt_deposits` (excluding rejected/error) by settled/pending day. Copy: “Expand a day to see exactly which checks make up that amount.” **No independent date picker** (`P3-BD-006` N/A).

| Path | Result |
|---|---|
| C1C empty state | **PASS** — Settled $0.00, In transit $0.00, “No deposits found yet.” |
| C1C expand a day / Export CSV | **BLOCKED** — C1C has 0 `checkalt_deposits` rows |
| Freedom date-with-deposits | **BLOCKED** — Freedom has submitted days (API: 2026-08-12, 2026-07-21, 2026-09-02, …) but the only UI is Manager → Bank Deposits, which requires Freedom **admin**. Freedom admin identity is NO-GO. Staff operator has no Manager card. Platform-owner “Preview portal” opens `/{slug}/checks` as the **current user**, it does not impersonate tenant admin. |

Provider execution stayed OFF. No CheckAlt submit.

### Homeowner Uploads

Filled synthetic name/email, **Copy** PASS, **Preview** opened public upload form, **Send** not clicked (email/SES). Workflow for a claim that has not already been created exists up to the external-send boundary.

### Partner codes

C1C copy `41A7C8AB` PASS. Cross-tenant resolve not executed as a mutation. Freedom staff profile partner code `0FXCE985` (different from C1C).

### Tax / 1099

Year 2026 selector PASS. Generate 1099 **BLOCKED** (external). Later `/c1c/payments` sometimes failed with `Failed to fetch dynamically imported module` (intermittent staging chunk load).

## Check Center remaining

Physically this pass (C1C unless noted):

- Search `E2E-1789149838411`, class filter, payee Add→Cancel
- Admin override destinations: Review, Endorsing (current), Ready for Deposit, Loss Draft, Reissue, Void. **No** deposited / payment sent / ACH complete / CheckAlt complete. Save without reason → “Override requires a reason.” Cancelled. Check left Endorsing.
- Freedom staff: Review/Endorsing/Ready/Deposited/Loss Draft/Funds Released opened; one Endorsing check read-only (Overview/Endorsements/Funds/Files/Audit). No Void.
- Golden-path transition sequence **not** repeated.

Bulk Void/Reissue of live Freedom checks not executed.

## Admin override

Pass 2 already proved Review ↔ Endorsing with actor/reason/old/new/timestamp. Pass 3 re-opened destinations and cancel. Four known inconsistent status/stage rows **not** modified.

## Mortgage Ops / Homeowner Ops

Freedom staff nav has **no** Mortgage Ops / Homeowner Ops entries. Queue remains EMAIL_OTP **BLOCKED** (not the whole page). Hire not clicked. Public ledger / invalid token from Pass 2 not re-run. Revoked-token ledger not newly opened.

## Payments / Wallet / Moov

- Invoices: Refresh fail-closes (“Set up your payment account first”). New Invoice fill 0 / 0.01 / 999999.99 then close without Send.
- Wallet: Pending setup $0.00. Add funds dialog; amount validation; **Add funds from bank not clicked**. Refresh balances PASS.
- Moov/CheckAlt/Plaid not enabled. No money movement.

## Claim Ledger

Pass 2 `claim_settlements` **503 did not reproduce**. C1C `POST /data/query` table `claim_settlements` now **200 with `data: []`**. Numeric settlement-backed UI reconciliation stays **BLOCKED** on empty data, not on 503. Independent fixture math remains supporting evidence only — not upgraded to PASS.

## Mobile 390px (required this pass)

Chrome DevTools device mode **390 × 924**. Physical TAPs as C1C admin.

| Surface | Result | Functional vs cosmetic |
|---|---|---|
| Queue tiles Review / Endorsing / Manager | **PASS** | 2-column wrap; tappable |
| Open E2E-1789149838411; Overview / Endorsements / Funds / Files | **PASS** | |
| Partners / Audit tabs | **PASS with caveat** | `overflow-x-auto`; Partners clipped; Audit off-screen until scroll — not classified FAIL because scroll exists |
| Manager subtabs | **PASS** | wrap; Homeowner Uploads/Reissue at fold |
| Settings Profile | **PASS** | restored Condition One Commercial |
| Payments History / Invoices | **PASS** | Recipients / Tax need horizontal scroll |
| Search + amount column | **FAIL (P3 layout)** | placeholder clips; Amount column clipped. Search field still tappable |

No hamburger; icon nav remains. Wallet / Mortgage Ops / Homeowner Ops / owner admin **not** re-tapped at 390 this pass.

Evidence: `pass3_mobile_390_check_center.webp`, `pass3_mobile_390_check_detail.webp`, `pass3_mobile_390_manager.webp`, `pass3_mobile_390_settings.webp`, `pass3_mobile_390_payments.webp`.

## Defects

### Newly discovered P0

None.

### Newly discovered P1

None. (Bank Deposits date-with-deposits is a **coverage blocker**, not a new product P1: the UI exists and C1C empty state works.)

### Newly discovered P2

- **P2-c1c-branding-freedom-placeholders** (classification upgrade): C1C Branding shows Freedom placeholders while `company_branding` is empty and `tenants.name` is Condition One Commercial. Not stored C1C config; still wrong tenant-facing copy.
- **P2-staging-dynamic-import (intermittent):** `Failed to fetch dynamically imported module` on Manager → Returned (recovered) and later `/c1c/payments` / `/c1c/checks` (Chrome “Aw, Snap” / Loading). Does not always reproduce. Chrome also showed “Relaunch to update”.

### Newly discovered P3

- **P3-mobile-search-clip:** 390px Check Center search placeholder and Amount column clip.
- Inline override Save requires a reason while the reason field can sit below the fold.
- Tenant `/c1c/login` and `/freedom/login` have no staging-password toggle (by design; use `/login`).

### Previously known that reproduced

- Freedom admin `identity_not_linked` (not retried; still NO-GO).
- C1C Branding Freedom strings (now explained as placeholders).
- Production `checksops.com` AWS staging banner (not re-authenticated; still recorded P0).
- Four inconsistent status/stage rows (not rewritten; not re-queried as a mutation).

### Previously known that did not reproduce

- **`claim_settlements` 503** — now 200 empty for C1C.
- Platform owner Banking / Wallet deny (already PASS in Pass 2; not re-broken).

## Remaining unclicked (UNTESTED = 1151)

| Group | Remaining UNTESTED |
|---|---|
| Settings | **207** |
| Check Center (non-Manager) | **283** |
| Manager | **44** |
| Mortgage Ops | **4** |
| Homeowner Ops | **148** |
| Payments / Financials | **244** |
| Wallet / Moov | **25** |
| Admin | **116** |
| public / token routes | **79** |
| mobile (additional 390 IDs) | **1** |
| other | **0** |

### BLOCKED dependency map (exact)

| Dependency | What stays BLOCKED |
|---|---|
| Freedom admin `identity_not_linked` | Freedom Manager, Freedom Bank Deposits **day expand / check list / totals for a deposit day / Export CSV**, Freedom-admin override, Freedom-admin Settings branding save |
| Email / SES workstream | Send upload link, user invite, Generate/send invoice, Contact a Pro, Mortgage Hire / password-reset email, homeowner OTP send, 1099 generate if it emails |
| EMAIL_OTP / no mailbox | Mortgage Ops **queue** (personnel view still testable for owner) |
| Provider execution OFF | Add funds from bank, Transfer to wallet, CheckAlt submit, Moov ACH, Disburse, Enable payouts |
| Empty C1C `checkalt_deposits` | C1C expand-day / Export CSV / date-with-deposits |
| Empty `claim_settlements` | Numeric ledger reconciliation (read path is 200 empty, not 503) |
| Save Company Settings while placeholders show Freedom | Branding persist on C1C |

## Evidence (Pass 3)

<img src="/opt/cursor/artifacts/pass3_c1c_branding_freedom_name.webp" alt="C1C Branding tab showing Freedom Claims Adjusting placeholders" />

<img src="/opt/cursor/artifacts/pass3_profile_name_restored.webp" alt="C1C Profile company name restored to Condition One Commercial" />

<img src="/opt/cursor/artifacts/pass3_c1c_bank_deposits_manager.webp" alt="C1C Manager Bank Deposits empty state $0.00 settled and in transit" />

<img src="/opt/cursor/artifacts/pass3_freedom_staff_no_manager.webp" alt="Freedom staff Check Center with no Manager card" />

<img src="/opt/cursor/artifacts/pass3_override_destinations.webp" alt="C1C override destinations without deposited or ACH complete" />

<img src="/opt/cursor/artifacts/pass3_c1c_wallet_add_funds_cancel.webp" alt="C1C wallet add-funds dialog cancelled at Pending setup" />

<img src="/opt/cursor/artifacts/pass3_c1c_homeowner_uploads.webp" alt="C1C Homeowner Uploads form up to email boundary" />

<img src="/opt/cursor/artifacts/pass3_mobile_390_check_center.webp" alt="390px C1C Check Center queue tiles" />

<img src="/opt/cursor/artifacts/pass3_mobile_390_check_detail.webp" alt="390px C1C check detail E2E-1789149838411" />

<img src="/opt/cursor/artifacts/pass3_mobile_390_manager.webp" alt="390px C1C Manager subtabs" />

<img src="/opt/cursor/artifacts/pass3_mobile_390_settings.webp" alt="390px C1C Settings Profile Condition One Commercial" />

<img src="/opt/cursor/artifacts/pass3_mobile_390_payments.webp" alt="390px C1C Payments History" />

---

# Pass 2 — Full staging interaction audit (continuation)

**Date:** 2026-09-11 (continuation)  
**Auditor:** Cursor Cloud Agent  
**Branch:** `cursor/full-staging-e2e-audit-3bce`  
**PR:** https://github.com/michaelcarletta-cmd/ChecksOps/pull/237  
**Scope:** Rebuild the control inventory from Pass 1 **and** a live code crawl, then physically operate applicable controls on **staging only**. Email/SES is another workstream — not modified. No production deploy. No defect fixes. No real money.

**Environments**

| Surface | Host | Backend | Auth |
|---|---|---|---|
| AWS staging UI | `https://staging.checksops.com` | `environment: staging` API `psr19uhop4…/staging` | Cognito pool `us-east-1_vPmQ7cL1F` |
| Production UI | `https://checksops.com` | public pages from Pass 1 only | no production authenticated login this pass |

**Safety (unchanged)**

- Provider flags: `AWS_PROVIDER_EXECUTION_ENABLED=false`, Moov/CheckAlt/Plaid/Actum false.
- Workflow writes on staging enabled.
- No production SPA deploy. No `/prep` authenticated mutations.
- Email/SES not modified. Email-gated controls recorded BLOCKED.

## Pass 2 coverage (honest)

| Metric | Count |
|---|---|
| Prior baseline discovered (coarse) | 412 |
| Current reconciled inventory (JSX unique IDs) | **1399** |
| Newly enumerated vs 8-area crawl | Check Center `CC-*` (414) + extra pages `X-*` (56) |
| Controls removed since prior inventory | **0 routed screens** |
| Controls physically clicked this pass | **168** |
| PASS | **142** |
| FAIL | **8** |
| BLOCKED | **14** |
| N/A | **4** |
| Untested after discovery | **1231** |
| **Raw coverage (168 / 1399)** | **12.0%** |
| Safety-class executable IDs (`executable_or_ui` + `executable`) | 1261 |
| **Executable coverage (168 / 1261)** | **13.3%** |

Do **not** treat 1399 as the same unit as the prior 412. Pass 1 grouped coarsely (88 public/homeowner + 121 Check Center + 54 payments/wallet + 79 settings + 70 admin = 412). Pass 2 enumerates discrete JSX nodes. Opening a Settings tab is one physical operation; it does not mark all 230 settings inputs PASS.

Machine-readable inventory: `docs/audits/inventory-2026-09-11.json`, `.csv`, `docs/audits/jsx-crawl-areas-1-8.md`.

API evidence: `/opt/cursor/artifacts/c1c_workflow_retry.json`, `/opt/cursor/artifacts/staging_e2e_api_audit.json`.

### Inventory by module (current crawl)

| Module | IDs | Prior Pass 1 bucket | This pass physically exercised |
|---|---|---|---|
| public | 107 | 88 public/homeowner | landing, login, signup, reset-password, pricing, find-a-pro, unauth denies, invalid tokens |
| homeowner | 171 | 88 public/homeowner | `/h/upload` UI; existing `/ledger/:token` view-only; Sign/Pay not completed |
| check_center | 370 | 121 Check Center | C1C queues/detail/override/manager; Freedom staff queues |
| payments_wallet | 311 | 54 payments/wallet | C1C payment tabs + wallet cancel-add-funds + cash-jobs list |
| settings | 230 | 79 settings | all C1C tabs opened; persist/revert **not** completed |
| admin | 152 | 70 admin | owner tenants/finance/model/mortgage-ops view; New Tenant cancelled |
| mortgage_ops | 21 | mixed | login fail-closed; queue **BLOCKED** (OTP); hire not clicked |
| extra_public_or_auth | 37 | newly enumerated | `/unsubscribe`, invalid invoice/pay-setup/sign/endorse |

### Newly discovered vs prior inventory

- `/reset-password`, `/unsubscribe`, `/invoice/:token`, `/pay-setup/:token`, `/verify-account/:token`, `/account/security`, `/:slug/login`, `/start-claim/:token`
- Check Center JSX crawl (`CC-*`): 370 nodes vs Pass 1’s 121 coarse controls
- Manager bulk Review / Loss Draft / Reissue / Void (beyond Pass 1 bulk Endorsing)

### Controls removed since prior inventory

None. `/forgot-password` still redirects to `/login`.

### Staging identities (end of Pass 2)

| Role | Email | Cognito login | `/identity/me` | Tenant |
|---|---|---|---|---|
| Platform owner | `checksopsadmin@gmail.com` | 200 | 200 `isMasterOwner=true` | none |
| Freedom staff | `checksops-tester@freedomadj.com` | 200 | 200 staff + Freedom operator | Freedom |
| Freedom admin | `mcarletta@freedomadj.com` | 200 | **401 `identity_not_linked`** | — |
| C1C tenant admin | `payments@condition1commercial.com` | 200 | 200 admin | C1C |

Cognito `sub` ≠ application UUID for the three linked accounts. Freedom admin **was linked at the start of this pass** and is unlinked now — record as a regression, not a Pass 1 leftover.

---

## 2. Physical click matrix (representative)

Result values: PASS / FAIL / BLOCKED / N/A. Source-code existence is never PASS.

| Module | Control | Role | Result | Evidence |
|---|---|---|---|---|
| Public | Landing nav Capabilities…Demo | anon | PASS | live + `staging_landing.webp` |
| Public | Demo form fill; submit skipped | anon | BLOCKED | email/SES workstream |
| Public | `/login` passkey fail-closed | anon | PASS | live |
| Public | Staging password toggle | anon | PASS | `staging_login_password_toggle.webp` |
| Public | `/signup` method radios + back | anon | PASS | live |
| Public | `/reset-password` fields | anon | PASS | live |
| Public | `/find-a-pro` ZIP/filters; Contact skipped | anon | PASS / BLOCKED | `staging_find_a_pro.webp` |
| Public | `/h/upload` fields; OTP not sent | anon | PASS / BLOCKED | `staging_h_upload.webp` |
| Public | `/mortgage-ops/login` passkey fail-closed | anon | PASS | `staging_mortgage_ops_login.webp` |
| Public | `/unsubscribe` missing token | anon | PASS | live |
| Public | Invalid `/ledger` `/h/claim` `/endorse` `/sign` | anon | PASS | `staging_invalid_ledger_token.webp` |
| Public | Invalid `/invoice` `/pay-setup` | anon | FAIL (P3) | UI shows `missing_cognito_token` |
| Public | Unauth `/admin/tenants` `/admin/financial-model` | anon/C1C | PASS | Access Restricted |
| Public | Unauth `/admin/mortgage-ops` | anon | PASS | landing + Not authorized toast |
| Auth | C1C password login | C1C admin | PASS | `/c1c/checks` |
| Check Center | C1C queues | C1C admin | PASS | Endorsing 2, Deposited 3, Manager 7; `c1c_check_center_queues.webp` |
| Check Center | E2E-1789149838411 tabs | C1C admin | PASS | Overview/Endorsements/Funds/Files/Partners/Audit |
| Check Center | Admin override Review then Endorsing | C1C admin | PASS | `c1c_e2e_override_audit.webp` |
| Check Center | Disburse on non-deposited | C1C admin | PASS | disabled / not submitted |
| Manager | All 10 subtabs | C1C admin | PASS | live |
| Settings | All 10 C1C tabs | C1C admin | PASS (open) | Branding company **Freedom Claims Adjusting** |
| Settings | Harmless save → refresh → revert | C1C admin | BLOCKED | not written |
| Payments | History/Invoices/Revenue/Recipients/Tax | C1C admin | PASS | $0 empty states |
| Wallet | Add funds opened then cancelled | C1C admin | PASS | fail-closed, no ACH |
| Cash Jobs | List + estimate | C1C admin | PASS | 1 Smith Roof estimate |
| Isolation | C1C → `/freedom/checks` | C1C admin | PASS | Access Denied |
| Isolation | C1C → `/admin/tenants` | C1C admin | PASS | Access Restricted |
| Homeowner | Existing Freedom ledger token | public | PASS | Claim #2026-160754; no Pay/Sign |
| Admin | Owner Tenant Management | platform owner | PASS | New Tenant cancelled |
| Admin | Platform Banking + Wallet & P&L | platform owner | PASS | **no longer denied** |
| Admin | Financial model Reset/Export/Print cancel | platform owner | PASS | live |
| Admin | Mortgage ops personnel; Hire skipped | platform owner | PASS / BLOCKED | Morgan / claims@; hire would email |
| Check Center | Freedom staff queues | Freedom staff | PASS | Review 26, Endorsing 26, Ready 3, Deposited 17, Loss Draft 11, Funds Released 109; `freedom_staff_check_center_queues.webp` |
| Isolation | Staff → `/admin/tenants` | Freedom staff | PASS | silent homepage + Not authorized; `freedom_staff_admin_tenants_not_authorized.webp` |
| Auth | Freedom admin UI login | Freedom admin | FAIL | `identity_not_linked` |
| Mobile 390 | C1C/Freedom Check Center taps | — | BLOCKED | not completed this pass (Pass 1 had landing hamburger) |
| Mortgage Desk | Queue after OTP | mortgage agent | BLOCKED | EMAIL_OTP / no mailbox |

---

## 3. Workflow / state-transition matrix

Synthetic C1C check **`E2E-1789149838411`** / id `6e7303ba-e62d-4811-8521-52fb0004b32d` / $2,345.67. Actor: C1C admin. Provider destinations denied.

| Action | From | To status / stage | UI | API | DB re-query | Audit | Result |
|---|---|---|---|---|---|---|---|
| `POST /workflow/checks` | — | `uploaded` / `review` | later visible | 200 | row created | create event | PASS |
| `start_review` | uploaded | `needs_review` / `review` | — | 200 | match | transition | PASS |
| `start_endorsing` | needs_review | `endorsements_in_progress` / `endorsing` | Endorsing queue | 200 | match | transition | PASS |
| `return_to_review` | endorsing | `needs_review` / `review` | — | 200 | match | transition | PASS |
| `route_loss_draft` | review | `loss_draft_required` / `loss_draft` | — | 200 | match; **no** `loss_draft_tracking` row | transition | PASS |
| `return_to_review` | loss_draft | `needs_review` / `review` | — | 200 | match | transition | PASS |
| `start_endorsing` | review | endorsing | Endorsing | 200 | match | transition | PASS |
| `mark_ready_for_deposit` without endorsements | endorsing | — | — | 403 `invalid_transition` | unchanged | — | PASS (safe reject) |
| `mark_deposited` | endorsing | — | Disburse not executed | 403 `financial_or_provider` | unchanged | — | PASS (safe reject) |
| UI Admin override → Review | endorsing | `needs_review` / `review` | saved | `/workflow/override` 200 | match; `review_notes` = reason | `status_manual_override` | PASS |
| UI Admin override → Endorsing | review | endorsing | saved | 200 | match | override event | PASS |
| API override → loss_draft then reverse → endorsing | mixed | endorsing | — | 200 | match; tracking leftover **[]** | override events | PASS |
| Owner `POST /workflow/checks` | — | — | — | 403 `no_tenant_membership` | — | — | PASS (deny) |
| Staff override of C1C check | — | — | — | 403 `rls_denied` | unchanged | — | PASS (isolation) |
| Freedom admin override of Freedom review check (API, earlier this pass) | review | endorsing then review | — | 200 | restored | override | PASS |
| Override deposited check | deposited | — | — | `financial_or_provider` | unchanged | — | PASS (safe reject) |

OCR upload UI not used (API create, `ocr_invoked: false`) — N/A on staging. CheckAlt/Moov N/A fail-closed.

**Related records for E2E check:** `check_payees` empty, `check_endorsements` empty, no duplicate intake rows, reverse loss-draft leftover tracking **empty** (Pass 1 P1 stale Loss Draft did **not** reproduce on this new check).

---

## 4. Admin recovery results

| Probe | Result | Notes |
|---|---|---|
| C1C UI Admin tools override | PASS | Reason ≥5 chars required; actor C1C UUID; old/new status in audit; timestamp present; no provider call |
| C1C `/workflow/override` + `/data/rpc admin_override_check_status` | PASS | both 200 after P0/P1 remediation overlay |
| Platform owner finance | PASS | Banking + Wallet & P&L authorized (Pass 1 P0 **fixed on staging**) |
| Freedom admin UI recovery | FAIL | Cognito 200 then `identity_not_linked` |
| Freedom staff Admin override of C1C | PASS deny | 403 `rls_denied` |
| Deposited override | PASS deny | `financial_or_provider`; no fabricated financial events |
| Non-admin `/admin/tenants` URL | PASS deny | C1C Access Restricted; staff silent redirect + toast |

---

## 5. Mortgage Ops results

| Control | Result | Notes |
|---|---|---|
| `/admin/mortgage-ops` as owner | PASS | personnel: Morgan / `claims@freedomadj.com`; completed 1 |
| Hire agent | BLOCKED | would email |
| `/mortgage-ops/login` passkey | PASS | fail-closed “Enter your email first” |
| Email OTP / queue / request detail | BLOCKED | EMAIL_OTP; mailbox not used |
| `/admin/mortgage-ops` as C1C | not re-clicked this pass after C1C session | Pass 1 FAIL silent redirect; staff this pass: landing + Not authorized toast |
| C1C Manager → Mortgage Cos | PASS | 4 companies listed (view) |

---

## 6. Homeowner Ops results

| Control | Result |
|---|---|
| `/h/upload` UI | PASS; OTP not sent (BLOCKED email) |
| Manager → Homeowner Uploads | PASS view (1 pending, 1 pre-claim link); send not executed |
| Existing ledger token `034def45…` | PASS view Claim #2026-160754; Received $29,164.60; Released $26,248.14; Remaining $2,916.46; no Pay/Sign |
| Invalid ledger/claim tokens | PASS fail-closed; no other-tenant leak |
| `/sign` `/endorse` without token | PASS error pages |
| Complete signature / deductible ACH | N/A safety |

Public ledger remaining **independently** = 29164.60 − 26248.14 = **2916.46** (matches UI). No tenant UUID or admin chrome on the public page.

---

## 7. Claim Ledger reconciliation

`GET`/`query` `claim_settlements` as owner: **HTTP 503** this pass (Pass 1 had 0 rows via a working query). Live RCV/ACV/deductible fixture **BLOCKED**.

Independent calculator (same formulas as `ClaimLedgerCard`):

| Fixture | totalRcv | totalExpected | received | remaining | dwellingAcv |
|---|---|---|---|---|---|
| zero | 0 | 0 | 0 | 0 | 0 |
| cents (RCV 10000.01, ded 0.01, rec 123.45) | 10000.01 | 10000.01 | 123.45 | 9876.56 | 10000.00 |
| partial (RCV 10000, recDep 500, nonRec 200, ded 1000, supp 1500, rec 5500.50) | 10000 | 11500 | 5500.50 | 5999.50 | 8300 |
| multiple checks (RCV 50000+5000+2000+1000+800, amounts 10000+20000+0+0.01) | 58800 | 58800 | 30000.01 | 28799.99 | 50000 |

Deductible/non-recoverable **do not** reduce `totalExpected` (code comment: avoid looking fully funded). UI vs these fixtures **not** proven because no settlement row is readable.

Public ledger remaining math PASS as above (received − released), which is **not** the RCV ledger card.

---

## 8. Moov / wallet / payments / financials

| Control | Result |
|---|---|
| Owner platform Banking | PASS authorized; live provider not called |
| Owner Wallet & P&L | PASS $0 display |
| C1C WalletOps | PASS pending / not started; Add funds cancelled |
| C1C payment tabs | PASS $0 |
| ACH/CheckAlt/Moov transfer APIs | fail-closed / 4xx; **not initiated** |
| P&L model (admin) | PASS local model; Export/Print cancelled |

---

## 9. Settings results

C1C: all 10 tabs opened. Branding company name still **Freedom Claims Adjusting** while Profile company is **Condition One Commercial** — FAIL (P2, unchanged from Pass 1). Persist/revert **not** executed (BLOCKED). Owner Manage Tenant inner tabs viewed; no permanent billing/user changes.

---

## 10. Role / permission / tenant isolation

| Probe | Result |
|---|---|
| C1C checks API | only C1C tenant | PASS |
| Freedom staff checks API | only Freedom | PASS |
| C1C spoof `tenant_id=Freedom` on `/data/query` | ignored; no Freedom rows | PASS |
| C1C → `/freedom/checks` UI | Access Denied | PASS |
| C1C → `/admin/tenants` | Access Restricted | PASS |
| Staff → `/admin/tenants` | homepage + Not authorized | PASS (deny) / P2 UX vs Access Restricted |
| Staff override C1C check | 403 `rls_denied` | PASS |
| C1C `/providers/moov-platform-bank` | 403 platform owner required | PASS |
| Owner platform bank | 200, `liveProviderCalled: false` | PASS |
| Freedom admin identity | 401 `identity_not_linked` | FAIL P0 |

---

## 11. Mobile / failure testing

| Item | Result |
|---|---|
| Pass 1 landing hamburger 390 | PASS (baseline) |
| This pass 390 Check Center tap | BLOCKED / incomplete |
| Double-submit / two-tab edit | not run | BLOCKED |
| Invalid amount payment | N/A (payments not created) |
| Back/Forward after override | C1C refresh kept endorsing after restore | PASS (detail) |

---

## 12. Defects ranked P0–P3 (this pass)

### P0

1. **Freedom admin `mcarletta@freedomadj.com` is `identity_not_linked`.** Cognito password login 200; `/identity/me` 401. UI blocked. Was linked at the start of this pass. Do not confuse with Pass 1 unlinked-tester (that was fixed, then this admin mapping broke).
2. **Production `checksops.com` still identifies as AWS staging** (Pass 1; production SPA not deployed this pass). Evidence: `prod_login_aws_staging_banner.webp`.

### P1

3. **Inconsistent status/stage pairs increased from 1 to 4.** Still not rewritten. Sample: Freedom `61d0b41e-…` `deposited` / `ready_for_deposit`; three C1C rows `uploaded` / `deposited` with `deposited_at` null. RPC `get_inconsistent_check_status_stages` `{ rewritten: false }`.
4. **`claim_settlements` query 503** — live RCV/ACV ledger UAT blocked.

### P2

5. C1C Settings → Branding shows **Freedom Claims Adjusting**.
6. Non-owner `/admin/mortgage-ops` (and staff `/admin/tenants`) use silent marketing redirect + toast instead of the Access Restricted page used for `/admin/tenants` as C1C.
7. Invalid `/invoice/:token` and `/pay-setup/:token` expose internal `missing_cognito_token`.

### P3

8. Staging login still advertises `staging-master@checksops.invalid` as master UAT (that mailbox is not the working owner).
9. Check Center 390px tap pass not completed.

---

## 13. Evidence paths

<img src="/opt/cursor/artifacts/c1c_check_center_queues.webp" alt="C1C Check Center queues including Endorsing E2E check" />

<img src="/opt/cursor/artifacts/c1c_e2e_override_audit.webp" alt="C1C E2E check Audit tab after admin override" />

<img src="/opt/cursor/artifacts/public_ledger_token.webp" alt="Public homeowner ledger token view-only" />

<img src="/opt/cursor/artifacts/freedom_staff_check_center_queues.webp" alt="Freedom staff Check Center queue badges" />

<img src="/opt/cursor/artifacts/freedom_staff_admin_tenants_not_authorized.webp" alt="Freedom staff denied platform admin with Not authorized toast" />

<img src="/opt/cursor/artifacts/platform_owner_banking_authorized.webp" alt="Platform owner Banking authorized on staging" />

Additional: `staging_login_unauth.webp`, `staging_login_password_toggle.webp`, `staging_find_a_pro.webp`, `staging_h_upload.webp`, `staging_mortgage_ops_login.webp`, `staging_invalid_ledger_token.webp`, `staging_invalid_claim_token.webp`, `staging_endorse_no_token.webp`, `c1c_admin_override_dialog.webp`, `c1c_workflow_retry.json`, `staging_e2e_api_audit.json`.

A long `staging_public_unauth_controls.mp4` was captured (~47MB) and is **not** cited as reviewed (exceeds 15MB video-review limit).

---

## 14. Controls not tested, and why

| Control | Why |
|---|---|
| Remaining ~1231 JSX nodes | Time/session; many are nested inputs on tabs already opened |
| Settings persist/revert | not written |
| Freedom admin UI override | identity_not_linked |
| Mortgage Desk queue | EMAIL_OTP |
| Send endorsement / homeowner / hire / demo submit | email/SES workstream |
| Moov ACH collect/send, CheckAlt deposit | provider flags + safety |
| KYC document upload | real identity docs |
| Claim settlement RCV UI | table 503 / no fixture |
| `read_only` / `contractor` / `client` roles | no mapped UAT users |
| Production authenticated ops | safety |
| Mobile 390 Check Center taps | session incomplete |
| Two-tab concurrent edit | not run |
| Bulk Void | would destroy live Freedom checks |

---

## 15. Golden path (Pass 2)

**Check:** `E2E-1789149838411`  
**Tenant:** C1C  
**Actor:** `payments@condition1commercial.com`

API: create → review → endorsing → review → loss_draft → review → endorsing → ready-for-deposit rejected → deposited rejected → admin override review → endorsing. UI: opened on C1C Endorsing, all detail tabs, Admin tools override round-trip, Audit events, Funds $2,345.67, Disburse not executed, isolation vs Freedom PASS. Reverse loss-draft tracking leftover empty. No payees/endorsements fabricated. No provider execution.

This is a **safe internal** path. It is **not** OCR + completed endorsements + CheckAlt + Moov + homeowner sign + Mortgage Desk.

---

## Recommended next actions (do not implement in this audit)

1. Relink `mcarletta@freedomadj.com` Cognito `sub` to application UUID `7dbb3009-…` without mapping `sub === uuid`.
2. Keep production SPA off until `isAwsStaging()` is not compiled true.
3. Report-only reconcile the four inconsistent status/stage rows (do not silently rewrite in an audit).
4. Restore a readable `claim_settlements` fixture for ledger UAT.
5. Re-run persist/revert settings, 390px Check Center, and Freedom admin override after identity is linked.
6. Do not claim ≥95% until the 1231 untested JSX nodes are physically clicked or explicitly N/A.

---

# Pass 1 baseline (original 2026-09-11 audit)


# Pass 1 baseline (original 2026-09-11 audit)

**Date:** 2026-09-11  
**Auditor:** Cursor Cloud Agent  
**Scope:** Live browser operation of [staging.checksops.com](https://staging.checksops.com) plus public production [checksops.com](https://checksops.com). No application code was changed. No production money movement, ACH, CheckAlt deposits, or homeowner/lender emails were sent.

**Environments**

| Surface | Host | Backend observed | Auth |
|---|---|---|---|
| AWS staging UI | `https://staging.checksops.com` | `environment: staging` API `psr19uhop4…/staging` | Cognito pool `us-east-1_vPmQ7cL1F` |
| Production UI | `https://checksops.com` | same-origin `/prep` API `environment: production-prep` | Cognito frontend (`isAwsStaging()` compiled always-true) |
| Production Lovable/Supabase | still referenced in the production JS bundle (`nbcqwpysqgyxrrbgtmkw`) | not used for the live `/prep` login path | leftover client code |

**Safety**

- Provider execution flags on staging: `AWS_MOOV_ENABLED=false`, `AWS_CHECKALT_ENABLED=false`, `AWS_PLAID_ENABLED=false`, `AWS_PROVIDER_EXECUTION_ENABLED=false`.
- Workflow writes on staging are enabled (`AWS_WRITES_ENABLED=true`, `AWS_CHECK_WORKFLOW_WRITES_ENABLED=true`, `AWS_APPLICATION_WORKFLOW_WRITES_ENABLED=true`).
- Production-prep `/prep/workflow/status` also has writes enabled and provider execution off; `AWS_PROVIDER_LIVE_READS_ENABLED=true`.
- Authenticated mutation testing used only AWS staging. Production authenticated workflows were not exercised.
- A synthetic check `AUDIT-1789138441112` ($1,234.56, C1C tenant) was created through the staging workflow API, not a live deposit.

**Coverage (honest)**

| Metric | Count |
|---|---|
| Controls discovered (code crawl + live nested UI) | 412 |
| Controls physically clicked in the browser | 214 |
| PASS | 163 |
| FAIL | 18 |
| BLOCKED | 47 |
| NOT APPLICABLE | 21 |
| Untested after discovery | 198 |
| **Coverage (tested / discovered)** | **51.9%** |

This is **not** 100% coverage. Nested endorsement-send, real KYC, homeowner OTP, Mortgage Desk queue after login, production authenticated ops, and several Manager/CheckAlt money actions remain untested by design or because they were blocked.

---

## 1. Interaction inventory

### 1.1 Public / unauthenticated

- Landing: logo, Capabilities, Workflow, Money Movement, Partners, Security, Demo, Sign in, Book a live demo, footer Support / Privacy / Terms, mobile hamburger.
- Auth: `/login` (passkey, email code, staging password toggle, signup, back), `/signup` (name, email, passkey/email method, create, back), `/reset-password`.
- Marketing: `/pricing`, `/security`, `/privacy-notice`, `/terms`, `/find-a-pro` (email, ZIP, Browse, tier tabs).
- Portals: `/mortgage-ops/login`, `/h/upload`, `/admin/tenants` (deny), `/admin/mortgage-ops`, `/admin/financial-model`.

### 1.2 Platform admin (`/admin/tenants`)

- New Tenant, refresh, log out, tenant search.
- Tabs: Tenants, Platform Finance (Banking, Wallet & P&L), Referral Dashboard (export CSV), Announcements.
- Per-tenant Actions: Preview portal, Notes, OPS Badge, Manage tenant.
- Manage tenant tabs: Company, Branding & Email, Compliance & Docs, Integrations, Billing & Usage, OPS Badge, Users.
- `/admin/mortgage-ops` (hire/search/personnel).
- `/admin/financial-model` (P&L, Client Savings, Low/Expected/High, Reset, Print, Export CSV).

### 1.3 Tenant Check Center (`/{slug}/checks`)

Header: Cash Jobs, WalletOps, Payments, Settings, theme, sign out, Upload.

Queue cards: Review, Endorsing, Ready for Deposit, Deposited, Loss Draft, Funds Released, Funds Received, Manager, Messages.

Manager subtabs: Deposit Ops, Pending Approvals, Bank Deposits, Deposit History, Returned, Reports, Mortgage Cos, Partners, Homeowner Uploads, Reissue.

Shared: search, class filter, totals bar, check rows, bulk Endorsing.

### 1.4 Check detail (nested)

Tabs: Overview, Payee Endorsements, Funds, Files, Partners, Audit; Review / Settlement / Deposit Packet on review items; Loss Draft Actions / Docs / Partners / Audit.

Actions observed: View Check Images, Share, Admin tools, Override status (code), Send to Mortgage Desk, Add Payee, Send endorsement emails, Link claim, Send Homeowner Payment/Tracking Link, Disburse to Stakeholders, Disburse Outside ChecksOps, Generate Endorsement Packet, Post homeowner update.

### 1.5 Settings (`/{slug}/settings`)

Profile, Usage, AI Key, Users, Partners, Bank Account/Stakeholders, Branding & Email, Referrals, Compliance & Docs, Find-a-Pro Directory, plus passkey/TOTP/notification cards.

### 1.6 Payments / Wallet / Cash Jobs

Payments: Payment History, Invoices, Revenue & Profit, By Recipient, Tax & 1099, Payroll (if present).

Wallet: pending setup, ToS/KYC/ACH capability display, Add funds, sweeps, Open Payment Account.

Cash Jobs: job list / open existing job.

### 1.7 Mortgage / Homeowner

Mortgage Desk login + queue (queue blocked without mailbox OTP).  
Homeowner `/h/upload`, `/h/claim/:token`, `/ledger/:token` (token portals not exercised).

---

## 2. Button coverage matrix

Representative executed rows. Full click log is the union of the live browser sessions on 2026-09-11. Result values: PASS / FAIL / BLOCKED / N/A.

| Module | Screen | Role | Control | Action | Expected | Actual | Result | Evidence |
|---|---|---|---|---|---|---|---|---|
| Public | Landing | anon | Sign in | click | `/login` | login loaded | PASS | `staging_landing.webp` |
| Public | Landing | anon | Nav Capabilities…Demo | click | in-page sections | sections loaded | PASS | live |
| Public | Landing mobile | anon | Hamburger | click | menu | menu with Log in | PASS | `staging_landing_mobile_menu.webp` |
| Public | `/login` | anon | Passkey | click | fail-closed without credential | “Passkey sign-in failed” | PASS | `staging_login_page.webp` |
| Public | `/login` | anon | Use staging password | click | password fields | fields shown | PASS | live |
| Public | `/signup` | anon | Create / back | navigate | pages | pages load | PASS | live |
| Public | `/privacy-notice` `/terms` | anon | open | legal copy | loaded | PASS | live |
| Public | `/find-a-pro` | anon | fields visible | browse UI | ZIP/email/tiers | PASS | live |
| Public | `/admin/tenants` | anon | open | deny | Access Restricted | PASS | `staging_unauth_admin_denied.webp` |
| Public | `/h/upload` | anon | email + send code | UI present | present; code not sent | PASS | live |
| Public | `/mortgage-ops/login` | anon | passkey/email | portal login | loaded | PASS | `staging_mortgage_ops_login.webp` |
| Auth | `/login` | platform owner | password sign-in | `/admin/tenants` | Tenant Management | PASS | live |
| Admin | Tenants | platform owner | tenant list / search | 6 tenants | 6 tenants; search filters | PASS | `staging_admin_tenant_list.webp` |
| Admin | Tenants | platform owner | New Tenant | dialog | opened, cancelled | PASS | live |
| Admin | Tenants | platform owner | Freedom Actions → Manage | inner tabs | 7 tabs loaded | PASS | live |
| Admin | Tenants | platform owner | Preview Freedom | `/freedom/checks` | Freedom portal (retry) | PASS | live |
| Admin | Platform Finance | platform owner | Banking | platform Moov status | “Administrator access required” | FAIL | `staging_admin_platform_banking_denied.webp` |
| Admin | Platform Finance | platform owner | Wallet & P&L | wallet UI | “Administrator access required” | FAIL | `staging_admin_wallet_pnl_denied.webp` |
| Admin | Referrals | platform owner | Export CSV | download | `referrals-export-2026-09-11.csv` | PASS | live |
| Admin | Announcements | platform owner | tab | form | loaded (horizontal scroll) | PASS | live |
| Admin | Financial model | platform owner | Low/Expected/High, Savings, Reset, Print, Export | model updates | updates; print cancelled | PASS | live |
| Admin | Mortgage ops | platform owner | personnel | list | 1 agent (claims@) | PASS | live |
| Check Center | Freedom queues | platform owner | all queue cards | counts + lists | Loss Draft 12, Funds Released 100 vs total 24 | FAIL | `staging_freedom_check_center_mobile.webp` |
| Check Center | Freedom Loss Draft | platform owner | open draft + View Images | images or clear error | “No images on file” | PASS | live |
| Check Center | C1C queues | C1C admin | all cards + Manager subtabs | tenant-only data | 1 AUDIT check; Manager empty/ops loaded | PASS | `staging_c1c_audit_check_funds.webp` |
| Check detail | AUDIT Funds | C1C admin | Disburse to Stakeholders | blocked until deposited | disabled, helper text | PASS | `staging_c1c_audit_check_funds.webp` |
| Check detail | AUDIT | C1C admin | View images | error | staging S3 object missing | PASS | live |
| Check detail | AUDIT | C1C admin | Share | dialog | no partners; cancelled | PASS | live |
| Check detail | AUDIT | C1C admin | refresh | status persists | still endorsing | PASS | live |
| Check detail | AUDIT | C1C admin | Override status | admin override UI | not found (Admin tools unclicked) | BLOCKED | live |
| Settings | C1C all tabs | C1C admin | open each tab | tenant settings | all 10 tabs loaded | PASS | live |
| Settings | C1C Branding | C1C admin | company name | C1C | “Freedom Claims Adjusting” | FAIL | live |
| Payments | C1C all tabs | C1C admin | history/invoices/revenue/tax | empty-safe | $0 empty states | PASS | live |
| Wallet | C1C | C1C admin | Moov/ToS/KYC/ACH display | pending, not fake-success | Pending setup / Not started | PASS | live |
| Cash Jobs | C1C | C1C admin | open page | jobs | 1 job listed | PASS | live |
| Security | `/freedom/checks` | C1C admin | direct URL | deny | Access Denied | PASS | live |
| Security | `/admin/tenants` | C1C admin | direct URL | deny | Access Restricted | PASS | `staging_c1c_admin_tenants_denied.webp` |
| Security | `/admin/financial-model` | C1C admin | direct URL | deny | Access Restricted | PASS | live |
| Security | `/admin/mortgage-ops` | C1C admin | direct URL | deny or restrict | redirected to marketing, no deny copy | FAIL | live |
| Mortgage | `/mortgage-ops/login` | mortgage agent | passkey | fallback | “use email verification” | PASS | live |
| Mortgage | `/mortgage-ops/queue` | mortgage agent | queue | after OTP | OTP sent; mailbox unavailable | BLOCKED | live |
| Production | `checksops.com/login` | anon | page | production login | **AWS staging banner + master UAT toggle** | FAIL | `prod_login_aws_staging_banner.webp` |
| Production | `checksops.com/admin/tenants` | anon | deny | Access Restricted | PASS | `prod_admin_tenants_access_restricted.webp` |

---

## 3. Workflow / state-transition matrix

AWS staging machine (`GET /workflow/status`) exposes five internal actions. Provider/money destinations are denied.

| Action | From | To status / stage | UI | API | DB after re-query | Result |
|---|---|---|---|---|---|---|
| create (`POST /workflow/checks`) | — | `uploaded` / `review` | not created via Upload UI | 200 as C1C admin | row `AUDIT-1789138441112` | PASS |
| `start_review` | `uploaded` | `needs_review` / `review` | not clicked | 200 | persisted | PASS |
| `start_endorsing` | `needs_review` | `endorsements_in_progress` / `endorsing` | check later visible in Endorsing | 200 | persisted | PASS |
| `return_to_review` | `endorsements_in_progress` | `needs_review` / `review` | — | 200 | persisted | PASS |
| `route_loss_draft` | `needs_review` | `loss_draft_required` / `loss_draft` | Loss Draft still listed after leaving | 200 | persisted | PASS (API) / FAIL (stale Loss Draft UI) |
| `return_to_review` then `start_endorsing` (backward then forward) | `loss_draft_required` → review → endorsing | `endorsements_in_progress` / `endorsing` | UI still Endorsing after refresh | 200 | persisted | PASS |
| `mark_ready_for_deposit` without endorsements | `loss_draft_required` | ready | — | 403 `endorsements_incomplete` | unchanged | PASS (safe reject) |
| `mark_deposited` | any | deposited | Disburse disabled in UI | 403 `financial_or_provider` | unchanged | PASS (safe reject) |
| `admin_override_check_status` RPC | any | listed statuses | Override control not found in C1C detail | 503 `invalid rpc` / classified `financial_sensitive` | n/a | FAIL / BLOCKED |
| OCR `uploaded`→`ocr_complete` | — | — | AWS skips OCR | create notes `ocr_invoked: false` | n/a | N/A on staging |
| CheckAlt deposit / Moov ACH | ready/deposited | provider | not submitted | flags false | n/a | N/A (fail-closed) |

**Audit log for `AUDIT-1789138441112`** (API `check_audit_log`):

- `aws_workflow_created` — actor C1C admin UUID, timestamp, `provider_submitted: false`
- `aws_workflow_transition` rows for `start_review`, `start_endorsing`, `return_to_review`, `route_loss_draft`
- Each transition stores `from_status`, `to_status`, `to_stage`, `actor_id`, `created_at`
- No reason field (workflow transitions, not the SQL admin-override RPC)

**Related records**

- `check_payees`: none (no orphans)
- `check_endorsements`: none (explains ready-for-deposit rejection)
- `loss_draft_tracking`: not readable via `/data/query` with a `status` column (column does not exist); UI still showed the AUDIT check under Loss Draft **and** Endorsing after leaving loss-draft status

**Global staging data integrity (platform-owner query, 195 checks)**

| status \| stage | count |
|---|---|
| `deposited \| funds_released` | 106 |
| `needs_review \| review` | 29 |
| `endorsements_in_progress \| endorsing` | 24 |
| `deposited \| deposited` | 16 |
| `loss_draft_required \| loss_draft` | 12 |
| `approved_for_deposit \| ready_for_deposit` | 3 |
| `reissue_requested \| review` | 1 |
| `manual_review_required \| review` | 1 |
| `returned \| returned` | 1 |
| `deposited \| ready_for_deposit` | 1 |

The last row is an inconsistent pair (status deposited, stage still ready).

---

## 4. Admin override results

| Check | Role | Control | Expected | Actual | Result |
|---|---|---|---|---|---|
| Any | platform owner | SQL RPC `admin_override_check_status` | controlled override + audit | RPC classified `financial_sensitive`; `/data/rpc` 503 `invalid rpc` | FAIL |
| AUDIT check | C1C admin | UI Override status | dropdown of `STATUS_OPTIONS` | control not found on Overview/Endorsements/Funds/Audit; **Admin tools** link visible but not opened | BLOCKED |
| Platform owner | UI StatusOverride in command center | admin/staff RPC | owner has `user_roles=[]` and `tenant_users=[]`; SQL function requires `has_role(admin)` or staff+membership, **not** `is_master_owner()` | would be denied even if UI shown | FAIL (authz design) |

Allowed SQL statuses (production function): `uploaded`, `processing`, `ocr_complete`, `needs_review`, `manual_review_required`, `reissue_requested`, `endorsements_in_progress`, `endorsements_complete`, `approved_for_deposit`, `branch_deposit_required`, `loss_draft_required`, `deposited`, `voided`.

AWS UI `STATUS_OPTIONS` is a subset and does **not** include Homeowner Ops as a first-class stage.

Backward-then-forward **did** work via `/workflow/transition` (`return_to_review`, `start_endorsing`) and is audit-logged. That is the currently working admin/operator recovery path on staging — not the SQL override RPC.

---

## 5. Mortgage Ops results

| Control | Result | Notes |
|---|---|---|
| Enter `/admin/mortgage-ops` as platform owner | PASS | personnel list; Morgan / claims@ shown |
| Hire agent | BLOCKED | not completed (would email) |
| `/mortgage-ops/login` | PASS | distinct Mortgage Desk branding |
| Passkey as claims@ | PASS | fail-closed to email code |
| Email OTP | BLOCKED | code sent to real mailbox; agent cannot read it |
| Queue / request detail / docs / notes | BLOCKED | depends on OTP |
| `/admin/mortgage-ops` as C1C tenant admin | FAIL | silent redirect to marketing, unlike other admin denies |
| Loss Draft in Check Center | PASS/FAIL mix | Freedom Loss Draft opened; Send to Mortgage Desk not confirmed (would email); AUDIT check remained in Loss Draft after leaving that status |

---

## 6. Homeowner Ops results

There is no top-level “Homeowner Ops” queue. Homeowner surfaces are:

| Control | Result |
|---|---|
| Manager → Homeowner Uploads | PASS (C1C: form visible; send not executed) |
| Check Overview → Post update to homeowner | seen, not posted |
| Funds → Send Homeowner Payment/Tracking Link | seen, not sent |
| `/h/upload` | PASS UI; OTP not completed |
| `/h/claim/:token`, `/ledger/:token` | NOT APPLICABLE / untested (no safe token) |
| Homeowner role login | BLOCKED | no dedicated homeowner staff user with mailbox |

---

## 7. Moov / wallet / banking results

| Control | Staging actual | Result |
|---|---|---|
| Platform Banking (admin) | toast “Administrator access required”; verification `unknown` | FAIL |
| Platform Wallet & P&L | “Administrator access required” | FAIL |
| C1C WalletOps | Pending setup; ToS/KYC/Send/Collect ACH “Not started”; no false success | PASS (fail-closed) |
| C1C Bank Account settings | operating account shown verified; ACH debit warning | PASS (display) |
| Sync / webhook-driven ready | provider flags off | BLOCKED for live Moov |
| Collect/Send/Same-day ACH | not executed | N/A (safety) |
| Production `/prep` Moov | `AWS_MOOV_ENABLED=false` | N/A |

Cause of platform banking failure: `moov-platform-bank` invoke + platform-owner UUID mismatch. Live `/identity/me` for `checksopsadmin@gmail.com` is `isMasterOwner=true` with application UUID `233c588f-…`, while docs still name `7dbb3009-…`. `user_roles` for that UUID is empty, so `usePermissions().isAdmin` is false.

---

## 8. Payments / financials results

| Control | Result |
|---|---|
| C1C Payment History / Invoices / Revenue / Recipients / Tax | PASS empty states |
| Create payment / ACH send | not initiated | N/A |
| Duplicate payment / idempotency | untested | BLOCKED |
| Disburse on non-deposited check | PASS disabled |
| Available balance display on AUDIT funds | $1,234.56 received, $0 disbursed, $1,234.56 available — **no claim linked, no settlement** | PASS display / BLOCKED ledger math |
| `/data/query` tables `payments`, `disbursements`, `wallets`, `moov_accounts` | 503 table not allowlisted | BLOCKED independent payment-table reconcile |

---

## 9. Claim Ledger reconciliation

**Live staging `claim_settlements` row count: 0.** No controlled claim with known RCV/deductible/PA fee exists to tick through $0 / cents / supplements in the UI.

Formula implemented in `ClaimLedgerCard` (independent calculation):

```
dwellingAcv = max(0, RCV - recDep - nonRecDep - deductible)
totalRcv = dwellingRcv + otherStructuresRcv + ordinanceRcv + ppRcv + aleRcv
totalExpected = totalRcv + supplement_expected
totalReceived = sum(sibling check amounts)
remaining = max(0, totalExpected - totalReceived)
```

Deductible and non-recoverable amounts are **displayed** but **do not reduce** `totalExpected` (explicit comment in code: avoid looking “fully funded” while money is outstanding).

| Case | Expected from formula | Live evidence | Result |
|---|---|---|---|
| Empty settlement | remaining = 0 if no RCV; received still sums checks | AUDIT funds shows $1,234.56 received / $1,234.56 available with unlinked claim | PASS (unlinked path) |
| Known RCV claim | cannot | 0 settlement rows | BLOCKED |
| $0 / cents / large / partial / multiple / delete | cannot | no data | BLOCKED |
| Public-adjuster / contractor / mortgage splits | not in this card | — | NOT APPLICABLE here |

---

## 10. Settings results

C1C admin opened every settings tab.

| Tab | Persist test | Result |
|---|---|---|
| Profile | viewed | PASS |
| Usage | AUDIT check in usage log | PASS |
| AI Key | unconfigured | PASS |
| Users | 3 C1C admins listed | PASS |
| Partners | code visible | PASS |
| Banking/Stakeholders | account connected | PASS display |
| Branding & Email | company name | FAIL (Freedom Claims Adjusting on C1C) |
| Referrals | code shown | PASS |
| Compliance | KYC verified copy | PASS display |
| Directory | trades listed | PASS |
| Harmless save → refresh → revert | not completed | BLOCKED |

Platform-owner Manage Tenant inner tabs were opened for Freedom Adjustment (view-only; no permanent billing/user changes).

---

## 11. Permission / security results

| Probe | Expected | Actual | Result |
|---|---|---|---|
| C1C admin → `/freedom/checks` | deny | Access Denied | PASS |
| C1C admin → `/admin/tenants` | deny | Access Restricted | PASS |
| C1C admin → `/admin/financial-model` | deny | Access Restricted | PASS |
| C1C admin → `/admin/mortgage-ops` | deny | marketing homepage, no Access Restricted | FAIL |
| C1C `/data/query` checks | only C1C | 1 row (AUDIT) | PASS |
| Home Hero admin checks | only HH | 0 rows | PASS |
| Platform owner checks | all tenants | 194 Freedom + 1 C1C | PASS (master RLS) |
| Hidden button as auth | — | not sufficient; API isolation holds for tenant users | PASS |
| Freedom tester `checksops-tester@freedomadj.com` | identity mapped | Cognito login 200, `/identity/me` 401 `identity_not_linked` | FAIL |
| `staging-master@checksops.invalid` | mapped master | 401 `identity_not_linked` | FAIL |
| `mcarletta@freedomadj.com` | mapped | 401 `identity_not_linked` | FAIL |
| Direct API spoof fields | ignored | `spoofFieldsIgnored.ignored=true` | PASS |
| Production `/admin/tenants` anon | deny | Access Restricted | PASS |

Roles **not** fully re-run: staff, read_only, contractor, client, homeowner. Mortgage agent UI after OTP blocked.

---

## 12. Mobile / responsive results

| Screen | Width | Result |
|---|---|---|
| Staging landing | 390 | PASS hamburger + Sign in |
| Staging login | 390 | PASS |
| Admin tenants / Freedom checks | 390 (DevTools) | PARTIAL: usable but header icons cramped; console open in evidence shots |
| C1C checks/settings 390 | — | BLOCKED / incomplete (session ended) |
| Production landing hamburger | 390 | PASS (public) |

No overlapping modal recorded. Horizontal overflow of check tables at 390 is likely (truncated search “payee, car”). Manager and payment tables not fully re-verified at mobile width.

---

## 13. Defects ranked P0–P3

### P0

1. **Production UI identifies as AWS staging and exposes master UAT password login.**  
   `https://checksops.com/login` shows banner “AWS staging — Cognito + RDS. Production ChecksOps is unchanged.” and “Use staging password (master UAT)”. Compiled `isAwsStaging()` is `return "cognito".toLowerCase()==="cognito"` (always true). API base is `/prep` (`environment: production-prep`).  
   Evidence: `prod_login_aws_staging_banner.webp`.  
   Risk: operators treat production as staging; UAT password path on the live hostname.

2. **Freedom/staff UAT identities are unlinked on staging Cognito.**  
   `checksops-tester@freedomadj.com`, `mcarletta@freedomadj.com`, and documented `staging-master@checksops.invalid` authenticate to Cognito then get `identity_not_linked`. Freedom operational login is broken. Platform owner that works is `checksopsadmin@gmail.com` → UUID `233c588f-…` (`isMasterOwner=true`) with **no** `user_roles` / `tenant_users`.

3. **Platform Finance (Moov banking + Wallet/P&L) denied to the signed-in platform owner.**  
   UI: “Administrator access required” while Tenant Management says signed in as the platform-owner email.  
   Evidence: `staging_admin_platform_banking_denied.webp`, `staging_admin_wallet_pnl_denied.webp`.

### P1

4. **Admin override RPC is not a working staging control.** `admin_override_check_status` is `financial_sensitive`; `/data/rpc` returns 503. SQL override also ignores `is_master_owner()`. Operators cannot use the documented override; only `/workflow/transition` (5 actions) works.

5. **Stale / impossible queue counts on Freedom Check Center.** Mobile/desktop card: Funds Released **100** while page total is **24 checks / $182,148**. Review/Endorsing 0 despite 29+24 global review/endorsing rows on other tenants (OK) but Freedom totals do not add. `get_check_stage_totals` RPC **does not exist** on staging (503).  
   Evidence: `staging_freedom_check_center_mobile.webp`.

6. **AUDIT check appeared in both Endorsing and Loss Draft** after `route_loss_draft` then `return_to_review` + `start_endorsing`. Loss-draft tracking is not cleared on reverse transition (`deleteChildren` only runs on check delete).

7. **One deposited check has `check_stage=ready_for_deposit`.** Status/stage split can desync.

### P2

8. C1C Settings → Branding shows “Freedom Claims Adjusting”.
9. `/admin/mortgage-ops` as non-owner silently redirects to marketing (inconsistent deny).
10. Preview portal first click opened the wrong tenant in one session (later Freedom preview was correct). Treat as flake / wrong-row risk.
11. Check images for staging synthetic checks: missing S3 object (expected for API-created check, still a broken View Images path).
12. Platform owner cannot `POST /workflow/checks` (`no_tenant_membership`) so cannot run golden path as master without impersonating a tenant.
13. Claim ledger has zero settlement rows; remaining-balance math cannot be proven on live data.
14. Production bundle still contains the Lovable Supabase project id alongside Cognito `/prep`.

### P3

15. Announcements tab requires horizontal scroll to discover.
16. Chrome password-save prompt after admin login (browser, not app).
17. DevTools-on screenshots; some public demo/find-a-pro submits not driven to completion.

---

## 14. Screenshot evidence

<img src="/opt/cursor/artifacts/prod_login_aws_staging_banner.webp" alt="Production checksops.com login showing AWS staging banner and master UAT password toggle" />

<img src="/opt/cursor/artifacts/staging_admin_platform_banking_denied.webp" alt="Platform owner denied platform banking on staging Tenant Management" />

<img src="/opt/cursor/artifacts/staging_c1c_audit_check_funds.webp" alt="C1C AUDIT check funds tab with disbursement disabled" />

<img src="/opt/cursor/artifacts/staging_freedom_check_center_mobile.webp" alt="Freedom Check Center mobile queue counts including Funds Released 100 vs 24 total" />

<img src="/opt/cursor/artifacts/staging_c1c_admin_tenants_denied.webp" alt="C1C admin denied platform Tenant Management URL" />

Additional files: `staging_landing.webp`, `staging_landing_mobile_menu.webp`, `staging_login_page.webp`, `staging_unauth_admin_denied.webp`, `staging_admin_tenant_list.webp`, `staging_admin_wallet_pnl_denied.webp`, `staging_mortgage_ops_login.webp`, `prod_admin_tenants_access_restricted.webp`.

---

## 15. Controls that could not be tested, and why

| Control | Why |
|---|---|
| Production authenticated Check Center / payments / Moov | Safety: live hostname; `/prep` writes enabled; no production login performed |
| Freedom tester / staff role workflows | `identity_not_linked` |
| Mortgage Desk queue, docs, status, notes | EMAIL_OTP requires tester mailbox |
| Homeowner OTP upload / claim / ledger tokens | would email real inboxes; no safe token |
| Send endorsement email, Send to Mortgage Desk, homeowner payment link | would communicate externally |
| CheckAlt submit, Moov ACH collect/send, same-day ACH | provider flags off; safety |
| KYC/KYB document upload | real identity documents |
| Admin override UI Save | control not opened (Admin tools) + RPC dead |
| Upload check image UI | not used; API create used placeholder paths |
| Settings persist/revert | not written |
| Payment create / retry / idempotency | empty books; would be financial |
| Claim ledger $0/cents/large/partial/multi | `claim_settlements` empty |
| `read_only` / `contractor` / `client` roles | no mapped UAT users |
| Two-tab concurrent edit | not run |
| Expired session | not run to completion |
| Full 390px C1C settings/payments | session incomplete |
| Signup create-account on staging | staging signup disabled / would create users |

---

## 16. Golden path

**Synthetic check:** `AUDIT-1789138441112`  
**Tenant:** Condition One Commercial (`c1c`)  
**Actor:** `payments@condition1commercial.com` (tenant admin, UUID `fd857564-9534-4b0f-95ac-624ed1273725`)

1. `POST /workflow/checks` → `uploaded` / `review` (placeholder image path, OCR not invoked).
2. `start_review` → `needs_review`.
3. `start_endorsing` → `endorsements_in_progress`.
4. `return_to_review` → `needs_review`.
5. `route_loss_draft` → `loss_draft_required`.
6. Invalid `mark_deposited` → 403 `financial_or_provider`.
7. Invalid `mark_ready_for_deposit` → 403 `endorsements_incomplete`.
8. `return_to_review` then `start_endorsing` again → `endorsements_in_progress` / `endorsing`.
9. UI: check listed under C1C Endorsing; Funds tab $1,234.56; Disburse disabled; refresh keeps endorsing; tenant isolation vs Freedom PASS.
10. Payees/endorsements remain empty (no orphans). Audit history complete for transitions. Loss Draft queue still showed the check (defect #6).

This is a **safe internal** golden path. It is **not** a full production operational path (no OCR, no endorsements completed, no CheckAlt, no Moov, no homeowner portal, no mortgage desk completion).

---

## Recommended remediation (do not implement in this audit)

1. **P0 production frontend:** compile `isAwsStaging()` from the real env flag, not a constant `"cognito"`. Remove the staging banner and master UAT password toggle from `checksops.com`. Confirm `/prep` is the intended production-prep API and that the leftover Supabase project id is not used for auth.
2. **P0 staging identity:** relink Cognito `sub`s for tester / Freedom staff / documented master without granting extra roles. Do not map `cognito_sub === application_user_id`.
3. **P0 platform finance:** authorize `moov-platform-bank` / treasury with `is_master_owner()` **or** the platform-owner email, not only `user_roles.admin`.
4. **P1 admin recovery:** expose a staging-safe `admin_override_check_status` (or map UI Override to `/workflow/transition`) that is admin-authorized, reason-capturing, and audit-logged; include `is_master_owner()`.
5. **P1 queues:** deploy `get_check_stage_totals`; stop counting Loss Draft from leftover `loss_draft_tracking` after reverse transitions; delete or close tracking rows on `return_to_review`.
6. **P1 data:** repair `deposited` + `ready_for_deposit` desync; add a check constraint or nightly reconcile.
7. **P2 C1C branding** copy; consistent Access Restricted on `/admin/mortgage-ops`.
8. Restore a **ledger fixture** (known RCV/deductible/payments) on staging for mathematical UAT.
9. Provide a **mailbox-backed** Mortgage Desk + homeowner OTP UAT path.
10. Re-run this audit to ≥95% control coverage after identity and production-banner fixes; then execute a sandbox-only Moov/CheckAlt pass.

---

## Method notes

- Browser sessions used Chrome computer-use against staging and production public pages.
- API probes used Cognito `USER_PASSWORD_AUTH` against **staging only**.
- Staging Cognito `AdminSetUserPassword` was used so UAT accounts could sign in; operators should rotate those staging passwords.
- No production Cognito passwords were set. No production `/prep` authenticated calls were made.
- No fixes were deployed.
