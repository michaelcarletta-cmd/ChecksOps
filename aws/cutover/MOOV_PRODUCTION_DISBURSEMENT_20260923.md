# Moov production disbursement — 2026-09-23

Cutover only. Existing Moov implementation was inspected and
preserved. No architecture review. No rebuild. No CheckAlt
changes. No endorsement auto-advance. No money flag mutation.
No real transfer sent.

Verdict:

**MOOV PRODUCTION ACTIVATION — COMPLETE: NO**

**MOOV PRODUCTION DISBURSEMENT ACCEPTANCE — NOT READY**

Enabling `AWS_MOOV_ENABLED` is **not** the only remaining step
and was **not** performed.

## A. Current production baseline

Live read-only confirm (this run):

| Item | Live value |
|---|---|
| Lambda | `checksops-production-prep-api` |
| CodeSha256 | `pVwEBVCZJG5PCS6kVmktMiziQ3SxE2NTnncC1pWxHUY=` |
| LastModified | `2026-09-23T15:30:51.000+0000` |
| SPA | `index-BR49bZTp.js` |

Forward-reconciled. Production was not rolled back.
Inspect Lambda restored to
`yYb/cXdUXkVh6JIesDAXwPcLmPwyTy86WwWvf4+xyso=`.

## B. Current financial flags

Unread-only. Not updated.

| Flag | Live |
|---|---|
| `AWS_CHECKALT_ENABLED` | `true` (unchanged) |
| `AWS_PROVIDER_EXECUTION_ENABLED` | `true` |
| `AWS_FINANCIAL_PERMISSIONS_ACTIVATED` | `true` |
| `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED` | `false` |
| `AWS_ENDORSEMENT_AUTO_ADVANCE` | `false` (left false) |
| `AWS_MOOV_ENABLED` | `false` (left false) |
| `AWS_PLAID_ENABLED` | `false` |
| `AWS_PROVIDER_WEBHOOK_DRY_RUN` | `true` |
| `AWS_PROVIDER_LIVE_READS_ENABLED` | `false` |
| `AWS_MOOV_TRANSFER_POST_ENABLED` | `false` |
| `AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED` | `false` |
| `AWS_EMAIL_MODE` | `ses` |

`executionAllowed('moov')` is false.

## C. Existing Moov implementation status

Already in current production. Not rebuilt.

Handlers used today:

| Concern | Existing piece |
|---|---|
| Identity / account readiness | `moov-readiness`, `moov.mjs` local snapshot, `evaluateReadiness` |
| Wallet | `moov-wallet-sync` / `parity/moov-wallet.mjs` (sandbox parity) |
| Bank connection | `moov-bank-*`, `payment_provider_methods` |
| Payout / transfer | `moov-transfer-create`, `moov-disburse` in `parity/moov-money.mjs` |
| Transfer status | `moov-transfer-status` (sandbox write-back) |
| Webhook | `POST /webhooks/moov` verify + dry-run receipt |
| Step-up | UI `disbursement.send` via `useFinancialGuard` |
| Idempotency | `payment_transfers.idempotency_key` persist-before-HTTP |

CheckAlt has dedicated production handlers that run **before**
the production hard-block. **Moov does not.**

`handleFunctionInvoke` in `providers.mjs`:

if `executionAllowed(provider)` and the spec is not `db_status`
or `webhook`, return `production_execution_blocked`
(`tranche4HardBlock: true`).

Parity `requireParityEnabled('moov')` also refuses when
`executionAllowed('moov')` is true, and refuses production
credentials on that path.

Therefore the already-built Moov money path is sandbox-parity
only. There is no CheckAlt-equivalent production Moov submit.

## D. Production Moov provider / account status

Provider secret `checksops/production/provider-At4ZFR`:

- `MOOV_ENVIRONMENT=production`
- `MOOV_PUBLIC_KEY` / `MOOV_SECRET_KEY` configured
- Sandbox Moov keys also present (not used)
- No `MOOV_ACCOUNT_ID` key in that secret
- `MOOV_WEBHOOK_SECRET_ARN` configured on the Lambda; secret
  present

Freedom tenant: `moov_allowlisted=true`,
`moov_environment=production`.

Mapped account
`60922058-7eca-4889-81dd-5720d7b9de96`
(`payment_provider_accounts` production, last synced
2026-08-28).

## E. Freedom Moov account / KYB status

| Field | Live |
|---|---|
| Account type | business |
| Onboarding | `active` |
| Verification | `verified` |
| TOS | accepted |
| Disabled / restricted | false / false |

## F. Capabilities status

Local snapshot (not a live Moov GET;
`AWS_PROVIDER_LIVE_READS_ENABLED=false`):

| Capability | Status |
|---|---|
| `send-funds` | enabled |
| `transfers` | enabled |
| `wallet` | enabled |
| `collect-funds` | in-review |

Matches `can_send_payments=true`, `can_ach_credit=true`,
`can_ach_debit=false`.

## G. Wallet status

One production operating wallet. Status `active`.
`available_cents=0`, `pending_cents=0`. Last synced
2026-09-03. Provider wallet id present.

No source funds available for a new payout from this snapshot.

## H. Bank / payout destination status

One Freedom production `payment_provider_methods` row:
`connection_status=connected`, bank id present, payment-method
id absent, `is_default=false`.

Four `external_payment_recipients` named Michael Carletta with
provider accounts. No `tenant_payout_preferences` /
`payout_preferences` table.

