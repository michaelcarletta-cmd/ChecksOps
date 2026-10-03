# M6.4D.2 — Create/prove durable bank-verify store

**STOP FOR REVIEW.** Bank-verify write flag stays **false**. No microdeposit.

## Table definition (reviewed)

| Property | Value |
|---|---|
| Name | `checksops-recipient-bank-verify-state` |
| Keys | `pk` (HASH), `sk` (RANGE) |
| Billing | PAY_PER_REQUEST |
| Encryption | SSE-DDB (`SSEEnabled: true`, AWS owned) |
| PITR | enabled in templates |
| TTL | optional attribute `ttl` (synthetic probe items only) |
| Public access | none (no `Principal: "*"` allow) |
| IAM | GetItem, PutItem, UpdateItem, DescribeTable on this table ARN only. No Scan. No `Resource: *`. |

Templates: `aws/production/bank-verify-state-table.yaml`, `aws/production/api-cfn.yaml`.

## What this agent could and could not do

`ChecksOpsCursorCloudStaging` **can** `cloudformation:CreateStack` for a new stack name and **can** invoke the prep Lambda.

It **cannot** `dynamodb:CreateTable` / `DescribeTable` / `PutResourcePolicy`.

CloudFormation table create fails because the CloudControl resource handler calls `DescribeTable` with the Cursor principal and is AccessDenied. Direct Lambda `CreateTable` is also AccessDenied (`checksops-production-api-execution` has no DynamoDB identity policy yet).

This does **not** broaden `ChecksOpsCursorCloudStaging`.

## Operator step (already-authorized admin principal)

Attach `aws/production/bank-verify-state-table-operator-policy.json` to an admin/deploy principal (not the staging Cursor role), then apply `aws/production/bank-verify-state-table.yaml` as stack `checksops-recipient-bank-verify-state`.

Alternatively attach the same actions to `checksops-production-api-execution` for this table ARN only, then re-invoke the direct Lambda probe:

```
{"checksops_bank_verify_state_probe":true,"action":"prove","probe_id":"synth-table-proof"}
```

The probe is direct-invoke only. It is not an HTTP route. It never enables the write flag and never calls Moov.

## Live overlay

Lambda CodeSha256 `Rph+8NYdZcqPXIQqJ2CtjGyba4BX9KzWj+00FCHZ7cI=` (`auth-cognito.mjs` unchanged).
Flags: bank-verify writes **false**; money flags **false**. Table env name is set.

Direct-invoke store probe (flag off, no Moov):
- DescribeTable / CreateTable → `AccessDeniedException` on `checksops-production-api-execution`
- GetItem/PutItem/UpdateItem → fail closed `bank_verify_state_unavailable`
- No synthetic item written

Dark HTTP probes: real initiate/confirm → 403 `recipient_bank_verify_writes_blocked`, `liveProviderCalled=false`.
