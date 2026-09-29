# E14 Phase 3 — no process POST yet

Phase 2 flags are live. **No** `POST /public/fincapture/deposit/process` was issued.

## Why submit did not start

The only Freedom member who can authorize CheckAlt (`roleAllowsFinancial`) is tenant admin `mcarletta@freedomadj.com`. Financial TOTP enrollments on production are still **0**, so that same user must enroll then step-up `deposit.submit` bound to:

- check `a3a4a153-46e1-4c28-a273-79a9bd04f3a6`
- amount `154672` cents

Cognito EMAIL_OTP for that admin was started at ~2026-09-22T21:51Z (`challenge=EMAIL_OTP`, destination `m***@f***`). The connected Outlook mailbox is `claims@freedomadj.com` (Freedom mortgage_agent). The new OTP did not arrive there. Older ChecksOps codes in that inbox are addressed to `claims@freedomadj.com` and cannot authorize this deposit.

Operator `checksops-tester@freedomadj.com` and mortgage_agent `claims@freedomadj.com` are mapped but cannot execute.

## What was not done

- No official `.checkalt.jpg` upload
- No `checkalt_deposits` insert
- No FinCapture authenticate/process
- No automatic retry
- No second check
- No Moov / ACH / RTP / wire

## Resume

1. Complete EMAIL_OTP as the Freedom admin in the normal ChecksOps UI (`https://checksops.com/login` → `/freedom/checks`).
2. Enroll financial TOTP (none exist yet).
3. Generate the endorsed rear deposit JPEG (`composite-endorsement-signatures` → `back_image_deposit_path`), then Deposit → step-up → one `checkalt-submit-deposit`.
4. Keep dry-run true through the first genuine webhook (Phase 4).

Do not raw-call FinCapture. Do not start a second process POST if the first HTTP outcome is ambiguous.
