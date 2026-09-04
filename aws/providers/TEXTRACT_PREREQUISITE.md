# Textract live-image readiness (account 806168576068)

## Status: **PASS** (verified 2026-09-04)

`SubscriptionRequiredException` is cleared. Live staging path confirmed:

**synthetic PNG → S3 `claim-files` → Textract `AnalyzeDocument` → ChecksOps `parseCheckFields` → descriptive DB commit**

## Verification evidence

| Check | Result |
|---|---|
| Engine | `aws_textract_analyze` |
| `SubscriptionRequiredException` | **gone** (`textract_error: null`) |
| Parsed fields | carrier `Synthetic Staging Mutual Insurance Company`, check `778899`, amount `1234.56`, claim `CLM-STAGING-7788`, payees split |
| DB descriptive commit | carrier / check_number / payee_line updated (T2 column grants) |
| Amount / ledger | **unchanged** (no amount write; no financial side effects) |
| Cross-tenant | C1C → Freedom check `check_not_found` / 0 visible rows |
| Image used | Synthetic only: `files/claim-files/checks/dc647a1f-…/synthetic-textract-live-verify-20260904.png` (`customer-doc=false`) |
| Moov / CheckAlt / Plaid / deposits | Still disabled (`provider_disabled` / `financial_job_disabled`) |

Artifact: `aws/providers/results/textract_live_verify_pass.json` (also `/opt/cursor/artifacts/textract_live_verify_pass.json`).

## What remains ready (unchanged)

| Item | Status |
|---|---|
| IAM `textract:DetectDocumentText` / `AnalyzeDocument` / `AnalyzeExpense` / `AnalyzeID` | Present on `ApiFunctionRolePolicyClassA` |
| Lambda `check-ocr-intake` | Textract first; stored-OCR fallback retained |
| Tenant-scoped S3 image load + RLS | Intact |
| OCR commit strategy | Descriptive T2 columns only (avoids `ocr_commit_results` amount/stage/payment writes) |

## Historical blocker (resolved)

```
SubscriptionRequiredException:
The AWS Access Key Id needs a subscription for the service
```

Resolved by account-level Textract enablement in **us-east-1** for account **806168576068**.
