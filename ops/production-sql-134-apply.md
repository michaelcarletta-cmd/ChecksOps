# Production SQL 134 (the Loss Draft escrow and draw write grants)

| key | file | what it does |
|---|---|---|
| `sql134` | `aws/workflows/sql/134_loss_draft_escrow_write_grants.sql` (sha256 `a9082d1369587a702014e10e443ab965c1608e99d14a193da900f7d35c91e03a`) | `GRANT UPDATE (total_escrowed, draw_amount_requested, draw_stage, draw_amount_released, holdback_amount) ON TABLE public.loss_draft_tracking` and `GRANT INSERT (loss_draft_id, draw_number, amount_requested, amount_released, release_date, released_at, status, notes, created_by) ON TABLE public.loss_draft_releases`, each to `checksops` and `authenticated`. No other statement: no table-wide UPDATE or INSERT, no other column, no SELECT, DELETE, sequence or function grant, no PUBLIC or anon grant, no RLS or policy change. |

**Why.** Owner decision 2026-10-30: a monitored loss draft stays in Loss Draft so the tenant can
document escrow and disbursements the mortgage company reports. The Loss Draft API change (#1464,
`aws/functions/api/workflow-rpc.mjs` `executeLossDraftAction`) records them with five
`loss_draft_action` actions, none of which moves money, on the draft's `loss_draft_tracking` row,
as `checksops`:

| action | `UPDATE public.loss_draft_tracking SET` | also |
|---|---|---|
| `mark_escrowed` | `escrow_status`, `total_escrowed`, `check_received_date`, `updated_at` | |
| `request_draw` | `escrow_status`, `draw_amount_requested`, `draw_stage`, `updated_at` | |
| `record_release` | `escrow_status`, `draw_amount_released`, `updated_at` | `INSERT INTO public.loss_draft_releases (loss_draft_id, draw_number, amount_requested, amount_released, release_date, released_at, status, notes, created_by)` in a savepoint |
| `record_holdback` | `holdback_amount`, `updated_at` | |
| `mark_final_release` | `escrow_status`, `draw_amount_released`, `updated_at` | |

SQL 50 (`aws/workflows/sql/50_tranche5_write_grants.sql`) grants `checksops` and `authenticated`
column UPDATE on `loss_draft_tracking` for `escrow_status`, `check_received_date`, `updated_at`
and the file's other metadata columns, but not on `total_escrowed`, `draw_amount_requested`,
`draw_stage`, `draw_amount_released` or `holdback_amount`; no later migration grants them, and none
grants INSERT on `loss_draft_releases` (SQL 51 only revokes SQL 50's grants where it is run; SQL 65,
87 and 126 do not grant on either table). The restored database gave `checksops` SELECT only
(`aws/db-copy/sql/02_grant_readonly_application_role.sql`). PostgreSQL checks table and column
privileges before row-level security, so without SQL 134 the four amount actions fail with 42501
and the Draws row is never written (the API reports `release_recorded: false`).
`loss_draft_releases.id` defaults to `gen_random_uuid()` (no sequence, so no USAGE grant), and
`holdback_amount`, `requested_at` and `created_at` take their defaults. The API's `draw_number`
subquery reads `loss_draft_releases` with the table SELECT `checksops` already holds; SQL 134 does
not grant SELECT.

**Roles.** `checksops` and `authenticated`, the roles SQL 50 grants `loss_draft_tracking` to (and
SQL 114 its column grant). The API connects as `checksops`, a member of `authenticated`; the
policies below are `TO authenticated`.

**Policies (not changed).** `aws_write_loss_draft_tracking` (`aws_can_write_check(check_intake_item_id)`)
and `aws_write_loss_draft_releases` (`aws/rls/sql/24_complete_write_policies.sql`: `FOR ALL TO
authenticated`, `USING` / `WITH CHECK` `aws_can_write_claim(ldt.claim_id)` of the draft) stay the
authorization boundary. `aws_can_write_claim(NULL)` is false, so a draft whose `claim_id` is null
(common for check-intake loss drafts) still gets no Draws row: its amounts are recorded on
`loss_draft_tracking`, and the API's savepoint reports `release_recorded: false`. SQL 65 widened the
same claim-only rule for `loss_draft_audit_log` in staging; widening `aws_write_loss_draft_releases`
is a separate owner decision and is not part of SQL 134.

**Expected outcomes of the inspect.** `already_applied` false with `precondition_failures` `[]` (no
column grant on the fourteen columns yet), or `already_applied` true (both lines held on all
fourteen: nothing to apply; the inspect is recorded as the verified-live evidence and the pin stays
`execute: false`). Anything else (a precondition failure, such as another role's grant on one of
the columns, a missing table, column or role) stops and needs its own reviewed change. Read also,
from the same inspect, the table ACLs of both tables and SQL 50's column grants on
`loss_draft_tracking` (`escrow_status`, `check_received_date`, `updated_at` for `checksops`): the
API needs them too, and SQL 134 does not grant them.

