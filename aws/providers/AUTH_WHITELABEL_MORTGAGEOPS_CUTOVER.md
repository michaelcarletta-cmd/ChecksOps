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
| CheckOps login (EMAIL_OTP) | `/login` | **PASS** | Cognito `/auth/passwordless/*` + `establishCognitoSession` |
| CheckOps login (passkey) | `/login` | **PASS** | Cognito WebAuthn on HTTPS staging only; fail-closed elsewhere |
| CheckOps password (master UAT) | `/login` | **PASS** | Staging-only password path for activated master principal |
| CheckOps forgot / confirm | `/forgot-password`, reset UI | **PASS** | Cognito forgot/confirm; Tester mailbox policy |
| WhiteLabel login (EMAIL_OTP) | `/{slug}/login`, custom domain `/login` | **PASS** | Cognito OTP + tenant membership gate via `WhiteLabelApp` |
| WhiteLabel login (passkey) | same | **PASS** | Same Cognito WebAuthn; tenant membership after hydrate |
| MortgageOps login (EMAIL_OTP) | `/mortgage-ops/login` | **PASS** | Portal-scoped session + role gate (`mortgage_agent` / `admin`) |
| MortgageOps login (passkey) | `/mortgage-ops/login` | **PASS** | Passkey tokens → mortgage session key / mortgage client |
| MortgageOps logout / isolation | desk session | **PASS** (code) | Isolated key; CheckOps sign-out must not clear mortgage key |
| Homeowner `/h/upload` OTP | `/h/upload` | **PASS** | Dedicated AWS OTP functions (no Cognito SPA session) |
| Passkey manager (settings) | Account security | **PASS** | Cognito list/register/delete on HTTPS staging |
| Hire mortgage agent | Admin Mortgage Ops | **PARTIAL** | Class A `hire-mortgage-agent` Cognito bridge implemented; **Lambda deploy + live hire UAT blocked** (invalid AWS STS in this agent env) |
| Admin mortgage password reset | Admin Mortgage Ops | **PARTIAL** | Routes to Cognito forgot; Tester delivery rules |
| TOTP / step-up MFA | Settings / financial gates | **PARTIAL** | Explicit staging stub; Cognito MFA not provisioned; production flags remain OFF |
| In-session change password | Settings | **PARTIAL** | Staging UI points to Cognito forgot / OTP; no `updateUser` password path |
| Legacy `/auth` password page | redirected → `/login` | **N/A** | SPA redirects away |
| Signup | CheckOps signup | **PASS** (disabled) | `signUp` returns disabled on AWS staging (intentional) |
| Production Supabase Auth at runtime | any | **PASS** (absent) | When `VITE_AUTH_PROVIDER=cognito`, SPA uses AWS client — no live Supabase Auth calls for login/OTP/session |

### Overall: **PARTIAL**

Primary remaining blockers for a full PASS scorecard:

1. **Refresh AWS STS credentials** and redeploy API Lambda so `hire-mortgage-agent` is live.
2. **Live UAT** on `https://staging.checksops.com`: CheckOps / WhiteLabel / MortgageOps login, OTP, logout, cross-portal isolation, role denial, passkey register/sign-in (HTTPS only).
3. Cognito MFA / financial step-up remains deferred (acceptable while `AWS_FINANCIAL_PERMISSIONS_ACTIVATED=false`).

## Evidence (automated)

```text
node --test aws/tests/portal-session-isolation.test.mjs \
  aws/tests/auth-embed-parity.test.mjs \
  aws/tests/passkey-session-handoff.test.mjs \
  aws/tests/class-a-final.test.mjs
```

Staging API smoke (no credentials): `POST /auth/passwordless/start` → HTTP 200 `EMAIL_OTP` challenge against  
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
