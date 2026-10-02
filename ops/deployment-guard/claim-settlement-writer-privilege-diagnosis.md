# Claim Ledger settlement writer — production privilege diagnosis

READ-ONLY. No GRANT/REVOKE, RLS change, migration, Lambda, SPA, or data mutation was performed.

## Authority at inspect time

| Surface | Fingerprint |
| --- | --- |
| Production SPA | `/assets/index-B2T1Wfw7.js` |
| Production `index.html` SHA-256 | `a696053f8d8f4ae32fe2bc39622a97452b6b98ed27a03563d7f3ae50fe20ef3e` |
| Production Lambda | `checksops-production-prep-api` CodeSha256 `kqXCfyf3PVmKxV4ncmLgWKH/A6iwbi/IgsOgFTbIedQ=` RevisionId `1f5bb42a-047d-4bd2-80f4-1ec11c97c2c6` |
| Staging Lambda writer member | `write-claim-settlement.mjs` sha256 `ce53b3683504081fb6ab3f52559a4c6fcad8856cadd078bbf635359f2cc8779d` (byte-identical to production) |
| PostgreSQL | 18.3 on both environments |
| SQL 43 / SQL 44 | exact on production (`checksops-prod-claim-ledger-sql-inspect-a2a4`, inspect-only, `mutated: false`) |

## Failing statement

The live writer’s first SQL statement, executed as login role `checksops` after `SET TRANSACTION READ WRITE` and `request.app_user_id`:

```sql
SELECT id, org_id
FROM public.claims
WHERE id = $1::uuid
FOR UPDATE
```

PostgreSQL 18.3 raises `42501` `permission denied for table claims`. The API classifies every `42501` as `rls_denied` (`aws/functions/api/data.mjs`). This is a table-privilege failure, not an RLS policy denial. Ordinary `SELECT` on `claims` succeeds (identity-scoped `/data/query`). Claim-number Save returning 200 is the same-number no-op in `executeClaimsNumberUpdate` and does not prove `UPDATE` exists.

Later writer statements are not reached on production:

1. `SELECT public.aws_can_write_claim($1::uuid)` — `SECURITY DEFINER`, already `GRANT EXECUTE` via `aws/rls/sql/20_write_helpers.sql`
2. `SELECT 1 FROM public.tenant_users …` — `checksops` has `SELECT` (and DML) on `tenant_users`
3. `SELECT` / `UPDATE` / `INSERT` on `public.claim_settlements`
4. Trigger `touch_claim_on_settlement` → `public.touch_claim_updated_at` is `SECURITY DEFINER` and does not consume invoker `UPDATE` on `claims`

## Execution role

| Check | Production | Staging |
| --- | --- | --- |
| `current_user` | `checksops` | `checksops` |
| `checksops_admin` used by API | no (refused) | no |
| `rolsuper` / `rolbypassrls` | false / false | false / false |
| Table owner | `checksops_admin` | `checksops_admin` |
| RLS on `public.claims` | enabled, not forced | enabled, not forced |
| `GRANT authenticated TO checksops` | intended role shim | intended role shim |

## Live `checksops` table privileges (`has_table_privilege`)

Official `GET /db-readonly-validate` as the application role. Column-level ACLs are not exposed by this endpoint.

| Object | Prod SELECT | Prod INSERT | Prod UPDATE | Prod DELETE | Stg SELECT | Stg INSERT | Stg UPDATE | Stg DELETE |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `public.claims` | yes | **yes** | **no** | no | yes | **no** | **no** | no |
| `public.tenant_users` | yes | yes | yes | yes | yes | yes | yes | yes |
| `public.claim_settlements` | not in CORE_TABLES probe | not in CORE_TABLES probe | not in CORE_TABLES probe | not in CORE_TABLES probe | not in CORE_TABLES probe | not in CORE_TABLES probe | not in CORE_TABLES probe | not in CORE_TABLES probe |

Writer-touched functions (repo contract + SQL 43/44 inspect):

- `public.aws_can_write_claim(uuid)` — `GRANT EXECUTE` to `checksops`, `authenticated`
- `public.review_save_detected_claim_number` / `public.claim_ledger_link_or_create` — `EXECUTE` to `checksops` only; both exact; neither grants table DML on `claims`

## What the schema contract intended

- `aws/db-copy/sql/02_grant_readonly_application_role.sql` — `GRANT SELECT ON ALL TABLES` to `checksops`. Matches live `SELECT` on `claims`.
- `aws/workflows/sql/70_staging_claims_number_grant.sql` — the only repo file that grants `checksops` any `UPDATE` on `public.claims`:

  ```sql
  GRANT UPDATE (claim_number, updated_at) ON TABLE public.claims TO checksops;
  ```

  Explicitly: no `INSERT`/`DELETE`, no `org_id`/`id`/`amount`, no RLS change, “Does not touch production.”
- Tranche grants `31`/`33`/`35`, SQL 43/44, and financial activation `64` do **not** grant `claims` `UPDATE` or any `claim_settlements` DML.
- `WRITE_ALLOWLIST.claims` allows only `update` of `claim_number`. `org_id` is client-ignored.
- PostgreSQL 18 requires `SELECT` on used columns **and `UPDATE` on at least one column of each table** for `SELECT … FOR UPDATE`.

## Staging grant production lacks

Staging accepted the identical writer (`save_status: 200`, persist after reread) on claim `695064-GQ`. Production fails on the first `claims` `FOR UPDATE`.

Table-level `has_table_privilege(…, 'UPDATE')` is false on **both** environments. Staging therefore holds a `claims` `UPDATE` privilege this probe does not surface — the only matching contract is the column-scoped SQL 70 grant. Production does not have a working `UPDATE` on any `claims` column (otherwise `FOR UPDATE` would succeed).

