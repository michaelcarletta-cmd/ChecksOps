# Phase 3 Functional Audit — resume on Integration Validated Baseline (2026-09-14)

**Date:** 2026-09-14  
**Workstream:** Functional Audit (`bc-c48d261b-22b3-481c-a28f-ddf0189e3bce`)  
**Inventory baseline:** #291 `cursor/phase2-integration-inventory-3bce` @ `b941ba9b4` (not reset)  
**Authoritative physical-testing pin:** Integration Validated Baseline dated 2026-09-14  
**Do not compare staging to PR #288 or the former Phase 2 SHA/SPA.**  
**Do not begin Phase 4.**

## Pin (MATCH — not INTEGRATION_BASELINE_DRIFT)

| Surface | Expected | Live this turn |
|---|---|---|
| Lambda `checksops-staging-api` CodeSha256 | `OSiyHTQqSq5J3QRZCKdDrQ7PRW5qPWeJS71LZ46LIOE=` | **MATCH** |
| SPA `index.html` ETag | `113dfd26211290d0be78377d4b8e1ee2` | **MATCH** |
| SPA JS/CSS | `index-a512Q1W0.js` / `index-67D8chGr.css` | **MATCH** |
| SQL apply inventory | `29 → 52 → 39 → 69 → 71 → 72 → 73` | not modified |
| SQL 30 | intentionally unapplied | not applied |
| SQL 72 / 73 fingerprints | `445994fc…` / `d388bb4e…` | not re-hashed this turn |
| Provider execution | OFF | `AWS_PROVIDER_EXECUTION_ENABLED=false` |
| CheckAlt / Moov | disabled | both `false` |
| Application writes | on | `true` |
| Endorsement email E2E | PASS and CLOSED | not repeated |

Evidence: `/opt/cursor/artifacts/phase3_validated_baseline_pin.json`.

This workstream did **not** deploy, restore, overlay, or modify Lambda, SPA, CloudFront, SQL/RLS/GRANTs, staging env, Cognito identities, production, or production-prep.

## Inventory movement

| Metric | Start | End |
|---|---:|---:|
| Discovered | 1,421 | 1,421 |
| N/A | 285 | 285 |
| Live/non-N/A | 1,136 | 1,136 |
| PASS | 714 | **714** |
| FAIL | 1 (`A8-035`) | **1** (`A8-035`) |
| INTERNAL BLOCKED | 248 | **247** |
| EXTERNAL BLOCKED | 173 | **173** |
| AWAITING_INTEGRATION_DEPLOYMENT | 0 | **1** (`A5-203`) |
| Operational PASS | 62.9% | **62.9%** (714 / 1,136) |

Newly PASS: **none** (no mapped authenticated SPA session; no invented PASS).

INTERNAL vs EXTERNAL taxonomy unchanged: EXTERNAL = `BLOCKED_PROVIDER` + `BLOCKED_EMAIL_EXTERNAL` + `BLOCKED_EMAIL_OTP` + `BLOCKED_IDENTITY`. INTERNAL = remaining BLOCKED.

## Attack order results

### 1. A5-201–204 C1C settlement / ledger

Retained fixture **not modified**: claim `266e1ae8-ec20-4ed5-9243-3e1424304ec6` (`AWS-PR235-LEDGER-TEST-B`), settlement `783788b8-13d8-44c8-97a2-9dc794dd29df`, intake `de3ba0a9-4edb-4451-94c0-c43a1f4c454f`. Do not run `23_claims_org_backfill.sql`.

**A5-203 Save All Categories — application defect, Git-fixed, not deployed**

Live `CheckCommandCenter-BZtZu8ed.js` contains `Save All Categories` / `claim_settlements`. Live main client `index-a512Q1W0.js` does **not** list `claim_settlements` in `AWS_WRITE_TABLES`, so AWS-mode writes fail closed with `writes_disabled` before `/data/write`. Live Lambda `write-app-metadata.mjs` has no `claim_settlements` executor.

Git remediation (do **not** deploy from this workstream):

