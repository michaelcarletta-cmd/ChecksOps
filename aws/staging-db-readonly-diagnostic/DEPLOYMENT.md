# Staging DB diagnostic deployment prerequisites

The workflow in `.github/workflows/staging-db-readonly-diagnostic-deploy.yml`
is a one-time, source-only deployment path for the standalone
`checksops-staging-db-readonly-diagnostic` stack. It refuses an existing stack,
any non-`main` or non-exact SHA run, every account other than `806168576068`,
and any target other than the staging diagnostic. It never deploys or updates
`checksops-staging-api`. Do not use it for production or as a general SAM
deployment role.

**Status: NO-GO; design only.** The workflow remains disabled. Do not provision
or enable the direct GitHub OIDC deployment role described in the setup notes
below. A GitHub environment OIDC subject identifies the repository and
environment, not an independent approval; a contributor who can change the
workflow can remove its SHA checks. The `approved_commit` input is caller
supplied and is not an approval record. No AWS resources, IAM, credentials, or
deployments are changed by this proposal.

The remaining setup notes describe the previously considered direct-workflow
baseline. They are not authorization to provision it. The independent
authorization design and its prerequisites below supersede that baseline.

## Independent one-time authorization proposal (not implemented)

### Threat model and trust boundary

Assume a contributor can change workflow code on `main`, choose workflow
inputs, and submit or replace artifacts. A GitHub OIDC token scoped to
`repo:michaelcarletta-cmd/ChecksOps:environment:staging`, a `main` check, an
`approved_commit` input, and a Deployment Guard receipt do not independently
approve a change. The guard remains required for repository deployment
coordination and live-state collision checks; it does not authenticate a human
approval to AWS.

The approval authority, authorization record, and deploy executor must be
administered outside this repository and outside the deployer's control. The
approver must be a named, MFA-authenticated human using an AWS identity
independent of the deployer. The approver must review and authorize the exact
40-character commit SHA and SHA-256 digest of the final template and deployment
artifact set. A trusted AWS-side verifier must independently bind the artifact
bytes to that tuple; a digest string supplied by the workflow alone is not
proof of artifact identity.

### Proposed gate and policy/trust delta

Use a small AWS-side authorization broker with an approval record in a
security-administered store. The broker must be immutable to GitHub contributors
and deployers. It accepts a request but does not grant GitHub a deployment
session. Only the independent approver identity may approve a request; the
approver identity and deployer identity must differ. The approval record binds:

- one opaque authorization ID, exact repository and full commit SHA;
- exact digest(s) of the final packaged CloudFormation template and Lambda
  artifact(s), verified against the bytes the broker will deploy;
- account `806168576068`, region `us-east-1`, stack
  `checksops-staging-db-readonly-diagnostic`, and create-only action;
- named approver identity, distinct deployer identity, approval time, and an
  expiry no more than 15 minutes after approval.

Authenticate the approver through a dedicated AWS IAM Identity Center
`ChecksOpsStagingDbReadonlyDiagnosticApprover` assignment with MFA, not through
a GitHub input, commit message, or shared role. The broker accepts approval
only on an IAM-authenticated approval route, validates the caller's stable
Identity Center principal against a separately administered named-approver
allowlist, and records that principal and the API Gateway-authenticated caller
identity in the approval record and CloudTrail. Reject shared identities,
unknown principals, and an approver matching the deployment requester. The
request route and approval route must have separate authorization; workflow
code cannot call the latter.

The broker atomically changes the authorization from `approved` to `consumed`
with a conditional write that checks the full tuple and expiry before making
any AWS mutation. The authorization is consumed before the first side effect;
timeouts or partial failures require a new human approval, never a replay.
The broker verifies the source SHA against the repository's `main` ref and
verifies all artifact digests itself. It creates the stack only if absent and
publishes the Lambda version only after checking the deployed code fingerprint.
It returns only the immutable version ARN and matching code fingerprint.

The GitHub workflow may request an authorization but must have no AWS
deployment permissions. If it uses OIDC for that request, that identity may
invoke only the broker's exact request interface, a dedicated AWS
control-plane endpoint and not the ChecksOps application API. The broker—not
workflow code—must validate approval, source, digests, and target before
deploying. The Deployment Guard lease/receipt and live-state check remain an
additional required collision control. A future broker must independently
validate an authentic guard receipt bound to this target and commit without
trusting a workflow-supplied success flag or exposing the local issuer key.
The current repository does not provide that cross-boundary verifier; this is
an implementation prerequisite, not a reason to bypass the guard.

The required IAM delta is:

1. **Remove the direct workflow trust.** The role
   `ChecksOpsGitHubStagingDbReadonlyDiagnosticDeploy` must have no
   `sts:AssumeRoleWithWebIdentity` trust for GitHub and no deployment
   permissions. If a request-only OIDC role is retained, its only permission is
   `execute-api:Invoke` on the broker's exact request route; it cannot approve
   or execute. The proposed trust principal for a separate executor role is
   only `arn:aws:iam::806168576068:role/ChecksOpsStagingDbReadonlyDiagnosticAuthorizationBroker`
   for `sts:AssumeRole`; no GitHub principal, shared staging role, or human
   approver is trusted by that role. The broker service role itself is trusted
   only by its AWS service runtime.

   Executor-role trust statement (the broker role name is proposed, not
   provisioned):

   ```json
   {
     "Effect": "Allow",
     "Principal": {
       "AWS": "arn:aws:iam::806168576068:role/ChecksOpsStagingDbReadonlyDiagnosticAuthorizationBroker"
     },
     "Action": "sts:AssumeRole"
   }
   ```

