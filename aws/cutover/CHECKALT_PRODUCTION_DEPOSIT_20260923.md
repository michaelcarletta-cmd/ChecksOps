# CheckAlt production deposit execution — 2026-09-23

Cutover only. Existing CheckAlt implementation was inspected and
preserved. No architecture redesign. No money-flag mutation.
No Moov / ACH / RTP / wire / disbursement. No endorsement
auto-advance. No fabricated deposit.

Verdict:

**CHECKALT PRODUCTION ACCEPTANCE — PENDING REAL DEPOSIT INPUT**

That is not a failure. No unused Freedom check is currently
eligible for a new CheckAlt `/fincapture/deposit/process`.

## A. Current production baseline

Live read-only confirm (this run):

| Item | Live value |
|---|---|
| Lambda | `checksops-production-prep-api` |
| CodeSha256 | `pVwEBVCZJG5PCS6kVmktMiziQ3SxE2NTnncC1pWxHUY=` |
| LastModified | `2026-09-23T15:30:51.000+0000` |
| SPA | `index-BR49bZTp.js` |

SHA and SPA match the accepted baseline. LastModified advanced
from `12:29:41` because of the earlier SES env update; the code
hash did not change. Forward-reconciled. Production was not rolled
back.

Inspect Lambda restored to
`yYb/cXdUXkVh6JIesDAXwPcLmPwyTy86WwWvf4+xyso=` after read-only
RDS queries.

## B. Current financial flags

Live Lambda environment (read-only, not updated):

| Flag | Live |
|---|---|
| `AWS_CHECKALT_ENABLED` | `true` |
| `AWS_PROVIDER_EXECUTION_ENABLED` | `true` |
| `AWS_FINANCIAL_PERMISSIONS_ACTIVATED` | `true` |
| `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED` | `false` |
| `AWS_ENDORSEMENT_AUTO_ADVANCE` | `false` (left false) |
| `AWS_MOOV_ENABLED` | `false` (left false) |
| `AWS_CHECKALT_STATUS_RECONCILE_ENABLED` | `false` |
| `AWS_PROVIDER_WEBHOOK_DRY_RUN` | `true` |
| `AWS_EMAIL_MODE` | `ses` |

`productionCheckAltExecutionAllowed` = true
(`checkalt` + financial permissions + not sandbox).

Freedom `checkalt_tenant_accounts`: enabled, registered, SSO
present. Live `auto_approve_enabled=true`,
`auto_approve_max_cents=200000`. Those DB flags are **not**
wired into submit/approve. They were not changed.

## C. Existing CheckAlt implementation found

Already in current production (not rebuilt):

- `POST /functions/v1/checkalt-submit-deposit` →
  `handleProductionCheckAltSubmit` → one
  `/fincapture/deposit/process`
- `POST /functions/v1/checkalt-approve-deposit` → refresh
  `/fincapture/deposit/item` then `/fincapture/deposit/approve`
  using stored `checkalt_reference`. Never calls process.
- Client: `src/lib/checkaltDepositOrchestrator.ts`
  (prep → eligibility → `deposit.submit` TOTP → submit)
- Approve UI: `src/components/settings/CheckAltSettings.tsx`
  (`deposit.approve` step-up, then `checkalt-approve-deposit`)
- Provider client: `aws/functions/api/providers/parity/checkalt-client.mjs`
- Idempotency: `checkalt-idempotency.mjs` + unique
  `(tenant_id, idempotency_key)`
- Eligibility: endorsements + official `.checkalt.jpg` + rear
  fingerprint (`checkalt-eligibility.mjs`)
- Secrets ARN:
  `checksops/production/provider-At4ZFR`

Live RDS already has SQL 65 writer columns/functions
(`idempotency_key`, `amount_cents`, `provider_http_attempted_at`,
`aws_checkalt_production_config`,
`aws_financial_execution_active`). The repo file header that
still says `NOT_APPLIED` is stale documentation only and was not
rewritten.

## D. Prior CheckAlt work preserved / reconciled

Current production already contains the approved CheckAlt delta
**plus** later accepted SES / ledger-grant / staff work.

No CheckAlt code was forward-ported or overwritten.
SES, ledger grant, staff check operations, OCR, branding, public
workflows, Cognito, and current RDS/S3 behavior were not touched.

Earlier today (before this cutover step) Freedom check
`0121319295` / `a3a4a153-46e1-4c28-a273-79a9bd04f3a6` already
completed the preserved path:

| Field | Value |
|---|---|
| Deposit | `b6adc6a6-232f-4748-add3-edff3c4036d4` |
| CheckAlt reference | `123733567` |
| Local status | `submitted` |
| `provider_http_attempted_at` | `2026-09-23T01:01:04.184Z` |
| Idempotency key | `92734979f3c2bd8407f6e4d69607e11c4be29cdde9f8f33a14f0583cc97877ab` |

That row was **not** resubmitted.

## E. Provider configuration status

- `checkalt_config.default_enabled=true`
- base URL and merchant present
- Freedom depositor registered (`sso_user_id` present)
- Production secrets ARN present
- Sandbox execution off
- Status-reconcile job off

Ready for a **new** process only when a check also passes
eligibility and has no existing provider reference.

## F. Deposit/process safety proof

Existing tests (71 passed this run):
`api-checkalt-production`, `checkalt-deposit-preflight`,
`checkalt-endorsement-gate`, `checkalt-status-read-gate`.

