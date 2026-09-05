# CheckAlt UAT certification (AWS staging)

**Date:** 2026-09-04  
**Branch:** `cursor/staging-checkalt-uat-cert-c8f0`  
**PR:** #125  
**Scope:** CheckAlt UAT certification only — not production activation.  
**Moov:** Sandbox certification remains **PASS** (PR #124). Moov implementation was **not** modified.  
**Verdict:** **PARTIAL** — STOP for review

## Documentation authority (authoritative)

Uploaded CheckAlt extract (Postman / OpenAPI 3.1 Clearingworks IR):

- `aws/providers/results/CheckAlt_PR125_Minimal_API.json`
- `/opt/cursor/artifacts/CheckAlt_PR125_Minimal_API.json`
- Collection: **Checkalt Clearingworks IR API Specifications - OpenAPI 3.1**
- Cross-check: working Lovable/Supabase FinCapture path (`supabase/functions/_shared/checkalt.ts` and deposit functions)

## Postman-backed FinCapture sequence

| Postman operation | Path | Role |
|---|---|---|
| Authenticate FinCapture user | `POST /public/fincapture/authenticate` | Auth → JWT (`userName`/`password`) |
| Register FinCapture user | `POST /fincapture/useraccount/register` | Create depositor links |
| Get user account information | `POST /fincapture/useraccount/getUserAccountInformation` | Account / `ssoKey` discovery |
| Get single deposit account detail | `POST /fincapture/useraccount/getDepositAccountInformation` | Authorize deposit account |
| **Submit deposit transaction** | **`POST /fincapture/deposit/process`** | **Direct submission** (`FinCaptureAPIDepositRequest`: FI key, depositor account, images, amounts) |
| Approve or reject deposit in workflow | `POST /fincapture/deposit/approve` | **Post-process** workflow action on an existing `referenceNumber` |
| Get deposit by reference | `POST /fincapture/deposit/item` | **Post-process** status/detail |
| List deposit history | `POST /fincapture/deposit/history` | **Post-process** history |
| Retrieve Transaction with High-Resolution Images | `GET /cw/transaction/getTransactionWithHighResImages/{partitionNumber}/{transactionId}` | **Post-transaction retrieval** — “use high-res only for detail, print, or IRD generation” |
| Generate Image Replacement Document (IRD) | `POST /cw/transaction/generateIRD` | **Post-transaction output** — TIFF IRD for an eligible existing check item (`transactionId` / image row required) |

### IRD / High-Resolution (definitive from Postman)

- **Not part of deposit submission.**
- High-res retrieve requires an existing `partitionNumber` + `transactionId`.
- IRD requires an existing eligible item (`transactionId` / front-image row); 422 if not IRD-eligible.
- Do **not** call either as a substitute for `/deposit/process`.

### `/deposit/process` sample fields (Postman)

Documented request sample includes: `fiKey`, `ssoKey`, `captureDateTime`, `depositAccountNumber`, `userAmount`, `frontImage`, `rearImage`, `performRiskAssessment`, plus optional sample fields `firstName` / `lastName` / `emailAddress` / `dailyDepositLimit`.

Description: validates user is registered for deposit and account belongs to the biller; 400 if user not eligible (complete registration first).

Working Lovable production submit does **not** send the optional name/email/limit fields and succeeds on production CheckAlt. AWS #125 preserves that Lovable parity (does not invent extra required fields).

## AWS #125 vs Lovable vs Postman

| Concern | Postman | Lovable | AWS #125 UAT |
|---|---|---|---|
| Submit endpoint | `/fincapture/deposit/process` | same | same |
| Auth / register / account info | documented | used | used |
| Approve / item / history | post-process | post-process | post-process |
| IRD / high-res | post-transaction | not used in submit | not used in submit |
| `userAmount` | integer in sample; success OCR shows dollars separately | integer cents | integer cents |
| Images | `frontImage` / `rearImage` in process body | prepare pipeline → raw base64 | same prepare pipeline |
| `performRiskAssessment` | present in sample | `true` | `true` |
| `testDeposit` | **not** in Postman sample | absent | absent |

**Finding:** No missing documented FinCapture submit step, image-upload endpoint, transaction-create endpoint, or IRD/high-res prerequisite. `/fincapture/deposit/process` is definitively the correct direct submission endpoint.

## Scorecard

| Area | Result |
|---|---|
| Authentication | **PASS** |
| Merchant / FI context | **PASS** |
| Deposit-account binding | **PASS** |
| Depositor / ssoKey | **PASS** |
| Image pipeline parity (Lovable) | **PASS** |
| FinCapture sequence / required fields (Postman-backed) | **PASS** |
| UAT submission | **PARTIAL** — process reached; CheckAlt HTTP 500: *"Please retake the check images and resubmit."*; no provider reference |
| Status / history | **BLOCKED** (no accepted reference) |
| Callback / webhook | **N/A** |
| Idempotency | **BLOCKED** |
| Reconciliation | **PASS** |
| Tenant isolation | **PASS** |

## Remaining HTTP 500 classification

Because Postman establishes `/deposit/process` as submit and AWS satisfies the documented request shape (aligned with working Lovable), the remaining failure is classified as **CheckAlt UAT IQA / image-acceptance behavior** on the synthetic non-negotiable payload.

Postman does **not** require a special photographic UAT fixture for process, and does **not** route submission through IRD or high-res retrieve.

Exact CheckAlt response observed on UAT:

> Check deposit processing failed. Please retake the check images and resubmit.

## Exact remaining action

1. Ask CheckAlt for UAT synthetic-image acceptance policy or an official UAT image kit / IQA guidance (do **not** submit restored production negotiable checks).
2. After an accepted deposit: status/history → idempotency → reconcile.

## Production remains OFF

```
AWS_PROVIDER_EXECUTION_ENABLED=false
AWS_CHECKALT_ENABLED=false
AWS_MOOV_ENABLED=false
AWS_FINANCIAL_PERMISSIONS_ACTIVATED=false
AWS_PLAID_ENABLED=false
```

Moov untouched. Production Supabase/Lovable CheckAlt untouched.

## Evidence

- `aws/providers/results/CheckAlt_PR125_Minimal_API.json`
- `aws/providers/results/checkalt_uat_certification_partial.json`
- `/opt/cursor/artifacts/checkalt_fincapture_doc_findings.json`
- `/opt/cursor/artifacts/checkalt_uat_prepare_pipeline_deposit.json`

## STOP FOR REVIEW — synthetic IQA (2026-09-05)

Reviewed and improved the **UAT-only** synthetic front/rear generator (readable written amount, clearer MICR-style band, rear ink endorsement). Production prepare pipeline unchanged.

Live CheckAlt UAT `POST /fincapture/deposit/process` with the improved pair still returned HTTP **500**:

> Check deposit processing failed. Please retake the check images and resubmit.

No provider reference. Status/history/idempotency **not** continued. See `aws/providers/results/checkalt_synthetic_iqa_review.md` and `checkalt_synthetic_iqa_stop.json`.

### Controlled IQA diagnostic matrix (same day)

One-variable UAT matrix against exact outbound JPEG/Base64 (not source-only):

| Test | Variable | HTTP | Outcome |
|---|---|---|---|
| A | improved pair, `performRiskAssessment: true` | 500 | retake images |
| B | **same image bytes**, `performRiskAssessment: false` | 500 | identical |
| C | same front, simplified rear (endorsement kept), risk `true` | 500 | identical |

Also verified: Base64 round-trip / JPEG reopen / no data-URI / no double encoding; AWS process field shape and prepare constants match Lovable (optional Postman name/email/limit fields omitted on both). Residual encoder note only: Lovable ImageScript vs AWS `jpeg-js` with the same numeric loop — **no smallest UAT-only field fix identified**.

**Verdict:** client-side diagnostics exhausted → sanitized escalation package for CheckAlt:

- `aws/providers/results/checkalt_iqa_diagnostic_matrix.json`
- `aws/providers/results/checkalt_iqa_escalation_package.md`
- `aws/providers/results/checkalt_iqa_matrix_stop.json`
- oneshot: `aws/providers/oneshots/checkalt-iqa-matrix.mjs`

**Do not merge PR #125.**


### Frozen risk A/B (same day, no image changes)

Re-used exact outbound improved JPEG bytes. `performRiskAssessment: true` and `false` both returned identical HTTP **500** (timestamp-only body difference). Base64 round-trip verified. AWS↔Lovable process fields and prepare constants match; no smallest UAT-only fix. Escalation: `checkalt_risk_ab_parity_escalation.md`, `checkalt_risk_ab_frozen.json`.

**Do not merge PR #125.**


### PR #130 Architecture A (2026-09-05) — continue #125, do not merge

Draft PR #130 found successful Lovable deposits use **Architecture A** (browser prepares/stores JPEG; backend Base64 only). AWS staging was updated to match. Offline parity vs successful Lovable prepared pairs: **8/8 byte-identical**. Prior jpeg-js re-encode was not identical.

One synthetic VOID UAT submit through corrected A path still returned CheckAlt HTTP **500** (AWS wrapper 502). Production writes: 0.

**Remaining measurable ChecksOps-controlled difference vs successful Lovable:** image content (synthetic VOID vs photographic/endorsed checks). Image pipeline + process payload gaps are closed. Do not resubmit historical/customer checks. Do not merge #125 or #130.

Evidence: `aws/providers/results/checkalt_pr130_architecture_a_review.md`, `checkalt_pr130_evidence_summary.json`.

### Known-good CheckAlt `120846345` forensic (2026-09-05) — STOP FOR REVIEW

Provider portal confirmed Accepted transaction **`120846345`** (2026-08-31, **$3,802.10**). Read-only forensic only — **not resubmitted**.

| Mapping | Value |
|---|---|
| ChecksOps deposit | `e630c449-48b3-4b92-8585-8a24421c600c` |
| Fingerprint | `ed9b7609164ba6f0` (**first of PR #130 offline 8/8**) |
| Check intake item | `76ead31d-25ec-436c-b1f4-1e86dc05fc42` |
| Prep path | front `reuse_cache` 1600×796 / 245945B; back `browser_reencode` 1200×583 / 109522B (`.deposit2.jpg`) |
| AWS #130 Architecture A | **byte-identical** front+back offline; **reproduces this known-good processing/request path** |

Measurable differences vs rejected synthetic VOID UAT remain **image content**, **CheckAlt env (prod vs UAT)**, and **amount/dims** — not a pipeline/process-key gap.

**Do not merge #125 or #130. Do not submit another CheckAlt deposit. Do not make speculative IQA changes.**

Evidence: `aws/providers/results/checkalt_known_good_120846345_forensic.md`, `.json`, `_stop.json`.


### PR #130 merge readiness (2026-09-05) — STOP FOR REVIEW

Final code/safety review of draft PR #130: **MERGE #130: YES** with production CheckAlt/provider/financial flags remaining OFF. Synthetic VOID UAT 500 stays a separate #125 certification limitation — do not change Architecture A to chase it.

After #130 merges: keep #125 open as UAT evidence; rebase when convenient; do **not** supersede/close #125 for certification; do **not** merge #125 yet.

**Do not merge #125 or #130 in this turn. No further CheckAlt submission.**

Evidence: `aws/providers/results/checkalt_pr130_merge_readiness.md`, `.json`.
