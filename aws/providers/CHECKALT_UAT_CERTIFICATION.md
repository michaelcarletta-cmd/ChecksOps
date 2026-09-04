# CheckAlt UAT certification (AWS staging)

**Date:** 2026-09-04  
**Branch:** `cursor/staging-checkalt-uat-cert-c8f0`  
**PR:** #125  
**Scope:** CheckAlt UAT certification only — not production activation.  
**Moov:** Sandbox certification remains **PASS** (PR #124). Moov implementation was **not** modified.  
**Verdict:** **PARTIAL** — STOP for review

## Documentation authority (this pass)

| Source | Status |
|---|---|
| CheckAlt-supplied FinCapture Postman / `ClearingworksAPI.yaml` file | **Not present** in this Cloud Agent workspace, PR tree, or message attachments. Upload requested. |
| In-repo Lovable reference citing the OpenAPI | Present — `supabase/functions/_shared/checkalt.ts` states: *API reference: Clearingworks IR OpenAPI 3.1 spec (`ClearingworksAPI.yaml`)* and maps Auth / Deposit / Status / Approve / History |
| Prior user-confirmed FinCapture workflow | Authenticate → register → getUserAccountInformation → getDepositAccountInformation → deposit item/process → history/status |
| Live UAT API responses from earlier #125 runs | Auth/register/account discovery PASS; `POST /fincapture/deposit/process` reached; HTTP 500 body: *"Check deposit processing failed. Please retake the check images and resubmit."* |
| CheckAlt public developer portal | `developer.checkalt.com` requires authenticated access (JS/OpenAPI assets 403 without login) |

This pass does **not** invent a “photographic UAT fixture” requirement. No available CheckAlt document states that. Classification of the 500 is from the **API response text** + confirmation that the documented submission sequence/fields are already satisfied.

## Documented FinCapture sequence vs implementations

| Step / operation | Documented role (Lovable + user workflow + OpenAPI citations) | Lovable/Supabase (production working path) | AWS #125 UAT |
|---|---|---|---|
| `POST /public/fincapture/authenticate` | Auth → JWT | Used | Used (UAT host) |
| `POST /fincapture/useraccount/register` | Create depositor; then discover `ssoKey` | Used | Used (sandbox-isolated) |
| `POST …/getUserAccountInformation` | Account list / `ssoKey` | Used | Used |
| `POST …/getDepositAccountInformation` | Authorize deposit account | Used | Used |
| **`POST /fincapture/deposit/process`** | **Direct deposit submission** (front/rear images + amount) | **Only submit path** | **Only submit path** |
| `POST /fincapture/deposit/approve` | **Post-process** approval when status 40 | After successful process | Parity route exists; not a pre-process gate |
| `POST /fincapture/deposit/item` | Status of an existing reference | Poll after process | Parity / sandbox status after process |
| `POST /fincapture/deposit/history` | History / status fallback | Poll fallback | Available |
| Retrieve Transaction with High-Resolution Images | **Post-transaction retrieval** of images for an existing transaction | **Not** used in submit | **Not** used (must not be used as a substitute for submit) |
| Generate Image Replacement Document (IRD) | **Post-transaction / output** (substitute-check / IRD generation for an existing item) | **Not** used in submit | **Not** used |

### IRD / High-Resolution classification

- **Not part of deposit submission.** Working Lovable never calls them before or instead of `/deposit/process`.
- Names and banking practice: high-resolution retrieve and IRD generation operate on an **existing** transaction/reference; they are retrieval/output, not capture.
- **Do not call them** merely because they mention images. Pending vendor Postman file for path/field confirmation only.

### Required `/deposit/process` fields (parity preserved)

| Field | Lovable | AWS #125 UAT |
|---|---|---|
| `fiKey` | yes | yes |
| `ssoKey` | yes (never API login) | yes |
| `depositAccountNumber` | yes | yes (API-discovered) |
| `captureDateTime` | ISO | ISO |
| `userAmount` | integer cents | integer cents (`1` for $0.01) |
| `frontImage` / `rearImage` | raw base64, prepare pipeline | raw base64 via same prepare pipeline |
| `performRiskAssessment` | `true` | `true` |
| `testDeposit` | absent | absent |

No documented pre-process “transaction create”, separate image-upload, or deposit-item step is missing from AWS relative to Lovable.

**Finding:** `/fincapture/deposit/process` is the correct direct submission endpoint. Documented request requirements exercised by Lovable are present on AWS UAT.

## Scorecard

| Area | Result |
|---|---|
| Authentication | **PASS** |
| Merchant / FI context | **PASS** |
| Deposit-account binding | **PASS** |
| Depositor / ssoKey | **PASS** |
| Image pipeline parity (Lovable) | **PASS** |
| FinCapture sequence / required fields | **PASS** (matches Lovable + documented workflow; no missing submit step found) |
| UAT submission | **PARTIAL** — process reached; CheckAlt HTTP 500 IQA message; no provider reference |
| Status / history | **BLOCKED** (no accepted reference) |
| Callback / webhook | **N/A** |
| Idempotency | **BLOCKED** |
| Reconciliation | **PASS** (report-only) |
| Tenant isolation | **PASS** |

## Remaining 500 classification

Because the documented submission endpoint and required fields are satisfied, the remaining failure is classified as **CheckAlt UAT IQA / image-acceptance behavior** on the synthetic non-negotiable payload — evidenced by CheckAlt’s own response:

> Check deposit processing failed. Please retake the check images and resubmit.

That message does **not**, by itself, establish a requirement for a special photographic UAT fixture in vendor documentation (Postman/OpenAPI file still not available to this agent). It does establish that CheckAlt rejected the submitted images after accepting the request shape enough to run image processing.

Safe next steps (do **not** submit restored production negotiable checks):

1. Attach the CheckAlt FinCapture Postman / `ClearingworksAPI.yaml` to this run for final IRD/high-res path confirmation.
2. Ask CheckAlt whether UAT accepts synthetic/non-negotiable images, or provide an official UAT image kit / IQA guidance.
3. After an accepted deposit: status/history → idempotency → reconcile.

## Production remains OFF

```
AWS_PROVIDER_EXECUTION_ENABLED=false
AWS_CHECKALT_ENABLED=false
AWS_MOOV_ENABLED=false
AWS_FINANCIAL_PERMISSIONS_ACTIVATED=false
AWS_PLAID_ENABLED=false
```

Moov untouched. Production Supabase/Lovable CheckAlt untouched. No DNS / production webhook / financial-activation changes.

## Evidence

- `aws/providers/results/checkalt_uat_certification_partial.json`
- `/opt/cursor/artifacts/checkalt_uat_prepare_pipeline_deposit.json`
- `/opt/cursor/artifacts/checkalt_image_parity_diff.json`
- `/opt/cursor/artifacts/checkalt_fincapture_doc_findings.json`
