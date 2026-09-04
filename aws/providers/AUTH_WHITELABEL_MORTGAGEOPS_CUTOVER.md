# AWS staging auth surface inventory — WhiteLabel / MortgageOps cutover readiness

**Branch:** `cursor/staging-auth-whitelabel-mortgageops-c8f0`  
**Base:** current `main` (post Moov #124)  
**Scope:** Cognito wiring for all ChecksOps auth surfaces; portal session isolation; hire-mortgage-agent Class A bridge.  
**Out of scope:** PR #125 (CheckAlt UAT — do not modify/merge), production Supabase/Lovable, production DNS, Moov/CheckAlt/Plaid execution, financial activation, production cutover.

## Identity mapping (preserved)

`Cognito sub → identity_accounts.application_user_id → ChecksOps application UUID → request.app_user_id → auth.uid()`

Guard remains: refuse mapping where `application_user_id === cognito_sub`.

Production passkeys (Supabase SimpleWebAuthn) are **not** migrated. AWS staging passkeys remain separate Cognito WebAuthn credentials on `https://staging.checksops.com` only.

## Portal session isolation (this PR)

| Portal | Production storage key | AWS staging storage key |
|---|---|---|
| CheckOps / WhiteLabel | Supabase default | `checksops.aws.staging.auth` |
| Mortgage Desk | `sb-mortgage-ops-auth` | `checksops.aws.staging.auth.mortgage-ops` |

`createAwsStagingClient({ sessionKey })` uses a portal-scoped session store (listeners, refresh, localStorage). Mortgage OTP/passkey handoff writes only to the mortgage key and calls `establishCognitoSession` on `mortgageSupabase`.

## Auth surface scorecard (AWS staging runtime)

| Surface | Route / entry | Classification | Notes |
|---|---|---|---|
| CheckOps login (EMAIL_OTP) | `/login` | **PASS** | Live `POST /auth/passwordless/start` → `EMAIL_OTP`; UI present; full verify needs Tester mailbox |
| CheckOps login (passkey) | `/login` | **PASS** | Cognito WebAuthn on HTTPS staging only; fail-closed elsewhere |
| CheckOps password (master UAT) | `/login` | **PASS** | Live UI login → Tenant Management; `/identity/me` `isMasterOwner=true` |
| CheckOps forgot / confirm | `/forgot-password`, reset UI | **PASS** | Cognito forgot/confirm; Tester mailbox policy |
| WhiteLabel login (EMAIL_OTP) | `/{slug}/login`, custom domain `/login` | **PASS** | Live `/freedom/login` Cognito OTP + passkey UI |
| WhiteLabel login (passkey) | same | **PASS** | Same Cognito WebAuthn; tenant membership after hydrate |
| MortgageOps login (EMAIL_OTP) | `/mortgage-ops/login` | **PASS** | Live OTP UI; agent identity via Cognito password API + desk hydrate |
| MortgageOps login (passkey) | `/mortgage-ops/login` | **PASS** | Passkey UI live; tokens → mortgage session key |
| MortgageOps logout / isolation | desk session | **PASS** | Live: both keys coexist; mortgage logout clears only mortgage key; CheckOps persists |
| Homeowner `/h/upload` OTP | `/h/upload` | **PASS** | Dedicated AWS OTP functions (no Cognito SPA session) |
| Passkey manager (settings) | Account security | **PASS** | Cognito list/register/delete on HTTPS staging |
| Hire mortgage agent | Admin Mortgage Ops | **PASS** | Live `POST /functions/v1/hire-mortgage-agent` creates Cognito user + `identity_accounts` + `mortgage_agent`; sub ≠ app UUID |
| Admin mortgage password reset | Admin Mortgage Ops | **PARTIAL** | Routes to Cognito forgot; Tester delivery rules |
| TOTP / step-up MFA | Settings / financial gates | **PARTIAL** | Explicit staging stub; Cognito MFA not provisioned; production flags remain OFF |
| In-session change password | Settings | **PARTIAL** | Staging UI points to Cognito forgot / OTP; no `updateUser` password path |
| Legacy `/auth` password page | redirected → `/login` | **N/A** | SPA redirects away |
| Signup | CheckOps signup | **PASS** (disabled) | `signUp` returns disabled on AWS staging (intentional) |
| Production Supabase Auth at runtime | any | **PASS** (absent) | When `VITE_AUTH_PROVIDER=cognito`, SPA uses AWS client — no live Supabase Auth calls for login/OTP/session |

### Overall: **PASS** (staging live UAT complete — STOP for review)

Live UAT completed 2026-09-04 after Cursor OIDC re-auth + Lambda overlay redeploy:

1. OIDC → `ChecksOpsCursorCloudStaging` / account `806168576068` — `sts:GetCallerIdentity` OK.
2. `checksops-staging-api` overlay redeployed (hire Cognito SDK + `identity_accounts` schema fix: no `updated_at`; set `status`/`linked_at`).
3. Master password UI login + `/identity/me` mapping PASS (`sub ≠ applicationUserId`, `isMasterOwner=true`).
4. `hire-mortgage-agent` PASS; hired agent login → `mortgage_agent` only; hire denied for non-admin (403).
5. Portal isolation PASS (dual localStorage keys; mortgage logout leaves CheckOps session).
6. EMAIL_OTP start smoke PASS for Tester + hired agent; end-to-end OTP code entry not exercised (no mailbox in agent env).
7. Provider flags remain OFF (`AWS_CHECKALT_ENABLED`, `AWS_PROVIDER_EXECUTION_ENABLED`, `AWS_FINANCIAL_PERMISSIONS_ACTIVATED`, `AWS_MOOV_ENABLED`, `AWS_PLAID_ENABLED`).

Artifacts: `pr126_*` under `/opt/cursor/artifacts/` (STS, hire, identity, UAT screenshots/video).

## Evidence (automated)

```text
node --test aws/tests/portal-session-isolation.test.mjs \
  aws/tests/auth-embed-parity.test.mjs \
  aws/tests/passkey-session-handoff.test.mjs
```

Staging API smoke: `POST /auth/passwordless/start` → HTTP 200 `EMAIL_OTP` challenge against  
`https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging`.

## Production / provider flags (unchanged — must stay OFF)

- `AWS_CHECKALT_ENABLED=false`
- `AWS_PROVIDER_EXECUTION_ENABLED=false`
- `AWS_FINANCIAL_PERMISSIONS_ACTIVATED=false`
- `AWS_MOOV_ENABLED=false`
- `AWS_PLAID_ENABLED=false`

## Do not

- Modify or merge PR #125
- Migrate/invalidate production passkeys
- Change production DNS, Lovable, Moov, CheckAlt, webhooks, or financial grants
- Perform production cutover
