# Temporary Cursor role for Security Hardening #2–#6

**STOP FOR REVIEW — #1–#6 PASS.**
Role **still exists**. Privileged cleanup of stack
`cursor-security-hardening-role` has **not** completed (still
**UPDATE_COMPLETE**). OIDC assume still succeeds. Do **not** broaden
staging. See `aws/cutover/OPERATOR_CLOUDTRAIL_CWLOGS_ROLE.md`.

Do **not** modify this role except via privileged stack delete of
`cursor-security-hardening-role` (live stack name). The CloudTrail →
CloudWatch Logs follow-up is **PASS**. Permanent detection resources stay.

The role exists (created `2026-09-07T17:45:35Z`) with **zero** inline
policies and six customer-managed policies. Cursor OIDC assume
succeeds. See `aws/cutover/OPERATOR_SECURITY_HANDOFF_2TO6.md`.

Two earlier CloudFormation creates **CREATE_FAILED** and rolled back:
`Maximum policy size of 10240 bytes exceeded for role
ChecksOpsCursorSecurityHardeningTemp`. That quota is the role’s
**aggregate inline-policy** size, not per-policy.

This revision attaches the same reviewed Allow/Deny statements as
**six customer-managed policies** owned by the same stack. The role has
**zero** inline policies (aggregate inline = 0 / 10240). Each managed
policy is under the **6,144-character** customer-managed limit. Live
OIDC trust is `api.cursor.com` / `sts.amazonaws.com` / `user:325724407`.
Permissions are not broadened. Financial/application Deny statements
are kept.

**Account:** `806168576068`  
**Region:** `us-east-1`  
**#1 CloudTrail:** PASS (`checksops-production-mgmt-events`). Do not create a
second management trail.

This role exists so Cursor can finish `#2`–`#6` from the already-reviewed
operator package **without** a human remaining in CloudShell, **without**
broadening `ChecksOpsCursorCloudStaging`, and **without** static access keys.

Templates for `#2`–`#6` stay the reviewed files in this PR. This document
only adds the **operator identity** those stacks will run as.

---

## 1. Exact role name

`ChecksOpsCursorSecurityHardeningTemp`

| Field | Value |
|---|---|
| Role name | `ChecksOpsCursorSecurityHardeningTemp` |
| Role ARN | `arn:aws:iam::806168576068:role/ChecksOpsCursorSecurityHardeningTemp` |
| Console stack name (template / historical) | `checksops-cursor-security-hardening-role` |
| Live CloudFormation stack | `cursor-security-hardening-role` |
| Template | `aws/production/cursor-security-hardening-role.yaml` |
| Trust JSON (paste) | `aws/production/cursor-security-hardening-role-trust.json` |
| Combined permissions (review) | `aws/production/cursor-security-hardening-role-permissions.json` |
| Role inline policies | **None** (aggregate inline quota 10,240) |
| Managed policies (6, each ≤6144) | `ChecksOpsCursorSecHardAllowCfnSns`, `AllowConfigPosture`, `AllowFlowAlarms`, `AllowReadonly`, `DenyFinancialApp`, `DenyIamInfra` |
| Max session | `3600` seconds |
| Credential type | Cursor Cloud OIDC → `sts:AssumeRoleWithWebIdentity` only |
| Static keys | **None.** Do not create access keys. |

Do **not** rename it. Do **not** attach extra managed policies. Do **not**
add it to `ChecksOpsCursorCloudStaging`.

---

## 2. Trust policy

**Live Cursor Cloud OIDC (2026-09-07 handoff):** issuer `https://api.cursor.com`,
audience `sts.amazonaws.com`, subject `user:325724407`. The same token
successfully assumes `ChecksOpsCursorCloudStaging`. The older
`oidc.cursor.sh` / `repo:…:environment:staging` subject does **not** match
current tokens and causes `AssumeRoleWithWebIdentity` AccessDenied.

