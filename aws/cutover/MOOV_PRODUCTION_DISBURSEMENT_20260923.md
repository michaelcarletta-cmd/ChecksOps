# Moov production disbursement — 2026-09-23

Cutover only. Existing Moov implementation was inspected and
preserved. No architecture review. No rebuild. No CheckAlt
handler rewrite. No endorsement auto-advance. No money flag
mutation. No real transfer sent.

Verdict:

**MOOV PRODUCTION EXECUTION IMPLEMENTATION — COMPLETE**

**MOOV PRODUCTION ACTIVATION — COMPLETE: NO**

The dedicated production handler is present and fail-closed.
Enabling `AWS_MOOV_ENABLED` is still **not** activation and
was **not** performed.

## A. Exact demonstrated gap addressed

Previous acceptance showed the existing Moov money path is
sandbox-parity only. Production mutations returned
`production_execution_blocked`. Parity `loadConnectedMethod`
read sandbox methods. Parity `transferCreate` trusted browser
`amount_cents`. UI `disbursement.send` TOTP was not
server-bound. Freedom wallet is `$0.00`. `collect-funds`
remains in-review.

This delta adds a dedicated production handler that:

1. Intercepts `moov-transfer-create` / `moov-disburse` before
   the sandbox-parity handler
2. Resolves amount and destination from RDS
3. Loads the production Moov payment method only
4. Requires a server-bound `disbursement.send` TOTP
5. Persists before HTTP and refuses a second create
6. Persists provider reference/status only from a documented
   provider success
7. Leaves the existing AWS Moov webhook verify path unchanged
   and still skips production apply

Wallet funding and collect-funds were **not** solved.

## B. Files / functions changed

Dedicated production handler:

- `aws/functions/api/providers/production/moov-dispatch.mjs`
- `aws/functions/api/providers/production/moov-holds.mjs`
- `aws/functions/api/providers/production/moov-authz.mjs`
- `aws/functions/api/providers/production/moov-submit.mjs`
- `aws/functions/api/providers/production/moov-idempotency.mjs`
- `aws/functions/api/providers/production/moov-methods.mjs`
- `aws/functions/api/providers/production/moov-secrets.mjs`

Wiring:

- `handleFunctionInvoke` in `providers.mjs` tries the
  production Moov handler before the tranche-4 hard-block
- `resolveFinancialStepUpBinding` accepts `disbursement.send`
  in addition to unchanged `deposit.submit`
- `AWS_MOOV_TRANSFER_POST_ENABLED` is now a first-class gate

CheckAlt production files were not modified.

## C. Dedicated production Moov handler

`runProductionMoovHandler` owns:

- `moov-transfer-create`
- `moov-disburse`

It recognizes production environment, the Freedom production
tenant `2eff5f1a-929d-4ce3-9a8b-cd96b98df42a`, production
Moov account `60922058-7eca-4889-81dd-5720d7b9de96`, and the
production execution flags.

Fail-closed unless every gate passes:

- `AWS_MOOV_ENABLED`
- `AWS_PROVIDER_EXECUTION_ENABLED`
- `AWS_FINANCIAL_PERMISSIONS_ACTIVATED`
- `AWS_MOOV_TRANSFER_POST_ENABLED`
- sandbox parity off
- Freedom production tenant + account
- financial role
- server-bound TOTP
- production payment method

While any gate is off the handler returns
`production_execution_blocked` / `provider_disabled` and does
not call Moov.

## D. Server-authoritative amount proof

Payable cents come from `payment_transfers.amount_cents` or
`disbursement_batches.approved_amount_cents` / payable splits.
Browser `amount_cents` is compared only. A mismatch is
`amount_mismatch`. Browser amount never becomes the posted
value. Tests cover tampering.

## E. Server-authoritative destination proof

Recipient and payout method are loaded from the approved
transfer or batch split. Tenant ownership and production
environment are verified. Browser recipient / method ids are
compared only. A mismatch is `destination_tamper`.

## F. Production payment-method proof

`loadProductionConnectedMethod` reads
`environment = 'production'` only. Sandbox methods return
`sandbox_method_refused`. A connected production row without
`provider_payment_method_id` returns
`production_method_missing`. Bank connection was not
redesigned.

## G. Server-bound disbursement.send TOTP proof

Authorization requires a fresh `financial_stepup_log` row
bound to:

- tenant
- transfer_id or batch_id
- server amount
- destination/recipient
- `operation = disbursement.send`

A token for another operation, amount, or destination is
`step_up_required`. Existing CheckAlt `deposit.submit` binding
is unchanged.

## H. Idempotency / duplicate proof

Key material is
`tenant|moov_disbursement|resource+destination|amount|USD`.
The transfer row is persisted before HTTP. CAS claims
`status='submitting'` only when `provider_transfer_id` is
null. An existing provider reference or a prior HTTP attempt
replays and does not POST again. Provider timeout/error stays
recoverable without a second create. Tests cover duplicate
key, existing reference, and concurrent claim.

## I. Provider-result persistence proof

Only a documented Moov transfer id plus a documented success
status (`created` / `queued` / `pending` / `completed`) is
persisted as success. HTTP-only or unknown status is
`provider_result_unsuccessful` and local status is `failed`.
Simulated provider failure leaves no provider reference.

## J. Existing webhook compatibility

`POST /webhooks/moov` verify + receipt is unchanged.
`applyMoovWebhook` still skips `production_environment_row`.
The production transfer persists `provider_transfer_id` so
the existing lookup can reconcile later when production apply
is intentionally enabled. Webhook mutation was not activated.

