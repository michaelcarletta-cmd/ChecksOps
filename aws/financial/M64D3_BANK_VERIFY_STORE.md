# M6.4D.3 — Operator-only create/prove bank-verify DynamoDB store

**STOP FOR REVIEW.** Bank-verify write flag stays **false**. No microdeposit.
Do not deploy `checksops-staging-api`. Do not broaden `ChecksOpsCursorCloudStaging`.

## What this agent could and could not do

This chat is **not** the integration/deployment chat. The only AWS identity
available here is `ChecksOpsCursorCloudStaging` via Cursor OIDC. There is no
already-authorized admin/deploy principal in this environment (no extra role
ARN, no AWS profile, no deploy secret).

| Action | Result |
|---|---|
| Broaden Cursor IAM | **not done** (forbidden) |
| Overlay `checksops-staging-api` | **not done** (forbidden) |
| Overlay `checksops-production-prep-api` | **not done** |
| Enable bank-verify / money flags | **not done** |
| Apply `aws/production/bank-verify-state-table.yaml` | **blocked** — Cursor lacks `dynamodb:CreateTable` / `DescribeTable`; CloudFormation table create still calls `DescribeTable` as the Cursor caller |
| `iam:PutRolePolicy` on `checksops-production-api-execution` | **blocked** — Cursor lacks IAM write on that role |
| Read-only Lambda config + direct-invoke prove + dark 403 routes | **done** (see proofs below) |

## Operator apply (already-authorized admin/deploy principal only)

Use a human/admin/deploy principal that already has DynamoDB table-admin and
IAM PutRolePolicy. Do **not** attach table-create rights to Cursor or to the
Lambda execution role.

### 1. Create the table stack (this template only)

```bash
aws cloudformation create-stack \
  --region us-east-1 \
  --stack-name checksops-recipient-bank-verify-state \
  --template-body file://aws/production/bank-verify-state-table.yaml

aws cloudformation wait stack-create-complete \
  --region us-east-1 \
  --stack-name checksops-recipient-bank-verify-state
```

Do **not** `UpdateStack` `checksops-production-prep-api` (that would reset live
env/flags/role/code). Do **not** deploy `checksops-staging-api`.

Expected table:

| Property | Value |
|---|---|
| Name | `checksops-recipient-bank-verify-state` |
| Keys | `pk` HASH, `sk` RANGE |
| Billing | PAY_PER_REQUEST |
| Encryption | SSE-DDB (`SSEEnabled: true`) |
| PITR | enabled |
| TTL | attribute `ttl` enabled (optional on items) |
| Deletion protection | enabled |
| Public access | none |

The template already attaches a **resource** policy for GetItem / PutItem /
UpdateItem / DescribeTable to:

- `arn:aws:iam::806168576068:role/checksops-production-api-execution`
- `arn:aws:iam::806168576068:role/checksops-production-prep-api-role`

No Scan. No `Resource: *`. No create/delete/table-admin on Lambda.

### 2. Grant Lambda identity policy (four actions, one table)

```bash
aws iam put-role-policy \
  --role-name checksops-production-api-execution \
  --policy-name RecipientBankVerifyStateLeastPrivilege \
  --policy-document file://aws/production/bank-verify-state-lambda-policy.json
```

Do **not** attach `aws/production/bank-verify-state-table-operator-policy.json`
to the Lambda role. That operator policy is create-time only (CreateTable,
PITR, TTL, PutResourcePolicy, DeleteItem for cleanup).

### 3. Prove from existing prep Lambda (flag still false)

Direct-invoke only (not an HTTP route). Does not enable the write flag and
does not call Moov:

```bash
aws lambda invoke \
  --region us-east-1 \
  --function-name checksops-production-prep-api \
  --cli-binary-format raw-in-base64-out \
  --payload '{"checksops_bank_verify_state_probe":true,"action":"prove","probe_id":"synth-table-proof"}' \
  /tmp/m64d3-prove.json
```

Expected after table + IAM exist:

- DescribeTable / GetItem work
- first PutItem CAS claims
- concurrent second claim returns `claimed: false`
- UpdateItem MV limiter allows 3 then blocks
- synthetic cleanup: Lambda must **not** have `DeleteItem`; operator deletes
  `PROBE#m64d2#*` keys or relies on TTL

### 4. Re-run dark routes (flag still false)

Initiate and confirm must stay `403 recipient_bank_verify_writes_blocked`
with `liveProviderCalled=false`. Do not enable the flag. Do not deploy the
SPA button. Do not send a Moov microdeposit.

## Live proofs from this agent (table still absent)

Cursor identity: `arn:aws:sts::806168576068:assumed-role/ChecksOpsCursorCloudStaging/checksops-t0-run`.

Prep Lambda `checksops-production-prep-api` (read-only inspect, no overlay):

| Field | Value |
|---|---|
| Role | `arn:aws:iam::806168576068:role/checksops-production-api-execution` |
| CodeSha256 | `Rph+8NYdZcqPXIQqJ2CtjGyba4BX9KzWj+00FCHZ7cI=` (M6.4D.2 overlay, unchanged) |
| LastModified | `2026-09-12T19:05:25.000+0000` |
| Bank-verify writes | `false` |
| Money flags | all `false` |
| Table env | `AWS_RECIPIENT_BANK_VERIFY_STATE_TABLE=checksops-recipient-bank-verify-state` |

`checksops-staging-api` was **not** updated by this chat. Read-only LastModified `2026-09-12T19:42:03.000+0000` (other workstream). Drift was not “restored” by overlay.

CloudFormation stack `checksops-recipient-bank-verify-state` **does not exist**.

Direct-invoke prove (`probe_id=synth-table-proof-d3`, flag off, no Moov):

- DescribeTable / CreateTable / PITR / TTL / PutResourcePolicy / DeleteItem → `AccessDeniedException` on the Lambda role
- GetItem / PutItem CAS / UpdateItem MV → fail closed `bank_verify_state_unavailable`
- No synthetic item written

Dark HTTP (valid-shape dummy token sha12 `ffe054fe7ae0`; flag check is before recipient resolve):

- initiate → 403 `recipient_bank_verify_writes_blocked`, `liveProviderCalled=false`
- confirm → 403 `recipient_bank_verify_writes_blocked`, `liveProviderCalled=false`
- missing token → 400 `token_required`, `liveProviderCalled=false`

## Dependencies / deploy order

1. Operator creates table stack from `bank-verify-state-table.yaml`.
2. Operator attaches Lambda identity policy JSON (four actions).
3. Integration chat re-invokes the existing prove payload on
   `checksops-production-prep-api` (already has probe from M6.4D.2).
4. Integration chat re-runs dark initiate/confirm.
5. Human review. Flag stays false until a later designated enablement chat.

Do not merge this into a shared staging Lambda overlay independently.

## Tests

`npm run test:aws-api`: 685 pass / 0 fail / 3 skip (includes
`aws/tests/api-moov-m64d3-operator-table.test.mjs`).
