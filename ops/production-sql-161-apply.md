# Production SQL 161 (EXECUTE for `checksops` on the mortgage handling trigger function)

| key | file | what it does |
|---|---|---|
| `sql161` | `aws/workflows/sql/161_tg_mortgage_handling_billing_checksops_execute.sql` (sha256 `519d15b1c7bcfd0cc27b5b1c0d08916729b28c9f007fefb8b8e701b6f865c98d`, authored by `17306ac9d`) | After checking that the function exists (42883 `sql161_function_missing`) and that the role `checksops` exists (42704 `sql161_role_missing`): `GRANT EXECUTE ON FUNCTION public.tg_record_mortgage_handling_billing() TO checksops`. Nothing else. |

**Why.** SQL 160 (`ops/production-sql-160-apply.md`) replaces four billing functions with CREATE OR REPLACE and no
GRANT or REVOKE, so each keeps its live ACL, and its spec fingerprints the ACL production holds
(`ops/deployment-guard/billing-trigger-inspect.json` `production_inspect.observed_functions`). The guarded staging SQL
executor read-live of SQL 160 on 2026-11-12 (run 43307779123, mode `read-live`, approved commit
`83a508fb10b32c30ff702231443ff11f7df68163`) reported `already_applied` false and `precondition_failures` `[]`, and these
staging ACLs:

| function | staging EXECUTE | production EXECUTE |
|---|---|---|
| `record_check_billing_event()` | `checksops`, owner | the same |
| `accrue_mortgage_ops_billing(uuid)` | `PUBLIC`, `authenticated`, `checksops`, owner | the same |
| `earn_mortgage_agent_compensation(uuid)` | owner | the same |
| `tg_record_mortgage_handling_billing()` | `PUBLIC`, owner | `PUBLIC`, `checksops`, owner |

CREATE OR REPLACE keeps the ACL, so in staging SQL 160's post-state could never equal its intended fingerprint
(`fae1623b…`) and its apply would roll back (post-condition `intended_state`). Owner 2026-11-12: "A new SQL 161 that
gives staging that one permission, then SQL 160".

**What it does.** One GRANT: `checksops` gets EXECUTE on `public.tg_record_mortgage_handling_billing()` (run by
`tr_record_mortgage_handling_billing` on `check_intake_items`). Afterwards the function's EXECUTE ACL is `PUBLIC`,
`checksops` and the owner, each granted by the owner: the ACL production already holds (owner `checksops_admin`, every
grant by `checksops_admin`).

Not changed: no REVOKE (`PUBLIC` and the owner keep EXECUTE); the function's body, language, `SECURITY DEFINER`,
`search_path`, result and owner; the trigger; the other three SQL 160 functions; SQL 160's file, spec, pins and
evidence; any table, column, policy, RLS setting, other grant, trigger or row. No API, Lambda or SPA change is part of
this file or its pins. No trigger is added.

**Status:** tooling built; staging and production pins pending (`execute: false`). Nothing applied or read.

## Order

No predecessor (spec `predecessors` `[]`). SQL 160 does not name SQL 161, and SQL 161 is not a predecessor of SQL 160
(SQL 160's spec is not changed). In staging SQL 161 runs before SQL 160 by the order of work (wave 52 when approved,
then SQL 160's wave 51 apply). In production SQL 161 is expected to be a no-op (below), so it adds nothing to SQL 160's
production order. `production-api-overlay-plan.json` has no entry for SQL 161: it holds no Lambda member.

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec `acl_functions` in
`release-sql-specs.mjs`, `render.grantors`, no `attributes`, `revokes` `[]`): the function's EXECUTE ACL with each
entry's grantor (the owner read as `owner`), or `absent`. Intended
`b916bcb512896ba7a90ac4401ad1903b18482d27e3173e8ccef21112eb4506f8` (`releaseIntendedHash('sql161', file bytes)`):

```
release sql161 v1
function_acl public.tg_record_mortgage_handling_billing(): acl=PUBLIC EXECUTE grantor=owner;checksops EXECUTE grantor=owner;owner EXECUTE grantor=owner
```

The same in staging and production (owner names are not part of it). The body is not part of it: the post-condition
`acl_functions_otherwise_unchanged` requires everything but the ACL unchanged.

**Expected pre-states.** Each is derived from the spec by `aws/tests/release-sql161-executor.test.mjs`
(`releaseStateHash('sql161', …)` of the intended state with that ACL) and read back from a PostgreSQL 16 database:

