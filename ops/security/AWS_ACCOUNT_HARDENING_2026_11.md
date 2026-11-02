# AWS account hardening, November 2026

Owner, 2026-11-02: "Proceed with a runbook PR for AWS items 1–5 and 8" and "OS patching 7 and data
exposure 6". Root console use (GuardDuty `Policy:IAMUser/RootCredentialUsage`) was confirmed by the
owner as their own.

This runbook changes nothing by itself. Account `806168576068`, region `us-east-1`.

**Who runs it.** The repository rules forbid direct AWS changes outside the guarded workflows and
the production SQL one-shot. No guarded workflow covers these account settings, so each step needs
one of two things:
- the owner runs it in AWS CloudShell; or
- the owner gives the exact go phrase listed with that step, as an explicit exception for that step
  only.

Every step follows the same shape: run the read-only pre-check, then the change, then the read-only
verification. Stop if a pre-check shows anything other than the expected result.

## Live state (read-only, 2026-11-02 20:40 UTC, `user/claude-code`)

Security Hub: 94 active CRITICAL/HIGH findings.
- 2 critical: EC2.19 and SSM.7.
- 92 high:
  - EC2.13, EC2.18, EC2.2, EC2.182;
  - S3.8 ×2 and RDS.46 ×2;
  - Inspector.3, GuardDuty.7, GuardDuty.8, GuardDuty.11;
  - about 80 Inspector package CVEs on the SQL runner `i-0c35557c4e5385406`.

| Item | Resource | Live state |
|---|---|---|
| 1 | `sg-07c8c7bc0d772b160` `launch-wizard-1` | Inbound tcp/22, 80 and 443 from `0.0.0.0/0`. No network interface, security group or launch template references it (0 launch templates exist). |
| 2 | SSM setting `/ssm/documents/console/public-sharing-permission` | `Enable`. 1 account-owned document, not shared publicly. |
| 3 | `checksops-staging-frontend-c48b` | Block Public Access all off. Bucket policy allows only CloudFront OAC for `E1CG52WRQZI7X1` (`IsPublic` false), `BucketOwnerEnforced`. Website hosting is configured but unused: CloudFront reads the REST endpoint through OAC. |
| 3 | `checksops-production-access-logs-806168576068` | `BlockPublicAcls` and `IgnorePublicAcls` off; the other two on. `BucketOwnerPreferred`; receives CloudFront standard logs for `E1B0ZWWO5559U5`. Policy not public. |
| 3 | Account-level S3 Block Public Access (S3.1) | Not configured. The other 9 buckets already have all four settings on, and none of the 11 buckets has a public policy or ACL. |
| 4 | EBS snapshot block public access | `unblocked`. The account owns 0 snapshots; none is public. |
| 5 | `sg-0a90b85366facd041` (VPC `default` group) | Inbound all traffic from itself; outbound all. Its only member is the staging database (`eni-060aa1a78b7d6a755`), which also has `rds-ec2-1` (`sg-0e9332faa87c1d059`). That group admits 5432 from the staging Lambda group `sg-0fe2698f236959353`. |
| 6 | RDS `checksops-production`, `checksops-staging` | `PubliclyAccessible` false; no public IP on any database ENI; encrypted; deletion protection on; 35-day backups. See item 6. |
| 8 | Inspector | EC2, ECR and Lambda scanning on. `lambdaCode` off. |
| 8 | GuardDuty `298dc17133dd46b1b2cf755bc1380e1f` | CloudTrail, DNS, flow logs, S3, EKS audit, RDS login and Lambda network logs on. `EBS_MALWARE_PROTECTION`, `RUNTIME_MONITORING` and `EKS_RUNTIME_MONITORING` off. The account has no EKS clusters. |

## Item 1 — delete the unused open security group (EC2.19, EC2.13, EC2.18)

Go phrase: **"run AWS hardening step 1"**

```bash
# Pre-check: every command must print an empty list.
aws ec2 describe-network-interfaces --filters Name=group-id,Values=sg-07c8c7bc0d772b160 --query 'NetworkInterfaces[].NetworkInterfaceId'
aws ec2 describe-security-groups --filters Name=ip-permission.group-id,Values=sg-07c8c7bc0d772b160 --query 'SecurityGroups[].GroupId'
aws ec2 describe-security-groups --filters Name=egress.ip-permission.group-id,Values=sg-07c8c7bc0d772b160 --query 'SecurityGroups[].GroupId'

# Change
aws ec2 delete-security-group --group-id sg-07c8c7bc0d772b160

# Verify: InvalidGroup.NotFound
aws ec2 describe-security-groups --group-ids sg-07c8c7bc0d772b160
```

