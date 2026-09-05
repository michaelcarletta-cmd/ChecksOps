# Ninth UUID resolution (fail-closed orphan)

UUID: `dd24eea5-5d12-47d1-999e-d5930c278b7d`

**Decision:** treat as an unlinked leftover identity. Do **not** invent an email, mint a Cognito user, add a `profiles` row, or grant tenant membership.

## Evidence

| Signal | Value |
|---|---|
| `profiles` | none |
| email | unknown — must not be guessed |
| `tenant_users` | none |
| `user_roles` | `admin` + `staff` (global, no tenant) |
| `identity_accounts` | pending, `cognito_sub` null |
| Login | `identity_not_linked` / RLS 0 rows |
| Writes | denied (global role without membership) |

## Mapping for cutover

| application_user_id | Cognito | Action |
|---|---|---|
| eight known emails | invite / link existing subs | map `cognito_sub →` same UUID |
| `dd24eea5-…` | **none** | leave pending; exclude from invite list |

This is a **safe resolution**. The ninth UUID is not a production login identity. Isolation tests must keep fail-closed behavior.

Operator SQL: `aws/identity/sql/ninth_uuid_orphan_report.sql` (read-only).

**Do not** apply this decision by deleting `user_roles` in this PR.