| environment | EXECUTE | fingerprint under `sql161` | from |
|---|---|---|---|
| staging | `PUBLIC`, owner (each granted by the owner) | `72031400264a910912cecd832ac0bf8486da7b67acfd036bc66aff6820258448` | SQL 160's staging read-live, run 43307779123 |
| production | `PUBLIC`, `checksops`, owner (each granted by the owner) | `b916bcb512896ba7a90ac4401ad1903b18482d27e3173e8ccef21112eb4506f8` (the intended state: `already_applied` true) | `billing-trigger-inspect.json` `observed_functions` (every grant by `checksops_admin`) |

Staging's pre-state:

```
release sql161 v1
function_acl public.tg_record_mortgage_handling_billing(): acl=PUBLIC EXECUTE grantor=owner;owner EXECUTE grantor=owner
```

Each pin records its own environment's read; neither value is written into a pin's
`expected_live_definition_sha256` before a run reads it. SQL 160's read-live did not print grantors; the grantor
`owner` is the expectation, not yet observed in staging. An entry granted by another role or with grant option, or any
other grantee, is refused (`acl_functions_acl_replaceable`): that is a stop.

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present` (the function, role `checksops`); `acl_functions_present`; `acl_functions_owned_by_login`;
`acl_functions_acl_replaceable` (every live entry is `PUBLIC EXECUTE`, `checksops EXECUTE` or `owner EXECUTE` granted
by the owner, all of which the file keeps; nothing with grant option, nothing from another grantor, no other grantee).

Post-conditions: the intended fingerprint; `acl_functions_otherwise_unchanged` (body, language, volatility,
`SECURITY DEFINER`, `proconfig`, result type and owner as before); everything else in schema `public` unchanged. The
tools roll back otherwise.

## How the tools treat a database already in the intended state (production)

The inspect reports `already_applied` true, `apply_preconditions_met` false and `precondition_failures` `[]`. An apply
against it is refused before the file runs (`UNRELATED_MUTATION`: already in place), and a pin that recorded that state
as its pre-state cannot be bound: a manifest whose expected live hash equals the intended one is refused before
connecting (`INVALID_MANIFEST`). The file itself is a no-op there. So where production reads as intended, no
production apply is run: the read-only inspect is the production acceptance and the production pin stays pending, as
SQL 131's staging pin did (`ops/production-sql-131-apply.md`).

## Steps

Each step is its own reviewed PR or run and waits for the owner's words for that step.

1. Staging: the staging executor must carry SQL 161 first (executor package refresh through the guarded staging
   executor `deploy` mode, its own reviewed run). Then `read-live` for
   `sql161-tg-mortgage-handling-billing-checksops-execute`. Expected `already_applied` false, live `72031400…`,
   `precondition_failures` `[]`, `prerequisites_missing` `[]`. Otherwise stop. Record `LIVE_DEFINITION_SHA256` in the
   staging pin (`expected_live_definition_sha256`, owner-approved `authorization`, `execute: true`, wave 52) in a
   reviewed change, `apply`, then `read-live` again (`already_applied` true, live `b916bcb5…`). Then SQL 160's staging
   read-live again: `tg_record_mortgage_handling_billing()` must read `PUBLIC`, `checksops`, owner.
2. Production: with the owner's OK for that read, the read-only inspect on the runner
   (`node scripts/deployment-guard/production-sql-one-shot.mjs --migration sql161 … --phase inspect`); expected
   `already_applied` true, live `b916bcb5…`, `precondition_failures` `[]`. Record `production_inspect` in a reviewed
   change; no apply. If it reads `already_applied` false (production lacks the grant after all), stop and report: the
   pin then needs its own reviewed change (record the pre-state, the staging acceptance, an owner-approved
   `authorization`, `execute: true`), and the apply uses the one-shot (`ops/production-sql-one-shot.md`,
   `--migration sql161 --approval-scope sql161 … --phase apply`, authorization phrase
   `GRANT_CHECKSOPS_EXECUTE_ON_MORTGAGE_HANDLING_TRIGGER_FUNCTION`) with the owner's words.
3. Record and retire the pin (`execute: false`) in a reviewed change.

Rollback (not part of this pin; a reviewed step of its own if ever needed): `REVOKE EXECUTE ... FROM checksops` on the
function through the guarded path as a new numbered migration (not in production, where the grant predates SQL 161).
