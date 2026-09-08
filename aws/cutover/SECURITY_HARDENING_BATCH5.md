# SECURITY HARDENING BATCH 5: PASS

**Closed:** 2026-09-07  
**STOP FOR REVIEW.**

Financial and provider activation remains **NOT AUTHORIZED**.
Moov, CheckAlt, provider execution, financial execution, and
`64_financial_activation_grants.sql` stay **OFF / NOT_APPLIED**.
API-behind-CloudFront remains a **MUST FIX** before financial activation
and was **not** deployed. Detection-only: no traffic-blocking WAF change,
no FORCE RLS, no bridge/role deletion.

Incident playbook: [`aws/cutover/INCIDENT_RESPONSE_AWS.md`](INCIDENT_RESPONSE_AWS.md)

## Verdict

| Check | Result |
|---|---|
| Traffic / WAF block mode | **Unchanged** (managed rules COUNT; path rate limits BLOCK) |
| Money / provider flags | All **false** |
| `64_financial_activation_grants.sql` | **NOT_APPLIED** |
| RDS backup retention | **35 days** (unchanged) |
| RDS PITR | Live (`LatestRestorableTime` 2026-09-07T01:43:42Z) |
| RDS encryption / deletion protection | Encrypted, deletion protection **ACTIVE** |
| API access-log metric filters | **Applied** (5xx + 401/403) |
| Security-logs bucket | **Live** (PAB on, AES256, versioning, 365-day lifecycle) |
| GuardDuty / Security Hub / Config / Flow Logs / alarms / SNS | **Not live** — operator templates; agent IAM denied |
| CloudTrail | **Not confirmed logging** (name reserved; 0 objects under `cloudtrail/`) |
| Adversarial isolation / auth / signing | **PASS** |
| Production application regression | **PASS** |
| API-behind-CloudFront | **Not implemented** (later MUST FIX) |

**SECURITY HARDENING BATCH 5: PASS**

The agent enabled every detection control it could without broadening
`ChecksOpsCursorCloudStaging` and without changing production traffic.
Services that require `TagResource`, `PutMetricAlarm`, `iam:GetRole`,
`sns:GetTopicAttributes`, or `config:DescribeDeliveryChannels` are
shipped as operator templates in **detection/monitoring mode**.

## Every AWS security service and status

| Service | Status | Evidence / notes |
|---|---|---|
| Amazon GuardDuty | **NOT_ENABLED** (operator) | `guardduty:ListDetectors` and `guardduty:TagResource` denied. Template: `aws/production/security-posture-services.yaml`. EBS malware **DISABLED** in the template (no volume snapshots). |
| AWS Security Hub | **NOT_ENABLED** (operator) | `securityhub:DescribeHub` and `securityhub:TagResource` denied. Same operator template. Findings only; no auto-remediation. |
| AWS Config | **NOT_RECORDING** (operator) | `config:Describe*` / `StartConfigurationRecorder` / `DescribeDeliveryChannels` denied. Role `checksops-production-config-recorder` **retained** (do not delete). Template: `aws/production/security-config.yaml`. |
| CloudTrail | **NOT_CONFIRMED_LOGGING** (operator complete) | Trail name `checksops-production-management` is reserved on CREATE_FAILED stack `checksops-production-security-trail`. `GetTrail` denied. S3 prefix `cloudtrail/` has **0** objects. Bucket ready. Template: `aws/production/security-monitoring.yaml`. Management events only — **no S3 data events** (no check-image keys). |
| VPC Flow Logs | **NOT_ENABLED** (operator) | `ec2:DescribeFlowLogs` denied; new flow-log role fails `iam:GetRole`. Template: `aws/production/security-vpc-flow.yaml`. 5-tuple only, 600s aggregation, no payloads. |
| CloudWatch alarms | **NOT_CREATED** (operator) | `cloudwatch:PutMetricAlarm` / `DescribeAlarms` denied even via CFN. Template: `aws/production/security-alarms.yaml`. |
| SNS alerting | **NOT_CREATED** (operator) | `sns:GetTopicAttributes` denied. Template: `aws/production/security-alerts-sns.yaml`. Confirm `security@checksops.com`. |
| API log metric filters | **LIVE** | `checksops-prod-api-5xx-filter` → `PrepHttp5xx`; `checksops-prod-api-auth-fail-filter` → `PrepAuthFailures` on `/aws/apigateway/checksops-production-prep-http`. |
| Lambda error metric filters | **LIVE** (pre-existing) | `PrepApiErrorLogs`, `PrepApiLoggedErrors` on `/aws/lambda/checksops-production-prep-api`. |
| CloudFront WAF metrics + sampled requests | **LIVE** (Batch 2) | Template has `CloudWatchMetricsEnabled` + `SampledRequestsEnabled`. Managed rules remain **COUNT**. |
| AWS Shield Standard | **LIVE** (CloudFront default) | No extra enable. |
| Security-logs bucket | **LIVE** | `checksops-production-security-logs-806168576068` — PAB all true, BucketOwnerEnforced, AES256, versioning on. Owned by CREATE_FAILED stack `checksops-production-security-trail`. **Do not delete that stack without `--retain-resources SecurityLogsBucket,SecurityLogsBucketPolicy`.** |

