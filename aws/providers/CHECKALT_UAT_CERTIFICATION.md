# CheckAlt UAT certification (AWS staging)

**Date:** 2026-09-04  
**Branch:** `cursor/staging-checkalt-uat-cert-c8f0`  
**PR:** #125  
**Scope:** CheckAlt UAT certification only — not production activation.  
**Moov:** Sandbox certification remains **PASS** (PR #124). Moov implementation was **not** modified.  
**Verdict:** **PARTIAL** — STOP for review

## Authoritative assumptions

1. Webhooks are **not** required (`CHECKALT_SANDBOX_WEBHOOK_SECRET` is not a blocker).
2. FinCapture workflow: authenticate → register → `getUserAccountInformation` → `getDepositAccountInformation` → deposit process → history/status.
3. Freedom Adjustment is a provisioned UAT business unit; use API/config values only.
4. Do not use sample `123456789` unless UAT API returns it.
5. Image/submission behavior must match the working Lovable/Supabase path — do not invent a new CheckAlt image strategy.

## Parity vs Lovable/Supabase (verified)

| Concern | Lovable reference | AWS UAT after this PR |
|---|---|---|
| Landscape / orientation | `ensureLandscape` + prepare `rotate(90)` | `browserCapToDepositTarget` + `normalizeToBudget` |
| Target max dim | 1600 (`prepareCheckAltDeposit` / prepare-image) | 1600 |
| Min acceptable dim | 1300 (browser cache gate) | 1300 (prepare constants) |
| JPEG quality ladder | prepare-image 78→35 | same |
| Per-image budget | 450KB | 450KB |
| Combined base64 limit | 1_600_000 | 1_600_000 |
| Raw base64 (no data-URI) | yes | yes |
| SVG back rejection | yes | unchanged in parity submit path |
| `fiKey` / `ssoKey` / `depositAccountNumber` / `captureDateTime` | yes | yes |
| `performRiskAssessment` | `true` | `true` (was incorrectly `false`) |
| `testDeposit` | absent | absent (removed) |
| `userAmount` | `Math.round(dollars * 100)` integer cents | same integer-cents adapter |

UAT sandbox deposits now build a synthetic VOID raster and run **`browserCapToDepositTarget` → `normalizeToBudget`** — the same constants as `checkalt-prepare-image` / `prepareCheckAltDeposit`.

## Scorecard

| Area | Result |
|---|---|
| Authentication | **PASS** |
| Merchant / FI context | **PASS** |
| Deposit-account binding | **PASS** (API `31…73` / fp `46bed6e573bb`) |
| Depositor / ssoKey | **PASS** (UAT register; FI login not used as ssoKey) |
| Image pipeline parity | **PASS** (1600×733 landscape JPEG via prepare pipeline; ≤450KB; raw base64; riskAssessment true; no testDeposit) |
| UAT submission | **PARTIAL** — CheckAlt HTTP 500 IQA: *"Please retake the check images and resubmit."* No provider reference; negotiableCheckSubmitted=false |
| Status / history | **BLOCKED** (no accepted deposit reference) |
| Callback / webhook | **N/A** |
| Idempotency | **BLOCKED** (success path not reached) |
| Reconciliation | **PASS** (report-only) |
| Tenant isolation | **PASS** (C1C → `404 operation_not_found`) |

## Why IQA still fails (precise remaining difference)

Encoding/dimension/budget/field parity is aligned. CheckAlt still rejects because the **pixel content** is not a photographic check.

Compared a restored Freedom check already `status=deposited` (inspected only — **not** submitted to UAT):

| | Lovable deposited example | AWS UAT synthetic fixture |
|---|---|---|
| Content | Camera JPEG of a real check + endorsed deposit back | Procedural geometric VOID + bitmap-font labels |
| Raw front | 4265×2052 (~2.3MB) | Drawn 1920×880 then capped |
| Prepared front | 1600×770 JPEG (~286KB) | 1600×733 JPEG (~110KB) |
| Back | Approved endorsed-deposit JPEG (1200×576) | Synthetic drawn rear (1600×733) |
| Host that accepted it | Production CheckAlt (Lovable) | UAT `uatapi.checkalt.com` (rejected) |

Shared after prepare: landscape, JPEG, raw base64, ≤450KB/side, `performRiskAssessment: true`, integer-cent `userAmount`, no data-URI, no `testDeposit`.

**Remaining gap is not pipeline constants — it is photographic / endorsed check imagery (or a CheckAlt-provided UAT image kit).** Using restored production check images for UAT would submit negotiable instruments; that is refused by this certification.

## Exact remaining action

1. Obtain CheckAlt-acceptable **UAT** check image fixtures (vendor UAT kit), **or** a documented UAT IQA bypass — without copying production negotiable checks into UAT submit.
2. Then: process → provider reference → status/history → idempotency → reconcile.

## Production remains OFF

```
AWS_PROVIDER_EXECUTION_ENABLED=false
AWS_CHECKALT_ENABLED=false
AWS_MOOV_ENABLED=false
AWS_FINANCIAL_PERMISSIONS_ACTIVATED=false
AWS_PLAID_ENABLED=false
```

Moov untouched. Production Supabase CheckAlt untouched. No financial activation grants.

## Evidence

- `aws/providers/results/checkalt_uat_certification_partial.json`
- `/opt/cursor/artifacts/checkalt_uat_prepare_pipeline_deposit.json`
- `/opt/cursor/artifacts/checkalt_image_parity_diff.json`
