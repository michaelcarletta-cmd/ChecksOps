# M6.4D — Prepare AWS Moov bank verification

**STOP FOR REVIEW.** Routes exist. The narrow write flag stays **false**.
Do not click Send verification deposit. Do not submit an MV code. Do not move money.

## Inventory (before this phase)

| Surface | Previous | Now |
|---|---|---|
| Initiate | Lovable `moov-recipient-bank-verify` `action=initiate` POST `/verify` | AWS `POST /prep/public/moov-recipient-bank-verify-initiate` |
| MV confirm | Same Edge function `action=confirm` PUT `/verify` | AWS `POST /prep/public/moov-recipient-bank-verify-confirm` |
| SPA | Hold copy only | Prepared button + MV form, gated on `onboarding.bank_verify_available === true` |
| Lovable | Still in repo, unused by production SPA | SPA has no `functions.invoke` |

## Binding

Pay-setup token → recipient `62a858ff-ee6a-49d7-9898-1c8e4a44227b` → Moov account
`ee8c608e-dc2d-45d3-95e9-3c992f3dfc5f` → live bank matching last4 `1506`
(`72eb66c1-d9a9-4f85-ab50-8871db9ceeea`). Browser account/bank/recipient ids are rejected.

## Initiation fail-closed

1. Re-read live bank + `/verify`.
2. Require same bank, KYC verified, ToS accepted, method `instant_micro_deposit`.
3. Skip POST when already initiated or verified.
4. In-process lock + deterministic `X-Idempotency-Key`.
5. Timeout/network: GET-reconcile; return `initiate_uncertain`; do not retry inside the request.

## MV code

Human enters it only in ChecksOps. Never logged, stored, or echoed. PUT to Moov only.
In-memory max 3 attempts / 15 minutes plus Moov max-attempt mapping.

## Flags

`AWS_PROVIDER_RECIPIENT_BANK_VERIFY_WRITES_ENABLED` (narrow, default false).

These stay false: `AWS_MOOV_ENABLED`, `AWS_PROVIDER_EXECUTION_ENABLED`,
`AWS_FINANCIAL_PERMISSIONS_ACTIVATED`, `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED`.

Lambda code SHA after dark deploy: `nkn7FhOZnRUHyzC6YwbyCEaZExtJDEM8YiRFczws+G0=`
(`auth-cognito.mjs` unchanged). Live flag `AWS_PROVIDER_RECIPIENT_BANK_VERIFY_WRITES_ENABLED=false`.

Live probes (no Moov POST):
- missing token → 400 `token_required`
- invalid token → 404
- dummy + real initiate/confirm → 403 `recipient_bank_verify_writes_blocked`, `liveProviderCalled=false`
- session 200: recipient/account preserved, `bank_should_initiate=true`, `bank_verify_available=false`

## Return card

```
AWS INITIATE ROUTE: POST /prep/public/moov-recipient-bank-verify-initiate
AWS MV VERIFY ROUTE: POST /prep/public/moov-recipient-bank-verify-confirm
LOVABLE BANK VERIFY REMAINING: unused by production SPA (Edge function still in repo)
SERVER BINDING: token → recipient + account + live Chase 1506
INITIATION IDEMPOTENCY: re-read + already-open + X-Idempotency-Key
CONCURRENT PROTECTION: in-process lock per recipient/account
UNCERTAIN RESPONSE HANDLING: GET reconcile, initiate_uncertain, no in-request retry
MV CODE LOGGING: redacted / never logged
MV CODE STORAGE: never persisted
MV RATE LIMIT: 3 attempts / 15 min in-memory
NARROW FEATURE FLAG: AWS_PROVIDER_RECIPIENT_BANK_VERIFY_WRITES_ENABLED=false
TRANSFER FLAGS: all execution flags false
SPA PREPARED: yes (gated on bank_verify_available)
INITIATION BUTTON ACTIVE: NO
TESTS: aws/tests/api-moov-m64d-bank-verify-aws.test.mjs
TARGET RECIPIENT: 62a858ff-ee6a-49d7-9898-1c8e4a44227b
TARGET ACCOUNT: ee8c608e-dc2d-45d3-95e9-3c992f3dfc5f
TARGET BANK: 72eb66c1-d9a9-4f85-ab50-8871db9ceeea
MICRODEPOSIT INITIATED: NO
MONEY MOVED: NO
SAFE TO ENABLE ONE HUMAN INITIATION: NO until this flag is reviewed on
GO/NO-GO: GO to review dark routes. NO-GO to click Send verification deposit.

STOP FOR REVIEW.
```
