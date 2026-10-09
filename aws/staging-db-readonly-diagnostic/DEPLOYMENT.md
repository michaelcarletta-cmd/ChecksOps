# Staging DB diagnostic deployment prerequisites

The workflow in `.github/workflows/staging-db-readonly-diagnostic-deploy.yml`
is a create-only path for the standalone `checksops-staging-db-readonly-diagnostic`
stack. It refuses an existing stack, any non-`main` or non-exact SHA run, every
account other than `806168576068`, and any target other than the staging
diagnostic. It never deploys or updates `checksops-staging-api`. Do not use it
for production or as a general SAM deployment role. The deploy job remains
disabled; it is not an updater and must not be dispatched.

## Independent approval design (source-only; not live)

GitHub `staging` environment screenshots do not show Required reviewers or
Prevent self-review. This repository is private; do not assume GitHub review
gates. `inputs.approved_commit` is a same-run SHA pin and is **not**
independent approval. A Deployment Guard HMAC receipt issued by the same
workflow is also not independent: that issuer is created on the runner and is
modifiable by the same source commit.

Minimum viable independent boundary, without a new external service:

- A separately administered AWS KMS key in account `806168576068` / `us-east-1`.
- Only an owner-controlled IAM principal may `kms:Sign`. The GitHub OIDC
  deploy role and CloudFormation execution role must not sign or administer
  the key.
- The approval payload is ECDSA_SHA_256 over canonical JSON bound to the
  exact main SHA, workstream `staging-db-readonly-diagnostic`, staging
  diagnostic stack/function, account, region, create-only deployment type,
  one-time 32-hex nonce, issued-at, and expiry (max 60 minutes).
- Create-only deploy verifies the signature with an owner-supplied SPKI
  public key and consumes the nonce once through an independently controlled
  persistent ledger. Verification cannot be replaced by `approved_commit`,
  GitHub environment reviewers, a local HMAC, or a runner-local file.

Do not claim an independent approval exists. The create-only job stays
`if: ${{ false }}` with `permissions: contents: read` and no `id-token: write`.

### INDEPENDENT APPROVAL BLOCKER

Activation is blocked until an owner-controlled AWS KMS approval authority is
evidenced. Source cannot create that key, IAM policy, or signer. Do not bypass
this with workflow enablement, a caller-supplied SHA, or a repo-generated HMAC.

Owner-controlled setup (outside this PR; do not apply from source):

1. Create a KMS key used only for this create-approval kind.
2. Key policy: owner principal `kms:Sign` / `kms:GetPublicKey`; deny
   `kms:Sign` to `ChecksOpsGitHubStagingDbReadonlyDiagnosticDeploy` and the
   CloudFormation execution role. Do not grant the deploy role key admin.
3. Publish the public key as a staging-environment secret
   `CHECKSOPS_STAGING_DB_DIAGNOSTIC_APPROVAL_PUBLIC_KEY_DER_B64` and the key
   ARN as `CHECKSOPS_STAGING_DB_DIAGNOSTIC_APPROVAL_KMS_KEY_ARN`. Workflow
   jobs must not be able to change those values.
4. Owner signs one approval for one reviewed main SHA, then discards it.
   Replay of the nonce must fail.
5. Provide an independently controlled **persistent** one-time consume
   ledger. Runner-local files, GitHub caches, and workflow concurrency are
   not replay protection: a fresh runner has an empty disk.
   Use atomic S3 `PutObject` `If-None-Match: *` on
   `s3://checksops-staging-db-readonly-diagnostic-artifacts-806168576068/checksops-staging-db-readonly-diagnostic/create-approvals/consumed/<nonce>.json`.
   AWS CLI `--body` must be a real temp file path, not inline JSON.
   Deny `s3:DeleteObject` / overwrite for the deploy role on that prefix.
   Source never issues `delete-object` or `put-object` without `If-None-Match: *`.
   A 412 PreconditionFailed is reuse. A failed create-stack cannot retry the
   same nonce; the owner must sign a new approval.

Until that evidence exists, keep the workflow disabled.

### Pending read-only owner evidence (do not retry forbidden AWS reads)

