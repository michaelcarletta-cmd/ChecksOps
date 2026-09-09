# Moov production readiness — Phase M3b

**DEPLOY READ-ONLY GATE + HUMAN-CONTROLLED PRODUCTION READ VERIFICATION**

**Status:** STOP FOR REVIEW. M3.1 is deployed to production-prep. Money flags remain false. Live-reads remain false. Production secret does **not** exist. **No production Moov HTTP.**

**Date:** 2026-09-09  
**Branch:** `cursor/moov-production-readiness-m3b-a508`  
**M3.1 verdict (accepted):** PASS.  
**M3b live GET:** **NOT PERFORMED** — human secret `checksops/production/providers` is absent.

This phase did **not** enable `AWS_MOOV_ENABLED`, `AWS_PROVIDER_EXECUTION_ENABLED`, `AWS_FINANCIAL_PERMISSIONS_ACTIVATED`, or `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED`. It did **not** create production secrets, copy sandbox keys, apply SQL 72, move money, redirect webhooks, or change Lovable.

---

## 1. M3.1 deployment SHA / version

| Item | Value |
| --- | --- |
| Git SHA deployed | `feb813af8bc4deb05cca53bfc618e5f17e515fd0` |
| M3.1 parent SHA | `974f98c6e96ae21d36114aecb758fb5da30dbb16` |
| Function | `checksops-production-prep-api` |
| CodeSha256 | `nnTP3XZpEI+pfmKEAhgKI/s6nVNa9ZTCIGd9JGRSV94=` |
| Zip sha256 | `9e74cfdd7669108fa97e628402180a23fb3a9d535af594c220677d24645257de` |
| LastModified | `2026-09-09T21:42:06Z` |
| Artifact | `s3://checksops-production-prep-artifacts-806168576068/checksops-production-prep-api.zip` |

Deploy method: S3 zip + `UpdateFunctionCode` only. Environment variables were **not** modified.

Additional hardening in this SHA: on `CHECKSOPS_ENV=production-prep`, `moov-transfer-create` and `moov-disburse` return `403 production_execution_blocked` **before** identity, RDS, or provider HTTP, even while live-reads is false. Staging sandbox dispatch is unchanged.

Post-deploy inventory names now include `MOOV_PLATFORM_ACCOUNT_ID` and `MOOV_ALLOWED_ORIGIN` (M3.1 contract), replacing the previous live `MOOV_ACCOUNT_ID` inventory name.

---

## 2. production-prep Lambda code version / hash

See table above. Source file sha256:

| File | sha256 |
| --- | --- |
| `moov-dispatch.mjs` | `237ebb6c14069388117d98c7e039f80df664f3c644e267e5230ca3409442cac6` |
| `moov-holds.mjs` | `750e4e60c48eb4e2e0841041a02e9c07ca98f410cdfa7057652a8ae14281e7db` |
| `moov-client.mjs` | `a6337e2b5375be616a039bdf9e0f601af307368b5726671ad2fb3965a54c9ede` |
| `moov-read.mjs` | `a617196a66fbf5df4996a347888c821c8b1736d96316d1f6a5fb99aab31d5f66` |

---

## 3. Live-read flag state

`AWS_PROVIDER_LIVE_READS_ENABLED=false`

Not enabled. Step 4 was **not** started because Step 2 (human secret) is incomplete.

---

## 4. All money flag states

| Flag | Value |
| --- | --- |
| `AWS_MOOV_ENABLED` | **false** |
| `AWS_PROVIDER_EXECUTION_ENABLED` | **false** |
| `AWS_FINANCIAL_PERMISSIONS_ACTIVATED` | **false** |
| `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED` | **false** |

Verified from Lambda configuration, `/prep/ops/readiness`, `/prep/sandbox/status`, and money-route hold snapshot. Staging was **not** overlaid (`AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED` remains true only on staging).

Observed preexisting **non-money** write flags (not changed): `AWS_WRITES_ENABLED=true`, workflow/storage/application writes true. Money routes still fail closed before `withIdentityWrite`.

---

## 5. Secret contract status — names / booleans only

**Secret does not exist.** `DescribeSecret` for `checksops/production/providers` → `ResourceNotFoundException`.

`PROVIDER_SECRETS_ARN` is **unset**.

| Name | configured |
| --- | --- |
| `MOOV_PUBLIC_KEY` | false |
| `MOOV_SECRET_KEY` | false |
| `MOOV_PLATFORM_ACCOUNT_ID` | false |
| `MOOV_WEBHOOK_SECRET` | false |
| `MOOV_ENVIRONMENT` | false |
| `MOOV_ALLOWED_ORIGIN` | false |

**READ-CONTRACT COMPLETE:** no  
**FULL EXECUTION-CONTRACT COMPLETE:** no  

This agent did not generate, guess, print, or copy `MOOV_SANDBOX_*` values.

---

