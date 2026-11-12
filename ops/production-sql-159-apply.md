# Production SQL 159 (checksops SELECT on homeowner intro requests: a contractor's Leads list)

| key | file | what it does |
|---|---|---|
| `sql159` | `aws/workflows/sql/159_homeowner_intro_requests_select_grant.sql` (sha256 `0e26c2e4d2efebf4e10b2332c5943ee530c554a686713ed031d767a6f95da3ab`, authored by `f81f9008e`) | Refuses without the table (`42P01 sql159_table_missing`) or the role (`42704 sql159_role_missing`); then `GRANT SELECT ON TABLE public.homeowner_intro_requests TO checksops`. Nothing else. |

**Why.** A contractor's Leads list (Settings, `ContractorLeadsCard`) cannot load in production. The production API log
(`/aws/lambda/checksops-production-prep-api`, 2026-11-10 20:01:40Z and 20:01:41Z) shows `/prep/data/query` answered 403
with "permission denied for table homeowner_intro_requests" (`data_query_failed`, `rls_denied`) for the card's read. The
data path reads as `checksops`, and production's `checksops` holds no SELECT on the table, although the restore meant
every table to carry it (`aws/db-copy/sql/02_grant_readonly_application_role.sql`) and no migration in this repository
revokes it. Staging's grant comes from its staging-only migrations (SQL 65, 68, 69).

Owner, 2026-11-12: option (a), "A now": the smallest fix, SELECT only. The table's writes (the Leads status update, the
Find a Pro intro insert, the homeowner signing update) are a separate decision: the table is `server_side_api` in
`aws/rls/sql/24_complete_write_policies.sql`, and whether those writes work in production depends on its row-level
security and policies, which this pin does not change.

**What it does.** One table grant: `checksops` SELECT on `public.homeowner_intro_requests`. The secret column
`access_token` stays out of the generic data path's reads (`aws/functions/api/secret-columns.mjs`).

Not changed: no INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES or TRIGGER; nothing to `authenticated`, `PUBLIC`, `anon` or
`service_role`; no column grant, sequence, policy, RLS setting, function, trigger, column or row.
`aws_select_homeowner_intro_requests` remains the authorization boundary for the rows. Every other grant on the table must
stay as it was (`other_table_privileges_unchanged`). No API, Lambda or SPA change is part of this pin.

**Number.** Authored as SQL 158 in #1808 and renumbered to 159 before merging: SQL 158 on main is the Mortgage Desk
oversight migration (`158_mortgage_desk_oversight_and_agent_notes.sql`, #1807). Nothing was applied under either number.

**Status:** tooling built; staging and production pins pending (`execute: false`). Nothing applied or read.

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec `sql159` in
`release-sql-specs.mjs`, `table_privileges` as SQL 104). Intended `d1677f1cb3f8bf5878744111986af7c6d9d4895b0e5a88161372249cdaa3dc0c`:

```
release sql159 v1
privileges public.homeowner_intro_requests SELECT: checksops SELECT
```

**Expected pre-state (production).** The table present and `checksops` without SELECT on it (no line):

```
release sql159 v1
privileges public.homeowner_intro_requests SELECT: 
```

That is `6170e77b6e8b764b28de0d41779ad2d326d867409b401a4b7fd0bb4aa27b7c50` (`releaseStateHash('sql159', { privileges:
{ 'public.homeowner_intro_requests': { exists: true, lines: [] } } })`). The table missing renders

```
release sql159 v1
privileges public.homeowner_intro_requests: absent
```

(`567ee275a409d67eda07451b63ff436b24fae5f40a381940d6e39c96cb086414`, `releaseStateHash('sql159', {})`), and the file refuses
it (`sql159_table_missing`). Staging
is expected to read the intended state already (its staging-only grants), so its read-live reports `already_applied`
true and needs no apply. Each pin records its own environment's read; neither value is written into a pin before a run
reads it. A pre-state other than these is a stop.

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present` (the table and the role `checksops`); `other_table_privileges_unchanged`; the applying login owns
`public.homeowner_intro_requests` (`altered_relations`).

Post-conditions: the intended fingerprint; everything else in schema `public` unchanged. The tools roll back otherwise.

## Steps

Each step is its own reviewed PR or run and waits for the owner's words for that step.

1. Staging: the staging executor must carry SQL 159 first (executor package refresh through the guarded staging executor
   `deploy` mode, its own reviewed run). Then `read-live` for `sql159-homeowner-intro-requests-select-grant`. Expected
   `already_applied` true (live `d1677f1c…`, staging already holds the grant), or `already_applied` false with
   `precondition_failures` `[]` and live `6170e77b…`, then a reviewed staging pin change (`expected_live_definition_sha256`,
   owner-approved `authorization`, `execute: true`), `apply`, and `read-live` again. Anything else: stop.
2. Production: with the owner's OK for that read, the read-only inspect on the runner
   (`node scripts/deployment-guard/production-sql-one-shot.mjs --migration sql159 … --phase inspect`); record
   `production_inspect`, copy `live_definition_sha256` into `expected_live_definition_sha256`, record the staging runs in
   `staging_acceptance`, set an owner-approved `authorization` and `execute: true`, in one reviewed change.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs --migration sql159
   --approval-scope sql159 … --phase apply` with the owner's words (authorization phrase
   `GRANT_HOMEOWNER_INTRO_REQUESTS_SELECT`).
4. Record the apply and retire the pin (`execute: false`).

Rollback (not part of this pin; a reviewed step of its own if ever needed): `REVOKE SELECT ON TABLE
public.homeowner_intro_requests FROM checksops`.
