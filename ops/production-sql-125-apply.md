# Production SQL 125 (the deposit views read as the caller)

| key | file | what it does |
|---|---|---|
| `sql125` | `aws/workflows/sql/125_deposit_views_security_invoker.sql` (sha256 `fc8096a3e7b4b71b05edfc80815aeca43d45bcacff9bc7486065aed34ba4d943`) | Sets `security_invoker = true` on the four Supabase-era deposit views, so a query through them reads `deposit_items`, `deposit_exceptions` and `deposit_attachments` under their RLS instead of as their owner. |

**Why.** Security audit 2026-10-29, finding 1 (owner, 2026-10-29: "start finding 1's migration
PR", then "Proceed with option 1"). `deposit_queue_scored`, `deposit_owner_performance`
(`supabase/migrations/20260308181449_*.sql`), `deposit_reminder_queue` (`20260308173916_*.sql`)
and `deposit_aging_dashboard` (`20260308173238_*.sql`) were created without
`security_invoker`. The restore left them owned by `checksops_admin`, which also owns the three
deposit tables, so a query through a view skipped their RLS. All four are on the API's read
allowlist (`aws/functions/api/allowed-tables.json`) and `checksops` holds SELECT on them: any
signed-in user of any tenant could `POST /data/query {"table": "deposit_queue_scored"}` and read
every tenant's open deposit items (amount, check number, carrier, claim, owner, status, exception
counts).

**What it changes.** `ALTER VIEW ... SET (security_invoker = true)` on the four views, each only
when present and owned by the applying login (42501 `sql125_not_view_owner` otherwise). Through a
view, a member then reads the deposit items of their own tenants' checks
(`aws_select_deposit_items`: `aws_can_access_check_non_partner(check_id)`), the platform owner
what that helper gives it, a partner tenant nothing; the exception and attachment counts follow the
same rule (`aws_can_access_deposit_item`). A `POST /data/query` on any of the four views then
returns only the caller's tenants' rows. No routed screen reads these views (on main `4f26c14`,
`DepositOwnerQueue`, `DepositAgingDashboard` and `DepositManagerCommandCenter`, which holds
`DepositManagerWorkflows`, are imported by no page), so no screen changes; the exposure was the
data API.

Not changed: no view definition, column or comment; no grant (`checksops` keeps SELECT on the
views, the views stay on the API allowlist); no table, policy, RLS setting, function, trigger or row.
The Supabase-era SECURITY DEFINER functions that read `deposit_owner_performance` and
`deposit_queue_scored` (the deposit KPI and digest functions) run as their owner, so through them
the views stay global: that is the separate finding on those functions. No trigger is added, so the
DB validator's public trigger count is not concerned.

**Staging executor refreshed (2026-10-29).** Inspect run 40885358014 found the live executor at
`7UUN4EHi…` without `sql/125_deposit_views_security_invoker.sql`. Deploy run 40885862573 (main
`8b231c3`) updated it to main's package ("Verify live executor now carries main's package" passed).

**Staging read-live (2026-10-29).** Run 40886747687 (main `a0c5c51`): the four views present, each
`different` from the intended state; `prerequisites_missing` `[]`, `precondition_failures` `[]`,
`already_applied` false; live
`9b31cf5dad3f82bf69fcddd03e0c26c0dc0fdd5ff6bd40137d1af316f1fd6541`, which the engine derives from the four reviewed
definitions without options (so the definitions are the reviewed ones and only `security_invoker`
is missing). Recorded in the staging pin (`expected_live_definition_sha256`, `execute: true`,
wave 24) under the owner's words of 2026-10-29, "open the SQL 125 staging pin PR".

**Staging apply (2026-10-29).** After #1380 merged the staging pin (main `4f26c14`), under the
owner's words of 2026-10-29, "merged 1380, start the SQL 125 staging apply", each run approved by
the owner in the GitHub `staging` environment:

- Inspect run 40890156931: live executor `TiHjGOKZ+OpHdVdQ8RgqSPelA579PDmzGamSkL8C+E8=` (deploy run
  40885862573); main supersedes only `lib/sql-executor-auth.mjs`; no collisions.
- Deploy run 40892051066: executor now `yHVZNx1R3mTcbyneZrWzSptd7qDIcD49ckM5DTehFZ4=` (revision
  `8ce5236f-4089-4576-b991-87e5ab6babec`); "Verify live executor now carries main's package" passed;
  staging API untouched.
- Apply run 40892707444 (workstream `github-staging-sql-40892707444`, pin commit `c0e9d1e`): receipt
  before `9b31cf5dad3f82bf69fcddd03e0c26c0dc0fdd5ff6bd40137d1af316f1fd6541`, after
  `a041efa5d6b8e564c860974d2427415ec3e031a8a63daf43005e893e2d55ddea` (intended), result `applied`;
  the four views `intended`, `prerequisites_missing` `[]`.
- Read-live run 40893116553: live `a041efa5…`, the four views `intended`.

