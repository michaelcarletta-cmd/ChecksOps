# SECURITY HARDENING BATCH 5: PASS / FAIL

**Status:** pending live apply and validation.  
**STOP FOR REVIEW** after the live result is recorded.

Financial/provider activation remains **NOT AUTHORIZED**.
API-behind-CloudFront remains a **MUST FIX** before financial activation
and is **not** deployed here.

Incident playbook: `aws/cutover/INCIDENT_RESPONSE_AWS.md`

## Intended detection-only stack

CloudFormation `checksops-production-security-monitoring`
(`aws/production/security-monitoring.yaml`):

- GuardDuty detector (EBS malware **DISABLED**)
- Security Hub (findings; no auto-remediation of traffic)
- AWS Config recorder + delivery (change monitoring)
- CloudTrail multi-region **management events only**
- VPC Flow Logs on `vpc-09f2268778966ce97` (no payloads)
- SNS `checksops-production-security-alerts`
- CloudWatch alarms (Lambda/API/WAF/RDS/S3)

## Live result

Filled after `--confirm-batch5`.

**SECURITY HARDENING BATCH 5: pending**
