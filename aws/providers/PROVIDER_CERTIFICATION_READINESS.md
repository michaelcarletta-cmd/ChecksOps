# Provider certification readiness (staging) — no execution enabled

**Date:** 2026-09-04  
**Rule:** Do not send transactions merely to improve parity. Financial execution remains disabled.

## Moov sandbox

**Status (2026-09-04):** **PASS** on AWS staging (PR #124).  
Platform account `36b7…47bb` authorized with Origin `https://staging.checksops.com`. Probe → $0.01 transfer → webhook signature/idempotency → reconcile → C1C cross-tenant denial all green. Production Moov/CheckAlt/financial execution flags remain **false**.

## CheckAlt UAT

**Status (2026-09-04):** **PARTIAL** (PR #125) — STOP for review.  
Auth + merchant/`lockbox5` + FI context **PASS**. Deposit-account binding **PASS** via UAT `getDepositAccountInformation` (authorized account fingerprint `46bed6e573bb`; sample `123456789` not used). Synthetic UAT depositor register + discoverable `ssoKey` **PASS**. Webhooks **N/A** (CheckAlt confirmed not required). UAT `deposit/process` **PARTIAL** — CheckAlt HTTP 500 image QA (*retake the check images*); no provider reference; status/idempotency not reached. Production CheckAlt remains **OFF**. See `CHECKALT_UAT_CERTIFICATION.md`.

## Plaid

**Not required for ChecksOps.** Do not treat missing Plaid sandbox keys as a production-cutover blocker. Keep `AWS_PLAID_ENABLED=false`. Existing Plaid adapter code may remain dormant.

## Shared staging gates (keep false)

- `AWS_PROVIDER_EXECUTION_ENABLED=false`
- `AWS_FINANCIAL_PERMISSIONS_ACTIVATED=false`
- Do **not** apply `64_financial_activation_grants.sql`
- Do **not** enable production Moov/CheckAlt

## Genuine production-cutover blockers (current)

1. Moov: production activation intentionally held (`AWS_MOOV_ENABLED` / master execution flags) — sandbox cert is **PASS**
2. CheckAlt: UAT image-acceptance gap for synthetic `testDeposit` + production activation held (deposit-account binding and depositor register resolved on UAT)
3. Production DNS / auth / data cutover not performed (intentional)
4. Financial activation grants / Deposit Ops money RPCs intentionally disabled

Removed from blocker list: **Plaid** (not required); **Moov sandbox account authorization** (resolved 2026-09-04); **CheckAlt webhook secret** (CheckAlt confirmed webhooks not required); **CheckAlt UAT deposit account number as sole unknown** (API-discovered).

## Next certification phase prerequisites (external)

1. CheckAlt: acceptable UAT check image fixture or image-QA guidance for `testDeposit` on merchant `lockbox5`
2. After accepted deposit: status/history + idempotency + reconcile evidence
3. Keep NAT/egress healthy (currently OK)
4. Moov production activation remains a deliberate, separate gate — sandbox PASS does not authorize production flags
5. CheckAlt webhooks remain optional / not required