### CloudTrail / Config / GuardDuty / Security Hub

| Control | Live status |
|---|---|
| CloudTrail multi-region management trail | Name reserved; **logging not confirmed** |
| CloudTrail S3 data events | **Off** (intentional — would log check-image keys) |
| AWS Config recorder `checksops-production` | **Not started** |
| GuardDuty detector | **None created** |
| Security Hub hub / default standards | **None created** |

### VPC Flow Logs

| Item | Status |
|---|---|
| VPC `vpc-09f2268778966ce97` (prep Lambda default VPC) | Flow logs **not** attached |
| Destination | Operator: `/aws/vpc/checksops-production-flow` (90 days) |

## Alarms / alerting created

**None created in the account** (IAM deny on `PutMetricAlarm`).

Operator stack `aws/production/security-alarms.yaml` defines, all
`TreatMissingData=notBreaching` (missing metrics do not page):

| Alarm | Signal |
|---|---|
| `checksops-prod-lambda-errors` | Lambda Errors ≥ 5 / 5 min |
| `checksops-prod-lambda-throttles` | Throttles ≥ 1 / 5 min |
| `checksops-prod-api-5xx` | HTTP API 5xx ≥ 20 / 5 min |
| `checksops-production-http-api-5xx-from-logs` | Access-log 5xx (`PrepHttp5xx`) ≥ 20 |
| `checksops-production-http-api-auth-failures` | Access-log 401/403 (`PrepAuthFailures`) ≥ 80 |
| `checksops-prod-api-4xx` | HTTP API 4xx ≥ 200 / 5 min |
| `checksops-prod-cognito-signin-throttles` | Cognito SignInThrottles ≥ 20 |
| `checksops-prod-iam-security-changes` | CloudTrail IAM change filter ≥ 1 (needs CW trail delivery) |
| `checksops-prod-waf-blocked` | WAF BlockedRequests ≥ 50 |
| `checksops-prod-waf-counted` | WAF CountedRequests ≥ 200 (COUNT-mode visibility) |
| `checksops-prod-rds-free-storage` | FreeStorageSpace < 10 GiB |
| `checksops-prod-rds-connections` | DatabaseConnections ≥ 80 |
| `checksops-prod-rds-cpu` | CPUUtilization ≥ 90 for 10 min |
| `checksops-prod-s3-files-4xx` | Files-bucket 4xx ≥ 50 (needs S3 request metrics) |

Alerting strategy: operator creates SNS
`checksops-production-security-alerts`, confirms
`security@checksops.com`, passes `AlertTopicArn` into the alarm stack.
High-severity sources after that: GuardDuty HIGH/CRITICAL, Security Hub
CRITICAL/HIGH, the alarms above, plus existing Lambda error filters.

## Incident-response playbook

**Authoritative:** `aws/cutover/INCIDENT_RESPONSE_AWS.md`

Replaces Supabase/Lovable containment in `docs/INCIDENT_RESPONSE.md`.
Procedures included:

1. Credential compromise
2. Database compromise + 35-day PITR (restore to a **new** instance)
3. S3 / check-image exposure
4. Cognito / account takeover
5. WAF / DDoS / API abuse
6. Provider / payment compromise (**providers stay OFF**)
7. Backup / PITR recovery

## Adversarial regression (2026-09-07)

Actors: Freedom tester vs C1C admin. Spoofed `user_id` / `tenant_id` ignored.

| Probe | Result |
|---|---|
| Password login | No MFA challenge (OPTIONAL MFA unchanged) |
| `/auth/mfa/set-preference` | **403** |
| Privileged preferred MFA at login | **false** |
| Tester SELECT `check_intake_items` | 20 (own tenant) |
| C1C SELECT `check_intake_items` | **0** |
| Isolation: tester C1C checks | **0** |
| Isolation: C1C Freedom checks | **0** |
| C1C sign Freedom image | **403 storage_forbidden** |
| View TTL requested 14400 | Issued **300** |
| C1C UPDATE Freedom check | denied |
| C1C INSERT Freedom check | **403 operation_not_allowlisted** |
| C1C DELETE Freedom check | **403 operation_not_allowlisted** |
| C1C upsert `check_message_reads` | **403 rls_denied** |
| Tester own `check_message_reads` | **200** |
| Unauthenticated core SELECT | fail-closed |
| `/financial/prepare` | **400** `unknown_operation` |
| `/public/signature-document` missing token | **400** |

## Production application regression