Recorded 2026-10-09, account `806168576068`, `us-east-1`:

| Prerequisite | Status |
| --- | --- |
| Lambda `checksops-staging-db-readonly-diagnostic` | absent |
| CloudFormation stack `checksops-staging-db-readonly-diagnostic` | absent |
| GitHub OIDC role `ChecksOpsGitHubStagingDbReadonlyDiagnosticDeploy` | exists; CreateStack + S3 GetObject/PutObject on diagnostic prefix; **no DeleteObject** |
| Inline policy `DiagnosticOnly` | reported CreateStack/DescribeStacks, PassRole, artifact prefix, GetFunctionConfiguration/PublishVersion |
| CloudFormation execution-role trust/policy | reported exists; CFN service trust; diagnostic-only policy |
| Artifact bucket encryption | AES256 |
| Artifact bucket public-access block | full block |
| Artifact bucket ownership | BucketOwnerEnforced |
| Artifact bucket policy | **none** |
| Artifact bucket versioning | **unset** |
| Staging environment required reviewers / prevent self-review | **unverified** |
| Exact live AWS role permission set | **pending owner evidence** |
| Diagnostic package/lockfile vs live dependencies | **pending owner evidence** |
| Independent approval KMS key / signer / public key | **unknown** (alias search found none; does not prove key absence) |
| Persistent create-approval consume ledger (S3 If-None-Match) | **unknown** (no bucket policy) |
| Deploy-role DeleteObject denied on consume prefix | IAM omits DeleteObject; **no bucket Deny** so an alternate path can still delete |

### Source-only KMS signer and write-once S3 ledger (do not apply)

Exact proposed JSON lives in `aws/staging-db-readonly-diagnostic/policies/`. Evaluate with:

```bash
node scripts/staging-db-readonly-diagnostic-kms-s3-ledger.mjs
```

`--apply` always exits `source_only_kms_s3_ledger_apply_refused`. It never calls `aws kms create-key`, `put-key-policy`, `put-bucket-policy`, `put-role-policy`, or workflow enablement. `CHECKSOPS_DEPLOYMENT_GUARD_APPLY=1` is not a bypass.

KMS (asymmetric ECDSA, independently administered):

- `KeySpec=ECC_NIST_P256`, `KeyUsage=SIGN_VERIFY`, `ECDSA_SHA_256` only.
- Proposed alias `alias/checksops-staging-db-readonly-diagnostic-create-approval`.
- Owner role `ChecksOpsOwnerDiagnosticCreateApprover` is the only `kms:Sign` principal, conditioned on `kms:SigningAlgorithm=ECDSA_SHA_256`.
- Deploy and CloudFormation execution roles are denied `kms:Sign` and key admin. Do not grant those roles `kms:GetPublicKey`; the SPKI public key is a separately controlled staging-environment secret.
- Account root may manage (not sign) for break-glass. No `kms:*`. This is not the deployment-guard receipt key.

S3 write-once consumed ledger (minimum scoped):

- Resource is only
  `arn:aws:s3:::checksops-staging-db-readonly-diagnostic-artifacts-806168576068/checksops-staging-db-readonly-diagnostic/create-approvals/consumed/*`.
- Real AWS keys: `s3:if-none-match` and `s3:x-amz-copy-source` (S3 conditional writes). `StringNotEquals` alone does not deny a missing header, so a `Null=true` Deny is required as well.
- Principal `*` Deny delete (`s3:DeleteObject`, `s3:DeleteObjectVersion`) and overwrite (PutObject unless `If-None-Match: *`; PutObject when copy-source is present).
- CloudFormation `package` PutObject stays under
  `checksops-staging-db-readonly-diagnostic/<40-hex-sha>/<run>-<attempt>/`, which cannot collide with `create-approvals/consumed/`.
- Consume command remains `aws s3api put-object --body <temp file> --if-none-match '*'`. Inline JSON `--body` is refused. Replay is HTTP 412.

IAM: additive Deny statements only. Do not replace live DiagnosticOnly. Live GetObject/PutObject on the diagnostic prefix is required for packaging and must not gain an If-None-Match requirement.

