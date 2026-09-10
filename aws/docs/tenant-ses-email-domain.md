# Tenant SES email-domain branding

Status: **prepared, not deployed, SES not enabled.**

This document is the schema assessment, IAM note, and deployment prerequisites
for tenant-owned sending domains (example: `notify.freedomadj.com`).

ChecksOps remains the delivery platform. Cognito email, Moov, CheckAlt, Plaid,
financial authorization, authentication enforcement, and RLS are unchanged.

## Schema assessment (existing — reused)

### `public.tenant_email_settings`

Created in `supabase/migrations/20260702170935_d1dbaccf-e389-46c4-999c-e08af87f7355.sql`
plus `resend_domain_id` in `20260702172448_15605765-5285-442b-bf7d-f642ca1e7057.sql`.

| Column | Role |
| --- | --- |
| `tenant_id` | Unique per tenant |
| `from_name` | From display name |
| `reply_to` | Reply-To mailbox |
| `sending_mode` | `platform` \| `custom` |
| `provider` | Legacy `lovable` \| `resend` \| `mailgun` (not expanded in this PR) |
| `sending_domain` | Sending subdomain |
| `from_address` | Full From address |
| `domain_status` | `unverified` \| `pending` \| `verified` \| `failed` |
| `dns_records` | DKIM (and optional MAIL FROM) records for the UI |
| `verified_at` | Set only by server-side SES check |
| `last_verification_error` | Safe diagnostic for admins (no ARNs/credentials) |
| `resend_domain_id` | Legacy Resend; unused by AWS SES path |

**Gap:** `sending_domain` is not unique across tenants today. Application code
rejects duplicates; the proposed unique index is **not applied**.

### `public.tenants` branding (reused, not altered)

`name`, `logo_url`, `primary_color`, `email_from_name`, `email_from_address`,
`email_reply_to`.

## Proposed additive migration (NOT APPLIED)

File: `aws/migrations/proposed/NOT_APPLIED_20260910_tenant_email_ses_domain.sql`

Adds:

- Unique index on `lower(sending_domain)` where non-null
- `domain_status` values `verifying` and `disabled`
- `last_checked_at`, `ses_identity_name`, `custom_sending_enabled`,
  `mail_from_domain`, `mail_from_records`

Runtime code degrades if those columns are missing (CHECK / undefined_column
fallbacks). Do not apply this file in this PR.

## Feature flags (disabled defaults)

| Name | Default | Meaning |
| --- | --- | --- |
| `AWS_EMAIL_MODE` | `sink` | All mail still goes through `sendViaSesOrSink()` |
| `AWS_TENANT_EMAIL_DOMAIN_ENABLED` | `false` | When false, never construct a live SESv2 client |
| `AWS_SES_CONFIGURATION_SET` | empty | Prepared only; unused in sink mode |
| `AWS_TENANT_SES_IDENTITY_DELETE_ENABLED` | `false` | Operator-only SES identity deletion |
| `AWS_TENANT_MAIL_FROM_ENABLED` | `false` | Do not call PutMailFrom in v1 |

## IAM — do not add in this PR

Staging `aws/template.yaml` and `aws/production/api-execution-role.yaml` must
**not** gain SES permissions here.

When a later, separately approved deploy enables domain APIs, use **narrow**
actions (no `ses:*`):

| Action | When |
| --- | --- |
| `ses:CreateEmailIdentity` | Start verification |
| `ses:GetEmailIdentity` | Check verification |
| `ses:PutEmailIdentityMailFromAttributes` | Only if custom MAIL FROM is approved later |
| `ses:DeleteEmailIdentity` | Separate platform-operator cleanup path only |
| `ses:SendEmail` | Only after an explicit send-enablement approval |

Prefer identity-scoped resources such as
`arn:aws:ses:REGION:ACCOUNT:identity/notify.example.com` over `*`.
Keep send permission off the domain-verification role if operator separation
is available.

Never store AWS credentials, account IDs, or ARNs in `tenant_email_settings`
or return them to the frontend.

## Sending enforcement

Custom From is used only when **all** of the following are true:

1. `sending_mode = custom`
2. `domain_status = verified` (written only by the backend after SES success)
3. SES identity name matches stored `sending_domain`
4. `from_address` belongs to that verified domain (exact host, or a subdomain
   of a verified parent; a verified subdomain does **not** authorize the parent)
5. Custom sending is enabled (not disabled)

Otherwise the platform From is used. Tenant display name, logo, color, and
safe Reply-To are preserved. Recipients never see SES internals.

Fallback From while pending:

`{Tenant Name} via ChecksOps <noreply@checksops.com>`

Verified:

`{Tenant Name} <noreply@notify.tenantdomain.com>`

## Deliverability foundation (not activated)

- Configuration set name from `AWS_SES_CONFIGURATION_SET` (empty default)
- SES message tags: `tenant_id` (UUID) and `message_category` only
- Categories: `signature_request`, `endorsement_request`, `homeowner_link`,
  `stakeholder_verification`, `tenant_invite`, `payment_direction`
- Bounce / complaint / delivery interfaces exist in code only
- No SNS, EventBridge, or webhook subscription in this PR

## Deployment prerequisites (future — not this PR)

1. Apply the additive migration in a dedicated, reviewed change.
2. Confirm no duplicate `sending_domain` rows exist.
3. Set `AWS_TENANT_EMAIL_DOMAIN_ENABLED=true` only in the intended environment.
4. Attach the narrow SES identity IAM actions above.
5. Keep `AWS_EMAIL_MODE=sink` until send-enablement is separately approved.
6. Create/verify a ChecksOps SES configuration set, then set
   `AWS_SES_CONFIGURATION_SET` (still does nothing in sink mode).
7. Do not change Cognito email configuration.
8. Do not enable SNS bounce/complaint webhooks until a later PR.

## Confirmation for this PR

- No deployment
- SES remains disabled (`AWS_EMAIL_MODE=sink`, domain flag false)
- Tests inject a mock SESv2 client; no live SES calls
- No production template/role changes
- No financial, authentication, Cognito-email, Moov, CheckAlt, Plaid, or RLS changes
- No Supabase Edge Function or production Resend changes
