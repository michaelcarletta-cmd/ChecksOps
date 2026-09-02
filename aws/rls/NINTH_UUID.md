# Ninth UUID (restored evidence only)

UUID: `dd24eea5-5d12-47d1-999e-d5930c278b7d`

**Do not** delete, merge, invite, assign an email, or create Cognito.

## Confirmed rows

| Object | Evidence |
| --- | --- |
| `user_roles` | `admin` and `staff` |
| `role_version_tracker` | version `2` at 2026-08-26 16:37:57 UTC |
| `tenant_vetting_documents.uploaded_by` | C1C tenant `4f172140-…13b4`, W9 `Condition One W9.pdf`, 2 051 233 bytes, `application/pdf`, path under the C1C prefix, `review_status=pending`, 2026-08-26 16:55:18 UTC |
| `identity_accounts` | staging mapping table only (created later); no Cognito sub, no email |
| `profiles` | no row |
| `tenant_users` | no row |
| `audit_logs` | 0 |
| `check_audit_log.actor_id` | 0 (live) |

## Dump-only oddity (not an email)

`referrers.id` equals this UUID in the dump COPY. Columns look like a misaligned `role_version_tracker` tuple (`name=2`, `company=<that timestamp>`, `email` NULL). Live oneshot re-reads `referrers`. **Email is still unknown.**

## Interpretation

Incomplete application identity: global `admin`+`staff` were granted and it uploaded C1C vetting, but it never received a profile or `tenant_users` membership. Write tests must keep it denied for tenant-scoped DML (global role without membership).
