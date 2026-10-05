# SQL 39 — TMP write-policy reconcile (prepare only)

STOP BEFORE STAGING SQL APPLY. This package is source/test only.

Catalog authority: 2026-10-05 `GET /inspect/tmp-rls-catalog` on accepted staging Lambda
`CodeSha256 GnVu6M3syf8AcnQCXpQ8ONBvGH6k5Q07rkd4yVW1i7A=` /
`RevisionId c19a91f4-8935-4e51-8b43-a39b321f0ec3`.

This is AWS RLS predicate drift. It is not Supabase runtime usage and not a leftover dump policy.

## 1. Exact proposed migration

`aws/rls/sql/39_tmp_write_policy_reconcile.sql`

Guards, then:

```sql
DROP POLICY IF EXISTS aws_write_tenant_maintenance_payments ON public.tenant_maintenance_payments;
CREATE POLICY aws_write_tenant_maintenance_payments ON public.tenant_maintenance_payments
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));
```

Refuses unless:

- RLS is already enabled
- live authenticated write USING/WITH CHECK is the inspected drifted text **or** already intended
- live `aws_write_tenant_maintenance_payments_job` still matches the inspected machine-write predicate

Does not modify `aws_can_write_tenant`, membership, grants, FORCE/ENABLE RLS, SELECT policies, or the job policy.

Rollback (policy text only, no snapshot): `aws/rls/sql/39_tmp_write_policy_reconcile_rollback.sql`

## 2. Before / after policy matrix

Policies that remain after repair (same four names as inspected):

| Policy | Command | Roles | After USING / WITH CHECK |
| --- | --- | --- | --- |
| `aws_write_tenant_maintenance_payments` | ALL | `authenticated` | `aws_can_write_tenant(tenant_id)` |
| `aws_write_tenant_maintenance_payments_job` | ALL | `checksops` | `aws_monthly_billing_job() OR request.provider_webhook_apply = '1'` |
| `aws_select_tenant_maintenance_payments` | SELECT | `authenticated` | unchanged |
| `aws_select_tenant_maintenance_payments_job` | SELECT | `checksops` | unchanged |

Zero restrictive policies. Lambda `current_user=checksops` inherits `authenticated`, so both ALL policies are applicable and OR.

| Actor / command | Before | After | Why after |
| --- | --- | --- | --- |
| Authorized tenant admin INSERT T1 | deny | allow | repaired authenticated policy |
| Unauthorized tenant INSERT T2 | deny | deny | `aws_can_write_tenant` membership |
| Authorized tenant UPDATE T1 | deny | allow | same ALL policy |
| Cross-tenant UPDATE T2 | deny | deny | helper + no job GUC |
| Ordinary member manufactures T2 | deny | deny | not admin/staff and not a T2 member |
| Monthly billing job INSERT | allow | allow | **job policy kept** |
| Provider webhook apply UPDATE | allow | allow | **job policy kept** |
| Platform owner INSERT any tenant | allow | allow | helper includes `aws_is_cross_tenant_reader()` |
| `PUBLIC` / `anon` write | deny | deny | no policy, no grant |
| Collection V2 `createOrGetOccurrence` INSERT | deny | allow | identity session, no job/webhook GUC |
| Collection V2 settlement UPDATE | deny | allow | same |

## 3. How billing-job / webhook authority is preserved

Accepted source (`24_complete_write_policies.sql`) only states tenant-write via `aws_can_write_tenant`. It does **not** encode monthly-billing or webhook TMP writes.

Those machine paths are a later live overlay:

- `aws_write_tenant_maintenance_payments_job` TO `checksops`
- `aws_monthly_billing_job()` reads `request.monthly_billing_job`
- live `tenant-billing-handlers.mjs` sets that GUC and stays `checksops`
- live `providers/webhook-apply.mjs` sets `request.provider_webhook_apply='1'` and stays `checksops`

`aws_can_write_tenant` requires `auth.uid()`. A job session without an application UUID would **fail** if the job policy were dropped and only the intended authenticated policy remained.

Therefore the smallest safe repair **keeps** the inspected job policy and **refuses apply** if it is missing or drifted. Replacing only the authenticated policy does not remove machine-write authority.

Do not OR the job predicates back into the authenticated policy. That would be wider than intended AWS tenant-write and is unnecessary while the job policy remains.

## 4. Tests

- `aws/tests/tmp-write-policy-reconcile.test.mjs` — source contract + matrix
- `aws/tests/tmp-write-policy-reconcile-pg.test.mjs` — isolated PostgreSQL 16 against the inspected live policy text

## 5. Exact staging apply plan (not executed here)

1. Fresh-read staging Lambda. Require the accepted inspector baseline or `INSPECT_COLLISION`.
2. One read-only `GET /inspect/tmp-rls-catalog` (inspector still deployed). Require the inspected write + job predicates or `SQL_COLLISION`.
3. Official evaluate-only guard only:
   - `node scripts/deployment-guard/preflight.mjs --input <identity.json>`
   - `node scripts/deployment-guard/sql-apply.mjs --input <sql39.json>`
   - `expected_live_definition_sha256` = SHA-256 of the inspected authenticated write USING text immediately before apply
   - `source_sha256` of this file (current): `a3ec9922d33cf75fc554ac9bdd3e7c1b14429112f38ce23f517d64e06b9442a9`
   - `owned_components` = that SQL file only
   - `target_environment=staging`
   - `plan.silent_backfill=false`
4. Apply, if later authorized, only through guarded SQL executor + signed receipt. Never `psql` / direct RDS / env-var bypass.
5. Re-GET the inspector. Require remaining four policies and intended write USING.
6. Do not CREATE Collection V2 fixtures in the apply workstream unless separately authorized.
7. Do not deploy Lambda. Do not remove the inspector in this apply.

Production is out of scope.

## 6. Rollback / recovery (no snapshot)

If the apply transaction fails, `ROLLBACK` undoes the session. No data rewrite.

If apply committed and must be undone: run `39_tmp_write_policy_reconcile_rollback.sql` through the same guarded SQL path. It restores the inspected drifted authenticated policy text only. It does not restore a database snapshot, does not delete TMP rows, and does not drop the job policy.

That rollback re-breaks tenant-admin Collection V2 writes. Prefer a forward fix if the intended policy is correct.

## 7. No Supabase service / runtime dependency

SQL 39 is an AWS RLS policy replace on `public.tenant_maintenance_payments`. It does not call PostgREST, `service_role`, Supabase Auth, or dump-policy names. `TO authenticated` and `auth.uid()` remain the existing AWS role/GUC shims.
