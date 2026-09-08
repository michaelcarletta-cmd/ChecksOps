# Temporary Cursor role for CloudTrail → CloudWatch Logs

**STOP FOR REVIEW.** Follow-up remains **PASS**. Temporary-role cleanup is
**INCOMPLETE**.

Privileged delete of stack `checksops-cursor-cloudtrail-cwlogs-role`
succeeded (stack now does not exist). Live hardening stack
`cursor-security-hardening-role` is still **UPDATE_COMPLETE**, and
`ChecksOpsCursorSecurityHardeningTemp` still assumes. Remaining Cursor
identities receive `AccessDenied` (not `NoSuchEntity`) on `iam:GetRole` /
`iam:GetPolicy` for the deleted CW Logs temp role. Do **not** broaden
staging.

Permanent CloudTrail → CloudWatch Logs resources remain. Do **not** clean
up `security@checksops.com`. Do **not** start API-behind-CloudFront or
financial activation.

**Account:** `806168576068`  
**Region:** `us-east-1`

## Final read-only cleanup verification 2026-09-08T13:57Z — FAIL

No AWS mutations. Staging cannot read CloudTrail/alarms/SNS attrs/Config/
GuardDuty/Hub/Flow Logs/IAM GetRole. Remaining HardeningTemp was used
only for those reads, which also proves that role is **not** gone.

| Check | Result |
|---|---|
| Stack `checksops-cursor-cloudtrail-cwlogs-role` | **gone** (`does not exist`) |
| Stack `cursor-security-hardening-role` | still **UPDATE_COMPLETE** (role + 6 managed policies) |
| `ChecksOpsCursorCloudTrailCwLogsTemp` assume | **AccessDenied** |
| `ChecksOpsCursorCloudTrailCwLogsTemp` `GetRole` | **AccessDenied** (not `NoSuchEntity`) |
| `ChecksOpsCursorSecurityHardeningTemp` | **EXISTS**; assume `checksops-sec-hard` succeeds |
| HardeningTemp attached policies | all **6** still attached |
| Stack `checksops-production-security-trail-cwlogs` | still **CREATE_COMPLETE** |
| Trail `checksops-production-mgmt-events` | `IsLogging=true`, exactly **1** trail |
| CW Logs delivery | `LatestCloudWatchLogsDeliveryTime=2026-09-08T13:56:26Z`, error **none** |
| Log group | `/aws/cloudtrail/checksops-production-mgmt-events`, retention **365** |
| Metric filter | `checksops-prod-iam-security-changes-filter` present |
| 14 security alarms | all present; all page `checksops-production-security-alerts` |
| Alarm `checksops-prod-iam-security-changes` | **OK** as of `2026-09-08T13:54:09Z` (recovered; not suppressed) |
| SNS `support@checksops.com` | **Confirmed** (`PendingConfirmation=false`) |
| SNS `security@checksops.com` | still **PendingConfirmation** (untouched) |
| Config `checksops-production-config-items` | recording **true**, `lastStatus=SUCCESS`, history **SUCCESS** |
| GuardDuty | `298dc17133dd46b1b2cf755bc1380e1f` **ENABLED**, EBS malware **DISABLED** |
| Security Hub | `hub/default` enabled |
| VPC Flow Logs `fl-0913268bc96a95205` | **ACTIVE** / `DeliverLogsStatus=SUCCESS` |
| RDS `checksops-staging` | backup **35**, deletion protection **on** |
| Security-logs PAB | all four **true** |
| Moov / CheckAlt / Provider / Financial | all **false** |
| `productionExecution` | **false** |
| `64_financial_activation_grants.sql` | **NOT_APPLIED** |
| Smoke | `/health` 200, `/ops/readiness` 200 `holds.ok=true`, `/financial/status` 200 |
| Failed trail stack | still **CREATE_FAILED** (untouched) |

Privileged next step: delete live stack `cursor-security-hardening-role`,
then confirm `GetRole` → `NoSuchEntity` for both temp roles and the nine
stack-owned policies.

---

## Cleanup attempt 2026-09-08 — BLOCKED

Read-only preflight of the follow-up **PASS** (logging, CW Logs delivery,
365-day log group, metric filter, alarm → existing SNS, `support@`
Confirmed, money flags false, `64_` NOT_APPLIED).

Then revoke was attempted as `ChecksOpsCursorCloudStaging` (the temp
roles Deny mutation of their own stacks).

