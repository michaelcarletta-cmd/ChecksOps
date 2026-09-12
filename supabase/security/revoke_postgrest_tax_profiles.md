# PostgREST containment for `public.recipient_tax_profiles`

Draft database-security change. Separate from merged PR #247 (AWS application-layer TIN handler).

**This document is catalog/metadata only.** No production or staging SQL was run while writing it. No table rows were selected. Column `tin` was never read.

Merging this PR **cannot apply SQL**. The revoke file is not under `supabase/migrations/`, so GitHub Supabase integration, `supabase db push`, Lovable merge deploys, oneshots, and `aws/db-copy` inventory cannot discover it. Direct psql is forbidden. The only authorized execution method is `scripts/run-hosted-tax-profile-containment.mjs` after a later, separate authorization.

## Official guidance (authoritative)

Reviewed 2026-09-12:

| Topic | Link | What it means for this table |
| --- | --- | --- |
| Data API grants vs RLS | https://supabase.com/docs/guides/api/securing-your-api | Grants decide whether `anon` / `authenticated` / `service_role` can reach an object over PostgREST. RLS only filters rows after a grant exists. Existing projects still auto-grant public tables unless revoked. Do not put public `SECURITY DEFINER` helpers in exposed schemas. |
| Row Level Security | https://supabase.com/docs/guides/database/postgres/row-level-security | RLS is row-level, not column-level. Enable RLS on exposed tables. Views default to security-definer behavior; use `security_invoker = true` (Postgres 15+) for views over protected tables. |
| Column privileges | https://supabase.com/docs/guides/database/postgres/column-level-security | Column grants can restore access after a table `REVOKE`. This change revokes the **entire table** (and leftover column grants) instead of trying to hide `tin` with RLS. |
| Views | https://supabase.com/docs/guides/database/tables | Views in `public` are Data API objects. Invoker-security views still require an underlying table grant. |
| Function `EXECUTE` | https://supabase.com/docs/guides/database/functions | Functions are executable by `PUBLIC` unless revoked. No public RPC is added here. |
| Platform default-grants changelog | https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically | From 2026-05-30 new projects opt in to exposure. **2026-10-30 is scheduled future behavior for newly created tables on existing projects.** It is **not** a current protection for `recipient_tax_profiles`. This table already exists with explicit `authenticated` DML grants, so the October change does **not** contain it. Explicit `REVOKE` is required. |
| Discussion | https://github.com/orgs/supabase/discussions/45329 | Confirms existing tables remain granted. |

## Why `supabase db push` must not be used

`supabase db push` applies **every pending file under `supabase/migrations/`**, not this revoke script. Using it would skip the unapplied file (it is outside that directory) **or**, if someone copied the file back into `migrations/`, would also apply unrelated pending migrations such as `20260911210000_aws_mortgage_ops_library_parity.sql`.

`supabase db push` is **not** an authorized application method. It must not be used. Direct psql is also forbidden.

The only documented future method is `scripts/run-hosted-tax-profile-containment.mjs`, which independently validates the hosted connection, pins SQL file SHA-256 hashes, and runs a single-file apply after explicit authorization.

## Repo-only metadata inventory

Live `information_schema` / `pg_catalog` on hosted production was **not** queried. The inventory below is reconstructed from repository migrations and client code. Before applying, operators must run the fail-closed gate `preflight_gate_revoke_postgrest_tax_profiles.sql` against the target database (catalog only). `preflight_inventory.sql` is optional extra listing SQL; it is **not the apply file**.

Do not guess the production state. Target metadata must be checked before apply.

### Table

| Field | Repo evidence |
| --- | --- |
| Schema / name | `public.recipient_tax_profiles` |
| Created | `supabase/migrations/20260709195755_af0fb428-7cf4-4ac3-9fc6-d04ed189b490.sql` |
| Owner | Not recorded in SQL. Hosted default is `postgres`. Fail closed if owner does not match the operator-supplied `expected_owner`. |
| Columns | `id`, `tenant_id` (FK → `tenants`), `recipient_key`, `recipient_name`, `tin TEXT`, address fields, `account_number`, `notes`, `created_at`, `updated_at`. Unique `(tenant_id, recipient_key)`. |
| RLS | `ENABLE ROW LEVEL SECURITY` in the create migration. `FORCE ROW LEVEL SECURITY` is **not** set. |
| Trigger | `recipient_tax_profiles_set_updated_at` → `public.set_updated_at()` (timestamp only; source does not name this table). |
| Later supabase migrations | No later file alters this table except the 2026-07-31 **blanket GRANT of all public tables to `authenticated`**. That file is **content-hash-pinned** in `hosted-tax-profile-containment.pins.json`; editing it fails CI until the new hash is reviewed. **Do not re-run it.** |