**Production inspect (2026-10-29).** Read-only `--inspect` through SSM
`9e7ea74b-ced1-4407-9622-d1902720aa9d` on `i-0c35557c4e5385406`, main `4f26c14` (tarball sha256
`834bf3c4ed405b7dc227f7799fbe86c4f98d7c2806b67f890a72765ca5171e49`, transfer run 40894708257, migration
source `fc8096a3…` == pin), connected as `checksops_admin`: the four views present; every prerequisite
present; live `9b31cf5dad3f82bf69fcddd03e0c26c0dc0fdd5ff6bd40137d1af316f1fd6541`, `already_applied` false, `precondition_failures` `[]`, the same pre-state as
staging's (the reviewed definitions without options). The runner was started for the run and stopped
after it (start requested 14:47:15 UTC, stopped 14:48:16 UTC). Recorded in the production pin with the
staging apply as its staging acceptance and `execute: true` under the owner's words of 2026-10-29, "open
the SQL 125 production pin PR". The owner merges the pin change; the apply still needs the owner's
run-time approval and runs only after that merge is on main and staged.

**Production apply (2026-10-29).** After the pin change (#1382, merged green on the owner's words "merge
1382 when green"), transfer run 40897690604 staged main `1cc1737` (tarball sha256
`b19123e27fccd48450d13a62357540d295cb9c785300fdb106b1a3e30d94eca4`). One-shot `--phase inspect` (SSM
`c8ffbcec-ab7f-49e5-ae21-a59414abee2f`: live `9b31cf5d…`, `precondition_failures` `[]`) then `--phase apply`
run `9e5a075d-3813-4567-aa0a-71ff86cf916e` through SSM `31ecaddd-b118-4239-a9e8-fb6e1c461db1`, workstream
`prod-sql125-deposit-views-security-invoker-20261029`, under the owner's words "apply SQL 125 in production
after 1382 merges" (passed verbatim): every step ok, contracts 4/4, 6/6 and 43/43; receipt `9b31cf5d…` →
`a041efa5d6b8e564c860974d2427415ec3e031a8a63daf43005e893e2d55ddea` (intended), result `applied`; post-apply
inspect `already_applied` true, `precondition_failures` `[]`; a separate read-only inspect (SSM
`0a95b440-0900-428e-bf84-a87eaee64012`) agreed. The receipt's unrelated-catalog hash was not captured (the
operator printed a summary and the first 6000 characters of the run's JSON); the pin's `applied` block
leaves it out and says so. An earlier attempt (SSM `ef080c3f-9b86-448c-a749-d65d0631eeeb`) ran only the
read-only inspect and stopped on the operator's own gate; nothing was written. Runner (finding C): started
and stopped for each attempt, 15:05:22 to 15:06:48 UTC and 15:07:19 to 15:09:11 UTC; it is stopped.

**Status:** applied to staging (wave 24) and to production (2026-10-29); the production pin is retired
(`execute: false`). Security audit finding 1 is closed in production.

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec
`sql125` in `release-sql-specs.mjs`): each view's collapsed `pg_get_viewdef` hash (the supabase
migration's view as PostgreSQL 16 renders it, re-derived by
`aws/tests/release-sql125-executor.test.mjs`) and its options. The views' options are left out of
the unrelated relations snapshot for these four only (PR #1372); their owner, ACL and RLS flags are
still compared. Intended
`a041efa5d6b8e564c860974d2427415ec3e031a8a63daf43005e893e2d55ddea`:

```
release sql125 v1
view public.deposit_queue_scored: def=1d363834642bb98ec9a1f84930418eae0fa1b41d7e8e6ea7058675033278ef00 options=security_invoker=true
view public.deposit_owner_performance: def=6845782430901e1b5d003dd2c4dd96016f2ab1073fa756217f0024d2c3b9894b options=security_invoker=true
view public.deposit_reminder_queue: def=38931bee601466624a312b211a942f269f786f96324ae9c4f91bac7d354f4a2d options=security_invoker=true
view public.deposit_aging_dashboard: def=8aa397f4a269d72516a0fcbad3f641aac0ccb747cb9773052a9d2c87bf8551f1 options=security_invoker=true
```

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present` (the four views); `altered_relations_owned_by_login` (each view owned by the
applying login). A production view whose definition is not the reviewed one does not reach the
intended fingerprint, and the tools roll back.

Post-conditions: the intended fingerprint; the views' owner unchanged; everything else in schema
`public` (and the functions of `auth`) unchanged. The tools roll back otherwise.

## Steps

1. Staging: the staging executor must carry SQL 125 first (executor package refresh through the
   guarded staging executor `deploy` mode, its own reviewed run). Then run the guarded staging
   SQL executor with `read-live` for `sql125-deposit-views-security-invoker`. If it reports
   `prerequisites_missing` other than `[]`, `precondition_failures` other than `[]`, or a view
   definition hash other than the reviewed one, stop. Otherwise record `LIVE_DEFINITION_SHA256` in
   the staging pin (`expected_live_definition_sha256`, owner-approved `authorization`,
   `execute: true`) in a reviewed change, `apply`, then `read-live` again. The check is that
   read-live: `already_applied` true at the intended fingerprint. No routed screen reads these
   views, so there is no screen to check.
2. Production: run the read-only inspect on the runner
   (`node scripts/deployment-guard/production-sql-one-shot.mjs --migration sql125 … --phase inspect`);
   record `production_inspect` and copy `live_definition_sha256` into
   `expected_live_definition_sha256`; record the staging runs in `staging_acceptance`; set an
   owner-approved `authorization` and `execute: true`, in one reviewed change.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs
   --migration sql125 --approval-scope sql125 … --phase apply` with the owner's words.
4. Record the apply and retire the pin (`execute: false`).
