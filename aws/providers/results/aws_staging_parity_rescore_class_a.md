# AWS Staging Parity Rescore — Class A services (email / OCR / HomeownerOps)

PR: #121 · Base: #120 master UAT rescore

| | Before (#120) | After (#121) | Δ |
|---|---:|---:|---:|
| PASS | 30 | 34 | +4 |
| PARTIAL | 22 | 24 | +2 |
| FAIL | 6 | 0 | -6 |
| P0 (open) | 0 | 0 | 0 |
| P1 (open) | 16 | 12 | -4 |
| P2 (open) | 12 | 10 | -2 |

Features audited: **58**

## Improved this batch

| Feature | Before | After | Note |
|---|---|---|---|
| OCR intake invoke | FAIL | PARTIAL | Class A route live; Textract account subscription missing — stored OCR JSON reparse works (`aws_stored_ocr_reparse`) |
| HomeownerClaimPortal | FAIL | PASS | Token portal `get` live; money CTAs forced off |
| HomeownerLedger token pages | FAIL | PASS | `homeowner-ledger-view` live (42 events); deductible pay still Class C |
| Homeowner check upload `/h/upload` | FAIL | PASS | `homeowner-upload-check` + S3 `homeowner-uploads`; magic-link OTP still Supabase-auth residual |
| QuickBooks / email sender / Zapier | FAIL | PARTIAL | Email sender Class A (sink); QB/Zapier still provider_disabled |
| Public directory | FAIL | PASS | `public-contractor-directory` live |

## Class A migrated (no longer `provider_disabled`)

Email: `send-email`, `send-transactional-email`, `preview-transactional-email`, `handle-email-unsubscribe`, notify wrappers, `send-portal-invite`, `send-file-to-homeowner`  
OCR: `check-ocr-intake`, `check-ocr-backlog`, `detect-endorsement-zone`  
HomeownerOps: `homeowner-ledger-view`, `homeowner-claim-portal`, `homeowner-ledger-upload`, `homeowner-ledger-sign-link`, `homeowner-ledger-send`, `homeowner-upload-check`  
Other: `get-check-image-urls`, `public-contractor-directory`, `contractor-directory-search`, `lookup-partner-code-public`

## Class A still outstanding

Document PDF generators (`generate-*`), domain verify cron, tenant Cognito invite/delete, OpenAI key vault, geocode, JobNimbus, endorsement packet render, SMS, SES bounce webhooks, `process-email-queue` worker.

## Remaining `provider_disabled` / financial

Moov / CheckAlt / Plaid execution · `homeowner-deductible-pay` · Stripe billing charges · deposit financial RPCs · `64_financial_activation_grants.sql` not applied.

## Email staging-safety

`AWS_EMAIL_MODE=sink` · gmail/yahoo recipients rewritten · `messageId` prefix `sink-` · `stagingMode=sink` / `sunk=true` · production Resend untouched.

## OCR / Textract

IAM `ApiFunctionRolePolicyClassA` present. Live Textract returns subscription error on account `806168576068`. Fallback reparse of restored `raw_ocr_front` JSON succeeds. Enable Textract subscription for live image OCR.

## HomeownerOps portal

Ledger token view PASS · claim portal PASS · upload PASS · wrong-email upload DENY 403 · `allow_deductible_payment=false`.

## RLS / cross-tenant

Spoof `x-tenant-id` ignored · OCR fake check → `check_not_found` · unauth email/OCR → 401 · upload email mismatch → 403.

## Still intentionally disabled

Moov / CheckAlt / Plaid money movement · production DNS/webhooks/auth · production data refresh.
