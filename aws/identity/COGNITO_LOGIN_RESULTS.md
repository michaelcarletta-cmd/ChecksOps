# Staging Cognito login / password activation results

Temporary Lambda `checksops-staging-cognito-login-c48b` was deleted with its admin-secret IAM role. API Policy4 still has only the `checksops` secret. RLS remains **165** select / **127** write policies, **165** tables enabled, **47** identity FKs, **83** Freedom claims, **97** NULL-org claims. `default_transaction_read_only` remains `on`.

No invitation, password-reset, or forgot-password emails were sent. No Moov/CheckAlt/Plaid/Resend/payment/webhook/DNS/Storage/frontend/production changes. Ninth UUID and the disabled probe were not modified.

## Pool / client configuration (after this phase)

| Setting | Before | After |
| --- | --- | --- |
| Pool | `us-east-1_vPmQ7cL1F` | unchanged |
| Client | `71bb7a192cbl6o6s8m259tl589` | unchanged |
| Auth flows | SRP, refresh, admin password | **+ `ALLOW_USER_PASSWORD_AUTH`** (SRP/refresh/admin kept) |
| Password policy | 12+, upper/lower/number/symbol, temp 7 days | unchanged |
| Recovery | `verified_email` | unchanged |
| Email | `COGNITO_DEFAULT` | unchanged (not Resend) |
| MFA | OFF | unchanged |
| UnusedAccountValidityDays | 7 | unchanged |
| Tokens | ID/access 60 minutes, refresh 30 days, revocation on | restored to the same after a 5-minute expiry probe |
| OAuth / hosted UI | disabled | unchanged |
| JWT authorizer | iss pool, aud client | unchanged |

## Eight users

| Email | Application UUID | Cognito sub | Cognito status | Notes |
| --- | --- | --- | --- | --- |
| asukanick@condition1commercial.com | `3af0234c-de1b-4819-938d-fa4f9390811b` | `84185468-a041-70e7-6f61-c6c63f4aff19` | FORCE_CHANGE_PASSWORD, enabled | mapping only |
| barzziniconstructiongroup@gmail.com | `e2ad0849-c6b6-4f4a-a68a-8c52f563c6fd` | `34a8e428-6071-70b2-92de-fc7e3fd74f14` | FORCE_CHANGE_PASSWORD, enabled | mapping only |
| checksops-tester@freedomadj.com | `abd3c2a0-6dc0-4680-92dd-a013e1141c91` | `c4386408-60e1-70e2-abb6-e6194e8e635f` | **CONFIRMED**, enabled | full lifecycle |
| claims@freedomadj.com | `b100f05d-9e81-4a7b-b9cc-9baf173131d9` | `2498c4b8-f0a1-701b-da4b-a1f5c79f675a` | FORCE_CHANGE_PASSWORD, enabled | mapping only |
| lhogan@condition1commercial.com | `0160a5f3-30a4-4aba-8e54-6529f1ceb0d4` | `5458c4f8-1081-701d-10cf-02a993311263` | FORCE_CHANGE_PASSWORD, enabled | mapping only |
| mcarletta@freedomadj.com | `7dbb3009-f059-4767-b5dc-1c5c72379330` | `54a8b4c8-60d1-7028-cfbb-0eb2baee5592` | FORCE_CHANGE_PASSWORD, enabled | mapping only |
| payments@condition1commercial.com | `fd857564-9534-4b0f-95ac-624ed1273725` | `e418f488-4011-7046-5a09-3f8b51140899` | **CONFIRMED**, enabled | full lifecycle |
| support@homeheropros.com | `30d0505c-bcfa-4732-81fd-869dc46da5dd` | `14187428-90d1-70f2-95f3-10844b186461` | FORCE_CHANGE_PASSWORD, enabled | mapping only |

All original application UUIDs are unchanged. No `cognito_sub` equals `application_user_id`. Probe sub is absent from `identity_accounts`.

## Emails sent

**None.** `ForgotPassword` was not called on any real mailbox. `kms:CreateKey` is denied, so a CustomEmailSender interceptor could not be installed. `AdminSetUserPassword` (no email) was used for controlled activation/reset.

