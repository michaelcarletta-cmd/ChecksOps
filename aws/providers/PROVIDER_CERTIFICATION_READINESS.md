# Provider certification readiness (staging) — no execution enabled

**Date:** 2026-09-04  
**Rule:** Do not send transactions merely to improve parity. Financial execution remains disabled.

## Moov sandbox

**Status (2026-09-04):** **PASS** on AWS staging (PR #124).  
Platform account `36b7…47bb` authorized with Origin `https://staging.checksops.com`. Probe → $0.01 transfer → webhook signature/idempotency → reconcile → C1C cross-tenant denial all green. Production Moov/CheckAlt/financial execution flags remain **false**.

## CheckAlt UAT

**Status (2026-09-04):** **BLOCKED** on depositor `ssoKey` + approved UAT deposit account (PR for CheckAlt UAT cert).  
Auth + merchant/`lockbox5` + FI context **PASS**. `getUserAccountInformation` returns accounts without `ssoKey`. `CHECKALT_UAT_DEPOSIT_ACCOUNT_NUMBER` and `CHECKALT_SANDBOX_WEBHOOK_SECRET` absent. No negotiable check submitted. Production CheckAlt remains **OFF**. See `CHECKALT_UAT_CERTIFICATION.md`.

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

1. CheckAlt: issue approved UAT deposit account number for lockbox5 + register UAT FinCapture depositor (`ssoKey`)
2. Optionally set `CHECKALT_SANDBOX_WEBHOOK_SECRET` for UAT callbacks
3. Keep NAT/egress healthy (currently OK)
4. Moov production activation remains a deliberate, separate gate — sandbox PASS does not authorize production flags

