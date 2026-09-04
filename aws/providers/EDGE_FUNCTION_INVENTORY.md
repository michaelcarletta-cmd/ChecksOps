# AWS Staging — Edge Function Inventory (reclassification)

**Scope:** Remaining Supabase Edge Functions that surface as `provider_disabled` (or equivalent) on AWS staging.  
**Rule:** Do **not** enable something merely to improve the parity score. Preserve authorization and financial safety.

Classification:

| Class | Meaning |
| --- | --- |
| **A** | Ordinary application service — can be replaced now with AWS (API/Lambda/SES/etc.) |
| **B** | Requires external provider sandbox/UAT credentials + egress |
| **C** | Financial-sensitive — must remain disabled until financial activation |
| **D** | Production-only / not required in staging |
| **E** | Obsolete — can eventually be removed |

## A — Replace now with AWS (ordinary app services)

| Function | Current | AWS replacement needed |
| --- | --- | --- |
| `send-email` / `send-transactional-email` / `preview-transactional-email` / `process-email-queue` | `provider_disabled` | SES (or approved staging mailer) + queue worker Lambda; keep unsubscribe/suppression tables |
| `handle-email-unsubscribe` / `handle-email-suppression` / `resend-webhook` | stubbed | SES/SNS event handlers on AWS |
| `send-sms` / `telnyx-sms-status` | stubbed | Pinpoint/SNS or Telnyx staging credentials (if SMS required for UAT) |
| `check-ocr-intake` / `check-ocr-backlog` | stubbed | AWS Textract (or existing OCR vendor) Lambda — ordinary intake, not financial |
| `detect-endorsement-zone` | stubbed | Image/CV Lambda (Textract/Rekognition or existing model) |
| `generate-document` / `generate-checksops-doc` / `generate-pol-docx` / `contracts-pdf` / `retry-pdf-generation` / `generate-invoice` | stubbed | Document Lambda + S3 (no money movement) |
| `generate-endorsement-packet` / `composite-endorsement-signatures` | stubbed | Packet render Lambda writing to `endorsement-packets` S3 |
| `get-check-image-urls` | partial | Prefer existing `/storage/sign` — retire edge wrapper when UI fully on AWS storage client |
| `tenant-domain-check` / `tenant-domain-verify` / `tenant-domain-recheck-cron` | stubbed | Route53/ACM + API routes (already partially AWS-native elsewhere) |
| `tenant-invite-user` / `create-tenant-user` / `delete-user` / `get-instance-users` | stubbed | Cognito Admin APIs + `/data/write` membership (narrow) |
| `tenant-set-openai-key` / `tenant-validate-openai-key` / `tenant-remove-openai-key` | stubbed | Secrets Manager per-tenant secret + API (no provider money) |
| `notify-homeowner-lead` / `notify-homeowner-lead-accepted` / `notify-mortgage-handling-request` | stubbed | Same as email/SMS A-class once mailer exists |
| `lookup-partner-code-public` / `public-contractor-directory` / `contractor-directory-search` | stubbed | Public API Gateway routes + RLS-safe reads (already have some public workflow routes) |
| `ingest-shared-check` / `delete-shared-check` / `partner-shared-checks` / `partner-checks-by-claim` | stubbed/partial | Extend `/data` + workflow routes (non-financial share metadata) |
| `geocode-claim` / `geocode-claims-batch` / `fetch-aerial-image` | stubbed | Map provider sandbox **or** skip if not needed for staging UAT |
| `jobnimbus-search-match` / `push-status-to-freedom` | stubbed | CRM sandbox credentials (B if vendor required; A if mockable) |
| `passkey-*` (Supabase SimpleWebAuthn) | superseded | **Already replaced** by Cognito WebAuthn on CheckOps HTTPS staging |
| `auth-email-hook` | N/A on Cognito | **E** for staging Cognito path |
| `aws-staging-storage-bridge` | transitional | Keep until Storage client fully AWS; then **E** |

## B — Requires external provider sandbox / UAT

| Function | Notes |
| --- | --- |
| `quickbooks-auth` / `quickbooks-payment` | Intuit sandbox app + OAuth |
| `send-docupost` | DocuPost sandbox |
| `send-signature-request` / `submit-signature` / `get-signature-document` / `signature-webhook` | E-sign vendor sandbox (partial public routes already exist) |
| `onesx-products` | Vendor catalog sandbox |
| Moov sandbox read/status helpers once NAT + sandbox platform id exist | Still blocked by provider test configuration; execution remains gated |
| CheckAlt sandbox connection/test once sandbox credentials exist | Keep deposit **submit/approve** in **C** |
| Plaid sandbox link-token (non-transfer) | Link/read may be B; transfer/disburse stay **C** |

## C — Financial-sensitive (remain disabled)

