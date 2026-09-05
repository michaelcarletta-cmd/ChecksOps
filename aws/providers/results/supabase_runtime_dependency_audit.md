# Supabase runtime dependency audit (AWS staging after Class A batch)

Scope: frontend + staging API path after PR #121. Production Supabase/Lovable paths intentionally retained.

## `supabase.functions.invoke`

| Dependency | Classification | Notes |
|---|---|---|
| Email send/transactional/unsubscribe/notifies/portal invite | **obsolete/removable on staging** | Routed to AWS Class A handlers (`AWS_EMAIL_MODE=sink`) |
| OCR intake / backlog / endorsement zone | **obsolete/removable on staging** | AWS Textract path + stored OCR fallback |
| Homeowner ledger/claim/upload/sign-link/send | **obsolete/removable on staging** | AWS public/token handlers; deductible pay remains Class C |
| get-check-image-urls / public directory / partner code | **obsolete/removable on staging** | AWS handlers |
| Moov / CheckAlt / Plaid money movement | **provider/financial dependent** | Must stay disabled |
| Stripe billing / tenant-checkout / usage report | **provider/financial dependent** | Keep disabled |
| QuickBooks / Zapier / DocuPost / e-sign vendor | **provider/financial dependent** (B) | Needs sandbox creds |
| Document PDF generators / endorsement packets | **still required temporarily** | Class A outstanding |
| tenant-invite-user / Cognito admin user ops | **still required temporarily** | Class A outstanding |
| passkey-* SimpleWebAuthn | **obsolete/removable on CheckOps staging** | Cognito WebAuthn; still used by WhiteLabel/MortgageOps surfaces |
| homeowner-deductible-pay | **provider/financial dependent** | Class C |

## Direct Supabase Storage

| Dependency | Classification | Notes |
|---|---|---|
| Staging SPA `/storage/*` S3 sign/upload | **AWS-native** | Prefer AWS; production still Supabase storage |
| `tenant-logos` / branding uploads via `supabase.storage` | **still required temporarily** / **production-only path** | Staging may still call client; expand AWS storage writes when needed |
| MortgageOps message attachments `supabase.storage` | **still required temporarily** | Bridge or port to `/storage/upload-url` |

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
| CheckOpsLogin EMAIL_OTP + passkeys | **obsolete/removable on staging** | Cognito (PR #126 PASS) |
| WhiteLabelLogin / MortgageOpsLogin | **obsolete/removable on staging** | Cognito EMAIL_OTP + WebAuthn + portal session isolation (PR #126 PASS) |
| `/h/upload` magic-link `signInWithOtp` | **obsolete/removable on staging** | AWS OTP functions (no Cognito SPA session) |
| MFA / step-up on financial surfaces | **production-only** / gated | Staging financial execution off; Cognito MFA remains OFF |

Cutover matrix: `aws/cutover/CUTOVER_READINESS_MATRIX.md`. Production SPA still uses `.env.production` Supabase Auth until an approved DNS/auth switch.

## Do not remove yet

Any production Supabase code path still used by Lovable production DNS/auth/storage/functions. Staging-only removals should wait until production cutover checklist items are complete.
