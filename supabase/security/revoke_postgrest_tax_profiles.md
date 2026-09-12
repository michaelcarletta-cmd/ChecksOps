# PostgREST containment for `public.recipient_tax_profiles`

Draft database-security change. Separate from merged PR #247 (AWS application-layer TIN handler).

**This document is catalog/metadata only.** No production or staging SQL was run while writing it. No table rows were selected. Column `tin` was never read.

## Official guidance (authoritative)

Reviewed 2026-09-12:

| Topic | Link | What it means for this table |
| --- | --- | --- |
| Data API grants vs RLS | https://supabase.com/docs/guides/api/securing-your-api | Grants decide whether `anon` / `authenticated` / `service_role` can reach an object over PostgREST. RLS only filters rows after a grant exists. Existing projects still auto-grant public tables unless revoked. Do not put public `SECURITY DEFINER` helpers in exposed schemas. |
| Row Level Security | https://supabase.com/docs/guides/database/postgres/row-level-security | RLS is row-level, not column-level. Enable RLS on exposed tables. Views default to security-definer behavior; use `security_invoker = true` (Postgres 15+) for views over protected tables. |
| Column privileges | https://supabase.com/docs/guides/database/postgres/column-level-security | Column grants can restore access after a table `REVOKE`. This change revokes the **entire table** (and leftover column grants) instead of trying to hide `tin` with RLS. |
| Views | https://supabase.com/docs/guides/database/tables | Views in `public` are Data API objects. Invoker-security views still require an underlying table grant. |
| Function `EXECUTE` | https://supabase.com/docs/guides/database/functions | Functions are executable by `PUBLIC` unless revoked. No public RPC is added here. |
| Platform default-grants changelog | https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically | From 2026-05-30 new projects opt in to exposure. **2026-10-30 applies to existing projects for newly created tables only.** Existing tables **keep current grants**. This table was created with explicit `authenticated` DML grants, so the October change does **not** contain it. Explicit `REVOKE` is required. |
| Discussion | https://github.com/orgs/supabase/discussions/45329 | Confirms existing tables remain granted. |

## Repo-only metadata inventory

Live `information_schema` / `pg_catalog` on hosted production was **not** queried. The inventory below is reconstructed from repository migrations and client code. Before applying, operators must re-run the metadata queries in `preflight_inventory.sql` against the target database (catalog only).

### Table

| Field | Repo evidence |
| --- | --- |
| Schema / name | `public.recipient_tax_profiles` |
| Created | `supabase/migrations/20260709195755_af0fb428-7cf4-4ac3-9fc6-d04ed189b490.sql` |
| Owner | Not recorded in SQL. Hosted default is `postgres`. Fail closed if a non-documented owner plus extra grantees appear. |
| Columns | `id`, `tenant_id` (FK → `tenants`), `recipient_key`, `recipient_name`, `tin TEXT`, address fields, `account_number`, `notes`, `created_at`, `updated_at`. Unique `(tenant_id, recipient_key)`. |
| RLS | `ENABLE ROW LEVEL SECURITY` in the create migration. `FORCE ROW LEVEL SECURITY` is **not** set. |
| Trigger | `recipient_tax_profiles_set_updated_at` → `public.set_updated_at()` (timestamp only; source does not name this table). |
| Later supabase migrations | No later file alters this table except the 2026-07-31 **blanket GRANT of all public tables to `authenticated`**. |

### Before (repo-known grants)

From the create migration, then re-asserted by `supabase/migrations/20260731144913_f26320f9-6473-4cc7-bda1-b4e2a0d71d97.sql` (GRANT on every public table):

| Role | Table privileges |
| --- | --- |
| `PUBLIC` | Not explicitly granted in the create file. Hosted default ACLs may still have added DML. Migration revokes `PUBLIC` anyway. |
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

AWS RDS copies may also have `aws_select_recipient_tax_profiles` / `aws_write_recipient_tax_profiles` from `aws/rls/sql/*`. Those files are **not** supabase migrations. If they are present on hosted Supabase, this migration **fails closed** (unexpected extra policies).

### After (desired / this migration)

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

### Dependent objects (repo)

| Class | Finding |
| --- | --- |
| Views / materialized views | No `CREATE VIEW` / `CREATE MATERIALIZED VIEW` in `supabase/migrations` references `recipient_tax_profiles` or this table’s `tin`. `tenants_public` is `security_invoker = true` and does not include tax columns. |
| Functions / procedures | No supabase function `prosrc` names `recipient_tax_profiles`. Trigger uses generic `set_updated_at`. |
| SECURITY DEFINER | None added. Do not add a public definer RPC for this table. AWS helper `aws_can_access_tax_profiles` lives in `aws/rls/sql/11_access_helpers.sql` (RDS), not in supabase migrations. It returns boolean and does not select `tin`; EXECUTE was granted to `authenticated` on AWS only. |
| PostgREST relationships | Generated types: FK `recipient_tax_profiles_tenant_id_fkey` → `tenants`, `tenant_safe`, `tenants_public`. Embeds such as `tenants?select=recipient_tax_profiles(tin)` require a table SELECT grant and will fail after revoke. No inbound FKs from other tables in migrations. |
| Publications | No `ALTER PUBLICATION supabase_realtime ADD TABLE public.recipient_tax_profiles`. Migration fails closed if the table is published. |
| Triggers / audit | Only `recipient_tax_profiles_set_updated_at`. |
| Exports / backups / jobs | `aws/db-copy/sql/reconciliation_counts.sql` counts the table (ops SQL, not PostgREST). Do not run it against production as part of this PR. Logical dumps still contain plaintext `tin` (at-rest risk; out of scope). No `pg_cron` job in repo names the table. |
| Frontend | `src/components/ledger/TaxSummary.tsx` uses `supabase.functions.invoke('tenant-tax-profiles')` only. No `.from('recipient_tax_profiles')`. |
| Browser keys | `src/integrations/supabase/client.ts` uses the publishable (anon) key. No service-role key in `src/`. |
| Edge Functions | No `supabase/functions/*` reference to this table. There is **no** hosted `tenant-tax-profiles` Edge Function in this repo; that handler is AWS (`aws/functions/api/tax-profiles.mjs`) from PR #247. |
| Types | `src/integrations/supabase/types.ts` still lists the table (generated types, not a grant). |

