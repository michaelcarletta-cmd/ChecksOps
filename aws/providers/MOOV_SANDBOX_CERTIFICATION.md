# Moov sandbox certification (AWS staging)

**Date:** 2026-09-04 (resume #3 — allowed domain `https://staging.checksops.com`)  
**Scope:** Moov sandbox certification only — not production activation.  
**Verdict:** **PASS**

## Authorization gate

Secret: `checksops/staging/providers` (`AWSCURRENT`). Platform account matches the confirmed ChecksOps Test Mode ID (`36b7…47bb`, begins `36B79`, ends `47BB`). Origin: `https://staging.checksops.com`.

| Step | Result |
|---|---|
| OAuth `client_credentials` (account-scoped scopes) | **PASS** |
| `GET /accounts/{platform}` with `Origin: https://staging.checksops.com` | **PASS** HTTP **200** (`displayName=ChecksOps`, verified business) |
| Wallets | **PASS** (1 active) |
| Payment methods | **PASS** (wallet + ACH debit/credit + RTP types) |
| Capabilities | **PASS** (`transfers:enabled`; Moov also labels `production-app:enabled` on this Test Mode account — ChecksOps production execution flags remain **false**) |

Agent-VM direct calls to `api.moov.io` later hit Cloudflare `1010`; live proof continued via `checksops-staging-api` Lambda egress.

## Certification sequence (staging harness)

| Step | Result |
|---|---|
| `POST /sandbox/moov/probe` | **PASS** — account/wallets/paymentMethods/capabilities HTTP 200; pairing `ach_debit_to_wallet` |
| Minimal sandbox transfer ($0.01) | **PASS** — `sandboxHttpCalled=true`, `productionExecution=false`, status `provider_pending` |
| Transfer retrieve | **PASS** — provider status `pending`; listed transfer count includes created id |
| Transfer idempotent replay | **PASS** — `duplicate=true`, no second provider HTTP |
| Webhook valid signature | **PASS** — accepted; `applied=false`; spoofed `tenant_id` ignored |
| Webhook replay | **PASS** — `duplicate=true` |
| Webhook bad signature / expired timestamp | **PASS** — `401 invalid_signature` / `401 timestamp_outside_window` |
| `POST /sandbox/reconcile` | **PASS** — report-only; `autoCorrected=false`; `compared=1`; no findings |
| Cross-tenant (C1C retrieve Freedom op) | **PASS** — `403 cross_tenant_denied` |
| Isolation gate | **PASS** — `productionIdOverlap=false`; Moov HTTP allowed via sandbox keys only |

## Harness fix included

Probe previously reused the `/accounts.read` list bearer for account-scoped GETs (Moov **403**). It now mints per-scope tokens and prefers ACH-debit → wallet payment-method pairing for transfer mapping.

## Production remains OFF

```
AWS_PROVIDER_EXECUTION_ENABLED=false
AWS_MOOV_ENABLED=false
AWS_CHECKALT_ENABLED=false
AWS_FINANCIAL_PERMISSIONS_ACTIVATED=false
AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED=true
AWS_PROVIDER_WEBHOOK_DRY_RUN=true
```

`POST /providers/moov/status` → `liveProviderCalled=false` (local RDS snapshot only).  
No production webhook/DNS/auth/data changes. `64_financial_activation_grants.sql` not applied. Production Supabase/Lovable Moov integration untouched.

## Evidence

- `/opt/cursor/artifacts/moov_sandbox_certification_pass.json`
- `/opt/cursor/artifacts/moov_account_gate_200.json`
- `aws/providers/results/moov_sandbox_certification_pass.json`