The staging role itself is unchanged: it does **not** gain
`sts:AssumeRole` on this role.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CursorCloudOidcLiveApiCursorCom",
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::806168576068:oidc-provider/api.cursor.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "api.cursor.com:aud": "sts.amazonaws.com",
          "api.cursor.com:sub": "user:325724407"
        }
      }
    }
  ]
}
```

There is **no** `AWS` principal, **no** root, **no**
`ChecksOpsCursorCloudStaging` principal, and **no** `sts:AssumeRole` trust.

---

## 3. Least-privilege permissions

Canonical combined document:
`aws/production/cursor-security-hardening-role-permissions.json`.
The CloudFormation stack creates **six** customer-managed policies and
attaches them to the role (same statements, no added Allow). The role
has no inline policies. Summary:

| Allow | Why |
|---|---|
| CloudFormation create/update/delete **only** on `checksops-production-security-sns`, `-config`, `-posture`, `-flow`, `-alarms` | Deploy / rollback `#2`–`#6` |
| SNS on `checksops-production-security-alerts` | `#2` |
| Config recorder/channel APIs; `iam:PassRole` **only** `checksops-production-config-items-recorder` to `config.amazonaws.com` | `#3` (operator creates that role; no `CreateRole` for Config) |
| GuardDuty detector + Security Hub hub/standards + `TagResource` | `#4` (EBS malware stays **DISABLED** in the reviewed template) |
| `iam:CreateServiceLinkedRole` **only** for `guardduty.amazonaws.com`, `securityhub.amazonaws.com`, `config.amazonaws.com` | First-enable of those services |
| EC2 flow logs on `vpc-09f2268778966ce97`; log group `/aws/vpc/checksops-production-flow`; IAM create/get/put-inline/pass **only** `checksops-production-vpc-flow-logs` to `vpc-flow-logs.amazonaws.com` | `#5` (`CAPABILITY_NAMED_IAM` on that stack only) |
| CloudWatch alarms `checksops-prod*` / `checksops-production-http-api-*` | `#6` |
| Read-only CloudTrail, security-logs bucket list/get, RDS `checksops-staging` describe, Lambda `checksops-production-prep-api` get-config | PASS-verify `#1` leftover + money flags OFF |

Explicit **Deny** (wins over Allow):

- `lambda:UpdateFunctionConfiguration` / `UpdateFunctionCode` / invoke / create / delete
- RDS modify/delete/create/restore and `rds-data:*`
- Cognito pool/client/MFA writes
- `wafv2:*`, CloudFront distribution updates, Route53 record changes
- Secrets Manager get/put, SSM send/session/put-parameter
- CloudFormation mutate of `checksops-production-security-trail`, `checksops-production-cloudtrail`, prep/spa/http-api stacks, **and this role’s own stack**
- S3 delete/put-policy/put-object on `checksops-production-security-logs-806168576068`
- CloudTrail create/update/delete/start/stop/selectors ( `#1` stays as-is )
- IAM mutate except the named VPC Flow Logs role; `PassRole` except `checksops-production-config-items-recorder` + Flow Logs roles; attach managed policies; create users/keys
- `sts:AssumeRole` (no chaining into `ChecksOpsCursorCloudStaging` or the API execution role)
- SG/VPC/route/instance mutation
- Delete/put metric filters on prep API/Lambda log groups

`iam:AttachRolePolicy` is denied even on the flow-logs role (inline
`PutRolePolicy` only), so this identity cannot attach `AdministratorAccess`.

---

## 4. Exact one-time AWS Console action

Do this **once**, after review, as a privileged IAM user/role that already
can `iam:CreateRole` (Administrator or IAM-full + CloudFormation). **Not**
root. **Not** `ChecksOpsCursorCloudStaging`. No access keys, passwords, OTPs,
or secrets are required for Cursor.

1. Console region **N. Virginia (`us-east-1`)**.
2. **CloudFormation → Stacks → Create stack → With new resources (standard)**.
3. **Template source:** Upload a template file → choose
   `aws/production/cursor-security-hardening-role.yaml` from this branch.
4. **Stack name (exact):** `checksops-cursor-security-hardening-role`
5. No parameters. Next through Configure stack options (do not add extra
   IAM policies or a stack service role).
6. **Capabilities:** check **I acknowledge that AWS CloudFormation might
   create IAM resources with custom names** (`CAPABILITY_NAMED_IAM`).
7. Submit. Wait for **CREATE_COMPLETE**.
8. Outputs: `RoleArn` =
   `arn:aws:iam::806168576068:role/ChecksOpsCursorSecurityHardeningTemp`

That is the only AWS write for this step. Do **not** deploy `#2`–`#6` yet.
Do **not** attach further policies. Do **not** edit
`ChecksOpsCursorCloudStaging`. Do **not** touch
`checksops-production-security-trail` or the security-logs bucket.

Do **not** paste the combined permissions JSON as one inline policy
(that exceeds the 10,240 aggregate inline quota). Prefer this
CloudFormation path so the six managed policies and the role are created
and deleted together.

---

## 5. How Cursor will assume it

Existing mechanism only. No new OIDC provider. No static keys.

1. Cursor Cloud issues a web-identity token:
   `POST /run/cursor/api.sock` `/v1/tokens/oidc` body
   `{"aud":"sts.amazonaws.com"}`.
2. `aws sts assume-role-with-web-identity` against
   `arn:aws:iam::806168576068:role/ChecksOpsCursorSecurityHardeningTemp`
   with that token, `--duration-seconds 3600`, session name
   `checksops-sec-hard`.
