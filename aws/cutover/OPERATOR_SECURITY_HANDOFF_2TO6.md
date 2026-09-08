# Security Hardening #2–#6 handoff — STOP FOR FINAL REVIEW: #6 PASS

**Date:** 2026-09-08  
**STOP FOR FINAL REVIEW.** `#1`–`#6` are **PASS**. Temporary role **not**
deleted. Stale `security@checksops.com` pending subscription **not**
cleaned up. Failed trail stack not touched.

Caller: `arn:aws:sts::806168576068:assumed-role/ChecksOpsCursorSecurityHardeningTemp/checksops-sec-hard`

## SNS confirmation (gate)

| Endpoint | State | ARN |
|---|---|---|
| `support@checksops.com` | **Confirmed** (`PendingConfirmation=false`) | `…:f9200315-a38c-4b3d-ace0-074b7aa143ae` |
| `security@checksops.com` | still `PendingConfirmation` (untouched) | `…:5365a46f-f2cd-4af0-b21e-00222be734b5` |

Topic unchanged:
`arn:aws:sns:us-east-1:806168576068:checksops-production-security-alerts`

## #6 CloudWatch alarms — PASS

| Field | Value |
|---|---|
| Stack | `checksops-production-security-alarms` |
| Status | **CREATE_COMPLETE** |
| Stack ID | `arn:aws:cloudformation:us-east-1:806168576068:stack/checksops-production-security-alarms/40d62960-ab70-11f1-a0e9-0e876cfcd65b` |
| `AlertTopicArn` | existing security alerts topic (exact) |
| Alarm count | **14 / 14** |
| `ActionsEnabled` | `true` on all 14 |
| `AlarmActions` | existing topic on all 14 |
| `TreatMissingData` | `notBreaching` on all 14 |

| Alarm | State | Threshold / dimensions |
|---|---|---|
| `checksops-prod-lambda-errors` | INSUFFICIENT_DATA | Errors ≥ 5; `checksops-production-prep-api` |
| `checksops-prod-lambda-throttles` | INSUFFICIENT_DATA | Throttles ≥ 1; same Lambda |
| `checksops-prod-api-5xx` | INSUFFICIENT_DATA | 5xx ≥ 20; `kiqojucc02` / `prep` |
| `checksops-production-http-api-5xx-from-logs` | INSUFFICIENT_DATA | PrepHttp5xx ≥ 20 |
| `checksops-production-http-api-auth-failures` | INSUFFICIENT_DATA | PrepAuthFailures ≥ 80 |
| `checksops-prod-iam-security-changes` | INSUFFICIENT_DATA | IamSecurityChanges ≥ 1 |
| `checksops-prod-api-4xx` | INSUFFICIENT_DATA | 4xx ≥ 200; `kiqojucc02` / `prep` |
| `checksops-prod-cognito-signin-throttles` | INSUFFICIENT_DATA | ≥ 20; pool `us-east-1_h00WorYMT` client `3ja9fqaq2fjkv3i6up2varcqpe` |
| `checksops-prod-waf-blocked` | INSUFFICIENT_DATA | BlockedRequests ≥ 50; `checksopsProductionCloudFrontWaf` |
| `checksops-prod-waf-counted` | OK | CountedRequests ≥ 200; same WAF metric |
| `checksops-prod-rds-free-storage` | INSUFFICIENT_DATA | FreeStorageSpace < 10 GiB; `checksops-staging` |
| `checksops-prod-rds-connections` | INSUFFICIENT_DATA | DatabaseConnections ≥ 80 |
| `checksops-prod-rds-cpu` | INSUFFICIENT_DATA | CPUUtilization ≥ 90 over 2 periods |
| `checksops-prod-s3-files-4xx` | OK | 4xxErrors ≥ 50; `checksops-staging-privatefilesbucket-erzqsolpucjp` |

INSUFFICIENT_DATA immediately after create is acceptable.

## Regression #1–#5 — PASS

| # | Check | Result |
|---|---|---|
| 1 | CloudTrail `checksops-production-mgmt-events` | logging, multi-region, validation on, management All, `DataResources=[]`, exactly one trail |
| 3 | Config `checksops-production-config-items` | `recording: true`, `lastStatus: SUCCESS`, history delivery SUCCESS, prefix `config/` |
| 4 | GuardDuty `298dc17133dd46b1b2cf755bc1380e1f` | ENABLED, `FIFTEEN_MINUTES`, EBS malware DISABLED |
| 4 | Security Hub | `arn:aws:securityhub:us-east-1:806168576068:hub/default` |
| 5 | Flow log `fl-0913268bc96a95205` | ACTIVE, `DeliverLogsStatus=SUCCESS` |
| — | Security-logs PAB | all four Block/Ignore/Restrict **true** |
| — | Bucket policy SHA-256 | `3eda5eb41fbfa49985ab0a49ae0561c1f62494a006f4a21d5be9b2b7c8f33ffd` (unchanged) |
| — | RDS `checksops-staging` | backup 35 days, deletion protection on |
| — | Smoke | `/health` 200, `/ops/readiness` 200 `holds.ok=true`, `/financial/status` 200 |
| — | Flags | all four provider/financial execution flags **false**; `productionExecution=false` |
| — | `64_financial_activation_grants.sql` | **NOT_APPLIED** (`financialActivationSqlApplied=false`) |

## Holds (not done)

- Temporary role `ChecksOpsCursorSecurityHardeningTemp` kept
- Stale `security@` pending subscription kept
- Trail stack `checksops-production-security-trail` not touched
- No API-behind-CloudFront
- No RDS secret rotate, no KMS CMK / FORCE RLS
- No Moov/CheckAlt/provider/financial enablement
- No financial grants

## Warnings

- `IamSecurityChanges` stays quiet until CloudTrail is also delivered to CloudWatch Logs (not in `#1`).
- S3 files 4xx alarm is already `OK` (request metrics present). Template note still applies if those metrics are later removed.
- WAF `ListWebACLs` is denied on this role. Live `checksops-prod-waf-counted=OK` confirms the template metric name `checksopsProductionCloudFrontWaf` is receiving data.
- `/financial/status` still reports `apiBehindCloudFrontRequiredBeforeFinancial: true`.

## Proposed follow-up (not deployed)

CloudTrail → CloudWatch Logs for `IamSecurityChanges`. Template:
`aws/production/security-cloudtrail-cwlogs.yaml`. Do **not** modify
`ChecksOpsCursorSecurityHardeningTemp` (cannot `UpdateTrail`). Separate
role `ChecksOpsCursorCloudTrailCwLogsTemp` exists (identity PASS). See
`aws/cutover/OPERATOR_CLOUDTRAIL_CWLOGS_ROLE.md`. Do **not** deploy the
follow-up until reviewed.
