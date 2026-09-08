# Operator: create Step 3 IAM roles (not this agent)

**Use the Step3Temp-only handoff.** Do not deploy the combined
template. Do not deploy Gate 3A–3C from this file.

Canonical package: `aws/cutover/API_PERIMETER_STEP3_OPERATOR_HANDOFF.md`

Template: `aws/production/cursor-api-perimeter-step3-temp-role-only.yaml`

```
aws cloudformation create-stack \
  --region us-east-1 \
  --stack-name checksops-cursor-api-perimeter-step3-temp-role \
  --template-body file://aws/production/cursor-api-perimeter-step3-temp-role-only.yaml \
  --parameters ParameterKey=DeployRole,ParameterValue=true \
  --capabilities CAPABILITY_NAMED_IAM
```

Do **not** use stack `checksops-cursor-api-perimeter-step3-role` or
`aws/production/cursor-api-perimeter-step3-role.yaml` (that template
also creates `checksops-production-origin-verify` and can collide
with the leftover probe role). Inspect that leftover role read-only.
Do not change or delete it this turn.

Wait `CREATE_COMPLETE`. Then STOP. Do not begin Gate 3A.