## Containment contract

- `anon` has no access.
- Browser / PostgREST `authenticated` has no `SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER` on the table.
- Direct REST fails regardless of tenant membership.
- RLS stays enabled as defense in depth; member policies are dropped; authenticated is **not** granted back.
- No view, RPC, function, or relationship should expose `tin`.
- `service_role` / server SQL remains for the controlled workflow only.
- PR #247’s `POST /functions/v1/tenant-tax-profiles` remains the application interface.
- Existing rows are not selected, rewritten, deleted, decrypted, or printed.
- No public `SECURITY DEFINER` function.

## Impact analysis

Revoking Data API table access is the security outcome. Do not weaken it to keep an unsafe browser `from('recipient_tax_profiles')` path.

| Surface | After revoke |
| --- | --- |
| Production SPA (hosted Supabase client) | `TaxSummary` already calls `tenant-tax-profiles`. That function is **not** deployed on hosted Edge Functions. Tax/1099 on the Lovable/production build is already unable to load profiles through the new handler and **cannot** fall back to PostgREST after this change. Treat as **Tax/1099 temporarily disabled** on that build until a hosted server handler exists or traffic uses AWS. |
| Legacy Lovable build | Same hosted client and grants. Direct REST that still works today (`select=tin`) **stops**. Unsafe workflow is not preserved. |
| AWS SPA | Uses Cognito + AWS API (`isAwsStaging()`). Handler talks to RDS as the server role, not PostgREST. Unaffected **if this supabase migration is not applied to RDS**. |
| Direct `supabase-js` / REST / GraphQL | `/rest/v1/recipient_tax_profiles`, schema-qualified names, and embeds fail. |
| Edge Functions | None read this table today. `service_role` inside a future function would still work; do not put the service-role key in the browser. |
| Reports / CSV | `buildPaymentReportingCsv` does not include TIN. Unchanged. |
| Ops dumps / reconciliation | Still see plaintext `tin` at rest. Out of scope. |
| `20260731144913` blanket GRANT | Historical landmine: re-running that DO block would grant `authenticated` on **all** public tables again, including this one. Do not re-run it. |

## Local advisor results (disposable Postgres, not hosted)

`supabase db advisors --db-url …?sslmode=disable --type security` after applying this migration on the fixture:

| Advisor | Level | Object | Notes |
| --- | --- | --- | --- |
| `rls_enabled_no_policy` | INFO | `public.recipient_tax_profiles` | **Intended.** RLS is on with zero policies because Data API grants are revoked. If grants were accidentally restored, default-deny RLS still blocks rows. Do not add an authenticated policy to silence this. |
| `function_search_path_mutable` | WARN | `public.set_updated_at` | Fixture stub only. This migration does not create that function. |
| `rls_disabled_in_public` | ERROR | `public.tenants` | Fixture stub only (minimal tenants table without RLS). Not applied to production. |

`supabase db lint` is not supported on this disposable cluster (`plpgsql_check` is not available). Do not run advisors against production from this PR.

## Remaining risk (not this PR)

`recipient_tax_profiles.tin` remains **plaintext at rest**. This PR does not encrypt, tokenize, or rewrite values. Backups, table owners, and `service_role` can still read TIN in SQL.

## Staged application plan (do not run in this PR)

1. Operator authorization recorded (change ticket + explicit approval to revoke Data API access, accepting Lovable Tax/1099 outage).
2. Disposable clone or local DB: apply this migration; run `revoke_postgrest_tax_profiles.test.mjs`.
3. On the **target** hosted database, run `preflight_inventory.sql` only (catalog). Compare to the before-state above. If extra policies (`aws_*`), publications, views, or unknown grantees appear, **stop**.
4. Apply with one of:
   - `psql -1 -v ON_ERROR_STOP=1 -f supabase/migrations/20260912114853_revoke_postgrest_tax_profiles.sql`
   - `supabase db push` (CLI wraps the file; this file also uses `BEGIN`/`COMMIT` so SQL Editor cannot half-apply).
5. Re-run catalog assertions (grants/policies only). Confirm PostgREST `reload schema` (migration already `NOTIFY`s `pgrst`).
6. Probe with a **non-production** user JWT against `/rest/v1/recipient_tax_profiles?select=id` — expect `42501` / permission denied. Do not `select=tin` on production.
7. Do not merge-apply from this draft PR without a later authorized change. This PR stops at draft.

## Confirmation (this agent run)

- No SQL applied to staging or production.
- No AWS / Supabase / environment configuration changed.
- No stored TIN read or printed.
- PR #247 not reopened or modified.
- Encryption at rest not started.
