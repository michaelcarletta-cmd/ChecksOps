# SECURITY HARDENING BATCH 4: PASS / FAIL

**Status:** pending live apply and validation.  
**STOP FOR REVIEW** after the live result is recorded below.

Financial/provider activation remains **NOT AUTHORIZED**.
Moov, CheckAlt, provider execution, financial execution, and
`64_financial_activation_grants.sql` stay **OFF / NOT_APPLIED**.
API-behind-CloudFront is a later must-fix and is **not** deployed here.
Batch 1/2/3 controls, Cognito login, CloudFront WAF, and both migration
bridges are preserved.

## Intended mutations

| Change | Before | After |
|---|---|---|
| Authenticated check/document view TTL | clamp max 14400s; sign-many default 1800s; homeowner/docs 900s | **≤300s** |
| Upload URL TTL | 60s | 60s (unchanged) |
| Public signing document TTL | 14400s | **1800s** (signing-session exception) |
| FORCE RLS | off | evaluated; **not applied** unless proven safe |
| KMS CMK migration | SSE-S3 | evaluate only; do not rewrite historical objects |
| Money flags | OFF | OFF |

## Live result

Filled after `--confirm-batch4` apply and adversarial validation.

**SECURITY HARDENING BATCH 4: pending**
