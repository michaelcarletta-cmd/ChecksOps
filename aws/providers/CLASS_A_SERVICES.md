# AWS Staging — Class A final cleanup

**Status:** implemented on AWS staging API (this batch)  
**Non-goals:** Moov/CheckAlt/Plaid money movement, financial activation SQL, production Resend/Telnyx live delivery.

## Migrated this batch

- PDF/docs: `generate-document`, `generate-checksops-doc`, `generate-pol-docx`, `contracts-pdf`, `retry-pdf-generation`, `generate-invoice`, `generate-endorsement-packet`, `composite-endorsement-signatures`
- Email worker/webhooks: `process-email-queue`, `handle-email-suppression`, `resend-webhook` (dry-run)
- SMS: `send-sms` (sink), `telnyx-sms-status` (dry-run)
- Tenant admin: `tenant-invite-user`, `create-tenant-user`, `delete-user` (soft disable)
- Domain: `tenant-domain-verify`, `tenant-domain-check`, `tenant-domain-recheck-cron`
- OpenAI BYOK: `tenant-set/validate/remove-openai-key` → Secrets Manager
- `/h/upload` AWS OTP: `homeowner-upload-otp-start|verify|session` (no Supabase Auth)
- Scheduled: `POST /scheduled/class-a` (financial jobs denied)

## Staging safety

| Channel | Mode | Behavior |
|---|---|---|
| Email | `AWS_EMAIL_MODE=sink` | Rewrite to `staging-sink@checksops.invalid` |
| SMS | `AWS_SMS_MODE=sink` | Rewrite to `+15555550100`; audit only |

## Textract

See `TEXTRACT_PREREQUISITE.md` — **PASS** (live `aws_textract_analyze` on synthetic staging image; subscription blocker cleared).

## SQL

- `68_staging_class_a_grants.sql`
- `69_staging_class_a_final_grants.sql` (upload OTP/session tables + SECURITY DEFINER helpers)
