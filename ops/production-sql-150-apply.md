# Production SQL 150 (record a payment made outside ChecksOps up to the check amount)

| key | file | what it does |
|---|---|---|
| `sql150` | `aws/workflows/sql/150_external_disbursement_up_to_check_amount.sql` (sha256 `b470f8ecb12d85f2a51d470d9a408d8e2012d720388eb1bcc4d3fbccfc8a31dc`) | Refuses without the disbursement, check, transfer and stakeholder schema (the columns the function reads and writes), SQL 90's `aws_can_write_tenant(uuid)`, `auth.uid()` and role `checksops` (`55000 sql150_prerequisite_missing`), or when the applying login could not read and write `disbursement_batches`, `disbursement_splits`, `check_intake_items`, `payment_transfers`, `stakeholder_accounts` and `check_stakeholders` as a DEFINER owner past RLS (`55000 sql150_definer_cannot_write`). Then `CREATE OR REPLACE` of SQL 147's `aws_record_external_disbursement(uuid, uuid, jsonb, text)` (same identity and attributes: `plpgsql`, `VOLATILE`, `SECURITY DEFINER`, `search_path = public, pg_temp`, `RETURNS jsonb`) with one change in its body, `REVOKE ALL ... FROM PUBLIC` (and from `anon`, `authenticated`, `service_role` where they exist) and `GRANT EXECUTE ... TO checksops`, as SQL 147. No other statement. |

**Why.** Owner report 2026-11-10 (production): recording an outside payment of $7,870.67 on an $8,745.19
check from the check's Funds tab was refused ("Amount exceeds what is left on this check ($874.52
available)") while the form showed the whole check amount; "I should be able to disburse the whole thing
if I want ... there should be no rules holding back disbursing here". SQL 147 (applied in staging and in
production on 2026-11-10; `ops/production-sql-147-apply.md`) caps an outside payment at the check amount
less the saved PA fee less what was already paid out of the check. Owner 2026-11-10: "I want to be able
to record up to the check amount", then "merge 1752 when green" (PR #1752 added the file, its behavior
test `aws/tests/sql150-external-disbursement-pg.test.mjs` and the Funds tab's matching rule in
`src/components/payments/FundsTab.tsx`; SQL 147's file is not edited), then "build the SQL 150 tooling
and merge it when green" (this tooling).

**What it changes.** `aws_record_external_disbursement(_tenant_id, _check_intake_item_id, _payments jsonb,
_idempotency_key)` is replaced in place (same oid, owner, attributes and EXECUTE ACL) with one change:
available = the check amount - the tenant's splits on the check that did not fail - the tenant's Moov send
legs for the check that did not fail, in cents. The saved PA fee is no longer subtracted, so the check
columns `pa_fee_pct` and `pa_fee_amount` are no longer read (and are no longer prerequisites). A total above
what is available is still `P0001 external_disbursement_exceeds_available` (what was already recorded still
counts, so a check cannot be recorded past its amount). Everything else is SQL 147's, unchanged: the member
gate (`42501 external_disbursement_forbidden`), the input checks (`22023 external_disbursement_invalid`),
the check locked `FOR UPDATE` and owned by the tenant (`P0002 external_disbursement_check_not_found`), the
idempotency key (`23505 external_disbursement_key_reused`), the batch and split rows written and the
result object. The PA fee stays saved on the check and still applies to ChecksOps sends.

Function bodies (sha256 of `prosrc`): SQL 147's
`97971254e4f5fdd25f00f4d83d93796e44732b4b17480760d188df3831e9691b`, SQL 150's
`80b78a71d72562ea1de44c1dd536f9ef35e2bdf611c2ce168bb530bb597cb8cd`. The body diff removes `v_fee`, the
`pa_fee_pct` / `pa_fee_amount` reads and the fee term of `v_available`, and rewords one comment
(`aws/tests/release-sql150-executor.test.mjs` re-derives both and the diff).

EXECUTE: revoked from `PUBLIC`, `anon`, `authenticated` and `service_role`; granted to `checksops`
(the API login). The owner keeps its own. As SQL 147.

Not changed: no table, column, index, policy, RLS setting, table grant, trigger or row; no other
function. The API route that calls the function (`aws/functions/api/external-disbursement.mjs`, route
`record-external-disbursement`) is unchanged and needs no deploy.

**Predecessor.** SQL 147, which SQL 150 supersedes (as SQL 138 for SQL 113). The release engine refuses
SQL 150 (`predecessors_applied`) unless SQL 147 reads applied, that is the function exactly as SQL 147
left it; after SQL 150, SQL 147 counts as applied while SQL 150 is. No `superseded_intended_sha256` is
pinned: SQL 147's only object is the function SQL 150 replaces (as SQL 143 for SQL 142).

**Staging executor refreshed (2026-11-11).** Deploy run 42927303051 updated
`checksops-staging-guarded-sql-executor` to carry SQL 150 (inspect run 42926976972 read CodeSha256
`X2Z+6Nkj0qI3pYc/jY7/YZVKBGu5+YjdN3wr6NA1hho=` before it, inspect run 42927674258
`aPgcRrWIUqtEN2smVE554q0UlGAMgIbGlf3hxLFOTeE=` after it).