| Area | Functions (representative) |
| --- | --- |
| Moov money movement | `moov-disburse`, `moov-transfer-create`, `moov-transfer-group-create`, `moov-wallet-fund`, `moov-tenant-fee-charge`, `moov-invoice`, `initiate-wallet-funding`, `cancel-wallet-funding`, `calculate-payment-funding`, `process-funded-payment`, `wallet-fund-on-clear`, `platform-treasury`, `moov-sweep-config`, fee schedule upsert/cancel, micro-deposits that move funds |
| CheckAlt deposit execution | `checkalt-submit-deposit`, `checkalt-approve-deposit`, `checkalt-register-account` (production-binding), live poll that mutates deposit state toward money movement |
| Plaid transfers | `plaid-disburse`, `plaid-exchange` (funding), `plaid-transfer-webhook` apply path |
| Billing charges | `tenant-checkout`, `tenant-credit-topup`, `tenant-maintenance-subscription`, `report-check-usage-to-stripe`, `tenant-billing-webhook`, `bill-mortgage-handling` (charges tenant) |
| Homeowner pay | `homeowner-deductible-pay`, `homeowner-bank-link-send` when it initiates ACH |

**Do not apply** `64_financial_activation_grants.sql`. Do not enable Moov/CheckAlt/Plaid production execution.

## D — Production-only / not required in staging

| Function | Notes |
| --- | --- |
| `storage-backup` / `glba-retention-purge` | Ops/cron against production retention policy |
| `deposit-daily-automation` | Production automation |
| `backfill-check-deposit-images*` / `backfill-check-images` / `backfill-mirrored-endorsements` | One-off prod backfills |
| `bootstrap-test-admin` | Dangerous in shared staging; prefer Cognito admin APIs |
| `setup-email-queue-secrets` | Ops bootstrap |
| Production Resend/Stripe live webhooks | Staging should use sandbox endpoints only when B is ready |

## E — Obsolete / eventually removable

| Function | Notes |
| --- | --- |
| Supabase `passkey-register-*` / `passkey-auth-*` on AWS staging CheckOps | Replaced by Cognito WebAuthn |
| `auth-email-hook` for staging Cognito users | Cognito EMAIL_OTP owns the path |
| Soft `organizations` / `organization_members` UI (`OrganizationSettings.tsx`) | **Table does not exist** in staging RDS (`relation "public.organizations" does not exist`). Dead UI path — do not invent a fake org admin model; prefer `tenants` / `tenant_users` |
| Duplicate storage bridge once SPA is 100% on `/storage/*` | Remove after cutover |

## HomeownerOps portals (special)

| Function | Class | AWS note |
| --- | --- | --- |
| `homeowner-claim-portal` | **A** (token public API) | Port to public API Gateway routes + RLS token tables; no Moov required for view |
| `homeowner-ledger-view` / `homeowner-ledger-send` / `homeowner-ledger-sign-link` | **A** view/send link; sign may be **B** | Send-link needs email (**A** mailer); signing vendor **B** |
| `homeowner-ledger-upload` / `homeowner-ledger-attach-upload` / `homeowner-upload-check` | **A** | Public upload → S3 `homeowner-uploads` + metadata writes (bucket already in storage write set) |
| `send-file-to-homeowner` / `send-portal-invite` | **A** after mailer | |

## Email / OCR guidance

Ordinary services such as **email** and **OCR** must **not** remain disabled merely because they were formerly Supabase Edge Functions. They are **A**: implement AWS replacements (SES + Textract/OCR Lambda). They are unrelated to Moov/CheckAlt/Plaid financial activation.

## Staging posture after this batch

- Master UAT login activated (identity mapping only).
- CashJobs + homeowner timeline **note** inserts allowlisted (no `amount`, no `cash_job_payments`).
- Provider/financial edge invokes remain `provider_disabled`.
- Next engineering batches should prioritize **A** mailer + OCR + HomeownerOps public routes before any **B/C** work.

## Staging posture after Class A batch

See `aws/providers/CLASS_A_SERVICES.md`.

Migrated to AWS handlers (invoke no longer `provider_disabled`):
email send/transactional/unsubscribe/notifies, OCR intake/backlog/zone, HomeownerOps ledger/claim/upload/sign-link/send/`homeowner-upload-check`, get-check-image-urls, public contractor directory, partner code lookup.

Still `provider_disabled` / deferred: Class B/C providers, document PDF generators, domain cron, tenant invite Cognito admin, SMS, SES bounce webhooks, `homeowner-deductible-pay`.

Routing: Class A dispatch runs **before** `handleProviderRequest` so unknown-provider stubs cannot shadow these routes.

## Staging posture after Class A final cleanup

See `aws/providers/CLASS_A_SERVICES.md`, `SCHEDULED_JOBS.md`, `TEXTRACT_PREREQUISITE.md`, `PROVIDER_CERTIFICATION_READINESS.md`.

Launch-relevant Class A ports complete for PDF, SMS sink, email queue, Cognito invite, domain check, `/h/upload` AWS OTP, and safe scheduled endpoint.
Financial/provider execution remains disabled. Textract requires account subscription enablement.