**Status:** not applied anywhere. The staging pin and the production pin are pending.

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec
`column_acl` in `release-sql-specs.mjs`, as SQL 92 and SQL 114): the column ACL
(`pg_attribute.attacl`, every grantee) of the fourteen columns, or `absent` per column. Intended
`c046d1c91cc79596c103f154b043b5421cb1dc6ceaef45d87f2f6ea1c0073c7c`:

```
release sql134 v1
column public.loss_draft_tracking.total_escrowed acl: authenticated UPDATE;checksops UPDATE
column public.loss_draft_tracking.draw_amount_requested acl: authenticated UPDATE;checksops UPDATE
column public.loss_draft_tracking.draw_stage acl: authenticated UPDATE;checksops UPDATE
column public.loss_draft_tracking.draw_amount_released acl: authenticated UPDATE;checksops UPDATE
column public.loss_draft_tracking.holdback_amount acl: authenticated UPDATE;checksops UPDATE
column public.loss_draft_releases.loss_draft_id acl: authenticated INSERT;checksops INSERT
column public.loss_draft_releases.draw_number acl: authenticated INSERT;checksops INSERT
column public.loss_draft_releases.amount_requested acl: authenticated INSERT;checksops INSERT
column public.loss_draft_releases.amount_released acl: authenticated INSERT;checksops INSERT
column public.loss_draft_releases.release_date acl: authenticated INSERT;checksops INSERT
column public.loss_draft_releases.released_at acl: authenticated INSERT;checksops INSERT
column public.loss_draft_releases.status acl: authenticated INSERT;checksops INSERT
column public.loss_draft_releases.notes acl: authenticated INSERT;checksops INSERT
column public.loss_draft_releases.created_by acl: authenticated INSERT;checksops INSERT
```

**Expected pre-state (both environments).** No column grant on any of the fourteen columns (each
`acl: ` empty): `7827f4c87e5bc9e7bd0def01d5f201a0a1fc26365480921896aa452e1403466d`, derived by
`aws/tests/release-sql134-executor.test.mjs` and read back from a PostgreSQL 16 database with the
tables as the restored database and SQL 50 leave them. Each pin records its own environment's read;
neither value is written into a pin before a run reads it.

Table-level grants (`relacl`) and every other column's grants (SQL 50's among them) are outside the
fingerprint; the unrelated-catalog snapshot requires them, the tables' RLS flags and their policies
unchanged.

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present` (both tables, the fourteen columns, roles `checksops` and `authenticated`);
`altered_relations_owned_by_login` (the login owns both tables, so its GRANTs take effect);
`column_acl_replaceable` (every live grant on the fourteen columns is one of the two pinned lines:
another role's grant there would survive the file and is refused). No predecessor. A column that
already holds one or both lines passes: the file only adds the missing ones; all held is
`already_applied` true.

Post-conditions: the intended fingerprint; everything else in schema `public` (and the functions
of `auth`) unchanged, the fourteen columns' ACLs excepted. The tools roll back otherwise.

## Order

No predecessor and no order. The grants alone change no behaviour; the API change that uses them
(#1464) is deployed through the guarded Lambda path after SQL 134 is applied in that environment
(`ops/lambda-configuration-change.md`, `ops/production-lambda-rebuild.md`). No later migration
revokes these grants.

## Steps

1. Staging: the staging executor must carry SQL 134 first (executor package refresh through
   `sql-executor-ensure.mjs` / the guarded staging executor `deploy` mode, its own reviewed run).
   Then run the guarded staging SQL executor with `read-live` for
   `sql134-loss-draft-escrow-write-grants`. Expected: `already_applied` false,
   `precondition_failures` `[]`, `live_definition_sha256` `7827f4c8…` (above). If it reports
   `already_applied` true, record the run as the staging evidence (nothing to apply). If it reports
   `prerequisites_missing` other than `[]` or `precondition_failures` other than `[]`, stop.
   Otherwise record `LIVE_DEFINITION_SHA256` in the staging pin (`expected_live_definition_sha256`,
   owner-approved `authorization`, `execute: true`) in a reviewed change, `apply` with the owner's
   approval of that run, then `read-live` again (expected `already_applied` true).
2. Production: run the read-only inspect on the runner
   (`node scripts/deployment-guard/production-sql-one-shot.mjs --migration sql134 … --phase inspect`,
   or the tool's `--inspect`); record `production_inspect`. If `already_applied` is true, the
   reviewed change records it as verified live and leaves `execute: false`. Otherwise copy
   `live_definition_sha256` into `expected_live_definition_sha256`, record the staging runs in
   `staging_acceptance`, and set an owner-approved `authorization` and `execute: true`, in one
   reviewed change.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs
   --migration sql134 --approval-scope sql134 … --phase inspect`, then the owner-named
   `--phase apply` with the owner's words (authorization phrase
   `APPLY_LOSS_DRAFT_ESCROW_WRITE_GRANTS`).
4. Record the apply and retire the pin (`execute: false`).
5. Only then deploy the API change through the guarded Lambda path.
