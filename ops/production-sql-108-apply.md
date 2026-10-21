# Production SQL 108 (check_intake_items funds_type values)

| key | file | what it does |
|---|---|---|
| `sql108` | `aws/workflows/sql/108_check_intake_items_funds_type_values.sql` (sha256 `89cea9c9bac16ebddbfb32aeff55e46a630b87bf28a011ba894b33d0d2412a49`) | Replaces `public.check_intake_items_funds_type_check` with `CHECK (funds_type IS NULL OR funds_type IN (…nine values…))`. Only from the exact five-value predecessor; refuses (`sql108_invalid_rows`) if a row would violate the new constraint; a no-op when the constraint already allows exactly the nine values. Nothing else: no column, grant, policy, trigger, other constraint or row change. |

**Why.** The constraint was added on Supabase
(`supabase/migrations/20260506145529_61e262df-66f0-4b5d-b477-5f4fa7add9d6.sql`) with five values:
`acv`, `rcv`, `recoverable_depreciation`, `supplement`, `overhead_and_profit`. No migration in
`aws/` changed it. The SPA's Funds Type pickers (`FUNDS_TYPE_OPTIONS` in
`src/features/check-command/status.ts`, used by `FundsTypeField` in
`src/pages/CheckCommandCenter.tsx`, and the Check Classification select in
`src/components/check-review/CheckReviewConsole.tsx`) also offer `deductible`,
`other_structures`, `personal_property` and `additional_living_expenses`. The API passes
`funds_type` through as text (`write-check-workflow.mjs` `intakeCoerce`, `workflow.mjs`), so the
database refuses each save of those four:

- production, `/aws/lambda/checksops-production-prep-api`, 2026-10-21 15:57:52, 15:58:10,
  15:58:32, 15:58:45 and 15:58:54 UTC, route `/prep/data/write`, request ids
  `FmgYKjjxIAMEJxw=`, `Fmga8hcrIAMEctg=`, `FmgeYh_xIAMEJ1Q=`, `FmggeirXoAMEJZw=`,
  `Fmgh3i9bIAMEcUw=`: `data_query_failed`, `new row for relation "check_intake_items" violates
  check constraint "check_intake_items_funds_type_check"`, status 503;
- staging, `/aws/lambda/checksops-staging-api`: the same message on 2026-09-12 (three) and
  2026-10-01 (two, `/staging/workflow/checks`).

The refused UPDATE is one statement, so nothing of it is saved. The Check Classification select
in `CheckReviewConsole.tsx` sets its local value before the save and keeps it after a failure
(only a "Save failed" toast), which is why the value looked saved.

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec
`constraints` in `release-sql-specs.mjs`): the constraint's `pg_get_constraintdef` (sha256) and
its validated flag, or `absent`. Intended
`a796a3966009ceb9db4bcc43c4a75cc1a15753954e4f469abe77174eaccceaa5`:

```
release sql108 v1
constraint public.check_intake_items check_intake_items_funds_type_check: bf82bff31a8fbb5c4ac7ad063ddb8d48f0ef84f77e708993969c736746e0d99d validated=true
```

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present` (the table); `altered_relations_owned_by_login` (the login owns
`check_intake_items`, as for SQL 95). No predecessor. The file itself refuses a missing
constraint or any definition other than the five-value list
(`sql108_unsupported_funds_type_check`) and rows outside the nine values
(`sql108_invalid_rows`). Post-conditions: the intended fingerprint and everything else in schema
`public` unchanged; the tools roll back otherwise.

## Order

Independent of every other migration (no predecessor, nothing waits on it, no Lambda member and
no SPA change). The SPA already sends the nine values.

## Status

- **Staging executor refreshed (2026-10-21).** Inspect run 39656814885 (main `20059c9d3`) found the
  live executor at CodeSha256 `cRNuRg2R…` without SQL 108 (adds only
  `sql/108_check_intake_items_funds_type_values.sql`, supersedes the three engine files, nothing
  dropped, no collisions). Deploy run 39657106517 updated it to
  `KR/KUKLCKc0zrSAHtvIlc5wr+JBVGW/MFXJmhaUqVc8=`.
- **Staging read-live (2026-10-21).** Run 39657370816 (main `20059c9d3`, executor `KR/KUKLC…`):
  constraint `different`, live `c83dcc9b97b84d294a743063adb0c1f5231f5c37ade2f00d65dc134a1d55cf00`
  (the release engine's fingerprint of exactly the Supabase five-value definition, validated),
  `already_applied` false, `precondition_failures` `[]`. Recorded in the staging pin
  (`expected_live_definition_sha256`, `execute: true`, wave 9) under the owner's statement of
  2026-10-21, "apply SQL 108 in production then DEPLOY WEBSITE TO PRODUCTION then APPLY API
  CONFIGURATION TO PRODUCTION", which covers SQL 108's whole guarded path.
- Staging apply and the second read-live: not run yet. The production pin stays pending.

## Steps

1. Staging: the staging executor must carry SQL 108 first (executor package refresh through
   `sql-executor-ensure.mjs` / the guarded staging executor `deploy` mode, its own reviewed run).
   Then run the guarded staging SQL executor with `read-live` for
   `sql108-check-intake-items-funds-type-values`. Expected: `already_applied` false,
   `precondition_failures` `[]`. Record `LIVE_DEFINITION_SHA256` in the staging pin
   (`expected_live_definition_sha256`, owner-approved `authorization`, `execute: true`) in a
   reviewed change, `apply` with the owner's approval of that run, then `read-live` again
   (expected `already_applied` true). Anything else: stop and record it in its own reviewed
   change.
2. Production: run the read-only inspect
   (`node scripts/deployment-guard/sql108-check-intake-items-funds-type-values-production-apply.mjs --inspect`,
   or the one-shot's `--phase inspect`); record `production_inspect`, copy
   `live_definition_sha256` into `expected_live_definition_sha256`, record the staging runs in
   `staging_acceptance` and set an owner-approved `authorization` and `execute: true`, in one
   reviewed change. Expected: the constraint present with the five values, `already_applied`
   false, `precondition_failures` `[]`.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs
   --migration sql108 --approval-scope sql108 … --phase inspect`, then the owner-named
   `--phase apply`.
4. Record the apply and retire the pin (`execute: false`).
