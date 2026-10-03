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

The file is a **single transaction** (`BEGIN` … `COMMIT`). If the preflight, unique
index, CHECK constraint, new columns, or rate-limit table fails, Postgres rolls
the whole change back. It does **not** delete, merge, or rewrite conflicting
`tenant_email_settings` rows.

Adds:

- Duplicate-domain preflight that raises listing only `normalized-domain (count)`
- Unique index on `lower(sending_domain)` where non-null
- `domain_status` values `verifying` and `disabled`
- `last_checked_at`, `ses_identity_name`, `custom_sending_enabled`,
  `mail_from_domain`, `mail_from_records`
- `tenant_email_action_rate_limits` for atomic per-tenant/user/action counters
- `public.consume_tenant_email_action_rate_limit(...)` SECURITY DEFINER function
  (owned by `checksops_admin`, `EXECUTE` only for `checksops`)

Runtime code degrades if SES metadata columns are missing. Mutating domain APIs
**fail closed** if the consume function is missing (they do not fall back to
in-memory as the security control, and they never DML the table directly). Do
not apply this file in this PR.

### Read-only sending-domain preflight

Run this before applying the unique index. It returns only normalized domains
and duplicate counts — no tenant names, emails, or other PII.

```sql
SELECT lower(btrim(sending_domain)) AS domain, count(*)::int AS count
FROM public.tenant_email_settings
WHERE sending_domain IS NOT NULL AND btrim(sending_domain) <> ''
GROUP BY 1
HAVING count(*) > 1
ORDER BY 1;
```

If this returns any rows, stop. Resolve duplicates with an explicit operator
decision. Do not auto-delete or merge.

## Durable rate limiting

Mutating and SES-check actions (`domain_start`, `domain_check`, `domain_save`,
`domain_disable`, `domain_delete`) call
`public.consume_tenant_email_action_rate_limit(tenant_id, user_id, action, limit, window_seconds)`.

That function is `SECURITY DEFINER`, `SET search_path = public, pg_temp`, owned
by the migration/admin role `checksops_admin`, revoked from `PUBLIC`, and
`GRANT EXECUTE` only to the staging API database role `checksops` (the Lambda
database user; never `checksops_admin`). It validates `p_user_id = auth.uid()`,
the fixed action enum, and positive bounded limit/window values, then consumes
the counter with `INSERT … ON CONFLICT` using Postgres `now()`. It returns only
`allowed`, `count`, and `retry_after_seconds` (no tenant/user identifiers).
`retry_after_seconds` is computed entirely from PostgreSQL timestamps.

`tenant_email_action_rate_limits` keeps RLS enabled with **no** policy for
`checksops` and **no** `SELECT`/`INSERT`/`UPDATE`/`DELETE` grants. It is **not**
in `aws/functions/api/allowed-tables.json`. The generic data API cannot read or
write it. An in-memory Map is only a same-instance deny cache and cannot grant a
request that the database would refuse. Missing function, permission, or
validation failures fail closed as `rate_limit_unavailable`.

## Fail-closed audit

Start, replace, save, verification status transitions, disable, and operator
SES identity deletion insert `audit_logs` in the **same database transaction**
as the settings change. If that insert fails, the handler returns
`audit_unavailable` and `withIdentity` rolls back. Get and preview do not
require audit. Payloads are a whitelist: normalized `sending_domain`,
`replaced`, and enum `result`. No DKIM tokens, From/Reply-To, recipients,
ARNs, account IDs, claims, or secrets.

## Feature flags (disabled defaults)

| Name | Default | Meaning |
| --- | --- | --- |
| `AWS_EMAIL_MODE` | `sink` | Mail goes through `sendViaSesOrSink()`. `ses-identity` enables live Create/Get EmailIdentity without SendEmail. `ses` additionally allows allowlisted SendEmail. |
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

1. Run the read-only sending-domain preflight query above. Stop if any duplicates exist.
2. Apply the additive migration in a dedicated, reviewed change (one transaction).
3. Set `AWS_TENANT_EMAIL_DOMAIN_ENABLED=true` only in the intended environment.
4. Attach the narrow SES identity IAM actions above.
5. Keep `AWS_EMAIL_MODE=sink` until identity or send-enablement is separately approved. Use `ses-identity` for domain verification without outbound send.
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