## K. Test results

`aws/tests/api-moov-production.test.mjs` plus existing
CheckAlt / TOTP / provider suites:

- Moov disabled → fail closed
- transfer-post disabled → fail closed
- wrong tenant / role → denied
- stale/missing TOTP → denied
- TOTP for different operation / amount / destination → denied
- browser amount / destination tampering → denied
- sandbox method / missing production method → denied
- duplicate idempotency key → no second create
- existing provider reference → no second create
- simulated provider failure → no false success
- simulated provider success → reference/status persisted
- webhook apply still skips production rows

No real Moov transfer was sent.

## L. Exact production deployment

Forward-only overlay of live `checksops-production-prep-api`.
Downloaded current production zip
(`pVwEBVCZJG5PCS6kVmktMiziQ3SxE2NTnncC1pWxHUY=`), copied
only this handler delta, re-zipped, `update-function-code`.
Staging Lambda SHA unchanged
(`n82ErD+mGSUt71qm2+4UyoF4SUVSArNa2qYIO/oWhaI=`).
Lambda environment was not updated.
CheckAlt handlers were not replaced.
`AWS_ENDORSEMENT_AUTO_ADVANCE` remains false.

Overlaid:

- `providers.mjs`
- `provider-flags.mjs`
- `ops-readiness.mjs`
- `auth-financial-totp.mjs`
- `providers/production/moov-*.mjs` (added)

Inspect Lambda
`checksops-endorsement-transition-inspect-e3dd` was used
read-only and restored to
`yYb/cXdUXkVh6JIesDAXwPcLmPwyTy86WwWvf4+xyso=`.

## M. Current production Lambda SHA / SPA after deployment

| Item | Live value |
|---|---|
| Lambda | `checksops-production-prep-api` |
| CodeSha256 | `zQzfz1Use78/jI/+t2FWpcCguCEK9uF/oMPejSAuDbY=` |
| LastModified | `2026-09-23T17:11:26.000+0000` |
| Previous SHA | `pVwEBVCZJG5PCS6kVmktMiziQ3SxE2NTnncC1pWxHUY=` |
| SPA | `index-BR49bZTp.js` (unchanged) |
| `/prep/health` | 200 `ok` / `production-prep` |
| `/prep/ops/readiness` | 200; reports `AWS_MOOV_TRANSFER_POST_ENABLED=false` |

Live readiness now includes the new first-class
`AWS_MOOV_TRANSFER_POST_ENABLED` flag, proving the overlay
is the running code.

## N. Current Moov flags

Live Lambda environment (unread after overlay; not mutated):

- `AWS_MOOV_ENABLED=false`
- `AWS_MOOV_TRANSFER_POST_ENABLED=false`
- `AWS_ENDORSEMENT_AUTO_ADVANCE=false`
- `AWS_CHECKALT_ENABLED=true` (unchanged)
- `AWS_PROVIDER_EXECUTION_ENABLED=true` (unchanged)
- `AWS_FINANCIAL_PERMISSIONS_ACTIVATED=true` (unchanged)
- `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED=false`
- `AWS_CHECKALT_STATUS_RECONCILE_ENABLED=false`
- `AWS_PROVIDER_WEBHOOK_DRY_RUN=true`
- `AWS_EMAIL_MODE=ses`

## O. Proof no real transfer occurred

Implementation tests use mocked `fetchImpl` only. No Moov
HTTP was issued from this run.

Live read-only RDS after overlay:

- Freedom production `payment_transfers`: **0 rows**
- Freedom production transfers with `provider_transfer_id`: **0**
- Freedom production wallet `473ceaca-3534-467b-8d92-49baa53f6c68`
  `available_cents=0`, `pending_cents=0`,
  `last_synced_at=2026-09-03T17:38:08.418Z` (unchanged)
- Latest CheckAlt deposit still `123733567`
  (`updated_at=2026-09-23T10:05:55.230Z`; not mutated)

No historical transfer executed. No wallet balance moved.

## P. MOOV PRODUCTION EXECUTION PATH — READY

**YES**

The code path is production-ready and remains disabled.

## Q. Remaining provider / funding blocker

- Freedom production wallet `available_cents=0`
- `collect-funds` remains in-review / `can_ach_debit=false`
- Production payout method still needs a Moov payment-method
  id before a real send can succeed

## R. Remaining requirement before activation

1. This implementation is accepted
2. Freedom has an eligible funding state/source
3. Production payout method is ready
4. A legitimate unused disbursement exists
5. Operator explicitly authorizes that specific real transfer

Do not flip `AWS_MOOV_ENABLED` or
`AWS_MOOV_TRANSFER_POST_ENABLED` until those are true.

## S. Production components now FROZEN

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
11. Staff check operations
12. SES application email
13. Ledger-token GRANT
14. CheckAlt deposit path (pending real unused input; do not
    reopen)

Still **not** frozen:

- First new production check intake — PENDING REAL INPUT
- CheckAlt fresh production acceptance — PENDING REAL INPUT
- Moov **activation** / funded live disbursement

The Moov **execution implementation** is complete and stays
disabled.

## T. SINGLE NEXT MASTER AWS CUTOVER ITEM

**MOOV / PRODUCTION ACTIVATION** — only after the five
activation requirements in R. Do not enable Moov. Do not send
a real transfer. Do not reopen architecture.

**MOOV PRODUCTION EXECUTION IMPLEMENTATION — COMPLETE**