GitHub OIDC: the disabled job still has `permissions: contents: read` and **no** `id-token: write`. That absence is intentional. Do not add `id-token: write` or enable `jobs.deploy.if` from this PR. Session policy Deny on the consumed prefix is source-only and inactive while the job is disabled.

#### Blast radius

- New KMS key is unused until the owner signs one approval. No existing Lambda, API, or guard receipt verifies with it.
- Bucket policy Deny is prefix-limited. Artifact uploads, other buckets, staging API, production, SQL, Cognito, and CORS are out of scope.
- Additive IAM Deny cannot grant new access. Versioning stays unset.

#### Rollback (owner only; not this PR)

1. Delete the new bucket policy (Oct 9 live state had none).
2. Remove only the additive consumed-prefix IAM Deny statements.
3. Cancel the proposed alias and schedule-delete the unused signing key if created.
4. Leave the workflow disabled. Do not add `id-token: write` as rollback.

#### Phone-friendly owner checklist

1. Do not merge, deploy, or enable the diagnostic workflow.
2. Confirm `if: false` and `contents: read` only (no `id-token: write`).
3. Confirm package prefix is SHA/run, not `create-approvals/consumed/`.
4. Create the P-256 SIGN_VERIFY key with the source key policy; only the owner role may `kms:Sign`.
5. Publish the SPKI public key and key ARN as staging secrets jobs cannot change.
6. Put the consumed-prefix bucket policy. Do not enable versioning here.
7. Add the additive deploy-role Deny for delete/overwrite of consumed objects.
8. Prove `put-object --body FILE --if-none-match '*'`, then replay 412. Never `delete-object`.
9. Do not touch staging API, production, SQL, Cognito, CORS, or other workstreams.

### Separate non-blocking issues (do not weaken security to "fix")

- `workflow_dispatch` 403 `Resource not accessible by integration` is a GitHub
  caller/app/environment permission. Do not add `actions: write`, broaden
  `GITHUB_TOKEN`, or change OIDC to work around it.
- Missing Cognito admin ID token for HTTP `GET /db-readonly-validate` is a
  separate operator-secret issue. Do not weaken Cognito, CORS, SQL, or
  production auth.

### Operator checklist before any future enablement

- [ ] Owner evidences the KMS approval key, signer, public key, and deny-sign
      for the deploy/execution roles. Do not claim an independent approval exists
      until that evidence is recorded outside this PR.
- [ ] Owner evidences the persistent consume ledger: bucket encryption,
      public-access block, ownership, `If-None-Match: *` create-only, and no
      deploy-role delete/overwrite on the consume prefix. Fresh-runner replay
      and failed-deploy retries must refuse without a new owner signature.
- [ ] Owner read-only verifies execution-role trust/policy and artifact-bucket
      encryption / public-access block / ownership.
- [ ] Owner confirms staging environment settings without changing visibility
      or plan. GitHub reviewers are extra, not a substitute for KMS approval.
- [ ] Owner reviews exact IAM statements and the diagnostic package/lockfile.
- [ ] First create remains staging-only, main SHA pinned, single-use
      lease/receipt plus independent approval, absent-stack check, CreateStack
      only, publish immutable version, fingerprint verify, read-only invoke
      with allowlisted `inspect`.
- [ ] No staging API, production, SQL apply, IAM, or other-workstream writes.
- [ ] Keep the create-only workflow disabled until a later reviewed
      authorization explicitly enables it. This PR must not enable or dispatch.

## AWS create-only prerequisites (still required; several remain unknown)

No AWS resources or IAM are provisioned by this repository change. Before an
authorized operator can run the workflow, the following separate AWS setup is
required. Treat execution-role and artifact-bucket details as unknown until
owner read-only evidence exists:

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
   `repo:michaelcarletta-cmd/ChecksOps:environment:staging`. Keep the GitHub
   `staging` environment restricted to `main`. Do not treat environment
   reviewers as the independent approval boundary; they are unverified here
   and are not cryptographically bound to SHA, workstream, or nonce. GitHub
   environment branch protection and the workflow's `GITHUB_REF` check
   enforce `main`; AWS OIDC `sub` is scoped to the protected environment.

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