Code proof:

1. Submit posts `/fincapture/deposit/process` only after
   `markHttpAttempted` CAS (`provider_http_attempted_at IS NULL`
   and `checkalt_reference IS NULL`).
2. Existing reference / attempted_at / terminal status replays
   and does not POST process again.
3. Browser image bytes and amount spoof are rejected.
4. Provider HTTP happens only after eligibility + image load +
   durable queued row.
5. Failed HTTP persists `error` / `submitting`; success required
   for `pending_approval` (40) or `submitted`.
6. 127 / Approved maps to local `submitted`. Cleared requires
   provider `depositDate`.

## G. Duplicate / idempotency proof

- Key = `sha256(tenant \| checkalt_deposit \| check_id \| cents \| USD)`
- Unique index
  `checkalt_deposits_tenant_idempotency_key_uq`
- `pickBlockingDeposit` prefers any row with
  `checkalt_reference`, then any HTTP attempt
- 23505 insert collision loads the existing row and reconciles
- Tests: duplicate / simultaneous claim / legacy NULL key /
  historical reference all refuse a second process POST

## H. Approval / TOTP proof

- Submit `requireStepUp: true`, action `deposit.submit`,
  30-minute TTL, bound to check id + server amount cents
- Approve uses stored `referenceNumber`; path is
  `/fincapture/deposit/approve` only
- Approve does not insert a deposit (`createdDeposit: false`)
- UI `deposit.approve` step-up remains; server approve does not
  weaken submit TOTP
- Auto-approval was not enabled or modified
- Tests: leftover / other-check / amount-change / stale TOTP
  all `step_up_required`; approve posts only while provider
  remains 40 / `pending_approval`

## I. Real deposit-ready check selected

None.

Inspected unused Freedom `ready_for_deposit` /
`approved_for_deposit` checks:

| Check | Claim | Amount | Why not selected |
|---|---|---|---|
| `9562` | `0829002096` | `$9984.11` | payee `tenant_id` null; no official rear |
| `070668` | `2026-233663` | `$19805.42` | payee `tenant_id` null; no official rear; one insured payee still pending |
| `9020169620` | `22882660` | `$13257.25` | payee `tenant_id` null; rear not `.checkalt.jpg`; no rear fingerprint; existing rejected CheckAlt ref `119599317` |
| `3480171849` | `051802777018` | `$8745.19` | payee `tenant_id` null; no official rear; insured payee pending |
| `0121319295` | `250356537` | `$1546.72` | eligibility would pass, but already submitted as `123733567` |

`review` / `needs_review` checks were not treated as deposit-ready.

## J. Pre-deposit validation

No candidate passed all gates:

- Freedom tenant ownership: all five are Freedom
- Endorsements + official `.checkalt.jpg` + rear fingerprint:
  only `0121319295`
- No existing CheckAlt reference: fails for `0121319295` and
  `9020169620`
- Provider config: ready
- Fresh `deposit.submit` TOTP: not requested because no unused
  eligible check exists

If tenant_id were hypothetically filled (diagnostic only; not
applied): `9562` / `070668` / `3480171849` still fail
`provider_rear_image_missing`; `9020169620` still fails
`rear_fingerprint_missing` and is blocked by `119599317`.

## K. CheckAlt provider request result

Not sent. Phase 5 was not entered.

## L. CheckAlt reference

None new. Existing `123733567` left untouched.

## M. Provider status / result

No new provider call.

## N. Local deposit status

No new `checkalt_deposits` row.

## O. Manager / Bank Deposits result

Not exercised. No new transaction.

## P. Duplicate-submission verification

No process POST was issued. Existing references remain
one-row / one-reference.

## Q. CHECKALT PRODUCTION DEPOSIT — COMPLETE

**PENDING REAL INPUT**

## R. Concrete remaining CheckAlt blocker

Need one unused Freedom check that already has:

1. All required endorsements signed (authoritative endorsement
   rows, tenant-safe payees)
2. Official front and rear `.checkalt.jpg`
3. Matching `checkalt_rear_fingerprint`
4. No existing `checkalt_reference` / provider HTTP attempt
5. Operator `deposit.submit` TOTP bound to that check and amount

Do not manufacture images, do not reuse `0121319295` /
`123733567`, do not lift endorsement auto-advance to create
eligibility.

## S. Remaining blocker before DISBURSEMENT

CheckAlt production deposit execution is not closed.
Moov remains out of scope. Do not enable `AWS_MOOV_ENABLED`.
Do not start ACH / RTP / wire / wallet payout.

## T. Production components now FROZEN

Unchanged CLOSED set:

1. Cognito
2. AWS `/prep` API
3. RDS / S3
4. OCR / Textract
5. Branding / public assets
6. Public Sign
7. Public Endorse
8. Homeowner upload
9. Ledger / tracking
10. Token / storage / tenant isolation
11. Authenticated Freedom staff check operations
12. Production SES application email
13. `homeowner-ledger-send` GRANT correction

CheckAlt production deposit path is **not** frozen.

## U. SINGLE NEXT MASTER AWS CUTOVER ITEM

**CHECKALT / PRODUCTION DEPOSIT EXECUTION**

Wait for the next legitimate unused deposit-ready Freedom check.
Then process exactly one through the existing UI/API, with TOTP,
without a second `/deposit/process`.

Do not begin Moov.
