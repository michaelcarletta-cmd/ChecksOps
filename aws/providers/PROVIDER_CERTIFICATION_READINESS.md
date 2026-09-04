# Provider certification readiness (staging) — no execution enabled

**Date:** 2026-09-04  
**Rule:** Do not send transactions merely to improve parity. Financial execution remains disabled.

## Moov sandbox

| Item | Status |
|---|---|
| Secrets present | `MOOV_SANDBOX_PUBLIC_KEY`, `MOOV_SANDBOX_SECRET_KEY`, `MOOV_SANDBOX_PLATFORM_ACCOUNT_ID`, `MOOV_SANDBOX_WEBHOOK_SECRET`, `MOOV_SANDBOX_ALLOWED_ORIGIN` (`https://staging.checksops.com`) |
| Missing / failing | `MOOV_SANDBOX_CONNECTED_ACCOUNT_ID` (optional). **Account resource authorization:** OAuth PASS but `GET /accounts/{platform}` returns **401** — Moov app/key cannot read the configured account. |
| Discovery / cert (2026-09-04 resume) | OAuth **PASS**; webhook signature + idempotency **PASS**; capabilities/wallet/methods/transfer **blocked** by account 401. See `MOOV_SANDBOX_CERTIFICATION.md`. |
| Network/egress | **Reachable** (`moovReachable: true`) |
| Webhooks | Staging `/sandbox/webhooks/moov` signature + replay **PASS**; production webhooks not redirected |
| Certification | **PARTIAL** |
| Why execution disabled | `AWS_PROVIDER_EXECUTION_ENABLED=false`, `AWS_MOOV_ENABLED=false`; Class C money movement intentionally off |

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

1. Moov: sandbox account resource authorization (GET `/accounts/{platform}` must return 200 with staging sandbox keys) before any Moov money path
2. Moov: production activation intentionally held (`AWS_MOOV_ENABLED` / master execution flags)
3. CheckAlt: UAT deposit account binding + production activation held
4. Production DNS / webhooks / auth / data cutover not performed (intentional)
5. Financial activation grants / Deposit Ops money RPCs intentionally disabled

Removed from blocker list: **Plaid** (not required).

## Next certification phase prerequisites (external)

1. Moov: fix sandbox platform account ↔ API key authorization (see `MOOV_SANDBOX_CERTIFICATION.md`), then resume capabilities/wallet/transfer cert  
2. CheckAlt: UAT deposit account number approved for lockbox5 merchant  
3. Keep NAT/egress healthy (currently OK)
