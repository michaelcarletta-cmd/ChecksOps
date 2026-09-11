# M6.3O — Production financial TOTP authorization-only test

**STOP FOR REVIEW. Do not enter a TOTP code until this card is accepted.**

Do **not** reset or re-enroll Michael’s Apple authenticator. Do **not** request,
capture, print, or log the 6-digit code. Do **not** flip money flags. Do **not**
call CheckAlt, Moov, deposit submit, approve, prepare, or assign. Do **not**
change check workflow/status.

Goal: prove production app-level financial TOTP can authorize a real
`deposit.submit` step-up while causing **zero** financial/provider action.

---

## Return card

```
TOTP ENROLLED: YES — verified_at 2026-09-11T14:43:13.231Z
  application_user_id 7dbb3009-f059-4767-b5dc-1c5c72379330
  key_id financial-totp-v1 / SHA1 / 6 digits / 30s
  last_used_timestep null / locked false / failed_attempts 0
  Apple authenticator must NOT be reset or re-enrolled

COGNITO MFA: DISABLED/EMPTY
  pool us-east-1_h00WorYMT
  username a45884b8-d051-70b3-b19d-ca704964c6e8
  UserMFASettingList null
  PreferredMfaSetting null
  UserLastModifiedDate 2026-09-10T18:56:10.659Z (unchanged)

MONEY FLAGS: ALL FALSE (live Lambda checksops-production-prep-api)
  AWS_PROVIDER_EXECUTION_ENABLED=false
  AWS_MOOV_ENABLED=false
  AWS_CHECKALT_ENABLED=false
  AWS_FINANCIAL_PERMISSIONS_ACTIVATED=false
  AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED=false
  AWS_COGNITO_MFA_PREFERRED=false
  CHECKSOPS_ENV=production-prep
  keep: AWS_PROVIDER_LIVE_READS_ENABLED=true
  keep: AWS_PROVIDER_WEBHOOK_DRY_RUN=true
  CodeSha256 l9nHBQHn+cwwroKO9+czOXi2WMjoeChOpgVFtR0Tj7A= (M6.3L.4)

SAFE TEST CHECK: 3a77367e-5e79-4189-bfcd-225aa077afd8
  tenant Freedom 2eff5f1a-929d-4ce3-9a8b-cd96b98df42a (slug freedom)
  status deposited / check_stage funds_released
  amount 2877.20 dollars
  checkalt_deposits for this check: 0
  financial_stepup_log for this check: 0
  NOT the forbidden CheckAlt target 623442f0-a408-4db5-85be-14bae231a722

SERVER AMOUNT: 287720 cents (serverAmountCentsFromCheck / dollars×100)
  browser tenant/amount are ignored

TEST HARNESS ENDPOINT: POST /prep/auth/mfa/step-up
  production same-origin https://checksops.com/prep/auth/mfa/step-up
  action_key deposit.submit (CHECKALT_TOTP_ACTION; other actions 409)
  check_id bound from check_intake_items
  amount_cents server-authoritative

AUTHORIZATION ONLY: YES
  success path INSERT financial_stepup_log only
  consumes last_used_timestep (not a reset / not re-enroll)
  does NOT call deposit submit, CheckAlt, Moov, approve/prepare/assign
  does NOT UPDATE check_intake_items status/stage

CHECKALT CALL POSSIBLE: NO
  productionCheckAltExecutionAllowed() requires every money flag true
  AND sandbox execution false — currently unreachable
  runProductionCheckAltHandler returns null
  harness never invokes checkalt-submit-deposit

MOOV CALL POSSIBLE: NO
  AWS_MOOV_ENABLED=false and AWS_PROVIDER_EXECUTION_ENABLED=false
  harness never calls Moov
  moov_invoices=0 payment_transfers=0 payment_transfer_groups=0

CHECK MUTATION POSSIBLE: NO (for this harness)
  no check/stage/checkalt_deposits writes
  expected writes if TOTP succeeds: one financial_stepup_log row
  + last_used_timestep consume on the existing enrollment

BEFORE COUNTS (2026-09-11T17:41Z read-only probe):
  financial_stepup_log total=4  michael=3  this check=0
  checkalt_deposits total=69  this check=0
  checkalt_webhook_events=2
  moov_invoices=0  moov_invoice_customers=0
  payment_transfers=0  payment_transfer_groups=0
  financial_totp_enrollments=2
  selected check updated_at=2026-08-25T13:57:27.691Z

EXACT HUMAN STEPS: see below. ONE code. Do not share it.

SAFE TO ENTER ONE TOTP: YES

GO/NO-GO: GO — one authorization-only step-up on the selected check.
  NO-GO — money flags, reset/re-enroll, CheckAlt, Moov, deposit, check mutation.

STOP FOR REVIEW.
```

---

## Why this check

The forbidden CheckAlt target `623442f0-a408-4db5-85be-14bae231a722` is
`approved_for_deposit` / `ready_for_deposit` (amount `9984.11`). Do not use it.

