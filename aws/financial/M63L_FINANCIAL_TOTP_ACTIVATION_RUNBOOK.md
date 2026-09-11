# M6.3L — Financial TOTP activation runbook

**NOT EXECUTED.** Dark merge of PR #220 (`063a3cee` on `main` via merge `8dfdebdb`)
is code-only. This file is the exact activation sequence for a later authorized
phase. Do not run A–J until that phase is approved.

Do not: change `mcarletta@freedomadj.com` MFA, disable Cognito TOTP, change
password, enable money flags, apply SQL72, touch Moov/recipient links, or move
money.

## Preconditions (already true after M6.3K)

| Check | Expected |
| --- | --- |
| Reviewed head on `main` | `063a3cee3dd0461bcd5029d67e3921892726e23f` |
| Lambda `checksops-production-prep-api` | **not** this overlay; last known `CodeSha256` `D5ONhRTftnb9LHwgQLJfcp6PPins79O1T5Zut9dKidk=` at `2026-09-11T01:11:48Z` |
| Wrap key `checksops/production/financial-totp-wrap-key` | **does not exist** |
| SQL file | `aws/migrations/proposed/NOT_APPLIED_20260911_financial_totp_enrollment.sql` — not applied |
| Production user MFA | `SOFTWARE_TOKEN_MFA` present; `PreferredMfaSetting` null; `UserLastModifiedDate` `2026-09-10T18:56:10.659Z` |
| Money flags | `AWS_MOOV_ENABLED=false`, `AWS_PROVIDER_EXECUTION_ENABLED=false`, `AWS_FINANCIAL_PERMISSIONS_ACTIVATED=false`, `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED=false`; keep `AWS_PROVIDER_LIVE_READS_ENABLED=true`, `AWS_PROVIDER_WEBHOOK_DRY_RUN=true` |

STOP if any precondition drifted.

## Order (strict)

A wrap key → B SQL → C verify schema → D Lambda ARN + IAM → E deploy overlay → F–I tester proofs → J **stop** (production-user recovery is a later phase).

If any step fails, do not continue. Do not skip to MFA disable.

---

### A. Create production wrap key

Region `us-east-1`. Account `806168576068`.

1. Generate 32 bytes as 64 hex chars. Do not log them. Do not put them in Lambda env.
2. Create Secrets Manager secret **only if missing**:

```bash
# Do not run in M6.3K.
aws secretsmanager create-secret \
  --region us-east-1 \
  --name checksops/production/financial-totp-wrap-key \
  --description 'AES-256-GCM wrap key for app-level financial TOTP. Not Cognito login MFA.' \
  --secret-string '{"keyId":"financial-totp-v1","hex":"<64-hex>"}'
```

Parser accepts raw 64-hex **or** JSON `key` / `wrapKey` / `hex` plus `keyId`.
Prefer JSON with `keyId=financial-totp-v1`.

3. Record the secret **ARN** only. Never paste the hex into tickets, chat, or env.

4. Grant the existing prep API role `secretsmanager:GetSecretValue` on **that ARN
   only**. Do not grant `checksops_admin` DB secrets. Do not put the wrap key in
   `FINANCIAL_TOTP_WRAP_KEY`.

Abort if the secret already exists and was not created for this purpose.

### B. Apply ONLY the financial-TOTP SQL

File: `aws/migrations/proposed/NOT_APPLIED_20260911_financial_totp_enrollment.sql`

- Apply as **`checksops_admin`** on database `checksops`.
- Do **not** apply as Lambda role `checksops`.
- Do **not** apply SQL64/SQL65/SQL72 or any other proposed file.
- Single `psql --file` of that one script (`BEGIN`/`COMMIT` inside).

Abort on any error. Do not retry with a different migration.

### C. Verify tables / functions / RLS / grants

As `checksops_admin`, expect:

