# Production SQL 117 (the platform owner deactivates, reactivates or deletes an empty tenant)

| key | file | what it does |
|---|---|---|
| `sql117` | `aws/workflows/sql/117_platform_owner_tenant_lifecycle.sql` (sha256 `44cdef389446e528cc9633e5c8f845ba18c122a90a5ff276afb670856a61f00d`) | Creates `public.tenant_deactivations` (RLS on, no policy, no grant) and six functions, all platform-owner only except the IMMUTABLE table list: `aws_tenant_activity_tables()`, `aws_platform_owner_tenant_activity(uuid)`, `aws_platform_owner_deactivate_tenant(uuid, text)`, `aws_platform_owner_reactivate_tenant(uuid)`, `aws_platform_owner_delete_empty_tenant(uuid, text)` and `aws_platform_owner_deactivated_tenants()`. EXECUTE revoked from PUBLIC, granted to `checksops` and `authenticated` (as SQL 102). Refuses (`55000 sql117_prerequisite_missing`) without the prerequisites. No existing object or row changes. |

**Why.** Owner item 8 (2026-10-26): delete tenants in Tenant Management. Owner's choice "both, by
tenant": any tenant can be deactivated (its `tenant_users` rows move into `tenant_deactivations`,
so its users lose access the same way a removed member does; `subscription_status` becomes
`inactive`; reversible), and a tenant with no checks or money movement can be permanently deleted
after its slug is typed. Every change is audited in `tenant_pricing_audit` (no foreign key to
`tenants`, so a deleted tenant's audit is kept). The API that calls the functions
(`tenant-billing-admin` `tenants-deactivated`, `tenant-deactivate`, `tenant-reactivate`,
`tenant-activity`, `tenant-delete`) is live in both environments and answers
`503 tenant_lifecycle_missing` until SQL 117 is applied.

**Expected outcomes of the inspect.** `already_applied` false with `precondition_failures` `[]`
(the prerequisites present, the table and functions absent, the login able to write `tenants`,
`tenant_users` and `tenant_pricing_audit`), or `already_applied` true (nothing to apply; the
inspect is recorded as the verified-live evidence and the pin stays `execute: false`). Anything
else stops and needs its own reviewed change.

**Staging executor refreshed (2026-10-27).** Inspect run 40431399921 (main `9d6f164`) found the
live executor at CodeSha256 `y4Tko8e2…` without SQL 117 (adds
`sql/117_platform_owner_tenant_lifecycle.sql`; supersedes `lib/release-sql-specs.mjs`,
`lib/release-sql-state.mjs`, `lib/sql-executor-auth.mjs`). Deploy run 40431581944 updated it to
main's package (`BQRU3AYO…`; "Verify live executor now carries main's package" passed).

**Staging read-live (2026-10-27).** Run 40431777849 (main `9d6f164`): `tenant_deactivations` and the
six functions absent, every prerequisite present, the login able to write `tenants`, `tenant_users`
and `tenant_pricing_audit`; live `dcfcb810a7d016f63451a3cf6ec00982be2f555fae087871885e49cc4b501956`,
`already_applied` false, `precondition_failures` `[]`. Recorded in the staging pin
(`expected_live_definition_sha256`, `execute: true`, wave 18) under the owner's words of
2026-10-27, "SQL 117 to production" and "Go".

**Staging apply (2026-10-27), rolled back.** Executor deploy run 40434302332 (main `acc1994`)
carried the authorized pin (`QKETFJsu…`). Apply run 40434533070, under the owner's words
"Approve SQL 117 staging apply", refused with `UNRELATED_MUTATION` ("SQL 117 did not leave exactly
the reviewed state", failed `intended_state`, `unrelated_changed` `[]`) and rolled back. Read-live
run 40434717509 confirmed staging unchanged (`dcfcb810…`, `already_applied` false). Cause: the new
table kept the grants the database's default privileges give a new table, while the file revoked
only `PUBLIC` and the spec requires no grant; reproduced on PostgreSQL 16 with a default `SELECT`
grant to `checksops` on new tables.

**Status:** retired, never applied anywhere. The staging pin is back to `execute: false` with a
retirement `authorization`; the production pin stays pending. SQL 118
(`ops/production-sql-118-apply.md`) replaces it.

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec
`functions` and `tables` in `release-sql-specs.mjs`). `aws_platform_owner_deactivated_tenants()`
returns `TABLE (...)`; its result is stated in the spec as `pg_get_function_result` renders it.
Intended `aceed4572b39db76bc12258f1f707ec4b6d78ebcec730a5dbee2bb1999677e00` (reached by a real
apply on PostgreSQL 16 in `aws/tests/sql117-platform-owner-tenant-lifecycle-pg.test.mjs`):

```
release sql117 v1
function public.aws_tenant_activity_tables(): lang=sql vol=i parallel=u secdef=false result=text[] config= prosrc=bed95d26a95f7d29a2ae11f99a9f8e82bc8af428da0369b395b087109c4cc56c acl=authenticated EXECUTE;checksops EXECUTE;owner EXECUTE
function public.aws_platform_owner_tenant_activity(uuid): lang=plpgsql vol=s parallel=u secdef=true result=jsonb config=row_security=off;search_path=public, pg_temp prosrc=7f93699a250dd1308223f49d8dd99f19608d1fa0696ade39a78937a58f0f2118 acl=authenticated EXECUTE;checksops EXECUTE;owner EXECUTE
function public.aws_platform_owner_deactivate_tenant(uuid, text): lang=plpgsql vol=v parallel=u secdef=true result=jsonb config=row_security=off;search_path=public, pg_temp prosrc=3af9f8010c3c3c4579633ef4abb7d257097b1d469e6dfa7b283502fbd0aadaa8 acl=authenticated EXECUTE;checksops EXECUTE;owner EXECUTE
function public.aws_platform_owner_reactivate_tenant(uuid): lang=plpgsql vol=v parallel=u secdef=true result=jsonb config=row_security=off;search_path=public, pg_temp prosrc=a79082b1b3b5876ffd0217bcfe3106d4e75936381e4546c4215f50f7b2191393 acl=authenticated EXECUTE;checksops EXECUTE;owner EXECUTE
function public.aws_platform_owner_delete_empty_tenant(uuid, text): lang=plpgsql vol=v parallel=u secdef=true result=jsonb config=row_security=off;search_path=public, pg_temp prosrc=8d0d472de5fc6eafb00b7ecc2c893f5182fa38191c334bc7069053aa6393a756 acl=authenticated EXECUTE;checksops EXECUTE;owner EXECUTE
function public.aws_platform_owner_deactivated_tenants(): lang=plpgsql vol=s parallel=u secdef=true result=TABLE(tenant_id uuid, deactivated_at timestamp with time zone, deactivated_by uuid, reason text, previous_subscription_status text, suspended_memberships integer) config=row_security=off;search_path=public, pg_temp prosrc=70d5a383e14ada682d9dcc5955c49ff081de0c1ea4af75128ef565f186227e8b acl=authenticated EXECUTE;checksops EXECUTE;owner EXECUTE
table public.tenant_deactivations: kind=r rls=true forced=false
table public.tenant_deactivations column tenant_id: uuid notnull=true default=- acl=
table public.tenant_deactivations column deactivated_at: timestamp with time zone notnull=true default=28a4dae0461e17af56e979c2095abfbe0bfc45fe9ca8abf3144338a518a1bb8f acl=
table public.tenant_deactivations column deactivated_by: uuid notnull=false default=- acl=
table public.tenant_deactivations column reason: text notnull=false default=- acl=
table public.tenant_deactivations column previous_subscription_status: text notnull=false default=- acl=
table public.tenant_deactivations column memberships: jsonb notnull=true default=3fad7390b7bffb3cf2f50703d5e74be1cd9c8738608b6702cfea68f9d98e02bb acl=
table public.tenant_deactivations constraint tenant_deactivations_pkey: 6389a079a1ff3a19fa1944eccdebcfd80d48ea07383c213998d2da88023a52b7 validated=true
table public.tenant_deactivations constraint tenant_deactivations_tenant_id_fkey: 7f42781354ada4cba94285eec06e82bfbb8e0b7621579554d57f76324d9a067b validated=true
table public.tenant_deactivations index tenant_deactivations_pkey: 8f7a326058048ef3773f6f1bd75da24163c907b6df07fa27a016265b234b4fc2
table public.tenant_deactivations policies: 
table public.tenant_deactivations triggers: 
table public.tenant_deactivations acl: 
```

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present` (`tenants`, `tenant_users`, `tenant_pricing_audit`, `is_platform_owner()`,
`aws_tenants_member_column_guard()`, `auth.uid()`, the roles and the columns the functions use);
`created_tables_absent_or_intended` (`tenant_deactivations` absent or exactly as intended); the
functions absent or exactly as intended; `definer_can_write_relations` (`tenants`, `tenant_users`,
`tenant_pricing_audit`).

Post-conditions: the intended fingerprint; everything else in schema `public` (and the functions
of `auth`) unchanged, the new table and functions excepted. The tools roll back otherwise.

## Order

No predecessor. Its prerequisites come from SQL 96 (`tenant_pricing_audit`) and SQL 102
(`aws_tenants_member_column_guard()`), both applied in production on 2026-10-19 and 2026-10-20.

## Steps

1. Staging: the staging executor must carry SQL 117 first (executor package refresh through
   `sql-executor-ensure.mjs` / the guarded staging executor `deploy` mode, its own reviewed run).
   Then run the guarded staging SQL executor with `read-live` for
   `sql117-platform-owner-tenant-lifecycle`. If it reports `already_applied` false and
   `precondition_failures` `[]`, record `LIVE_DEFINITION_SHA256` in the staging pin
   (`expected_live_definition_sha256`, owner-approved `authorization`, `execute: true`) in a
   reviewed change, `apply` with the owner's approval of that run, then `read-live` again
   (expected `already_applied` true). Anything else: stop and record it in its own reviewed
   change.
2. Production: run the read-only inspect on the runner
   (`node scripts/deployment-guard/sql117-platform-owner-tenant-lifecycle-production-apply.mjs --inspect`,
   or the one-shot's `--phase inspect`); record `production_inspect`. If `already_applied` is
   true, the reviewed change records it as verified live and leaves `execute: false`. Otherwise
   copy `live_definition_sha256` into `expected_live_definition_sha256`, record the staging runs
   in `staging_acceptance`, and set an owner-approved `authorization` and `execute: true`, in one
   reviewed change.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs
   --migration sql117 --approval-scope sql117 … --phase inspect`, then the owner-named
   `--phase apply`.
4. Record the apply and retire the pin (`execute: false`).
