# Gate 0 — temporary role CREATE BLOCKED

**2026-09-08T14:46Z–14:49Z.** Identity:
`arn:aws:sts::806168576068:assumed-role/ChecksOpsCursorCloudStaging/checksops-t0-run`

`ChecksOpsCursorCloudStaging` **cannot** create the reviewed role. Direct
`iam:CreateRole` / `iam:CreatePolicy` are AccessDenied. CloudFormation
`CreateStack` was accepted, then **CREATE_FAILED**:

```
iam:CreatePolicy on resource: policy ChecksOpsCursorApiPerimeterSteps12Allow
iam:CreatePolicy on resource: policy ChecksOpsCursorApiPerimeterSteps12Deny
```

Stack `checksops-cursor-api-perimeter-steps12-role` rolled back to
**ROLLBACK_COMPLETE** and was **deleted** so the name is free. No IAM role
or managed policy remains from this attempt.

Did **not**:

- broaden `ChecksOpsCursorCloudStaging`
- recreate `ChecksOpsCursorSecurityHardeningTemp`
- recreate `ChecksOpsCursorCloudTrailCwLogsTemp`
- assume `TEMP_ROLE` (still named the deleted hardening role in this environment)
- touch CloudFront, API Gateway, SPA, WAF, DNS, Lambda, RDS, Cognito

OIDC `AssumeRoleWithWebIdentity` on
`arn:aws:iam::806168576068:role/ChecksOpsCursorApiPerimeterSteps12Temp`
returns AccessDenied (role does not exist).

## Privileged-operator create (one command)

From a human IAM principal that **already** may `iam:CreateRole` /
`iam:CreatePolicy` / `cloudformation:CreateStack` (same class of principal
that created the now-deleted hardening stack). Use the reviewed template
unchanged:

```bash
aws cloudformation deploy \
  --region us-east-1 \
  --stack-name checksops-cursor-api-perimeter-steps12-role \
  --template-file aws/production/cursor-api-perimeter-steps12-role.yaml \
  --parameter-overrides DeployRole=true \
  --capabilities CAPABILITY_NAMED_IAM \
  --tags Temporary=true Purpose=api-perimeter-steps-1-2
```

Then verify:

```bash
aws iam get-role --role-name ChecksOpsCursorApiPerimeterSteps12Temp \
  --query 'Role.{Name:RoleName,Arn:Arn,MaxSessionDuration:MaxSessionDuration}'
aws iam list-attached-role-policies --role-name ChecksOpsCursorApiPerimeterSteps12Temp
```

Expected:

- Role `ChecksOpsCursorApiPerimeterSteps12Temp`
- Attached: `ChecksOpsCursorApiPerimeterSteps12Allow`, `ChecksOpsCursorApiPerimeterSteps12Deny`
- Trust: `api.cursor.com` / aud `sts.amazonaws.com` / sub `user:325724407`
- **No** extra managed policies

Reply to this agent after the stack is **CREATE_COMPLETE**. Gate 1 (CloudFront)
and Gate 2 (SPA) will run as that OIDC role only.

## Holds still in force

No origin-verify secret. No API Gateway authorizer.
`DisableExecuteApiEndpoint` stays false. No Lambda/RDS/Cognito/WAF/DNS
changes. `productionExecution=false`. `64_` NOT_APPLIED.
