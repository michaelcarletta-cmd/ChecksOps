# MOOV M5 — AWS PRODUCTION ONBOARDING + RECIPIENT FOUNDATION

**Date:** 2026-09-10  
**Branch:** `cursor/moov-production-readiness-m5-a508`  
**STOP FOR REVIEW.** Dark code only.

No production writes activated. SPA still uses Supabase. Webhook not registered. SQL72 not applied. Money flags false. No Moov mutation. No invitations issued. $0.00 moved.

## Verdict

| Item | Result |
|---|---|
| ONBOARDING FOUNDATION | **PASS** |
| KYC/KYB FOUNDATION | **PASS** |
| TOS FOUNDATION | **PASS** |
| BANK FOUNDATION | **PASS** |
| CAPABILITIES FOUNDATION | **PASS** |
| RECIPIENT FOUNDATION | **PASS** |
| PUBLIC RECIPIENT SESSION | **PASS** |
| RECIPIENT READINESS | **PASS** |
| WALLET FOUNDATION | **PASS** |
| WEBHOOK APPLY DARK CODE | **PASS** |
| PRODUCTION WRITES ENABLED | **NO** |
| SPA CUTOVER | **NO** |
| WEBHOOK REGISTERED | **NO** |
| SQL72 | **NOT_APPLIED** |
| MONEY FLAGS | **FALSE** |
| MONEY MOVED | **$0.00** |
| GO/NO-GO for live onboarding | **NO-GO** |

## New holds (all default false)

| Flag | Purpose |
|---|---|
| `AWS_MOOV_ONBOARDING_WRITES_ENABLED` | Tenant/recipient/bank/ToS/KYC mutations. Independent of money flags. |
| `AWS_MOOV_WEBHOOK_APPLY_ENABLED` | Authoritative webhook apply. Receipt persist remains separate. |
| `AWS_LOVABLE_MONEY_NEUTRALIZED` | Required before AWS money execution. Prevents AWS money from going live while Lovable still moves money. |

`productionMoovExecutionAllowed()` now also requires `AWS_LOVABLE_MONEY_NEUTRALIZED=true`. Default false → money still blocked even if the three older money flags were set by accident.

M5 handlers still refuse live Moov POST/PATCH even if the onboarding flag is flipped; they return `403 production_onboarding_blocked` with an `intended` request. Wiring `productionMoovFetch({ mode: 'onboard' })` is a later GO.

## READY predicate (recipients)

`evaluateRecipientReady()` in `moov-recipient-readiness.mjs`. **Not sufficient:** last4, `bank_linked_at`, local bank name, RDS `onboarding_status`.

READY requires all of:

- live account present
- `mode` production (when present)
- not disabled / not restricted
- identity verification `verified`
- ToS accepted (`termsOfService.acceptedDate` / `acceptedOn`)
- at least one bank `verified`
- eligible receive method (`ach-credit-standard` or `ach-credit-same-day`, enabled)
- no blocking requirements / errored capabilities

`POST /functions/v1/moov-recipient-readiness` is GET-only live Moov (account, banks, PMs, capabilities) when live-reads is on. It does not mutate Freedom recipients.

## Public recipient session

`POST /functions/v1/moov-recipient-session` does **not** use Cognito.

- Token: 256-bit hex; stored as `sha256:…` on AWS invites; Lovable plaintext still matches via hash-of-stored
- Expiry, revoke (`disconnected` / `token_revoked_at`), 404 without tenant enumeration
- 10 failures / 15 min / IP
- Mutations (`kyc`, `tos-accept`, `bank-add`) remain `production_onboarding_blocked`
- No financial execution authority

## Webhook apply

`applyProductionMoovWebhook` computes intended mutations. Default `applied=false`.

- Duplicate event id unchanged
- Transfer status is monotonic (`out_of_order` skips)
- `awaiting_bank` → `ready` only if the **full** live READY predicate succeeds (bank verified alone is not enough)
- Webhook cannot create a transfer
- No Moov POST from apply

## Legacy money isolation (not neutralized)

Lovable CRITICAL movers stay live. Later neutralization:

1. Dual-run AWS dark receipts + GET readiness
2. Set `AWS_LOVABLE_MONEY_NEUTRALIZED=true` only after Lovable `MOOV_ENABLED` is false for money functions (or those functions 403)
3. Only then consider money flags
4. AWS money execution cannot become true without step 3

Do **not** set `AWS_LOVABLE_MONEY_NEUTRALIZED` in this phase.

## Architecture / route matrix

