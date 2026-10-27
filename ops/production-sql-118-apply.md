# Production SQL 118 (the platform owner deactivates, reactivates or deletes an empty tenant)

| key | file | what it does |
|---|---|---|
| `sql118` | `aws/workflows/sql/118_platform_owner_tenant_lifecycle.sql` (sha256 `f10655a8f105436b4a020be5564186e335f1f6bb06f840742c939879bdba45a5`) | SQL 117 plus the revoke of every non-owner grant on `public.tenant_deactivations`. Creates `public.tenant_deactivations` (RLS on, no policy, no grant, default-privilege grants revoked) and six functions, all platform-owner only except the IMMUTABLE table list: `aws_tenant_activity_tables()`, `aws_platform_owner_tenant_activity(uuid)`, `aws_platform_owner_deactivate_tenant(uuid, text)`, `aws_platform_owner_reactivate_tenant(uuid)`, `aws_platform_owner_delete_empty_tenant(uuid, text)` and `aws_platform_owner_deactivated_tenants()`. EXECUTE revoked from PUBLIC, granted to `checksops` and `authenticated` (as SQL 102). Refuses (`55000 sql118_prerequisite_missing`) without the prerequisites. No existing object or row changes. |

**Why SQL 118 and not SQL 117.** SQL 117 (`ops/production-sql-117-apply.md`) was never applied.
Its guarded staging apply (run 40434533070, 2026-10-27, after executor deploy run 40434302332)
rolled back with `UNRELATED_MUTATION` `intended_state`: the new table kept the grants the
database's default privileges give a new table (SQL 117 revoked only `PUBLIC`, while its spec
requires no grant). Read-live run 40434717509 confirmed staging unchanged
(`dcfcb810a7d016f63451a3cf6ec00982be2f555fae087871885e49cc4b501956`, `already_applied` false).
The same failure reproduces on PostgreSQL 16 with a default `SELECT` grant to `checksops` on new
tables, and SQL 118 reaches its intended fingerprint there
(`aws/tests/sql118-platform-owner-tenant-lifecycle-pg.test.mjs`). SQL 96 and SQL 98 avoid it the same
way, by revoking `authenticated` and `checksops` on their new tables; SQL 118 revokes every
non-owner grantee, whichever the database's defaults name. Migrations on main are append-only, so
the fix is this new number; the SQL 117 pins are retired (`execute: false`).

