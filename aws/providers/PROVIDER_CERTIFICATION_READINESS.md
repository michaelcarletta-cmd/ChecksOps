# Provider certification readiness (staging) — no execution enabled

**Date:** 2026-09-04  
**Rule:** Do not send transactions merely to improve parity. Financial execution remains disabled.

## Moov sandbox

| Item | Status |
|---|---|
| Secrets present | `MOOV_SANDBOX_PUBLIC_KEY`, `MOOV_SANDBOX_SECRET_KEY` in `checksops/staging/providers` |
| Missing | `MOOV_SANDBOX_PLATFORM_ACCOUNT_ID` (and optional webhook secret / allowed origin) |
| Network/egress | **Reachable** from `checksops-staging-api` (`GET /providers/egress` → `moovReachable: true`, HTTP 403 at edge without credentials — expected) |
| Webhooks | Dry-run path present; production webhooks not redirected |
| Why execution disabled | `AWS_PROVIDER_EXECUTION_ENABLED=false`, `AWS_MOOV_ENABLED=false`; Class C money movement intentionally off |

## CheckAlt UAT

| Item | Status |
|---|---|
| Secrets present | `CHECKALT_UAT_USER_ID`, `CHECKALT_UAT_PASSWORD`, `CHECKALT_UAT_FI_KEY`, `CHECKALT_UAT_MERCHANT`, `CHECKALT_UAT_BASE_URL` |
| Missing | Approved UAT deposit account number / register-account binding confirmation |
| Network/egress | **Reachable** (`checkaltUatReachable: true`) |
| Webhooks | Staging dry-run; production not redirected |
| Why execution disabled | Deposit submit/approve remain Class C; flags keep execution off |

## Plaid sandbox

| Item | Status |
|---|---|
| Secrets present | **Missing** `PLAID_SANDBOX_CLIENT_ID` / `PLAID_SANDBOX_SECRET` |
| Network/egress | Not probed (no keys); NAT/egress already proven for HTTPS generally |
| Webhooks | Not configured for sandbox |
| Why execution disabled | No sandbox credentials; transfers Class C |

## Shared staging gates (keep false)

- `AWS_PROVIDER_EXECUTION_ENABLED=false`
- `AWS_FINANCIAL_PERMISSIONS_ACTIVATED=false`
- Do **not** apply `64_financial_activation_grants.sql`
- Do **not** enable production Moov/CheckAlt/Plaid

## Next certification phase prerequisites (external)

1. Moov: platform account id for sandbox + confirm sandbox business account mapping  
2. CheckAlt: UAT deposit account number approved for lockbox5 merchant  
3. Plaid: create sandbox app keys in Secrets Manager  
4. Keep NAT/egress healthy (currently OK)
