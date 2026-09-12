# MOOV M6.1 — FREEDOM RECIPIENT LIVE GET-ONLY READINESS PROBE

**Date:** 2026-09-10  
**Branch:** `cursor/moov-production-readiness-m6-a508`  
**STOP FOR REVIEW.** GET-only. Do not merge PR #201 or #202.

AWS session restored via Cursor OIDC `assume-role-with-web-identity` to `ChecksOpsCursorCloudStaging` in account `806168576068` (`us-east-1`). Session name `checksops-m61-live-get`.

Surgical overlay of three read files onto `checksops-production-prep-api` (`UpdateFunctionCode` only). Environment blob was **not** sent. Original zip restored. `CodeSha256` matches pre-probe `ItJiyRVnWJZ2DIUce3ZhalFn3LrZrkKMSXdpP6MJo50=`.

No recipient onboard. No KYC/ToS/bank mutation. No transfer. No webhook register. SQL72 not applied. Money flags false. $0.00 moved.

## Identity

| Field | Value |
|---|---|
| Account | `806168576068` |
| Role | `ChecksOpsCursorCloudStaging` |
| Session | `checksops-m61-live-get` |
| Region | `us-east-1` |

IAM was not broadened.

## Probe path

Authenticated Lambda invoke of `POST /functions/v1/moov-readiness` with `{ recipient_live_gets: true }`. Tenant derived from Freedom membership (Cognito sub of the Freedom admin). Browser Moov/platform ids rejected (`400 untrusted_provider_config`). C1C `tenant_id` denied (`403 cross_tenant_denied`). Sandbox recipient skipped.

Moov HTTP ran only inside Lambda. This VM did not call `api.moov.io`.

## Recipients checked: 3 production (1 sandbox excluded)

| Recipient fp | Moov account fp | Live account | KYC | ToS | Bank | ACH credit PM | Caps | READY | First failing class | Local vs live |
|---|---|---|---|---|---|---|---|---|---|---|
| `53a2be7e…78c5` | `d1adebb2…12db` | production individual, not disabled/restricted | **unverified** | not accepted | GET **403** (unread) | unread (403) | GET 403 | **false** | **AWAITING_KYC** | **CONTRADICTORY** |
| `4c1ced8c…ab38` | `bfeb279f…eecd` | production individual, not disabled/restricted | **unverified** | not accepted | exists, status **new** / not verified, last4 `1506` | `ach-credit-standard` + `ach-credit-same-day` present | `transfers=enabled`, `send-funds=pending` | **false** | **AWAITING_KYC** | **INCOMPLETE** |
| `62a858ff…227b` | `ee8c608e…fc5f` | production individual, not disabled/restricted | **unverified** | not accepted | exists, status **new** / not verified, last4 `1506` | `ach-credit-standard` + `ach-credit-same-day` present | `transfers=enabled`, `send-funds=pending` | **false** | **AWAITING_KYC** | **INCOMPLETE** |

Sandbox `3269bd10…2562` / `f190ea55…6184` was excluded. C1C unused.

last4 `1506` and `bank_linked_at` were **not** treated as READY.

## FIRST_TEST_RECIPIENT_AVAILABLE

**NO**

READY_COUNT **0**. No safest candidate. Do not send money.

Closest live inventories are `4c1ced8c…ab38` and `62a858ff…227b` (banks and PMs readable). Both still fail KYC first.

## Minimum human action (do not perform in this phase)

Complete **KYC / identity verification** for **one** existing Freedom production recipient through the legitimate Moov hosted / Moov.js flow.

Suggested existing target (most recently linked, live bank readable): recipient `62a858ff…227b` / Moov `ee8c608e…fc5f`.

After KYC, the same recipient still needs:

1. ToS acceptance via Moov.js Drop (do not forge `accepted=true`)
2. Bank verification (live status is `new`, not `verified` — micro-deposits or Moov verification)

Do **not** create a new recipient to bypass these blockers.

## Local vs live

Local RDS `awaiting_bank` + last4 `1506` is **not** an accurate READY picture.

- `4c1ced8c…ab38` and `62a858ff…227b`: local last4 matches live last4, and the bank is not verified, so `awaiting_bank` is directionally true, but KYC and ToS also fail → **INCOMPLETE**
- `53a2be7e…78c5`: local last4/`bank_linked_at` vs live bank GET **403** (no readable live bank) plus unverified KYC/ToS → **CONTRADICTORY**

RDS was not repaired.

## Safety

| Check | Result |
|---|---|
| Moov resource mutations | **0** (OAuth token POST + GETs only) |
| Provider money POSTs | **0** (`moov-transfer-create` / `moov-disburse` **403** `production_execution_blocked`, `liveProviderCalled=false`) |
| DB financial mutations | **0** |
| Money moved | **$0.00** |
| SQL72 | **NOT_APPLIED** (`financialActivationSqlApplied=false`) |
| `AWS_MOOV_ENABLED` | **false** |
| `AWS_PROVIDER_EXECUTION_ENABLED` | **false** |
| `AWS_FINANCIAL_PERMISSIONS_ACTIVATED` | **false** |
| `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED` | **false** |
| Webhook registration | unchanged (`productionWebhooksRedirected=false`) |
| M5/#201 | OPEN draft, **unmerged** |
| M6/#202 | OPEN draft, **unmerged** |
| Lambda restored | **YES** (`CodeSha256` match) |
| Flags unchanged | **YES** |
| Restored Lambda still ignores `recipient_live_gets` | **YES** (`live_recipients` absent) |

## Tests

After restore: `api-moov-m6-recipient-live.test.mjs` + production-reads + production: **54/54 pass**, 0 fail.

## GO/NO-GO

**NO-GO for first controlled transfer preparation.** No Freedom production recipient is live READY.
