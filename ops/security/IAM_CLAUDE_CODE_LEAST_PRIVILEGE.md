# Least privilege for the `claude-code` IAM user

Owner, 2026-11-03: the `claude-code` IAM user "still has admin-level access ... worth revisiting".

This change is for the owner to apply. Claude does not change its own permissions.

## Today (read-only, 2026-11-03)

- **User:** `arn:aws:iam::806168576068:user/claude-code`. One active access key (`…O4HG`), created
  2026-10-27, last used 2026-11-03. No MFA, since the key is used programmatically.
- **Policies:** `PowerUserAccess` and `IAMFullAccess`.
  - `IAMFullAccess` lets the holder grant itself anything, so in effect this is an administrator.
  - Anyone holding this key controls the account.
- **The key's path:** cloud Claude Code sessions reach AWS through the environment's credential
  proxy, which injects this key.

### What the user actually did (CloudTrail, 2026-10-26 to 2026-11-03, 13,539 events)

- **Reads, by far the most:** CloudTrail lookups, logs, KMS describes, IAM and EC2 describes,
  Lambda configuration, SSM status, Security Hub, GuardDuty, Inspector, RDS describes, and S3
  objects in the website and transfer buckets.
- **Routine writes:**
  - `ec2:StartInstances` / `StopInstances` / `RebootInstances` on the SQL runner
    `i-0c35557c4e5385406`: 31, 32 and 1 calls.
  - `ssm:SendCommand`: 56 calls.
  - `kms:CreateGrant`: 31 calls. These are made by EC2 on the user's behalf when the runner starts,
    to decrypt its EBS volume with the AWS-managed `aws/ebs` key. That key's policy already allows
    this through EC2, so no IAM permission is needed for it.
- **One-off administrative writes by earlier sessions:**
  - Oct 29–30: IAM `CreateRole`, `CreatePolicy`, `PutRolePolicy`, `DeleteRolePolicy`, and Cognito
    `AdminDeleteUser` and `UpdateUserPool`.
  - Nov 2: today's hardening steps (security group, SSM, EBS, Inspector, GuardDuty, Security Hub,
    the staging database's security groups) and two service-linked roles.

## Target

| Attach | What it gives |
|---|---|
| AWS managed `SecurityAudit` | Account-wide metadata reads: CloudTrail lookups, Security Hub, GuardDuty and Inspector findings, describes for EC2, RDS, Lambda, IAM, S3 settings, CloudFront and KMS. No object or secret contents, but it does list object names and read object ACLs and tags in every bucket; `ClaudeCodeOperate` denies that for the private-files buckets. |
| AWS managed `ViewOnlyAccess` | List and describe across remaining services, for orientation. Includes `s3:ListBucket` on every bucket. |
| Inline `ClaudeCodeOperate`, from [`iam/claude-code-operate-policy.json`](iam/claude-code-operate-policy.json) | See below. |

`ClaudeCodeOperate` allows only:
- **S3 reads** of four buckets:
  - the production website bucket;
  - the staging website bucket;
  - the CloudFront access-log bucket (list only);
  - the SQL transfer bucket.
- **CloudWatch Logs** reads and queries.
- **The SQL runner:** start, stop, reboot, and `ssm:SendCommand` with `AWS-RunShellScript`, both
  only on `i-0c35557c4e5385406`.
- **Its own SSM commands:** reading their results, and cancelling them.

It also **denies**, overriding both managed policies, any listing of or object read in the two
private-files buckets (`checksops-production-privatefiles-806168576068` and
`checksops-staging-privatefilesbucket-erzqsolpucjp`). That covers `s3:ListBucket`,
`ListBucketVersions`, `ListBucketMultipartUploads`, `ListMultipartUploadParts` and every
`s3:GetObject*`, including ACLs, tags and attributes. Bucket-level settings, such as the bucket
policy, Block Public Access and encryption, stay readable for security checks.

The first version of the policy passed IAM Access Analyzer `ValidatePolicy` with no findings. The
two deny statements were added after the apply, when this user could no longer call `ValidatePolicy`.
They were checked with `iam:SimulatePrincipalPolicy` instead (see below).

**What this user can no longer do:**
- read, list, or read the ACLs or tags of anything in the private-files buckets, or read any secret value;
- change IAM, Cognito, RDS, security groups or account security settings;
- deploy anything.

Deploys already run through the guarded GitHub workflows with their own OIDC roles, which this
change does not touch. Future one-off administrative work, like today's runbook, becomes "the owner
runs it in CloudShell", or the owner grants a temporary, scoped permission for that task and removes
it after.

## Apply (owner, in CloudShell)

```bash
U=claude-code
# 1. add the new permissions first, so the user is never left without what it needs
aws iam attach-user-policy --user-name $U --policy-arn arn:aws:iam::aws:policy/SecurityAudit
aws iam attach-user-policy --user-name $U --policy-arn arn:aws:iam::aws:policy/job-function/ViewOnlyAccess
aws iam put-user-policy --user-name $U --policy-name ClaudeCodeOperate \
  --policy-document file://claude-code-operate-policy.json   # this repository's ops/security/iam/ file

# 2. remove the admin-level policies
aws iam detach-user-policy --user-name $U --policy-arn arn:aws:iam::aws:policy/PowerUserAccess
aws iam detach-user-policy --user-name $U --policy-arn arn:aws:iam::aws:policy/IAMFullAccess

# 3. verify
aws iam list-attached-user-policies --user-name $U
aws iam list-user-policies --user-name $U
```