### Before (repo-known grants)

From the create migration, then re-asserted by `supabase/migrations/20260731144913_f26320f9-6473-4cc7-bda1-b4e2a0d71d97.sql` (GRANT on every public table):

| Role | Table privileges |
| --- | --- |
| `PUBLIC` | Not explicitly granted in the create file. Hosted default ACLs may still have added DML. Apply revokes `PUBLIC` anyway. |
| `anon` | Not explicitly granted. Revoked anyway (defense in depth). |
| `authenticated` | `SELECT, INSERT, UPDATE, DELETE` |
| `authenticator` | No table grant in repo. Revoked if present. |
| `service_role` | `ALL` |
| Application / `checksops` | Not granted in supabase migrations. |

No column-level grants appear in supabase migrations. Column `REVOKE` still runs so a dashboard column grant cannot restore `tin`.

### Before (repo-known RLS policies)

All `TO authenticated`, membership via `tenant_users` for `tenant_id` (any member, not owner/admin-only):

| Policy | Command | USING / WITH CHECK |
| --- | --- | --- |
| `tenant members read recipient_tax_profiles` | SELECT | `EXISTS (SELECT 1 FROM public.tenant_users tu WHERE tu.tenant_id = recipient_tax_profiles.tenant_id AND tu.user_id = auth.uid())` |
| `tenant members insert recipient_tax_profiles` | INSERT | same predicate as WITH CHECK |
| `tenant members update recipient_tax_profiles` | UPDATE | USING + WITH CHECK, same predicate |
| `tenant members delete recipient_tax_profiles` | DELETE | same USING predicate |

This is a broad tenant-member policy. Any authenticated member can `select=tin` over PostgREST.

AWS RDS copies may also have `aws_select_recipient_tax_profiles` / `aws_write_recipient_tax_profiles` from `aws/rls/sql/*`. Those files are **not** supabase migrations. If they are present on hosted Supabase, preflight and apply **fail closed** (unexpected `aws_*` policies).

### After (desired / later authorized apply)

| Role | Table privileges |
| --- | --- |
| `PUBLIC` | none |
| `anon` | none |
| `authenticated` | none |
| `authenticator` | none |
| `service_role` | unchanged `ALL` (controlled server path) |

| RLS | Policies |
| --- | --- |
| Enabled | None. No replacement “tenant member” or authenticated policy. |

Direct REST `/rest/v1/recipient_tax_profiles` (any schema alias, embed, or `select=tin`) fails with permission denied (`42501`) regardless of tenant membership.

### Preflight classifications and stop conditions

The wrapper proves the connection target, then supplies non-secret identity vars (SQL checks remain defense in depth; PostgreSQL does not expose the Supabase project ref):

- `expected_project_ref` must be exactly `nbcqwpysqgyxrrbgtmkw`
- `expected_database` must equal `current_database()`
- `expected_owner` must equal the table owner

| Classification | Meaning | Gate / apply |
| --- | --- | --- |
| `EXACT_EXPECTED_LEGACY` | Ordinary table `r` in `public`; owner matches; RLS on; FORCE RLS off; exact four tenant-member policies with expected commands/roles/USING/WITH CHECK; authenticated table DML; `service_role` DML; no extra policies/grantees/deps/aws/checksops/bad membership | Apply mutates (revoke + drop policies) |
| `ALREADY_CONTAINED` | Same identity/owner/relkind/no deps/aws/checksops; RLS on; **zero** policies; no Data API table/column privs for `PUBLIC`/`anon`/`authenticated`/`authenticator`; `service_role` DML remains | No-op |
| `UNSAFE/AMBIGUOUS` | Anything else (partial apply, extra policy, wrong USING, publications, views, foreign tables, functions, GraphQL objects, cron, extra triggers, custom grantee, role inheritance, RDS names/roles, `aws_*` policies, wrong identity) | **RAISE** and stop |

The gate never selects table rows or TIN values, runs `SET TRANSACTION READ ONLY` where supported, and rolls back.

### Dependent objects (repo)

