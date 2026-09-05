# CheckAlt Postman/OpenAPI review (uploaded Reduced collection)

**Date:** 2026-09-05  
**Source reviewed:** `CheckAlt_Cursor_Reduced_ce88.json` (reduced Clearingworks IR Postman collection; responses/examples omitted)  
**Compared to:** PR #125 `processBody` → `POST /fincapture/deposit/process`  
**Production / provider flags / credentials / webhooks:** unchanged

## Direct submission endpoint

| Question | Answer |
|---|---|
| Is `/fincapture/deposit/process` the direct deposit submit path? | **YES** |
| Documented name | `FinCapture Deposits > Submit deposit transaction` |
| Method / path | `POST /fincapture/deposit/process` |
| Documented purpose | `POST FinCaptureAPIDepositRequest` with FI key, depositor account, images, and amounts. Validates the user is registered for deposit and the account belongs to the biller. |

Related FinCapture deposit endpoints in the same collection are **post-submit / workflow**, not alternate submit paths:

- `POST /fincapture/deposit/approve` — approve/reject an existing deposit
- `POST /fincapture/deposit/item` — get deposit by reference
- `POST /fincapture/deposit/history` — history
- `POST /fincapture/deposit/queryDeposits` — search

Clearingworks `cw/deposits/*`, `cw/depositApprovals/*`, and Scan site-assignment APIs are separate products/flows — **not** FinCapture mobile/API deposit submit.

## Documented request fields vs PR #125

Documented sample body keys for `/fincapture/deposit/process`:

`fiKey`, `ssoKey`, `firstName`, `lastName`, `emailAddress`, `captureDateTime`, `depositAccountNumber`, `dailyDepositLimit`, `userAmount`, `frontImage`, `rearImage`, `performRiskAssessment`

PR #125 sends:

`fiKey`, `ssoKey`, `depositAccountNumber`, `captureDateTime`, `userAmount`, `performRiskAssessment`, `frontImage`, `rearImage` (rear omitted only if unavailable)

| Field | In docs sample | In PR #125 request | Notes |
|---|---|---|---|
| `fiKey` | yes | yes | Match |
| `ssoKey` | yes | yes | Depositor identity (registered FinCapture user) |
| Depositor info | sample also has `firstName`/`lastName`/`emailAddress` | via prior `/fincapture/useraccount/register` + `ssoKey` on process | Sample fields; description does **not** mark them required on process |
| `depositAccountNumber` | yes | yes | Match |
| `userAmount` | yes | yes | Integer cents (existing PR formatting) |
| `frontImage` / `rearImage` | yes (type `string`) | yes (base64 strings) | Docs give no encoding/format schema beyond string |
| `performRiskAssessment` | yes (`false` in sample) | yes (`true`) | Boolean present; sample value is illustrative |
| `captureDateTime` | yes | yes | Match |
| `dailyDepositLimit` | yes in sample | not sent on process | Not stated as required on process; limits come from account APIs |

**No concrete required-field mismatch** between the documented FinCapture submit contract and the PR #125 process payload.

## Image / IQA / DPI / fixture requirements in this collection

Searched the uploaded collection for IQA, image quality, DPI, resolution, JPEG/JPG/PNG, compression, dimensions, pixels, width/height, bitonal, grayscale, photographic fixtures, test-image kits, upload, and preprocess.

| Topic | Present for `/fincapture/deposit/process`? |
|---|---|
| IQA / image-quality rules | **No** |
| DPI / resolution / dimensions | **No** |
| JPEG/PNG/TIFF format mandate on process | **No** (`frontImage`/`rearImage` are opaque strings) |
| Compression limits | **No** |
| Photographic UAT fixture requirement | **No** |
| Separate image preprocess/upload step before process | **No** |

`TIFF` / `imageFormat` / `base64ImageData` appear only on **Clearingworks** payloads (deposit approvals / `cw/deposits/depositPayment`) and IRD-style transaction items — **not** on FinCapture `/deposit/process`.

## Preprocessing / upload step?

**None documented** for FinCapture deposit submit. Images are inline on `/fincapture/deposit/process`. Registration (`/fincapture/useraccount/register`) is a prerequisite for depositor eligibility, which PR #125 already performs before process.

## Verdict

1. **Concrete implementation ↔ documentation mismatches:** none that require a code change for `/fincapture/deposit/process`.
2. **Documented image requirements currently violated:** **none** in this collection (no DPI/IQA/format/fixture rules stated for process).
3. **`/fincapture/deposit/process` confirmed as direct submission endpoint:** **YES**.
4. **Another documented preprocessing/upload step:** **NO**.
5. **PR #125 action:** **leave implementation unchanged**; remain **PARTIAL / waiting on CheckAlt UAT IQA / image-acceptance guidance** (live UAT still returns the provider message to retake check images). Do **not** invent photographic fixture requirements from this Postman file. Do **not** merge as full UAT PASS. Do **not** submit real customer/negotiable checks.
