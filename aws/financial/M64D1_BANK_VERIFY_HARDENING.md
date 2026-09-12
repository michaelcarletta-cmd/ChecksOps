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

SPA Send verification deposit remains gated on `bank_verify_available === true`.
