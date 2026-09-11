# M6.3P — Production EMAIL_OTP “identity failed”

**STOP FOR REVIEW. Do not deploy a patch. Do not change Cognito, MFA, TOTP, or
identity mapping in this phase.**

Michael attempted a fresh production EMAIL_OTP login as `mcarletta@freedomadj.com`
**before** the M6.3O authorization-only TOTP test. The UI returned “identity failed”.

---

## Return card

```
EMAIL_OTP INITIATED: YES
  2026-09-11T17:46:22Z POST /prep/auth/passwordless/start 200 (1838 bytes)
  IP 71.200.255.218  integrationStatus 200

EMAIL_OTP SELECTED: YES
  Start returned 200 with EMAIL_OTP session (same size as the working 14:41 start)
  Live auth-cognito.mjs still has M6.3G SELECT_CHALLENGE
  SHA-256 d3c8178fd5fa9709da055e0fbed3ec41dc2243d8f4a729479257a6decb0cd199

OTP ACCEPTED BY COGNITO: YES
  2026-09-11T17:46:36Z POST /prep/auth/passwordless/verify 200 (4195 bytes)

TOKENS ISSUED: YES
  Verify 200 + 4195-byte AuthenticationResult (id/access/refresh JWTs)
  Frontend then called identity/me with the new id token

FAILURE STAGE: /prep identity/bootstrap (after Cognito success)
  cognito_sub lookup in identity_accounts

FAILING ENDPOINT: GET /prep/identity/me
  https://checksops.com/prep/identity/me
  Lambda checksops-production-prep-api
  module aws/functions/api/identity.mjs
  function handleIdentityMe → resolveIdentitySession

HTTP STATUS: 401
  API GW responseLength 151 → compact JSON error identity_not_linked
  integrationStatus 200 (Lambda ran; not origin-verify, not API GW JWT deny)

ERROR: identity_not_linked
  UI toast title is “Verification failed”; description is identity_not_linked
  (reported as “identity failed”)
  Cognito authentication had already succeeded

COGNITO USER: EXISTS / ENABLED / CONFIRMED
  pool us-east-1_h00WorYMT
  username/sub a45884b8-d051-70b3-b19d-ca704964c6e8
  email mcarletta@freedomadj.com email_verified=true
  UserLastModifiedDate 2026-09-10T18:56:10.659Z (unchanged)

COGNITO MFA: EMPTY
  UserMFASettingList null / PreferredMfaSetting null
  AWS_COGNITO_MFA_PREFERRED=false

EMAIL_OTP AVAILABLE: YES
  Client ExplicitAuthFlows includes ALLOW_USER_AUTH
  Start 200 (not 409 email_otp_unavailable)

SUB: a45884b8-d051-70b3-b19d-ca704964c6e8  (production pool; expected)

IDENTITY_MAPPING: BROKEN
  application_user_id 7dbb3009-f059-4767-b5dc-1c5c72379330 is active
  but cognito_sub is now c4386408-60e1-70e2-abb6-e6194e8e635f
  LOOKUP_MAPPING_SQL for production sub returns ZERO rows
  linked_at 2026-09-11T16:33:20.421Z  ← overwrite moment

APPLICATION_USER: EXISTS / approved
  profiles.id 7dbb3009-f059-4767-b5dc-1c5c72379330
  email mcarletta@freedomadj.com  approval_status approved

FREEDOM_MEMBERSHIP: YES
  tenant 2eff5f1a-929d-4ce3-9a8b-cd96b98df42a slug freedom
  tenant_users.role admin / user_roles.admin / subscription active

DUPLICATE_MAPPING: NO second identity_accounts row
  production sub a45884b8… is unmapped (empty)
  staging sub c4386408… is now the only sub on Michael’s app user

FINANCIAL_TOTP RELATED: NO
  Enrollment still verified on 7dbb3009… (14:43:13Z)
  TOTP handlers do not write identity_accounts
  M6.3G SELECT_CHALLENGE overlay did not fail this login
    (start+verify 200, identical sizes to the working 14:41–14:42 login)

ROOT CAUSE: identity_accounts.cognito_sub for Michael’s application user was
  rewritten at 16:33:20Z from the production Cognito sub a45884b8… to the
  staging-pool sub c4386408… (pool us-east-1_vPmQ7cL1F, email also
  mcarletta@freedomadj.com). Production EMAIL_OTP JWTs still carry a45884b8…
  so GET /identity/me cannot find a mapping.

SMALLEST FIX: one-row UPDATE restoring production cognito_sub a45884b8…
  where application_user_id = 7dbb3009… and current sub = c4386408…
  (a45884b8… is not currently mapped). Do NOT deploy in this phase.
  Do not reset TOTP. Do not change Cognito MFA. Do not overlay repo
  auth-cognito.mjs.

SAFE TO PATCH: YES (after human review of the one-row restore)
  Precondition: confirm a45884b8… still unmapped immediately before UPDATE

FINANCIAL TOTP TEST NOW: NO
  Login cannot establish a production session until the mapping is restored

GO/NO-GO: NO-GO for M6.3O TOTP authorization-only test
  GO to review/apply the identity_accounts restore only

STOP FOR REVIEW.
```

