# E14 Phase 1 — selected-check go packet

Recorded 2026-09-22T21:47Z against live isolated production. **No execution flags were changed in this phase.**

## Selected check (unambiguous)

| Field | Value |
| --- | --- |
| Check ID | `a3a4a153-46e1-4c28-a273-79a9bd04f3a6` |
| Check number | `0121319295` |
| Amount displayed | `$1,546.72` |
| Amount submitted (server cents) | `154672` |
| Amount match | **yes** (`1546.72 → 154672`) |
| Tenant | Freedom `2eff5f1a-929d-4ce3-9a8b-cd96b98df42a` |
| Payee line | Miranda Shollenberger And Freedom Adjustment |
| Payees | Freedom Adjustment (public_adjuster, signed); Miranda Shollenberger (insured, signed) |
| Claim context | Freedom claim `250356537` (no `claim_checks` row) |
| Status / stage | `approved_for_deposit` / `ready_for_deposit` |
| Recommendation | `ready_for_deposit` |
| Existing CheckAlt deposits | **none** (0 rows; no reference; no HTTP attempt) |
| Official `.checkalt.jpg` | not yet — created by the normal prepare step |
| `back_image_deposit_path` | not yet — created by the normal endorsed-deposit composite before prepare |

This is the only Freedom `approved_for_deposit` check with tenant-scoped payees, both endorsements signed, and zero `checkalt_deposits` rows. The other four approved Freedom checks are excluded: two have empty tenant-scoped payees, one has a historical rejected referenced deposit, one has no payees/endorsements.

## Production baseline (before any flag change)

| Gate | Result |
| --- | --- |
| API CodeSha | `COjFgV8sD7NmAe+/4XyXUG1n7r9JDItT1T4PFu9FjTc=` (accepted E13) |
| SPA | `index-BwMXtcQm.js` sha256 `26ad3d423b9ee515e47f91cf57a79f543e9dfb3c4d885046d7e4c5bdecb5ffb1` (accepted E12; meta git `a733d104a`) |
| `CHECKALT_WEBHOOK_SECRET` | configured on `PROVIDER_SECRETS_ARN` `checksops/production/provider-At4ZFR` |
| Webhook endpoint | `https://checksops.com/prep/webhooks/checkalt` — unsigned POST returns `401 missing_signature_headers` |
| `AWS_PROVIDER_WEBHOOK_DRY_RUN` | `true` |
| Freedom CheckAlt mapping | enabled; SSO + deposit account present |
| C1C mapping | none |
| CheckAlt host | `https://api2.checkalt.com` (approved production). UAT/sandbox base URLs absent |
| Dry-run / reconcile / Moov / ACH / RTP / wire | dry-run true; reconcile false; `AWS_MOOV_ENABLED=false`; `AWS_MOOV_TRANSFER_POST_ENABLED=false`; no ACH/RTP/wire flags exist and Moov stays off |
| Historical CheckAlt rows | 69 total / 58 referenced / amount `453990.48` / `last_updated` `2026-09-04T15:58:10.843Z` |
| SQL 65 objects | present (`provider_http_attempted_at`, receipts). `FORCE RLS` off. **Not reapplied.** |
| Source images in production S3 | front JPEG 4,529,502 B; endorsed SVG back 4,641,698 B; original rear JPEG 3,463,826 B; AES256 |

Money flags at Phase 1 close (still fail-closed):

- `AWS_PROVIDER_EXECUTION_ENABLED=false`
- `AWS_CHECKALT_ENABLED=false`
- `AWS_FINANCIAL_PERMISSIONS_ACTIVATED=false`
- `AWS_CHECKALT_STATUS_RECONCILE_ENABLED=false`
- `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED=false`

## Required overlay before Phase 3 submit

Live E13 `CHECK_ELIGIBILITY_SELECT` includes `front_image_deposit_path`. Isolated production `check_intake_items` does **not** have that column (`back_image_deposit_path` exists). Official front path is derived from `front_image_path` only. The E14 overlay removes the nonexistent column from the select so preflight/submit can run without a schema migration.

## Phase 3 workflow notes (not blockers for this packet)

- Financial TOTP enrollments on production: **0**. Enrollment happens in the normal ChecksOps UI before the first `deposit.submit` step-up. EMAIL_OTP login is not money authority.
- Official CheckAlt JPEGs and the endorsed rear deposit path are created by the normal Deposit / endorsement-composite / `prepareCheckAltDeposit` path. They are not backfilled here.
- Freedom has one mapped Cognito admin (financial role) and one operator (cannot execute).
