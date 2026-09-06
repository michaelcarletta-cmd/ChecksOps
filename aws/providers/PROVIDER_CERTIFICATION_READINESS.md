# Provider certification readiness (staging) — no execution enabled

**Date:** 2026-09-04  
**Rule:** Do not send transactions merely to improve parity. Financial execution remains disabled.

## Moov sandbox

**Status (2026-09-04):** **PASS** on AWS staging (PR #124).  
Platform account `36b7…47bb` authorized with Origin `https://staging.checksops.com`. Probe → $0.01 transfer → webhook signature/idempotency → reconcile → C1C cross-tenant denial all green. Production Moov/CheckAlt/financial execution flags remain **false**.

## CheckAlt

**Reassessed 2026-09-06** (Architecture A on `main` via merged PR #130; known-good Accepted `120846345` byte-identical). See `results/checkalt_cutover_readiness_reassessment.md`.

| Gate | Status |
|---|---|
| **Production integration** | **READY** — Architecture A on `main`; offline 8/8 incl. provider-Accepted `120846345`; Lovable process parity. Execution flags stay **OFF**. |
| **Synthetic UAT certification** | **PARTIAL** (PR #125) — synthetic VOID still HTTP 500 / IQA rejection. Not a pipeline gap. |

Authoritative Postman extract (`CheckAlt_PR125_Minimal_API.json`) confirms **`POST /fincapture/deposit/process` = Submit deposit transaction**. Approve/item/history and high-res/IRD are post-process only. Production CheckAlt remains **OFF**. Cutover may be **scheduled** with CheckAlt OFF; enable later under separate approval. Do **not** merge #125 for this classification.

## Plaid

**Not required for ChecksOps.** Do not treat missing Plaid sandbox keys as a production-cutover blocker. Keep `AWS_PLAID_ENABLED=false`. Existing Plaid adapter code may remain dormant.

## Shared staging gates (keep false)

- `AWS_PROVIDER_EXECUTION_ENABLED=false`
- `AWS_FINANCIAL_PERMISSIONS_ACTIVATED=false`
- Do **not** apply `64_financial_activation_grants.sql`
- Do **not** enable production Moov/CheckAlt

## Genuine production-cutover blockers (current)

1. Moov: production activation intentionally held (`AWS_MOOV_ENABLED` / master execution flags) — sandbox cert is **PASS**
2. CheckAlt: **production enablement** intentionally held (`AWS_CHECKALT_ENABLED` / master execution flags) — **integration READY**; synthetic UAT remains **PARTIAL** and does **not** block scheduling DNS/auth cut while flags stay OFF
3. Production DNS / auth / data cutover not performed (intentional)
4. Financial activation grants / Deposit Ops money RPCs intentionally disabled

Removed from blocker list: **Plaid**; **Moov sandbox account authorization**; **CheckAlt webhook secret**; **CheckAlt UAT deposit account / ssoKey discovery**; **CheckAlt image pipeline constant mismatch vs Lovable**; **Missing FinCapture pre-process / IRD / high-res submit step**; **CheckAlt Architecture A / known-good parity gap** (closed by #130 + Accepted `120846345`). Synthetic VOID UAT 500 is **not** a schedule blocker when production CheckAlt stays OFF.

## Next certification phase prerequisites (external)

1. CheckAlt: UAT synthetic-image acceptance policy or official UAT image kit / IQA guidance (do not submit restored production negotiable checks)
2. After accepted deposit: status/history + idempotency + reconcile evidence
3. Keep NAT/egress healthy (currently OK)
4. Moov production activation remains a deliberate, separate gate — sandbox PASS does not authorize production flags
5. CheckAlt webhooks remain optional / not required
6. Postman authority for FinCapture submit vs IRD/high-res is now on-branch (`aws/providers/results/CheckAlt_PR125_Minimal_API.json`)