- PR **#309** `cursor/phase3-a5-settlement-write-3bce` @ `906c8afa6`
- Base: `cursor/public-endorsement-rpc-ec26`
- Tranche-6 insert/update, tenant via `claims.org_id` **or** linked `check_intake_items.tenant_id`, reject negatives, ignore client `created_by`, refuse `claim_id` retarget, no delete
- SPA `AWS_WRITE_TABLES` includes `claim_settlements` (missing even on PR #277)
- SQL 40 GRANT file is Git-only. **Do not apply.** Prior inspect already had settlement INSERT/UPDATE GRANTs.

Local tests: `node --test aws/tests/app-metadata-writes.test.mjs` 11 pass; `aws/tests/api-write.test.mjs` 19 pass.

**A5-201 / A5-202 / A5-204** remain INTERNAL BLOCKED `c1c_authenticated_session_unavailable`. C1C mapping is intact; this agent does not have the C1C plaintext; Cognito identity mutation is forbidden this turn; `staging-master@checksops.invalid` Cognito-succeeds then `/identity/me` → `identity_not_linked`. Tabs/Cancel/inputs were not physically clicked.

### 2. Check Command Center persistence (synthetic checks)

**Not executed.** Needs a mapped tenant session. `unsafe_persist_checkcommandcenter` (16) stays INTERNAL BLOCKED. Do not fabricate deposits.

### 3. Status-gated controls

**Not executed.** `CC-363–366` stay `BLOCKED_STATUS`. Do not fabricate deposits.

### 4. CRC / payee controls

**Not executed.** `no_crc_payee_row` (10) stays INTERNAL BLOCKED.

### 5. Settled-payment controls without real provider settlement

**Not executed.** `empty_settled_payments` (13) stays INTERNAL BLOCKED.

### 6. Provider-free pay-setup (Moov remains OFF)

Physically tested invalid tokens only. Did not insert `external_payment_recipients`. Did not enable Moov.

| Probe | Result |
|---|---|
| Browser `/pay-setup/not-a-valid-token` | UI “Payment setup unavailable” / “invalid or has expired” |
| Browser `/pay-setup/phase3-paysetup-probe-token` | same |
| API short token | HTTP 400 `invalid_link` |
| API plausible missing token | HTTP 404 `invalid_link` |
| Live `handlePublicRecipientSession` after a found row | **always** HTTP 409 `payment_setup_unavailable` |

X-022–041 remain INTERNAL BLOCKED `valid_paysetup_token_unavailable`. Bank-form controls cannot be reached on this baseline without enabling Moov or SQL DML.

Evidence: `/opt/cursor/artifacts/phase3_paysetup_invalid_token.webp`, `phase3_paysetup_plausible_missing.webp`, `phase3_public_paysetup_and_portal.mp4`.

### 7. Missing write paths / live UI controls

Settlement save path: see A5-203 / PR #309.

Homeowner portal loss-draft actions still **501 `action_not_ported`** on live API for `sign_document`, `submit_mortgage_intake`, and `complete_action` (retained token GET 200 `pending:false`; unknown hex 404). Browser: DTP form mounted unsigned; no separate Sign document / Submit mortgage info controls because `actions[]` is empty. Did not click Sign Direction to Pay (A7-024 remains PASS from prior port). A7-028–041 stay `BLOCKED_MISSING_FEATURE`.

EndorsementAdjuster **is** present in live `CheckCommandCenter-BZtZu8ed.js` (`Adjust Received Endorsement`). Physical click still needs a mapped session + synthetic back image. CC-178–189 stay `BLOCKED_MISSING_FEATURE` / fixture as previously classified.

### 8–10. Remaining authenticated INTERNAL BLOCKED

Stopped. Genuine boundary: no mapped SPA session without a Cognito identity mutation (forbidden) or an injected C1C password secret (none exists).

## Remaining FAIL

`A8-035` Sign in with password — `identity_not_linked` (out of scope; Freedom admin). Unchanged.

## Defects found this turn

1. **Live SPA/API cannot persist `claim_settlements`.** Root cause: client allowlist + missing Lambda executor. Git-fixed in PR #309. **AWAITING_INTEGRATION_DEPLOYMENT.**
2. **Portal `sign_document` / `submit_mortgage_intake` / `complete_action` still 501** on the validated baseline. Reproduced. Not ported this turn (needs loss-draft document + S3 PDF write path). Remain BLOCKED_MISSING_FEATURE.

## Remediation PRs / commits

| Item | Value |
|---|---|
| Settlement write | PR **#309** `906c8afa6` — **do not deploy** |
| Inventory / this report | this PR, base `cursor/phase2-integration-inventory-3bce` |
| SQL 40 | Git artifact only; not applied |
| PR #304 / #277 | not deployed |

## Fixtures

| Fixture | Disposition |
|---|---|
| C1C ledger claim / settlement / intake | **Retained; not modified** |
| SES-free portal lead `ccee4d05-…` | **Retained; GET only + 501 probe; no DTP re-sign; no upload; no SES** |
| Pay-setup recipient | **none created** |
| New Cognito users | **none** |

## Integration & Release handoffs

1. Deploy PR #309 (Lambda + SPA) when authorized. Optionally apply SQL 40 if column GRANTs are still incomplete; do not apply SQL 30; do not run SQL 23.
2. After deploy, Functional Audit still needs a **mapped C1C (or other tenant) password** without `identity_accounts` DML to physically click A5-201–204 and CCC persist.
3. Do not enable Moov/CheckAlt/provider execution for pay-setup.
4. Portal 501 actions remain an AWS port gap (`aws/functions/api/homeowner.mjs`).
5. Pin watch: if Lambda SHA or SPA ETag changes unexpectedly, stop and report `INTEGRATION_BASELINE_DRIFT`.

## Safety

- Production unchanged
- Provider execution remained OFF
- No real financial transaction
- SES/email unchanged (endorsement E2E not repeated)
- Cognito identities unchanged this turn
- No shared-staging deployment
- No Phase 4

**STOP after this report.** Remaining Phase 3 authenticated attack-order items wait on a mapped session and/or Integration deploy of #309. Do not begin Phase 4.