| Stack | Result |
|---|---|
| `checksops-cursor-cloudtrail-cwlogs-role` | **DELETE_FAILED** — `iam:DetachRolePolicy` AccessDenied on `ChecksOpsCursorCloudTrailCwLogsTemp` |
| `checksops-cursor-security-hardening-role` | already **does not exist** (historical). Live owner is `cursor-security-hardening-role` |
| `cursor-security-hardening-role` | **UPDATE_COMPLETE** — not deleted after the first stack failed |
| `checksops-production-security-trail-cwlogs` | still **CREATE_COMPLETE** |
| `checksops-production-security-trail` | still **CREATE_FAILED** |

Re-verified 2026-09-08T12:13Z as
`ChecksOpsCursorCloudTrailCwLogsTemp/checksops-ct-cwlogs` (HardeningTemp
still assumes separately):

| Check | Result |
|---|---|
| Stack `checksops-production-security-trail-cwlogs` | still **CREATE_COMPLETE** |
| Trail `checksops-production-mgmt-events` | `IsLogging=true`, exactly **1** trail |
| CW Logs delivery | `LatestCloudWatchLogsDeliveryTime=2026-09-08T12:11:05Z`, error **none** |
| Log group | `/aws/cloudtrail/checksops-production-mgmt-events`, retention **365** |
| Metric filter | `checksops-prod-iam-security-changes-filter` present |
| Alarm `checksops-prod-iam-security-changes` | still pages `checksops-production-security-alerts`; currently **ALARM** after the blocked `iam:DetachRolePolicy` attempt |
| SNS `support@checksops.com` | **Confirmed** (`PendingConfirmation=false`) |
| SNS `security@checksops.com` | still **PendingConfirmation** (untouched) |
| Moov / CheckAlt / Provider / Financial | all **false** |
| `productionExecution` | **false** |
| `64_financial_activation_grants.sql` | **NOT_APPLIED** stub; `financialPermissionsActivated=false` |
| Smoke | `/health` 200, `/ops/readiness` 200 `holds.ok=true`, `/financial/status` 200 |

Both temporary roles still assume. Stack-owned managed policies still
exist (CFN resource list). Delivery role
`checksops-production-cloudtrail-cwlogs` kept.

Privileged next step (not staging, not these temp roles): retry
`delete-stack` on `checksops-cursor-cloudtrail-cwlogs-role`, then delete
`cursor-security-hardening-role` (the live HardeningTemp stack). Confirm
`GetRole` → `NoSuchEntity` for both temp roles and their nine managed
policies. Do **not** broaden `ChecksOpsCursorCloudStaging`.

---

## Follow-up verification 2026-09-08 — PASS

| Check | Result |
|---|---|
| Caller | `arn:aws:sts::806168576068:assumed-role/ChecksOpsCursorCloudTrailCwLogsTemp/checksops-ct-cwlogs` |
| Stack `checksops-production-security-trail-cwlogs` | **CREATE_COMPLETE** (`f5972840-ab7a-11f1-88a6-0afffa733a75`, created `2026-09-08T11:46:42Z`) |
| Log group | `/aws/cloudtrail/checksops-production-mgmt-events`, retention **365** |
| IAM role | `checksops-production-cloudtrail-cwlogs` |
| Metric filter | `checksops-prod-iam-security-changes-filter` → `ChecksOps/ProductionPrep` / `IamSecurityChanges` / value `1` / `DefaultValue=0` |
| `UpdateTrail` | **one call**, only `--cloud-watch-logs-log-group-arn` and `--cloud-watch-logs-role-arn` |
| Frozen trail fields | **unchanged** (`frozenDiff=[]`) |
| `IsLogging` | **true** |
| Trail count | **1** (`checksops-production-mgmt-events`) |
| S3 | `checksops-production-security-logs-806168576068` / prefix `cloudtrail` |
| Multi-region / validation / global events | **true** / **true** / **true** |
| Selectors | management All, `DataResources=[]`, no insight selectors |
| CW Logs ARNs | log-group `.../aws/cloudtrail/checksops-production-mgmt-events:*` ; role `checksops-production-cloudtrail-cwlogs` |
| CW Logs delivery | `LatestCloudWatchLogsDeliveryTime=2026-09-08T11:49:53Z`, error **none**, **1** stream (no intentional IAM test event) |
| Alarm `checksops-prod-iam-security-changes` | **unchanged**; still pages `checksops-production-security-alerts`; `TreatMissingData=notBreaching` |
| SNS `support@checksops.com` | still **Confirmed** (`…:f9200315-a38c-4b3d-ace0-074b7aa143ae`) |
| SNS `security@checksops.com` | still **PendingConfirmation** (untouched) |
| Moov / CheckAlt / Provider / Financial | all **false** |
| `productionExecution` | **false** |
| `64_financial_activation_grants.sql` | **NOT_APPLIED** |
| Smoke | `/health` 200, `/ops/readiness` 200 `holds.ok=true`, `/financial/status` 200 |
| Temp roles | **kept** |

