# M6.4C — Verify live KYC + ToS completion

**STOP FOR REVIEW.** Read-only GET of production Moov + existing AWS session.
Do not initiate micro-deposits. Do not enable bank verification. Do not move money.

## Live reads (2026-09-12)

GET `/accounts/{id}`, `/capabilities`, `/bank-accounts`, `/bank-accounts/{bankId}`,
`/payment-methods`, `/transfers?count=20` on account
`ee8c608e-dc2d-45d3-95e9-3c992f3dfc5f`.

AWS session `POST /prep/public/moov-recipient-session` with existing token
sha12 `9acf164e4c0a` (token not printed, not consumed).

Live db-bridge (`mode=read_only`, writes/deletes/rpc/rawSql false) on
`external_payment_recipients`: target row unchanged
(`id=62a858ff-ee6a-49d7-9898-1c8e4a44227b`,
`provider_account_id=ee8c608e-dc2d-45d3-95e9-3c992f3dfc5f`,
Chase last4 `1506`, `onboarding_status=awaiting_bank`, `token_used_at=null`).
`created_at=2026-08-31`; `updated_at=2026-09-10` (token issuance, not today's KYC).
`payment_transfers=0`. Two older production recipients also show last4 `1506` on
**different** Moov accounts (`created_at` 2026-08-30 and 2026-08-31); they were
not created today and do not bind the target account.

RDS via Lambda `GET /db-readonly-validate`: `ok=true`, `readOnly=true`,
`writesAttempted=false`, `transactionReadOnly=on`, `productionSupabaseChanged=false`.
Application role without identity sees 0 core-table rows (expected RLS fail-closed).
No Lambda overlay and no SQL72.

CloudFront today: KYC/ToS AWS 200 once each after earlier 500s; **0** bank-verify,
**0** bank-add, **0** Lovable Edge KYC/ToS.

## Result

| Check | Result |
|---|---|
| Recipient | `62a858ff-ee6a-49d7-9898-1c8e4a44227b` |
| Moov account | `ee8c608e-dc2d-45d3-95e9-3c992f3dfc5f` individual production |
| KYC | `verified`; identity requirements `[]` |
| ToS | `acceptedDate=2026-09-12T17:37:31.697535Z` on that same account |
| Bank | one bank: JPMORGAN CHASE BANK, NA last4 `1506` id `72eb66c1-d9a9-4f85-ab50-8871db9ceeea` status `new` |
| Micro-deposit | eligible (`should_initiate=true`); **not** initiated |
| Transfers | `0` |
| Session status | `awaiting_bank`; `complete=false`; `token_consumed=false`; `mutated=false` |
| Live DB | 4 recipients total; 1 bound to target Moov account; transfers 0 |
| RDS | connected read-only; no writes; RLS fail-closed without identity |

## Money flags (live Lambda)

`AWS_MOOV_ENABLED=false`
`AWS_PROVIDER_EXECUTION_ENABLED=false`
`AWS_FINANCIAL_PERMISSIONS_ACTIVATED=false`
`AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED=false`
`AWS_CHECKALT_ENABLED=false`
`AWS_PROVIDER_LIVE_READS_ENABLED=true`
`AWS_PROVIDER_RECIPIENT_KYC_TOS_WRITES_ENABLED=true`

Lambda code SHA unchanged from M6.4B: `fzKym3Al65mKO/t3v4Z9i7/bP5hEh+0Fsil0BIWYApQ=`

## Return card

```
KYC STATUS: verified
KYC VERIFIED: YES
REMAINING REQUIREMENTS: none
TOS ACCEPTED: YES (acceptedDate 2026-09-12T17:37:31.697535Z)
TOS ACCOUNT BINDING: ee8c608e-dc2d-45d3-95e9-3c992f3dfc5f (exact target)
RECIPIENT PRESERVED: YES 62a858ff-ee6a-49d7-9898-1c8e4a44227b
MOOV ACCOUNT PRESERVED: YES ee8c608e-dc2d-45d3-95e9-3c992f3dfc5f
BANK PRESERVED: YES JPMORGAN CHASE BANK, NA last4 1506
BANK ID: 72eb66c1-d9a9-4f85-ab50-8871db9ceeea
LIVE BANK STATUS: new / unverified / not_started
MICRODEPOSIT ELIGIBLE: YES (instant_micro_deposit, should_initiate)
MICRODEPOSIT ALREADY INITIATED: NO
DUPLICATES CREATED: NO (1 account, 1 bank)
TRANSFERS CREATED: NO (0)
MONEY FLAGS: all execution flags false
MONEY MOVED: NO
NEXT REQUIRED ACTION: M6.4D prepare AWS bank-verification (do not initiate yet)
SAFE TO PREPARE BANK VERIFICATION: YES
GO/NO-GO: GO to prepare bank verification only. Do not send a verification deposit in this phase.

STOP FOR REVIEW.
```
