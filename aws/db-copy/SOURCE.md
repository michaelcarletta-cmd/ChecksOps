# Source of truth for the first AWS copy

**Authoritative live catalog:** [`LIVE_SOURCE_INVENTORY.md`](LIVE_SOURCE_INVENTORY.md)
(committed on `aws-migration` from the Lovable-connected production database).

This tooling **does not** request another Supabase access token or database
password. Live catalog counts are parsed from that file.

## Correction: there is no 20-table discrepancy

| Object | Live count | Notes |
| --- | --- | --- |
| Public **base tables** | **166** | `pg_class relkind = 'r'` |
| Public **views** | **20** | `relkind = 'v'`; no materialized views |
| Public **relations** (tables + views) | **186** | Earlier “186 tables” mixed these |
| Public functions | **960** | `information_schema.routines` |
| Public triggers | **211** | |
| Public RLS policies | **380** | Catalog only; **do not ENABLE ROW LEVEL SECURITY** on first copy |
| `auth.users` | **9** | **Out of scope** (Cognito later). **0** FKs from public → `auth.users` |
| `storage.objects` | **1,335** | **Out of scope** (S3 later) |

Generated PostgREST types (`src/integrations/supabase/types.ts`) list the same
**166 tables and 20 views**. Function coverage in that file is only 358 names
(a PostgREST subset of the live 960).

## What the first copy includes

- Public schema (166 tables + 20 views + functions/triggers needed for integrity)
- Application **data** for all 166 tables
- RDS-supported extensions: `pgcrypto`, `uuid-ossp`, `pg_stat_statements`, plus
  `postgis` and `vector` **if** the engine allows them (stop if not)

## What the first copy excludes

- Supabase Auth users, sessions, identities (Cognito later)
- Storage objects (S3 later)
- RLS **activation** (policies may exist in the dump sidecar; they are not restored)
- Realtime publication
- `pg_cron` / `pg_net` / `supabase_vault` / `pgmq` / `pgsodium` **behavior**
- Production payment/email webhooks (Moov, CheckAlt, Plaid, Resend)

## Target (existing instance only)

- Instance: `checksops-staging.cyr0q4kcop3c.us-east-1.rds.amazonaws.com`
- Isolate restore in a **new database named `checksops`**
- Leave the current `postgres` database (and `/db-health`) untouched
- App role `checksops`: CONNECT + SELECT on `checksops` after restore; Lambda
  stays on `dbname=postgres` until a later, approved cutover
