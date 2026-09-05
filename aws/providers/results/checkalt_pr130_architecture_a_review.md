# CheckAlt UAT certification — PR #130 Architecture A evidence (continuation of #125)

**Date:** 2026-09-05  
**Context:** PR #125 UAT certification continued after draft PR #130  
**STOP FOR REVIEW — do not merge #125 or #130 — no further CheckAlt submission**

## What #130 established

Successful Lovable CheckAlt deposits use **Architecture A**:

1. Browser `prepareCheckAltDeposit` (EXIF / landscape, 1600px, 450KB, quality 0.80→0.62→0.50→0.38; already-good JPEG pass-through; 1200px endorsed rears are browser-re-encoded because they fail the ≥1300 rule)
2. `checkalt-submit-deposit` downloads those **stored** bytes and Base64-encodes them — **no second encode**
3. Client-supplied `frontImage` / `rearImage` are ignored

AWS staging was updated to match A (`imagePipeline: browser_prepare_aws_base64`). Sharp was **not** shipped (x64 Sharp crashed linux-arm64 Lambda). Architecture B (server jpeg-js / ImageScript clone on submit) is **not** the production path.

### Offline regression (no CheckAlt HTTP)

| Metric | Result |
|---|---|
| Lovable `submitted` deposits with refs + pairs (staging copy) | 42 |
| Sampled complete pairs | **8/8** |
| AWS A Base64 of stored prepared object vs Lovable prepared bytes | **byte-identical** (orientation, JPEG magic, dims, size, Base64) |
| Prior jpeg-js re-encode of same originals | **not** identical (e.g. front 245945B Lovable vs 273457B jpeg-js) |

Sample path decisions:

- Fronts: `reuse_cache` (`.deposit2.jpg`) or `browser_reencode`
- Backs: mostly `browser_reencode` of 1200px endorsed JPEGs; one `passthrough_original`

### Staging deploy + synthetic UAT (already performed in #130)

- `UpdateFunctionCode` on staging API only; `/health` ok; `productionSupabaseChanged: false`
- Production flags remain **OFF** (`AWS_CHECKALT_ENABLED=false`, `AWS_PROVIDER_EXECUTION_ENABLED=false`, `AWS_FINANCIAL_PERMISSIONS_ACTIVATED=false`)
- One non-negotiable synthetic VOID submit through corrected A path:
  - Front 1600×700 / 60162B; back 1400×650 / 54414B; already-good pass-through
  - Injected client image ignored
  - CheckAlt HTTP **500**; AWS wrapper **502**; not accepted
  - Production `checkalt_deposits` writes: **0**; no historical resubmit

## Measurable ChecksOps-controlled differences remaining?

Compared: successful Lovable deposits (offline byte identity under Architecture A) vs rejected synthetic UAT (Architecture A, still HTTP 500).

| Area | Successful Lovable | Rejected synthetic UAT (#130) | ChecksOps-controlled? | Still a pipeline gap? |
|---|---|---|---|---|
| Submit image path | Browser prepared → Base64 only | Same (`browser_prepare_aws_base64`) | Yes | **No** — fixed by #130 |
| Stored-byte Base64 identity | N/A (source of truth) | Offline 8/8 identical on real prepared pairs | Yes | **No** |
| Process body fields | `fiKey`, `ssoKey`, `depositAccountNumber`, `captureDateTime`, `userAmount`, `frontImage`, `rearImage`, `performRiskAssessment` | Same builder / same keys | Yes | **No** |
| Optional Postman depositor fields | Omitted | Omitted | Yes | **No** |
| Second JPEG encode on submit | None | None (client bytes ignored) | Yes | **No** |
| Image **content** | Photographic check fronts; real endorsed backs (often 1200px → browser `.deposit2.jpg`) | Synthetic VOID / non-negotiable geometric JPEGs | Yes (what we choose to upload) | **Yes — only remaining ChecksOps-controlled differentiator we can measure without customer checks** |
| CheckAlt environment / FI credentials | Production Lovable accepts these photos | UAT host + UAT FI | Yes (which env we target) | Environmental — not an image-pipeline bug |
| Amount vs OCR | Real dollar amounts matching check face | $0.01 synthetic | Yes | Possible secondary factor; observed error is retake-images / IQA-style 500, not amount-mismatch text |

### Verdict

After #130, **no measurable ChecksOps-controlled image-pipeline or process-payload gap remains** between successful Lovable submissions and the AWS Architecture A path (proven by offline 8/8 byte identity on real prepared pairs).

The synthetic UAT 500 therefore is **not** explained by AWS re-encoding. The only clear ChecksOps-controlled difference still present in the rejected attempt is **image content** (synthetic VOID vs real photographic / endorsed check imagery). We must **not** resubmit historical or customer checks to prove that. Environment (UAT vs production CheckAlt) is a separate non-pipeline factor.

Further undocumented MICR / endorsement / DPI guessing is not justified. Escalate to CheckAlt for UAT synthetic/VOID acceptance policy or an official UAT image kit.

## Relation to #125 prior work

#125 already showed:

- Risk `true`/`false` identical 500 on frozen synthetic bytes
- Base64 round-trip / no data-URI / no double encoding
- Prepare constants matched Lovable prepare-image edge; residual encoder note only

#130 supersedes the encoder concern for the **submit** path: production/Lovable success does not re-encode on submit at all. Offline A parity closes that gap. Synthetic rejection persists.

## Safety / stop

- Do **not** merge PR #125
- Do **not** merge PR #130
- Do **not** submit another CheckAlt deposit until reviewed
- Production provider/financial flags remain OFF
- No historical/customer checks

## Evidence pointers

- PR #130 body + commits on `cursor/checkalt-lovable-parity-3a4a`
- `/opt/cursor/artifacts/checkalt_pr130_evidence_summary.json`
- Prior #125: `checkalt_risk_ab_frozen.json`, `checkalt_iqa_escalation_package.md`