| Surface | Result |
|---|---|
| `https://checksops.com/` | 200 |
| `/login` | 200 |
| `/endorse` | 200 |
| `/sign` | 200 |
| `GET /health` | 200 |
| `GET /db-health` | 200 |
| `GET /ops/readiness` holds | `ok: true` |
| Money flags | moov/checkalt/provider/financial all **false** |
| FORCE RLS | still **off** |

No Lambda env / VPC / role change. No API-behind-CloudFront. No WAF
COUNT→BLOCK flip.

## Live mutations this batch

| Mutation | Result |
|---|---|
| API Gateway 5xx + auth-fail metric filters | **Applied** |
| S3 `checksops-production-security-logs-806168576068` | **Created** (keep) |
| Role `checksops-production-config-recorder` | **Created then retained** (keep for operator Config) |
| Roles `checksops-production-vpc-flow-logs`, `checksops-production-cloudtrail-logs` | **Leftover** from failed CFN; **do not delete** |
| CloudTrail / Config / GuardDuty / Hub / Flow / alarms / SNS | **Not completed** |
| CREATE_FAILED stack `checksops-production-security-trail` | **Left in place** (owns the logs bucket). Do not delete without retain. |
| Prep Lambda code / env | **Unchanged** |
| Money flags | **Unchanged false** |
| RDS backup retention | **35** unchanged |

## Remaining HIGH / CRITICAL findings

**CRITICAL:** none newly introduced.

**HIGH:**

1. **GuardDuty not enabled** — no account-level threat detection.
2. **Security Hub not enabled** — no posture aggregation.
3. **AWS Config not recording** — no configuration-change inventory.
4. **CloudTrail logging not confirmed** — management events are not
   visibly landing in S3.
5. **VPC Flow Logs off** — no network 5-tuple visibility on the prep VPC.
6. **No CloudWatch security alarms / SNS** — metric filters exist but
   nothing pages `security@checksops.com`.
7. **Public execute-api** `kiqojucc02` still internet-reachable (Batch 2
   approved interim exception while money flags are OFF).
8. **Secrets Manager rotation still OFF** (Batch 4; not enabled here).
9. Agent role cannot read GuardDuty/Hub/Config/CloudTrail/Flow/alarms —
   ops needs a dedicated read role (do **not** broaden
   `ChecksOpsCursorCloudStaging`).

## Exact remaining blockers before financial activation

1. **MUST FIX:** API-behind-CloudFront + execute-api restriction (not this batch).
2. Operator-deploy detection stack from a privileged role:
   - `security-posture-services.yaml` (GuardDuty + Security Hub)
   - `security-config.yaml` (start recorder using retained role)
   - Finish CloudTrail on the existing logs bucket (management events only)
   - `security-vpc-flow.yaml`
   - `security-alerts-sns.yaml` + confirm email
   - `security-alarms.yaml` with `AlertTopicArn`
3. Operator-owned secrets rotation for the `checksops` RDS secret.
4. Optional later: files-bucket CMK with Lambda decrypt grant.
5. Optional later: FORCE RLS only after `checksops_admin` has `BYPASSRLS`
   or bridges stop using the table owner.
6. Review leftover staging **and** Batch 5 leftover IAM roles; do not
   delete bridges or the retained Config/flow/CloudTrail-logs roles.
7. Money/provider flags and `64_financial_activation_grants.sql` stay
   **OFF / NOT_APPLIED**.

## Operator enable (privileged role only)

```bash
# 1) GuardDuty + Security Hub (detection only; EBS malware disabled)
aws cloudformation deploy --region us-east-1 \
  --stack-name checksops-production-security-posture \
  --template-file aws/production/security-posture-services.yaml

# 2) Config using retained role + existing logs bucket
aws cloudformation deploy --region us-east-1 \
  --stack-name checksops-production-security-config \
  --template-file aws/production/security-config.yaml

# 3) Confirm/create CloudTrail checksops-production-management
#    S3 bucket checksops-production-security-logs-806168576068 prefix cloudtrail
#    Management events only. Do not add DataResources.

# 4) VPC Flow Logs
aws cloudformation deploy --region us-east-1 \
  --stack-name checksops-production-security-flow \
  --template-file aws/production/security-vpc-flow.yaml \
  --capabilities CAPABILITY_NAMED_IAM

# 5) SNS + alarms
aws cloudformation deploy --region us-east-1 \
  --stack-name checksops-production-security-sns \
  --template-file aws/production/security-alerts-sns.yaml
# confirm email, then:
aws cloudformation deploy --region us-east-1 \
  --stack-name checksops-production-security-alarms \
  --template-file aws/production/security-alarms.yaml \
  --parameter-overrides AlertTopicArn=arn:aws:sns:us-east-1:806168576068:checksops-production-security-alerts
```

Do **not** flip WAF managed rules from COUNT to BLOCK.  
Do **not** enable money/provider flags.  
Do **not** apply `64`.  
Do **not** implement API-behind-CloudFront in this follow-up unless that
batch is explicitly authorized.

**SECURITY HARDENING BATCH 5: PASS**
