# Production SQL 158 (checksops SELECT on homeowner intro requests: a contractor's Leads list)

| key | file | what it does |
|---|---|---|
| `sql158` | `aws/workflows/sql/158_homeowner_intro_requests_select_grant.sql` (sha256 `675516f839057c350ab59c01fd90ac9d8802f192df4a905c57a04b78412f7e32`, authored by `4136f3004`) | Refuses without the table (`42P01 sql158_table_missing`) or the role (`42704 sql158_role_missing`); then `GRANT SELECT ON TABLE public.homeowner_intro_requests TO checksops`. Nothing else. |

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

**Status:** tooling built; staging and production pins pending (`execute: false`). Nothing applied or read.

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec `sql158` in
`release-sql-specs.mjs`, `table_privileges` as SQL 104). Intended `4014fdf9a1622b06ffd3bee3fd6891ac7eca61d661aa3545a26230ae0730630b`:

```
release sql158 v1
privileges public.homeowner_intro_requests SELECT: checksops SELECT
```

**Expected pre-state (production).** The table present and `checksops` without SELECT on it (no line):

```
release sql158 v1
privileges public.homeowner_intro_requests SELECT: 
```

That is `4ae9a98cc5e45a840383924fcd5870dcfb6ed231c3804274fc032233036a7ff2` (`releaseStateHash('sql158', { privileges:
{ 'public.homeowner_intro_requests': { exists: true, lines: [] } } })`). The table missing renders

```
release sql158 v1
privileges public.homeowner_intro_requests: absent
```

(`34f66cde89c35735c565f6ae7fa8772dc66ff26141cb330f44d4ea3f5edd9aa2`, `releaseStateHash('sql158', {})`), and the file refuses
it (`sql158_table_missing`). Staging
is expected to read the intended state already (its staging-only grants), so its read-live reports `already_applied`
true and needs no apply. Each pin records its own environment's read; neither value is written into a pin before a run
reads it. A pre-state other than these is a stop.

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present` (the table and the role `checksops`); `other_table_privileges_unchanged`; the applying login owns
`public.homeowner_intro_requests` (`altered_relations`).

Post-conditions: the intended fingerprint; everything else in schema `public` unchanged. The tools roll back otherwise.

## Steps

Each step is its own reviewed PR or run and waits for the owner's words for that step.

1. Staging: the staging executor must carry SQL 158 first (executor package refresh through the guarded staging executor
   `deploy` mode, its own reviewed run). Then `read-live` for `sql158-homeowner-intro-requests-select-grant`. Expected
   `already_applied` true (live `4014fdf9…`, staging already holds the grant), or `already_applied` false with
   `precondition_failures` `[]` and live `4ae9a98c…`, then a reviewed staging pin change (`expected_live_definition_sha256`,
   owner-approved `authorization`, `execute: true`), `apply`, and `read-live` again. Anything else: stop.
2. Production: with the owner's OK for that read, the read-only inspect on the runner
   (`node scripts/deployment-guard/production-sql-one-shot.mjs --migration sql158 … --phase inspect`); record
   `production_inspect`, copy `live_definition_sha256` into `expected_live_definition_sha256`, record the staging runs in
   `staging_acceptance`, set an owner-approved `authorization` and `execute: true`, in one reviewed change.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs --migration sql158
   --approval-scope sql158 … --phase apply` with the owner's words (authorization phrase
   `GRANT_HOMEOWNER_INTRO_REQUESTS_SELECT`).
4. Record the apply and retire the pin (`execute: false`).

Rollback (not part of this pin; a reviewed step of its own if ever needed): `REVOKE SELECT ON TABLE
public.homeowner_intro_requests FROM checksops`.
