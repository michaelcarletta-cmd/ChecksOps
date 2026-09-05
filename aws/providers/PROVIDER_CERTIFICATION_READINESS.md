# Provider certification readiness (staging) — no execution enabled

**Date:** 2026-09-04  
**Rule:** Do not send transactions merely to improve parity. Financial execution remains disabled.

## Moov sandbox

**Status (2026-09-04):** **PASS** on AWS staging (PR #124).  
Platform account `36b7…47bb` authorized with Origin `https://staging.checksops.com`. Probe → $0.01 transfer → webhook signature/idempotency → reconcile → C1C cross-tenant denial all green. Production Moov/CheckAlt/financial execution flags remain **false**.

## CheckAlt UAT

**Status (2026-09-04):** **PARTIAL** (PR #125) — STOP for review.  
Authoritative Postman extract (`CheckAlt_PR125_Minimal_API.json`) confirms **`POST /fincapture/deposit/process` = Submit deposit transaction**. Approve/item/history are post-process. **High-res retrieve** and **IRD generate** are post-transaction only (not submit). AWS matches Lovable core process fields + image-pipeline parity. Remaining UAT HTTP 500 (*retake the check images*) is CheckAlt IQA/acceptance behavior — not a missing documented workflow step. Production CheckAlt remains **OFF**. See `CHECKALT_UAT_CERTIFICATION.md`.

## Plaid

**Not required for ChecksOps.** Do not treat missing Plaid sandbox keys as a production-cutover blocker. Keep `AWS_PLAID_ENABLED=false`. Existing Plaid adapter code may remain dormant.

## Shared staging gates (keep false)

- `AWS_PROVIDER_EXECUTION_ENABLED=false`
- `AWS_FINANCIAL_PERMISSIONS_ACTIVATED=false`
- Do **not** apply `64_financial_activation_grants.sql`
- Do **not** enable production Moov/CheckAlt

## Genuine production-cutover blockers (current)

1. Moov: production activation intentionally held (`AWS_MOOV_ENABLED` / master execution flags) — sandbox cert is **PASS**
2. CheckAlt: UAT IQA/acceptance rejection of synthetic non-negotiable images after documented `/deposit/process` submit (sequence/fields aligned with Lovable) + production activation held
3. Production DNS / auth / data cutover not performed (intentional)
4. Financial activation grants / Deposit Ops money RPCs intentionally disabled

Removed from blocker list: **Plaid**; **Moov sandbox account authorization**; **CheckAlt webhook secret**; **CheckAlt UAT deposit account / ssoKey discovery**; **CheckAlt image pipeline constant mismatch vs Lovable**; **Missing FinCapture pre-process / IRD / high-res submit step** (not required for submission).

## Next certification phase prerequisites (external)

1. CheckAlt: UAT synthetic-image acceptance policy or official UAT image kit / IQA guidance (do not submit restored production negotiable checks)
2. After accepted deposit: status/history + idempotency + reconcile evidence
3. Keep NAT/egress healthy (currently OK)
4. Moov production activation remains a deliberate, separate gate — sandbox PASS does not authorize production flags
5. CheckAlt webhooks remain optional / not required
6. Postman authority for FinCapture submit vs IRD/high-res is now on-branch (`aws/providers/results/CheckAlt_PR125_Minimal_API.json`)

