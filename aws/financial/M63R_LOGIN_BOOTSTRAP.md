# M6.3R — Verify fresh production login bootstrap

**STOP FOR REVIEW.** Read-only verification of Michael’s post-M6.3Q EMAIL_OTP
login. This phase did **not** start or consume an OTP, and did not change
Cognito, TOTP, identity mapping, password, passkeys, Moov, money flags, or SQL.

---

## Return card

```
EMAIL_OTP LOGIN: YES
  2026-09-11T18:59:39.747Z POST /prep/auth/passwordless/start 200 (1838 bytes)
  IP 71.200.255.218  requestId DjFgahgRIAMEJ2Q=  integrationStatus 200

TOKENS ISSUED: YES
  2026-09-11T18:59:52.600Z POST /prep/auth/passwordless/verify 200 (4195 bytes)
  Same AuthenticationResult size as the working 14:42Z and the 17:46Z verify
  requestId DjFibjNxoAMEc4w=

IDENTITY_ME: 200
  2026-09-11T18:59:54.358Z GET /prep/identity/me 200 (1159 bytes)
  Same size as the working 14:42:16Z login (401 identity_not_linked was 151)
  requestId DjFisgTpoAMEJnA=
  524ms later POST /prep/auth/mfa/status 200 (1074 bytes) and POST /prep/data/query 200

COGNITO SUB: a45884b8-d051-70b3-b19d-ca704964c6e8
  LOOKUP_MAPPING_SQL matches exactly one active identity_accounts row
  Staging sub c4386408… maps to zero rows

APPLICATION USER: 7dbb3009-f059-4767-b5dc-1c5c72379330
  profiles email mcarletta@freedomadj.com  approval_status=approved

FREEDOM MEMBERSHIP: YES / admin / active
  tenant 2eff5f1a-929d-4ce3-9a8b-cd96b98df42a slug freedom
  tenant_users.role=admin  user_roles.admin  subscription_status=active

COGNITO MFA: EMPTY
  UserMFASettingList null  PreferredMfaSetting null
  UserLastModifiedDate 2026-09-10T18:56:10.659Z (unchanged by this login)
  AWS_COGNITO_MFA_PREFERRED=false

FINANCIAL TOTP: VERIFIED (unchanged)
  enrolled_at 2026-09-11T14:42:38.412Z
  verified_at 2026-09-11T14:43:13.231Z
  last_used_timestep null  key_id financial-totp-v1
  POST /prep/auth/mfa/status 200 immediately after identity/me

IDENTITY MUTATIONS: NONE
  cognito_sub / email / status / created_at / linked_at identical to M6.3Q after-state
  linked_at still 2026-09-11T16:33:20.421Z

MONEY FLAGS: UNCHANGED (all false)
  AWS_MOOV_ENABLED=false
  AWS_PROVIDER_EXECUTION_ENABLED=false
  AWS_FINANCIAL_PERMISSIONS_ACTIVATED=false
  AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED=false
  AWS_CHECKALT_ENABLED=false
  AWS_PROVIDER_LIVE_READS_ENABLED=true
  AWS_PROVIDER_WEBHOOK_DRY_RUN=true
  CHECKSOPS_ENV=production-prep
  Prep API CodeSha256 l9nHBQHn+cwwroKO9+czOXi2WMjoeChOpgVFtR0Tj7A= (unchanged)

SAFE TO RUN FINANCIAL TOTP AUTHORIZATION TEST: YES
  Login session established. Mapping restored. TOTP still verified.
  Money flags remain false. Do not enable money. Do not move money.

GO/NO-GO: GO for M6.3O-style authorization-only financial TOTP test
  NO-GO for money flags / Moov / CheckAlt / SQL72 / money movement

STOP FOR REVIEW.
```

---

## Stage trace (18:59Z, IP 71.200.255.218)

| Stage | Result | Evidence |
| --- | --- | --- |
| USER_AUTH initiation | 200 / 1838 | `POST /prep/auth/passwordless/start` |
| EMAIL_OTP verify | 200 / 4195 | tokens issued (`AuthenticationResult`) |
| GET `/prep/identity/me` | **200 / 1159** | not 401 `identity_not_linked` |
| cognito_sub lookup | HIT | production sub `a45884b8…` → app `7dbb3009…` |
| POST `/prep/auth/mfa/status` | 200 / 1074 | financial TOTP status via mapped session |
| POST `/prep/data/query` | 200 | session reads succeed (16:33Z after overwrite was 401) |

Authenticated dashboard traffic continued from the same IP through at least
19:01:17Z (`data/query` 200 with large payloads). One incidental `data/query`
503 (`Service Unavailable`, `integrationStatus=-`) at 18:59:57.253Z did not
block the session.

Incidental and unrelated: `GET /prep/auth/mfa/step-up` 500 at 18:46:09Z
(missing live `tenant-email-domain-handlers.mjs`). That was before this login
and is not this failure class.

---

## Mapping vs M6.3Q after-state

| Field | M6.3Q after restore | M6.3R now |
| --- | --- | --- |
| `application_user_id` | `7dbb3009-f059-4767-b5dc-1c5c72379330` | same |
| `cognito_sub` | `a45884b8-d051-70b3-b19d-ca704964c6e8` | same |
| `email` | `mcarletta@freedomadj.com` | same |
| `status` | `active` | same |
| `linked_at` | `2026-09-11T16:33:20.421Z` | same |
| `created_at` | `2026-09-02T10:49:52.986Z` | same |
| TOTP `verified_at` | `2026-09-11T14:43:13.231Z` | same |
| TOTP `last_used_timestep` | `null` | same |

Read-only RDS probe used confirm `M63R_LOGIN_BOOTSTRAP_READONLY` on
`checksops-staging-rehearsal-oneshot`. Original zip restored immediately
(CodeSha256 `Uuqs/fRkCulPrdKUj72FJTlHdTkfhVXc+mttZljUzwk=`).
