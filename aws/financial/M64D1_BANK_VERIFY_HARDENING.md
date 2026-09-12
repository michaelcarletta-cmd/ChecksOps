# M6.4D.1 — Harden bank verification before live enablement

**STOP FOR REVIEW.** Durable claim + MV limiter are in AWS code. The narrow write
flag stays **false**. Do not click Send verification deposit. Do not submit an MV
code. Do not move money.

## Why

M6.4D dark routes are accepted, but two protections were process-local:

1. Initiation lock was an in-memory `Map`.
2. MV 3/15-minute limiter was an in-memory `Map`.

Those cannot serialize concurrent Lambda instances.

## Durable store

DynamoDB table `checksops-recipient-bank-verify-state` (pay-per-request).

Env: `AWS_RECIPIENT_BANK_VERIFY_STATE_TABLE` (not a money flag).

No RDS/SQL72. Public pay-setup has no Cognito identity, so Postgres RLS is not
used for this lock.

Keys never contain MV codes or raw `secure_token` values. Token identity is
`sha256(token).slice(0, 16)`.

### Initiation claim

1. Validate live Moov bank/account/KYC/ToS first.
2. If verified or already initiated, persist that state and **do not POST**.
3. `PutItem` claim with condition `attribute_not_exists(pk) OR state = not_started`.
4. Winner POSTs `/accounts/{bound}/bank-accounts/{bound}/verify` with the same
   deterministic `X-Idempotency-Key`.
5. Losers reconcile via GET and **never POST**.
6. Timeout / lost response → persist `uncertain` or reconcile to
   `verification_pending`; never blind-retry.

### MV limiter

Scope: recipient + account + bank + token fingerprint + confirm action.

`UpdateItem` increments `attempts` where `attempts < 3` in a 15-minute server-clock
window. Consume **before** Moov PUT. Wrong code consumes. Provider/network failure
consumes. Limiter errors fail closed (no PUT).

## State machine

`not_started` → `initiation_claimed` → `verification_pending` | `uncertain` | `verified`

`verified` does not regress.

## Binding (unchanged)

Token → recipient `62a858ff-ee6a-49d7-9898-1c8e4a44227b` → account
`ee8c608e-dc2d-45d3-95e9-3c992f3dfc5f` → Chase `72eb66c1-d9a9-4f85-ab50-8871db9ceeea`.
Browser bank/account/recipient ids are rejected. Transfer paths remain denied.

## Flags

`AWS_PROVIDER_RECIPIENT_BANK_VERIFY_WRITES_ENABLED=false`

Money flags stay false: `AWS_MOOV_ENABLED`, `AWS_PROVIDER_EXECUTION_ENABLED`,
`AWS_FINANCIAL_PERMISSIONS_ACTIVATED`, `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED`,
`AWS_CHECKALT_ENABLED`.

Lambda code SHA after dark overlay: `eMfH8wuH68Q7BW8aZhNQsZpkboMBKprruvnROixatJQ=`
(`auth-cognito.mjs` unchanged, sha `d3c8178fd5fa9709da055e0fbed3ec41dc2243d8f4a729479257a6decb0cd199`).
Live flag `AWS_PROVIDER_RECIPIENT_BANK_VERIFY_WRITES_ENABLED=false`.
Live env `AWS_RECIPIENT_BANK_VERIFY_STATE_TABLE=checksops-recipient-bank-verify-state`.

This Cursor IAM role cannot `dynamodb:CreateTable`. The table resource is in
`aws/production/api-cfn.yaml` with a resource-based policy for the prep API role.
It is **not applied** in this phase.

Live probes (no Moov POST):
- missing token → 400 `token_required`
- invalid token → 404
- dummy + real initiate/confirm → 403 `recipient_bank_verify_writes_blocked`, `liveProviderCalled=false`
- session 200: recipient/account preserved, `bank_should_initiate=true`, `bank_verify_available=false`

SPA was not redeployed. Production JS has no Send verification deposit string.

## Return card

```
DURABLE INITIATION STORAGE: DynamoDB table checksops-recipient-bank-verify-state (CAS PutItem)
CAS/UNIQUE CLAIM: attribute_not_exists(pk) OR state=not_started; one claimant
CROSS-LAMBDA SAFE: yes in code; live table not created by this agent
PROVIDER IDEMPOTENCY: checksops-recipient-bank-verify:{recipientId}:{bankId}
UNKNOWN-OUTCOME HANDLING: persist uncertain / reconcile GET; never blind-retry POST
DURABLE MV RATE LIMIT: DynamoDB UpdateItem 3 attempts / 15 min window; consume before PUT
RATE LIMIT FAIL-CLOSED: 503 if store/table/credentials unavailable; no PUT
STATE MACHINE: not_started → initiation_claimed → verification_pending | uncertain | verified (no verified regression)
SQL/MIGRATION REQUIRED: NO
SQL APPLIED: NO
SPA DEPLOYED: NO (git prepared; live bundle has no Send-deposit button)
BUTTON ACTIVE: NO
BANK VERIFY FLAG: false
TRANSFER FLAGS: all false
TESTS: aws/tests/api-moov-m64d1-harden-bank-verify.test.mjs (plus M6.4D); npm run test:aws-api 677 pass / 0 fail / 3 skip
MICRODEPOSIT INITIATED: NO
MV CODE SUBMITTED: NO
MONEY MOVED: NO
SAFE TO ENABLE EXACTLY ONE HUMAN INITIATION: NO until the DynamoDB table exists and Lambda CAS is proven live
GO/NO-GO: GO to review hardening. NO-GO to enable the flag or click Send verification deposit.

STOP FOR REVIEW.
```
