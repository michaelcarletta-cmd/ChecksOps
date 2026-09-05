# CheckAlt UAT — sanitized IQA escalation package (PR #125)

**Date:** 2026-09-05  
**Audience:** CheckAlt support / UAT operations  
**Environment:** `uatapi.checkalt.com` only  
**Images:** synthetic / non-negotiable VOID fixtures only (no real or negotiable checks)  
**Secrets:** intentionally omitted (`fiKey`, `ssoKey`, credentials, account numbers, merchant secrets)

## Summary

Client-side diagnostics against `POST /fincapture/deposit/process` are exhausted. Authentication, depositor register, and deposit-account binding succeed. Controlled image/payload matrix still returns identical HTTP **500** IQA-style reject with no deposit reference.

## Endpoint

- **Host:** `uatapi.checkalt.com`
- **Method/path:** `POST /fincapture/deposit/process`
- **Auth path used:** `POST /public/fincapture/authenticate` → HTTP 200

## Timestamps (UTC)

| Test | Client started | Client ended | CheckAlt `timestamp` |
|---|---|---|---|
| A — improved pair, `performRiskAssessment: true` | 2026-09-05T13:13:44.879Z | 2026-09-05T13:13:47.046Z | 2026-09-05T13:13:47.024612424Z |
| B — same bytes, `performRiskAssessment: false` | 2026-09-05T13:13:47.048Z | 2026-09-05T13:13:49.187Z | 2026-09-05T13:13:49.164433433Z |
| C — same front, simplified rear, risk `true` | 2026-09-05T13:13:49.189Z | 2026-09-05T13:13:51.515Z | 2026-09-05T13:13:51.493883957Z |

Full matrix: `checkalt_iqa_diagnostic_matrix.json`.

## HTTP status and sanitized response (every test)

All three controlled tests:

- **HTTP status:** `500`
- **Provider body keys:** `error`, `message`, `status`, `timestamp`
- **Sanitized body:**
  - `status`: `500`
  - `error`: `Internal Server Error`
  - `message`: `Check deposit processing failed. Please retake the check images and resubmit.`
  - `timestamp`: CheckAlt-generated (recorded in matrix JSON)
- **Reference / correlation:** none returned (`referencePresent: false`)

## Image dimensions / format (exact outbound bytes)

Inspected **after** Base64 serialization of the HTTP body fields (decode → hash → JPEG reopen), not only the source generator:

| Side | Dimensions | Format | Mode | Bytes | Notes |
|---|---|---|---|---|---|
| Front (A/B/C) | 1600×733 | JPEG (JFIF) | RGB | 179129 | landscape; magic `ffd8ff` |
| Rear (A/B) | 1600×733 | JPEG (JFIF) | RGB | 150243 | same SHA across A and B |
| Rear simplified (C) | 1600×733 | JPEG (JFIF) | RGB | 88810 | endorsement band retained; rest flattened |

Base64 round-trip checks:

- no `data:image/...;base64,` prefix
- no double encoding
- `Buffer.from(b64,'base64').toString('base64')` matches outbound string
- JPEG decode OK

## Request field names sent

`fiKey`, `ssoKey`, `depositAccountNumber`, `captureDateTime`, `userAmount`, `frontImage`, `rearImage`, `performRiskAssessment`

Optional Postman sample fields **not** sent (matches working Lovable production submit): `firstName`, `lastName`, `emailAddress`, `dailyDepositLimit`.

`userAmount` for matrix: integer `1` (1 cent), matching synthetic image amount.

## `performRiskAssessment` results

| Value | HTTP | Message |
|---|---|---|
| `true` (test A) | 500 | retake images / resubmit |
| `false` (test B) | 500 | identical message |

**Outcome unchanged.** Cannot isolate a distinct risk/IQA stage from client-visible response (no risk-stage detail keys returned).

## Prior stages that already pass

| Stage | Result |
|---|---|
| Authenticate | PASS (HTTP 200) |
| Register FinCapture depositor | PASS (HTTP 200) |
| Deposit account binding / discovery | PASS |
| Image prepare constants vs Lovable | MATCH (1600 / q78→35 / min 1300 / 450KB) |
| Process request field shape vs Lovable | MATCH |

## Client-side residual note (not a field gap)

AWS Node prepare uses `jpeg-js`; Lovable edge prepare uses ImageScript. Numeric resize/quality/budget loop matches. Process body fields match Lovable. No smallest UAT-only field flip identified; optional Postman fields are omitted on both sides.

## Ask for CheckAlt

1. Confirm whether UAT FinCapture IQA accepts non-negotiable / VOID synthetic images at all.
2. Provide an official UAT image kit or documented IQA acceptance criteria for synthetic RDC testing.
3. If possible, return a more specific IQA reject code/stage in the process response (current body is generic 500).

## Machine-readable companion

`aws/providers/results/checkalt_iqa_diagnostic_matrix.json`


## Frozen risk A/B addendum (2026-09-05T15:15Z)

Exact improved outbound JPEG bytes (no regenerate) re-submitted:

| performRiskAssessment | HTTP | Sanitized message |
|---|---|---|
| true | 500 | Check deposit processing failed. Please retake the check images and resubmit. |
| false | 500 | identical (timestamp only differed) |

Base64 of transmitted fields: decode → same SHA-256 as frozen files; JPEG 1600×733; no data-URI; no double encoding.

AWS process field set and prepare constants match Lovable. Residual diffs (synthetic source; ImageScript vs jpeg-js encoder) do not yield a smallest UAT-only field flip.

Client diagnostics exhausted. Escalate to CheckAlt for UAT synthetic/VOID IQA policy.
