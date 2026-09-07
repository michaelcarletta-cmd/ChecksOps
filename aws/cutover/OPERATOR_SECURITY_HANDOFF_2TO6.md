# Security Hardening #2–#6 handoff — STOP after #5 PASS

**Date:** 2026-09-07  
**STOP FOR REVIEW.** `#5` VPC Flow Logs is **PASS**. Temporary role
**not** deleted. Trail stack left `CREATE_FAILED`. Money flags remain
**false**. `64_` remains **NOT_APPLIED**. **#6 not started.**

Caller: `arn:aws:sts::806168576068:assumed-role/ChecksOpsCursorSecurityHardeningTemp/checksops-sec-hard`

## Gates

| Check | Result |
|---|---|
| `GetCallerIdentity` is the temp role | **PASS** |
| Moov / CheckAlt / Provider / Financial | All **false** |
| `64_financial_activation_grants.sql` | **NOT_APPLIED** |

## Deployments

| # | Service | Result |
|---|---|---|
| 1 | CloudTrail | **PASS**. Still logging. |
| 2 | SNS | **PASS**. Email still `PendingConfirmation`. |
| 3 | AWS Config | **PASS**. Still `recording: true`, `lastStatus: SUCCESS`. |
| 4 | GuardDuty + Security Hub | **PASS**. Detector `298dc17133dd46b1b2cf755bc1380e1f` ENABLED. Hub enabled. |
| 5 | VPC Flow Logs | **PASS**. Stack `checksops-production-security-flow` `CREATE_COMPLETE`. |
| 6 | CloudWatch alarms | **NOT STARTED** |

## #5 evidence

| Item | Value |
|---|---|
| Stack | `checksops-production-security-flow` `CREATE_COMPLETE` |
| FlowLogId | `fl-0913268bc96a95205` |
| FlowLogStatus | `ACTIVE` |
| DeliverLogsStatus | `SUCCESS` |
| ResourceId | `vpc-09f2268778966ce97` |
| TrafficType | `ALL` |
| Destination | CloudWatch Logs `/aws/vpc/checksops-production-flow` |
| Retention | 90 days |
| MaxAggregationInterval | 600 |
| IAM role | `checksops-production-vpc-flow-logs` trusts only `vpc-flow-logs.amazonaws.com` |
| Log delivery | ENI/NAT streams present with `lastIngestionTime` (e.g. `eni-03224d8d3e5c575b1-all`) |
| Format | 5-tuple + packets/bytes/action only (no payloads) |

`logs:FilterLogEvents` is denied on the temp role (expected; not
broadened). Stream metadata is enough to show ingestion.

## Holds

- Trail stack still `CREATE_FAILED`
- Bucket policy SHA-256 unchanged `3eda5eb41fbfa499…`; PAB all-block
- No staging / app / Cognito / CloudFront / WAF / DNS / RDS change
- Public `/` `/login` `/endorse` `/sign` and API `/health` `/db-health`
  `/ops/readiness` `/financial/status` 200; `productionExecution` false
- Temp role kept
