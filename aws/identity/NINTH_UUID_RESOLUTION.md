# Ninth UUID — live production investigation

UUID: `dd24eea5-5d12-47d1-999e-d5930c278b7d`

**Decision:** **not a production user requiring Cognito migration.** Do not invent an email, invite, or import.

## Live production (read-only DB bridge, 2026-09-05)

Script: `node aws/cutover/scripts/ninth-uuid-live-investigate.mjs` (no emails printed).

| Table | Rows scanned | UUID present |
|---|---|---|
| `profiles` | 8 | **no** |
| `tenant_users` | 7 | **no** |
| `user_roles` | 10 | **no** |
| `identity_accounts` | 0 | **no** |
| `identity_map` profiles | count 8 | **no** |

Classification: `not_found` on live production. The eight expected application UUIDs remain the only invite list.

Earlier rehearsal notes about global `admin`+`staff` leftover roles described **staging/RDS overlay leftovers**, not a live Lovable login identity.

## Mapping for cutover

| application_user_id | Cognito | Action |
|---|---|---|
| eight known mappings | invite / link later | map `cognito_sub →` same UUID |
| `dd24eea5-…` | **none** | exclude from invite list |

`--apply` on identity scripts stays refused. Isolation tests keep fail-closed behavior.

Operator SQL (read-only): `aws/identity/sql/ninth_uuid_orphan_report.sql`.