| Route | Purpose | Auth | Tenant authority | Moov op | GET vs mutation | Hold | DB | Lovable |
|---|---|---|---|---|---|---|---|---|
| `POST /functions/v1/moov-account-create` | Connected account | Cognito + financial role | membership, ignore browser account id | `POST /accounts` | mutation | onboarding | `payment_provider_accounts` | `moov-account-create` |
| `POST /functions/v1/moov-account-onboard` | KYB profile, controller, owners | same | membership | `PATCH /accounts`, representatives | mutation | onboarding | same | `moov-account-onboard` |
| `POST /functions/v1/moov-onboarding-link` | Hosted session | same | membership | hosted link | mutation | onboarding | same | `moov-onboarding-link` |
| `POST /functions/v1/moov-tos-token` | Moov.js ToS Drop token | same | membership | OAuth scoped token | mutation (token mint) | onboarding | none | `moov-tos-token` |
| `POST /functions/v1/moov-tos-accept` | Apply Drop token | same | membership | `POST …/tos-acceptances` | mutation | onboarding | `tos_*` | `moov-tos-accept` |
| `POST /functions/v1/moov-bank-link-token` | Moov.js bank Drop | same | membership | OAuth | mutation | onboarding | none | `moov-bank-link-token` |
| `POST /functions/v1/moov-bank-account-add` | Manual bank | same | membership | `POST …/bank-accounts` | mutation | onboarding | methods last4 only | `moov-bank-account-add` |
| `POST /functions/v1/moov-micro-deposit-*` | Micro-deposits | same | membership | initiate/confirm | mutation | onboarding | methods | same names |
| `POST /functions/v1/moov-account-file-upload` | KYC files | same | membership | `POST …/files` | mutation | onboarding | metadata | `moov-account-file-upload` |
| `POST /functions/v1/moov-account-files` | Document status | same | membership | `GET …/files` | GET | live-reads | none | `moov-account-files` |
| `POST /functions/v1/moov-underwriting` | Underwriting GET; `action=save` is write | same | membership | GET/PUT `/underwriting` | GET / mutation | live-reads / onboarding | metadata | `moov-underwriting` |
| `POST /functions/v1/moov-recipient-create` | Invite + recipient account | Cognito | membership | `POST /accounts` | mutation | onboarding | recipients + hashed invite | `moov-recipient-create` |
| `POST /functions/v1/moov-recipient-session` | Public setup page | **token only** | derived from token | GET account/banks/PMs | GET | live-reads for Moov GET | recipients lookup | `moov-recipient-session` |
| `POST /functions/v1/moov-recipient-kyc-update` | Payee KYC | token | derived | PATCH profile | mutation | onboarding | recipients | `moov-recipient-kyc-update` |
| `POST /functions/v1/moov-recipient-tos-accept` | Payee ToS | token | derived | ToS | mutation | onboarding | recipients | `moov-recipient-tos-accept` |
| `POST /functions/v1/moov-recipient-bank-add` | Payee bank | token | derived | POST bank | mutation | onboarding | last4 only | `moov-recipient-bank-add` |
| `POST /functions/v1/moov-recipient-readiness` | Live READY | Cognito | membership | GET recipient Moov | GET | live-reads | none (no write) | none (new) |
| `POST /functions/v1/moov-wallet-activity` | BALANCE_READ ledger | Cognito | membership | RDS ledger | GET | live-reads | `payment_transfers` read | `moov-wallet-sync` (partial) |
| `POST /functions/v1/initiate-wallet-funding` etc. | FUNDING/TRANSFER/DISBURSE/SWEEP | Cognito | membership | blocked | mutation | money | — | same names |
| `POST /webhooks/moov` | Receipt + dark apply | HMAC | mapped account | none | persist | apply flag false | receipts | `moov-webhook` |

Browser never supplies authority for tenant id (must be a membership), Moov account id, or platform account id.

ToS: user completes Moov.js Drop; server mints token and later applies the Drop-issued token. `accepted=true` without a token is `tos_acceptance_forged`.

Bank Drop: user enters routing/account in Moov.js; server never needs full numbers on that path. Manual add still exists and is held.

## SPA migration map (do not switch production)

| Surface | OLD | NEW (later) |
|---|---|---|
| Tenant onboarding | `moov-account-create`, `moov-account-onboard`, `moov-onboarding-link` | same `/functions/v1/*` on AWS Cognito client |
| KYC/KYB | onboard + `moov-account-file-*` | same |
| ToS | `moov-tos-token`, `moov-tos-accept` | same; Drop still in browser |
| Bank | `moov-bank-link-token`, `moov-bank-account-add`, micro-deposits, `moov-sync` | same |
| Capabilities | onboard/sync + `moov-underwriting` | `moov-underwriting` GET; save held |
| Wallet | `moov-readiness`, `moov-wallet-sync` | `moov-readiness` + `moov-wallet-activity` |
| Recipients | `moov-recipient-*` | public session **without** Cognito; invite still Cognito |
| Readiness | `moov-readiness` | + `moov-recipient-readiness` |

Production SPA must keep `VITE_AUTH_PROVIDER` off Cognito until a later GO.

## Remaining gaps after M5

- Live onboard `productionMoovFetch({ mode: 'onboard' })` not invoked (intentional M5 refuse)
- Signed file-view bytes (HMAC view token designed; no public documents)
- Recipient live GET of payment methods during webhook apply (apply uses supplied `liveReadiness` only)
- SQL72 still not applied
- Secrets: `MOOV_WEBHOOK_SECRET`, `MOOV_PLATFORM_ACCOUNT_ID` still absent
- Webhook not registered
- SPA still Lovable
- Freedom recipients still `awaiting_bank` (explained, not mutated)

## Recommended M6

GET-only Freedom **recipient** live inventory via `moov-recipient-readiness` against production Lambda (no mutation). Human review of why last4 `1506` is still not READY. Do not onboard. Do not register webhook unless that GO is explicit.

## Tests

`aws/tests/api-moov-m5-onboarding.test.mjs`: **14/14 pass**. Combined with production + reads + parity + providers: **77/77 pass**, 0 fail. No live Moov mutation tests.