```sql
SELECT c.relname, c.relrowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('financial_totp_enrollments', 'financial_totp_rate_limits');
-- relrowsecurity true for both

SELECT grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_name IN ('financial_totp_enrollments', 'financial_totp_rate_limits');
-- no SELECT/INSERT/UPDATE/DELETE to checksops or authenticated

SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args,
       p.prosecdef, p.proconfig
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname LIKE 'financial_totp%' OR p.proname = 'consume_financial_totp_rate_limit';
-- SECURITY DEFINER; proconfig includes search_path=public, pg_temp

SELECT p.proname, r.rolname AS grantee
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN aclexplode(p.proacl) a ON true
JOIN pg_roles r ON r.oid = a.grantee
WHERE n.nspname = 'public'
  AND p.proname IN (
    'financial_totp_get_enrollment',
    'financial_totp_status',
    'financial_totp_upsert_enrollment',
    'financial_totp_mark_verified',
    'consume_financial_totp_rate_limit'
  )
  AND a.privilege_type = 'EXECUTE';
-- EXECUTE to checksops only; not authenticated/PUBLIC
```

`financial_totp_status` returns only `enrolled_at`, `verified_at`.
`financial_totp_get_enrollment` is Lambda-only (ciphertext), still `auth.uid()` gated.

Confirm generic data API still omits both tables (`allowed-tables.json`).

### D. Configure `FINANCIAL_TOTP_WRAP_KEY_ARN`

Function: `checksops-production-prep-api`. `CHECKSOPS_ENV=production-prep`
already refuses env hex.

1. `get-function-configuration` and copy the **full** environment map.
2. Add `FINANCIAL_TOTP_WRAP_KEY_ARN=<secret ARN from A>`.
3. Do **not** set `FINANCIAL_TOTP_WRAP_KEY`.
4. Do **not** flip money flags. Keep the four money flags `false`.
5. `update-function-configuration` with the merged map (never replace with a
   partial map).
6. Re-read flags; abort if any money flag changed.

IAM from A must already allow `GetSecretValue` on that ARN.

### E. Deploy app-level financial-TOTP overlay

Overlay **onto the current** `checksops-production-prep-api` zip. Do not
publish a zip that contains only the new files.

Copy from `main` at/after `063a3cee`:

- `aws/functions/api/financial-totp.mjs`
- `aws/functions/api/auth-financial-totp.mjs` (**new file**)
- `aws/functions/api/auth-mfa.mjs`

Then `lambda update-function-code` + `lambda wait function-updated`.

Record new `CodeSha256`. Confirm `LastModified` moved and money flags still false.

Do not deploy SQL inside the zip. Do not change Cognito pool MFA config.

### F. Prove live enrollment — tester only

User: `checksops-tester@freedomadj.com`  
Production pool: `us-east-1_h00WorYMT`  
App UUID: `abd3c2a0-6dc0-4680-92dd-a013e1141c91`  
Freedom tenant: `2eff5f1a-929d-4ce3-9a8b-cd96b98df42a`

Do **not** use `mcarletta@freedomadj.com`. Do not `AdminSetUserPassword`.

1. Tester signs in with EMAIL_OTP (tester mailbox). Do not change password.
2. `POST /prep/auth/mfa/status` → `totpEnrolled=false`, `source=financial_totp_enrollments`. Body has no secret/ciphertext.
3. `POST /prep/auth/mfa/associate` → `totp.secret` + `otpauth_uri` issuer **ChecksOps Financial** once.
4. Confirm Cognito `UserMFASettingList` is still empty/off (`AdminGetUser` read-only).
5. Confirm the code in the authenticator labeled ChecksOps Financial.
6. `POST /prep/auth/mfa/verify` with that code → `verified=true`, `recorded=false`.
7. Status now `totpEnrolled=true`. Secret absent from status/verify JSON.

Abort if associate calls Cognito software-token APIs or writes `financial_stepup_log`.

### G. Prove EMAIL_OTP remains available for tester

Read-only / non-consuming:

```text
InitiateAuth USER_AUTH
ClientId 3ja9fqaq2fjkv3i6up2varcqpe
AuthParameters.USERNAME=checksops-tester@freedomadj.com
(no PREFERRED_CHALLENGE)
```

Expect `ChallengeName=SELECT_CHALLENGE` and `AvailableChallenges` includes
`EMAIL_OTP`. Do **not** `RespondToAuthChallenge`. Do not send a preferred
`EMAIL_OTP` (that emails a code). Do not touch the production user.

### H. Prove one bound `financial_stepup_log`