**What.** Owner item 8 (2026-10-26): delete tenants in Tenant Management. Owner's choice "both, by
tenant": any tenant can be deactivated (its `tenant_users` rows move into `tenant_deactivations`,
so its users lose access the same way a removed member does; `subscription_status` becomes
`inactive`; reversible), and a tenant with no checks or money movement can be permanently deleted
after its slug is typed. Every change is audited in `tenant_pricing_audit` (no foreign key to
`tenants`, so a deleted tenant's audit is kept). The API that calls the functions
(`tenant-billing-admin` `tenants-deactivated`, `tenant-deactivate`, `tenant-reactivate`,
`tenant-activity`, `tenant-delete`) is live in both environments and answers
`503 tenant_lifecycle_missing` until SQL 118 is applied.

**Expected outcomes of the inspect.** `already_applied` false with `precondition_failures` `[]`
(the prerequisites present, the table and functions absent, the login able to write `tenants`,
`tenant_users` and `tenant_pricing_audit`), or `already_applied` true (nothing to apply; the
inspect is recorded as the verified-live evidence and the pin stays `execute: false`). Anything
else stops and needs its own reviewed change.

**Staging executor refreshed (2026-10-27).** Deploy run 40436720850 (main `7cd3272`) updated the
live executor from `QKETFJsu…` (it lacked `sql/118_platform_owner_tenant_lifecycle.sql`) to main's
package (`2YWR1aEg…`; "Verify live executor now carries main's package" passed).

**Staging read-live (2026-10-27).** Run 40436888477 (main `7cd3272`): `tenant_deactivations` and the
six functions absent, every prerequisite present, the login able to write `tenants`, `tenant_users`
and `tenant_pricing_audit`; live `1b5eec31635d869abbabc9d4584674ee5852a27689629d9c199627d7c8653cde`
(the same pre-state the PostgreSQL 16 test reads), `already_applied` false, `precondition_failures`
`[]`. Recorded in the staging pin (`expected_live_definition_sha256`, `execute: true`, wave 19)
under the owner's words of 2026-10-27, "Start the SQL 118 tooling PR" and "Go".

**Staging apply (2026-10-27).** After the staging pin change (#1282), executor deploy run
40437966024 (main `58c99eb`) carried the authorized pin (`Am+LSNC5…`). Apply run 40438147297, under
the owner's words "approve the SQL 118 staging apply": result `applied`, before
`1b5eec31635d869abbabc9d4584674ee5852a27689629d9c199627d7c8653cde`, after
`6f9e2ef349c397ab4df81337139776287e2b6e8a85d4108ae090604717476925` (intended). Read-live run
40438403321: `already_applied` true, `tenant_deactivations` intended with `table_privileges` `[]`, the
six functions intended.

**Production inspect (2026-10-27).** Read-only `--inspect` through SSM
`7e8004f8-aad0-45ef-993a-f17a04b13304` on `i-0c35557c4e5385406`, main `58c99eb57` (tarball sha256
`5a3e3def5ddb27c46f764b8162fdcc32b89845158f370433ae544738ee06e56c`, transfer run 40438680541, migration
source `f10655a8…` == pin), connected as `checksops_admin`: `tenant_deactivations` and the six
functions absent, every prerequisite present; live
`1b5eec31635d869abbabc9d4584674ee5852a27689629d9c199627d7c8653cde` (the staging pre-state),
`already_applied` false, `precondition_failures` `[]`. Recorded in the production pin with the staging
apply as its staging acceptance and `execute: true` under the owner's words of 2026-10-27, "SQL 117 to
production" (the tenant lifecycle, which SQL 118 now carries) and "Go". Each apply still needs the
owner's run-time approval.

**Status:** applied to staging and to production (2026-10-27); the production pin is retired
(`execute: false` again; see "Production apply of SQL 118").

## Production apply of SQL 118 (2026-10-27)

The owner's message of 2026-10-27 was "Apply SQL 118 in production"; it was passed verbatim (base64,
`--approval-statement-b64`) and recorded by the one-shot as `approval_statement`. The one-shot
cannot verify who said it, and the statement covered this run only. `production-sql-one-shot.mjs
--migration sql118 --approval-scope sql118` on `i-0c35557c4e5385406` (operator-supplied
`--runner`, not verified by the one-shot), operator `michaelcarletta-cmd`, workstream
`prod-sql118-tenant-lifecycle-20261027`, from main `4d9763eff` (tarball
`source-4d9763eff050b7ca9471892562882d60da9419f5.tar.gz`, sha256 `f669e856…`, 12789 files, transfer
run `40439891990`, `sql53-temporary-transfer.yml` on main after the #1283 merge; it printed
`TARBALL_SHA256 f669e85678a64cb3ee43f0e0a7cdd27e7694197ff48be0b75982473311f848f1`). One SSM command,
`9bccc7c9-9fe2-4e6f-988d-a778f07b1607` (2026-10-27T10:45:37Z to 10:46:03Z, exit 0), ran both phases;
the apply phase ran only after the inspect phase succeeded (`set -e`).

- **Inspect phase:** run_id `04a48489-5dce-473d-81e5-c6347ac28b9b`: pin (execute true, staging
  acceptance run 40438147297), source, inspect and contracts ok (claim-ledger 4/4, tenant-isolation
  6/6, financial-write-protections 43/43), read-only; live `1b5eec31…` (live_matches_expected true),
  already_applied false, precondition_failures [], apply_preconditions_met true, connected as
  `checksops_admin`.
- **Apply phase:** run_id `a47888ef-daf8-4add-adac-3a703176b67d`, one_use_id
  `sql118-prod-327fe57a-22b1-452f-afdc-6c52b653f153` (spent): every step ok (pin, source, inspect,
  contracts, manifest, source-recheck-before-preflight, preflight (receipt issued), evaluate
  (`sql118_production_apply_allowed` true), source-recheck-before-apply, apply (applied),
  post-apply-inspect); migration source `f10655a8…` (== pin); pre-apply inspect live `1b5eec31…`,
  live_matches_expected true, precondition_failures [], `tenant_deactivations` and the six functions
  absent; contracts claim-ledger 4/4, tenant-isolation 6/6, financial-write-protections 43/43;
  manifest `09ec4d5c…`; receipt `1b5eec31…` -> `6f9e2ef3…`, result applied, unrelated catalog
  `a6eed736…` (relations 890, columns 3543, constraints 2234, policies 404, functions 1326, indexes
  654, default ACL 0, triggers 180, views 25, types 18, roles 29, role memberships 15); post-apply
  inspect live `6f9e2ef3…` (= intended), already_applied true, precondition_failures [],
  missing_dependencies []; `tenant_deactivations` intended (RLS on, no policy, `table_privileges`
  `[]`) and the six functions intended with EXECUTE for `authenticated`, `checksops` and the owner.
  SSM returns at most 24000 characters of output, so the end of the apply run's JSON was not
  captured; every value above was printed in the captured part.

No later read-only inspect is recorded. The pin is `execute: false` again; a re-apply needs a new
reviewed pin change. The tenant lifecycle API (`tenant-billing-admin` `tenants-deactivated`,
`tenant-deactivate`, `tenant-reactivate`, `tenant-activity`, `tenant-delete`), live since overlay run
40425235000, now reaches the functions instead of answering `503 tenant_lifecycle_missing`.

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec
`functions` and `tables` in `release-sql-specs.mjs`). `aws_platform_owner_deactivated_tenants()`
returns `TABLE (...)`; its result is stated in the spec as `pg_get_function_result` renders it.
Intended `6f9e2ef349c397ab4df81337139776287e2b6e8a85d4108ae090604717476925` (reached by a real
apply on PostgreSQL 16 in `aws/tests/sql118-platform-owner-tenant-lifecycle-pg.test.mjs`):

