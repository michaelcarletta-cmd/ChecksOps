# Supabase runtime dependency audit (AWS staging after Class A + PR #127)

Scope: frontend + staging API path after Cognito WhiteLabel/MortgageOps and data/storage rehearsal. Production Supabase/Lovable paths intentionally retained until cutover.

Authoritative cutover scorecard: `aws/cutover/FINAL_PRODUCTION_CUTOVER_RUNBOOK.md`.

## `supabase.functions.invoke`

| Dependency | Classification | Notes |
|---|---|---|
| Email send/transactional/unsubscribe/notifies/portal invite | **obsolete/removable on staging** | Routed to AWS Class A handlers (`AWS_EMAIL_MODE=sink`) |
| OCR intake / backlog / endorsement zone | **obsolete/removable on staging** | AWS Textract path + stored OCR fallback |
| Homeowner ledger/claim/upload/sign-link/send | **obsolete/removable on staging** | AWS public/token handlers; deductible pay remains Class C |
| `homeowner-ledger-attach-upload` | **still required temporarily** | Not in `CLASS_A_FUNCTIONS` |
| `ingest-shared-check` | **still required temporarily** | Not in `CLASS_A_FUNCTIONS` |
| `check-endorsement` (public token) | **AWS-native on staging** | `publicWorkflowApi` `/public/endorsement`; authenticated invoke still production Edge |
| get-check-image-urls / public directory / partner code | **obsolete/removable on staging** | AWS handlers |
| Document PDF generators / endorsement packets | **obsolete/removable on staging** | Class A handlers present |
| tenant-invite-user / hire-mortgage-agent / Cognito admin | **obsolete/removable on staging** | Class A Cognito admin |
| passkey-* SimpleWebAuthn | **obsolete/removable on AWS Cognito mode** | Cognito WebAuthn for CheckOps / WhiteLabel / MortgageOps |
| Moov / CheckAlt money movement | **provider/financial dependent** | Must stay disabled |
| Stripe billing / tenant-checkout / usage report | **provider/financial dependent** | Keep disabled |
| QuickBooks / Zapier / DocuPost / e-sign vendor | **provider/financial dependent** (B) | Needs sandbox creds |
| `send-signature-request` | **still required temporarily** | E-sign vendor |
| homeowner-deductible-pay | **provider/financial dependent** | Class C |
| Plaid / `moov-plaid-bridge` | **N/A — not a cutover requirement** | Keep `AWS_PLAID_ENABLED=false` |

## Direct Supabase Storage

| Dependency | Classification | Notes |
|---|---|---|
| Staging SPA `/storage/*` S3 sign/upload | **AWS-native** | Prefer AWS; production still Supabase storage |
| `tenant-logos` / branding uploads via `supabase.storage` | **AWS adapter on Cognito mode** / **production-only path** | |
| MortgageOps message attachments | **AWS adapter on Cognito mode** | |

## Direct Supabase database (`supabase.from`)

| Dependency | Classification | Notes |
|---|---|---|
| Most CheckOps reads/writes on staging | **obsolete/removable on staging** | Proxied via `/data/query` + `/data/write` when `VITE_AUTH_PROVIDER=cognito` |
| Production Lovable build | **production-only** | Keep until cutover |
| Soft `organizations` / `organization_members` UI | **obsolete/removable** | Table missing in staging RDS |

## Supabase realtime

| Dependency | Classification | Notes |
|---|---|---|
| Channel subscriptions | **still required temporarily** (noop on AWS) | Polling already used for some queues; realtime remains stub |

## Supabase auth

| Dependency | Classification | Notes |
|---|---|---|
| CheckOps / WhiteLabel / MortgageOps login | **obsolete/removable on staging** | Cognito EMAIL_OTP + WebAuthn |
| `/h/upload` OTP | **obsolete/removable on staging** | Dedicated AWS OTP functions (no Cognito SPA session) |
| MFA / TOTP / step-up on financial surfaces | **production-only** / gated | Staging financial execution off; Cognito MFA not provisioned |
| Production passkeys | **not migrated** | Users re-enroll on a future production Cognito pool |

## Do not remove yet

Any production Supabase code path still used by Lovable production DNS/auth/storage/functions. Staging-only removals should wait until the cutover runbook gates are complete.