---

## 1. Exact role name

`ChecksOpsCursorCloudTrailCwLogsTemp`

| Field | Value |
|---|---|
| Role name | `ChecksOpsCursorCloudTrailCwLogsTemp` |
| Role ARN (after create) | `arn:aws:iam::806168576068:role/ChecksOpsCursorCloudTrailCwLogsTemp` |
| Console stack name | `checksops-cursor-cloudtrail-cwlogs-role` |
| Template | `aws/production/cursor-cloudtrail-cwlogs-role.yaml` |
| Trust JSON | `aws/production/cursor-cloudtrail-cwlogs-role-trust.json` |
| Combined permissions (review only) | `aws/production/cursor-cloudtrail-cwlogs-role-permissions.json` |
| Attached Allow | `aws/production/cursor-cloudtrail-cwlogs-role-allow.json` → `ChecksOpsCursorCtCwLogsAllow` |
| Attached Deny (financial/app) | `aws/production/cursor-cloudtrail-cwlogs-role-deny-financial.json` → `ChecksOpsCursorCtCwLogsDenyFinancial` |
| Attached Deny (IAM/trail/infra) | `aws/production/cursor-cloudtrail-cwlogs-role-deny-iam.json` → `ChecksOpsCursorCtCwLogsDenyIam` |
| Review-only merged Deny | `aws/production/cursor-cloudtrail-cwlogs-role-deny.json` (do not attach) |
| Role inline policies | **None** (aggregate inline quota 10,240) |
| Max session | `3600` seconds |
| Credential type | Cursor Cloud OIDC → `sts:AssumeRoleWithWebIdentity` only |
| Static keys | **None.** Do not create access keys. |

Do **not** rename it. Do **not** attach extra managed policies. Do **not**
add it to `ChecksOpsCursorCloudStaging`. Do **not** add it to
`ChecksOpsCursorSecurityHardeningTemp`.

---

## 2. Trust policy

Same live Cursor Cloud OIDC as the hardening role: issuer
`https://api.cursor.com`, audience `sts.amazonaws.com`, subject
`user:325724407`. No AWS principal, no root, no staging-role principal,
no `sts:AssumeRole` trust.

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

---

## 3. Least-privilege permissions

Canonical combined document:
`aws/production/cursor-cloudtrail-cwlogs-role-permissions.json`.
The CloudFormation stack creates **three** customer-managed policies and
attaches them (same statements, no added Allow). The role has no inline
policies.

| Allow | Why |
|---|---|
| CloudFormation create/update/delete **only** `checksops-production-security-trail-cwlogs` | Deploy / rollback the approved follow-up stack |
| IAM create/get/delete/put-inline/pass **only** `checksops-production-cloudtrail-cwlogs`, passed **only** to `cloudtrail.amazonaws.com` | Stack-owned delivery role |
| CloudWatch Logs create/retention/metric-filter **only** on `/aws/cloudtrail/checksops-production-mgmt-events` | Log group + `checksops-prod-iam-security-changes-filter` |
| `cloudtrail:DescribeTrails`, `ListTrails` (account) | Confirm still exactly one trail |
| `cloudtrail:GetTrail`, `GetTrailStatus`, `GetEventSelectors` on `checksops-production-mgmt-events` | Confirm S3 delivery, multi-region, selectors, `DataResources=[]` |
| `cloudtrail:UpdateTrail` **only** `checksops-production-mgmt-events` | Add CloudWatch Logs log-group ARN + role ARN |
| Read-only security-logs bucket, RDS `checksops-staging`, Lambda `checksops-production-prep-api`, Config/GuardDuty/Hub/Flow/alarms/SNS | Verify money flags OFF and `#1`–`#6` unchanged |

Explicit **Deny** (wins over Allow):

