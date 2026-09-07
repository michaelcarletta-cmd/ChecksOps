# ChecksOps production AWS incident response

**Authoritative for production AWS** (`806168576068`, `us-east-1`).  
Replaces the obsolete Supabase/Lovable-oriented plan in `docs/INCIDENT_RESPONSE.md` for AWS-hosted ChecksOps.

**Owner:** Qualified Individual — security@checksops.com  
**Do not** enable Moov, CheckAlt, provider execution, or financial execution from this playbook.  
**Do not** apply `64_financial_activation_grants.sql` during an incident.  
**Do not** delete migration bridges, rollback resources, or unused IAM roles without review.

Detection stack (Batch 5): CloudFormation `checksops-production-security-monitoring`
(`aws/production/security-monitoring.yaml`) — Config, CloudTrail (management
events), VPC Flow Logs, CloudWatch alarms.

Operator-only (agent IAM cannot tag/create these):
- GuardDuty + Security Hub: `aws/production/security-posture-services.yaml`
- SNS `checksops-production-security-alerts`: `aws/production/security-alerts-sns.yaml`

Existing live controls to keep: CloudFront WAF (COUNT managed rules + path
rate-limit BLOCK), API throttle 50/100, production CORS allow-list, Cognito JWT,
OPTIONAL MFA, privileged step-up policy, RLS, 300s view TTLs.

---

## 1. Severity

| Sev | Meaning | First action |
|---|---|---|
| 1 | Confirmed NPI/check-image/bank-data exposure, credential theft, or RDS compromise | Contain immediately; preserve logs |
| 2 | Likely account takeover, WAF/DDoS saturation, or suspicious S3 access | Contain + investigate |
| 3 | Failed login spike, GuardDuty low/medium, Config drift | Investigate; no traffic change |

Notify CEO + Legal within 24 hours for Sev 1/2. FTC within 30 days if ≥500
consumers' unencrypted NPI (16 CFR 314.5).

---

## 2. Evidence first

Before mutating IAM, S3, RDS, or Cognito:

1. Export CloudTrail (`s3://checksops-production-security-logs-806168576068/cloudtrail/` — live trail name after operator #1: `checksops-production-mgmt-events`; do not use poisoned CFN name `checksops-production-management`).
2. Export GuardDuty findings and Security Hub CRITICAL/HIGH.
3. Snapshot CloudWatch log groups:
   `/aws/lambda/checksops-production-prep-api`,
   `/aws/apigateway/checksops-production-prep-http`,
   `/aws/vpc/checksops-production-flow`.
4. Do **not** paste Authorization headers, signed URLs, bank fields, or tokens
   into tickets.

---

## 3. Credential compromise

Suspect: leaked AWS key, stolen Lambda role session, leaked Secrets Manager value,
or stolen SNS/bridge secret.

1. Identify principal in CloudTrail (`userIdentity.arn`, `accessKeyId`, `sourceIPAddress`).
2. If **IAM user access key**: deactivate the key (`iam:UpdateAccessKey`), do not
   delete until forensics finish.
3. If **assumed role** (`checksops-production-api-execution` or leftover staging
   roles): rotate any long-lived secret the role can read; do not delete the
   role (bridges/rollback).
4. Rotate **only** the compromised secret:
   - App DB: `rds-db-credentials/.../checksops` — coordinate downtime; Lambda
     uses this ARN.
   - Never rotate `checksops_admin` from the API Lambda.
   - Bridge token `checksops/staging/storage-migration-token` — rotate if that
     secret leaked; keep the bridge deployed.
5. Invalidate leaked Cognito tokens with `AdminUserGlobalSignOut` for the
   affected user only.
6. Confirm money flags still `false`. Do not turn providers on “to test.”

---

## 4. Database compromise

RDS `checksops-staging` is the live application database (`checksops`).
Backup retention **35 days**, storage encrypted, deletion protection **ACTIVE**,
latest restorable time is PITR.

1. Do not drop the instance. Do not disable deletion protection.
2. If active abuse: change the `checksops` password in Secrets Manager **and**
   RDS; Lambda picks up the secret on the next cold start (or recycle ENIs).
   Leave `checksops_admin` unused by the API.
3. Set `default_transaction_read_only=on` only if writes must stop; this breaks
   production writes — Sev 1 decision.
4. Restore options (operator):
   - PITR to a **new** instance (`restore-db-instance-to-point-in-time`) using
     a timestamp ≤ `LatestRestorableTime`.
   - Automated backup restore within 35 days.
5. Do not restore over the live instance. Do not apply
   `64_financial_activation_grants.sql` on the restored copy.
6. Reconcile with RLS still enabled. App role is `checksops` (no BYPASSRLS).

---

## 5. S3 / check-image exposure

Bucket: `checksops-staging-privatefilesbucket-erzqsolpucjp` (SSE-S3, PAB on,
BucketOwnerEnforced). View URLs are ≤300s; uploads 60s.

1. If a signed URL leaked: it expires ≤300s (signing PDF exception 1800s).
   Do not log the URL. Invalidate by waiting or rotating object if the object
   itself was copied.
2. If the **bucket policy** became public: restore PAB all-true and remove
   public statements. Do not make the bucket public “to debug.”
3. CloudFront does **not** origin this files bucket (SPA/S3 only). A leaked
   execute-api `/storage/sign` URL is the usual path.
4. Cross-tenant sign must stay 403. If a tenant can sign another tenant’s
   object: disable `/storage/sign` via a temporary 403 in Lambda **only** after
   evidence; prefer fixing RLS/auth. Do not disable the whole API.
5. Preserve S3 access logs / CloudTrail management events. Object data events
   are not enabled (avoid logging check-image keys).

---

## 6. Cognito / account takeover

Pool `us-east-1_h00WorYMT`. MFA **OPTIONAL**. Preferred MFA at login stays
**OFF**. First factors: EMAIL_OTP, PASSWORD, WEB_AUTHN. Staging pool
`us-east-1_vPmQ7cL1F` — do not modify.

1. Confirm `AdminGetUser` status (do not print email in public notes).
2. `AdminUserGlobalSignOut` the compromised username.
3. Reset TOTP only via existing admin-only `admin-reset-totp` (disable +
   sign-out). Do not set pool MFA to ON/REQUIRED (locks all users).
4. Do not call `/auth/mfa/set-preference` (stays 403).
5. Forgot-password / recovery is `verified_email` only. If mailbox is the
   attack: disable the Cognito user (`AdminDisableUser`) after sign-out.
6. Re-enable after mailbox recovery. Do not import users from staging.

---

## 7. WAF / DDoS / API abuse

CloudFront WAF `checksops-production-cloudfront-waf` is live. Managed rules
are **COUNT**. Path rate limits BLOCK `/auth` 100, `/storage` 300, `/public`
200 per 5 min/IP. API Gateway throttle **50 rps / 100 burst**.

1. Use WAF sampled requests + `BlockedRequests` / COUNT metrics. Do not flip
   managed groups from COUNT to BLOCK during an incident without a human
   review (false positives can take the site down).
2. For volumetric DDoS: keep CloudFront + WAF; do not disable the
   distribution. AWS Shield Standard is on CloudFront.
3. For execute-api flooding: throttle is already 50/100. API-behind-CloudFront
   is a **MUST FIX before financial activation** — do not implement it in an
   incident without the approved design.
4. Do not convert HTTP API `kiqojucc02` to REST to attach regional WAF.

---

## 8. Provider / payment compromise (providers stay OFF)

Live flags must remain:

- `AWS_MOOV_ENABLED=false`
- `AWS_CHECKALT_ENABLED=false`
- `AWS_PROVIDER_EXECUTION_ENABLED=false`
- `AWS_FINANCIAL_PERMISSIONS_ACTIVATED=false`

1. Verify `/ops/readiness` holds `ok: true` and `/financial/prepare` is 4xx.
2. If a flag was flipped: set it back to `false` on
   `checksops-production-prep-api` **environment only** (no full stack
   replace). Do not apply `64`.
3. Rotate `checksops/staging/providers` only if that secret leaked. Do not
   enable sandbox execution to “retest.”
4. Leave Moov/CheckAlt objects in place. Report-only reconcile later.

---

## 9. Backup / PITR recovery

| Setting | Required live value |
|---|---|
| Instance | `checksops-staging` (do not rename/delete) |
| Backup retention | **35 days** |
| PITR | `LatestRestorableTime` should be within minutes |
| Storage encryption | true |
| Deletion protection | ACTIVE |
| Multi-AZ | false (do not enable in an incident) |

Restore to a **new** instance. Point the app only after review. Do not
overwrite the live DB. Bridges stay deployed.

---

## 10. Alerting

SNS topic `checksops-production-security-alerts` is **operator-owned**.
The Cloud Agent role cannot create SNS (`sns:GetTopicAttributes` denied)
and cannot tag GuardDuty/Security Hub. Create the topic, confirm
`security@checksops.com`, then pass `AlertTopicArn` into the monitoring
stack. High-severity sources:

- GuardDuty findings (filter HIGH/CRITICAL)
- Security Hub CRITICAL/HIGH
- CloudWatch alarms: Lambda errors/throttles, API 4xx/5xx, WAF blocks,
  RDS storage/connections, S3 4xx on the files bucket
- Log filters `PrepApiErrorLogs`, `PrepHttp5xx`, `PrepAuthFailures`

Operator mailbox: `security@checksops.com`.

---

## 11. What this playbook must not do

- Enable money/provider flags or apply financial grants
- Deploy API-behind-CloudFront as an emergency change
- Delete leftover staging IAM roles or bridges
- Set Cognito MFA to REQUIRED
- FORCE RLS
- Broaden `ChecksOpsCursorCloudStaging`

Leftover roles from Batch 5 failed creates (**do not delete** without
review): `checksops-production-config-recorder` (needed for operator
Config), `checksops-production-vpc-flow-logs`,
`checksops-production-cloudtrail-logs`.

CREATE_FAILED stack `checksops-production-security-trail` owns
`checksops-production-security-logs-806168576068`. Delete only with
`--retain-resources SecurityLogsBucket,SecurityLogsBucketPolicy`.