2. **Give deploy permissions only to the broker.** Its executor policy may
   allow only `cloudformation:CreateStack` and
   `cloudformation:DescribeStacks` needed to verify the exact stack on
   `arn:aws:cloudformation:us-east-1:806168576068:stack/checksops-staging-db-readonly-diagnostic/*`;
   `iam:PassRole` for
   `arn:aws:iam::806168576068:role/ChecksOpsStagingDbReadonlyDiagnosticCloudFormationExecution`
   with `iam:PassedToService=cloudformation.amazonaws.com`;
   `s3:GetBucketLocation` and `s3:ListBucket` on the exact artifact bucket
   (with `s3:prefix` restricted to its diagnostic `sha256/` prefix), and
   `s3:GetObject`/`s3:PutObject` only in
   `arn:aws:s3:::checksops-staging-db-readonly-diagnostic-artifacts-806168576068/checksops-staging-db-readonly-diagnostic/sha256/*`;
   and `lambda:GetFunctionConfiguration` plus
   `lambda:PublishVersion` on
   `arn:aws:lambda:us-east-1:806168576068:function:checksops-staging-db-readonly-diagnostic`.
   Keep the CloudFormation execution role limited to the standalone diagnostic
   resources and exact staging secret as already documented.
3. **Keep destructive and adjacent actions unavailable.** Do not grant
   `cloudformation:UpdateStack`, `DeleteStack`, change-set execution, direct
   Lambda create/update/delete/invoke, stack deletion, SQL, API, production,
   financial, or unrelated S3 access. Where the account is governed by AWS
   Organizations, add a separately administered SCP (or an equivalent
   organization-controlled boundary) that denies direct creation of this stack
   except through the broker. Confirm no alternate role, user, or account
   administrator path can bypass the broker. An IAM allowlist alone is not a
   boundary against principals able to change those IAM policies.

IAM cannot inspect a CloudFormation request's template body and prove its
digest, nor can a short-lived STS session be made single-use by shortening its
duration. The broker's digest verification and atomic authorization consume
are therefore required; policy scope alone is insufficient. Likewise, an SCP
does not make the approver independent if the same administrators can change
the SCP, broker, approval store, or approver assignments.

### Alternatives and residual risks

- **Temporary human-approved IAM role/session grant:** useful as an
  independently administered approval step, but not sufficient by itself.
  STS credentials can be reused until expiry, and IAM does not bind
  `CreateStack` to an artifact digest or atomically consume approval. It is
  acceptable only as the broker's internal, non-exported execution mechanism
  with the atomic gate above—not as credentials handed to the workflow or
  deployer.
- **AWS-native approval (for example, a separately administered CodePipeline
  manual approval):** potentially viable only if the pipeline, approval
  configuration, source/artifact verification, and execution role are outside
  repository contributor control; the named approver is distinct from the
  deployer; the approval is bound to the exact SHA/digests and target; and
  replay/concurrent execution is rejected. A native approval action alone
  does not establish these conditions. No such separately controlled pipeline
  is evidenced here.

Residual risks remain for AWS Organizations management administrators,
compromise of the independent approver or broker, inaccurate human review,
upstream identity-provider compromise, and AWS service/control-plane defects.
CloudTrail and alerting can make these actions auditable but do not prevent
them. Do not describe repository tests, GitHub environment checks, or the
Deployment Guard as eliminating these risks.

### Revocation, rollback, and acceptance tests

Before deployment, revoke by keeping the workflow disabled, removing any
GitHub trust and deploy permissions, disabling the broker request path, and
revoking the pending authorization. Once consumed, never reset or reuse its
record; require a new authorization. Revoke broker/executor trust and
permissions if the independent boundary is suspected compromised. If stack
creation partially succeeds or completes, stop and inspect read-only. Do not
update or delete the stack as rollback; any later disposition needs its own
reviewed authorization and must preserve unrelated live state.

Before considering a future enablement, add offline tests and an AWS-side
non-production verification plan proving rejection of: wrong or non-main SHA;
wrong template or artifact digest or modified artifact bytes; wrong account,
region, stack, or action; missing, expired, consumed, or concurrently consumed
approval; approver/deployer identity collision; unavailable identity or
approval service; existing stack; replay after partial failure; direct GitHub
assumption; and attempts to update/delete the stack or touch production, API,
SQL, financial, or unrelated resources. Positive tests must prove exactly one
create, digest-matched immutable Lambda version publication, audit identity,
and that Deployment Guard lease/receipt and live-state checks remain required.
No live AWS write is part of these tests or this design.

### Go/no-go decision

**NO-GO until prerequisites are independently demonstrated.** This repository
does not establish that account `806168576068` has a separately governed
named-human approver identity, an AWS-owned atomic one-time authorization
broker (or an equivalently constrained AWS-native pipeline), immutable
approval/deployment configuration, and an organization-controlled boundary
against direct deployment bypass. An authorized AWS/security administrator
must confirm those capabilities, their independent owners, audit trail, and
rejection-test results before a separate review can authorize implementation.
If those identity and account controls cannot be provided, stop; do not
re-enable the workflow, issue credentials, or deploy.

No AWS resources or IAM are provisioned by this repository change. Before an
authorized operator can run the workflow, the following historical AWS setup
notes would need review and replacement. In particular, do not apply steps 3–4
as written; the direct GitHub OIDC deployment role and its policy are rejected
by the design above.

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
