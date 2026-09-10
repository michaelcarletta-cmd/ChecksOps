# MOOV M6 — FREEDOM RECIPIENT LIVE READINESS DIAGNOSIS

**Date:** 2026-09-10  
**Branch:** `cursor/moov-production-readiness-m6-a508`  
**STOP FOR REVIEW.** GET-only. Do not treat draft PR #201 as production activation.

No recipient onboard. No KYC/ToS/bank/capability mutation. No transfer. No webhook register. No secret change. SQL72 not applied. Money/onboarding/webhook-apply/Lovable-neutralized flags remain false. C1C unused. Sandbox recipient excluded. $0.00 moved.

## Safest GET-only path

Already-deployed `POST /functions/v1/moov-readiness` live-GETs the **Freedom tenant** account only. Recipients are classified from RDS. That cannot satisfy the M6 READY predicate.

M5 `moov-recipient-readiness` is **not** required and was **not** merged or activated.

M6 adds opt-in `recipient_live_gets: true` on the **existing** authenticated production-prep probe. Server derives recipient Moov account ids from `external_payment_recipients`. Browser Moov ids are rejected. Sandbox rows are skipped. C1C is denied.

| Question | Answer |
|---|---|
| M5 MERGE REQUIRED FOR THIS DIAGNOSIS | **NO** |
| M5 activated | **NO** |
| New Moov POST/PATCH/PUT/DELETE | **none** (OAuth token POST + GETs only, when probed) |

## Live probe status

This Cloud Agent AWS session token is **expired** (`ExpiredToken` on `sts:GetCallerIdentity`). Lambda overlay and authenticated Lambda invoke could not be performed from this VM.

Public `GET https://checksops.com/prep/ops/readiness` still returned **200** with:

- `AWS_PROVIDER_LIVE_READS_ENABLED=true`
- `AWS_MOOV_ENABLED=false`
- `AWS_PROVIDER_EXECUTION_ENABLED=false`
- `AWS_FINANCIAL_PERMISSIONS_ACTIVATED=false`
- `productionWebhooksRedirected=false`

Unauthenticated `POST /prep/functions/v1/moov-readiness` returned **401** `missing_cognito_token`.

RDS + live recipient Moov GETs therefore were **not** re-executed in M6. Local rows below are the last confirmed GET-only snapshot from M3b.8 (`2026-09-10T10:46:05Z`). They are **not** live Moov truth.

## Local RDS (M3b.8 snapshot — not re-queried)

Sandbox excluded from diagnosis (`f190ea55…6184`). C1C unused.

| Recipient row id (fp) | Environment | Local status | Local last4 | bank_linked_at | Moov account fp |
|---|---|---|---|---|---|
| `53a2be7e…78c5` | production | `awaiting_bank` | `1506` | `2026-08-30T19:13:38.421Z` | `d1adebb2…12db` |
| `4c1ced8c…ab38` | production | `awaiting_bank` | `1506` | `2026-08-31T20:44:55.828Z` | `bfeb279f…eecd` |
| `62a858ff…227b` | production | `awaiting_bank` | `1506` | `2026-09-02T15:05:35.512Z` | `ee8c608e…fc5f` |

Display names were not selected in M3b.8. M6 SELECT adds `display_name` for the live probe.

**Do not treat last4 `1506` or `bank_linked_at` as READY.**

## Live Moov (not collected this phase)

Per-recipient ACCOUNT / ToS / BANK / PAYMENT METHODS / CAPABILITIES live fields: **NOT COLLECTED**.

READY predicate was not applied to live payloads. No production recipient is confirmed READY.

## Classification (live)

| Class | Count |
|---|---|
| READY | **unknown (live GET not executed)** |
| others | **unknown** |

Local-only: 3 production rows remain `awaiting_bank`. That can mean stale sync, unverified bank, missing ACH credit method, or another blocker. M3b.8 did **not** GET recipient accounts.

## FIRST_TEST_RECIPIENT_AVAILABLE

**NO**

No live READY predicate result exists. Do not send money. Do not pick a candidate from last4.

## Smallest human action (after live GET)

Run the GET-only overlay probe with a valid AWS session (Environment blob **not** sent):

```
CHECKSOPS_M6_OVERLAY=I_UNDERSTAND_GET_ONLY CHECKSOPS_M6_INVOKE=1 \
  node aws/financial/scripts/m6-freedom-recipient-live-probe.mjs
```

Then, for **one** Freedom production recipient, do the first failing live class only:

| Live class | Human action (do not perform in M6) |
|---|---|
| AWAITING_KYC | Recipient completes identity verification in Moov.js / hosted flow |
| AWAITING_TOS | Recipient accepts ToS via Moov.js Drop (server must not forge `accepted=true`) |
| AWAITING_BANK | Recipient links a bank (Drop or manual); do not use sandbox |
| BANK_UNVERIFIED | Complete micro-deposits / wait for Moov verified |
| NO_ELIGIBLE_PAYMENT_METHOD | Wait for Moov to enable `ach-credit-standard` or `ach-credit-same-day` after verified bank |
| ACTION_REQUIRED | Satisfy Moov requirements / capability errors |
| RESTRICTED | Moov dashboard / support; do not workaround |
| BROKEN_LOCAL_SYNC | Live bank missing or unverified while RDS last4 is set — do **not** flip RDS to ready |

Do not onboard a new recipient until live inventory says none of the three can become READY with a smaller action.

## Local vs live

`LOCAL STATE ACCURATE`: **PARTIAL**

- Local `awaiting_bank` + last4 `1506` is internally consistent as “not ready in RDS”
- It is **not** proof of live bank verification
- Webhook is not registered, so RDS cannot catch up from Moov `bankAccount.updated` / `paymentMethod.enabled`

Do not repair local rows.

## Safety

| Check | Result |
|---|---|
| Moov provider POST count | **0 this phase** (OAuth not invoked; AWS token expired) |
| Resource mutations | **0** |
| Database financial mutations | **0** |
| Webhook changes | **0** |
| SQL72 | **NOT_APPLIED** |
| Money flags | **FALSE** |
| `AWS_MOOV_ONBOARDING_WRITES_ENABLED` | **false** (not in live ops snapshot; default false) |
| `AWS_MOOV_WEBHOOK_APPLY_ENABLED` | **false** |
| `AWS_LOVABLE_MONEY_NEUTRALIZED` | **false** |
| Money moved | **$0.00** |
| M5 merged/activated | **NO** |
| SPA cutover | **NO** |

## Tests

`aws/tests/api-moov-m6-recipient-live.test.mjs` plus production-reads + M5: **41 pass / 0 fail** for that combined run (M6 file is 7 tests). No live Moov mutation tests.

## Remaining after M6

1. Restore AWS credentials and run the GET-only overlay probe
2. Fill per-recipient live class / FIRST_TEST_RECIPIENT
3. Still do not merge M5, register webhook, apply SQL72, or enable money

## Recommended next

Complete the live GET overlay (same GET-only path). Then STOP again with filled READY counts before any M7 transfer talk.

**GO/NO-GO FOR NEXT PHASE: NO-GO**
