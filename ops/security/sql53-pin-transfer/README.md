# SQL53 authorization-pin transfer prerequisites

This is a source-only draft. Nothing in this directory creates IAM resources,
configures GitHub, invokes the workflow, or executes SQL. The production SQL53
function must remain untouched until its separate guarded apply is approved.

## Security review findings

- The workflow checks out only `main`, checks the checkout SHA against the
  dispatch SHA, and hashes the exact SQL source and authorization-pin bytes.
  The JSON pin's target, execute-authorization fields, SQL hash, and exact
  function identity are checked both on GitHub and by the fixed SSM document.
- `AWS-RunShellScript` is still the SSM document plugin, but the GitHub role is
  authorized only for `ChecksOpsSql53PinTransfer` document version `1`. The
  document contains a fixed Python transfer script; the only caller inputs are
  two Base64 chunks passed using `ENV_VAR` interpolation. They are decoded,
  hashed against the immutable expected pin digest, and never evaluated as
  shell text. The script checks the runner's SQL file and function identity,
  backs up the previous file, and atomically replaces only the pin file.
- `ssm:SendCommand` must be restricted to the custom document ARN and the one
  EC2 instance ARN, with `ssm:DocumentVersion` equal to `1`. The role must not
  be allowed to update the document or use any other document. Any later
  document change requires independent review and a separately authorized
  version/role-policy update; do not move the role to `$LATEST` or `default`.
- AWS does not provide resource-level authorization for
  `ssm:GetCommandInvocation`; its `Resource: "*"` grant is unavoidable. Keep
  that as the only other SSM action and do not add `GetCommand`, `List*`,
  `CancelCommand`, or instance-management permissions. The inline session
  policy is an additional restriction, not a substitute for the role's
  permission policy or its trust policy.
- Trust must use the account's GitHub OIDC provider, audience
  `sts.amazonaws.com`, and exact subject
  `repo:michaelcarletta-cmd/ChecksOps:environment:production`. The workflow's
  `production` environment must require an independent reviewer, restrict
  deployments to `main`, and prevent self-approval where the GitHub plan
  supports that control. The workflow also refuses any ref other than
  `refs/heads/main`.
- This environment-scoped OIDC subject does not identify a specific workflow
  file. Treat every workflow on `main` that can target `production` and request
  an OIDC token as inside the trust boundary; protect workflow changes with
  required review and keep the production environment approval gate enabled.

The following are policy review criteria, not instructions to apply them
directly. The exact account OIDC provider ARN must be confirmed before use:

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
        "token.actions.githubusercontent.com:sub": "repo:michaelcarletta-cmd/ChecksOps:environment:production"
      }
    }
  }]
}
```

Attach only the following actions to the new role. Split document and instance
resources so the version condition is evaluated on the custom document
resource. `GetCommandInvocation` has no resource-level ARN scope:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "ssm:SendCommand",
      "Resource": "arn:aws:ssm:us-east-1:806168576068:document/ChecksOpsSql53PinTransfer",
      "Condition": { "StringEquals": { "ssm:DocumentVersion": "1" } }
    },
    {
      "Effect": "Allow",
      "Action": "ssm:SendCommand",
      "Resource": "arn:aws:ec2:us-east-1:806168576068:instance/i-0c35557c4e5385406"
    },
    {
      "Effect": "Allow",
      "Action": "ssm:GetCommandInvocation",
      "Resource": "*"
    }
  ]
}
```

The workflow's inline session policy must be kept at least as restrictive as
this role policy. Neither policy permits editing the SSM document, launching
other documents, or invoking the SQL apply CLI.

## Provisioning sequence (not performed)

1. Obtain independent security approval for this document content, the
   dedicated trust and permission policies, the runner target/path, and the
   release-lock coordination. Confirm the production environment protection
   rules are active before enabling OIDC.
2. Use only the organization's reviewed, guarded IAM-as-code process to
   create the custom SSM document as version `1` and a new dedicated role
   named `ChecksOpsGitHubSql53PinTransfer`. Attach only the trust and SSM
   permissions described above. Do not edit, broaden, or reuse any existing
   staging/production role. If the approved guard has no writer for these
   resources, stop and obtain one; do not use direct AWS console/CLI writes.
3. Separately, an authorized GitHub environment administrator configures the
   `production` environment's required reviewers and `main` deployment-branch
   restriction through the approved repository administration process. Add
   `CHECKSOPS_SQL53_PIN_TRANSFER_ROLE_ARN` as an environment variable with the
   exact dedicated role ARN. Do not configure static AWS credentials.
4. Review the resulting trust, permission policy, SSM document version/content
   hash, and environment settings independently. Run the offline tests and
   review the workflow diff. Until those prerequisites are approved and
   evidenced, the role variable should remain absent and the workflow must
   remain unable to assume the dedicated role.
5. A later, separately approved manual transfer writes only
   `ops/deployment-guard/sql53-production-apply.json` on the existing runner
   and preserves the previous bytes in a unique `/tmp` backup. Verify the SSM
   status, success marker, target file hash, and backup. This action issues no
   receipt, acquires no lease, edits no release lock, and does not invoke the
   SQL53 apply CLI. SQL execution remains blocked on its separate guarded
   apply process.