| Class | Finding |
| --- | --- |
| Views / materialized views | No `CREATE VIEW` / `CREATE MATERIALIZED VIEW` in `supabase/migrations` references `recipient_tax_profiles` or this table’s `tin`. `tenants_public` is `security_invoker = true` and does not include tax columns. |
| Functions / procedures | No supabase function `prosrc` names `recipient_tax_profiles`. Trigger uses generic `set_updated_at`. |
| SECURITY DEFINER | None added. Do not add a public definer RPC for this table. AWS helper `aws_can_access_tax_profiles` lives in `aws/rls/sql/11_access_helpers.sql` (RDS), not in supabase migrations. It returns boolean and does not select `tin`; EXECUTE was granted to `authenticated` on AWS only. |
| PostgREST relationships | Generated types: FK `recipient_tax_profiles_tenant_id_fkey` → `tenants`, `tenant_safe`, `tenants_public`. Embeds such as `tenants?select=recipient_tax_profiles(tin)` require a table SELECT grant and will fail after revoke. No inbound FKs from other tables in migrations. |
| Publications | No `ALTER PUBLICATION supabase_realtime ADD TABLE public.recipient_tax_profiles`. Apply fails closed if the table is published. |
| Triggers / audit | Only `recipient_tax_profiles_set_updated_at`. |
| Exports / backups / jobs | `aws/db-copy/sql/reconciliation_counts.sql` counts the table (ops SQL, not PostgREST). Do not run it against production as part of this PR. Logical dumps still contain plaintext `tin` (at-rest risk; out of scope). No `pg_cron` job in repo names the table. |
| Frontend | `src/components/ledger/TaxSummary.tsx` uses `supabase.functions.invoke('tenant-tax-profiles')` only. No `.from('recipient_tax_profiles')`. **This PR does not modify the SPA.** |
| Browser keys | `src/integrations/supabase/client.ts` uses the publishable (anon) key. No service-role key in `src/`. |
| Edge Functions | No `supabase/functions/*` reference to this table. There is **no** hosted `tenant-tax-profiles` Edge Function in this repo; that handler is AWS (`aws/functions/api/tax-profiles.mjs`) from PR #247. |
| Types | `src/integrations/supabase/types.ts` still lists the table (generated types, not a grant). |

## Containment contract

- `anon` has no access.
- Browser / PostgREST `authenticated` has no `SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER` on the table.
- Direct REST fails regardless of tenant membership, including `SELECT id`.
- RLS stays enabled as defense in depth; member policies are dropped; authenticated is **not** granted back.
- No view, RPC, function, or relationship should expose `tin`.
- `service_role` / server SQL remains for the controlled workflow only.
- PR #247’s `POST /functions/v1/tenant-tax-profiles` remains the application interface.
- Existing rows are not selected, rewritten, deleted, decrypted, or printed.
- No public `SECURITY DEFINER` function.

## Product UX (no SPA change in this PR)

After a later hosted apply:

- Tax/1099 profile lookup/save on the **legacy Supabase build** may be unavailable (`tenant-tax-profiles` is not a hosted Edge Function; PostgREST fallback is what this revoke removes).
- The current UI may misleadingly show **“No TIN on file”** after a failed list request: `TaxSummary` defaults `taxProfiles = []` and `tinStatusLabel` returns that string when no profile is mapped. The list path is `functions.invoke('tenant-tax-profiles')`, not `.from('recipient_tax_profiles')`.
- A **separate small UI PR** must add an explicit unavailable/error banner **before** the database change is applied.

## Impact analysis

Revoking Data API table access is the security outcome. Do not weaken it to keep an unsafe browser `from('recipient_tax_profiles')` path.

| Surface | After revoke |
| --- | --- |
| Production SPA (hosted Supabase client) | `TaxSummary` already calls `tenant-tax-profiles`. That function is **not** deployed on hosted Edge Functions. Tax/1099 on the Lovable/production build is already unable to load profiles through the new handler and **cannot** fall back to PostgREST after this change. Treat as **Tax/1099 temporarily disabled** on that build until a hosted server handler exists or traffic uses AWS. |
| Legacy Lovable build | Same hosted client and grants. Direct REST that still works today (`select=tin`) **stops**. Unsafe workflow is not preserved. |
| AWS SPA | Uses Cognito + AWS API (`isAwsStaging()`). Handler talks to RDS as the server role, not PostgREST. Unaffected **if this SQL is not applied to RDS**. |
| Direct `supabase-js` / REST / GraphQL | `/rest/v1/recipient_tax_profiles`, schema-qualified names, and embeds fail. |
| Edge Functions | None read this table today. `service_role` inside a future function would still work; do not put the service-role key in the browser. |
| Reports / CSV | `buildPaymentReportingCsv` does not include TIN. Unchanged. |
| Ops dumps / reconciliation | Still see plaintext `tin` at rest. Out of scope. |
| `20260731144913` blanket GRANT | Historical landmine: re-running that DO block would grant `authenticated` on **all** public tables again, including this one. Do not re-run it. |

## CI safety guard

`scripts/check-recipient-tax-profile-migrations.mjs` fails CI if a **future** file under `supabase/migrations/`:

- references `recipient_tax_profiles` and performs `GRANT`, `REVOKE`, `CREATE`/`DROP`/`ALTER POLICY`, `ALTER TABLE` RLS, or default-privilege changes; or
- uses `GRANT ... ON ALL TABLES ... TO authenticated/anon/PUBLIC`; or
- uses `ALTER DEFAULT PRIVILEGES ... GRANT ... TO authenticated/anon/PUBLIC`; or
- conceals privilege SQL with `EXECUTE`, concatenation, psql `\\i`, or encoded generators.

Historical exceptions are **content-hash-pinned** in `supabase/security/hosted-tax-profile-containment.pins.json` (exact basename + SHA-256 + review note). Editing a pinned file fails CI until the new hash is reviewed in the same PR. Filename-only allowlisting is not accepted.

Static scanning cannot prove arbitrary SQL safe. The guard fails closed on suspicious constructs.

**Authorized future migration:** put the SQL in the same PR as a pins.json hash exception (or avoid privilege changes), with an explicit security review. Do not move the revoke file back under `supabase/migrations/`.

## Local advisor results (disposable Postgres, not hosted)

`supabase db advisors --db-url …?sslmode=disable --type security` after applying this SQL on the fixture:

| Advisor | Level | Object | Notes |
| --- | --- | --- | --- |
| `rls_enabled_no_policy` | INFO | `public.recipient_tax_profiles` | **Intended.** RLS is on with zero policies because Data API grants are revoked. If grants were accidentally restored, default-deny RLS still blocks rows. Do not add an authenticated policy to silence this. |
| `function_search_path_mutable` | WARN | `public.set_updated_at` | Fixture stub only. This change does not create that function. |
| `rls_disabled_in_public` | ERROR | `public.tenants` | Fixture stub only (minimal tenants table without RLS). Not applied to production. |

`supabase db lint` is not supported on this disposable cluster (`plpgsql_check` is not available). Do not run advisors against production from this PR.

## Remaining risk (not this PR)

`recipient_tax_profiles.tin` remains **plaintext at rest**. This PR does not encrypt, tokenize, or rewrite values. Backups, table owners, and `service_role` can still read TIN in SQL.

## Authorized future sequence (do not run in this PR)

The **only authorized execution method** is:

`scripts/run-hosted-tax-profile-containment.mjs`

Direct `psql`, `supabase db push`, and Git merge application are **forbidden**.

PostgreSQL does **not** independently expose the Supabase project ref. The wrapper proves the connection target (direct `db.<ref>.supabase.co` hostname, or pooler hostname plus `postgres.<ref>` username, database `postgres`, and `sslmode=require|verify-ca|verify-full`). SQL `-v expected_project_ref` is defense in depth only.

1. Review this wrapper and the pinned SHA-256 values in `supabase/security/hosted-tax-profile-containment.pins.json` at the exact git commit that will be used.
2. Record operator authorization. Ship the Tax UI unavailable/error banner PR **before** hosted apply.
3. Export `CHECKSOPS_TAX_CONTAINMENT_DATABASE_URL` (never argv). Run preflight only:

```
CHECKSOPS_TAX_CONTAINMENT_DATABASE_URL=... \
  node scripts/run-hosted-tax-profile-containment.mjs preflight
```

Require wrapper output `WRAPPER_CLASSIFICATION=EXACT_EXPECTED_LEGACY`. Stop on `ALREADY_CONTAINED`, `UNSAFE/AMBIGUOUS`, hash mismatch, or connection rejection.

4. Remote apply still requires a **separate** authorization event. Then:

```
CHECKSOPS_TAX_CONTAINMENT_DATABASE_URL=... \
  node scripts/run-hosted-tax-profile-containment.mjs apply \
    --i-authorize-hosted-recipient-tax-profiles-revoke \
    --confirm=REVOKE_POSTGREST_RECIPIENT_TAX_PROFILES
```

The wrapper re-validates the URL, verifies SQL file hashes, runs preflight on that same URL, and applies only `supabase/security/unapplied-do-not-run/NOT_APPLIED_revoke_postgrest_tax_profiles.sql` when classification is `EXACT_EXPECTED_LEGACY`.

5. Probe with a **non-production** user JWT against `/rest/v1/recipient_tax_profiles?select=id` — expect `42501`. Do not `select=tin` on production.
6. Do not merge-apply from this draft PR. This PR stops at draft.

There is **no automatic unsafe rollback**. See `EMERGENCY_ROLLBACK_revoke_postgrest_tax_profiles.md`.
`recipient_tax_profiles.tin` remains plaintext at rest.

## Confirmation (this agent run)

- No SQL applied to staging or production.
- No AWS / Supabase / environment configuration changed.
- No stored TIN read or printed.
- PR #247 not reopened or modified.
- Encryption at rest not started.
