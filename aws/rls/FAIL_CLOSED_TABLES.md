# Fail-closed / platform-only table classification

SELECT policies for these tables are unchanged (`aws_is_cross_tenant_reader()` unless noted). This is the write/read classification for staging AWS. No USING(true) writes.

| Table | SELECT today | Proposed class | Writes |
| --- | --- | --- | --- |
| `checkalt_config` | platform-owner | **server-side API-only** | Contains webhook secret / JWT cache. Lambda after secret verify. Not browser. |
| `checkalt_webhook_events` | platform-owner | **server-side API-only** | Webhook ingest only. |
| `checkalt_deposits` | check/tenant join | **server-side API-only** | CheckAlt callback. |
| `checkalt_tenant_accounts` | tenant_id | **tenant-readable**; writes **API-only** | SSO/deposit account numbers. |
| `plaid_webhook_cursors` | platform-owner | **server-side API-only** | Cursor table. |
| `payment_webhook_events` | tenant_id | tenant-readable for ops; writes **API-only** | No authenticated write policy. |
| `payment_idempotency_keys` | tenant_id | **API-only writes** | No authenticated write policy. |
| `storage_backup_log` | platform-owner | **API-only** | Backup job. |
| `ai_response_cache` | platform-owner | **API-only** | Edge cache. |
| `tenant_partner_code_aliases` | platform-owner (has tenant_id) | **tenant-readable** after SELECT rewrite (future); writes tenant-admin | Current SELECT is fail-closed; do not open until reviewed. |
| `company_branding` | fallback platform-owner | **platform-owner-only** | Singleton, no `tenant_id`. Tenant-readable would leak Freedom letterhead to C1C. |
| `deposit_automation_settings` | fallback platform-owner | **platform-owner-only** | Key/value, no tenant key. |
| `deposit_provider_config` | fallback platform-owner | **server-side API-only** | Provider `config` JSON. |
| `deposit_automation_runs` / digests / escalation / snapshots / pending approvals / provider attempts | fallback platform-owner | **API-only writes**; SELECT platform-owner until tenant keys exist | No tenant_id in dump. |
| `email_send_state` / `email_unsubscribe_tokens` | fallback platform-owner | **API-only** | Email pipeline. |
| `homeowner_directory_leads` | fallback platform-owner | **API-only INSERT** | Original anon open INSERT. Capture via API. |
| `payment_methods` | fallback platform-owner | **inaccessible to normal users** until tenant-scoped | No tenant_id; `created_by` only. |
| `platform_announcements` / templates / `zip_geocache` / `mortgage_companies` | catalog authenticated SELECT | tenant-readable catalogs | Writes: platform-owner or API. |
| `signature_document_presets` | catalog SELECT | **API or platform-owner writes** | Original ALL USING(true) — do not restore. |

Normal authenticated tenant staff: **cannot** read CheckAlt secrets, Plaid cursors, provider config JSON, or singleton branding.
