# Moov sandbox certification (AWS staging)

**Date:** 2026-09-04 (resume #2 — corrected platform account ID)  
**Scope:** Moov sandbox certification only — not production activation.  
**Verdict:** **BLOCKED** (account authorization still 401)

## Gate retest (fresh Secrets Manager read)

Secret: `checksops/staging/providers` (`AWSCURRENT`). No cached account ID used. Platform redaction changed from prior wrong value (`36b7…47bb` → `eb75…613b`).

| Step | Result |
|---|---|
| OAuth `POST https://api.moov.io/oauth2/token` `grant_type=client_credentials` scope `/accounts.read` | **PASS** HTTP 200 |
| OAuth with account-scoped scopes `/accounts/[account]/profile.read` + wallets/payment-methods/capabilities/transfers.read+write | **PASS** HTTP 200 (token minted; scopes echoed) |
| `GET https://api.moov.io/accounts/{MOOV_SANDBOX_PLATFORM_ACCOUNT_ID}` | **FAIL** HTTP **401**, empty body (`bodyLen: 0`) |
| Headers on GET | `Authorization: Bearer <token>`, `Accept: application/json`, `Origin: https://staging.checksops.com`, `x-moov-version: v2024.01.00` |
| Staging Lambda `/sandbox/moov/probe` (after secret reload) | auth **PASS**; `reads.account.httpStatus: 401` (redacted id `eb75…613b`) |

**Stopped here.** No account ID changes, no workarounds, no transfer attempt.

## Not continued (blocked by gate)

Capabilities → wallet → payment methods → simulated transfer → webhook lifecycle/reconciliation for this resume.

(Prior resume already certified webhook signature/idempotency against staging `/sandbox/webhooks/moov` with the configured webhook secret; that result stands but does not unblock account reads.)

## Exact authorization result to fix in Moov

The staging sandbox API key can mint OAuth tokens that *claim* account-scoped scopes for the configured platform Account ID, but Moov rejects the subsequent resource GET with **401** and an empty body.

This means either:

1. The Account ID still does not belong to the Moov application that owns these API keys, or
2. The API key/application is not permitted to read that account despite scope mint succeeding.

### Suggested Moov-side check (manual)

In Moov Dashboard → the application that owns the staging sandbox keys → open that platform account → use Moov’s API explorer / curl with the **same** public/secret key and `Origin: https://staging.checksops.com` until `GET /accounts/{id}` returns **200**. Then resume certification.

## Production remains OFF

```
AWS_PROVIDER_EXECUTION_ENABLED=false
AWS_MOOV_ENABLED=false
AWS_CHECKALT_ENABLED=false
AWS_FINANCIAL_PERMISSIONS_ACTIVATED=false
```

No production webhook/DNS/auth/data changes. `64_financial_activation_grants.sql` not applied.

## Evidence

- `/opt/cursor/artifacts/moov_account_gate_still_401.json`
- `aws/providers/results/moov_account_gate_still_401.json`
