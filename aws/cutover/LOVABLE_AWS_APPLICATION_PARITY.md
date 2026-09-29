# Lovable → AWS application parity

Status of the controlled parity delta from `origin/main` (`8a9181ae`). This document is the implementation record for the approved FAIL gaps. It does not authorize cutover.

## Verdict

**LOVABLE → AWS APPLICATION PARITY: PASS** after the delta in this branch.

Validated 2026-09-06:

- `npm run test:aws-api` — 298/298 pass
- AWS template flags remain false; `64_financial_activation_grants.sql` is not auto-applied
- `bun run build:aws` succeeds
- Isolated oneshot apply on `checksops_rehearsal_20260906` (not recreated, not live `checksops`)
- Live `checksops` already has `returned_*` / `return_*` columns
- Live `checksops` `tg_mirror_payee_to_endorsement` still **lacks** the Sept 3 rename-delete body; rehearsal now has it

Targeted DB overlay of the trigger function is still required before production RDS matches Lovable payee-rename behavior. This PR does not apply that overlay to live `checksops`.

## Implemented on AWS (this PR)

| Gap | AWS behavior | Safety hold preserved |
| --- | --- | --- |
| Authenticated `check-endorsement` | Class A handler: send / in-person / internal / waive | Tenant membership via `aws_can_write_tenant`; contractor CC-only; 5-minute resend limit |
| Public endorsement submit | `POST /public/endorsement` submit/reject enabled | Consent required; token rotate; spoofed `x-tenant-id` ignored |
| `advance_check_on_endorsement_complete` | Denied / fail-closed | Does **not** set `ready_for_deposit` / `approved_for_deposit` or create payment-direction disbursement |
| `/public/signature-submit` | Token-hash submit, field validation, request completion | No deposit RPCs; flatten is best-effort and injectable |
| `check-reconciliation` | Class A stale / loss-draft / dashboard alerts | Tenant-scoped for non-admins; S3 orphan walk skipped |
| `send-payment-direction-request` | SES/sink Class A template | No Resend, no Telnyx, no Lovable connector |
| `admin-reset-totp` | Cognito `AdminSetUserMFAPreference` disable + global sign-out | Does not import users, enable preferred MFA, or change pool MFA (production MFA stays OFF) |
| `bill-mortgage-handling` | Named Class A handler | Ledger accrual only: may create one idempotent `platform_fee_line_items` usage fee for completed Mortgage Desk work. Does not call Stripe or Moov and does not initiate money movement. Collection occurs later through the existing monthly Moov platform-fee rollup. |
| Sept 3 `tg_mirror_payee_to_endorsement` | `aws/write-path/sql/38_parity_payee_mirror_and_returns.sql` | Rename deletes stale unsigned row then upserts; no `preferred_auth_method` |
| Returned-check columns | `ADD COLUMN IF NOT EXISTS` for `check_intake_items.returned_*` and `checkalt_deposits.return_*` | Isolated rehearsal apply only; never auto-applied to live `checksops` |

## Intentionally unchanged

- CheckAlt Architecture A
- Cognito / AWS auth architecture (no user import, no auth switch)
- 15-second polling
- Stripe / QuickBooks fail-closed
- Both Lovable migration bridges
- All production / provider / financial flags OFF
- `64_financial_activation_grants.sql` not applied
- PR #125 left open and unmerged
- Lovable production, DNS, webhooks, final DB/storage delta, and bridge teardown are out of scope

## Workflow match vs Lovable

Staff Check Command Center / EndorsementChecklist / in-person sign and the public Endorse / Sign pages invoke the same names as Lovable. AWS matches those workflows except the denied deposit / payment-direction cascade after all endorsements complete.

## Isolated schema validation

- Read-only inspect: oneshot step `inspect_return_columns` (may target `checksops`)
- Apply: oneshot step `apply_parity_ddl` (rehearsal name only, including optional `checksops_rehearsal_YYYYMMDDp`)
- Do not recreate `checksops_rehearsal_20260906` (timed rehearsal evidence)
- Do not apply `38_*.sql` to live `checksops` from this PR
