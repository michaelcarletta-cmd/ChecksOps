# Trigger reconciliation (live 211 vs restored 164)

The approved backup is authoritative. Public triggers were **not** dropped by the restore filter.

## Counting mismatch, not missing objects

| Source | Count | What it counts |
| --- | ---: | --- |
| Live inventory | 211 | Matches `information_schema.triggers` (one row per event) |
| Approved dump TOC | 164 | `pg_trigger` public non-internal (`TRIGGER` class 2620, schema `public`) |
| Restored AWS `checksops` | 164 | Same: `pg_trigger` not internal |
| Extra event rows | 47 | 37 multi-event public triggers expand to 47 extra `information_schema` rows |

`164 + 47 = 211`. Restore kept all 164 public dump triggers (filter skipped 0 public triggers).

The 37 multi-event triggers and their extra event rows are in `trigger_event_expansion.md`.

## Categories of the 164 restored public triggers

| Category | Count | Migration blocker? |
| --- | ---: | --- |
| data-integrity | 98 | No — present on AWS |
| application/business logic | 64 | No — present on AWS |
| RLS/security-related | 2 | No — present; RLS policies themselves were not applied |
| Supabase/Auth-specific | 0 | n/a |
| realtime-specific | 0 | n/a |
| cron/net/vault/pgmq-specific | 0 | n/a |
| other | 0 | n/a |

Full lists: `public_triggers_by_category.md`.

The two RLS/security-related public triggers are `user_roles.on_role_change` and `user_roles.trg_prevent_mortgage_agent_role_conflict`. They are application role-integrity triggers, not `ENABLE ROW LEVEL SECURITY`.

## Dump triggers that were correctly excluded (not part of the 47)

These are **not** public, were filtered out, and are not application-table gaps:

| Schema | Table | Trigger | Category |
| --- | --- | --- | --- |
| pgmq | q_auth_emails | email_queue_wake_auth | cron/net/vault/pgmq-specific |
| pgmq | q_transactional_emails | email_queue_wake_transactional | cron/net/vault/pgmq-specific |
| realtime | subscription | tr_check_filters | realtime-specific |
| storage | buckets | enforce_bucket_name_length_trigger | other (Storage/S3 phase) |
| storage | buckets | protect_buckets_delete | other (Storage/S3 phase) |
| storage | objects | protect_objects_delete | other (Storage/S3 phase) |
| storage | objects | update_objects_updated_at | other (Storage/S3 phase) |

Plus 6 Supabase event triggers (`issue_pg_cron_access`, `issue_pg_net_access`, `pgrst_ddl_watch`, etc.), owner `supabase_admin`.

## Blocker assessment

No missing application/business-logic or data-integrity public trigger versus the approved backup. **Not a migration blocker** for this phase.

Do not treat the 211 vs 164 gap as 47 dropped public triggers. Future inventories should count `pg_trigger` (`NOT tgisinternal`, `nspname = 'public'`) to match RDS.
