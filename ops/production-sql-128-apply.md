# Production SQL 128 (contractor verification reads Compliance & Docs)

| key | file | what it does |
|---|---|---|
| `sql128` | `aws/workflows/sql/128_contractor_verification_from_compliance.sql` (sha256 `19d5ea14967dd604bcb2e9ae7d90822a404de5c52ec07907e01ff6e0cee5a9cc`) | `CREATE OR REPLACE` of `contractor_verification_status(uuid)` with the same signature and `jsonb` result, `STABLE`, `SECURITY DEFINER`, `search_path = public`. `REVOKE ALL` from `PUBLIC`, and from `anon`, `authenticated` and `service_role` where they exist; `GRANT EXECUTE` to `checksops`. `DROP FUNCTION IF EXISTS _trg_recompute_contractor_tier_from_docs()`. |

**Why.** `contractor_verification_status` was restored onto the AWS databases from supabase migration
`20260709105400`. It reads `public.contractor_documents`, which supabase migration `20260826140740`
dropped on purpose: contractors upload their W-9 and insurance on Settings > Compliance & Docs. So
every call fails, and with it the Find-a-Pro "Verification status" card, the OPS Badge dialog, OPS
approve/revoke (`aws/functions/api/workflow-rpc.mjs` reads the status back) and every
`contractor_reviews` write (trigger `recompute_tier_on_reviews` -> `recompute_contractor_tier` ->
this function). Owner decision 2026-10-30: "There are no admin so B" (read the Compliance & Docs
uploads).

**What it changes.** Only the two document checks; every other check, the tier rules and the result
keys stay as supabase defines them. The contractor's tenants are the `tenant_users` rows of the
profile's `user_id`.

| check | was (supabase) | now (SQL 128) |
|---|---|---|
| `w9_on_file` | a `contractor_documents` row like `%w-9%`, or any contractor's row like `w9%` (the `OR` was outside the contractor filter) | a `moov_compliance_documents` row of one of the contractor's tenants with `purpose = 'w9'` and `status` `stored` or `sent`, or a `tenant_documents` row with `doc_type` `library:mortgage:w-9` or `w9` |
| `coi_current` | a `contractor_documents` row like `%coi%` / `%insurance%`, not expired | the same with `purpose = 'insurance'`, or a `tenant_documents` row with `doc_type` `library:mortgage:certificate-of-insurance`, `library:mortgage:general-liability-insurance`, `library:mortgage:workers-comp-insurance` or `insurance` whose `expires_at` is empty or not past |

`moov_compliance_documents` has no expiry, so a stored insurance upload counts as current. Its
`environment` is not filtered: each database serves one runtime. `pending_upload` and `rejected`
uploads do not count. The function has no caller gate of its own: the API gates it
(`aws/functions/api/data.mjs` `RPC_ACCESS_GATES`), and the review and profile triggers call it for
whoever wrote the row.

Not changed: `recompute_contractor_tier`, `admin_set_contractor_pro`, the review and profile trigger
functions and triggers, any table, column, view, policy, RLS setting, table grant or row, and the
Compliance & Docs upload routes. No API, Lambda or SPA change is part of this file or its pins. No
trigger is added, so the DB validator's public trigger count is not concerned.

**Status:** not applied anywhere. The staging pin and the production pin are pending.

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec
`sql128` in `release-sql-specs.mjs`). Intended
`ba4dcb2e43c233adf6109e5a89e7d6319dc993babcf3dbdcdfee261e6a33fbd7`:

```
release sql128 v1
function public.contractor_verification_status(uuid): lang=plpgsql vol=s parallel=u secdef=true result=jsonb config=search_path=public prosrc=c21a6e741c9c13dd44a0097c9b5706081326a30b727a8e35f2d5d331922ff2d3 acl=checksops EXECUTE;owner EXECUTE
function public._trg_recompute_contractor_tier_from_docs(): absent
```

**Expected pre-state.** The supabase function as restored (`pg_dump --no-acl`): the supabase body
(sha256 `4a1172bd73ddc2db5779f9a7683fe82920d8f40d4f2106a678b5fab2306cb9ab`), EXECUTE for `PUBLIC`
and the owner. With the orphan docs trigger function also restored the fingerprint is
`8bd6b42d189ff05b77e19d178ddba0229a0d2b6bca0a2d1d98221774fa8fbc5f`; without it
`11e6b5796c8485b4368f104680a179f80817d034be97b90f4c3ec74450cd8772` (both derived from the supabase bytes
by `aws/tests/release-sql128-executor.test.mjs`; the first is read back from a PostgreSQL 16 database
with the supabase functions restored). A different hash is not by itself a stop (an EXECUTE grant to
`authenticated` changes it and is revoked by the file), but the per-function report and ACL must be
read before recording it.

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present` (`contractor_verification_status(uuid)`, `contractor_profiles`,
`contractor_reviews`, `tenant_users`, `moov_compliance_documents`, `tenant_documents`, every column the
body reads, role `checksops`); `functions_owned_by_login`; `function_results_match` (`jsonb`);
`function_acl_replaceable` (no EXECUTE grant outside `PUBLIC`, `anon`, `authenticated`, `service_role`,
`checksops` and the owner); for the dropped function, if present: owned by the login, no dependents,
no caller.

Post-conditions: the intended fingerprint; the function owned by the login; everything else in schema
`public` (and the functions of `auth`) unchanged. The tools roll back otherwise.

## Steps

1. Staging: the staging executor must carry SQL 128 first (executor package refresh through the
   guarded staging executor `deploy` mode, its own reviewed run). Then run the guarded staging SQL
   executor with `read-live` for `sql128-contractor-verification-from-compliance`. If it reports
   `prerequisites_missing` other than `[]` or `precondition_failures` other than `[]`, stop.
   Otherwise record `LIVE_DEFINITION_SHA256` in the staging pin (`expected_live_definition_sha256`,
   owner-approved `authorization`, `execute: true`) in a reviewed change, `apply`, then `read-live`
   again.
2. Production: run the read-only inspect on the runner
   (`node scripts/deployment-guard/production-sql-one-shot.mjs --migration sql128 … --phase inspect`);
   record `production_inspect` and copy `live_definition_sha256` into
   `expected_live_definition_sha256`; record the staging runs in `staging_acceptance`; set an
   owner-approved `authorization` and `execute: true`, in one reviewed change.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs
   --migration sql128 --approval-scope sql128 … --phase apply` with the owner's words
   (authorization phrase `APPLY_CONTRACTOR_VERIFICATION_FROM_COMPLIANCE`).
4. Record the apply and retire the pin (`execute: false`).
