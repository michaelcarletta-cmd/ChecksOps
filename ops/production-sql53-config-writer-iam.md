# SQL53 production config-writer IAM (prepare only)

Do not create or modify IAM from this document until the owner names a
trust principal and separately authorizes the create. This is not an
apply, overlay, invoke, or SQL authorization.

## Verified identities

| Identity | Verified? | Use |
|---|---|---|
| AWS IAM administrator ARN that can `iam:CreateRole` | **No.** Live IAM reads from `ChecksOpsCursorCloudStaging` are `AccessDenied`. No admin user/role ARN is recorded in the repository. | Owner must create the role from an existing production administrator (console or CloudShell). |
| Owner IAM user that should assume the writer | **No.** Repository fail-closed input `CHECKSOPS_STAGING_DB_DIAGNOSTIC_OWNER_IAM_USER_ARN` is still `null`. | Preferred assume principal once the owner names `arn:aws:iam::806168576068:user/<owner>` and that user uses MFA. |
| Cursor Cloud owner subject `user:325724407` | **Yes as Cursor owner subject only.** Matches this run’s owning user and the live trust used by previous owner-created temp roles. | Optional assume principal only if the owner explicitly chooses Cursor OIDC. Not an AWS IAM administrator. |

`ChecksOpsProductionSql53ConfigWriter` existence remains **unverified**.

## Proposed permission policy (final)

File: `aws/production/sql53-config-writer-permissions.json`

```json
{
  "Version": "2012-10-17",
  "Id": "checksops-production-sql53-config-writer-permissions",
  "Statement": [
    {
      "Sid": "Sql53TemporaryLambdaConfigurationOnly",
      "Effect": "Allow",
      "Action": [
        "lambda:GetFunctionConfiguration",
        "lambda:UpdateFunctionConfiguration",
        "lambda:InvokeFunction"
      ],
      "Resource": "arn:aws:lambda:us-east-1:806168576068:function:checksops-production-prep-api"
    }
  ]
}
```

`sts:GetCallerIdentity` needs no Allow. Do not add code/version/policy
updates, aliases, other functions, API Gateway, IAM, PassRole,
CloudFormation, S3, Secrets Manager, RDS, or SQL.

## Proposed trust (choose one; default is fail-closed)

Committed default: `aws/production/sql53-config-writer-trust-fail-closed.json`.
It denies every assume. Do not create a usable role from it.

### Option A — preferred, unverified until named

Replace `OWNER_IAM_USER_ARN_REQUIRED` in
`aws/production/sql53-config-writer-trust-owner-iam-user.template.json`
with one existing IAM user ARN in account `806168576068`. Keep MFA.
Do not apply the placeholder.

### Option B — complete, requires explicit owner approval

`aws/production/sql53-config-writer-trust-cursor-oidc-owner.json` trusts
only `api.cursor.com` audience `sts.amazonaws.com` subject
`user:325724407`. It does not trust `ChecksOpsCursorCloudStaging`,
GitHub OIDC, or account root. Choosing this lets later Cloud Agent runs
owned by that user assume the writer without broadening staging.

## Rejected principals

- Account root
- `ChecksOpsCursorCloudStaging`
- `ChecksOpsGitHubProductionReadOnlyInspect`
- Any `ChecksOpsGitHubStaging*` role
- Production Lambda execution roles
- `token.actions.githubusercontent.com`
- Wildcard principals or wildcard OIDC subjects

## Exact create procedure (stop until authorized)

Run only from an owner-controlled production administrator after the
owner names Option A or approves Option B. Do not run from
`ChecksOpsCursorCloudStaging`.

```bash
aws sts get-caller-identity --output json
# Record Account=806168576068 and the admin ARN. If this identity cannot
# iam:GetRole / iam:CreateRole, stop and use a true administrator.

aws iam get-role --role-name ChecksOpsProductionSql53ConfigWriter
# Expected: NoSuchEntity. If the role exists, stop and reconcile.
# If AccessDenied, this identity is not the administrator.

# After the owner selects a trust file (never the fail-closed file,
# never the unreplaced IAM-user template):
TRUST=aws/production/sql53-config-writer-trust-<chosen>.json
PERMS=aws/production/sql53-config-writer-permissions.json

aws iam create-role \
  --role-name ChecksOpsProductionSql53ConfigWriter \
  --assume-role-policy-document "file://${TRUST}" \
  --description 'Dedicated SQL53 temporary Lambda configuration writer' \
  --max-session-duration 3600 \
  --tags Key=checksops:purpose,Value=sql53-temporary-lambda-config \
         Key=checksops:environment,Value=production \
         Key=checksops:workstream,Value=prod-sql53-iam-prep-3bc9

aws iam put-role-policy \
  --role-name ChecksOpsProductionSql53ConfigWriter \
  --policy-name ChecksOpsProductionSql53ConfigWriterInline \
  --policy-document "file://${PERMS}"

aws iam get-role --role-name ChecksOpsProductionSql53ConfigWriter \
  --query 'Role.{Arn:Arn,CreateDate:CreateDate}' --output json
aws iam get-role-policy \
  --role-name ChecksOpsProductionSql53ConfigWriter \
  --policy-name ChecksOpsProductionSql53ConfigWriterInline \
  --query 'PolicyDocument' --output json
```

Do not attach managed policies. Do not add a Lambda resource-based
invoke statement. Do not grant `ChecksOpsCursorCloudStaging`
`sts:AssumeRole`. Do not invoke the diagnostic or set SQL53 environment
variables.

## After a successful create

1. Independently `GetRole` / `GetRolePolicy` from the same administrator.
2. Assume `ChecksOpsProductionSql53ConfigWriter` as the approved
   principal (not Cursor staging).
3. Run official
   `node scripts/deployment-guard/sql53-temporary-lambda-config.mjs --fingerprint-only`.
4. Stop again before receipt, apply, or invoke.
