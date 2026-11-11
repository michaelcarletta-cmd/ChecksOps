# Production SQL 155 (adopt the claim owner stamp production already runs)

| key | file | what it does |
|---|---|---|
| `sql155` | `aws/workflows/sql/155_claim_owner_org_stamp.sql` (sha256 `847b2e6710050f2ce3ad35289d3ccd2ef72a36b2985881a5039a716d6c60c203`, authored by `0c14fc5ae`) | Refuses without `claims.org_id`, `tenants.slug`, `tenant_users(tenant_id, user_id)`, `auth.uid()`, `aws_is_cross_tenant_reader()` and the roles `checksops` and `authenticated` (`55000 sql155_prerequisite_missing`), or unless the applying login owns `tenants` and `tenant_users` (`55000 sql155_definer_cannot_read`); then `aws_claim_owner_tenant_id()`, `aws_stamp_claim_org_id()`, the trigger `trg_aws_stamp_claim_org_id` on `claims` and their EXECUTE grants, as production already runs them. |

**Why.** After SQL 76 (2026-11-11) production's `/db-readonly-validate` still answered 503 for one public trigger that
no file on main defined: `claims.trg_aws_stamp_claim_org_id`. Its source is `aws/rls/sql/39_claim_owner_org.sql` on
the unmerged branch `cursor/claim-ownership-invariant-7084` (PR #429, commit `6a05191a3`, 2026-09-22), whose PR records
it as applied to production directly ("Isolated production SQL: `trg_aws_stamp_claim_org_id` applied"), before the
guarded path existed. Owner 2026-11-11: "Keep it, adopt it through the guarded path". SQL 155 (#1777) is that file's
text from `CREATE OR REPLACE FUNCTION public.aws_claim_owner_tenant_id()` to its end, byte for byte, after a
prerequisite check of its own.

**What it does.**
- `aws_claim_owner_tenant_id()` (plpgsql, STABLE, SECURITY DEFINER, `search_path=public`, `row_security=off`, RETURNS
  uuid): the owning tenant for a new claim from `auth.uid()`: the tenant `request.active_tenant_slug` names when the
  user is a member of it (a UUID or malformed slug is ignored), else the user's one `tenant_users` row; more than one
  membership and no usable slug is `22023 claim_owner_tenant_required`; no user or no membership is NULL.
- `aws_stamp_claim_org_id()` (plpgsql, VOLATILE, SECURITY DEFINER, same config, RETURNS trigger) with
  `trg_aws_stamp_claim_org_id` BEFORE INSERT OR UPDATE ON `claims` FOR EACH ROW: an UPDATE keeps a non-null `org_id`;
  otherwise `org_id` comes from `aws_claim_owner_tenant_id()`; with no owner a NULL `org_id` is `23502
  claim_org_id_required`, and a signed-in user who is not a cross-tenant reader is `42501 claim_owner_tenant_required`.
- EXECUTE on both: `authenticated`, `checksops` and the owner (REVOKE ALL FROM PUBLIC first), as production has it.

Not changed: no table, column, index, policy, RLS setting, table grant or row; no other function. Where the live state
already matches, applying it changes nothing. No API, Lambda or SPA change: on main the API writes `claims` only to
rename an existing claim (`claim_number`), which the trigger leaves alone.

**Public trigger.** `trg_aws_stamp_claim_org_id` is a public trigger. Production's `db-readonly-validate` justified set
gains it in its own change, once production's state is recorded through this path.

**Status:** staging pin execute-authorized (wave 47); not applied anywhere. The production pin is pending.

**Staging read-live (2026-11-11).** Run 43077253195 (job 130720232170, main `d0548d4af`, after executor deploy run
43076433402, inspect runs 43076004984 and 43076849830), under the owner's words "Redeploy the staging executor and run
SQL 155 read-live": `already_applied` false, `precondition_failures` `[]`, `prerequisites_missing` `[]`,
`definer_writes` `tenants` and `tenant_users` `ok true`; both functions and the trigger `absent`, no EXECUTE grant. Live
`d63969e2ef8e5c809f2e107c41b61d87b3bedba5fe7a059b2dabb66f65604f54`: everything SQL 155 creates absent, equal to the derived state; intended
`d65fcff9…`. Staging never had file 39 (PR #429 named only production). Recorded in the staging pin
(`expected_live_definition_sha256`, `execute: true`, wave 47) under the owner's words of 2026-11-11, "Record the SQL
155 staging pin and merge it when green". The staging apply is a separate run after this pin is merged and the
executor is redeployed carrying it, on the owner's words for that run. The production pin stays pending.

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec `sql155` in
`release-sql-specs.mjs`). Intended `d65fcff93a2b9da222dc0fc40118f312c6df3b92d80ab9b7bbec6ed19d448609`:

```
release sql155 v1
function public.aws_claim_owner_tenant_id(): lang=plpgsql vol=s parallel=u secdef=true result=uuid config=row_security=off;search_path=public prosrc=3c6131ab8ad2e9e80b321c4e24ec22eb59c79a927f876cdf55b5ba7e19677dd0 acl=authenticated EXECUTE;checksops EXECUTE;owner EXECUTE
function public.aws_stamp_claim_org_id(): lang=plpgsql vol=v parallel=u secdef=true result=trigger config=row_security=off;search_path=public prosrc=659d15b7dd09a159da131e32c1e58dbc071acd5a10f28545f7e48d870ba56015 acl=authenticated EXECUTE;checksops EXECUTE;owner EXECUTE
trigger public.claims trg_aws_stamp_claim_org_id: enabled=O def=039c3a3599dd8152a8f149cde09077253d65b65a94d2a254a73566f4a5cc0171
```

**Expected production state.** Already as above (`already_applied` true, live `d65fcff93a2b9da222dc0fc40118f312c6df3b92d80ab9b7bbec6ed19d448609`), since production has run
file 39 since 2026-09-22. If the read-only inspect reports exactly that, the record-and-retire change records it as
`verified_live` (as SQL 82 to SQL 86) and nothing is applied in production.

**Staging state.** Not known: PR #429 names only production. Everything absent reads:

```
release sql155 v1
function public.aws_claim_owner_tenant_id(): absent
function public.aws_stamp_claim_org_id(): absent
trigger public.claims trg_aws_stamp_claim_org_id: absent
```

That is `d63969e2ef8e5c809f2e107c41b61d87b3bedba5fe7a059b2dabb66f65604f54` (`releaseStateHash('sql155', {})`). Each pin records its own environment's read; neither value is
written into a pin before a run reads it. Any other state is a stop.

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present`; `functions_owned_by_login`, `function_results_match` and `function_acl_replaceable` (both
functions, where present); `altered_relations_owned_by_login` (`claims`); `definer_can_write_relations` on `tenants`
and `tenant_users` (the functions run with `row_security=off`).

Post-conditions: the intended fingerprint; everything else in schema `public` unchanged. The tools roll back
otherwise.

## Steps

Each step is its own reviewed PR or run and waits for the owner's words for that step.

1. Staging: the staging executor must carry SQL 155 first (executor package refresh through the guarded staging
   executor `deploy` mode, its own reviewed run). Then run the guarded staging SQL executor with `read-live` for
   `sql155-claim-owner-org-stamp`. Expected `precondition_failures` `[]` and `prerequisites_missing` `[]`; either
   `already_applied` true (intended) or everything absent (`d63969e2…`). Otherwise stop. When absent: record
   `LIVE_DEFINITION_SHA256` in the staging pin (`expected_live_definition_sha256`, owner-approved `authorization`,
   `execute: true`) in a reviewed change, `apply`, then `read-live` again.
2. Production: with the owner's OK for that read, the read-only inspect on the runner
   (`node scripts/deployment-guard/production-sql-one-shot.mjs --migration sql155 … --phase inspect`). Expected
   `already_applied` true, live `d65fcff9…`, `precondition_failures` `[]`. Stop on anything else.
3. If production reads intended: the record-and-retire change records `production_inspect`, the staging acceptance
   and an `applied` block with result `verified_live`; `execute` stays false and nothing is applied. If production
   reads anything else, its own reviewed pin change and an apply through the one-shot with the owner's words
   (authorization phrase `ADOPT_CLAIM_OWNER_ORG_STAMP`), then the record.
4. Then add `public.claims trg_aws_stamp_claim_org_id` to the db-readonly-validate justified trigger set (its own
   change), which brings production's `/db-readonly-validate` back to 200.

Rollback (not part of this pin; a reviewed step of its own if ever needed): drop the trigger and both functions.
