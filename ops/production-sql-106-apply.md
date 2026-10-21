# Production SQL 106 (the step-up log append-only), before SQL 97

| key | file | what it does |
|---|---|---|
| `sql106` | `aws/workflows/sql/106_financial_stepup_log_append_only.sql` (sha256 `b7b4f3f3cb0293a1c95f9ae87ad7e6b12375dd6336630f1d0c834b5e55f68f2c`) | `REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.financial_stepup_log` from `PUBLIC`, `checksops`, `authenticated` and `anon` (a role that is absent is skipped; a privilege that is not held is a no-op). Nothing else: SELECT and INSERT unchanged for every role, no change for the owner or `service_role`, no RLS, policy, trigger or row change. |

**Why.** SQL 97 (`aws/workflows/sql/97_financial_stepup_log_server_writer.sql`) refuses a
client-shaped `app_financial_totp` step-up row with a BEFORE INSERT trigger, but nothing stops
a role that keeps UPDATE from rewriting an existing row's `metadata` into one, or a role that
keeps DELETE or TRUNCATE from removing the audit trail. Its review note
(`ops/production-sql-90-97-apply.md`) says to stop before applying SQL 97 if its inspect's
`release_sql_inspect.table_privileges[0].other_write_grants` is not `[]`. The read-only
production inspect of SQL 97 (2026-10-21, SSM `16bcba87-7ad4-48b1-a63b-a2de20d25eee`, main
`dcd86525690e0732691ab7bf0723dc25167d89e9`) reported `lines: ["checksops INSERT"]` and
`other_write_grants: ["checksops DELETE", "checksops UPDATE"]`, so SQL 97 was not applied. The
owner decided to close that with a new migration ("build SQL 106 and merge when green"), not an
edit to SQL 97: SQL 97's file, pins and fingerprints (`e3c8fd41…`, pre-state `56b1f631…`,
intended `5d9b50f5…`) are unchanged.

**No server path updates or deletes step-up rows** (checked on main 2026-10-21):
`auth-financial-totp.mjs` (`insertAppStepUpLog`) and `admin-reset-totp.mjs`
(`RESET_TOTP_CONSUME_SQL`, "the table is insert-only") write it with INSERT only;
`moov-fund-authz.mjs`, `checkalt-authz.mjs` and `admin-reset-totp.mjs` read it with SELECT; the table is in the read allowlist
(`allowed-tables.json`) but not in `WRITE_ALLOWLIST`, so `/data/write` refuses it; no Supabase
function, retention job, script or SQL migration updates, deletes or truncates it (the
rehearsal script `aws/db-copy/rehearsal/scripts/bridge-db-rehearsal.mjs` writes it only in an
isolated rehearsal database). `trg_financial_stepup_log_updated_at` is a BEFORE UPDATE trigger:
it only fires on an UPDATE and stays as it is.

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec
`table_privileges` in `release-sql-specs.mjs`): the UPDATE, DELETE and TRUNCATE lines of
`PUBLIC`, `anon`, `authenticated` and `checksops` on the table (with grant option where held),
which must be none, or `absent`. Intended
`0a159961b80a1887b551d7bc9f187811f62614ef352c00b12bbfe621f109088f`:

```
release sql106 v1
privileges public.financial_stepup_log UPDATE,DELETE,TRUNCATE: 
```

