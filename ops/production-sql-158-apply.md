# Production SQL 158 (Tenant Management Desk oversight, assign, private agent notes)

| key | file | what it does |
|---|---|---|
| `sql158` | `aws/workflows/sql/158_mortgage_desk_oversight_and_agent_notes.sql` (sha256 `282c6bdac33be8e09d5100854e861cf7d14003ff94eba334d1ffe65986319e05`, authored by `d5d104f23`) | Refuses without its prerequisites (`55000 sql158_prerequisite_missing`) or unless the applying login can read `mortgage_handling_requests`, `mortgage_ops_request_audit`, `mortgage_agent_accounts`, `identity_accounts`, `profiles`, `user_roles` and `tenants` past RLS (`55000 sql158_definer_cannot_read`); then one new table with no grant and six new SECURITY DEFINER functions, EXECUTE `checksops` and the owner only. |

**Why.** Owner 2026-11-12: "Tenant Management desk view plus 'Message agent'" (an email to the assigned agent AND a note on
the request, "Both"); then "Tenant management and the agent assigned can see the notes", "If no agent then tenant management
can assign", "Note is only visible to agent"; tenant management is the platform owner only, and assigning a queued request
starts it. SQL 158 (#1807) replaces SQL 157 (#1803), which is never applied and has no pin or tooling: SQL 157's new table
revoked only PUBLIC and checksops, so it kept the grants the database's default privileges give a new table, the defect that
rolled SQL 117 back in staging (run 40434533070, `UNRELATED_MUTATION` `intended_state`). SQL 158 revokes every non-owner
grant on the table, as SQL 118 and SQL 152 do.

**What it does.**
- `public.mortgage_desk_agent_notes` (new): one row per note (request, author, the agent it was written to, body of 1 to
  2000 characters, email outcome). FK to `mortgage_handling_requests` ON DELETE CASCADE, index on `(request_id, created_at
  DESC)`. RLS on, no policy, no grant to anyone, default-privilege grants included: only the functions below touch it. The
  tenant never sees a note; it is not a check message.
- `aws_mortgage_desk_overview(uuid, text, integer, integer)`: Desk requests (requested, in_progress, completed; one tenant or
  all), queued oldest first, with the agent's name, seconds in the current status, turnaround once completed, note count and
  the total count. Platform owner only.
- `aws_mortgage_desk_assignable_agents()`: active mortgage agents with their in-progress count. Platform owner only.
- `aws_mortgage_desk_assign_agent(uuid, uuid)`: a queued (requested, unassigned) request becomes `in_progress` for the agent
  with `accepted_at` now(), the row change the agent's own accept makes, plus a `mortgage_ops_request_audit` row
  (`assign`). Platform owner only.
- `aws_mortgage_desk_add_agent_note(uuid, text)` and `aws_mortgage_desk_record_agent_note_email(uuid, text)`: a note to the
  assigned agent (10 per request per hour) and its email outcome, once. Platform owner only.
- `aws_mortgage_desk_agent_notes(uuid)`: the request's notes, for the platform owner or the agent it is assigned to.

Not changed: no existing function is replaced; no policy, trigger, or existing table, column or grant. The db-readonly-validate
trigger count is not affected. The assign's row change fires whatever live triggers the agent's accept fires (the live-only
`tr_accrue_mortgage_ops_billing` among them); the staging apply shows it. No API, Lambda or SPA change is part of this pin:
the API (Tenant Management actions, the agent email, the Desk's read of the notes) and the Tenant Management page ship
afterwards through their own guarded paths.

**Staging apply (2026-11-12).** After the staging pin (#1813, merged as `bb145ba53`), executor inspect run 43227363018 and executor
deploy run 43227752850 (CodeSha256 `W/eT6lJL…` -> `jEx6/8so…`, RevisionId `85310e5f…`): read-live run 43228270028 `ed94cf62…`,
apply run 43228829366 under the owner's words "merge #1813 and apply SQL 158 in staging" (receipt `ed94cf62…` -> `1c43cf6c…`,
result `applied`), read-live run 43229310297 `already_applied` true, live `1c43cf6c…`.

**Production inspect (2026-11-12).** Read-only, under the owner's words "run the read-only SQL 158 production inspect": transfer run
43230095815 staged main `bb145ba53` (tarball `54f325ea…`, the SQL 158 file on the runner `282c6bda…` == the pin), SSM
`621abcee-0a4a-48c2-9209-e67da773b9bf` on the runner (started 13:49:17Z, stopped 13:51:49Z): live `ed94cf62…` (the table and all
six functions absent), `already_applied` false, `precondition_failures` `[]`, `prerequisites_missing` `[]`, `definer_writes` ok on all
seven relations.

**Status:** applied to staging (wave 50, 2026-11-12); production pin execute-authorized (owner-approved pin change of 2026-11-12,
"record the SQL 158 production pin, merge it when green, and apply SQL 158 in production"); not applied to production. The production
apply still needs the owner's words for that run.

**Staging read-live (2026-11-12).** Run 43221906020 (job 131195251180, main `bfdb9126c`, after executor deploy run
43221459029 (executor CodeSha256 `0idw/ztv…` -> `W/eT6lJL…`, RevisionId `6dde0557…`) and inspect run 43220942074), under the
owner's words "approve SQL 158": `already_applied` false, `precondition_failures` `[]`, `prerequisites_missing` `[]`, every
`definer_writes` relation `ok true`; the table and all six functions absent. Live
`ed94cf62003c8ef29667a8b79dd081f8e0491bde28cf8ec1acee1154b877e233`, equal to the derived state; intended `1c43cf6c…`. Recorded in the staging pin
(`expected_live_definition_sha256`, `execute: true`, wave 50). The staging apply is a separate run after this pin is merged
and the executor is redeployed carrying it, on the owner's words for that run. The production pin stays pending.

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec `sql158` in
`release-sql-specs.mjs`). Intended `1c43cf6ca02fd3d4842b1d854b1ea559dba3cbd007a01c2739d625cfc14428ee`:

```
release sql158 v1
function public.aws_mortgage_desk_overview(uuid, text, integer, integer): lang=plpgsql vol=s parallel=u secdef=true result=TABLE(request_id uuid, tenant_id uuid, tenant_name text, status text, mortgage_company text, loan_number text, claim_number text, homeowner_name text, assigned_agent_id uuid, assigned_agent_name text, created_at timestamp with time zone, accepted_at timestamp with time zone, completed_at timestamp with time zone, status_since timestamp with time zone, seconds_in_status bigint, turnaround_seconds bigint, note_count integer, last_note_at timestamp with time zone, total_count bigint) config=row_security=off;search_path=public prosrc=13c3a9ee9ba0445e9056df9cfbfce20d358ccf94c317dfd293e92b2b0e344f0f acl=checksops EXECUTE;owner EXECUTE
function public.aws_mortgage_desk_assignable_agents(): lang=plpgsql vol=s parallel=u secdef=true result=TABLE(agent_id uuid, agent_name text, in_progress_count integer) config=row_security=off;search_path=public prosrc=0b1b96715b2edf2696cf8c96eac52190cc3333946b1ecc0be707797f8af3b3f1 acl=checksops EXECUTE;owner EXECUTE
function public.aws_mortgage_desk_assign_agent(uuid, uuid): lang=plpgsql vol=v parallel=u secdef=true result=TABLE(request_id uuid, agent_id uuid, agent_name text, agent_email text, accepted_at timestamp with time zone, tenant_name text, mortgage_company text, loan_number text) config=row_security=off;search_path=public prosrc=8ac43d4b18152c480133fc636483f6631c2ee17e8558ccc50d8fbdeed508ce1d acl=checksops EXECUTE;owner EXECUTE
function public.aws_mortgage_desk_add_agent_note(uuid, text): lang=plpgsql vol=v parallel=u secdef=true result=TABLE(note_id uuid, request_id uuid, agent_id uuid, agent_name text, agent_email text, created_at timestamp with time zone, tenant_name text, mortgage_company text, loan_number text) config=row_security=off;search_path=public prosrc=78900dfe21395a0183a181db4e478677ab379b00ca791c860994f984c1a3d9fd acl=checksops EXECUTE;owner EXECUTE
function public.aws_mortgage_desk_record_agent_note_email(uuid, text): lang=plpgsql vol=v parallel=u secdef=true result=boolean config=row_security=off;search_path=public prosrc=4ae981f27da8c467179fc967144ae7bd813e89b711d404e51abd7a92a65d1e6b acl=checksops EXECUTE;owner EXECUTE
function public.aws_mortgage_desk_agent_notes(uuid): lang=plpgsql vol=s parallel=u secdef=true result=TABLE(note_id uuid, request_id uuid, author_id uuid, agent_id uuid, body text, email_status text, emailed_at timestamp with time zone, created_at timestamp with time zone) config=row_security=off;search_path=public prosrc=69d0da92257398915e00c6d3069d30e6481a8622ecb2e4937bce08a1a979a3b4 acl=checksops EXECUTE;owner EXECUTE
table public.mortgage_desk_agent_notes: kind=r rls=true forced=false
table public.mortgage_desk_agent_notes column id: uuid notnull=true default=eea9a3e7c2abe43835e2a6fdf92a7d1e6f145ad6dfbfd243fc5d395e5b390a33 acl=
table public.mortgage_desk_agent_notes column request_id: uuid notnull=true default=- acl=
table public.mortgage_desk_agent_notes column author_id: uuid notnull=true default=- acl=
table public.mortgage_desk_agent_notes column agent_id: uuid notnull=true default=- acl=
table public.mortgage_desk_agent_notes column body: text notnull=true default=- acl=
table public.mortgage_desk_agent_notes column email_status: text notnull=true default=a89df8d14a00b7bd2ead7e86414dcd5232bff306786856171b38584e153bb73f acl=
table public.mortgage_desk_agent_notes column emailed_at: timestamp with time zone notnull=false default=- acl=
table public.mortgage_desk_agent_notes column created_at: timestamp with time zone notnull=true default=28a4dae0461e17af56e979c2095abfbe0bfc45fe9ca8abf3144338a518a1bb8f acl=
table public.mortgage_desk_agent_notes constraint mortgage_desk_agent_notes_body_length: b2b1acd877b42cab8a98ede3149e20ad7c80e672efbb09e92fafae8dd48ffe27 validated=true
table public.mortgage_desk_agent_notes constraint mortgage_desk_agent_notes_email_status: bae6af8c2c31dabb286e7aa49b586e7504b53ac220cbb0bcb9914d47159fa197 validated=true
table public.mortgage_desk_agent_notes constraint mortgage_desk_agent_notes_pkey: 8c8464f42472e42ee190fc91ca8db79b5351d3a4609040516578d229c56f6fa5 validated=true
table public.mortgage_desk_agent_notes constraint mortgage_desk_agent_notes_request_id_fkey: 9056671e6b98172f54bbe3f28b4284a2b0fb26998008b65359a6a04146b12e13 validated=true
table public.mortgage_desk_agent_notes index mortgage_desk_agent_notes_pkey: b98831829e60c1a31d951ff9ac37b2ea414ec8524d272ae168b3600fd27ac47e
table public.mortgage_desk_agent_notes index mortgage_desk_agent_notes_request_idx: aadaf79521969825e010b0b1d20a403051b361b2d06a916a1559c2ab631471a0
table public.mortgage_desk_agent_notes policies: 
table public.mortgage_desk_agent_notes triggers: 
table public.mortgage_desk_agent_notes acl: 
```

**Expected pre-state (both environments).** The table and the six functions absent:

```
release sql158 v1
function public.aws_mortgage_desk_overview(uuid, text, integer, integer): absent
function public.aws_mortgage_desk_assignable_agents(): absent
function public.aws_mortgage_desk_assign_agent(uuid, uuid): absent
function public.aws_mortgage_desk_add_agent_note(uuid, text): absent
function public.aws_mortgage_desk_record_agent_note_email(uuid, text): absent
function public.aws_mortgage_desk_agent_notes(uuid): absent
table public.mortgage_desk_agent_notes: absent
```

That is `ed94cf62003c8ef29667a8b79dd081f8e0491bde28cf8ec1acee1154b877e233` (`releaseStateHash('sql158', {})`). Each pin records its own environment's read; neither value is written
into a pin before a run reads it. A pre-state other than this one is a stop.

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present`; `function_acl_replaceable` and `function_results_match` (where present); `definer_can_write_relations`
on `mortgage_handling_requests`, `mortgage_ops_request_audit`, `mortgage_agent_accounts`, `identity_accounts`, `profiles`,
`user_roles` and `tenants` (the functions run with `row_security=off`).

Post-conditions: the intended fingerprint (the new table with no grant to anyone but the owner); everything else in schema
`public` unchanged. The tools roll back otherwise.

## Steps

Each step is its own reviewed PR or run and waits for the owner's words for that step.

1. Staging: the staging executor must carry SQL 158 first (executor package refresh through the guarded staging executor
   `deploy` mode, its own reviewed run). Then `read-live` for `sql158-mortgage-desk-oversight-and-agent-notes`. Expected
   `already_applied` false, `precondition_failures` `[]`, `prerequisites_missing` `[]`, live `ed94cf62…`. Otherwise
   stop. Record `LIVE_DEFINITION_SHA256` in the staging pin (`expected_live_definition_sha256`, owner-approved `authorization`,
   `execute: true`) in a reviewed change, `apply`, then `read-live` again.
2. Production: with the owner's OK for that read, the read-only inspect on the runner
   (`node scripts/deployment-guard/production-sql-one-shot.mjs --migration sql158 … --phase inspect`); record
   `production_inspect`, copy `live_definition_sha256` into `expected_live_definition_sha256`, record the staging runs in
   `staging_acceptance`, set an owner-approved `authorization` and `execute: true`, in one reviewed change.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs --migration sql158
   --approval-scope sql158 … --phase apply` with the owner's words (authorization phrase
   `START_MORTGAGE_DESK_OVERSIGHT_AND_AGENT_NOTES`).
4. Record the apply and retire the pin (`execute: false`).
5. Then the API and the Tenant Management page through the guarded Lambda overlay and SPA paths, each with its own approval.

Rollback (not part of this pin; a reviewed step of its own if ever needed): drop the six functions and the table.