Rollback: recreate `launch-wizard-1` in `vpc-09f2268778966ce97`. Nothing should need it: nothing
used it.

## Item 2 — block public sharing of SSM documents (SSM.7, critical)

Go phrase: **"run AWS hardening step 2"**

```bash
# Pre-check: no account-owned document is shared with "All".
for d in $(aws ssm list-documents --filters Key=Owner,Values=Self --query 'DocumentIdentifiers[].Name' --output text); do
  echo "$d $(aws ssm describe-document-permission --name "$d" --permission-type Share --query 'AccountIds' --output text)"
done

# Change
aws ssm update-service-setting --setting-id /ssm/documents/console/public-sharing-permission --setting-value Disable

# Verify: Disable
aws ssm get-service-setting --setting-id /ssm/documents/console/public-sharing-permission --query 'ServiceSetting.SettingValue'
```

Rollback: the same command with `--setting-value Enable`. The guarded SQL one-shot uses
`AWS-RunShellScript`, an AWS-owned document; this setting does not affect it.

## Item 3 — S3 Block Public Access (S3.8 ×2, then S3.1)

Go phrase: **"run AWS hardening step 3"**

```bash
BPA=BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

# Pre-check: IsPublic false for both; no AllUsers or AuthenticatedUsers grant.
for b in checksops-staging-frontend-c48b checksops-production-access-logs-806168576068; do
  aws s3api get-bucket-policy-status --bucket "$b" --query 'PolicyStatus.IsPublic'
  aws s3api get-bucket-acl --bucket "$b" --query 'Grants[?Grantee.URI].Grantee.URI'
done
aws s3api list-objects-v2 --bucket checksops-production-access-logs-806168576068 --prefix cloudfront/ \
  --query 'reverse(sort_by(Contents,&LastModified))[0].LastModified'   # note the newest log time

# 3a: the two buckets
aws s3api put-public-access-block --bucket checksops-staging-frontend-c48b --public-access-block-configuration "$BPA"
aws s3api put-public-access-block --bucket checksops-production-access-logs-806168576068 --public-access-block-configuration "$BPA"

# 3b: the unused website configuration on the staging bucket (CloudFront uses the REST endpoint)
aws s3api delete-bucket-website --bucket checksops-staging-frontend-c48b

# Verify 3a/3b
curl -sI https://staging.checksops.com/ | head -1          # HTTP/2 200
curl -sI https://checksops.com/ | head -1                  # HTTP/2 200
```

Wait one hour for CloudFront to deliver logs, then confirm logs still arrive. The newest
`cloudfront/` object must be newer than the time noted above. CloudFront standard logging writes
with an ACL grant to the AWS log-delivery account, which is not a public grant, so Block Public
Access does not stop it.

```bash
aws s3api list-objects-v2 --bucket checksops-production-access-logs-806168576068 --prefix cloudfront/ \
  --query 'reverse(sort_by(Contents,&LastModified))[0].LastModified'
```

3c: account-wide Block Public Access (S3.1). Do this only after 3a and 3b verify, and after
re-running the pre-check loop over every bucket (`aws s3api list-buckets`):

```bash
aws s3control put-public-access-block --account-id 806168576068 --public-access-block-configuration "$BPA"
aws s3control get-public-access-block --account-id 806168576068
```

Rollback: `aws s3api delete-public-access-block --bucket <bucket>`, or
`aws s3control delete-public-access-block --account-id 806168576068`, and
`put-bucket-website` with the previous configuration (`index.html`).

## Item 4 — EBS snapshot block public access (EC2.182)

Go phrase: **"run AWS hardening step 4"**

```bash
# Pre-check: empty list
aws ec2 describe-snapshots --owner-ids self --restorable-by-user-ids all --query 'Snapshots[].SnapshotId'

# Change
aws ec2 enable-snapshot-block-public-access --state block-all-sharing

# Verify: block-all-sharing
aws ec2 get-snapshot-block-public-access-state --query State
```

Rollback: `aws ec2 disable-snapshot-block-public-access`.

## Item 5 — empty the default security group (EC2.2)

Go phrase: **"run AWS hardening step 5"**

