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
same rule (`aws_can_access_deposit_item`). The Deposit Manager and Owner Queue screens show only the
caller's tenants.

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

**Status:** staging pin execute-authorized (wave 24); nothing applied yet; production pin pending.

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
   `execute: true`) in a reviewed change, `apply`, then `read-live` again. Check the Deposit
   Manager and Owner Queue screens on staging as a member of one tenant.
2. Production: run the read-only inspect on the runner
   (`node scripts/deployment-guard/production-sql-one-shot.mjs --migration sql125 … --phase inspect`);
   record `production_inspect` and copy `live_definition_sha256` into
   `expected_live_definition_sha256`; record the staging runs in `staging_acceptance`; set an
   owner-approved `authorization` and `execute: true`, in one reviewed change.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs
   --migration sql125 --approval-scope sql125 … --phase apply` with the owner's words.
4. Record the apply and retire the pin (`execute: false`).