3. Wrapper: `aws/cutover/scripts/assume-and-run.mjs`.

**Preferred (does not change the staging role or the default environment
ARN):** on the run that will execute `#2`–`#6`, set

```bash
CURSOR_AWS_SECURITY_HARDENING_ROLE_ARN=arn:aws:iam::806168576068:role/ChecksOpsCursorSecurityHardeningTemp
```

The wrapper uses that ARN when set; otherwise it keeps
`CURSOR_AWS_ASSUME_IAM_ROLE_ARN` (`ChecksOpsCursorCloudStaging`).

**Alternative:** temporarily point the Cursor Cloud environment AWS role ARN
at the temp role for that run only. Restore `ChecksOpsCursorCloudStaging`
after PASS.

Do **not** add `sts:AssumeRole` on `ChecksOpsCursorCloudStaging` to chain
into this role. Do **not** put a human IAM user in the trust.

Until the Console create in §4 is done, assume will fail with `AccessDenied`
/ `NoSuchEntity`. That is expected.

---

## 6. Revoke / delete after final PASS

After `#2`–`#6` are PASS-verified:

1. Unset `CURSOR_AWS_SECURITY_HARDENING_ROLE_ARN`. If the Cursor environment
   ARN was retargeted, restore `ChecksOpsCursorCloudStaging`.
2. Console **CloudFormation → stack `checksops-cursor-security-hardening-role`
   → Delete**. That removes the role and all six managed policies.
3. Confirm:
   `aws iam get-role --role-name ChecksOpsCursorSecurityHardeningTemp`
   → `NoSuchEntity`.
4. Confirm `GetCallerIdentity` on the next Cursor run is again
   `ChecksOpsCursorCloudStaging`.

**Do not delete** as part of revoke:

- Bucket `checksops-production-security-logs-806168576068` or its policy
- CREATE_FAILED stack `checksops-production-security-trail`
- Trail `checksops-production-mgmt-events`
- Role `checksops-production-config-items-recorder` (after operator create)
- Missing leftover name `checksops-production-config-recorder` (do not recreate)
- Leftover `checksops-production-vpc-flow-logs` / `checksops-production-cloudtrail-logs` if still present
- Live `#2`–`#6` detection resources (those stay; only the **Cursor** role goes)

If CloudFormation delete is blocked, IAM → Roles →
`ChecksOpsCursorSecurityHardeningTemp` → Delete role.

---

## 7. This role cannot activate financial / provider functionality

Money/provider execution is gated on Lambda environment flags
`AWS_MOOV_ENABLED`, `AWS_CHECKALT_ENABLED`,
`AWS_PROVIDER_EXECUTION_ENABLED`, and
`AWS_FINANCIAL_PERMISSIONS_ACTIVATED`, plus SQL
`64_financial_activation_grants.sql`.

This role:

- Has **Deny** on `lambda:UpdateFunctionConfiguration` (the API that would
  set those flags) and on `lambda:UpdateFunctionCode`
- Has **no** `secretsmanager:GetSecretValue` (cannot read
  `checksops/staging/providers` or RDS secrets)
- Has **Deny** on `rds-data:*` and RDS modify/restore (cannot apply `64_`)
- Has **no** `iam:PassRole` on `checksops-production-api-execution`
- Has **Deny** on `sts:AssumeRole` (cannot chain to a broader role)
- Does not grant WAF, CloudFront, Cognito, or Route53 writes

Read-only `lambda:GetFunctionConfiguration` is allowed **only** to confirm
the four flags remain `false`.

Residual (not financial): `guardduty:UpdateDetector` is required for the
reviewed `#4` template and **could** flip EBS malware on. Do not do that.
The template keeps `EBS_MALWARE_PROTECTION` **DISABLED**. IAM cannot express
that feature flag.

---

## Holds (unchanged)

- `#1`–`#6` are **PASS**. Temporary-role cleanup is **BLOCKED**; do not
  broaden staging. Privileged next step: delete live stack
  `cursor-security-hardening-role`.
- Do not broaden `ChecksOpsCursorCloudStaging`.
- Do not use root, access keys, passwords, OTPs, or secrets.
- Do not modify application code, prep Lambda env/VPC/role, RDS data,
  Cognito, CloudFront, WAF, migration bridges, or staging.
- Do not enable Moov, CheckAlt, provider execution, or financial
  permissions. Do not apply `64_financial_activation_grants.sql`.
- Preserve the security-logs bucket and policy. Leave
  `checksops-production-security-trail` CREATE_FAILED untouched.
- Do not implement API-behind-CloudFront in this step.
