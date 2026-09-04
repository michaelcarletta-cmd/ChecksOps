# Textract live-image prerequisite (account 806168576068)

## Exact blocker

```
SubscriptionRequiredException:
The AWS Access Key Id needs a subscription for the service
```

Observed from:
- Agent STS role `ChecksOpsCursorCloudStaging`
- Staging Lambda role `checksops-staging-ApiFunctionRole-*` (OCR intake)

## What is already ready

| Item | Status |
|---|---|
| IAM `textract:DetectDocumentText` / `AnalyzeDocument` / `AnalyzeExpense` / `AnalyzeID` | Present on `ApiFunctionRolePolicyClassA` |
| Lambda code path `check-ocr-intake` | Calls Textract first, then stored-OCR fallback |
| Tenant-scoped S3 image load + RLS | Implemented |
| Staging fallback | `aws_stored_ocr_reparse` works without Textract |

## Manual AWS step (console)

Cursor cannot safely complete marketplace/account enablement for this service.

1. Sign in to AWS account **806168576068** as an admin (not the Cloud Agent staging role).
2. Open **Amazon Textract** in **us-east-1**.
3. If prompted, **enable / subscribe** to Amazon Textract (first-time account activation / free tier enrollment).  
   Equivalent: AWS Console → Textract → Get started, or enable the service subscription that clears `SubscriptionRequiredException`.
4. Confirm a trivial `DetectDocumentText` call succeeds from the console or CloudShell.
5. Re-run staging OCR on a **non-production** check image (synthetic/staging-only object). Do **not** use production customer documents merely for testing.

## After enablement

No code deploy should be required if IAM + handler remain as shipped. Expected engine on live images: `aws_textract_analyze` or `aws_textract_detect`.
