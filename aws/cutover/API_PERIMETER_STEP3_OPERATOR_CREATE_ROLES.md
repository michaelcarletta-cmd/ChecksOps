# Operator: create Step 3 IAM roles (not this agent)

Staging cannot `iam:CreateRole` / `iam:CreatePolicy` / `iam:PassRole`.
`ChecksOpsCursorApiPerimeterStep3Temp` does **not** exist.
Execution role `checksops-production-origin-verify` **may already exist**
(retained after a failed stack). Do not recreate it blindly.

From a privileged IAM principal (not staging, not Steps12Temp):

```
aws cloudformation create-stack \
  --region us-east-1 \
  --stack-name checksops-cursor-api-perimeter-step3-role \
  --template-body file://aws/production/cursor-api-perimeter-step3-role.yaml \
  --parameters ParameterKey=DeployRole,ParameterValue=true \
  --capabilities CAPABILITY_NAMED_IAM
```

Wait `CREATE_COMPLETE`. Do not broaden staging. Do not recreate deleted
hardening roles.

After the stack exists, Cursor OIDC can assume
`ChecksOpsCursorApiPerimeterStep3Temp` and run Gates 3A–3C.
