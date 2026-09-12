# Moov production readiness — Phase M3.1

**READ-ONLY PROVIDER GATE + PRE-CREDENTIAL SAFETY REVIEW**

**Status:** STOP FOR REVIEW. Code and fixture tests only. No production change. No secret created. No flag enabled.

**Date:** 2026-09-09  
**Branch:** `cursor/moov-production-readiness-m3-1-a508`  
**M3 verdict (accepted):** PASS for dark implementation.  
**M3b:** remains **NO-GO for this agent**. A human may later create the secret and perform GET-only Freedom verification after this code is deployed.

This phase does **not** enable `AWS_PROVIDER_LIVE_READS_ENABLED`, `AWS_MOOV_ENABLED`, `AWS_PROVIDER_EXECUTION_ENABLED`, or `AWS_FINANCIAL_PERMISSIONS_ACTIVATED`. It does **not** set `PROVIDER_SECRETS_ARN`, create secrets, apply SQL 72, call Moov, move money, or change Lovable.

---

## 1. Files modified

| Path | Change |
| --- | --- |
| `aws/functions/api/providers/production/moov-holds.mjs` | `productionMoovReadsAllowed()` independent of money flags |
| `aws/functions/api/providers/production/moov-secrets.mjs` | Read vs execution secret contracts |
| `aws/functions/api/providers/production/moov-client.mjs` | Required `mode`; GET allowlist; write methods fail before I/O |
| `aws/functions/api/providers/production/moov-authz.mjs` | `authorizeMoovProductionRead` (no TOTP, no money flags) |
| `aws/functions/api/providers/production/moov-read.mjs` | Tenant-derived account GET; no `payment_transfers` required |
| `aws/functions/api/providers/production/moov-dispatch.mjs` | Read vs money dispatch split |
| `aws/functions/api/providers/production/moov-transfer.mjs` | `mode: 'execute'` on POST |
| `aws/functions/api/providers/production/moov-reconcile.mjs` | `mode: 'execute'` on GET after money attempt |
| `aws/functions/api/provider-flags.mjs` | Live-reads flag documented as GET-only |
| `aws/functions/api/providers.mjs` | Live-reads warning: GET-only, never writes |
| `aws/functions/api/providers/catalog.mjs` | Catalog notes |
| `aws/tests/api-moov-production-reads.test.mjs` | M3.1 matrix |
| `aws/financial/MOOV_PRODUCTION_SECRET_CONTRACT.md` | Read vs execution table |

No new AWS routes into `moov-disburse`, `moov-transfer-create`, `process-funded-payment`, or `initiate-wallet-funding`.

---

## 2. Read-only flag / gate design

Existing flag: `AWS_PROVIDER_LIVE_READS_ENABLED` (string `true` only). **Not enabled in M3.1.** Templates remain `"false"`.

```
productionMoovReadsAllowed =
  AWS_PROVIDER_LIVE_READS_ENABLED
  AND NOT AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED
```

Independent of `AWS_MOOV_ENABLED`, `AWS_PROVIDER_EXECUTION_ENABLED`, `AWS_FINANCIAL_PERMISSIONS_ACTIVATED`.

Invariant: live-reads true + money flags false → allowlisted GET only. Money routes return `403 production_execution_blocked` before HTTP.

OAuth `POST /oauth2/token` is the only POST in read mode (client credentials). Resource POST/PUT/PATCH/DELETE fail before any network I/O, including before the token request.

---

## 3. Exact GET operations allowed

Under `mode: 'read'`, only:

- `GET /accounts/{server-derived-account-id}`
- `GET /accounts/{id}/capabilities` and `GET /accounts/{id}/capabilities/{capability}`
- `GET /accounts/{id}/wallets` and `GET /accounts/{id}/wallets/{walletId}`
- `GET /accounts/{id}/bank-accounts`
- `GET /accounts/{id}/payment-methods`
- `GET /accounts/{id}/transfers/{already-known-transfer-id}`

`POST /functions/v1/moov-readiness` performs the account/capability/wallet/bank/method GETs. No `payment_transfers` row is required.