The staging database is the default group's only member. It reaches staging Lambdas through
`rds-ec2-1`, not through the default group's self rule. Remove the default group from the staging
database first, then empty the group. This is staging only; production does not use the default
group. A security-group change on RDS applies immediately without a restart.

```bash
# Pre-check: rds-ec2-1 admits the staging Lambda group on 5432
aws ec2 describe-security-groups --group-ids sg-0e9332faa87c1d059 --query 'SecurityGroups[0].IpPermissions'
# Pre-check: the staging database ENI is the default group's only member
aws ec2 describe-network-interfaces --filters Name=group-id,Values=sg-0a90b85366facd041 --query 'NetworkInterfaces[].[NetworkInterfaceId,Description]'

# 5a: staging database keeps only rds-ec2-1
aws rds modify-db-instance --db-instance-identifier checksops-staging \
  --vpc-security-group-ids sg-0e9332faa87c1d059 --apply-immediately

# Verify 5a: [sg-0e9332faa87c1d059]
aws rds describe-db-instances --db-instance-identifier checksops-staging --query 'DBInstances[0].VpcSecurityGroups[].VpcSecurityGroupId'
# Then prove a staging Lambda still reaches the database: run guarded-staging-sql-executor.yml with
# mode read-live (read-only) and confirm it connects. /staging/health does not test this:
# it reports "database":"not-connected" by design.

# 5b: remove the default group's rules
aws ec2 revoke-security-group-ingress --group-id sg-0a90b85366facd041 \
  --ip-permissions 'IpProtocol=-1,UserIdGroupPairs=[{GroupId=sg-0a90b85366facd041}]'
aws ec2 revoke-security-group-egress --group-id sg-0a90b85366facd041 \
  --ip-permissions 'IpProtocol=-1,IpRanges=[{CidrIp=0.0.0.0/0}]'

# Verify 5b: [] and []
aws ec2 describe-security-groups --group-ids sg-0a90b85366facd041 --query 'SecurityGroups[0].[IpPermissions,IpPermissionsEgress]'
```

Rollback: re-add the two rules with `authorize-security-group-ingress` and
`authorize-security-group-egress`. Restore the database's groups with
`modify-db-instance --vpc-security-group-ids sg-0e9332faa87c1d059 sg-0a90b85366facd041`.

## Item 8 — detection coverage (Inspector.3, GuardDuty.8, GuardDuty.11, GuardDuty.7)

Go phrase: **"run AWS hardening step 8"**

| Control | Recommendation | Why |
|---|---|---|
| Inspector.3 (Lambda code scanning) | Enable | About 90 Lambdas hold application code. Billed per function scanned; small at this size. |
| GuardDuty.8 (Malware Protection for EC2) | Enable | Scans EBS volumes only when GuardDuty raises a finding on an instance. Pay per scan. |
| GuardDuty.11 (Runtime Monitoring) | Defer; disable the control with a reason | The only EC2 instance is the SQL runner, which is stopped between runs. Runtime Monitoring needs an agent on it. Revisit if more instances or containers appear. |
| GuardDuty.7 (EKS Runtime Monitoring) | Disable the control with a reason | The account has no EKS clusters. |

```bash
# Change
aws inspector2 enable --resource-types LAMBDA_CODE
aws guardduty update-detector --detector-id 298dc17133dd46b1b2cf755bc1380e1f \
  --features '[{"Name":"EBS_MALWARE_PROTECTION","Status":"ENABLED"}]'

# Verify
aws inspector2 batch-get-account-status --query 'accounts[0].resourceState.lambdaCode.status'      # ENABLED
aws guardduty get-detector --detector-id 298dc17133dd46b1b2cf755bc1380e1f \
  --query "Features[?Name=='EBS_MALWARE_PROTECTION'].Status"                                       # ENABLED
```

Disable GuardDuty.7 and GuardDuty.11 in the Security Hub console: Controls → the control → Disable,
with the reasons from the table above.

Rollback: `aws inspector2 disable --resource-types LAMBDA_CODE`, and the same `update-detector`
call with `"Status":"DISABLED"`.

## Item 6 — database network exposure (RDS.46): findings and plan

Read-only result, 2026-11-02:
- **Exposure today: none from the internet.** Both databases have `PubliclyAccessible` false, and no
  database ENI has a public IP.
