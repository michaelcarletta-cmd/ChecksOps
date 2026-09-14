# AWS ACTIVE-PRODUCT PARITY PHASE

**Date:** 2026-09-14  
**Branch:** `cursor/prod-active-parity-c48b`  
**Inventory:** same 1,421 IDs in `docs/audits/inventory-2026-09-11.json`  
**Production SPA:** still locked (`index-CiOVNYWh.js` / commit `868e69387d63`). Not redeployed.

## Headline counts

| Metric | Count |
|---|---|
| Existing inventory | **1,421** |
| N/A (all) | **285** |
| N/A — LEGACY_UNUSED (Zapier + Stripe credit UI) | **8** |
| ACTIVE_REQUIRED (live / non-N/A) | **1,136** |
| AWS_PASS | **7** |
| AWS_FAIL | **0** |
| SUPABASE_DEPENDENCY (live locked SPA) | **7** |
| INTERNAL_BLOCKED | **248** |
| EXTERNAL_BLOCKED | **167** |
| NOT_RETESTED_POST_CUTOVER | **707** |

Frozen prior `result` totals remain **714 PASS / 1 FAIL / 421 BLOCKED / 285 N/A**.

`A8-035` prior `result` stays FAIL; `post_cutover_status` stays AWS_PASS.

## Unused integrations removed

| Integration | Application/UI | Secrets / infra | Audit |
|---|---|---|---|
| Zapier | Deleted unmounted settings panel | Column + any AWS secret kept | A4-225–227 N/A — LEGACY_UNUSED |
| Stripe | Deleted unused billing panel + unmounted credit checkout; stripped dead report invoke | `stripe_*` columns + fail-closed AWS stubs kept | CC-228–232 N/A — LEGACY_UNUSED |
| Telnyx | No SPA UI to delete. SMS handler stays sink (does not call Telnyx) | SMS secrets kept | No UI IDs |
| Make.com | Already absent | — | — |

See `UNUSED_INTEGRATIONS_REMOVAL_2026-09-14.md`.

## Repairs prepared (not released)

| ID | Repair in this branch | Live locked SPA |
|---|---|---|
| X-020 | `Unsubscribe.tsx` GET/POST → `/prep/functions/v1/handle-email-unsubscribe` | Still blanked `VITE_SUPABASE_URL` → origin `/functions/v1/...` |
| A5-305–A5-310 | `verificationFiles.ts` XHR → `/prep/functions/v1/moov-account-file-upload` + Cognito bearer | Still origin `/functions/v1/moov-account-file-upload` |

**Controlled production SPA release is required** for these two repairs to take effect. This branch does not unlock or `--apply` the SPA.

Resend is unchanged. SES was not started.

## Remaining Supabase dependencies

See `SUPABASE_RETIREMENT_SCOPE_2026-09-14.md`. Project is **not** shut down.

Live user-facing leftovers on the **locked** SPA are still X-020 and A5-305–310. Source on this branch is repaired.

## Production blockers (unchanged safety)

- Do not initiate CheckAlt deposit, Moov transfer, payment, funding, or disbursement for testing.
- Production Class A cron secret is absent — email-queue / OCR-backlog sweep not on EventBridge.
- Ninth Cognito UUID still unlinked.
- 707 NOT_RETESTED_POST_CUTOVER rows are not automatic repair tickets.

## Controlled SPA release required?

**Yes**, for unsubscribe + Moov KYC upload source fixes to reach `checksops.com`.  
**No** other production deploy is required for Phase 1 UI removal (those surfaces were unmounted).
