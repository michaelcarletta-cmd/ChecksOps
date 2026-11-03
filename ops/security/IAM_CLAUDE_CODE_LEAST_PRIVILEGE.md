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
| AWS managed `SecurityAudit` | Account-wide metadata reads: CloudTrail lookups, Security Hub, GuardDuty and Inspector findings, describes for EC2, RDS, Lambda, IAM, S3 settings, CloudFront and KMS. **No object or secret contents.** |
| AWS managed `ViewOnlyAccess` | List and describe across remaining services, for orientation. |
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

The policy passes IAM Access Analyzer `ValidatePolicy` with no findings.

**What this user can no longer do:**
- read the private-files buckets or any secret value;
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

## Rotate the key (owner, after the policy change)

The key has had admin-level power since 2026-10-27, so replace it once the policy is narrowed:
1. `aws iam create-access-key --user-name claude-code`. Note the new key.
2. Put the new key in the cloud environment's AWS credential settings. That is where the proxy
   reads it; the steps are in the environment settings page.
3. Start a session and confirm `sts get-caller-identity` works with the new key.
4. `aws iam update-access-key --user-name claude-code --access-key-id <old …O4HG> --status Inactive`,
   then delete it a day later if nothing broke.