`ForgotPassword` on a nonexistent address returned existence-suppressing `CodeDeliveryDetails` (`PreventUserExistenceErrors=ENABLED`). `ConfirmForgotPassword` with a bogus code was rejected (`ExpiredCodeException`) and did not change the password.

Intended future delivery for a staging frontend remains Cognito `verified_email` via `COGNITO_DEFAULT`, not Resend.

## Lifecycle tests

**First-password-change (Freedom Tester and C1C payments admin):** `FORCE_CHANGE_PASSWORD` → public `USER_PASSWORD_AUTH` → `NEW_PASSWORD_REQUIRED` → `CONFIRMED`. Cognito `sub` unchanged.

**Normal login:** public `USER_PASSWORD_AUTH` with the new password succeeded for both users. ID token `aud`/`iss` match the staging client/pool. `token_use=id`.

**Refresh:** `REFRESH_TOKEN_AUTH` returned a new ID token with the same `sub`.

**Sign-out / revocation:** `GlobalSignOut` and `RevokeToken` succeeded. HTTP API JWT authorizer still accepted the unexpired **ID** token until `exp` (signature-only JWT authorizer; it does not consult Cognito revocation). Refresh tokens were revoked. A later password login (admin-set, no email) issued new tokens with the same `sub` and ChecksOps UUID.

**Expired token:** client ID/access lifetime was temporarily 5 minutes (Cognito rejected 1 minute). After expiry, `/identity/me` and `/authorization/jwks-check` returned **401**. Lifetime restored to 60 minutes.

## `/identity/me`

| User | HTTP | authUid | roles | tenants | sub equals UUID |
| --- | ---: | --- | --- | --- | --- |
| Freedom Tester | 200 | `abd3c2a0-…1c91` | staff | Freedom operator | false |
| C1C payments admin | 200 | `fd857564-…3725` | admin | C1C admin | false |

Spoofed ninth/C1C/Freedom user and tenant IDs in query/headers were ignored.

## Token / JWKS

| Case | Result |
| --- | --- |
| Unauthenticated `/identity/me` | 401 |
| Malformed bearer | 401 |
| Wrong issuer | 401 |
| Expired ID token | 401 |
| Access token on `/authorization/jwks-check` (`token_use=id` verifier) | 401 `Token use not allowed: access` |
| Access token on `/identity/me` (HTTP API JWT authorizer) | 200, still mapped to ChecksOps UUID not the sub |
| Valid ID token JWKS check | 200, 2 keys, `verifiedInLambda: true` |

## RLS isolation regression

| Identity | Claims n / Freedom / NULL | Freedom checks | C1C tenant | Freedom tenant |
| --- | ---: | ---: | ---: | ---: |
| Freedom staff Tester | 83 / 83 / **0** | 182 | 0 | 1 |
| C1C payments admin | 0 / 0 / **0** | 0 | 1 | 0 |
| Other C1C admins | 0 / 0 / **0** | 0 | 1 | 0 |
| Master | 180 / 83 / **97** | 182 | 1 | 1 |
| Barzzini / Home Hero / mortgage agent | 0 / 0 / **0** | 0 | 0 | 0 |
| Ninth UUID | 0 | 0 | 0 tenants | |
| Unauthenticated | 0 | 0 | | |
| Cognito sub used as `request.app_user_id` | 0 claims, 0 tenants for all eight | | | |

Policies were not weakened.

## Ninth UUID and probe

- Ninth `dd24eea5-5d12-47d1-999e-d5930c278b7d`: still pending, no email, no Cognito, no profile, no `tenant_users`, admin+staff roles unchanged, RLS fail-closed.
- Probe user remains **disabled**. `AdminInitiateAuth` → `NotAuthorizedException`. Probe sub is not in `identity_accounts`.

## Ready for staging frontend?

**Yes, for a staging frontend only**, with these limits:

- Wire the staging app to this pool/client (`USER_PASSWORD_AUTH` or SRP, refresh, forgot-password APIs).
- Two users are `CONFIRMED` and can complete email/password login.
- Six users remain `FORCE_CHANGE_PASSWORD` (7-day unused validity). Do not bulk-invite them yet.
- Forgot-password on a real mailbox will send Cognito default email; that was not exercised.
- Do **not** cut over production frontend, DNS, or Lovable/Supabase.