After step 3, Claude verifies from a session, read-only:
- `sts get-caller-identity` and a Security Hub read still work;
- an IAM write such as `iam:CreatePolicy` with a dry-run name, which is never created, is refused.

**Rollback:** re-attach `PowerUserAccess` and `IAMFullAccess`.

## Applied, and the private-files follow-up (2026-11-03)

The owner applied the steps above in CloudShell on 2026-11-03. Afterwards the user had
`SecurityAudit`, `ViewOnlyAccess` and the inline `ClaudeCodeOperate`, and nothing else.

Claude's read-only check from a session:
- **Still works:** identity is `user/claude-code`. Security Hub, IAM, logs, SSM and EC2 reads
  work, and so does `HeadObject` on the production website's `index.html`.
- **The SQL runner:** a dry-run `StartInstances` on the runner is allowed, and a dry-run
  `CreateSecurityGroup` is refused. Simulation allows `StopInstances` and `SendCommand` on
  the runner, and refuses them on any other instance.
- **Refused by simulation:** `iam:CreatePolicy`, `AttachUserPolicy`, `PutUserPolicy` and
  `CreateAccessKey`; `cognito-idp:AdminDeleteUser`; `rds:ModifyDBInstance` and
  `ModifyDBSubnetGroup`; `ec2:AuthorizeSecurityGroupIngress`; `s3:PutObject` and
  `PutBucketPolicy`; `secretsmanager:GetSecretValue`; and `lambda:UpdateFunctionCode`.
- **Gap found:** `s3:ListBucket` on both private-files buckets was allowed, and listing
  the production bucket returned an object name. Both managed policies grant it.
  `GetObjectAcl`, `GetObjectVersionAcl` and `GetObjectTagging` were also allowed, by
  `SecurityAudit`. Object contents were refused: `HeadObject` returned 403.

The two deny statements in the policy file close that gap. A simulation with them added refuses
all 15 actions it covers, on both buckets. These are `s3:ListBucket`, `ListBucketVersions`,
`ListBucketMultipartUploads` and `ListMultipartUploadParts`, plus `GetObject`, `GetObjectVersion`,
`GetObjectAcl`, `GetObjectVersionAcl`, `GetObjectTagging`, `GetObjectVersionTagging`,
`GetObjectAttributes`, `GetObjectVersionAttributes`, `GetObjectRetention`, `GetObjectLegalHold`
and `GetObjectTorrent`. The same simulation still allows `GetObject` and `ListBucket` on the
production website bucket, `GetObject` on the SQL transfer bucket, and `GetBucketPolicy` and
`GetBucketPublicAccessBlock` on the private-files bucket.

To apply it (owner, in CloudShell), re-run the `put-user-policy` line with the updated file. It
replaces the whole inline policy, and nothing else changes:

```bash
aws iam put-user-policy --user-name claude-code --policy-name ClaudeCodeOperate \
  --policy-document file://claude-code-operate-policy.json   # this repository's ops/security/iam/ file
aws iam get-user-policy --user-name claude-code --policy-name ClaudeCodeOperate \
  --query 'PolicyDocument.Statement[].Sid'
```

Applied by the owner on 2026-11-03: CloudTrail `PutUserPolicy` by root at 02:06:19 UTC. The first
apply was at 01:14:34–01:14:38 UTC: `AttachUserPolicy` ×2, `PutUserPolicy`, then `DetachUserPolicy` ×2. The policy file the owner applied had the same sha256
as this repository's file: `9d8d1679b34c530cc9bc4de59abb90be86bdd2303d9cb31449a93782af522e08`. The
inline policy now lists seven statements. Claude's read-only check afterwards:
- **Refused (`AccessDenied`):** listing either private-files bucket, and listing the production
  bucket's object versions.
- **Still allowed:** reading that bucket's Block Public Access setting, `HeadObject` on the production
  website's `index.html`, and listing the website and SQL transfer buckets.
- **Simulation:** `GetObjectAcl`, `GetObjectTagging` and `GetObject` on a private-files object are
  each an `explicitDeny`.

**Rollback:** re-run `put-user-policy` with the previous version of the file, the one without the
two `Deny` statements.

## Rotate the key (owner, after the policy change)

The key has had admin-level power since 2026-10-27, so replace it once the policy is narrowed:
1. `aws iam create-access-key --user-name claude-code`. Note the new key.
2. Put the new key in the cloud environment's AWS credential settings. That is where the proxy
   reads it; the steps are in the environment settings page.
3. Start a session and confirm `sts get-caller-identity` works with the new key.
4. `aws iam update-access-key --user-name claude-code --access-key-id <old …O4HG> --status Inactive`,
   then delete it a day later if nothing broke.