---

## Stage trace (17:46Z, IP 71.200.255.218)

| Stage | Result | Evidence |
| --- | --- | --- |
| USER_AUTH initiation | 200 | `POST /prep/auth/passwordless/start` 1838 bytes |
| SELECT_CHALLENGE / EMAIL_OTP | 200 | Same start size as working 14:41:54Z login; live module has SELECT_CHALLENGE |
| OTP challenge response | 200 | `POST /prep/auth/passwordless/verify` 4195 bytes |
| Cognito token issuance | YES | Verify 200 with AuthenticationResult |
| GET /prep/identity/me | **401** | 151 bytes `identity_not_linked` 2s later |
| cognito_sub lookup | MISS | `WHERE cognito_sub = a45884b8… AND status IN ('active','isolated_test')` → 0 rows |
| application_user / Freedom | intact | profile + tenant_users unchanged |
| frontend session | not established | `identityFromTokens` throws; toast “Verification failed” |

Last known **working** production bootstrap (same IP, same start/verify sizes):

| Time (UTC) | Path | Status |
| --- | --- | --- |
| 14:41:54 | POST `/prep/auth/passwordless/start` | 200 / 1838 |
| 14:42:15 | POST `/prep/auth/passwordless/verify` | 200 / 4195 |
| 14:42:16 | GET `/prep/identity/me` | **200 / 1159** |
| 14:42:38–14:43:13 | financial TOTP enroll/verify | succeeded |
| 15:41:22 | GET `/prep/identity/me` (session restore) | 200 / 1159 |
| 16:33:20 | `identity_accounts.linked_at` | **sub rewritten** |
| 16:33:21 | POST `/prep/data/query` | 401 (old JWT sub no longer mapped) |
| 17:46:22–17:46:38 | fresh EMAIL_OTP then identity/me | 200 / 200 / **401** |

---

## Mapping now vs expected

| Field | Expected (production) | Observed now |
| --- | --- | --- |
| `application_user_id` | `7dbb3009-f059-4767-b5dc-1c5c72379330` | same |
| `cognito_sub` | `a45884b8-d051-70b3-b19d-ca704964c6e8` (prod pool) | `c4386408-60e1-70e2-abb6-e6194e8e635f` (**staging** pool `us-east-1_vPmQ7cL1F`) |
| `email` | `mcarletta@freedomadj.com` | same |
| `status` | `active` | `active` |
| `linked_at` | prior production link | **2026-09-11T16:33:20.421Z** |
| `created_at` | 2026-09-02T10:49:52.986Z | unchanged |

`c4386408-…` does **not** exist in the production pool. It is a confirmed staging Cognito user with the same email. Production EMAIL_OTP cannot mint that sub.

This is not a duplicate-row problem. It is a **wrong-sub overwrite** of the single Michael row. RLS is off on `identity_accounts`; lookup is not hidden.

Writer of the 16:33:20 UPDATE was **not** this M6.3O/M6.3P run (those probes were later and read-only). Prep API at 16:33 only shows `data/query` polls. Likely a separate identity relink / SQL UPDATE that set `cognito_sub` and `linked_at = now()` on `application_user_id = 7dbb3009-…`. Financial TOTP and M6.3G did not perform that write.

---

## What is not the cause

- Cognito MFA / Apple authenticator / financial TOTP enrollment (still verified; not used at login).
- Live M6.3G `auth-cognito.mjs` (SELECT_CHALLENGE). Repo `auth-cognito.mjs` still lacks SELECT_CHALLENGE — **do not overlay the repo file**.
- Origin-verify (`ORIGIN_VERIFY_REQUIRE=true`): start/verify/identity all reached Lambda (`integrationStatus=200`).
- Money flags / CheckAlt / Moov: untouched.

Incidental (not this failure): `GET /prep/auth/mfa/step-up` at 17:45:55Z and 17:52:46Z returned 500 because live zip is missing `tenant-email-domain-handlers.mjs` (fallthrough from GET on a POST-only route). Do not “fix” that by overlaying repo `auth-cognito.mjs`.

---

## Proposed smallest fix (not applied)

One-row restore, only after a human re-checks that `a45884b8-…` is still unmapped:

```sql
UPDATE public.identity_accounts
   SET cognito_sub = 'a45884b8-d051-70b3-b19d-ca704964c6e8',
       linked_at = now()
 WHERE application_user_id = '7dbb3009-f059-4767-b5dc-1c5c72379330'
   AND email = 'mcarletta@freedomadj.com'
   AND cognito_sub = 'c4386408-60e1-70e2-abb6-e6194e8e635f'
 RETURNING application_user_id, cognito_sub, email, status, linked_at;
```

Expect `rowCount = 1`. Then Michael repeats EMAIL_OTP; `GET /prep/identity/me` must be 200 before any TOTP authorization test.

Do not reset financial TOTP. Do not enable Cognito MFA. Do not change the staging pool user.
