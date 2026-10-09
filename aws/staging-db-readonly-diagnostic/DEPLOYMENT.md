# Staging DB diagnostic deployment prerequisites

The workflow in `.github/workflows/staging-db-readonly-diagnostic-deploy.yml`
is a create-only path for the standalone `checksops-staging-db-readonly-diagnostic`
stack. It refuses an existing stack, any non-`main` or non-exact SHA run, every
account other than `806168576068`, and any target other than the staging
diagnostic. It never deploys or updates `checksops-staging-api`. Do not use it
for production or as a general SAM deployment role. The deploy job remains
disabled; it is not an updater and must not be dispatched.

No AWS resources or IAM are provisioned by this repository change. Before an
authorized operator can run the workflow, the following separate AWS setup is
required:

1. Create the private artifact bucket
   `checksops-staging-db-readonly-diagnostic-artifacts-806168576068` in
   `us-east-1`, with encryption, public access blocked, and object ownership
   enforced. Retain only objects under the
   `checksops-staging-db-readonly-diagnostic/` prefix for this workflow.
2. Create the CloudFormation execution role
   `arn:aws:iam::806168576068:role/ChecksOpsStagingDbReadonlyDiagnosticCloudFormationExecution`.
   Its trust must allow only `cloudformation.amazonaws.com`. Grant only the
   actions required to create the standalone Lambda, its generated execution
   role and log group, and its VPC attachment. Scope Lambda to
   `checksops-staging-db-readonly-diagnostic`, the generated role to the
   `checksops-staging-db-readonly-diagnostic-StagingDbReadonlyDiagnosticFunctionRole-*`
   name prefix, logs to `/aws/lambda/checksops-staging-db-readonly-diagnostic`,
   and secret reads to the exact staging application secret ARN in the
   deployment script. Permit only read-only EC2 describe operations needed to
   resolve the two fixed staging subnets and the existing API security group.
   No SQL, database write, provider, financial, Cognito, API Gateway, production,
   or other Lambda permissions are needed.