---

## 4. Exact methods denied (read mode, before I/O)

`POST`, `PUT`, `PATCH`, `DELETE` on Moov resource paths.

Denied AWS routes while live-reads is the only gate: `moov-transfer-create`, `moov-disburse`, `moov-wallet-fund`, `moov-recipient-create`, `moov-tos-accept`, capability/ToS/bank mutation bodies on readiness.

---

## 5. Tenant / account derivation

Cognito → application user → tenant membership (owner/admin/manager) → `payment_provider_accounts` where `provider='moov'` and `environment='production'` → `provider_account_id`. Browser Moov account ids are rejected. Cross-tenant tenant_id fails. Freedom cannot inspect C1C.

---

## 6. Read-only credential minimum

`MOOV_PUBLIC_KEY`, `MOOV_SECRET_KEY`, `MOOV_ENVIRONMENT=production`, `MOOV_ALLOWED_ORIGIN=https://checksops.com`.

Webhook secret is not required for GET. Platform account id is not required for tenant account GET.

---

## 7. Full execution credential minimum (unchanged)

`MOOV_PUBLIC_KEY`, `MOOV_SECRET_KEY`, `MOOV_PLATFORM_ACCOUNT_ID`, `MOOV_WEBHOOK_SECRET`, `MOOV_ENVIRONMENT`, `MOOV_ALLOWED_ORIGIN`.

---

## 8. Test results

Related suites including M3.1: **130 / 130 pass**. Fixture/mock HTTP only.

---

## 9. Proof transfer POST remains unreachable

With live-reads true and money flags false, `moov-transfer-create` and `moov-disburse` return `production_execution_blocked` and `processPosts === 0`. Client-level POST/PUT/PATCH/DELETE throw `read_only_method_denied` with fetchImpl never called.

---

## 10–14. Flags, secret, SQL 72, HTTP, money

Unchanged from M3 live probes. `AWS_PROVIDER_LIVE_READS_ENABLED` remains **false**. Production secret remains **absent**. SQL 72 **NOT_APPLIED**. Live Moov HTTP **0**. Money movement **0**.

---

## 15. Remaining blockers for M3b

1. Production secret does not exist (human must create; no sandbox copy).  
2. `PROVIDER_SECRETS_ARN` unset on production-prep.  
3. `AWS_PROVIDER_LIVE_READS_ENABLED` remains false until a human sets it on production-prep only.  
4. This branch must be deployed before the GET will exist in Lambda.  
5. Freedom live KYC/wallet/bank/ACH still UNKNOWN until that GET.  
6. Lovable `moov-disburse` bypass remains CRITICAL (activation blocker, not M3b).  
7. Do not use C1C as first-test destination.  
8. Do not apply SQL 72 for M3b.

---

## 16. Exact human steps for M3b

1. Merge/deploy M3.1. Confirm money flags still false.  
2. Human creates `checksops/production/providers` with production names only (read minimum at least; prefer the full six so execution stays complete but unused). Do not copy `MOOV_SANDBOX_*`.  
3. Point production-prep `PROVIDER_SECRETS_ARN` at that secret.  
4. Set **only** `AWS_PROVIDER_LIVE_READS_ENABLED=true` on production-prep. Leave money flags and sandbox false.  
5. As a Freedom owner/admin/manager Cognito user, call `POST /functions/v1/moov-readiness` with no Moov account id.  
6. Record account/KYC/ToS/capabilities/wallet/bank from the GET. Do not POST a transfer.  
7. Leave Lovable Moov and the webhook in place.

---

## 17. GO / NO-GO

| Decision | Verdict |
| --- | --- |
| M3.1 read-only gate | **PASS / GO for review** |
| This agent creating the secret or calling Moov | **NO-GO** |
| Authorized **human** creating the production secret and performing Freedom GET-only verification after deploy | **GO**, with money flags remaining false |
| First transfer / webhook redirect / Lovable shutdown | **NO-GO** |

**STOP. Do not proceed to M3b in this agent. Do not create secrets. Do not activate. Do not move money.**
