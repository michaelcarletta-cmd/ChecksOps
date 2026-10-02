# M6.4E — Bank-verify application contract (no staging deploy)

Bank-verify writes stay **false**. Money flags stay **false**. The DynamoDB
table is still operator-only and was **not** created from this workstream.

## Feature / work completed

Harden the recipient bank-verify contract around the planned durable store,
mocked Moov paths, public UI, and operator IAM package.

READY_FOR_INTEGRATION: application + tests in this branch.
OPERATOR_STEP_REQUIRED: table create + Lambda identity policy (unchanged from M6.4D.3).
NOT_READY_FOR_INTEGRATION: enabling the write flag, SPA deploy, or microdeposit.

## Store contract

- States: `not_started` → `initiation_claimed` → `verification_pending` | `uncertain` | `verified`
- CAS PutItem; concurrent second claim does not POST again
- MV 3/15 limiter via UpdateItem; isolated by recipient + account + bank + token fingerprint
- Claim TTL 90 days (expired claims become reclaimable); verified items remove TTL
- MV window TTL = window + 1 hour
- `tenant_id` stamped; mismatch fails closed
- Audit helper redacts routing, account, token, codes
- Public responses drop routing/account/code fields

## Probe

Direct-invoke prove no longer attempts table-admin (`CreateTable`, `DeleteItem`,
`PutResourcePolicy`). `action=provision` returns `operator_table_create_required`.
Synthetic cleanup uses UpdateItem TTL, which is allowed on the Lambda role.

## Frontend

- Restored missing `tosDropToken` state (ToS continue was a runtime ReferenceError)
- Dark button unless `bank_verify_available === true`
- Mapped writes_blocked / rate-limit / max-attempts messages
- No sessionStorage/localStorage for MV codes

## Operator package (do not apply here)

1. `aws/production/bank-verify-state-table.yaml`
2. `aws/production/bank-verify-state-lambda-policy.json` or
   `aws/production/bank-verify-state-lambda-iam.yaml`

## Holds

Do not deploy `checksops-staging-api`. Do not overlay production-prep.
Do not enable `AWS_PROVIDER_RECIPIENT_BANK_VERIFY_WRITES_ENABLED`.
Do not send a microdeposit.