3. Create the GitHub OIDC role
   `arn:aws:iam::806168576068:role/ChecksOpsGitHubStagingDbReadonlyDiagnosticDeploy`.
   Its trust provider is `token.actions.githubusercontent.com`, audience is
   `sts.amazonaws.com`, and its subject is exactly
   `repo:michaelcarletta-cmd/ChecksOps:environment:staging`. Also require
   the GitHub `staging` environment to allow deployments only from `main` and
   require its configured reviewers. GitHub environment branch protection and
   the workflow's `GITHUB_REF` check enforce `main`; AWS OIDC `sub` is scoped
   to the protected environment.

   Trust policy:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Principal": {
         "Federated": "arn:aws:iam::806168576068:oidc-provider/token.actions.githubusercontent.com"
       },
       "Action": "sts:AssumeRoleWithWebIdentity",
       "Condition": {
         "StringEquals": {
           "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
           "token.actions.githubusercontent.com:sub": "repo:michaelcarletta-cmd/ChecksOps:environment:staging"
         }
       }
     }]
   }
   ```

4. Limit the GitHub role policy to this one CloudFormation stack ARN:
   `arn:aws:cloudformation:us-east-1:806168576068:stack/checksops-staging-db-readonly-diagnostic/*`.
   Allow only `cloudformation:CreateStack` and `cloudformation:DescribeStacks`
   there; do not allow update, delete, or change-set operations. Allow
   `iam:PassRole` only for the named CloudFormation
   execution role with `iam:PassedToService =
   cloudformation.amazonaws.com`. Allow bucket location/list on the named
   artifact bucket and `s3:GetObject`/`s3:PutObject` only under its diagnostic prefix. Each workflow
   run uploads under a SHA/run/attempt-specific prefix. Allow
   only `lambda:GetFunctionConfiguration` and `lambda:PublishVersion` on the
   exact diagnostic function ARN. Do not grant direct Lambda create, update,
   delete, invoke, or alias permissions. The workflow also installs this same
   narrow policy as an STS session policy. The attached policy's exact
   statement set is in the workflow's `inline-session-policy`; do not widen it
   or reuse an existing staging role.

   The CloudFormation execution role's trust policy should have only
   `cloudformation.amazonaws.com` as its service principal. Its permissions
   must be limited as follows:

   - `lambda:CreateFunction`, `DeleteFunction`, `GetFunction`,
     `GetFunctionConfiguration`, `TagResource`, `UntagResource` on the exact
     diagnostic function ARN.
   - `iam:CreateRole`, `DeleteRole`, `GetRole`, `TagRole`, `UntagRole`,
     `AttachRolePolicy`, `DetachRolePolicy`, `PutRolePolicy`, `DeleteRolePolicy`
     on
     `arn:aws:iam::806168576068:role/checksops-staging-db-readonly-diagnostic-StagingDbReadonlyDiagnosticFunctionRole-*`.
     `iam:PassRole` is limited to that same role prefix and conditioned on
     `iam:PassedToService=lambda.amazonaws.com`.
   - `ec2:DescribeSubnets` and `ec2:DescribeSecurityGroups` only; AWS requires
     `Resource: "*"` for these describe operations.

   The function role is created by the reviewed template and must retain only
   its declared VPC access policy and `secretsmanager:GetSecretValue` access to
   the exact application secret. Do not attach any other role or widen this
   role to another secret.

The stack and template are registered as a staging-only `cloudformation`
Deployment Guard target. The workflow obtains its short-lived lease and receipt
before assuming the AWS role. The runner accepts only an absent stack, packages
the standalone template, deploys that fixed stack, and publishes the function
using the returned `CodeSha256` as the version precondition. Its only deployment
output is the immutable version ARN and matching code fingerprint; configure
`CHECKSOPS_STAGING_DB_DIAGNOSTIC_VERSION_ARN` from that ARN through the
approved GitHub environment process.

Do not deploy from this pull request. The first live deployment requires a
separate reviewed authorization after the documented AWS prerequisites are
independently verified.

## Existing-function updater draft — source-only and inactive

`scripts/staging-db-readonly-diagnostic-update.mjs` is a pure safety contract,
not a deployment command. Its direct entrypoint always refuses with
`source_only_draft`; it has no AWS client or mutation path. Its offline tests
exercise exact target and role checks, injected independent-approval
verification, stack ownership refusal, CodeSha256/RevisionId/configuration
compare-and-swap, source-composition scope, immutable-version matching, and
diagnostic output redaction. The role ARN in that contract is the existing
create-only role, not evidence that the role is authorized or suitable for an
update. The generic Lambda overlay is not an allowed workaround: this function
is not a registered shared Lambda target.

No AWS configuration was read for this draft. The repository documents an
existing function and published version as reported information, but has no
independently verified live CodeSha256, RevisionId, configuration, published
version inventory, or stack-to-function ownership evidence. Likewise, no
independent approval controller, protected-environment reviewer/bypass
configuration, update-capable OIDC trust, or current IAM policy was verified.
The exact value of `CHECKSOPS_STAGING_DB_DIAGNOSTIC_VERSION_ARN` was not read or
changed. Do not infer these facts from source, a workflow input, or a caller
supplied commit SHA.

### Owner checklist before any updater implementation or activation

- [ ] An independent GitHub/AWS owner supplies evidence for the protected
  staging approval boundary, independent reviewers, no self-approval, no
  administrator bypass, main-only deployment restriction, replay protection,
  and an approval record cryptographically bound to this workstream and commit.
  The approver/verifier must not be changeable by the same source commit.
- [ ] An AWS owner performs fresh read-only checks of the exact function,
  account, region, CodeSha256, RevisionId, complete live configuration,
  published versions, and CloudFormation stack/resource ownership. Record the
  observed values in the separately authorized review; never copy fingerprints
  from old runs or this repository.
- [ ] If CloudFormation owns the function, the resource owner chooses and
  approves a stack-aware change-set/update path. Do not call
  `UpdateFunctionCode` out of band or use the generic overlay. If ownership or
  resource composition is unclear, stop.
- [ ] Independently review the GitHub OIDC trust and exact AWS role policy.
  They must be limited to this staging diagnostic and its owner-approved
  stack-aware operation; deny production, staging API/shared Lambda, SQL,
  SPA, and financial resources. Do not reuse the create-only permissions as
  proof of update authority.
- [ ] Review the full forward-composed diagnostic package against the live
  package/build dependencies. Preserve live configuration, unrelated modules,
  and all unrelated resources; do not restore a prior ZIP or overwrite
  concurrent work.
- [ ] Only after those prerequisites, obtain separate owner authorization for
  an updater implementation and activation. Publish the exact resulting code
  hash, verify the immutable version, and update
  `CHECKSOPS_STAGING_DB_DIAGNOSTIC_VERSION_ARN` only through the independently
  authorized GitHub variable process. Never guess or auto-write that variable.

### Required live staging acceptance tests after independent authorization

1. Verify wrong account, region, role, environment, function, workstream,
   branch/SHA, missing approval, self-approval, approval replay, and changed
   workflow/verifier all refuse before AWS mutation.
2. Verify existing/unexpected stack ownership, stale CodeSha256,
   stale RevisionId, configuration drift, and a concurrent write refuse
   without retrying from or restoring old code. Confirm the AWS write uses the
   freshly observed revision as its compare-and-swap condition.
3. Verify the stack-aware change set changes only the diagnostic code and
   preserves live configuration, unrelated package members/resources, and
   other workstreams. Stop on any same-file source conflict or uncomposed
   package dependency.
4. Verify the resulting CodeSha256, published version ARN, and that version's
   code hash independently. Set the GitHub version variable only to that
   verified immutable ARN through its authorized process.
5. Invoke only that exact version with the existing read-only `inspect`
   allowlist. Confirm unavailable metadata is distinguishable from absent
   database objects, and that SQL bodies, credentials, and secret values never
   appear in logs or summaries.
6. Confirm no SQL migration/write, Lambda configuration change, API route,
   Cognito admin authorization, CORS, IAM scope, or
   `workflow_dispatch` 403 behavior was relaxed. Resolve dispatch access only
   through its GitHub caller/app/environment owner.

Until these checks and independent approvals are evidenced, keep the existing
create-only workflow disabled and the updater draft non-mutating.
