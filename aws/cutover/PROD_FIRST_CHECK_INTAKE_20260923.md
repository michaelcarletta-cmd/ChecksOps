# First production check intake — 2026-09-23

Frozen CLOSED components were not reopened except for the known
`homeowner-ledger-send` GRANT denial. Ledger architecture, OCR,
email, CheckAlt, and Moov were not redesigned. No money movement.

## A. Narrow homeowner-ledger grant defect — FIXED

Production `checksops` had **no** table privileges on
`public.homeowner_ledger_tokens`. Table owner is `checksops_admin`.
`checksops` is a member of `authenticated` (RLS stays in force;
`rolbypassrls=false`).

Applied only:

```sql
GRANT SELECT, INSERT, UPDATE ON TABLE public.homeowner_ledger_tokens TO checksops;
```

Repo record: `aws/workflows/sql/72_production_homeowner_ledger_token_grants.sql`.
No DELETE. No extra tables. No RLS/policy changes.

Verified through the existing production API as Freedom admin
`mcarletta@freedomadj.com`:

| Step | Result |
|---|---|
| `POST /prep/functions/v1/homeowner-ledger-send` | 200 |
| Recipient | operator mailbox `claims@freedomadj.com` only |
| Claim | `3f50cb5a-4b6c-4d87-91d2-8c668a806de4` / `034882580` |
| Public view | 200, claim `034882580` |
| SES inbox | `Your claim timeline` at 2026-09-23T15:50:37Z from `ChecksOps <support@checksops.com>` |
| Token prefix | `47b1855f` (revoked after verification at 2026-09-23T16:26:00Z) |

This narrow regression is **CLOSED**.

## B. Check selected for production intake

USAA issued a real Freedom settlement check on 2026-09-16:

| Field | Value |
|---|---|
| Carrier | USAA |
| Claim | `038953633-802` |
| Amount | `$11,303.97` |
| Payee named in notice | FREEDOM ADJUSTMENT |
| Source | claims@ inbox `USAA Claim Settlement` (has attachments) |
| Loss location | Clarksburg, NJ |

This is a later payment on the USAA `038953633` family (email also
lists prior payment `$15,411.28`). It is **not** fabricated.

Front/rear check photographs were **not available** to this agent.
Outlook MCP cannot read file attachments (`/$value` / `/content`
blocked). Local images are synthetic/blank only and were not used.

## C. Duplicate-prevention result

Admin inspect of production `check_intake_items` for
`038953633-802`, `038833030-800`, `7010433186`, and `11303.97`:
**no matching intake row**.

Related existing row (different check, not a duplicate of this
settlement):

| Check | Claim detected | Amount | Status |
|---|---|---|---|
| `0000328744` | `038953633` | `$10,873.33` | deposited / funds_released |

Accepted staff-ops check `0000549229` / `$1,492.47` / claim
`034882580` remains the prior safe review check and was not reused.

## D. Production upload result

Freedom UI path reached: `/freedom/checks` → **Upload Check** →
dialog `Upload Insurance Check` (AI extraction enabled, Front/Back
inputs present). **No file was chosen. Upload & Analyze was not
clicked.**

Intake of the USAA `$11,303.97` check was **not performed** because
legitimate unused front/rear images were not obtainable without
fabricating financial images.

## E–K. RDS / S3 / Textract / Review / tenant / payee / persist

Not exercised for a new check. No new `check_intake_items` row was
created. No new S3 objects were written. OCR/Textract was not
invoked. No Review Check descriptive write was made for a new check.

## L. Endorsement-routing readiness

Not opened for a new check. Endorsement email was not sent.

## M. Exact workflow state reached

1. Ledger grant closed (API + public ledger + SES to operator inbox).
2. Freedom Checks Upload Check dialog open, no file selected.
3. Absolute stop before upload/analyze and before any deposit control.

## N. Exact point immediately before money movement

Unchanged from staff-ops freeze: deposit / CheckAlt / auto-advance
were not clicked. The new-check path stopped even earlier — at
Upload Check with no images.

## O. FIRST NEW PRODUCTION CHECK INTAKE — COMPLETE: NO

## P. Remaining blocker before processing additional real checks

A legitimate unused Freedom check **front and rear photograph**
must be available to the authenticated Freedom UI (phone scan or
mailbox attachment that this environment can actually open). Do not
use synthetic Textract fixtures. Do not re-upload `0000549229`.

## Q. Remaining blocker before DEPOSIT

CheckAlt E14 remains a separate workstream. Do not enable
`AWS_ENDORSEMENT_AUTO_ADVANCE`.

## R. Remaining blocker before DISBURSEMENT

Moov remains separate. `AWS_MOOV_ENABLED` stays false.

## S. Production components now FROZEN

All previously frozen items remain frozen, plus this grant close:

1. Cognito authentication
2. AWS `/prep` API
3. RDS / S3 foundation
4. OCR / AWS Textract
5. Branding / Public Assets
6. Public Sign
7. Public Endorse
8. Homeowner Upload
9. Ledger / Tracking
10. token/storage/tenant isolation
11. authenticated Staff Check Operations
12. application SES email delivery
13. `homeowner-ledger-send` `homeowner_ledger_tokens` GRANT
    (`SELECT`/`INSERT`/`UPDATE` for `checksops` only)

First new production check intake is **not** frozen as complete.

## T. SINGLE NEXT MASTER AWS CUTOVER ITEM

Obtain unused real Freedom front/rear check images and complete
the already-built Upload Check → Textract → Review Check acceptance
for one new production check. **STOP before money movement.**
Do not begin CheckAlt. Do not begin Moov.