- `cloudtrail:CreateTrail`, `DeleteTrail`, `StartLogging`, `StopLogging`, `PutEventSelectors`, `PutInsightSelectors`
- `cloudtrail:UpdateTrail` on **any trail other than** `checksops-production-mgmt-events`
- Lambda mutate/invoke (including `UpdateFunctionConfiguration` that would set money/provider flags)
- RDS mutate/restore and `rds-data:*`
- Cognito pool/client/MFA writes
- `wafv2:*`, `cloudfront:*`, Route53 hosted-zone / record changes
- Secrets Manager get/put/create/delete/list; SSM put-parameter / send / session
- CloudFormation mutate of the failed trail stack, prep/spa/http-api, **hardening role stack**, **this role’s own stack**, and live `#2`–`#6` stacks
- S3 delete/put-policy/put-object on `checksops-production-security-logs-806168576068`
- IAM mutate except the named CloudTrail CW Logs delivery role; `PassRole` except that role to `cloudtrail.amazonaws.com`; attach managed policies
- `sts:AssumeRole` (no chaining into staging or the API execution role)
- SNS/Config/GuardDuty/Hub/Flow/alarm mutation
- Metric-filter / log-group mutation on prep API, HTTP API, and VPC flow log groups

`iam:AttachRolePolicy` is denied on **all** roles (inline `PutRolePolicy`
only on the delivery role), so this identity cannot attach
`AdministratorAccess`.

**Residual:** IAM cannot constrain `UpdateTrail` arguments. After this
role exists, the follow-up must pass **only**:

```bash
aws cloudtrail update-trail \
  --name checksops-production-mgmt-events \
  --cloud-watch-logs-log-group-arn arn:aws:logs:us-east-1:806168576068:log-group:/aws/cloudtrail/checksops-production-mgmt-events:* \
  --cloud-watch-logs-role-arn arn:aws:iam::806168576068:role/checksops-production-cloudtrail-cwlogs
```

Do **not** pass `--s3-bucket-name`, `--s3-key-prefix`,
`--is-multi-region-trail` / `--no-is-multi-region-trail`,
`--enable-log-file-validation` / `--no-enable-log-file-validation`,
or call `put-event-selectors`. Do not generate an IAM change to test the
metric filter.

---

## 4. IAM quota validation (design)

IAM enforces **6,144 characters** per customer-managed policy and
**10,240 characters aggregate** for **inline** policies on a role. This
role uses **zero** inline policies. Combined Allow+Deny compact size is
**10,327**, which **exceeds** 10,240, so the statements must not be pasted
as one inline policy.

Measured `JSON.stringify` sizes (pretty / compact / no-whitespace). All
three encodings of each **attached** policy are ≤ 6,144:

| Document | pretty | compact / noWs | Quota |
|---|---:|---:|---|
| `ChecksOpsCursorCtCwLogsAllow` | 6,094 | 4,537 | 6,144 customer-managed |
| `ChecksOpsCursorCtCwLogsDenyFinancial` | 2,358 | 1,746 | 6,144 customer-managed |
| `ChecksOpsCursorCtCwLogsDenyIam` | 5,321 | 4,120 | 6,144 customer-managed |
| Combined review JSON (do not attach) | 13,673 | 10,327 | exceeds 10,240 inline |
| Role inline policies | 0 | 0 | 10,240 aggregate inline |
| Managed policies on role | 3 |  | default 10 per role |
| Trust document pretty | 460 |  | 2,048 assume-role policy |

---

## 5. Exact one-time AWS Console action (done)

The Cursor role stack was created **2026-09-08**. Do **not** recreate it.
The follow-up stack `checksops-production-security-trail-cwlogs` is
**CREATE_COMPLETE**. Do **not** call `UpdateTrail` again unless a later
reviewed change is opened.

Historical role create: upload
`aws/production/cursor-cloudtrail-cwlogs-role.yaml`, stack name
`checksops-cursor-cloudtrail-cwlogs-role`, `CAPABILITY_NAMED_IAM`.

---

## 6. How Cursor assumes it

Existing mechanism only. No new OIDC provider. No static keys.

1. Cursor Cloud issues a web-identity token:
   `POST /run/cursor/api.sock` `/v1/tokens/oidc` body
   `{"aud":"sts.amazonaws.com"}`.
2. `aws sts assume-role-with-web-identity` against
   `arn:aws:iam::806168576068:role/ChecksOpsCursorCloudTrailCwLogsTemp`
   with that token, `--duration-seconds 3600`, session name
   `checksops-ct-cwlogs`.
3. Wrapper: `aws/cutover/scripts/assume-and-run.mjs`.

On the run that will execute the follow-up, set:

```bash
CURSOR_AWS_CLOUDTRAIL_CWLOGS_ROLE_ARN=arn:aws:iam::806168576068:role/ChecksOpsCursorCloudTrailCwLogsTemp
```