The only Freedom `returned` check found (`ec2f4d26-341f-4c79-b24a-75539a19990a`)
already has a `checkalt_deposits` row, so it is more entangled with provider
history.

Selected `3a77367e-5e79-4189-bfcd-225aa077afd8` is an existing Freedom check
that is already `deposited` / `funds_released`, has **zero** CheckAlt deposit
rows, has **zero** step-up rows, and is not the forbidden target. Combined with
all money flags false, provider HTTP cannot run even if the wrong UI were used.

Tester prior check `c7ea8b6a-2f88-4571-8798-18daab6534ad` is
`endorsements_in_progress` / `endorsing` (live workflow). Do not use it.

---

## Harness confirmation

Live SPA `https://checksops.com/` → `/assets/index-cU7wOTrI.js`
SHA-256 `332d50976edc1d9917dff44e4ce079118a36030c03ef18c4dc51b04263cc86cb`
contains **Financial TOTP test** and
`Verify financial TOTP only — no deposit will be submitted.`

Frontend:

- `src/lib/financialTotpOnlyTest.ts` calls only `requireStepUp` with
  `actionKey: deposit.submit` and the typed check UUID. Frozen stop:
  `continued: false`, `invoked: []`, `providerHttp: false`, no check/stage/
  `checkalt_deposits` mutation. Browser tenant/amount ignored.
- `src/components/auth/FinancialTotpOnlyTestCard.tsx` button copy is that
  same sentence. Mounted on `/account/security` and `/{slug}/settings` Profile.
- `useStepUp` → `StepUpDialog` (enrolled path) → `stepUpAwsTotp` →
  `POST ${awsApiBaseUrl()}/auth/mfa/step-up`. Production `awsApiBaseUrl()` is
  same-origin `/prep`.

Backend `handleMfaStepUp`:

- Requires `action_key === deposit.submit`.
- Loads the check; tenant from the check; `amount_cents` from
  `serverAmountCentsFromCheck`.
- On success: `INSERT financial_stepup_log` with
  `{check_id, amount_cents, operation: deposit.submit, source: app_financial_totp}`.
- No CheckAlt/Moov/deposit/workflow/status updates.

`aws/tests/frontend-financial-totp-only.test.mjs` and
`aws/tests/financial-totp.test.mjs`: 23 passed.

---

## Exact human steps (ONE authorization-only test)

Michael enters the current 6-digit Apple authenticator code himself.
Do not send the code to chat, email, screenshots, or logs.

1. Sign in at `https://checksops.com` as `mcarletta@freedomadj.com` with
   EMAIL_OTP only. Do not enable Cognito MFA. Do not open Check Command Center,
   Deposit, CheckAlt, or Moov.
2. Open **exactly one** of:
   - `https://checksops.com/account/security`
   - `https://checksops.com/freedom/settings` → **Profile** tab
3. Scroll to the amber card titled **Financial TOTP test**.
   Do **not** click Set up / Restart on **ChecksOps Financial authenticator**.
   If the test dialog shows a QR code, **STOP** — that is enrollment, not this test.
4. Paste this existing check UUID into **Existing check ID**:

   `3a77367e-5e79-4189-bfcd-225aa077afd8`

5. Click the button:

   **Verify financial TOTP only — no deposit will be submitted.**

6. In the step-up dialog, enter the current 6-digit authenticator code **once**.
   Expected success toast: **Financial TOTP authorized — stopped**.
   Result text: `continued: false`, `provider HTTP: false`,
   `check / stage / checkalt_deposits mutated: no`.
7. **STOP.** Do not submit a deposit. Do not retry a second code unless this
   attempt fails without recording a step-up.

If the card is missing, STOP (admin role should show it). If login asks for
authenticator MFA, STOP (Cognito MFA must stay empty).

---

## Expected AFTER (only if GO and one success)

| Surface | Before | After success |
| --- | --- | --- |
| `financial_stepup_log` total | 4 | 5 |
| Michael step-ups | 3 | 4 |
| This check’s step-ups | 0 | 1 (`source=app_financial_totp`, `amount_cents=287720`) |
| `checkalt_deposits` total | 69 | 69 |
| This check deposit rows | 0 | 0 |
| Moov invoice/transfer tables | 0 | 0 |
| Check status/stage/`updated_at` | deposited / funds_released / 2026-08-25T13:57:27.691Z | unchanged |
| Enrollment `verified_at` | 2026-09-11T14:43:13.231Z | unchanged |
| `last_used_timestep` | null | non-null (consume, not reset) |
| Cognito MFA | empty | empty |
| Money flags | all false | all false |

---

## Holds still in force

- Do not `AdminDeleteSoftwareToken` / `admin-reset-totp.mjs`.
- Do not overlay repo `auth-cognito.mjs` onto live Lambda.
- Do not enable money flags or apply SQL72.
- Do not decrypt the wrap key or print otpauth secrets.
- Rehearsal Lambda restored to original CodeSha256
  `Uuqs/fRkCulPrdKUj72FJTlHdTkfhVXc+mttZljUzwk=`.
