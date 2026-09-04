# AWS Staging — Class A Services (Email / OCR / HomeownerOps)

**Status:** implemented on AWS staging API (this batch)  
**Scope:** Replace Class A Supabase Edge Function invokes with AWS-native handlers.  
**Non-goals:** Moov / CheckAlt / Plaid money movement, financial activation SQL, production Resend.

## Email

| Item | Behavior |
| --- | --- |
| Mode | `AWS_EMAIL_MODE=sink` (default) or `ses` |
| Sink | All deliveries logged; destination rewritten to `AWS_EMAIL_SINK_ADDRESS` (default `staging-sink@checksops.invalid`) |
| Allowlist (ses mode) | Domains: `checksops.invalid`, `checksops.com`, `freedomadj.com` (+ `AWS_EMAIL_ALLOWLIST_DOMAINS`) |
| Exact allowlist | `staging-master@checksops.invalid`, `mcarletta@freedomadj.com`, `checksops-tester@freedomadj.com` |
| Production customers | Non-allowlisted recipients are **never** SES-delivered; rewritten to sink |
| Audit | `email_send_log` rows with provider `aws_staging` |

Functions: `send-email`, `send-transactional-email`, `preview-transactional-email`, `handle-email-unsubscribe`, notify wrappers, `send-portal-invite`, `send-file-to-homeowner`.

## OCR

| Item | Behavior |
| --- | --- |
| Engine | AWS Textract (`AnalyzeDocument`/`DetectDocumentText`) + heuristic field parse |
| Staging fallback | If Textract is not subscribed on the account, reparse restored `raw_ocr_front` JSON/text (`aws_stored_ocr_reparse`) |
| Functions | `check-ocr-intake`, `check-ocr-backlog`, `detect-endorsement-zone` |
| Commit | Prefers `ocr_commit_results`; falls back to descriptive intake columns (no amount) |
| Isolation | Image loaded from tenant-scoped S3 key after RLS check on `check_intake_items` |
| Ops note | Account `806168576068` currently returns Textract “subscription for the service” — enable Textract for live image OCR |

## HomeownerOps (non-financial)

| Function | Notes |
| --- | --- |
| `homeowner-ledger-view` | SECURITY DEFINER token lookup; money CTAs forced off |
| `homeowner-claim-portal` | get / upload_check / sign_dtp |
| `homeowner-ledger-upload` | Public upload → `homeowner-uploads` |
| `homeowner-upload-check` | Cognito session **or** lead `access_token` + email match; SECURITY DEFINER insert |
| `homeowner-ledger-sign-link` | Mints SHA-256 signer token for existing `/sign` flow |
| `homeowner-ledger-send` | Staff + staging-safe email |
| Deductible pay / bank link | **Still Class C / disabled** |

## Other Class A

`get-check-image-urls`, `public-contractor-directory`, `lookup-partner-code-public`.

## Still outstanding (Class A not fully ported)

Document generation PDF pack (`generate-*`), domain verify cron, tenant Cognito invite/delete, OpenAI key vault, geocode, JobNimbus, endorsement packet render, SMS, Resend/SES bounce webhooks, `process-email-queue` worker.

## Deploy notes

- Lambda env: `AWS_EMAIL_MODE=sink`
- IAM: `ApiFunctionRolePolicyClassA` (SES + Textract)
- SQL: `68_staging_class_a_grants.sql`