**Staging read-live (2026-11-11).** Run 42928033292 (job 130219398971, main `1ecbe3452`, after executor deploy run
42927303051), under the owner's words "apply SQL 150 in staging": `already_applied` false, `precondition_failures`
`[]`, `prerequisites_missing` `[]`, `definer_writes` all `ok true`. Live `650ad0d486b5eebdf647e4c25a56c8776ed7a412d8735cfc83aad1d449b959fa`: the function exactly
as SQL 147 left it, equal to the derived pre-state; intended `48d61bb3…`. Recorded in the staging pin
(`expected_live_definition_sha256`, `execute: true`, wave 44) under the owner's words of 2026-11-11, "record the SQL
150 staging pin and merge it when green". The staging apply is a separate run after this pin is merged and the
executor is redeployed carrying it, on the owner's words "apply SQL 150 in staging". The production pin stays pending:
a read-only production inspect decides production's pre-state.

**Status:** staging pin execute-authorized (wave 44); not applied anywhere. The production pin is pending.

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec
`sql150` in `release-sql-specs.mjs`). Intended
`48d61bb31da60ca6f52d2691e3f3a95de9ce33347725a32e9b95b4939ff1bb13`:

```
release sql150 v1
function public.aws_record_external_disbursement(uuid, uuid, jsonb, text): lang=plpgsql vol=v parallel=u secdef=true result=jsonb config=search_path=public, pg_temp prosrc=80b78a71d72562ea1de44c1dd536f9ef35e2bdf611c2ce168bb530bb597cb8cd acl=checksops EXECUTE;owner EXECUTE
```

**Expected pre-state (both environments).** SQL 147 applied: the function exactly as SQL 147 left it,
everything else in place:

```
release sql150 v1
function public.aws_record_external_disbursement(uuid, uuid, jsonb, text): lang=plpgsql vol=v parallel=u secdef=true result=jsonb config=search_path=public, pg_temp prosrc=97971254e4f5fdd25f00f4d83d93796e44732b4b17480760d188df3831e9691b acl=checksops EXECUTE;owner EXECUTE
```

That is `650ad0d486b5eebdf647e4c25a56c8776ed7a412d8735cfc83aad1d449b959fa`, derived from SQL 147's bytes
(`releaseStateHash('sql150', …)` of SQL 147's intended function) by
`aws/tests/release-sql150-executor.test.mjs` and read back on PostgreSQL 16 after SQL 147 is applied
there. Each pin records its own environment's read; neither value is written into a pin before a run
reads it. A pre-state other than this one is a stop: its per-function report and ACL must be read and
explained in its own reviewed change.

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present` (the six relations with the 40 columns the function reads or writes,
`aws_can_write_tenant(uuid)`, `auth.uid()`, role `checksops`); `predecessors_applied` (SQL 147 in
place); `definer_can_write_relations` on all six relations (the applying login owns each without
`FORCE ROW LEVEL SECURITY`, or is a superuser or `BYPASSRLS`); `functions_owned_by_login` (the function
SQL 147 created is owned by the applying login), `function_results_match` (the `jsonb` result) and
`function_acl_replaceable` (no EXECUTE grant outside `checksops` and the owner, which the file keeps, and
`PUBLIC`, `anon`, `authenticated` and `service_role`, which it revokes).

Post-conditions: the intended fingerprint; the function owned by the login; everything else in schema
`public` unchanged. The tools roll back otherwise.

## Steps

Each step is its own reviewed PR or run and waits for the owner's words for that step.

1. Staging: the staging executor must carry SQL 150 first (executor package refresh through the
   guarded staging executor `deploy` mode, its own reviewed run). Then run the guarded staging SQL
   executor with `read-live` for `sql150-external-disbursement-up-to-check-amount`. Expected:
   `already_applied` false, `precondition_failures` `[]`, `predecessors` `{"sql147": true}`,
   `definer_writes` all six `ok true`, `live_definition_sha256` `650ad0d4…` (above). If it reports
   another pre-state, `prerequisites_missing` other than `[]` or `precondition_failures` other than `[]`,
   stop. Otherwise record `LIVE_DEFINITION_SHA256` in the staging pin (`expected_live_definition_sha256`,
   owner-approved `authorization`, `execute: true`) in a reviewed change, `apply`, then `read-live` again.
2. Production: run the read-only inspect on the runner
   (`node scripts/deployment-guard/production-sql-one-shot.mjs --migration sql150 … --phase inspect`);
   record `production_inspect` and copy `live_definition_sha256` into
   `expected_live_definition_sha256`; record the staging runs in `staging_acceptance`; set an
   owner-approved `authorization` and `execute: true`, in one reviewed change.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs
   --migration sql150 --approval-scope sql150 … --phase apply` with the owner's words
   (authorization phrase `APPLY_EXTERNAL_DISBURSEMENT_UP_TO_CHECK_AMOUNT`).
4. Record the apply and retire the pin (`execute: false`).
5. No API or Lambda change. The Funds tab's matching rule (#1752) reaches each environment only through
   the guarded SPA path, its own reviewed run; until SQL 150 is applied there, that form can offer an
   amount the function still refuses (`external_disbursement_exceeds_available`), and nothing is recorded.
