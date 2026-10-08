# Staging DB diagnostic deployment prerequisites

The workflow in `.github/workflows/staging-db-readonly-diagnostic-deploy.yml`
is a one-time, source-only deployment path for the standalone
`checksops-staging-db-readonly-diagnostic` stack. It refuses an existing stack,
any non-`main` or non-exact SHA run, every account other than `806168576068`,
and any target other than the staging diagnostic. It never deploys or updates
`checksops-staging-api`. Do not use it for production or as a general SAM
deployment role.

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