The wrapper checks that ARN **first**, then
`CURSOR_AWS_SECURITY_HARDENING_ROLE_ARN`, then
`CURSOR_AWS_ASSUME_IAM_ROLE_ARN` (`ChecksOpsCursorCloudStaging`).

Do **not** add `sts:AssumeRole` on `ChecksOpsCursorCloudStaging` or on
`ChecksOpsCursorSecurityHardeningTemp` to chain into this role. Do **not**
put a human IAM user in the trust.

Identity verification on 2026-09-08 assumed this session successfully.
The follow-up stack and single `UpdateTrail` are **PASS**. Stack delete
of this role is **BLOCKED** for Cursor operators; finish from a
privileged IAM principal.

---

## 7. Revoke / delete after follow-up PASS

After the CloudTrail → CloudWatch Logs follow-up is PASS-verified:

1. Unset `CURSOR_AWS_CLOUDTRAIL_CWLOGS_ROLE_ARN`. If the Cursor environment
   ARN was retargeted, restore `ChecksOpsCursorCloudStaging`.
2. Console **CloudFormation → stack `checksops-cursor-cloudtrail-cwlogs-role`
   → Delete**, or:

   ```bash
   aws cloudformation delete-stack --region us-east-1 \
     --stack-name checksops-cursor-cloudtrail-cwlogs-role
   ```

   That removes this Cursor role and its three managed policies only.
3. Confirm:
   `aws iam get-role --role-name ChecksOpsCursorCloudTrailCwLogsTemp`
   → `NoSuchEntity`.

**Do not delete** as part of revoke:

- Stack `checksops-production-security-trail-cwlogs`
- Role `checksops-production-cloudtrail-cwlogs`
- Log group `/aws/cloudtrail/checksops-production-mgmt-events`
- Metric filter `checksops-prod-iam-security-changes-filter`
- Trail `checksops-production-mgmt-events` (S3 delivery, multi-region,
  management selectors, `DataResources=[]` stay)
- Role `ChecksOpsCursorSecurityHardeningTemp` / stack
  `checksops-cursor-security-hardening-role`
- Bucket `checksops-production-security-logs-806168576068` or its policy
- CREATE_FAILED stack `checksops-production-security-trail`
- Live `#2`–`#6` detection resources

If CloudFormation delete is blocked, IAM → Roles →
`ChecksOpsCursorCloudTrailCwLogsTemp` → Delete role, then delete the three
customer-managed policies by name.

---

## 8. This role cannot activate financial / provider functionality

Money/provider execution is gated on Lambda environment flags
`AWS_MOOV_ENABLED`, `AWS_CHECKALT_ENABLED`,
`AWS_PROVIDER_EXECUTION_ENABLED`, and
`AWS_FINANCIAL_PERMISSIONS_ACTIVATED`, plus SQL
`64_financial_activation_grants.sql`.

This role:

- Has **Deny** on `lambda:UpdateFunctionConfiguration` and
  `lambda:UpdateFunctionCode`
- Has **no** `secretsmanager:GetSecretValue` (cannot read
  `checksops/staging/providers` or RDS secrets)
- Has **Deny** on `rds-data:*` and RDS modify/restore (cannot apply `64_`)
- Has **no** `iam:PassRole` on `checksops-production-api-execution`
- Has **Deny** on `sts:AssumeRole`
- Does not grant WAF, CloudFront, Cognito, or Route53 writes

Read-only `lambda:GetFunctionConfiguration` is allowed **only** to confirm
the four flags remain `false`.

---

## Holds (unchanged)

- **STOP FOR REVIEW.** Follow-up remains PASS. Temporary-role cleanup is
  **INCOMPLETE**. Do not clean up `security@checksops.com`. Do not deploy
  API-behind-CloudFront or financial activation.
- Do not modify `ChecksOpsCursorSecurityHardeningTemp`.
- Do not broaden `ChecksOpsCursorCloudStaging`.
- Do not use root, access keys, passwords, OTPs, or secrets.
- Do not modify application code, prep Lambda env/VPC/role, RDS data,
  Cognito, CloudFront, WAF, migration bridges, or staging.
- Do not enable Moov, CheckAlt, provider execution, or financial
  permissions. Do not apply `64_financial_activation_grants.sql`.
- Preserve the security-logs bucket and policy. Leave
  `checksops-production-security-trail` CREATE_FAILED untouched.
- Do not implement API-behind-CloudFront in this step.
- Do not call `put-event-selectors`. Do not create a second trail.
