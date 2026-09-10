# MOOV M6.2N-A — AWS READ-ONLY RECIPIENT ACCOUNT PROBE

**Date:** 2026-09-10  
**STOP FOR REVIEW.** Diagnosis only. Do not merge. Do not reopen or resend the recipient link. Do not copy AWS secrets into Lovable.

GET-only. Temporary `account_get_only` overlay on `checksops-production-prep-api` so Lambda could `GET /accounts/ee8c608e…fc5f`. Environment blob was not sent. Original zip restored (`CodeSha256` `QeWQ4l/klRdo7IsfNTb1GYw0kWlLmxFu0DhGT0fHAvQ=`).

This VM did not call `api.moov.io` (Cloudflare 1010). Moov HTTP ran only inside Lambda via `productionMoovFetch` read mode.

No recipient onboard. No KYC/ToS/bank mutation. No transfer. No webhook register. SQL72 not applied. Money flags false. $0.00 moved. Lovable Edge was not modified.

## Identity

| Field | Value |
|---|---|
| Account | `806168576068` |
| Role | `ChecksOpsCursorCloudStaging` |
| Session | `m62na-recipient-get` |
| Region | `us-east-1` |
| Auth | Lambda invoke with Freedom **admin** Cognito sub (staff tester is `financial_unauthorized`) |

IAM was not broadened. Freedom admin MFA was not challenged (invoke uses API Gateway authorizer claims, not `USER_PASSWORD_AUTH`).

## Probe path

1. Existing live `POST /functions/v1/moov-readiness` `{ account_get_only: true }` — GET Freedom **tenant business** `60922058…de96` (OAuth control).
2. Surgical overlay so `account_get_only` + ChecksOps `recipient_id` server-derives `provider_account_id` from RDS (browser Moov ids rejected).
3. GET `/accounts/ee8c608e…fc5f` + GET capabilities (read-only).
4. Restore original zip.

Spoof `provider_account_id` → `400 untrusted_provider_config`, `liveProviderCalled=false`.

## Result — recipient `62a858ff…227b` / Moov `ee8c608e…fc5f`

| Check | Result |
|---|---|
| OAuth | **200**, access token minted |
| Account GET | **sent** |
| HTTP status | **200** |
| Account exists | **yes** |
| AWS authorized | **yes** |
| Application `aid` | `694a303b…3878` |
| Public key sha256_12 | `3ad0839428e5` |
| Origin | `https://checksops.com` |
| Mode | **production** |
| Account type | individual, not disabled/restricted |
| KYC | **unverified** |
| ToS | empty (`tos_field_keys: []`, accepted=null) |
| Capabilities | `transfers=enabled`, `send-funds=pending` |
| RDS | `awaiting_bank`, last4 `1506`, `token_used_at` null, `updated_at` `2026-09-10T17:37:32.282001+00:00` unchanged |

Same-day M6.2A GET of this account recorded send-funds currently-due `account.tos-acceptance`, `individual.address`, `individual.birthdate`, `individual.ssn`. This probe confirmed `send-funds=pending`; array-shaped `requirements` were empty on the capability object.

## Lovable Edge mismatch

Lovable Edge `moov-recipient-session` returns `502 moov_account_get_failed` for this same server-derived account after `POST /oauth2/token`. Classifier (#209) is **not live** (dummy 404 CORS still lacks `x-checksops-operator-classify`).

AWS production application **can** GET the account. Edge cannot. Edge uses Deno `MOOV_*`, not AWS Secrets Manager.

**Mismatch proven: yes.** Edge `MOOV_*` is not the working AWS production application (`694a303b` / `3ad0839428e5`), or is otherwise unauthorized for this connected account.

Do not copy AWS secrets into Lovable until reviewed. Do not reopen the pay-setup link until the Edge classifier is live or secrets are corrected under a later authorized step.

## Safety

| Check | Result |
|---|---|
| Moov resource mutations | **0** (OAuth token POST + GETs only) |
| Provider money POSTs | **0** (`moov-transfer-create` **403** `production_execution_blocked`, `liveProviderCalled=false`) |
| DB financial mutations | **0** (recipient `updated_at` unchanged) |
| Money moved | **$0.00** |
| SQL72 | **NOT_APPLIED** |
| `AWS_MOOV_ENABLED` | **false** |
| `AWS_PROVIDER_EXECUTION_ENABLED` | **false** |
| `AWS_FINANCIAL_PERMISSIONS_ACTIVATED` | **false** |
| `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED` | **false** |
| Lambda restored | **YES** |
| Lovable | **unchanged** (dummy session still 404 `This link is not valid.`) |

## GO/NO-GO

**GO for this diagnosis.**  
**NO-GO to reopen the same pay-setup link.**  
**NO-GO for KYC/ToS/bank/money.**