Every other grant on the table (SELECT and INSERT of every role, `service_role`'s, the
owner's) is outside the fingerprint; the post-condition `other_table_privileges_unchanged`
requires it unchanged. SQL 97's fingerprint covers only the INSERT lines of `PUBLIC`,
`authenticated` and `checksops`, its guard function and its trigger, so SQL 106 leaves SQL 97's
live fingerprint as it was, before or after SQL 97.

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present` (the table, roles `checksops` and `authenticated`; `anon` is optional);
`altered_relations_owned_by_login` (the login owns the table, so its REVOKEs take effect on the
owner's grants). No predecessor. A table that holds any subset of the revoked lines passes. A
grant made by another grantor than the owner is not revoked by the owner's REVOKE; the
post-condition `intended_state` then fails and the tools roll back.

Post-conditions: the intended fingerprint; `other_table_privileges_unchanged`; everything else
in schema `public` (and the functions of `auth`) unchanged, the table's ACL excepted. The tools
roll back otherwise.

## Order

**Before SQL 97 in production.** SQL 97 follows SQL 106, with its own run-time approval, once its
inspect reports `other_write_grants` `[]` (its runbook step 7). Both were applied to production on
2026-10-21 in that order (see "Production apply of SQL 106" below). This is recorded in the pin (`order_note`), the
spec (`runs_before: ["sql97"]`) and the one-shot registry (`ONE_SHOT_TOOLS.sql106.runs_before`),
as SQL 103 → SQL 29 was. It is informational: SQL 97's tooling does not refuse on
`other_write_grants` (not a precondition rule), so the operator reads it in SQL 97's one-shot
inspect step and stops if it is not `[]`. In staging SQL 97 is already applied (wave 4), and SQL
106 runs after it there; no later migration grants these privileges back, so SQL 106 is not
re-run. No Lambda member waits on SQL 106 (no `sql_before`, no plan entry).

## Status

- **Production inspect recorded (2026-10-21).** Read-only `--inspect` through SSM
  `4539d0f0-b715-42f6-ba19-ef03252e87c7` on `i-0c35557c4e5385406`, main `fd1e059b5`
  (tarball sha256 `72a7355b26183e3621eec75a09b8b54eeef7a9f507ed23eacd2731775df64238`, transfer
  run 39633912868): `table_privileges[0].lines` `["checksops DELETE", "checksops UPDATE"]`,
  `other_write_grants` `[]`, live `56b5e4bb1a2db3133c32c9cc3cca02c1e7fb876839544dbdfd0717aad8f25880`,
  `already_applied` false, `precondition_failures` `[]`. Recorded in the pin as
  `expected_live_definition_sha256`.
- **Staging: substitute evidence.** SQL 106 was already in effect in staging: read-live run
  39633390440 (main `588bda34`) reported `already_applied` true, live = intended, `lines` `[]`. The
  owner accepts it as substitute evidence by reviewing and merging the pin change.
- **Pin `execute: true`** once that change is merged (#1120). Nothing is applied by it; the apply
  (step 3) needs the owner's own approval statement for that run.
- **Applied to production (2026-10-21)** and the pin retired (`execute: false` again; see
  "Production apply of SQL 106" below). SQL 97 followed (step 5).

## Steps

1. Staging: the staging executor must carry SQL 106 first (executor package refresh through
   `sql-executor-ensure.mjs` / the guarded staging executor `deploy` mode, its own reviewed run).
   Then run the guarded staging SQL executor with `read-live` for
   `sql106-financial-stepup-log-append-only`. Which UPDATE, DELETE or TRUNCATE grants staging
   holds on the table is not recorded in the repository, so either outcome is possible:
   - `already_applied` false and `precondition_failures` `[]`: record `LIVE_DEFINITION_SHA256`
     in the staging pin (`expected_live_definition_sha256`, owner-approved `authorization`,
     `execute: true`) in a reviewed change, `apply` with the owner's approval of that run, then
     `read-live` again (expected `already_applied` true);
   - `already_applied` true (staging holds none of the lines): nothing to apply; the read-live
     is the staging evidence, accepted by the owner as substitute evidence in the production pin
     change.
   If the read-live reports anything else (a precondition failure, a grantee outside the four),
   stop and record it in its own reviewed change.
2. Production: run the read-only inspect on the runner
   (`node scripts/deployment-guard/sql106-financial-stepup-log-append-only-production-apply.mjs --inspect`,
   or the one-shot's `--phase inspect`); record `production_inspect` and copy
   `live_definition_sha256` into `expected_live_definition_sha256`; record the staging runs in
   `staging_acceptance`; set an owner-approved `authorization` and `execute: true`, in one
   reviewed change. Expected: `release_sql_inspect.table_privileges[0].lines`
   `["checksops DELETE", "checksops UPDATE"]` (SQL 97's inspect of 2026-10-21),
   `already_applied` false, `precondition_failures` `[]`.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs
   --migration sql106 --approval-scope sql106 … --phase inspect`, then the owner-named
   `--phase apply`.
4. Record the apply and retire the pin (`execute: false`).
5. Then SQL 97 (`ops/production-sql-90-97-apply.md` step 7): its one-shot inspect must report
   `other_write_grants` `[]` and the same `live_definition_sha256` its pin records
   (`56b1f631…`), and its apply needs the owner's run-time approval for SQL 97.

## Production apply of SQL 106 (2026-10-21)

One owner approval statement, passed verbatim (base64, `--approval-statement-b64`) to the SQL 106
and the SQL 97 runs: "apply SQL 106 and SQL 97 in production" (the one-shot cannot verify who said
it; it covered those runs only). `production-sql-one-shot.mjs --migration sql106 --approval-scope
sql106` on `i-0c35557c4e5385406`, operator `michaelcarletta-cmd`, workstream
`prod-sql106-financial-stepup-log-append-only-20261021`, from main `7124a160b` (tarball
`source-7124a160b9848d6334bc4328d69e9404aebddff3.tar.gz`, sha256 `48713c46…`, transfer run
`39640540760`, `sql53-temporary-transfer.yml` dispatched on main at 2026-10-21T17:04:43Z; its
upload job printed `TARBALL_SHA256 48713c464437e21c91dd63360fe33c27495918c332a32951ac8f3ec692089dde`).

- **Inspect phase:** SSM `78e335e7-b844-4fbe-8c81-ebccdcd737c2`, run_id
  `458bd072-8cdf-4611-91ff-1bbdf5aebd2b`: pin, source, inspect and contracts ok, nothing written;
  live `56b5e4bb…` (live_matches_expected true), `lines` `["checksops DELETE", "checksops UPDATE"]`.
- **Apply phase:** SSM `43070c9e-2bb5-4e49-80f3-97fe6f35e3d0` (2026-10-21T17:18:15Z to 17:18:25Z),
  run_id `0ae3e5dc-a34f-4799-ba75-d79a9b2ade28`, one_use_id
  `sql106-prod-c994fcc1-bbff-414b-bfad-3b864d96d4a6` (spent): every step ok (pin, source, inspect,
  contracts, manifest, source-recheck-before-preflight, preflight, evaluate,
  source-recheck-before-apply, apply (applied), post-apply-inspect); migration source `b7b4f3f3…`
  (== pin); contracts claim-ledger 4/4, tenant-isolation 6/6, financial-write-protections 43/43;
  pre-apply inspect live `56b5e4bb…`, precondition_failures []; manifest `8ca15d2d…`; receipt
  `56b5e4bb…` -> `0a159961…`, result applied, unrelated catalog `22332dfc…` (relations 890, columns
  3535, constraints 2233, policies 404, functions 1312, indexes 654, triggers 179, views 25, types
  18, roles 29, role memberships 15); post-apply inspect live `0a159961…`, already_applied true,
  precondition_failures [], `lines` `[]`, `other_write_grants` `[]`.

No later read-only inspect was run. The pin is `execute: false` again; a re-apply needs a new
reviewed pin change (and SQL 106 is not re-run: no later migration grants these privileges back).
SQL 97 followed under the same statement (`ops/production-sql-90-97-apply.md`, "Production apply
of SQL 97").