Production uniquely has table-level `INSERT` on `public.claims` that staging lacks. Do **not** copy that. SQL 44 tests and the guarded executor forbid `GRANT INSERT ON TABLE public.claims`.

`public.claim_settlements` has no grant file in the repo. Production never reached those statements. If a later `42501` names `claim_settlements`, that is a second missing grant and must be diagnosed separately. Do not pre-grant table-wide financial DML.

## #601 overlap

`#601` is merged (`supabase/migrations/20261001231500_tenant_users_same_check_permissions.sql`). It replaces `user_can_move_tenant_checks` / `admin_override_check_status` (`SECURITY DEFINER` check-movement helpers). It does not `GRANT`/`REVOKE` on `public.claims` or `public.claim_settlements`.

Official `sql-executor-invoke` is staging-only and allowlisted to SQL 44 and `#601` only. It cannot apply a claims grant, and must not be widened to do so.

A temporary production inspect Lambda `checksops-prod-601-sql-inspect-8543` appeared during this diagnosis (LastModified `2026-10-02T18:30:46Z`, inspect-only, `#601` identities only) and was already gone on the next list. Concurrent `#601` production-SQL work is in flight. Serialize any future production-sql apply with that workstream. Do not bundle a claims `GRANT` into `#601`.

## Is this a narrow GRANT or a missing migration?

Narrow existing contract: apply SQL 70 on production. It is not a new financial-write migration, not SQL 43/44, and not `#601`.

It is **not** sufficient to add `GRANT SELECT` — `SELECT` already exists. Extra `SELECT` would not bypass `aws_select_claims` and would not fix `FOR UPDATE`.

Do **not** grant `UPDATE (id, org_id)` or table-level `UPDATE`/`INSERT`/`DELETE` on `claims`. PostgreSQL 18 only needs `UPDATE` on one column for the row lock. `id`/`org_id` column `UPDATE` would enable tenant reassignment if any future path issued `UPDATE public.claims SET org_id = …`.

## Minimum privilege for the settlement writer

On `public.claims`, `checksops` needs:

- `SELECT` (already present)
- `UPDATE` on at least one column, preferably the already-contracted pair `(claim_number, updated_at)`

On `public.claim_settlements`, the writer needs `SELECT` plus `INSERT`/`UPDATE` of the breakdown columns. Those grants are unproven on production by the official CORE_TABLES probe; do not add them in the same apply unless a post-70 retry names that table.

On `public.tenant_users` and `aws_can_write_claim`, current privileges are sufficient.

## Proposed minimum SQL (not applied)

```sql
-- Identical to aws/workflows/sql/70_staging_claims_number_grant.sql
-- Does not INSERT/DELETE claims.
-- Does not GRANT amount/org_id/status/financial columns.
-- Does not ENABLE/FORCE RLS. Does not create or replace policies.

GRANT UPDATE (claim_number, updated_at) ON TABLE public.claims TO checksops;
```

## Security implications

- Does not add `SELECT`. RLS `aws_select_claims` remains the tenant read boundary (`aws_is_cross_tenant_reader()` or `aws_can_access_tenant(org_id)`).
- Column-scoped `UPDATE` does not let generic `/data/write` change `org_id` (`WRITE_ALLOWLIST.claims.columns = {claim_number}`).
- Actual `UPDATE` statements still pass `aws_write_claims` (`aws_can_write_claim(id)` / `aws_can_write_tenant(org_id)`).
- `FOR UPDATE` takes a row lock; it does not rewrite columns.
- `checksops` remains non-owner, non-`BYPASSRLS`.
- Do not grant table-level `UPDATE` or `UPDATE (org_id)`.
- Do not treat this as financial-table activation (`64_financial_activation_grants.sql` stays unapplied).

## Guarded production-apply plan (future authorization only)

1. Confirm `#601` production-sql apply is not in flight; do not share its executor allowlist or inspect Lambda.
2. Fresh-read production Lambda (`kqXCfyf3…` / `1f5bb42a…`) and SPA (`index-B2T1Wfw7.js` / `a696053f…`). STOP on drift.
3. Re-run official `GET /db-readonly-validate` plus a catalog-only `information_schema.column_privileges` / `has_column_privilege` inspect for `public.claims` (`id`, `org_id`, `claim_number`, `updated_at`) and `public.claim_settlements` (`SELECT`/`INSERT`/`UPDATE`). Use an inspect-only path. No apply Lambda. No arbitrary SQL on the API.
4. If `has_column_privilege('checksops', 'public.claims', 'claim_number', 'UPDATE')` is already true, STOP and re-diagnose; do not re-grant.
5. Authorize a dedicated `production-sql` receipt for SQL 70 only (`deployment_type` matching official sql-apply, not `sql-executor-invoke`). Exclusive production-sql lease. Owned component: `aws/workflows/sql/70_staging_claims_number_grant.sql`.
6. Apply that single `GRANT`. Do not change RLS. Do not modify Lambda or SPA. Do not `GRANT INSERT` on `claims`.
7. Re-probe column privileges. Expect `UPDATE` true on `claim_number` and `updated_at` only; `id`/`org_id` remain ungranted.
8. Authenticated production acceptance on a writable tenant claim: settlement RPC 200, persist after refresh, ACV derived, generic `claim_settlements` write still `column_not_allowlisted`, claims `INSERT` still blocked, cross-tenant still denied, claim-number real rename still column-scoped.
9. If the next error is `permission denied for table claim_settlements`, stop and treat that as a separate missing DML grant. Do not enlarge this apply.

No production write is authorized by this document.
