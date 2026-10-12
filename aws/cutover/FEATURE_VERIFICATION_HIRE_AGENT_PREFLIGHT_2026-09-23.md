# Feature Verification — Hire Agent staging preflight (STOP)

**Recorded:** 2026-09-23T19:28Z  
**Nature:** Read-only. No hire. No Cognito change. No production change.  
**Wait:** Do not create a user until the operator provides a real readable staging tester email.

## A. Hire Agent staging target — PASS

Live `checksops-staging-api` (read-only inspect):

| Setting | Value |
|---|---|
| `CHECKSOPS_ENV` | `staging` |
| `COGNITO_USER_POOL_ID` | `us-east-1_vPmQ7cL1F` (staging pool) |
| Production pool (not used) | `us-east-1_h00WorYMT` |
| `DATABASE_NAME` | `checksops` |
| DB secret | `rds-db-credentials/checksops-staging/checksops/…` |
| `/staging/db-health` | connected `currentDatabase=checksops`, role `checksops` |
| `POST /staging/functions/v1/hire-mortgage-agent` unauthenticated | 401 `missing_cognito_token`, `environment=staging` |

Code path: `runHireMortgageAgent` uses `process.env.COGNITO_USER_POOL_ID` and the Lambda RDS client. Staging identity scope resolves that pool to `identity_accounts` (not production locks).

No hire was invoked.

## B. Required Hire Agent form fields

Admin → Mortgage Ops → **Hire Agent** (`Hire Mortgage Ops Agent` dialog):

| Field | Required | Notes |
|---|---|---|
| Full name | **Yes** | Trimmed. API rejects empty (`Name and email are required`). |
| Email | **Yes** | Trimmed, lowercased. Must be a real readable mailbox for EMAIL_OTP. Do not use `@checksops.invalid`. |
| Temporary password | **No** | Optional. If provided, minimum 8 characters. Leave blank for the existing passwordless invite. |

Caller (not a form field): Hire is allowed only for `user_roles.admin` or `is_master_owner()`. The SPA page is additionally gated to the platform-owner mailbox. Unauthenticated hire is 401.

API behavior (existing, not changed): Cognito `AdminCreateUser` with `MessageAction=SUPPRESS`; invite is passwordless EMAIL_OTP / passkey. Application invite mail uses the staging sink. Cognito EMAIL_OTP still uses `COGNITO_DEFAULT` to the address entered in Email.

**Do not invent an email.** Waiting for the operator-supplied staging tester address before any hire.
