# Provider certification readiness (staging) — no execution enabled

**Date:** 2026-09-04  
**Rule:** Do not send transactions merely to improve parity. Financial execution remains disabled.

## Moov sandbox

**Status (2026-09-04):** **PASS** on AWS staging (PR #124).  
Platform account `36b7…47bb` authorized with Origin `https://staging.checksops.com`. Probe → $0.01 transfer → webhook signature/idempotency → reconcile → C1C cross-tenant denial all green. Production Moov/CheckAlt/financial execution flags remain **false**.

## CheckAlt UAT

| Item | Status |
|---|---|
| Secrets present | `CHECKALT_UAT_USER_ID`, `CHECKALT_UAT_PASSWORD`, `CHECKALT_UAT_FI_KEY`, `CHECKALT_UAT_MERCHANT`, `CHECKALT_UAT_BASE_URL` |
| Missing | Approved UAT deposit account number / register-account binding confirmation |
| Network/egress | **Reachable** (`checkaltUatReachable: true`) |
| Webhooks | Staging dry-run; production not redirected |
| Why execution disabled | Deposit submit/approve remain Class C; flags keep execution off |

## Plaid

**Not required for ChecksOps.** Do not treat missing Plaid sandbox keys as a production-cutover blocker. Keep `AWS_PLAID_ENABLED=false`. Existing Plaid adapter code may remain dormant.

## Shared staging gates (keep false)

- `AWS_PROVIDER_EXECUTION_ENABLED=false`
- `AWS_FINANCIAL_PERMISSIONS_ACTIVATED=false`
- Do **not** apply `64_financial_activation_grants.sql`
- Do **not** enable production Moov/CheckAlt

## Genuine production-cutover blockers (current)

1. Moov: production activation intentionally held (`AWS_MOOV_ENABLED` / master execution flags) — sandbox cert is **PASS**
2. CheckAlt: UAT deposit account binding + production activation held
3. Production DNS / webhooks / auth / data cutover not performed (intentional)
4. Financial activation grants / Deposit Ops money RPCs intentionally disabled

Removed from blocker list: **Plaid** (not required); **Moov sandbox account authorization** (resolved 2026-09-04).

## Next certification phase prerequisites (external)

1. CheckAlt: UAT deposit account number approved for lockbox5 merchant  
2. Keep NAT/egress healthy (currently OK)
3. Moov production activation remains a deliberate, separate gate — do not flip production flags from this sandbox PASS
