# Operator: production invite Cognito IAM (narrow)

**STOP unless you are the authorized production IAM operator.**  
`ChecksOpsCursorCloudStaging` is denied `iam:GetRole` / `iam:PutRolePolicy` on
`checksops-production-api-execution`. Do **not** broaden that staging role.

Do **not** CloudFormation-update `checksops-production-api-role` from
`aws/production/api-execution-role.yaml`. The live role has drifted from the
original stack (created 2026-09-06 with staging secret/bucket defaults). A
normal stack update can replace working production permissions.

Do **not** redeploy `checksops-production-prep-api`.  
Do **not** repeat SQL 80–83.  
Do **not** recreate tenant `prodonboard59ff`.  
Do **not** insert membership or `identity_production_cognito_locks` by hand.

## Live target

| Field | Value |
|---|---|
| Role | `checksops-production-api-execution` |
| Inline policy | `ProductionApiLeastPrivilege` |
| Pool | `arn:aws:cognito-idp:us-east-1:806168576068:userpool/us-east-1_h00WorYMT` |
| Stack (do not update) | `checksops-production-api-role` |
| Tenant | `d8267653-4e8d-4635-b42b-fe4968e0e930` / `prodonboard59ff` |

## Required grant only

```
Effect: Allow
Action:
  - cognito-idp:AdminCreateUser
  - cognito-idp:AdminGetUser
  - cognito-idp:AdminSetUserPassword
Resource: arn:aws:cognito-idp:us-east-1:806168576068:userpool/us-east-1_h00WorYMT
```

Do **not** grant `cognito-idp:*`, `AdminDisableUser`, `AdminDeleteUser`,
`AdminUpdateUserAttributes`, or another user pool.

## Commands

From an identity that can `iam:GetRole`, `iam:GetRolePolicy`, and
`iam:PutRolePolicy` on this role:

```bash
export AWS_REGION=us-east-1
export SNAPSHOT_DIR=/tmp/prod-iam-invite-cognito

# Phase 1 — capture live role before mutation
node aws/production/scripts/apply-production-invite-cognito-iam.mjs capture

# Phase 2 — surgical apply onto the existing live policy document
CONFIRM=APPLY_PRODUCTION_INVITE_COGNITO_IAM \
  node aws/production/scripts/apply-production-invite-cognito-iam.mjs apply

# Phase 3 — re-read live role
node aws/production/scripts/apply-production-invite-cognito-iam.mjs verify

# Compare snapshot to the repository template before any future CFN thought
SNAPSHOT_FILE=/tmp/prod-iam-invite-cognito/pre-change.json \
  node aws/production/scripts/apply-production-invite-cognito-iam.mjs diff-template
```

`apply` preserves every current non-Cognito statement exactly. It refuses if
`ProductionApiLeastPrivilege` is missing (it will not invent a replacement
from the repository template). It does not change the trust policy.

## After IAM

Resume production invitation on the existing tenant with a **fresh** mailbox.
Do not reuse `claims+prod-onboard-59ff@freedomadj.com` (Cognito user already
exists and is disabled).
