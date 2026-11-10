# Production SQL 147 (record a payment made outside ChecksOps against a check)

| key | file | what it does |
|---|---|---|
| `sql147` | `aws/workflows/sql/147_external_disbursement_record.sql` (sha256 `d503b5b6cc1e92b727dee5a6a47f754a4bda864e831d6b47b1d21f082f2f4c4f`) | Refuses without the disbursement, check, transfer and stakeholder schema (the columns the function reads and writes), SQL 90's `aws_can_write_tenant(uuid)`, `auth.uid()` and role `checksops` (`55000 sql147_prerequisite_missing`), or when the applying login could not read and write `disbursement_batches`, `disbursement_splits`, `check_intake_items`, `payment_transfers`, `stakeholder_accounts` and `check_stakeholders` as a DEFINER owner past RLS (`55000 sql147_definer_cannot_write`). Then `CREATE OR REPLACE` of the new `aws_record_external_disbursement(uuid, uuid, jsonb, text)` (`plpgsql`, `VOLATILE`, `SECURITY DEFINER`, `search_path = public, pg_temp`, `RETURNS jsonb`), `REVOKE ALL ... FROM PUBLIC` (and from `anon`, `authenticated`, `service_role` where they exist) and `GRANT EXECUTE ... TO checksops`. No other statement. |

**Why.** Owner report 2026-11-09 (production): "i could not record an external payment". Both screens
that record a payment made outside ChecksOps (the check's Funds tab "Disburse Outside ChecksOps" form,
`src/components/payments/FundsTab.tsx`, and the Disbursement Console's "External / Manual" speed,
`src/components/disbursement/DisbursementConsole.tsx`) wrote `public.disbursement_batches` and
`public.disbursement_splits` from the browser through the generic `/data/write` route. On AWS that route
refuses both tables before any SQL runs (`aws/functions/api/write-allowlist.mjs`
`FINANCIAL_OR_PROVIDER_TABLES`; `403 table_not_allowlisted`, reason `financial_or_provider`), so the first
insert failed and nothing was recorded. No API route wrote these tables for a tenant. PR #1729 added the
file, the API route (`aws/functions/api/external-disbursement.mjs`, route
`record-external-disbursement`) and the two screens' change. Owner 2026-11-09: "apply SQL 147 in
staging".

**What it changes.** One new SECURITY DEFINER function instead of opening the tables to `/data/write`
(the generic route keeps refusing both tables):

- `aws_record_external_disbursement(_tenant_id, _check_intake_item_id, _payments jsonb,
  _idempotency_key)`: only for a signed-in member of the tenant (`auth.uid()` and SQL 90's
  `aws_can_write_tenant(_tenant_id)`, membership only; the platform owner, partners and other tenants are
  refused, `42501 external_disbursement_forbidden`). Inputs (`22023 external_disbursement_invalid`): an
  idempotency key of 8-100 characters `[A-Za-z0-9_:-]`; 1-10 payments, each a whole-cent amount > 0, a
  recipient name (<= 200) or a stakeholder account that is the tenant's own or the payout account on this
  tenant's `check_stakeholders` row for the check, a recipient type out of the Funds tab's list, a check
  number <= 40 and a memo <= 500. The check is locked `FOR UPDATE` and must belong to the tenant (`P0002
  external_disbursement_check_not_found`, the same answer for another tenant's check). The same key
  returns the recorded batch (`duplicate: true`) and writes nothing; other payments under it are `23505
  external_disbursement_key_reused`. Available = the check amount - the saved PA fee - the tenant's
  splits on the check that did not fail - the tenant's Moov send legs for the check that did not fail; a
  total above it is `P0001 external_disbursement_exceeds_available`. Otherwise one `disbursement_batches`
  row (`completed`, created and approved by the user) and one `disbursement_splits` row per payee
  (`settled`, method `external_check`, check number, memo in `external_notes`). The existing stage
  triggers then move the check as for any settled payout. No `payment_transfers`, wallet or event-log row;
  no provider call.

EXECUTE: revoked from `PUBLIC`, `anon`, `authenticated` and `service_role`; granted to `checksops`
(the API login). The owner keeps its own. No generic RPC route lists it (`data.mjs` `READ_RPCS`,
`workflow-rpc.mjs` `SAFE_WRITE_RPCS`); only `external-disbursement.mjs` calls it.

Not changed: no table, column, index, policy, RLS setting, table grant, trigger or row; no other
function. Until SQL 147 is applied in an environment, the API route there fails (the function is absent,
`42883`) and nothing is recorded, as today.

**Predecessor.** None in the release engine. SQL 90 must be applied first (its membership-only
`aws_can_write_tenant(uuid)` is a prerequisite; applied in production).

**Status:** not applied anywhere. The staging pin and the production pin are pending.

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec
`sql147` in `release-sql-specs.mjs`). Intended
`8080fbd7c4c24ed07251584b47b6507b0ee07095645c73c3cded7f12f3acd499`:

```
release sql147 v1
function public.aws_record_external_disbursement(uuid, uuid, jsonb, text): lang=plpgsql vol=v parallel=u secdef=true result=jsonb config=search_path=public, pg_temp prosrc=97971254e4f5fdd25f00f4d83d93796e44732b4b17480760d188df3831e9691b acl=checksops EXECUTE;owner EXECUTE
```

**Expected pre-state (both environments).** The function absent, everything else in place:

```
release sql147 v1
function public.aws_record_external_disbursement(uuid, uuid, jsonb, text): absent
```

That is `a60b06089007f083007ac7b24ae41cdd1cd33b0cbd04c63985c09faa9b666286`, derived by
`aws/tests/release-sql147-executor.test.mjs`. Each pin records its own environment's read; neither
value is written into a pin before a run reads it. A pre-state other than this one is not by itself a
stop, but its per-function report and ACL must be read and explained before it is recorded.

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present` (the six relations with the 42 columns the function reads or writes,
`aws_can_write_tenant(uuid)`, `auth.uid()`, role `checksops`); `definer_can_write_relations` on all six
relations (the applying login owns each without `FORCE ROW LEVEL SECURITY`, or is a superuser or
`BYPASSRLS`: a DEFINER filtered by RLS would under-count what was already paid); and, where the function
already exists (a re-run), `functions_owned_by_login`, `function_results_match` (the `jsonb` result) and
`function_acl_replaceable` (no EXECUTE grant outside `checksops` and the owner, which the file keeps, and
`PUBLIC`, `anon`, `authenticated` and `service_role`, which it revokes).

Post-conditions: the intended fingerprint; the function owned by the login; everything else in schema
`public` unchanged. The tools roll back otherwise.

## Steps

Each step is its own reviewed PR or run and waits for the owner's words for that step.

1. Staging: the staging executor must carry SQL 147 first (executor package refresh through the
   guarded staging executor `deploy` mode, its own reviewed run). Then run the guarded staging SQL
   executor with `read-live` for `sql147-external-disbursement-record`. Expected: `already_applied`
   false, `precondition_failures` `[]`, `definer_writes` all six `ok true`, `live_definition_sha256`
   `a60b0608…` (above). If it reports `prerequisites_missing` other than `[]` or `precondition_failures`
   other than `[]`, stop. Otherwise record `LIVE_DEFINITION_SHA256` in the staging pin
   (`expected_live_definition_sha256`, owner-approved `authorization`, `execute: true`) in a reviewed
   change, `apply`, then `read-live` again.
2. Production: run the read-only inspect on the runner
   (`node scripts/deployment-guard/production-sql-one-shot.mjs --migration sql147 … --phase inspect`);
   record `production_inspect` and copy `live_definition_sha256` into
   `expected_live_definition_sha256`; record the staging runs in `staging_acceptance`; set an
   owner-approved `authorization` and `execute: true`, in one reviewed change.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs
   --migration sql147 --approval-scope sql147 … --phase apply` with the owner's words
   (authorization phrase `APPLY_EXTERNAL_DISBURSEMENT_RECORD`).
4. Record the apply and retire the pin (`execute: false`).
5. Only then deploy the API change (`external-disbursement.mjs` ADD, the guarded production API
   overlay, staging first, held behind SQL 147 in `ops/deployment-guard/production-api-overlay-plan.json`)
   and the SPA change through the guarded SPA path.
