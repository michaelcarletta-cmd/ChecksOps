# Ninth UUID (restored evidence only)

UUID: `dd24eea5-5d12-47d1-999e-d5930c278b7d`

**Do not** delete, merge, invite, assign an email, or create Cognito.

## Confirmed rows

Prior full UUID-column scan of `public` + `auth` found **exactly four** tables. Live re-read confirms:

| Object | Evidence |
| --- | --- |
| `user_roles` | `admin` and `staff` (2 rows) |
| `role_version_tracker` | version `2` at 2026-08-26 16:37:57 UTC |
| `tenant_vetting_documents.uploaded_by` | C1C tenant `4f172140-…13b4`, W9 `Condition One W9.pdf`, 2 051 233 bytes, `application/pdf`, path `4f172140-…/vetting/w9-1787763316469-Condition_One_W9.pdf`, `review_status=pending`, 2026-08-26 16:55:18 UTC |
| `identity_accounts` | staging mapping table only; `cognito_sub` null, `email` null, `status=pending` |
| `profiles` | no row |
| `tenant_users` | no row |
| `referrers` | **empty** (dump COPY has zero referrer rows) |
| `audit_logs` | 0 |
| `check_audit_log.actor_id` | 0 |
| `check_intake_items.uploaded_by` / `reviewed_by` | 0 |
| `claim_folders.created_by` | 0 |
| `claim_files.uploaded_by` | 0 |
| `auth.users` | schema exists, **0 rows** restored |
| `auth.identities` | none |
| `contractor_profiles` | 0 |

## Dump misread (corrected)

An earlier note treated a `role_version_tracker` tuple as a `referrers` row (`name=2`, `company=<timestamp>`). The dump `COPY public.referrers` block is immediately `\.` — no referrer rows. **Email is still unknown.**

## Interpretation

Incomplete application identity: global `admin`+`staff` were granted and it uploaded a C1C W9, but it never received a profile or `tenant_users` membership. Write tests must keep it denied for tenant-scoped DML (global role without membership). Knowing this UUID must not authorize writes.