- **Production firewall:** `checksops-production-rds` admits 5432 only from the production Lambda
  group `sg-0bc4695a666baf49b` and the SQL runner group `sg-0c606bab2bdb2abc5`.
- **Production placement:** Multi-AZ. The primary is in `us-east-1f`, subnet
  `subnet-092e4e41821fba6c4`, which routes `0.0.0.0/0` through NAT `nat-15f538197c4a75331`. The
  standby is in `us-east-1b`, subnet `subnet-03989e61c0468268a`, whose route table
  `rtb-0b92eeeb4ce2759c8` has an internet-gateway route. The subnet group
  `checksops-production-db-subnets` lists all six VPC subnets, four of them internet-routed.
- **Staging placement:** single-AZ in `us-east-1f`. It uses the shared `default-vpc-09f2268778966ce97`
  subnet group, which has the same six subnets.
- **Lambdas:** every Lambda in the VPC uses only the two NAT-routed private subnets, `us-east-1a`
  (`subnet-0df2518070c5b9ff0`) and `us-east-1f`.

RDS.46 flags placement, not an open path. The risk it guards against: if `PubliclyAccessible` were
ever switched on, an instance in an internet-routed subnet would become reachable at once.

**Plan, a separate reviewed change with its own approval, staging first.** Restrict both subnet
groups to the two private subnets (1a and 1f):
1. Staging: create a dedicated subnet group `checksops-staging-db-private` (1a and 1f), and move
   `checksops-staging` to it in a staging window. Confirm in the current RDS documentation that
   moving an instance between subnet groups in the same VPC is supported for this configuration
   before scheduling. If it is not, use the Multi-AZ route below.
2. Production, in an announced window:
   1. `modify-db-instance --no-multi-az`. This removes the 1b standby; the primary stays in 1f
      with no restart.
   2. `modify-db-subnet-group` to keep only 1a and 1f.
   3. `modify-db-instance --multi-az`. The new standby is created in 1a; expect brief I/O latency
      while it syncs.

   Re-check `PubliclyAccessible`, the security groups and the API health after each step.
3. Until then, Security Hub control RDS.2 (public accessibility) is the guardrail on the
   `PubliclyAccessible` flag. Confirm it stays PASSED.

## Item 7 — SQL runner OS patching

The runner `i-0c35557c4e5385406` is Amazon Linux 2023, image `ami-0d27e0fb3bac4d724`, in private
subnet `us-east-1a`, stopped between runs. Inspector reports about 80 HIGH package CVEs: kernel,
openssl, sudo, curl, bind, systemd, libcap, python3 and others.

Go phrase, run by Claude through SSM: **"start the production SQL runner for OS patching"**.
Starting the runner always needs the owner's words. This phrase covers one patch run and nothing
else: no SQL.

1. Start the instance and wait until SSM reports it online.
2. Before: record `uname -r`, `cat /etc/os-release`, `node --version`, `rpm -q nodejs` and
   `dnf check-release-update`. Also record
   `dnf updateinfo list --security --sec-severity Critical,Important | wc -l`.
3. Patch: `sudo dnf upgrade --releasever=latest -y`. Amazon Linux 2023 delivers fixes in release
   versions, so the security updates need the latest release. Record the transaction summary.
4. Reboot with `aws ec2 reboot-instances`, wait until SSM is online, and confirm the new `uname -r`.
   `dnf needs-restarting -r` must report no reboot needed.
5. Smoke check, read-only:
   - `node --version`; if it changed, record both versions;
   - the one-shot tool's `--inspect` against production, which proves the runner still reaches the
     database;
   - `dnf updateinfo list --security --sec-severity Critical,Important | wc -l`, expected 0.
6. Stop the instance and confirm `stopped`. Inspector refreshes the instance's findings the next
   time it scans the running instance. The earlier Inspector SSM plugin run failed with
   `InvalidPlatform`, so record the before/after package versions here as the evidence, not only
   Inspector's view.

Rollback: Amazon Linux 2023 keeps the previous kernel. If the instance does not come back healthy,
select the previous kernel with `grubby --set-default` through the serial console, or rebuild the
runner from the same image.

## Not in this runbook

- xlsx in the SPA: waits on the owner's choice of route.
- npm dependency findings: PR #1551 (pdfjs-dist, xmldom) and the planned lockfile refresh.
- Root account: the owner confirmed the console use is theirs. Recommended: MFA on root, and a
  separate admin login for day-to-day work.