## 6–12. Freedom / Moov live GET fields

**Not available.** Production Moov GET was not authorized without the human secret.

RDS **local snapshot** (not live Moov; do not treat as sender truth):

| Field | RDS only |
| --- | --- |
| Freedom production account row | present (`provider_account_id` present; value not printed) |
| Account type | `business` |
| Onboarding | `active` |
| Verification / KYC cache | `verified` |
| KYB | not separately stored; account type is business |
| ToS accepted (local timestamp present) | yes |
| Wallet | present, `operating` / `active` |
| Wallet balance (live) | **not read** |
| Own payment method | one row: `verified` / `connected`, `can_send` + `can_receive` |
| ACH send (local cache) | `can_ach_credit=true` |
| ACH collect (local cache) | `can_ach_debit=false` |
| Capabilities from Moov | **not read** |
| Requirements / action_required from Moov | **not read** |

---

## 13. Sender readiness verdict

**BLOCKED** for live Moov sender verification.

Reason: production credentials are absent, live-reads is false, and no GET `/accounts/{id}` ran. RDS cache is **not** a substitute for Moov-reported capabilities, KYC/KYB, wallet balance, or requirements.

---

## 14. Existing controlled recipient readiness

**RECIPIENT_NOT_CONFIRMED**

Freedom `external_payment_recipients` (Moov): 4 rows. Onboarding status for all: `awaiting_bank`. None verified. C1C was not used.

A Freedom-owned verified `payment_provider_methods` row exists (`external_recipient_id` null). That is the sender’s own method, not a distinct verified recipient. First-transfer destination remains unconfirmed. Nobody was onboarded.

---

## 15. Production GET count

**0**

---

## 16. Production POST count

**0** (no Moov resource POST, no OAuth token request)

Money-route proofs returned `production_execution_blocked` with `liveProviderCalled: false` before any provider I/O (Lambda invoke and unauthenticated CloudFront POST).

---

## 17. Financial / database mutations

**None.** Identity and `/data/query` used read-only transactions (`ROLLBACK`). SQL 72 column probe failed because the column does not exist. No `payment_transfers` insert. No recipient/bank/ToS/capability writes.

---

## 18. SQL 72 status

**NOT_APPLIED**

Live proof: `SELECT provider_http_attempted_at FROM payment_transfers` → `column "provider_http_attempted_at" does not exist`. File `aws/financial/sql/72_moov_production_intent.sql` remains unapplied. Hold snapshot also reports `sql72: NOT_APPLIED`.

---

## 19. Lovable status

**Unchanged.** This phase did not disable Lovable, rotate Lovable secrets, or redirect the Moov webhook.

---

## 20. Remaining blockers before first controlled transfer

1. Human creates `checksops/production/providers` with at least the read contract (`MOOV_PUBLIC_KEY`, `MOOV_SECRET_KEY`, `MOOV_ENVIRONMENT=production`, `MOOV_ALLOWED_ORIGIN=https://checksops.com`). Do not copy sandbox values.
2. Point production-prep `PROVIDER_SECRETS_ARN` at that secret. Re-verify money flags still false.
3. Set **only** `AWS_PROVIDER_LIVE_READS_ENABLED=true`. Prove transfer/disburse still `production_execution_blocked`.
4. Authenticated Freedom owner/admin/manager `POST /functions/v1/moov-readiness` (no browser Moov account id). Production-prep Cognito has a linked Freedom **admin**; HTTP JWT must come from that pool (`us-east-1_h00WorYMT`), not the staging sub.
5. Live GET must classify sender as `READY_AS_SENDER` or list exact missing Moov requirements. Do not remediate in that GET phase.
6. A Freedom-controlled **verified** recipient still does not exist (`awaiting_bank` only). Do not onboard; do not use C1C.
7. SQL 72, Lovable neutralization, and money flags remain **out of scope** until a later authorized phase.

---

## 21. GO / NO-GO for the next phase

**NO-GO** for SQL 72, Lovable neutralization, money-flag enablement, or any transfer POST.

**GO** only to resume this same M3b GET sequence **after** a human creates the production secret. Until then, live-reads must stay false and `PROVIDER_SECRETS_ARN` must stay unset.

---

## Step 1 evidence (completed)

- `/prep/health` → `200` `environment=production-prep` `status=ok`
- Live-reads false; all four money flags false
- `POST /functions/v1/moov-transfer-create` → `403 production_execution_blocked` `liveProviderCalled=false`
- `POST /functions/v1/moov-disburse` → `403 production_execution_blocked` `liveProviderCalled=false`

## Steps 2–6 (stopped)

Human secret missing. Did not connect ARN. Did not enable live-reads. Did not call Moov.

## Post-GET safety (vacuous + verified holds)

Zero transfer/funding/recipient/capability/bank/ToS POSTs. Zero money movement. SQL 72 still not applied. Money flags still false. Lovable unchanged. Webhook unchanged.