```
release sql118 v1
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
`created_tables_absent_or_intended` (`tenant_deactivations` absent or exactly as intended); the functions absent or exactly as intended; `definer_can_write_relations` (`tenants`, `tenant_users`,
`tenant_pricing_audit`).

Post-conditions: the intended fingerprint; everything else in schema `public` (and the functions
of `auth`) unchanged, the new table and functions excepted. The tools roll back otherwise.

## Order

No predecessor. Its prerequisites come from SQL 96 (`tenant_pricing_audit`) and SQL 102
(`aws_tenants_member_column_guard()`), both applied in production on 2026-10-19 and 2026-10-20.

## Steps

1. Staging: the staging executor must carry SQL 118 first (executor package refresh through
   `sql-executor-ensure.mjs` / the guarded staging executor `deploy` mode, its own reviewed run).
   Then run the guarded staging SQL executor with `read-live` for
   `sql118-platform-owner-tenant-lifecycle`. If it reports `already_applied` false and
   `precondition_failures` `[]`, record `LIVE_DEFINITION_SHA256` in the staging pin
   (`expected_live_definition_sha256`, owner-approved `authorization`, `execute: true`) in a
   reviewed change, `apply` with the owner's approval of that run, then `read-live` again
   (expected `already_applied` true). Anything else: stop and record it in its own reviewed
   change.
2. Production: run the read-only inspect on the runner
   (`node scripts/deployment-guard/sql118-platform-owner-tenant-lifecycle-production-apply.mjs --inspect`,
   or the one-shot's `--phase inspect`); record `production_inspect`. If `already_applied` is
   true, the reviewed change records it as verified live and leaves `execute: false`. Otherwise
   copy `live_definition_sha256` into `expected_live_definition_sha256`, record the staging runs
   in `staging_acceptance`, and set an owner-approved `authorization` and `execute: true`, in one
   reviewed change.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs
   --migration sql118 --approval-scope sql118 … --phase inspect`, then the owner-named
   `--phase apply`.
4. Record the apply and retire the pin (`execute: false`).