Parity `loadConnectedMethod` reads **sandbox** methods only.
It would not use this production bank row.

## I. Webhook status

- AWS `POST /webhooks/moov` exists
- Signature verify present (HMAC-SHA512 + legacy)
- Dry-run default still **true**
- Apply is separately gated:
  sandbox execution on **and** financial permissions off **and**
  provider execution off. Production already fails that gate, so
  apply cannot mutate production rows.
- `aws_provider_webhook_receipts` has no Moov rows
- Duplicate event id is ignored (existing test)

Webhook health is verify/receipt only. It does not move money
and would not start moving money if `AWS_MOOV_ENABLED` flipped.

## J. Financial safety controls

Existing tests passed (`api-providers` 41, plus
`api-provider-parity` / financial amount-ownership tests).

| Control | Existing behavior |
|---|---|
| Authenticated user | Cognito JWT required on `/functions/v1/*` |
| Tenant ownership | Membership check; browser tenant spoof denied |
| Financial role | Parity `canSendPayments` = owner/admin/manager or platform admin |
| TOTP | UI `disbursement.send` only. **Not** server-bound like CheckAlt `deposit.submit` |
| Server amount | Financial prepare rejects browser amounts. Parity `transferCreate` still reads `body.amount_cents` |
| Server destination | Loaded from mapped recipient/method, not browser Moov ids |
| Failed provider | Persist `failed`; 502; no success |
| Audit | `logPaymentEvent` / `aws_financial_audit` on financial prepare |

Concrete gap that blocks safe activation: there is no
production Moov handler that enforces CheckAlt-class server
TOTP + server amount **and** talks to production Moov.

## K. Idempotency / duplicate-transfer proof

- Draft insert with `idempotency_key` before HTTP
- Replay existing row; 409 on unique collision
- Provider key `checksops-transfer-{draft.id}` /
  `checksops-disb-split-{split.id}`
- Webhook unique `(provider, external_event_id)`; duplicate
  does not apply
- Apply never writes production-environment rows
- `moov-sweep` / `wallet-fund-on-clear` scheduled jobs stay
  `financial_job_disabled`

No queued Freedom `payment_transfers`. Historical
`disbursement_batches` are `completed` with `submitted_at` null
and would not fire from a flag flip.

## L. Automatic financial side effects of enabling `AWS_MOOV_ENABLED`

No automatic money movement from the flag alone:

- No queued transfers
- Sweep/fund-on-clear jobs remain disabled
- Webhook apply remains off (dry-run + apply gate)
- CheckAlt production handlers are independent
- `AWS_ENDORSEMENT_AUTO_ADVANCE` is a different flag

What the flag **would** do:

`executionAllowed('moov')` becomes true, so Moov mutations
return `production_execution_blocked`. That does **not**
activate a working production disbursement path.

## M. Exact activation change required

Not just `AWS_MOOV_ENABLED=true`.

Still required before a safe flip that actually pays:

1. An already-approved **production** Moov transfer/disburse
   handler (CheckAlt-style), or an approved exception that the
   current hard-block is the intended production path
2. Server-authoritative amount + destination + TOTP on that path
3. Production method/wallet load (not hardcoded `sandbox`)
4. Source funds (`available_cents` > 0 or approved bank debit;
   collect-funds is still in-review)
5. Operator authorization for one specific real payout

Do not rebuild those here.

## N. Whether Moov was activated

**No.** `AWS_MOOV_ENABLED` remains `false`.

## O. Post-activation non-money regression

Not run. Activation did not occur.

## P. Legitimate real disbursement currently available

**No.**

Wallet `$0.00`. `can_ach_debit=false` / `collect-funds`
in-review. No pending `payment_transfers`. Historical batches
are already `completed`. No check-linked unused payout was
identified that is both funded and eligible on the AWS
production path.

## Q. Candidate disbursement details

None. Recipients exist (Michael Carletta ×4) but there is no
funded, unused, check-authorized payout to send. Per the
cutover rule, even a candidate would require explicit operator
authorization before the irreversible provider call.

## R. MOOV PRODUCTION ACTIVATION — COMPLETE

**NO**

## S. MOOV PRODUCTION DISBURSEMENT ACCEPTANCE

**NOT READY**

(Not a fabricated-transaction failure. The production
execution path is not activatable by the flag alone, and no
funded real payout is waiting.)

## T. Concrete remaining blocker

1. **Primary:** flipping `AWS_MOOV_ENABLED` hard-blocks Moov
   mutations and does not enable a production transfer.
   CheckAlt already has a production handler; Moov does not.
   Do not rebuild it in this cutover.
2. Freedom wallet available balance is `0`.
3. `collect-funds` / ACH debit is not enabled.
4. Server TOTP for `disbursement.send` is UI-only.
5. Parity money path uses sandbox account/method rows and
   browser `amount_cents`.

## U. Production components now FROZEN

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

Still **not** frozen:

- First new production check intake — PENDING REAL INPUT
- CheckAlt fresh production acceptance — PENDING REAL INPUT
  (do not reuse `123733567`)
- Moov production activation / disbursement

## V. SINGLE NEXT MASTER AWS CUTOVER ITEM

**MOOV / PRODUCTION DISBURSEMENT**

Wait for an already-approved production Moov execution delta
(or an explicit operator decision that the current hard-block
is acceptable and a later handler will be the activation).
Do not flip `AWS_MOOV_ENABLED` until that exists.
Do not manufacture a transfer.
Do not reopen CheckAlt or frozen components.