Use an **existing** Freedom check the tester can access. Do not create a
transfer, deposit, or new recipient.

`POST /prep/auth/mfa/step-up` with TOTP string code + `check_intake_item_id` only.
Do not send browser `amount_cents` as authority. Optional spoofed `tenant_id`
must be ignored.

Expect exactly one new row:

| Column / metadata | Value |
| --- | --- |
| `user_id` | `abd3c2a0-6dc0-4680-92dd-a013e1141c91` |
| `tenant_id` | check’s tenant (Freedom `2eff5f1a-929d-4ce3-9a8b-cd96b98df42a` if that is the check tenant) |
| `action_key` | `deposit.submit` |
| `factor_type` | `totp` |
| `succeeded` | true |
| `metadata.check_id` | that check UUID |
| `metadata.amount_cents` | server cents from `check_intake_items.amount` |
| `metadata.source` | `app_financial_totp` |

Enroll-confirm must not have written a row. Money flags stay false; no provider call.

### I. Prove fail-closed

Same tester, after H:

1. **Replay** the same code in the same 30s window → fail; log count unchanged.
2. **Wrong** code `000000` → fail; no new log.
3. **Expired** window (timestep ±5) → fail; no new log.
4. **Cross-user** (another identity’s JWT, same code) → `totp_not_enrolled` or identity 401; no log for the victim.
5. **Cross-tenant** (check whose tenant the tester does not belong to) → `cross_tenant_denied`; no log.
6. **Amount mismatch** if `amount_cents` is sent and disagrees with server → `amount_mismatch`; no log.
7. **Action mismatch** (`wallet.fund`) → `action_mismatch`; no log.

### J. STOP — production-user recovery is a separate phase

Do **not** in M6.3L:

- `AdminSetUserMFAPreference` / `SetUserMFAPreference` on `mcarletta@freedomadj.com`
- `AdminDeleteSoftwareToken`
- password change
- `PreferredMfaSetting` change

After F–I all PASS, the next **separate** phase is production-user EMAIL_OTP
recovery, then a **new** ChecksOps Financial QR for that user.

## User-facing copy required before production enrollment

Server otpauth issuer is already `ChecksOps Financial`. UI still says Cognito /
login TOTP. Change these **before** asking a human to scan a QR:

| File | Current | Required |
| --- | --- | --- |
| `src/lib/totpQr.ts` | fallback issuer `ChecksOps` | `ChecksOps Financial` |
| `src/components/auth/TotpManagerCard.tsx` | title `Authenticator (TOTP)`; badge `Optional at login`; toast `Add ChecksOps`; error `Cognito did not retain SOFTWARE_TOKEN_MFA`; status error `from Cognito`; comment enrolls Cognito SOFTWARE_TOKEN_MFA | Title **ChecksOps Financial authenticator**. Badge enrolled/setup for **financial step-up**, not login. Toast: scan **ChecksOps Financial**. Errors: app enrollment, never Cognito MFA APIs. |
| `src/components/auth/TotpQrDisplay.tsx` | alt `Authenticator setup QR code` | `ChecksOps Financial authenticator QR code` |
| `src/components/auth/StepUpDialog.tsx` | `software-token` factor id; generic “two-factor” | Financial authenticator / `financial-totp`; copy that login remains EMAIL_OTP / passkey |
| `src/integrations/aws/client.ts` | “until Cognito MFA is enabled” | Financial TOTP is app-level; Cognito login MFA stays off |

Login screens must keep EMAIL_OTP / passkey language. Do not present financial
TOTP as a sign-in factor.

## Rollback (if A–E started and F fails)

- Leave Cognito users unchanged.
- Lambda: restore previous zip (`CodeSha256` `D5ONhRTftnb9LHwgQLJfcp6PPins79O1T5Zut9dKidk=`).
- Env: remove `FINANCIAL_TOTP_WRAP_KEY_ARN`; do not add env hex.
- SQL: keep tables; do not `DROP`; stop serving enroll if overlay is reverted.
- Wrap key: keep secret; do not rotate unless leaked.

## GO/NO-GO for this document

- **GO** to review this sequence.
- **NO-GO** to execute A–J until explicitly authorized as M6.3L.
- **NO-GO** to change the production user’s MFA in that same phase.
