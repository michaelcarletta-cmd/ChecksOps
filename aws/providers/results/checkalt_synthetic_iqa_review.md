# CheckAlt UAT synthetic image IQA review (PR #125)

**Date:** 2026-09-05  
**Branch:** `cursor/staging-checkalt-uat-cert-c8f0`  
**Scope:** Review / improve **UAT-only** synthetic front/rear generator. **No** production image pipeline changes.  
**Verdict:** **STOP FOR REVIEW** — improved synthetic pair still rejected by CheckAlt UAT IQA (HTTP 500).

## What was reviewed (existing generator)

Reviewed `buildSyntheticUatCheckSource` / `prepareSyntheticUatDepositImages` in `parity/checkalt-image.mjs` and prepared JPEG output only.

| Mobile-RDC checklist item | Before | Notes |
|---|---|---|
| Realistic check proportions | OK | ~6×2.75 aspect (source 1920×880 → prepared 1600×733) |
| Readable MICR-style routing/account/check near bottom | Weak | ASCII `A`/`C` placeholders + crude 5×7 glyphs; missing `J` broke “ADJUSTMENT” |
| Readable numeric + written amount consistent with `userAmount` | Weak | Numeric `$0.01` only; **no written amount line** |
| Nonblank rear with realistic simulated endorsement | Weak | Printed “FOR DEPOSIT ONLY” only; no ink scribble |
| Adequate JPEG clarity without excessive compression | OK | Prepared ~112KB / ~98KB JPEG, raw base64, no `data:` prefix |
| Clean Base64 (no data-URI) | OK | `/9j…` JPEG magic |

Unverified hypotheses (**not** treated as CheckAlt specs): 1200×570, 75–85% JPEG, mandatory E-13B, specific endorsement wording, particular DPI. Those were **not** hardcoded as requirements.

## UAT-only generator changes (non-production)

Updated **synthetic UAT source raster only** (still runs through unchanged production prepare constants: landscape, 1600 max, JPEG 78→35, MIN_DIM 1300, 450KB):

- Higher source resolution (2200×1008), paper grain + soft vignette
- Written amount line matching `userAmount` cents (`ZERO AND 01/100`)
- Date, memo, signature scribble on front
- Clearer MICR-style digit band + geometric transit/on-us markers (not claimed as E-13B)
- Fake all-zero routing/account digits only (not usable live bank numbers)
- Rear: simulated ink endorsement + VOID / non-negotiable labels
- Missing glyphs (`J`, etc.) restored
- `amountCents` wired through prepare → deposit body so image amount tracks `userAmount`

**Not changed:** `normalizeToBudget` / production prepare loop, CheckAlt production config, credentials, webhooks, provider flags, production execution.

## Live CheckAlt UAT result (single improved attempt)

| Step | Result |
|---|---|
| Auth `POST /public/fincapture/authenticate` | PASS |
| Discover deposit account via UAT account APIs | PASS (redacted `31…73`) |
| Register UAT-only FinCapture depositor (not API login) | PASS |
| `POST /fincapture/deposit/process` with improved synthetic front/rear | **FAIL** HTTP **500** |

Exact provider message:

> Check deposit processing failed. Please retake the check images and resubmit.

- No provider reference returned  
- Raw JPEG base64 (no data-URI)  
- Prepared front 1600×733 / 179129 bytes; rear 1600×733 / 150243 bytes  
- `userAmount` = 1 (integer cents); image amounts match  
- Negotiable / real customer check: **not** submitted  
- Production flags: untouched / remain OFF  

Evidence: `/opt/cursor/artifacts/checkalt_improved_synthetic_uat_result.json`

## Classification

Obvious synthetic deficiencies were addressed. CheckAlt UAT still returns the same IQA-style HTTP 500. Further guessing at undocumented CheckAlt image requirements is **stopped**.

Remaining action for humans / CheckAlt: obtain UAT synthetic-image acceptance policy or an official UAT image kit. Do **not** submit restored production negotiable checks.

## Scorecard impact

| Area | Result |
|---|---|
| UAT submission (improved synthetic) | **FAIL** — IQA HTTP 500; no reference |
| Status / history / idempotency | **BLOCKED** (no accepted reference) — **not** continued |
| Production | Remains OFF |

## STOP FOR REVIEW

Do **not** merge PR #125. Do **not** iterate further undocumented image tweaks in this pass.
