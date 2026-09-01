# Authoritative Live ChecksOps Source Inventory

Source: live Lovable/Supabase ChecksOps project queried directly through the connected Lovable database interface.

## Public schema object counts

- Base tables: 166
- Views: 20
- Materialized views: 0
- Sequences reported through information_schema: 0
- Public functions/routines: 960
- Public triggers: 211
- Public RLS policies: 380

The earlier reported count of 186 "public tables" is explained by 166 base tables + 20 views. There is no known 20-table data gap from that count discrepancy.

## Auth and storage counts

- auth.users: 9
- storage.objects: 1,335

No direct foreign-key constraints from public tables to auth.users were found in the live catalog query.

## Storage buckets

- ai-knowledge-base: 0
- claim-files: 1,184
- claim-files-backup: 0
- company-branding: 0
- contractor-documents: 0
- database_export_01_09_26: 1
- deposit-attachments: 0
- document-templates: 1
- email-assets: 1
- endorsement-packets: 125
- homeowner-uploads: 8
- loss-draft-documents: 2
- tenant-documents: 8
- tenant-logos: 5

Total storage objects: 1,335.

## Enabled extensions

- pg_cron 1.6.4
- pg_net 0.20.0
- pg_stat_statements 1.11
- pgcrypto 1.3
- pgmq 1.5.1
- pgsodium 3.1.8
- plpgsql 1.0
- postgis 3.3.7
- supabase_vault 0.3.1
- uuid-ossp 1.1
- vector 0.8.0

## Supabase-specific function dependencies found in public functions

- 40 functions reference auth.uid()
- 0 functions reference auth.jwt()
- 4 functions reference net.*
- 2 functions reference cron.*
- 5 functions reference vault/decrypted_secrets
- 5 functions reference pgmq.*

These functions must be classified before restore. Do not blindly restore Supabase-specific scheduling, network, vault, queue, or auth helper behavior into RDS.

Examples of affected operational functions include email queue/dispatch functions, file/status notification functions, session/tenant helpers, check/dashboard helpers, and vault bridge-secret functions.

## Migration implications

1. Treat the 166 base tables as the authoritative public table set for PostgreSQL schema/data migration.
2. Treat the 20 views separately and restore only after their dependencies are available.
3. Supabase Auth remains a separate Cognito migration phase; do not migrate password hashes/sessions/tokens.
4. Supabase Storage remains a separate S3 migration phase; preserve bucket/object mapping.
5. RLS policies should be extracted for analysis but not blindly applied on first RDS restore because many depend on Supabase auth semantics.
6. Supabase-specific extensions/functions using pg_net, pg_cron, pgmq, pgsodium/supabase_vault, or auth.uid() require transformation or replacement.
7. PostgreSQL-safe extensions such as pgcrypto, uuid-ossp, postgis, and vector should only be enabled on RDS if the live schema actually requires them and RDS supports the needed version.
8. Reconciliation must compare all 166 live base tables, plus critical financial/payment aggregates, before staging is considered valid.

## Safety

This inventory was read-only. No source database data or configuration was modified. No dump or restore was performed by this inventory step.
